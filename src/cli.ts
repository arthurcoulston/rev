#!/usr/bin/env node
// rev — run and control loops. Control verbs are sentinel writes; anything
// that reads state is safe from any context (the watch officer uses these).
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildLine, compare, parseMarker, runningLine, snapshot } from './build.js';
import { controlTargets, loadRoster, resolveRef, stateDir } from './config.js';
import { sessionSpec } from './shim.js';
import { LoopConfig } from './types.js';
import { pollUsage, readCodexUsage, readUsage, refreshCodexUsage, usageLine, usagePath } from './usage.js';
import { selectRun } from './routing.js';
import { runLoop } from './loop.js';
import { serviceFile, serviceInstall, serviceStart, serviceStatusLine, serviceUninstall, stalePinnedService } from './service.js';
import { assertInstallation, requireTarget, target, targetLine } from './install.js';
import { planLines, removalPlan, removeInstallation } from './remove.js';
import { ReleaseError, describe as describeRelease, migrationLine, readSelection, rollback, selectionFile, upgrade } from './release.js';
import { beginActivation, deploymentFile } from './deployment.js';
import { readRedeploy, requestRedeploy, watchRedeploy } from './redeploy.js';
import { logEvent, pidAlive, processObservation, sClear, sGet, sHas, sPendingPid, sSetOwned, sValue, streakReset } from './sentinels.js';
import { runFleet } from './supervisor.js';
import { teamResume, teamStop } from './team-control.js';
import { buildIntakeResult, recordIntakeResult } from './intake-preparation.js';

const [cmd, ...rest] = process.argv.slice(2);
// `--installation <name|home>` may follow any command: it asserts which
// installation the command is about, and a disagreement is a refusal rather
// than a redirect (H-2473, src/install.ts). Taken out of `rest` here so that
// no command's own positional arguments have to know it might be there.
const requestedInstall = takeInstallFlag(rest);
const commandName = process.env['REV_COMMAND_NAME']?.trim() || 'rev';
// Assert the name here, at the door, and nowhere else. It used to be an
// argument each handler passed to `requireTarget`, which meant it held only on
// the surfaces that write: the read surfaces — exactly where a script puts an
// assertion — took the flag and exited 0 (H-2526). One check before the switch
// is the same discipline as the exempt list below: a surface added later
// cannot forget it, because it never had the chance to remember.
//
// Before the pinned-release check, so that a wrong name is answered as a wrong
// name rather than masked by an unrelated incoherent-release error.
if (requestedInstall !== undefined) assertInstallation([commandName, cmd, rest[0]].filter(Boolean).join(' '), requestedInstall);
// Validate a pinned release before even reading the roster. Every command,
// including read-only surfaces and the supervisor, enters through this file.
//
// Two families are deliberately exempt, and they have to be: they are the only
// two ways out of a broken selection, so gating them on it being sound would
// put the repair behind the fault (H-2493). `release` moves the selection;
// `install` — whose only verb is the removal — takes the installation away. The
// exemption has to live in THIS list and nowhere else: a handler that asks
// `requireTarget` to skip the check never reaches its own argument, which is
// how `install remove` shipped unreachable behind a gate its own comment said
// it was exempt from (H-2522).
const UNPINNED = ['release', 'install'];
if (!UNPINNED.includes(cmd ?? '')) {
  try {
    targetLine();
  } catch (e) {
    // A refusal that leaves the operator a `rm -rf` is the H-2431 shape. The
    // stack trace from inside the check named neither escape, so it said one.
    console.error(
      `${e instanceof Error ? e.message : String(e)}\n`
      + `Read what broke with: ${commandName} release status  (then ${commandName} release upgrade <release directory>)\n`
      + `Or take this installation's records away entirely with: ${commandName} install remove`,
    );
    process.exit(1);
  }
}

/**
 * What the supervisor loaded, read from the RUNNING marker it wrote at startup.
 * A dead observation means the marker, if present, is a crashed process's — so
 * there is nothing running to describe, and the artifact line above is the only
 * honest statement about code (H-2489).
 */
