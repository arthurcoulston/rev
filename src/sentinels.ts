import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { markerLines } from './build.js';
import { revHome, stateDir } from './config.js';
import { rotateIfOversized } from './logretention.js';
import { Sentinel } from './types.js';

// Sentinel files are the loop's operational state machine — the taxonomy is
// inherited from a battle-tested prototype. Each file has a defined owner:
//   STOP     operator: clean halt between iterations
//   HOLD     agent/operator: intended hold — not an anomaly, survives restart
//   BLOCKED  rev→human: cap exceeded / unrecoverable; escalated as a Helm ticket
//   LIMIT    rev: parked on a transient external condition, retrying
//   IDLE     rev: waiting on the wake cursor (contents = Helm event seq)
//   IDLE_AT  rev: epoch-ms the loop went idle; wakes held until idle_floor_s elapses (H-336)
//   RUNNING  rev: pid, start stamp and loaded build of the live loop process
//   PACE     operator/agent: velocity command ("park" or fraction (0,1])
//   PARKED   loop: acknowledgment that it has actually parked (command != state)
//   SEAT_HELD loop: standing down for another live session in the same seat
//   BACKOFF  supervisor: loop crashed; respawn pending (contents = attempt + retry time)
//   WEDGED   rev: cannot reach Helm at all; alarm raised. NOT a halt — the loop
//            keeps polling, because the fault is outside it and may clear.
//   REDEPLOY agent/operator (supervisor's dir): drain and come back on the new
//            code. Present at startup it is the record of the restart that just
//            happened, never a fresh ask — see redeploy.ts.

export function sPath(loop: string, s: Sentinel | string): string {
  return join(stateDir(loop), s);
}

export function sSet(loop: string, s: Sentinel, content = ''): void {
  writeFileSync(sPath(loop, s), content);
}

export type SentinelOwner = {
  value: string;
  by: string;
  at: string;
  pid: number;
  reason: string;
  expires_at: string;
};

function validOwnerTime(value: string, allowNever = false): boolean {
  return (allowNever && value === 'never') || Number.isFinite(Date.parse(value));
}

export function sOwner(loop: string, s: Sentinel): SentinelOwner | null {
  const content = sGet(loop, s);
  if (content === null) return null;
  const [value = '', ...lines] = content.split('\n');
  const fields = Object.fromEntries(lines.filter(Boolean).map((line) => {
    const at = line.indexOf('=');
    return at > 0 ? [line.slice(0, at), line.slice(at + 1)] : ['', ''];
  }));
  const pid = Number(fields.pid);
  if (!fields.by || !validOwnerTime(fields.at) || !Number.isInteger(pid) || !fields.reason || !fields.expires_at || !validOwnerTime(fields.expires_at, true)) return null;
  return { value, by: fields.by, at: fields.at, pid, reason: fields.reason, expires_at: fields.expires_at };
}

export function sValue(loop: string, s: Sentinel): string | null {
  const content = sGet(loop, s);
  return content === null ? null : (content.split('\n')[0] ?? '');
}

// A control set by a command that exits as soon as it has written it (the
// `pace` CLI) has no process whose death means anything: it is held by its
// expires_at alone. Recording the CLI's own pid released every agent park on
// the loop's next poll (H-738).
export const NO_OWNER_PID = 0;

export function sSetOwned(loop: string, s: Sentinel, owner: SentinelOwner): void {
  const reason = owner.reason.replace(/[\r\n]+/g, ' ').trim();
  const pending = s === 'PACE' ? sPath(loop, 'PACE.pending') : null;
  // The pending marker names the writer, which is this process whoever owns the control.
  if (pending) writeFileSync(pending, `${process.pid}\n`);
  try {
    sSet(loop, s, `${owner.value}\nby=${owner.by}\nat=${owner.at}\npid=${owner.pid}\nreason=${reason}\nexpires_at=${owner.expires_at}\n`);
  } finally {
    if (pending) rmSync(pending, { force: true });
  }
}

export function sPendingPid(loop: string): number | null {
  try { return parseInt(readFileSync(sPath(loop, 'PACE.pending'), 'utf8'), 10) || null; } catch { return null; }
}

export function paceAutoRelease(owner: SentinelOwner | null, now = Date.now(), alive = writerAlive): 'pace-expired' | 'pace-orphaned' | null {
  if (!owner || owner.by === 'human' || !validOwnerTime(owner.at) || !validOwnerTime(owner.expires_at, true)) return null;
  if (owner.expires_at !== 'never' && Date.parse(owner.expires_at) <= now) return 'pace-expired';
  if (owner.pid === NO_OWNER_PID) return null;
  return alive(owner.pid) ? null : 'pace-orphaned';
}

export function sReleaseOwned(loop: string, s: Sentinel, observed: Pick<SentinelOwner, 'by' | 'at' | 'pid'>): boolean {
  const current = sOwner(loop, s);
  if (!current || current.by !== observed.by || current.at !== observed.at || current.pid !== observed.pid) return false;
  sClear(loop, s);
  return true;
}

export function writerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function sGet(loop: string, s: Sentinel): string | null {
  return existsSync(sPath(loop, s)) ? readFileSync(sPath(loop, s), 'utf8') : null;
}

export function sClear(loop: string, ...ss: Sentinel[]): void {
  for (const s of ss) rmSync(sPath(loop, s), { force: true });
}

