import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';
import { rotateIfOversized } from './logretention.js';
import { Sentinel } from './types.js';

// Sentinel files are the loop's operational state machine — the taxonomy is
// inherited from a battle-tested prototype. Each file has a defined owner:
//   STOP     operator: clean halt between iterations
//   HOLD     agent/operator: intended hold — not an anomaly, survives restart
//   BLOCKED  rev→human: cap exceeded / unrecoverable; escalated as a Helm ticket
//   LIMIT    rev: parked on a transient external condition, retrying
//   IDLE     rev: waiting on the wake cursor (contents = Helm event seq)
//   RUNNING  rev: pid + start stamp of the live loop process
//   PACE     operator/agent: velocity command ("park" or fraction (0,1])
//   PARKED   loop: acknowledgment that it has actually parked (command != state)
//   BACKOFF  supervisor: loop crashed; respawn pending (contents = attempt + retry time)
//   WEDGED   rev: cannot reach Helm at all; alarm raised. NOT a halt — the loop
//            keeps polling, because the fault is outside it and may clear.

export function sPath(loop: string, s: Sentinel | string): string {
  return join(stateDir(loop), s);
}

export function sSet(loop: string, s: Sentinel, content = ''): void {
  writeFileSync(sPath(loop, s), content);
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
export function runningStamp(): string {
  return `${process.pid}\nstarted ${new Date().toISOString()}\ncmd ${ownCommand()}\n`;
}

// Our own driver invocation, minus the node binary — 'dist/cli.js run ward'.
function ownCommand(): string {
  return [process.argv[1] ?? '', ...process.argv.slice(2)].join(' ').trim();
}

// -ww so a long invocation is never truncated into a false mismatch. An empty
// answer (no such process, or no ps at all) reads as "not provably ours": the
// bias is deliberate, because a false 'alive' wedges the machine permanently
// while a false 'dead' is caught by the next start writing a fresh marker.
function liveCommand(pid: number): string {
  try {
    return execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export function pidAlive(loop: string): number | null {
  const running = sGet(loop, 'RUNNING');
  if (!running) return null;
  const lines = running.split('\n');
  const pid = parseInt(lines[0] ?? '', 10);
  if (!pid) return null;
  try {
    process.kill(pid, 0); // gone, or not ours to signal: settled, no ps needed
  } catch {
    return null;
  }
  const cmd = lines.find((l) => l.startsWith('cmd '))?.slice(4).trim();
  // A marker predating this format can only be trusted by pid, as before; the
  // next start of that process writes one carrying its command.
  if (!cmd) return pid;
  const live = liveCommand(pid);
  // Anchored at the end so the supervisor's 'cli.js run' cannot match a loop's
  // 'cli.js run ward' if its pid is recycled to one.
  return live === cmd || live.endsWith(` ${cmd}`) ? pid : null;
}
