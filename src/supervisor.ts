// The fleet supervisor: one child process per roster loop, respawns decided by
// the ladder's respawn policy, graceful drain on SIGTERM/SIGINT. The shim runs
// sessions with spawnSync, so a loop process defers signals past its in-flight
// iteration — the SIGTERM cascade here IS the drain: agents finish their
// close-out, then exit. That deferral is a courtesy the cascade extends, never
// a guarantee the session can rely on: what actually keeps an agent's turn
// intact is its own process group (shim.ts, H-467), because the signals that
// broke it came from outside this file — launchd and systemd stopping the
// job, a hangup on a shell-started fleet. The supervisor owns processes, never judgment: a halt
// sentinel (STOP/HOLD/BLOCKED) is a decision made below or beside it, honored
// until an operator clears it — the poll picks the loop back up within
// poll_seconds of `rev resume`.
import { spawn, ChildProcess } from 'node:child_process';
import { ancestryBroken, ancestryStamp } from './ancestry.js';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';
import { respawnDecide } from './ladder.js';
import { pollUsage } from './usage.js';
import { rotateOpenFd } from './logretention.js';
import { logEvent, occupiedPid, pidAlive, runningStamp, sClear, sGet, sHas, sSet, streakReset } from './sentinels.js';
import { endSessionGroup, sessionGroupsOf } from './shim.js';
import { REDEPLOY_EXIT, RedeployRequest, armRedeployWatch, readRedeploy, reportRedeployLanded } from './redeploy.js';
import { answeredResumeEscalation, completeAnsweredResume, failAnsweredResume, cliError } from './helm.js';
import { GlobalConfig, LoopConfig } from './types.js';

const SUP = 'supervisor';

interface Slot {
  cfg: LoopConfig;
  child: ChildProcess | null;
  fd: number | null; // console.log append handle while the child lives
  startedAt: number;
  restartStreak: number; // consecutive unhealthy exits
  respawnAt: number | null; // backoff expiry (ms epoch); null = waiting on sentinels/foreign pid
  resumeTicket: string | null; // answered block ticket awaiting a healthy restart
}

function halted(name: string): boolean {
  return sHas(name, 'STOP') || sHas(name, 'HOLD') || sHas(name, 'BLOCKED');
}

/** Resolves with the process exit code: 0 for a drain that should stay down,
 *  REDEPLOY_EXIT for one the service manager must bring back (H-1046). */
