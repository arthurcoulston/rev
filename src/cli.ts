#!/usr/bin/env node
// rev — run and control loops. Control verbs are sentinel writes; anything
// that reads state is safe from any context (the watch officer uses these).
import { loadRoster, stateDir } from './config.js';
import { pollUsage, readCodexUsage, readUsage, usageLine, usagePath } from './usage.js';
import { runLoop } from './loop.js';
import { serviceInstall, serviceStart, serviceStatusLine, serviceUninstall } from './service.js';
import { logEvent, pidAlive, sClear, sGet, sHas, sSet, streakReset } from './sentinels.js';
import { runFleet } from './supervisor.js';

const [cmd, ...rest] = process.argv.slice(2);

function loopArg(): string {
  const name = rest[0];
  if (!name) {
    console.error(`usage: rev ${cmd} <loop>`);
    process.exit(1);
  }
  return name;
}

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
}

const { global: g, loops } = loadRoster();

function state(name: string): string {
  const pid = pidAlive(name);
  if (sHas(name, 'STOP')) return 'STOP';
  if (sHas(name, 'HOLD')) return 'HOLD';
  if (sHas(name, 'BLOCKED')) return 'BLOCKED';
  // Above LIMIT/IDLE/RUNNING: a wedged loop looks busy from the outside
  // (its process is alive, polling) while drawing no work at all (H-448).
  if (sHas(name, 'WEDGED')) return 'WEDGED';
  if (!pid && sHas(name, 'BACKOFF')) return 'BACKOFF';
  if (pid && sHas(name, 'LIMIT')) return 'LIMIT';
  if (pid && sHas(name, 'PARKED')) return 'PARKED';
  if (pid && sHas(name, 'IDLE')) return 'IDLE';
  if (pid) return 'RUNNING';
  if (sHas(name, 'RUNNING')) return 'CRASHED';
  return 'halted';
}