export function sHas(loop: string, s: Sentinel): boolean {
  return existsSync(sPath(loop, s));
}

// Streak counters (dotfiles beside the sentinels; reset on healthy iterations).
export function streak(loop: string, name: string, bump: boolean): number {
  const p = join(stateDir(loop), `.${name}_streak`);
  let n = 0;
  if (existsSync(p)) n = parseInt(readFileSync(p, 'utf8'), 10) || 0;
  if (bump) {
    n += 1;
    writeFileSync(p, String(n));
  }
  return n;
}

export function streakReset(loop: string, ...names: string[]): void {
  for (const name of names) rmSync(join(stateDir(loop), `.${name}_streak`), { force: true });
}

export function streakMap(loop: string, name: string): Record<string, number> {
  const p = join(stateDir(loop), `.${name}_streaks.json`);
  try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, number>; } catch { return {}; }
}

export function streakMapSet(loop: string, name: string, values: Record<string, number>): void {
  const p = join(stateDir(loop), `.${name}_streaks.json`);
  if (Object.keys(values).length === 0) rmSync(p, { force: true });
  else writeFileSync(p, `${JSON.stringify(values)}\n`);
}

// Structured operational trace — the watch officer's and dashboard's perception
// surface. One timestamped line per launcher decision; append-only, best-effort.
export function logEvent(loop: string, event: string, fields = ''): void {
  const p = sPath(loop, 'events.log');
  try {
    rotateIfOversized(p);
    appendFileSync(p, `${new Date().toISOString()} ${event.padEnd(12)} ${fields}\n`);
  } catch {
    /* a trace write must never affect the loop */
  }
}

// A pid does not identify a process. Pids are recycled, and after a reboot a
// dead marker's pid routinely belongs to something unrelated — which took the
// whole fleet down for a night: an Apple helper landed on the old supervisor's
// number, so every launchd restart aborted with "a supervisor is already
// running" (57 times, with nothing running at all) and the machine could never
// converge on its own (H-154). So RUNNING records the command that owns it,
// and liveness means: that pid exists AND is still running that command.
// It also records the build this process LOADED, because the marker's lifetime
// is exactly the lifetime of those bytes: a rebuild replaces dist under a live
// supervisor, and the stamp beside the new code then describes something nobody
// is executing (H-2489). Written once, at startup, and never refreshed.
export function runningStamp(): string {
  return `${process.pid}\nstarted ${new Date().toISOString()}\ncmd ${ownCommand()}\n${markerLines()}`;
}

// Our own driver invocation, minus the node binary — 'dist/cli.js run ward'.
function ownCommand(): string {
  // A pinned launchd/systemd definition starts the installation-owned
  // launcher, which imports the selected cli.js in this same process. Node's
  // argv can be corrected for every downstream consumer, but the kernel's
  // command line remains the launcher. Record that physical entry point for
  // the supervisor only; loop drivers inherit the environment but have a loop
  // name after `run`, so their ordinary cli.js identity remains exact.
  const launcher = process.env['REV_SERVICE_LAUNCHER'];
  const expected = join(revHome(), 'service', 'launch.mjs');
  if (launcher === expected && process.argv.length === 3 && process.argv[2] === 'run') {
    return `${launcher} run`;
  }
  return [process.argv[1] ?? '', ...process.argv.slice(2)].join(' ').trim();
}

// -ww so a long invocation is never truncated into a false mismatch. An empty
// A missing process and unavailable inspection are different observations:
// callers may report or refuse the latter, but must never treat it as authority
// to signal the pid or start a second owner over the marker.
function liveCommand(pid: number): string | null {
  try {
    return execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export type ProcessObservation = { state: 'alive' | 'unknown'; pid: number } | { state: 'dead'; pid: null };

export function processObservation(loop: string, inspect: (pid: number) => string | null = liveCommand): ProcessObservation {
  const running = sGet(loop, 'RUNNING');
  if (!running) return { state: 'dead', pid: null };
  const lines = running.split('\n');
  const pid = parseInt(lines[0] ?? '', 10);
  if (!pid) return { state: 'dead', pid: null };
  try {
    process.kill(pid, 0); // gone, or not ours to signal: settled, no ps needed
  } catch {
    return { state: 'dead', pid: null };
  }
  const cmd = lines.find((l) => l.startsWith('cmd '))?.slice(4).trim();
  // A marker predating this format can only be trusted by pid, as before; the
  // next start of that process writes one carrying its command.
  if (!cmd) return { state: 'alive', pid };
  const live = inspect(pid);
  if (live === null) return { state: 'unknown', pid };
  // Anchored at the end so the supervisor's 'cli.js run' cannot match a loop's
  // 'cli.js run ward' if its pid is recycled to one.
  return live === cmd || live.endsWith(` ${cmd}`) ? { state: 'alive', pid } : { state: 'dead', pid: null };
}

export function pidAlive(loop: string): number | null {
  const observation = processObservation(loop);
  return observation.state === 'alive' ? observation.pid : null;
}

/** Startup/supervision check: unknown inspection keeps the marker occupied,
 * while pidAlive deliberately refuses to authorize signalling that pid. */
export function occupiedPid(loop: string, inspect?: (pid: number) => string | null): number | null {
  return processObservation(loop, inspect).pid;
}
