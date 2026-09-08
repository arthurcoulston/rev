#!/usr/bin/env node
// rev — run and control loops. Control verbs are sentinel writes; anything
// that reads state is safe from any context (the watch officer uses these).
import { existsSync, statSync } from 'node:fs';
import { loadRoster, resolveRef, stateDir } from './config.js';
import { sessionSpec } from './shim.js';
import { LoopConfig } from './types.js';
import { pollUsage, readCodexUsage, readUsage, refreshCodexUsage, usageLine, usagePath } from './usage.js';
import { selectRun } from './routing.js';
import { runLoop } from './loop.js';
import { serviceFile, serviceInstall, serviceStart, serviceStatusLine, serviceUninstall } from './service.js';
import { readRedeploy, requestRedeploy, watchRedeploy } from './redeploy.js';
import { logEvent, pidAlive, sClear, sGet, sHas, sSet, streakReset } from './sentinels.js';
import { runFleet } from './supervisor.js';

const [cmd, ...rest] = process.argv.slice(2);

const COMMAND_HELP: Record<string, string> = {
  run: 'usage: rev run [<loop> [--count N]]',
  stop: 'usage: rev stop [<loop>]',
  resume: 'usage: rev resume <loop>',
  service: 'usage: rev service <install|uninstall|start|status>',
  redeploy: 'usage: rev redeploy [--ticket <id>] [--reason "<why>"]',
  pace: "usage: rev pace <loop> <fraction (0,1] | park | clear>",
  usage: 'usage: rev usage [--poll]',
  routing: 'usage: rev routing',
  status: 'usage: rev status',
  tail: 'usage: rev tail <loop>',
  'session-spec': 'usage: rev session-spec <seat> --session <actor stamp> [--provider claude] [--tier high] [--model M] [--cwd P] [--constitution P] [--version V]',
};

if (cmd === '--help' || cmd === '-h') {
  console.log('usage: rev <command>  (run rev <command> --help for command syntax)');
  process.exit(0);
}
if (rest[0] === '--help' || rest[0] === '-h') {
  const usage = cmd ? COMMAND_HELP[cmd] : undefined;
  if (usage) {
    console.log(usage);
    process.exit(0);
  }
}

function loopArg(): string {
  const name = rest[0];
  if (!name) {
    console.error(`usage: rev ${cmd} <loop>`);
    process.exit(1);
  }
  return knownLoop(name);
}

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
}

const { global: g, loops, providers } = loadRoster();