export function runFleet(g: GlobalConfig, loops: Record<string, LoopConfig>): Promise<number> {
  const existing = occupiedPid(SUP);
  if (existing) {
    throw new Error(`A supervisor is already running (PID ${existing}). Check: rev status`);
  }
  if (sHas(SUP, 'RUNNING')) {
    // A previous supervisor died without cleanup (crash, power loss). Say so:
    // this line is the diagnosis H-154 spent a night without.
    const stale = sGet(SUP, 'RUNNING')?.split('\n')[0] ?? '?';
    logEvent(SUP, 'stale-marker', `pid=${stale} cleared`);
    console.log(`rev: previous supervisor (pid ${stale}) left a stale marker — clearing it and starting.`);
  }
  sSet(SUP, 'RUNNING', runningStamp());
  process.on('exit', () => sClear(SUP, 'RUNNING'));
  // A REDEPLOY found at startup is the record of the restart that just
  // happened, not an ask. Clearing it here, before any poll can read it, is
  // what keeps a redeploy from looping forever (H-1046).
  const landed = readRedeploy();
  if (landed) sClear(SUP, 'REDEPLOY');

  const slots = new Map<string, Slot>();
  let shuttingDown = false;
  let drainAt = 0;
  let redeploying: RedeployRequest | null = null;
  const lineage = ancestryStamp();

  return new Promise<number>((resolve) => {
    const finishIfDrained = () => {
      if (!shuttingDown) return;
      for (const s of slots.values()) if (s.child) return;
      clearInterval(timer);
      if (usageTimer) clearInterval(usageTimer);
      if (redeploying) {
        // Exit unsuccessfully on purpose: that is the exit launchd and systemd
        // restart, and the supervisor that returns is the new code.
        armRedeployWatch(g);
        logEvent(SUP, 'fleet-stop', `drained for redeploy (exit ${REDEPLOY_EXIT})`);
        console.log('rev: fleet drained to redeploy — exiting for the service manager to start the new code.');
        resolve(REDEPLOY_EXIT);
        return;
      }
      logEvent(SUP, 'fleet-stop', 'drained');
      console.log('rev: fleet drained — supervisor exiting.');
      resolve(0);
    };

    const launch = (s: Slot) => {
      const name = s.cfg.name;
      sClear(name, 'BACKOFF');
      // Re-invoke this same entry (dist/cli.js, or the .ts under tsx in dev) so
      // the child is exactly the v0 single-loop driver.
      const fd = openSync(join(stateDir(name), 'console.log'), 'a');
      const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'run', name], {
        stdio: ['ignore', fd, fd],
      });
      s.child = child;
      s.fd = fd;
      s.startedAt = Date.now();
      s.respawnAt = null;
      logEvent(SUP, 'spawn', `loop=${name} pid=${child.pid}`);
      console.log(`rev: spawned loop '${name}' (pid ${child.pid}) — console: ${join(stateDir(name), 'console.log')}`);

      const onGone = (code: number | null) => {
        if (s.fd !== null) closeSync(s.fd);
        s.child = null;
        s.fd = null;
        if (shuttingDown) {
          logEvent(SUP, 'exit', `loop=${name} code=${code} (drain)`);
          finishIfDrained();
          return;
        }
        if (s.resumeTicket) {
          const ticket = s.resumeTicket;
          s.resumeTicket = null;
          const detail = `process exited with code ${code ?? 'unknown'} after ${Math.round((Date.now() - s.startedAt) / 1000)}s`;
          sSet(name, 'BLOCKED', `automatic resume failed: ${detail}\nat=${new Date().toISOString()}\n`);
          try {
            failAnsweredResume(g, s.cfg, ticket, detail);
            logEvent(name, 'resume-failed', `ticket=${ticket} ${detail}`);
          } catch (e) {
            logEvent(name, 'resume-failure-alarm-failed', `ticket=${ticket} ${String(e).slice(0, 200)}`);
          }
        }
        const uptime = Math.round((Date.now() - s.startedAt) / 1000);
        const healthy = code === 0 && uptime >= g.min_uptime_seconds;
        s.restartStreak = healthy ? 0 : s.restartStreak + 1;
        const action = respawnDecide({
          halted: halted(name),
          exitCode: code,
          uptimeSeconds: uptime,
          restartStreak: s.restartStreak,
          backoffBase: g.respawn_backoff_seconds,
          backoffCap: g.respawn_backoff_cap_seconds,
          minUptime: g.min_uptime_seconds,
        });
        logEvent(SUP, 'exit', `loop=${name} code=${code} uptime=${uptime}s action=${action.act}${action.act === 'respawn' ? ` wait=${action.waitSeconds}s` : ''}`);
        if (action.act === 'await_clearance') {
          console.log(`rev: loop '${name}' halted itself (sentinel present) — will respawn when cleared.`);
        } else if (action.waitSeconds === 0) {
          launch(s);
        } else {
          s.respawnAt = Date.now() + action.waitSeconds * 1000;
          sSet(name, 'BACKOFF', `attempt=${s.restartStreak}\nretry_at=${new Date(s.respawnAt).toISOString()}\n`);
          console.log(`rev: loop '${name}' exited unhealthily (code ${code}, up ${uptime}s) — respawn in ${action.waitSeconds}s (streak ${s.restartStreak}).`);
        }
      };
      child.on('exit', onGone);
      child.on('error', (e) => {
        logEvent(SUP, 'spawn-error', `loop=${name} ${String(e).slice(0, 200)}`);
        onGone(null);
      });
    };

    const poll = () => {
      // Orphan watchdog (H-281): a launchd supervisor has an empty lineage
      // that can never break; a shell- or wrapper-started one whose recorded
      // ancestor chain breaks has lost its operator. Drain rather than run
      // unattended — the 2026-08-28 swarm was ~28 such trees, some driving
      // duplicate fleets against the live store for six days.
      // A redeploy asked for by a loop that shipped a fix to rev's own code
      // (H-1046). An ordinary drain, so in-flight iterations still finish.
      if (!shuttingDown && sHas(SUP, 'REDEPLOY')) {
        redeploying = readRedeploy();
        drain('redeploy');
      }
      if (!shuttingDown && ancestryBroken(lineage)) {
        logEvent(SUP, 'orphaned', `lineage [${lineage.join(' < ')}] broken`);
        drain('orphaned');
      }
      // Drain escalation (H-281): past the grace a straggler is wedged, and a
      // drain that never ends gets an operator kill -9 and leaves orphans.
      if (shuttingDown && drainAt && g.drain_grace_seconds > 0 && Date.now() - drainAt > g.drain_grace_seconds * 1000) {
        for (const s of slots.values()) {
          if (s.child) {
            // The loop's agent CLI runs in its own detached group (shim.ts,
            // H-467), so SIGKILLing the loop alone is not enough: the CLI
            // reparents to init and keeps working, and the fleet that comes
            // back a second later spawns a SECOND session for the same seat —
            // same ready queue, same Helmo actor, same working trees (H-1089).
            // Enumerate before the kill: once the loop is gone its children
            // are init's and no longer findable from here.
            const sessions = sessionGroupsOf(s.child.pid);
            logEvent(SUP, 'drain-kill', `loop=${s.cfg.name} pid=${s.child.pid}`);
            s.child.kill('SIGKILL');
            for (const group of sessions) {
              logEvent(SUP, 'drain-kill-session', `loop=${s.cfg.name} group=${group}`);
              endSessionGroup(group);
            }
          }
        }
        drainAt = 0; // once; exit events finish the drain
      }
      for (const s of slots.values()) {
        // Rotate the live console.log in place — a long-running loop never
        // reopens its fd, so unbounded growth is only caught here, not at
        // spawn (H-434).
        if (s.child && s.fd !== null) rotateOpenFd(join(stateDir(s.cfg.name), 'console.log'), s.fd);
        if (s.child && s.resumeTicket && Date.now() - s.startedAt >= g.min_uptime_seconds * 1000) {
          const ticket = s.resumeTicket;
          try {
            const closed = completeAnsweredResume(g, ticket, join(stateDir(s.cfg.name), 'RUNNING'));
            s.resumeTicket = null;
            logEvent(s.cfg.name, 'resume-complete', `ticket=${ticket}${closed ? '' : ' already closed by someone else'}`);
          } catch (e) {
            logEvent(s.cfg.name, 'resume-completion-failed', `ticket=${ticket} ${cliError(e).slice(0, 200)}`);
          }
        }
        if (s.child || shuttingDown) continue;
        const name = s.cfg.name;
        if (sHas(name, 'BLOCKED')) {
          try {
            const ticket = answeredResumeEscalation(g, s.cfg);
            if (ticket) {
              s.resumeTicket = ticket;
              sClear(name, 'BLOCKED');
              streakReset(name, 'fail', 'limit');
              logEvent(name, 'answer-resume', `ticket=${ticket} BLOCKED cleared`);
            }
          } catch (e) {
            logEvent(name, 'answer-resume-check-failed', String(e).slice(0, 200));
          }
        }
        if (s.respawnAt !== null) {
          if (Date.now() < s.respawnAt) continue;
          if (halted(name)) {
            // Operator halted the loop during its backoff; the halt wins.
            s.respawnAt = null;
            sClear(name, 'BACKOFF');
            logEvent(SUP, 'backoff-halted', `loop=${name}`);
            continue;
          }
          launch(s);
        } else if (!halted(name) && !occupiedPid(name)) {
          // Sentinels cleared (rev resume), or a foreign process died: take it.
          s.restartStreak = 0;
          launch(s);
        }
      }
      finishIfDrained();
    };
    const timer = setInterval(poll, g.poll_seconds * 1000);

    // Max-plan usage (H-278). Guidance, never a gate: pollUsage never throws,
    // and nothing above waits on it.
    const usageTimer =
      g.usage_poll_seconds > 0 ? setInterval(() => void pollUsage(), g.usage_poll_seconds * 1000) : null;
    if (usageTimer) void pollUsage();

    const drain = (sig: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      drainAt = Date.now();
      logEvent(SUP, 'drain', `signal=${sig}`);
      console.log(`rev: ${sig} — draining the fleet (in-flight iterations finish their close-out).`);
      for (const s of slots.values()) s.child?.kill('SIGTERM');
      finishIfDrained();
    };
    process.on('SIGTERM', () => drain('SIGTERM'));
    process.on('SIGINT', () => drain('SIGINT'));

    logEvent(SUP, 'fleet-start', `pid=${process.pid} loops=${Object.keys(loops).join(',')}`);
    console.log(`rev: supervisor pid ${process.pid} — ${Object.keys(loops).length} loop(s) in the roster. Stop the machine: rev stop`);
    if (landed) reportRedeployLanded(g, landed, process.pid);
    for (const cfg of Object.values(loops)) {
      const slot: Slot = { cfg, child: null, fd: null, startedAt: 0, restartStreak: 0, respawnAt: null, resumeTicket: null };
      slots.set(cfg.name, slot);
      const foreign = occupiedPid(cfg.name);
      if (foreign) {
        console.log(`rev: loop '${cfg.name}' already running outside the supervisor (pid ${foreign}) — leaving it alone; will adopt if it exits.`);
        logEvent(SUP, 'foreign', `loop=${cfg.name} pid=${foreign}`);
      } else if (halted(cfg.name)) {
        console.log(`rev: loop '${cfg.name}' has a halt sentinel — will respawn when cleared (rev resume ${cfg.name}).`);
      } else {
        launch(slot);
      }
    }
    if (slots.size === 0) {
      console.log('rev: roster has no loops — nothing to supervise.');
      clearInterval(timer);
      if (usageTimer) clearInterval(usageTimer);
      resolve(0);
    }
  });
}
