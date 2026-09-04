// Pure decision functions for the failure ladder, provider selection, and
// pacing — no side effects, unit-tested in isolation. The classifications
// encode the prototype's hard-won lessons:
//  - transient (API 429/529, network outage) is NEVER a failure: park and
//    retry; a rescuer launched into the same dead API dies with the patient.
//  - apparatus faults (missing constitution, unresolvable runtime) fail closed
//    immediately — never retry a half-instructed agent.
//  - runtime failures get a small consecutive cap, then a human.
import { ExitClass, RunChoice } from './types.js';

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

// A ready queue is standing state, not motion. Scoped loops get one restart
// pickup so work queued during downtime is not stranded; store-wide loops do
// not, because their motion-only wake is the triage signal itself (H-92/H-426).
export function wakeDecide(c: {
  changedSince: boolean;
  firstPoll: boolean;
  workstream: string;
  readyCount: number;
}): boolean {
  return c.changedSince || (c.firstPoll && c.workstream !== '*' && c.readyCount > 0);
}

// Same-seat guard (H-558): two live sessions sharing one crew name (a rev loop
// and a desk session or subagent) collided twice, each working over the
// other's in-flight tickets. Before spending an iteration, the loop asks who
// holds in_progress work in its name. Its own claims carry its seat stamp;
// anything else FRESH is another live instance and the loop stands down. A
// stale hold (past Helmo's takeover convention) is an abandoned claim, not a
// live session — blocking on it would let one forgotten ticket idle a loop
// forever, so the session gets to apply the normal takeover discipline
// instead. A hold whose claim cannot be found or dated is skipped for the
// same reason: the guard exists to yield to live work, never to wedge a seat
// on an unattributable record.
export type SeatAction = { act: 'work' } | { act: 'stand_down'; reason: string };

export function seatDecide(opts: {
  holds: { ticketId: string; claimSession: string | null; ageSeconds: number | null }[];
  seat: string;
  staleSeconds: number;
}): SeatAction {
  if (opts.staleSeconds <= 0) return { act: 'work' };
  for (const h of opts.holds) {
    if (h.claimSession === opts.seat) continue; // the seat's own mid-flight work
    if (h.ageSeconds === null || h.ageSeconds > opts.staleSeconds) continue; // abandoned or unattributable
    return {
      act: 'stand_down',
      reason: `${h.ticketId} held in this name by another live session${h.claimSession ? ` ('${h.claimSession}')` : ''} — claimed ${Math.round(h.ageSeconds / 60)}m ago`,
    };
  }
  return { act: 'work' };
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

// The probe tier (H-412; crew skills/model-selection.md). "Is there anything
// to do?" is a fixed near-zero-judgement task, and running it at the loop's
// working tier is pure waste — ward's cheapest sessions were exactly that
// shape. The wake-check makes the case deterministic for a scoped loop:
// nothing ready to draw AND nothing already in hand means the session ahead
// can only read the queue and stop, so it runs on the probe model.
//
// held_count arrives only from a helmo that reports it; when it is missing the
// answer is the working model — a probe misroute wastes cents, but real work
// accidentally run on the small tier is a misroute of judgement. Store-wide
// loops ('*') never probe: their motion-only wakes ARE the work (triage).
//
// A roster-wide pin ([global] probe, H-625) moves every probe to one
// provider/tier — the steady probe trickle comes off the primary provider's
// cap. The pin yields to the loop's own probe model when its cap is out, and
// never touches a mock loop: tests must stay hermetic.
export function probeDecide(c: {
  probeModel: string | undefined;
  workstream: string;
  readyCount: number;
  heldCount: number | undefined;
  pinned?: RunChoice;
  pinnedExhausted?: boolean;
  mock?: boolean;
}): { model: string; on?: RunChoice } | null {
  if (c.workstream === '*') return null;
  if (c.readyCount !== 0 || c.heldCount !== 0) return null;
  if (!c.mock && c.pinned && !c.pinnedExhausted) return { model: c.pinned.model, on: c.pinned };
  return c.probeModel ? { model: c.probeModel } : null;
}

// Which provider runs this iteration (H-479; crew skills/model-selection.md).
// The scheduled choice is the rotation cycle at the iteration's position —
// "every other run" falls out of a two-entry cycle. A provider whose cap the
// fresh snapshot says is out is skipped: first the rest of the cycle in order,
// then the fallbacks. When everything is out, the scheduled choice is returned
// unswitched and the transient ladder does what it always did — this function
// never invents availability.
export function choiceDecide(c: {
  choices: RunChoice[];
  fallbacks: RunChoice[];
  iteration: number; // 1-based
  exhausted: (choice: RunChoice) => boolean;
  headroom?: (choice: RunChoice) => number | null; // percentage points/hour until the binding reset
}): { choice: RunChoice; switched?: string } {
  const n = c.choices.length;
  const at = ((c.iteration - 1) % n + n) % n;
  const scheduled = c.choices[at]!;
  const candidates = [...c.choices.slice(at), ...c.choices.slice(0, at), ...c.fallbacks];
  if (c.headroom) {
    // Only the rotation is approved for proactive balancing. Fallbacks may
    // change tier and remain cap-out only. Unknown telemetry keeps the
    // operator's first available choice until both sides can be compared.
    const available = c.choices.filter((cand) => !c.exhausted(cand));
    const scores = available.map((choice) => ({ choice, score: c.headroom!(choice) }));
    if (scores.length && scores.every(({ score }) => score !== null && Number.isFinite(score) && score >= 0)) {
      const best = scores.reduce((a, b) => b.score! > a.score! ? b : a);
      return {
        choice: best.choice,
        switched: `headroom routing: ${best.choice.provider}/${best.choice.model} — ${scores.map(({ choice, score }) => `${choice.provider} ${score!.toFixed(2)}%/h`).join(', ')}`,
      };
    }
    const first = [...c.choices, ...c.fallbacks].find((cand) => !c.exhausted(cand));
    return {
      choice: first ?? c.choices[0]!,
      switched: 'headroom routing: fresh comparable usage unavailable — using configured provider order',
    };
  }
  for (const cand of candidates) {
    if (c.exhausted(cand)) continue;
    if (cand === scheduled) return { choice: scheduled };
    return {
      choice: cand,
      switched: `'${scheduled.provider}' cap is out — switched to ${cand.provider}/${cand.model}`,
    };
  }
  return { choice: scheduled };
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