switch (cmd) {
  case 'run': {
    const name = rest[0];
    if (!name) {
      // The general start (the operator starts the machine, not a named
      // worker): supervise every roster loop.
      await runFleet(g, loops);
      break;
    }
    const l = loops[name];
    if (!l) {
      console.error(`Unknown loop '${name}'. Roster has: ${Object.keys(loops).join(', ') || '(none)'}`);
      process.exit(1);
    }
    const count = flag('count') ? Number(flag('count')) : undefined;
    await runLoop(g, l, { count });
    break;
  }
  case 'status': {
    const sup = pidAlive('supervisor');
    console.log(`supervisor: ${sup ? `running (pid ${sup})` : 'down — start the machine with: rev run'}`);
    console.log(usageLine(readUsage(), 'Claude'));
    console.log(`${usageLine(readCodexUsage(), 'Codex')}\n`);
    console.log('LOOP                     STATE      PID     PACE   WORKSTREAM');
    for (const name of Object.keys(loops)) {
      const pid = pidAlive(name) ?? '-';
      const pace = sGet(name, 'PACE')?.trim() ?? '1';
      console.log(`${name.padEnd(24)} ${state(name).padEnd(10)} ${String(pid).padEnd(7)} ${pace.padEnd(6)} ${loops[name].workstream}`);
    }
    console.log('\nSTATE: RUNNING=iteration in flight  IDLE=waiting on wake cursor  PARKED=held via PACE');
    console.log('       WEDGED=alive but cannot reach Helm — drawing no work; see the loop trace');
    console.log('       LIMIT=waiting out a transient condition  BLOCKED=needs a human (see Helm queue)');
    console.log('       BACKOFF=crashed, supervisor retrying  STOP/HOLD=deliberate halts');
    console.log('       CRASHED=process gone, marker stale  halted=not started');
    break;
  }
  case 'stop': {
    const name = rest[0];
    if (!name) {
      // Graceful stop-all: drain the supervisor. In-flight iterations finish
      // their close-out; no STOP sentinels are written, so the next `rev run`
      // starts the whole machine again.
      const sup = pidAlive('supervisor');
      if (!sup) {
        console.error('No supervisor running. Stop a single loop with: rev stop <loop>');
        process.exit(1);
      }
      process.kill(sup, 'SIGTERM');
      console.log(`Drain requested (SIGTERM to supervisor pid ${sup}) — in-flight iterations finish, then the machine stops. Watch: rev status`);
      break;
    }
    sSet(name, 'STOP');
    logEvent(name, 'operator', 'STOP set');
    const sup = pidAlive('supervisor');
    console.log(
      `STOP set for '${name}' — halts cleanly after any in-flight iteration.` +
        (sup ? ` The supervisor leaves it down until: rev resume ${name}` : ` Resume: rev resume ${name} (then rev run ${name}).`),
    );
    break;
  }
  case 'resume': {
    const name = loopArg();
    sClear(name, 'STOP', 'HOLD', 'BLOCKED');
    // A resume is a statement the cause was looked at: the loop gets its full
    // retry budget back. Carrying the streak over made resume a single retry
    // that re-blocked in seconds and filed a duplicate escalation (H-401).
    streakReset(name, 'fail', 'limit');
    logEvent(name, 'operator', 'STOP/HOLD/BLOCKED cleared; fail/limit streaks reset');
    const sup = pidAlive('supervisor');
    console.log(
      `Halt sentinels cleared for '${name}'.` +
        (sup ? ` The supervisor picks it back up within ${g.poll_seconds}s.` : ` Start it with: rev run ${name}`),
    );
    break;
  }
  case 'service': {
    const verb = rest[0];
    if (verb === 'install') serviceInstall();
    else if (verb === 'uninstall') serviceUninstall();
    else if (verb === 'start') serviceStart();
    else if (verb === 'status') console.log(serviceStatusLine());
    else {
      console.error('usage: rev service <install|uninstall|start|status>  (stop the machine with: rev stop)');
      process.exit(1);
    }
    break;
  }
  case 'pace': {
    const name = loopArg();
    const v = rest[1];
    if (!v) {
      console.error('usage: rev pace <loop> <fraction (0,1] | park | clear>');
      process.exit(1);
    }
    if (v === 'clear') sClear(name, 'PACE');
    else sSet(name, 'PACE', v);
    logEvent(name, 'operator', `PACE=${v}`);
    console.log(`PACE ${v === 'clear' ? 'cleared' : `set to ${v}`} for '${name}' (picked up within one poll).`);
    break;
  }
  case 'usage': {
    // Claude bars are polled (H-278; --poll forces a fresh read); codex bars
    // are written by each codex run from its own rollout, so they are as fresh
    // as the last iteration and need no credential.
    const snap = rest.includes('--poll') ? await pollUsage() : readUsage();
    for (const [label, s] of [['Claude', snap], ['Codex', readCodexUsage()]] as const) {
      console.log(usageLine(s, label));
      if (s?.limits.length) {
        for (const l of s.limits) {
          console.log(`  ${l.label.padEnd(26)} ${String(l.percent).padStart(3)}%  ${l.severity.padEnd(8)} ${l.active ? 'active' : ''}  resets ${l.resets_at ?? '-'}`);
        }
      }
      if (s?.stale) console.log(`  STALE — last read failed (${s.error ?? 'no reason recorded'}); these are the last good numbers.`);
    }
    if (!snap) console.log(`  Nothing at ${usagePath()} yet. The supervisor polls every 10 min; 'rev usage --poll' reads now.`);
    break;
  }
  case 'tail': {
    const name = loopArg();
    console.log(`${stateDir(name)}/events.log`);
    break;
  }
  default:
    console.error(`usage: rev <command>
  run                      start the machine: supervise every roster loop (respawn, backoff, drain)
  run <loop> [--count N]   drive one loop in the foreground (debugging; --count 1 = assess early)
  stop                     graceful stop-all: drain the supervisor, iterations finish first
  stop <loop>              set STOP — clean halt after the in-flight iteration
  resume <loop>            clear STOP/HOLD/BLOCKED; a running supervisor picks the loop back up
  pace <loop> <v>          velocity: fraction (0,1], 'park', or 'clear'
  usage [--poll]           Max plan usage bars (session, weekly, per-model)
  status                   supervisor + every loop's state at a glance
  service <verb>           install|uninstall|start|status — survive reboots (launchd/systemd)
  tail <loop>              print the path of the loop's event trace
Roster: ${Object.keys(loops).join(', ') || '(none)'} — from ~/.rev/roster.toml (REV_HOME to override).`);
    process.exit(cmd ? 1 : 0);
}