function supervisorRunningLine(observation: ReturnType<typeof processObservation>): string {
  if (observation.state === 'dead') return runningLine('the supervisor', null);
  return runningLine('the supervisor', compare(parseMarker(sGet('supervisor', 'RUNNING')), snapshot()));
}

// Both spellings, because Helmo and the roadmap take both and a consumer
// writing `--installation=x` to Rev used to have it fall through as a
// positional — absorbed in silence by any command that ignores extra
// arguments, so the assertion was never made at all (H-2526).
function takeInstallFlag(args: string[]): string | undefined {
  return takeFlag(args, 'installation');
}

/**
 * Removes `--<name> <value>` or `--<name>=<value>` from `args` and returns the
 * value, so no command's own positional arguments have to know it might be
 * there. `undefined` means absent; `''` means present with nothing after it,
 * which callers refuse rather than guess at.
 */
function takeFlag(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const joined = args[i]!.startsWith(`--${name}=`);
  // A flag given last has no value; the refusal says so rather than guessing.
  return joined ? args.splice(i, 1)[0]!.slice(name.length + 3) : args.splice(i, 2)[1] ?? '';
}

const rosterSource = commandName === 'rev' ? '~/.rev/roster.toml (REV_HOME to override)' : '~/.rev-gp/roster.toml (fixed by gp-rev)';

function cliActor(): { label: string; human: boolean } {
  for (const key of ['REV_ACTOR', 'HELMO_ACTOR']) {
    const raw = process.env[key];
    if (!raw) continue;
    try {
      const actor = JSON.parse(raw) as { name?: string; kind?: string };
      if (actor.kind === 'human') return { label: 'human', human: true };
      if (actor.name) return { label: actor.name, human: false };
    } catch { return { label: raw, human: false }; }
  }
  return { label: `cli:${process.pid}:${cmd ?? 'unknown'}`, human: false };
}

const COMMAND_HELP: Record<string, string> = {
  run: `usage: ${commandName} run [<loop> [--count N]]`,
  stop: `usage: ${commandName} stop [<loop|role> [--worker]]`,
  resume: `usage: ${commandName} resume <loop|role> [--worker]`,
  service: `usage: ${commandName} service <install|uninstall|start|status>`,
  install: `usage: ${commandName} install remove [--confirm]`,
  release: `usage: ${commandName} release <status | upgrade <release directory> | rollback | activate>`,
  redeploy: `usage: ${commandName} redeploy [--ticket <id>] [--reason "<why>"]`,
  pace: `usage: ${commandName} pace <loop|role> <fraction (0,1] | park | clear> [--worker]`,
  usage: `usage: ${commandName} usage [--poll]`,
  routing: `usage: ${commandName} routing`,
  status: `usage: ${commandName} status [--json]`,
  tail: `usage: ${commandName} tail <loop>`,
  'session-spec': `usage: ${commandName} session-spec <seat> --session <actor stamp> [--provider claude] [--tier high] [--model M] [--cwd P] [--constitution P] [--version V]`,
  team: `usage: ${commandName} team <stop|resume> <loop|role|all> [--worker]`,
  intake: `usage: ${commandName} intake result goodplumb@<40-hex-commit>`,
};

if (cmd === '--help' || cmd === '-h') {
  console.log(`usage: ${commandName} <command>  (run ${commandName} <command> --help for command syntax)`);
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
    console.error(`usage: ${commandName} ${cmd} <loop>`);
    process.exit(1);
  }
  return knownLoop(name);
}

// Same two spellings as `--installation`, for the same reason: a consumer who
// writes `--ticket=H-1` should not have it read as a loop name (H-2526). This
// one reads without consuming, because these flags sit among arguments their
// own command already knows how to skip.
function flag(name: string): string | undefined {
  const i = rest.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  return rest[i]!.startsWith(`--${name}=`) ? rest[i]!.slice(name.length + 3) : rest[i + 1];
}

const { global: g, loops, providers } = loadRoster();

function knownLoop(name: string): string {
  if (!loops[name]) {
    console.error(`Unknown loop '${name}'. Roster has: ${Object.keys(loops).join(', ') || '(none)'}`);
    process.exit(1);
  }
  return name;
}