function knownLoop(name: string): string {
  if (!loops[name]) {
    console.error(`Unknown loop '${name}'. Roster has: ${Object.keys(loops).join(', ') || '(none)'}`);
    process.exit(1);
  }
  return name;
}

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
  if (pid && sHas(name, 'SEAT_HELD')) return 'SEAT_HELD';
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
      const code = await runFleet(g, loops);
      if (code) process.exit(code);
      break;
    }
    const l = loops[knownLoop(name)]!;
    const count = flag('count') ? Number(flag('count')) : undefined;
    await runLoop(g, l, { count });
    break;
  }
  // Activating a fix the crew has already committed and tested is the crew's
  // call, not the operator's (Arthur, H-1046). The ask is deferred on purpose:
  // the supervisor drains at its next poll, so the session that shipped the fix
  // finishes its close-out instead of being restarted out from under itself.
  case 'redeploy': {
    const sup = pidAlive('supervisor');
    if (!sup) {
      console.error('No supervisor running — nothing to redeploy. The next `rev run` starts on the current build anyway.');
      process.exit(1);
    }
    const pending = readRedeploy();
    if (pending) {
      console.log(`A redeploy is already pending (asked by ${pending.by} at ${pending.requested_at}) — the supervisor drains within ${g.poll_seconds}s. Yours would be the same restart.`);
      break;
    }
    requestRedeploy({
      by: flag('by') ?? process.env['REV_LOOP'] ?? 'operator',
      reason: flag('reason') ?? 'activate committed changes',
      ticket: flag('ticket'),
      requested_at: new Date().toISOString(),
    });
    console.log(
      `Redeploy requested. The supervisor (pid ${sup}) drains within ${g.poll_seconds}s — in-flight iterations finish their close-out — then exits for the service manager to start the new code.`,
    );
    if (!existsSync(serviceFile().file)) {
      console.log(
        `WARNING: no service is installed (${serviceFile().file}), so nothing will start the supervisor again: the fleet will drain and STAY DOWN until someone runs \`rev run\`. Rev will file that as an outage if it happens.`,
      );
    }
    break;
  }
  // Armed by a redeploying supervisor just before it exits, so that something
  // outlives the fleet to say if it never comes back (H-1046).
  case 'redeploy-watch': {
    const deadline = flag('deadline') ? Number(flag('deadline')) : g.redeploy_deadline_seconds;
    const ok = await watchRedeploy(g, deadline);
    if (!ok) process.exit(1);
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
    console.log('       SEAT_HELD=standing down for another live session in this seat');
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
    knownLoop(name);
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
    if (rest.includes('--poll')) refreshCodexUsage();
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
  case 'routing': {
    const usage = { claude: readUsage(), codex: readCodexUsage() };
    console.log('Working-model preview from current usage; does not start or resume a loop.');
    for (const loop of Object.values(loops)) {
      const selected = selectRun(loop, usage, 1, g.limit_exhausted_percent);
      console.log(`${loop.name}: ${selected.choice.provider}/${selected.choice.model} (${loop.routing ?? 'rotation'})`);
      if (selected.switched) console.log(`  ${selected.switched}`);
    }
    break;
  }
  case 'tail': {
    const name = loopArg();
    console.log(`${stateDir(name)}/events.log`);
    break;
  }
  // The composed session as JSON, for a consumer that runs a seat's session
  // without being a loop — the Meetings room, where Arthur types instead of
  // the queue (H-1152). Read-only: it prints what a run WOULD carry and
  // touches no state. A seat with no roster loop is composable by supplying
  // the two facts only the caller knows, so Rev never learns crew paths.
  case 'session-spec': {
    const name = rest[0];
    if (!name || name.startsWith('--')) {
      console.error(COMMAND_HELP['session-spec']);
      process.exit(1);
    }
    // The seat stamp is required, never defaulted. Everyone asking for a spec
    // is by definition NOT the loop — the loop calls runSession directly — and
    // a consumer that silently signed as `rev:<seat>` would make its Helm
    // writes read as the loop's own seat hold (H-558). Ward's H-1151 condition:
    // a meeting signs `meeting:<thread id>`.
    const session = flag('session');
    if (!session) {
      console.error(
        'session-spec needs --session: the Helm actor stamp this consumer writes under, e.g. --session meeting:<thread id>. ' +
        "Pass --session rev:<seat> only if you ARE that seat's loop.",
      );
      process.exit(1);
    }
    const base = loops[name];
    const cwd = flag('cwd') ?? base?.cwd;
    const constitution = flag('constitution') ?? base?.constitution;
    if (!cwd || !constitution) {
      console.error(
        `'${name}' is not a roster loop (roster has: ${Object.keys(loops).join(', ') || 'none'}) — a seat with no loop needs --cwd and --constitution.`,
      );
      process.exit(1);
    }
    // Same fail-closed rule runSession applies: never describe a session that
    // would start half-instructed.
    if (!existsSync(constitution) || statSync(constitution).size === 0) {
      console.error(`constitution missing or empty: ${constitution}`);
      process.exit(1);
    }
    // A meeting asks for a tier, not the loop's own choice: mason's loop runs
    // codex/frontier, and the room wants claude/high (H-1152).
    const tier = flag('tier');
    const provider = flag('provider') ?? 'claude';
    let runtime = base?.runtime ?? 'claude';
    let model = flag('model') ?? base?.model;
    if (tier) {
      const choice = resolveRef(`${provider}:${tier}`, providers, {}, 'rev session-spec');
      runtime = choice.runtime;
      if (!flag('model')) model = choice.model;
    }
    if (!model) {
      console.error(`'${name}' has no roster model — name one with --model, or a --tier to resolve from [providers.${provider}.models].`);
      process.exit(1);
    }
    const l: LoopConfig = {
      ...(base ?? { name, workstream: '', pace: 1, idle_floor_s: 0, choices: [], fallbacks: [] }),
      name,
      cwd,
      constitution,
      runtime,
      model,
      version: flag('version') ?? base?.version ?? '0.1',
    } as LoopConfig;
    console.log(JSON.stringify(sessionSpec(g, l, { model, session, in_roster: Boolean(base) }), null, 2));
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
  routing                  preview working-model choices from current usage (no runs)
  status                   supervisor + every loop's state at a glance
  session-spec <seat>      the composed session as JSON (model, cwd, skills, MCP, env) — reads nothing else
  service <verb>           install|uninstall|start|status — survive reboots (launchd/systemd)
  redeploy [--ticket <id>] [--reason "<why>"]
                           activate a committed fix: drain after in-flight iterations, come back on the new code
  tail <loop>              print the path of the loop's event trace
Roster: ${Object.keys(loops).join(', ') || '(none)'} — from ~/.rev/roster.toml (REV_HOME to override).`);
    process.exit(cmd ? 1 : 0);
}
