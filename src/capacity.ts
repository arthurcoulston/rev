// Provider capacity and runaway detection, in the units each provider actually
// exposes (H-179/H-185). Pure: snapshots and numbers in, decisions out, no I/O.
//
// The incident this exists to prevent: on 2026-09-29 Rev stopped a loop for
// 7h08m on a full backlog while both provider accounts had roughly a third of
// their weekly allowance unused. The gate was metering money that was never
// billed — both accounts are flat subscriptions — so the stop spent nothing and
// saved nothing. Three quantities, never substituted for one another:
//
//   plan capacity   the provider's own percent-of-window bars with reset times.
//                   The only quantity that says whether more work is possible.
//   notional        token-log dollars. Accounting and reporting, and the axis a
//                   runaway shows up on. Never a gate for ordinary work.
//   billed spend    not observable for a subscription provider. Said, not
//                   approximated.
//
// No percent here is ever converted to tokens or dollars, and no dollar figure
// is ever converted to a percent. The bars are plan allowance; that is all they
// are. `headroomRate` in usage.ts already holds this line and nothing new may
// cross it.
import { BillingMode, RunChoice } from './types.js';
import { hasSpendableCredits, UsageSnapshot, USAGE_MAX_AGE_MS } from './usage.js';

export type { BillingMode };

export interface CapacityThresholds {
  exhaustedPercent: number;          // limit_exhausted_percent — a bar at or above this is out
  sharedReservePercent: number;      // held back from loops so the operator's own sessions outlast them
  blockHorizonSeconds: number;       // a reset inside this is worth waiting out
  exhaustionCeilingSeconds: number;  // a reset beyond this is bad telemetry, not a plan
  staleGraceIterations: number;      // iterations that may run on stale bars before waiting
  staleWaitSeconds: number;          // how long to park once the grace is spent
}

// One choice's view of its own plan capacity. `snapshot` is the freshest read
// rev has for that provider — null when there has never been one.
export interface ChoiceCapacity {
  choice: RunChoice;
  snapshot: UsageSnapshot | null;
  refreshed: boolean;  // a refresh has already been attempted for it this iteration
}

export type CapacityDecision =
  | { act: 'continue'; on: RunChoice }
  | { act: 'switch'; on: RunChoice; reason: string }
  | { act: 'refresh'; providers: string[] }               // caller refreshes, then asks again
  | { act: 'continue_stale'; on: RunChoice; remaining: number; reason: string }
  | { act: 'wait'; seconds: number; reason: string }
  | { act: 'scheduled_resume'; resumeAt: string; reason: string }
  | { act: 'blocked'; reason: string };

/** The bar percent at which a run counts as out of capacity. The reserve is
 *  subtracted for LOOP runs only: the plan windows are shared with the
 *  operator's desk sessions, so the fleet stops consuming the last slice
 *  before he does. A desk session gets the full bar. */
export function effectiveExhaustedPercent(t: CapacityThresholds, isLoopRun: boolean): number {
  return isLoopRun ? Math.max(0, t.exhaustedPercent - t.sharedReservePercent) : t.exhaustedPercent;
}

/** No snapshot, or one older than the poll's own freshness window, or one the
 *  reader marked stale because the fetch failed. Stale bars never justify a
 *  wait (`exhaustedLimit` already refuses that) and they never justify an
 *  invented number either — they get the bounded grace path below. */
export function snapshotStale(s: UsageSnapshot | null, now: number, maxAgeMs = USAGE_MAX_AGE_MS): boolean {
  if (!s || s.stale) return true;
  const at = Date.parse(s.fetched_at);
  return !Number.isFinite(at) || now - at > maxAgeMs;
}

function outBars(s: UsageSnapshot, atPercent: number) {
  return s.limits.filter((l) => l.percent >= atPercent || l.severity === 'critical');
}