// Control commands take a role as well as a loop (H-676): a seat shared by
// pool workers reaches every one of them, and `--worker` narrows it to the
// single loop of that name. See controlTargets in config.ts.
const worker = rest.includes('--worker');
const controlArgs = rest.filter((a) => a !== '--worker');

function controlTargetsOf(name: string): string[] {
  const names = controlTargets(loops, name, worker);
  if (!names.length) {
    console.error(`Unknown loop '${name}'. Roster has: ${Object.keys(loops).join(', ') || '(none)'}`);
    process.exit(1);
  }
  return names;
}

function controlArg(): string[] {
  const name = controlArgs[0];
  if (!name) {
    console.error(`usage: ${commandName} ${cmd} <loop|role>`);
    process.exit(1);
  }
  return controlTargetsOf(name);
}

const listed = (names: string[]) => names.map((n) => `'${n}'`).join(', ');

function state(name: string): string {
  const observation = processObservation(name);
  const pid = observation.pid;
  if (sHas(name, 'STOP')) return 'STOP';
  if (sHas(name, 'HOLD')) return 'HOLD';
  if (sHas(name, 'BLOCKED')) return 'BLOCKED';
  // Above LIMIT/IDLE/RUNNING: a wedged loop looks busy from the outside
  // (its process is alive, polling) while drawing no work at all (H-448).
  if (sHas(name, 'WEDGED')) return 'WEDGED';
  if (observation.state === 'unknown') return 'UNKNOWN';
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
  case 'intake': {
    if (rest[0] !== 'result' || !rest[1] || !g.intake_preparation_checkout) {
      console.error(COMMAND_HELP.intake);
      process.exit(1);
    }
    const dir = stateDir('supervisor');
    const stateFile = join(dir, 'intake-preparation.json');
    const resultFile = join(dir, 'intake-preparation-result.json');
    recordIntakeResult(resultFile, buildIntakeResult(g.intake_preparation_checkout, stateFile, rest[1]));
    console.log('intake preparation result staged; the supervisor will sign and deliver it on its next poll.');
    break;
  }
  case 'team': {
    if (commandName !== 'gp-rev' || process.env['REV_LOOP'] !== 'prime') {
      console.error('team control is available only to Prime through gp-rev.');
      process.exit(1);
    }
    const verb = controlArgs[0];
    const target = controlArgs[1];
    if (!['stop', 'resume'].includes(verb ?? '') || !target) {
      console.error(COMMAND_HELP.team);
      process.exit(1);
    }
    const names = target === 'all' ? Object.keys(loops) : controlTargetsOf(target);
    console.log(targetLine(requireTarget(`${commandName} team ${verb}`)));
    if (verb === 'stop') {
      const result = teamStop(names);
      for (const name of result.stopped) logEvent(name, 'prime-stop', 'provenance=prime');
      if (result.refused.length) {
        console.error(`Refused (foreign STOP remains): ${result.refused.join(', ')}`);
        process.exitCode = 1;
      }
      if (result.stopped.length) console.log(`Prime STOP set for: ${result.stopped.join(', ')}`);
    } else {
      const result = teamResume(names);
      for (const name of result.resumed) logEvent(name, 'prime-resume', 'own STOP cleared');
      if (result.refused.length) {
        console.error(`Refused (not Prime-owned STOP, or HOLD/BLOCKED remains): ${result.refused.join(', ')}`);
        process.exitCode = 1;
      }
      if (result.resumed.length) console.log(`Prime STOP cleared for: ${result.resumed.join(', ')}`);
    }
    break;
  }
  case 'run': {
    const name = rest[0];
    if (!name) {
      // The general start (the operator starts the machine, not a named
      // worker): supervise every roster loop.
      console.log(targetLine(requireTarget('start the machine')));
      const code = await runFleet(g, loops);
      if (code) process.exit(code);
      break;
    }
    const l = loops[knownLoop(name)]!;
    console.log(targetLine(requireTarget(`run '${name}'`)));
    const count = flag('count') ? Number(flag('count')) : undefined;
    await runLoop(g, l, { count });
    break;
  }
  // Activating a fix the crew has already committed and tested is the crew's
  // call, not the operator's (Arthur, H-1046). The ask is deferred on purpose:
  // the supervisor drains at its next poll, so the session that shipped the fix
  // finishes its close-out instead of being restarted out from under itself.
  case 'redeploy': {
    console.log(targetLine(requireTarget('request a redeploy')));
    const sup = pidAlive('supervisor');
    if (!sup) {
      console.error(`No supervisor running — nothing to redeploy. The next \`${commandName} run\` starts on the current build anyway.`);
      process.exit(1);
    }
    const pending = readRedeploy();
    if (pending) {
      console.log(`A redeploy is already pending (asked by ${pending.by} at ${pending.requested_at}) — the supervisor drains within ${g.poll_seconds}s. Yours would be the same restart.`);
      break;
    }
    requestRedeploy({
      by: flag('by') ?? process.env['REV_LOOP'] ?? cliActor().label,
      reason: flag('reason') ?? 'activate committed changes',
      ticket: flag('ticket'),
      requested_at: new Date().toISOString(),
    });
    console.log(
      `Redeploy requested. The supervisor (pid ${sup}) drains within ${g.poll_seconds}s — in-flight iterations finish their close-out — then exits for the service manager to start the new code.`,
    );
    if (!existsSync(serviceFile().file)) {
      console.log(
        `WARNING: no service is installed (${serviceFile().file}), so nothing will start the supervisor again: the fleet will drain and STAY DOWN until someone runs \`${commandName} run\`. Rev will file that as an outage if it happens.`,
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
    const supervisor = processObservation('supervisor');
    const sup = supervisor.pid;
    // The machine-readable table (H-676). With pool workers a role is several
    // loops, so a liveness check asking "can builder take this?" needs each
    // loop's seat and claim scope, which the human table does not print. The
    // table stays as it is: four estate tools parse its header exactly.
    if (rest.includes('--json')) {
      console.log(JSON.stringify({
        installation: target('unchecked').label, home: target('unchecked').home,
        supervisor: supervisor.state === 'unknown' ? 'unobservable' : sup ? 'running' : 'down',
        loops: Object.values(loops).map((l) => {
          const pending = sPendingPid(l.name);
          return {
            loop: l.name, seat: l.seat ?? l.name, pool: (l.peer_sessions?.length ?? 0) > 1,
            state: state(l.name), pid: pidAlive(l.name), pace: pending ? `pending:${pending}` : (sValue(l.name, 'PACE') ?? '1'),
            workstream: l.workstream, project: l.project ?? null, tickets: l.tickets ?? null,
          };
        }),
      }, null, 2));
      break;
    }
    console.log(targetLine());
    // Provenance of the artifact, then of the process — never the same claim
    // (H-2489). A rebuild under a live supervisor makes the first current and
    // the second stale, and reading only the first is how H-2432 reported a
    // commit nobody was executing.
    console.log(buildLine());
    console.log(supervisorRunningLine(supervisor));
    console.log(`supervisor: ${supervisor.state === 'unknown' ? `unobservable (recorded pid ${sup}; process inspection unavailable)` : sup ? `running (pid ${sup})` : `down — start the machine with: ${commandName} run`}`);
    console.log(usageLine(readUsage(), 'Claude'));
    console.log(`${usageLine(readCodexUsage(), 'Codex')}\n`);
    console.log('LOOP                     STATE      PID     PACE   WORKSTREAM');
    for (const name of Object.keys(loops)) {
      const pid = pidAlive(name) ?? '-';
      const pending = sPendingPid(name);
      const pace = pending ? `pending:${pending}` : (sValue(name, 'PACE') ?? '1');
      console.log(`${name.padEnd(24)} ${state(name).padEnd(10)} ${String(pid).padEnd(7)} ${pace.padEnd(6)} ${loops[name].workstream}`);
    }
    console.log('\nSTATE: RUNNING=iteration in flight  IDLE=waiting on wake cursor  PARKED=held via PACE');
    console.log('       SEAT_HELD=standing down for another live session in this seat');
    console.log('       WEDGED=alive but cannot reach Helm — drawing no work; see the loop trace');
    console.log('       LIMIT=waiting out a transient condition  BLOCKED=needs a human (see Helm queue)');
    console.log('       BACKOFF=crashed, supervisor retrying  STOP/HOLD=deliberate halts');
    console.log('       UNKNOWN=process inspection unavailable; marker remains occupied, so no duplicate starts');
    console.log('       CRASHED=process gone, marker stale  halted=not started');
    break;
  }
  case 'stop': {
    const name = controlArgs[0];
    if (!name) {
      // Graceful stop-all: drain the supervisor. In-flight iterations finish
      // their close-out; no STOP sentinels are written, so the next `rev run`
      // starts the whole machine again.
      const sup = pidAlive('supervisor');
      if (!sup) {
        console.error(`No supervisor running. Stop a single loop with: ${commandName} stop <loop>`);
        process.exit(1);
      }
      console.log(targetLine(requireTarget('drain the machine')));
      process.kill(sup, 'SIGTERM');
      console.log(`Drain requested (SIGTERM to supervisor pid ${sup}) — in-flight iterations finish, then the machine stops. Watch: ${commandName} status`);
      break;
    }
    const names = controlTargetsOf(name);
    console.log(targetLine(requireTarget(`stop '${name}'`)));
    const actor = cliActor();
    for (const n of names) {
      sSetOwned(n, 'STOP', { value: '', by: actor.human ? 'human' : actor.label, at: new Date().toISOString(), pid: process.pid, reason: `${commandName} stop ${name}`, expires_at: 'never' });
      logEvent(n, actor.label, 'STOP set');
    }
    const sup = pidAlive('supervisor');
    console.log(
      `STOP set for ${listed(names)} — halts cleanly after any in-flight iteration.` +
        (sup ? ` The supervisor leaves it down until: ${commandName} resume ${name}` : ` Resume: ${commandName} resume ${name} (then ${commandName} run ${name}).`),
    );
    break;
  }
  case 'resume': {
    const names = controlArg();
    const name = controlArgs[0]!;
    console.log(targetLine(requireTarget(`resume '${name}'`)));
    for (const n of names) {
      sClear(n, 'STOP', 'HOLD', 'BLOCKED');
      // A resume is a statement the cause was looked at: the loop gets its full
      // retry budget back. Carrying the streak over made resume a single retry
      // that re-blocked in seconds and filed a duplicate escalation (H-401).
      streakReset(n, 'fail', 'limit');
      logEvent(n, cliActor().label, 'STOP/HOLD/BLOCKED cleared; fail/limit streaks reset');
    }
    const sup = pidAlive('supervisor');
    console.log(
      `Halt sentinels cleared for ${listed(names)}.` +
        (sup ? ` The supervisor picks it back up within ${g.poll_seconds}s.` : ` Start it with: ${commandName} run ${name}`),
    );
    break;
  }
  case 'service': {
    const verb = rest[0];
    // A refusal here is the ordinary answer, not a crash: it is how one
    // installation declines to operate another's service (H-2452). Print what
    // it said and the way out, without a stack trace over the top of it.
    const refusable = (act: () => void) => {
      try {
        act();
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    };
    if (verb === 'status') {
      console.log(targetLine());
      console.log(buildLine());
      console.log(supervisorRunningLine(processObservation('supervisor')));
      console.log(serviceStatusLine());
      break;
    }
    const act = { install: serviceInstall, uninstall: serviceUninstall, start: serviceStart }[verb ?? ''];
    if (!act) {
      console.error(`usage: ${commandName} service <install|uninstall|start|status>  (stop the machine with: ${commandName} stop)`);
      process.exit(1);
    }
    console.log(targetLine(requireTarget(`${commandName} service ${verb}`)));
    refusable(act);
    break;
  }
  // The only command that deletes an installation's records (H-2512). Its own
  // module carries why it is shaped the way it is; here it is two acts, because
  // a removal with no undo should not be one keystroke: the first prints what
  // would go, the second does it.
  case 'install': {
    if (rest[0] !== 'remove') {
      console.error(`${COMMAND_HELP['install']}  (to remove only the service and KEEP every record: ${commandName} service uninstall)`);
      process.exit(1);
    }
    // 'unchecked', for the same reason `release` is: a removal is one of the two
    // ways out of a broken selection, so gating it on the selection being sound
    // would leave an installation that cannot run and cannot be removed either.
    // This argument is only half of it — `UNPINNED` at the top of this file is
    // what lets the command reach it at all (H-2522).
    const t = requireTarget(`${commandName} install remove`, 'unchecked');
    console.log(targetLine(t));
    const plan = removalPlan(t.label, g);
    for (const line of planLines(plan)) console.log(line);
    if (plan.blocked) {
      console.error(`refusing to ${commandName} install remove: ${plan.blocked}`);
      process.exit(1);
    }
    if (!rest.includes('--confirm')) {
      console.log(
        `Nothing was removed. This is the one operation with no undo — no other ${commandName} command brings these back.\n`
        + `Confirm with: ${commandName} install remove --confirm`,
      );
      break;
    }
    for (const path of removeInstallation(plan)) console.log(`Removed: ${path}`);
    console.log(
      `Installation ${plan.label} is removed. Release directories were not touched: a release is shared between installations, `
      + `and ${commandName} release is what a version change goes through.`,
    );
    break;
  }
  // The one family that runs while the selection is broken, because it is what
  // repairs it. Every refusal below leaves the installation on the release it
  // is already running (H-2493, src/release.ts).
  case 'release': {
    const verb = rest[0] ?? 'status';
    const file = selectionFile();
    if (verb === 'status') {
      console.log(targetLine(target('unchecked')));
      for (const line of describeRelease(file)) console.log(line);
      break;
    }
    if (!['upgrade', 'rollback', 'activate'].includes(verb) || (verb === 'upgrade' && !rest[1])) {
      console.error(COMMAND_HELP['release']);
      process.exit(1);
    }
    if (!file) {
      console.error(
        `Cannot ${verb}: this installation is not pinned to a release, so there is no selection to change `
        + '(INSTALLATION_RELEASE is unset). Set it to the selection file this installation should use, then run this again.',
      );
      process.exit(1);
    }
    console.log(targetLine(requireTarget(`${commandName} release ${verb}`, 'unchecked')));
    try {
      if (verb === 'activate') {
        const selection = readSelection(file);
        if (!selection) throw new ReleaseError(`${file} names no selected release to activate`);
        if (!existsSync(serviceFile().file)) throw new ReleaseError(`no service is installed at ${serviceFile().file}; install the stable launcher before activation`);
        const stale = stalePinnedService();
        if (stale) throw new ReleaseError(`the installed service ${stale.file} names ${stale.program} inside a release; run '${commandName} service install' once so activation can restart through the stable launcher`);
        const sup = pidAlive('supervisor');
        if (!sup) throw new ReleaseError(`no supervisor is running; use '${commandName} service start' and verify it before activating a later selection`);
        if (readRedeploy()) throw new ReleaseError('a supervisor redeploy is already pending; wait for it to land before activating a release');
        const record = beginActivation(deploymentFile(file), selection, target('unchecked').label);
        requestRedeploy({ by: cliActor().label, reason: `activate selected release ${selection.release}`, requested_at: record.updated_at });
        console.log(`activation ${record.attempt}: ${selection.release} is queued. The current fleet drains within the configured bound; replacement sessions start only after the supervisor exits.`);
        break;
      }
      const change = verb === 'upgrade' ? upgrade(file, rest[1]!) : rollback(file);
      if (change.unchanged) {
        console.log(`release: already ${change.to} (${change.directory}) — nothing written.`);
        break;
      }
      console.log(`release: ${change.from ?? '(none)'} -> ${change.to} (${change.directory})`);
      if (change.discarded) console.log(`The selection this replaced could not be read (${change.discarded}), so nothing is retained to roll back to.`);
      console.log(`data compatibility: ${migrationLine(change.migration)}`);
      console.log(
        'Nothing was restarted: a running process keeps the code it loaded, and takes this release when it next starts '
        + `(${commandName} redeploy, or ${commandName} service start). Check with: ${commandName} status`,
      );
      // ...which is only true if the service definition resolves the selection
      // at start. One installed before H-2511 names a cli.js frozen inside the
      // release just left, so its next start would refuse. Say so here, where
      // the promise is made, rather than leaving it for launchd.log.
      const stale = stalePinnedService();
      if (stale) {
        console.log(
          `WARNING: the installed service definition ${stale.file} names ${stale.program}, which is inside a release directory, `
          + `so a restart would bring back the release this installation has just left and refuse to run. `
          + `Run '${commandName} service install' once to make restarts follow the selection.`,
        );
      }
    } catch (e) {
      // A release refusal is the ordinary answer, not a crash — the same shape
      // the `service` verbs use when one installation declines another's work.
      if (!(e instanceof ReleaseError)) throw e;
      console.error(e.message);
      process.exit(1);
    }
    break;
  }
  case 'pace': {
    const names = controlArg();
    const name = controlArgs[0]!;
    const v = controlArgs[1];
    if (!v) {
      console.error(`usage: ${commandName} pace <loop|role> <fraction (0,1] | park | clear>`);
      process.exit(1);
    }
    console.log(targetLine(requireTarget(`set the pace of '${name}'`)));
    const actor = cliActor();
    for (const n of names) {
      if (v === 'clear') sClear(n, 'PACE');
      else sSetOwned(n, 'PACE', { value: v, by: actor.human ? 'human' : actor.label, at: new Date().toISOString(), pid: process.pid, reason: `${commandName} pace`, expires_at: actor.human ? 'never' : new Date(Date.now() + 60 * 60 * 1000).toISOString() });
      logEvent(n, actor.label, `PACE=${v}`);
    }
    console.log(`PACE ${v === 'clear' ? 'cleared' : `set to ${v}`} for ${listed(names)} (picked up within one poll).`);
    break;
  }
  case 'usage': {
    // Claude bars are polled (H-278; --poll forces a fresh read); codex bars
    // are written by each codex run from its own rollout, so they are as fresh
    // as the last iteration and need no credential.
    console.log(targetLine());
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
    if (!snap) console.log(`  Nothing at ${usagePath()} yet. The supervisor polls every 10 min; '${commandName} usage --poll' reads now.`);
    break;
  }
  case 'routing': {
    const usage = { claude: readUsage(), codex: readCodexUsage() };
    console.log(targetLine());
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
    console.error(`usage: ${commandName} <command>
  run                      start the machine: supervise every roster loop (respawn, backoff, drain)
  run <loop> [--count N]   drive one loop in the foreground (debugging; --count 1 = assess early)
  stop                     graceful stop-all: drain the supervisor, iterations finish first
  stop <loop|role>         set STOP — clean halt after the in-flight iteration; a pooled
                           role reaches every worker of its seat, --worker only that loop
  resume <loop|role>       clear STOP/HOLD/BLOCKED; a running supervisor picks the loop back up
  pace <loop|role> <v>     velocity: fraction (0,1], 'park', or 'clear'
  usage [--poll]           Max plan usage bars (session, weekly, per-model)
  routing                  preview working-model choices from current usage (no runs)
  status [--json]          supervisor + every loop's state at a glance; --json adds seat and claim scope
  session-spec <seat>      the composed session as JSON (model, cwd, skills, MCP, env) — reads nothing else
  service <verb>           install|uninstall|start|status — survive reboots (launchd/systemd)
  install remove           delete this installation's records, controls and selection (no undo; --confirm)
  release <verb>           status|upgrade <dir>|rollback|activate — select, then activate with a bounded drain
  redeploy [--ticket <id>] [--reason "<why>"]
                           activate a committed fix: drain after in-flight iterations, come back on the new code
  tail <loop>              print the path of the loop's event trace
Any command also takes --installation <name|home> (or --installation=<name|home>): it asserts which
installation the command is about, and ANY command — reads included — refuses rather than redirects
if that disagrees with the environment.
${targetLine()}
Roster: ${Object.keys(loops).join(', ') || '(none)'} — from ${rosterSource}.`);
    process.exit(cmd ? 1 : 0);
}
