// Pure decision functions for the failure ladder and pacing — no side effects,
// unit-tested in isolation. The classifications encode the prototype's
// hard-won lessons:
//  - transient (API 429/529, network outage) is NEVER a failure: park and
//    retry; a rescuer launched into the same dead API dies with the patient.
//  - apparatus faults (missing constitution, unresolvable runtime) fail closed
//    immediately — never retry a half-instructed agent.
//  - runtime failures get a small consecutive cap, then a human.
import { ExitClass } from './types.js';

// Exit-code contract with the runtime shim (ports the prototype's):
//   0 = clean; 75 = transient external condition; 78 = apparatus fault.
export function classifyExit(rc: number): ExitClass {
  if (rc === 0) return 'ok';
  if (rc === 75) return 'transient';
  if (rc === 78) return 'apparatus';
  return 'failure';
}

export type LadderAction =
  | { act: 'continue' }
  | { act: 'idle' }
  | { act: 'limit_wait'; waitSeconds: number; attempt: number }
  | { act: 'blocked'; reason: string };

export function ladderDecide(
  cls: ExitClass,
  opts: { produced: boolean; failStreak: number; limitStreak: number; failCap: number; limitCap: number; limitWait: number },
): LadderAction {
  switch (cls) {
    case 'ok':
      return opts.produced ? { act: 'continue' } : { act: 'idle' };
    case 'transient':
      if (opts.limitStreak > opts.limitCap) {
        return { act: 'blocked', reason: `transient-condition cap exceeded (${opts.limitStreak} consecutive waits) — beyond any session window, needs a human look` };
      }
      return { act: 'limit_wait', waitSeconds: opts.limitWait, attempt: opts.limitStreak };
    case 'apparatus':
      return { act: 'blocked', reason: 'apparatus fault (missing/empty constitution or unresolvable runtime) — fail closed, never retried' };
    case 'failure':
      if (opts.failStreak > opts.failCap) {
        return { act: 'blocked', reason: `runtime failed ${opts.failStreak} consecutive iterations (cap ${opts.failCap})` };
      }
      return { act: 'continue' };
  }
}

// Supervisor respawn policy for a loop-process exit. A halt sentinel means the
// exit was deliberate (or escalated): never respawn over an operator's or the
// ladder's decision — poll until it is cleared. A clean exit after a healthy
// uptime is the iteration ceiling doing its job: fresh process, no penalty.
// Everything else — crash, signal, or an exit too young to trust — climbs an
// exponential backoff so a wedged loop cannot spin the machine.
export type RespawnAction =
  | { act: 'respawn'; waitSeconds: number }
  | { act: 'await_clearance' };

export function respawnDecide(opts: {
  halted: boolean;             // STOP/HOLD/BLOCKED present at exit
  exitCode: number | null;     // null = killed by signal
  uptimeSeconds: number;
  restartStreak: number;       // consecutive unhealthy exits, this one included
  backoffBase: number;
  backoffCap: number;
  minUptime: number;
}): RespawnAction {
  if (opts.halted) return { act: 'await_clearance' };
  if (opts.exitCode === 0 && opts.uptimeSeconds >= opts.minUptime) return { act: 'respawn', waitSeconds: 0 };
  const wait = Math.min(opts.backoffCap, opts.backoffBase * 2 ** Math.max(0, opts.restartStreak - 1));
  return { act: 'respawn', waitSeconds: wait };
}

// Velocity fraction -> inter-iteration pause seconds, using the loop's measured
// mean iteration duration (or a default before one exists). pace>=1 => no pause.
export function velocityToPause(pace: number, tAvgSeconds: number, defaultTiter = 180): number {
  if (!(pace > 0) || pace >= 1) return 0;
  const t = tAvgSeconds > 0 ? tAvgSeconds : defaultTiter;
  return Math.max(0, Math.round((t * (1 - pace)) / pace));
}

// Rolling mean over the last n durations.
export function rollingMean(window: number[], next: number, n = 5): { window: number[]; mean: number } {
  const w = [...window, next].slice(-n);
  return { window: w, mean: Math.round(w.reduce((a, b) => a + b, 0) / w.length) };
}