/** The binding reset for an exhausted snapshot: the soonest moment any of its
 *  out bars comes back. A bar with no reset time cannot schedule anything and
 *  is reported as unknown rather than guessed at. */
function earliestReset(s: UsageSnapshot, atPercent: number): { at: string; ms: number } | null {
  let best: { at: string; ms: number } | null = null;
  for (const l of outBars(s, atPercent)) {
    if (!l.resets_at) continue;
    const ms = Date.parse(l.resets_at);
    if (!Number.isFinite(ms)) continue;
    if (!best || ms < best.ms) best = { at: l.resets_at, ms };
  }
  return best;
}

/** Can this iteration run, and where?
 *
 *  continue          the scheduled choice has a fresh bar under the effective
 *                    exhaustion percent.
 *  switch            it does not and another choice does. (`choiceDecide`
 *                    already does this at run selection; this is the same
 *                    answer from the capacity side.)
 *  refresh           every choice's bars are stale and no refresh has been
 *                    tried yet. Neither refresh costs a model call, so it is
 *                    always worth one attempt before deciding on old numbers.
 *  continue_stale    still stale after that refresh, inside the grace. This is
 *                    deliberate: continuing on stale bars risks a 429, and a
 *                    429 is already handled by the transient ladder, whereas
 *                    stopping on stale bars risks another silent night.
 *  wait              every bar is out and the soonest reset is inside the
 *                    waiting horizon — or the stale grace is spent.
 *  scheduled_resume  every bar is out and the soonest reset is beyond the
 *                    horizon. This is the branch that used to be `blocked`,
 *                    which is how a weekly cap resetting in two days became a
 *                    wait for a human.
 *  blocked           every bar is out with no usable reset time, or one beyond
 *                    the exhaustion ceiling. Past the ceiling the telemetry is
 *                    wrong, not the plan, and that is a question.
 */
