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

// The burn breaker (H-412). The ladder above judges each iteration on how it
// ended; this judges the loop on what it has cost. Two burns motivated it and
// neither showed up as a failure: bosun spent $86 in a day triaging, and rolo
// ran 52 consecutive productive-looking iterations for $108. Both looked
// healthy to every check rev had.
//
// Thresholds are set from the whole token-log, not from taste: no loop hour has
// ever exceeded $28, no normal day exceeds $36, and no loop but rolo has ever
// strung more than five iterations together. Defaults sit above every observed
// legitimate figure so a trip means new territory, never a busy afternoon.
//
// What this does NOT catch: a small spin. Ward's five-iteration loop against a
// one-ticket wake cost $5.70 — under every cap here, and correctly so. That one
// is a question of what counts as production, not of how much was spent.
export interface BurnCaps {
  usdPerHour: number;   // 0 disables
  usdPerDay: number;    // 0 disables
  continueCap: number;  // consecutive iterations without idling; 0 disables
}

export function breakerDecide(
  s: { hourUsd: number; dayUsd: number; continueStreak: number },
  caps: BurnCaps,
): { act: 'ok' } | { act: 'trip'; reason: string } {
  if (caps.usdPerHour > 0 && s.hourUsd > caps.usdPerHour) {
    return { act: 'trip', reason: `burn breaker: $${s.hourUsd.toFixed(2)} metered in the last hour, over the $${caps.usdPerHour.toFixed(2)} cap` };
  }
  if (caps.usdPerDay > 0 && s.dayUsd > caps.usdPerDay) {
    return { act: 'trip', reason: `burn breaker: $${s.dayUsd.toFixed(2)} metered in the last 24h, over the $${caps.usdPerDay.toFixed(2)} cap` };
  }
  if (caps.continueCap > 0 && s.continueStreak > caps.continueCap) {
    return { act: 'trip', reason: `burn breaker: ${s.continueStreak} consecutive iterations without idling, over the cap of ${caps.continueCap} — the loop is not reaching a stopping point` };
  }
  return { act: 'ok' };
}

// What to do about a transient API condition, now that rev can see which cap
// it hit (H-402, using the H-278 poller).
//
// The old behaviour was one rule for every 429: wait 15 minutes, up to twenty
// times, then block. For an overloaded API that is right. For an exhausted
// weekly quota it is exactly wrong — on 2026-08-26 three loops spent five
// hours of blind retries and then sat blocked for 34-42 more, while the answer
// ("this resets Thursday at 18:00") was in the response and in the usage
// endpoint the whole time.
//
// So: a cap that resets soon is waited out to its reset. A cap that resets
// beyond the horizon is a decision, and goes to a human immediately, naming
// the cap and the time. Anything we cannot identify keeps the old ladder.
export interface LimitContext {
  limitStreak: number;
  limitCap: number;
  limitWait: number;
  blockHorizonSeconds: number;
  /** From the usage endpoint: the bar that is actually out, if known. */
  exhausted: { label: string; percent: number; resets_at: string | null } | null;
  /** What the 429 itself said, for the escalation. */
  message?: string;
  nowMs?: number;
}

export function limitDecide(c: LimitContext): LadderAction {
  const now = c.nowMs ?? Date.now();
  const said = c.message ? ` The API said: ${c.message.slice(0, 300)}` : '';

  if (c.exhausted) {
    const resetMs = c.exhausted.resets_at ? Date.parse(c.exhausted.resets_at) : NaN;
    const secondsAway = Number.isFinite(resetMs) ? Math.round((resetMs - now) / 1000) : NaN;
    const when = c.exhausted.resets_at ?? 'an unknown time';
    const cap = `${c.exhausted.label} at ${c.exhausted.percent}%`;

    if (!Number.isFinite(secondsAway) || secondsAway > c.blockHorizonSeconds) {
      return {
        act: 'blocked',
        reason:
          `quota exhausted — ${cap}, resets ${when}. That is beyond the ${Math.round(c.blockHorizonSeconds / 3600)}h waiting horizon, ` +
          `so this is a decision rather than a retry: move the loop to another model, or leave it down until the reset.${said}`,
      };
    }
    if (secondsAway <= 0) return { act: 'limit_wait', waitSeconds: 60, attempt: c.limitStreak };
    // Wait to the reset plus a small margin, rather than counting attempts.
    return { act: 'limit_wait', waitSeconds: secondsAway + 60, attempt: c.limitStreak };
  }

  // Nothing identifiable: the pre-existing ladder, unchanged.
  if (c.limitStreak > c.limitCap) {
    return {
      act: 'blocked',
      reason: `transient-condition cap exceeded (${c.limitStreak} consecutive waits) — beyond any session window, needs a human look.${said}`,
    };
  }
  return { act: 'limit_wait', waitSeconds: c.limitWait, attempt: c.limitStreak };
}
