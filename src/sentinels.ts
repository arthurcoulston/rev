import { existsSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';
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
  try {
    appendFileSync(sPath(loop, 'events.log'), `${new Date().toISOString()} ${event.padEnd(12)} ${fields}\n`);
  } catch {
    /* a trace write must never affect the loop */
  }
}

export function pidAlive(loop: string): number | null {
  const running = sGet(loop, 'RUNNING');
  if (!running) return null;
  const pid = parseInt(running.split('\n')[0] ?? '', 10);
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}