export function capacityDecide(c: {
  choices: ChoiceCapacity[];    // the scheduled choice first
  isLoopRun: boolean;
  staleIterations: number;      // consecutive iterations already run on stale bars
  thresholds: CapacityThresholds;
  nowMs?: number;
}): CapacityDecision {
  const now = c.nowMs ?? Date.now();
  const pct = effectiveExhaustedPercent(c.thresholds, c.isLoopRun);
  const scheduled = c.choices[0];
  if (!scheduled) return { act: 'blocked', reason: 'capacity: the loop has no run choices.' };

  const stale: ChoiceCapacity[] = [];
  const available: ChoiceCapacity[] = [];
  const out: ChoiceCapacity[] = [];
  for (const cc of c.choices) {
    if (snapshotStale(cc.snapshot, now)) stale.push(cc);
    else if (outBars(cc.snapshot!, pct).length && !hasSpendableCredits(cc.snapshot)) out.push(cc);
    else available.push(cc);
  }

  if (available.length) {
    const first = available[0]!;
    // By provider+model rather than object identity: callers legitimately
    // rebuild a choice (spreading a probe model onto it, for one), and a
    // rebuilt scheduled choice must not read as a switch to itself.
    if (first.choice.provider === scheduled.choice.provider && first.choice.model === scheduled.choice.model) {
      return { act: 'continue', on: first.choice };
    }
    return {
      act: 'switch',
      on: first.choice,
      reason: `capacity: '${scheduled.choice.provider}' is out or unreadable — switched to ${first.choice.provider}/${first.choice.model}`,
    };
  }

  // Nothing readable is free. Stale choices come first: an unknown bar is not
  // an exhausted one, and treating it as exhausted is how a telemetry fault
  // becomes an outage.
  if (stale.length) {
    const unrefreshed = stale.filter((s) => !s.refreshed).map((s) => s.choice.provider);
    if (unrefreshed.length) return { act: 'refresh', providers: [...new Set(unrefreshed)] };
    const remaining = c.thresholds.staleGraceIterations - c.staleIterations;
    if (remaining > 0) {
      return {
        act: 'continue_stale',
        on: stale[0]!.choice,
        remaining,
        reason:
          `capacity: no fresh usage for ${stale.map((s) => s.choice.provider).join(', ')} after a refresh — ` +
          `continuing on the transient ladder for ${remaining} more iteration(s) rather than stopping on numbers we do not have`,
      };
    }
    return {
      act: 'wait',
      seconds: c.thresholds.staleWaitSeconds,
      reason:
        `capacity: usage for ${stale.map((s) => s.choice.provider).join(', ')} has been unreadable for ` +
        `${c.staleIterations} iterations, past the grace of ${c.thresholds.staleGraceIterations} — waiting rather than guessing`,
    };
  }

  // Every choice's bars are fresh and out. The soonest reset across all of them
  // decides whether this is a wait, a scheduled resume, or a real question.
  let best: { at: string; ms: number; cc: ChoiceCapacity } | null = null;
  for (const cc of out) {
    const r = earliestReset(cc.snapshot!, pct);
    if (r && (!best || r.ms < best.ms)) best = { ...r, cc };
  }
  const bars = out.map((cc) => {
    const worst = outBars(cc.snapshot!, pct).reduce((a, b) => (b.percent > a.percent ? b : a));
    return `${cc.choice.provider} ${worst.label} at ${worst.percent}%`;
  }).join('; ');

  if (!best) {
    return {
      act: 'blocked',
      reason: `capacity: every choice's plan window is out (${bars}) and none reports a reset time, so there is nothing to resume at.`,
    };
  }
  const secondsAway = Math.round((best.ms - now) / 1000);
  if (secondsAway <= 0) return { act: 'wait', seconds: 60, reason: `capacity: ${bars}, reset ${best.at} has passed but the bars have not moved yet.` };
  if (secondsAway <= c.thresholds.blockHorizonSeconds) {
    return { act: 'wait', seconds: secondsAway + 60, reason: `capacity: ${bars} — waiting out the reset at ${best.at}.` };
  }
  if (secondsAway > c.thresholds.exhaustionCeilingSeconds) {
    return {
      act: 'blocked',
      reason:
        `capacity: ${bars}, reset ${best.at} — that is ${Math.round(secondsAway / 86400)} days out, beyond any plan window. ` +
        `The telemetry is wrong rather than the plan, and that is a question rather than a wait.`,
    };
  }
  return {
    act: 'scheduled_resume',
    resumeAt: best.at,
    reason:
      `capacity: ${bars} — every choice is out and the soonest reset is ${best.at}, ` +
      `${Math.round(secondsAway / 3600)}h beyond the ${Math.round(c.thresholds.blockHorizonSeconds / 3600)}h waiting horizon. Resuming there.`,
  };
}

export interface AnomalyThresholds {
  rateMultiple: number;  // × the loop's own rolling mean of the last 5 iterations
  minUsd: number;        // floor below which a multiple is noise, not a runaway
  absPercent: number;    // plan percentage points one iteration may consume
}

/** Is the iteration that just ran a runaway?
 *
 *  A runaway is a change in slope; a productive night is a straight line. So
 *  the evidence is a RATE, never a cumulative total — the cumulative total is
 *  what stopped the fleet on a full backlog and it will do it again.
 *
 *  Measured on notional cost, deliberately NOT on tokens. Calibrated against
 *  the 625-line Good Plumb token-log (597 rolling windows, five loops, four
 *  days): the two largest token ratios in the whole record are x84.02 and
 *  x33.01, and both cost LESS than their own means (x0.45 and x0.29). They are
 *  cache-read-heavy iterations — the cheapest shape there is, and the exact
 *  opposite of a runaway. A tokens axis would stop a loop for reading its own
 *  context efficiently. Cost tracks the quantity that actually runs away.
 *
 *  The multiple itself: over those 597 windows, a cost multiple of 4 would have
 *  tripped 23 times, 5 would have tripped 7, and 6 twice — roughly one trip per
 *  300 iterations, about a week of fleet time. 6 stands.
 *
 *  The floor is why `minUsd` exists and the design's first cut did not have it.
 *  A $1 floor still stopped three ordinary transitions from cheap queue passes
 *  to substantive builds: $1.71/$0.19, $2.30/$0.19 and $2.55/$0.33. The floor
 *  is therefore $5: above every confirmed productive transition, while the
 *  historical $5.17/$0.60 cost blowout still trips. This cost heuristic is a
 *  backstop; the independently measured plan-point ceiling remains absolute.
 *
 *  An iteration whose cost the shim could not determine (the token-log carries
 *  `cost_usd=?` lines) is never a trip and must never enter the mean: an
 *  unknown read as zero drags the mean down and makes the next ordinary
 *  iteration look like a blowout.
 */
export function anomalyDecide(o: {
  observedUsd: number | undefined;      // notional cost of the iteration just run
  meanUsd: number;                      // rolling mean of the last 5 parseable iterations
  windowSize: number;                   // how many iterations that mean is over
  planPointsUsed?: number | null;       // plan percentage points this one iteration consumed
  thresholds: AnomalyThresholds;
}): { act: 'ok' } | { act: 'trip'; kind: 'anomaly'; reason: string } {
  const t = o.thresholds;

  // The absolute rule first: a shape no productive iteration has, so it trips
  // regardless of the mean — including on a loop's very first iterations,
  // before there is a mean worth comparing against.
  if (o.planPointsUsed != null && Number.isFinite(o.planPointsUsed) && o.planPointsUsed > t.absPercent) {
    return {
      act: 'trip',
      kind: 'anomaly',
      reason:
        `anomaly: one iteration consumed ${o.planPointsUsed.toFixed(1)} percentage points of a plan window, ` +
        `over the ${t.absPercent} point ceiling for a single iteration`,
    };
  }

  const usd = o.observedUsd;
  if (usd == null || !Number.isFinite(usd)) return { act: 'ok' };
  if (usd < t.minUsd) return { act: 'ok' };
  if (!(o.meanUsd > 0)) return { act: 'ok' };
  if (usd > t.rateMultiple * o.meanUsd) {
    return {
      act: 'trip',
      kind: 'anomaly',
      reason:
        `anomaly: observed=$${usd.toFixed(2)} mean=$${o.meanUsd.toFixed(2)} window=${o.windowSize} ` +
        `over=${(usd / o.meanUsd).toFixed(1)}x the ${t.rateMultiple}x rate multiple`,
    };
  }
  return { act: 'ok' };
}

/** Largest movement of one unchanged plan window. A reset is a new window,
 *  not negative consumption, and unmatched bars are unknown rather than zero. */
export function planPointsConsumed(
  before: UsageSnapshot | null,
  after: UsageSnapshot | null,
): number | undefined {
  if (!before || !after || before.stale || after.stale) return undefined;
  const movements = after.limits.flatMap((next) => {
    const prior = before.limits.find((old) =>
      old.kind === next.kind && old.label === next.label && old.resets_at === next.resets_at,
    );
    if (!prior) return [];
    const movement = next.percent - prior.percent;
    return Number.isFinite(movement) && movement >= 0 ? [movement] : [];
  });
  return movements.length ? Math.max(...movements) : undefined;
}

/** Whether the dollar gate applies at all. A subscription account's token-log
 *  dollars are notional — for codex they come from roster prices x tokens, and
 *  for claude from the CLI's API-equivalent estimate on a flat plan. Neither is
 *  money, so neither may stop productive work. The burn caps stay in the roster
 *  as the recorded ceilings they are, and a future pay-per-token provider gets
 *  them back by declaring itself metered. */
export function dollarGateApplies(billing: BillingMode | undefined): boolean {
  return (billing ?? 'metered') === 'metered';
}
