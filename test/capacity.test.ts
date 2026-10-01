import { describe, it, expect } from 'vitest';
import { anomalyDecide, capacityDecide, dollarGateApplies, effectiveExhaustedPercent, planPointsConsumed, snapshotStale } from '../src/capacity.js';
import { RunChoice } from '../src/types.js';
import { UsageSnapshot } from '../src/usage.js';

const NOW = Date.parse('2026-09-29T08:00:00.000Z');

const thresholds = {
  exhaustedPercent: 95,
  sharedReservePercent: 5,
  blockHorizonSeconds: 7200,
  exhaustionCeilingSeconds: 691200,
  staleGraceIterations: 6,
  staleWaitSeconds: 900,
};

const anomaly = { rateMultiple: 6, minUsd: 5.0, absPercent: 10 };

const claude: RunChoice = { provider: 'claude', runtime: 'claude', model: 'claude-opus-5' };
const codex: RunChoice = { provider: 'codex', runtime: 'codex', model: 'gpt-5.6-terra' };

/** A snapshot whose bars sit at the given percents, fetched just now. `resets`
 *  is hours from NOW; null means the provider reported no reset time. */
function snap(percents: number[], resets: (number | null)[] = [], fetchedMsAgo = 0): UsageSnapshot {
  return {
    fetched_at: new Date(NOW - fetchedMsAgo).toISOString(),
    stale: false,
    limits: percents.map((percent, i) => ({
      kind: 'weekly_all',
      label: `weekly (all models) #${i}`,
      percent,
      severity: 'ok',
      resets_at: resets[i] === undefined || resets[i] === null ? null : new Date(NOW + resets[i]! * 3_600_000).toISOString(),
      active: true,
    })),
  };
}

describe('capacityDecide — a productive backlog at real capacity (matrix 1)', () => {
  it('continues at the bars that stopped the fleet on 2026-09-29', () => {
    // Claude weekly 65%, codex weekly 64% — the live figures at the moment a
    // $83.46/24h notional counter halted Builder for 7h08m.
    const d = capacityDecide({
      choices: [
        { choice: claude, snapshot: snap([65]), refreshed: false },
        { choice: codex, snapshot: snap([64]), refreshed: false },
      ],
      isLoopRun: true,
      staleIterations: 0,
      thresholds,
      nowMs: NOW,
    });
    expect(d).toEqual({ act: 'continue', on: claude });
  });

  it('never consults a dollar gate for a subscription account', () => {
    expect(dollarGateApplies('subscription')).toBe(false);
    // An estate that declares nothing keeps every gate it has today.
    expect(dollarGateApplies('metered')).toBe(true);
    expect(dollarGateApplies(undefined)).toBe(true);
  });
});

describe('capacityDecide — the shared reserve', () => {
  it('holds the last slice back from loops but not from a desk session', () => {
    expect(effectiveExhaustedPercent(thresholds, true)).toBe(90);
    expect(effectiveExhaustedPercent(thresholds, false)).toBe(95);
    const choices = [{ choice: claude, snapshot: snap([92], [1]), refreshed: false }];
    expect(capacityDecide({ choices, isLoopRun: true, staleIterations: 0, thresholds, nowMs: NOW }).act).toBe('wait');
    expect(capacityDecide({ choices, isLoopRun: false, staleIterations: 0, thresholds, nowMs: NOW }).act).toBe('continue');
  });
});

describe('capacityDecide — switching', () => {
  it('switches to a fresh provider when the scheduled one is out', () => {
    const d = capacityDecide({
      choices: [
        { choice: claude, snapshot: snap([99], [1]), refreshed: false },
        { choice: codex, snapshot: snap([20]), refreshed: false },
      ],
      isLoopRun: true,
      staleIterations: 0,
      thresholds,
      nowMs: NOW,
    });
    expect(d.act).toBe('switch');
    expect(d).toMatchObject({ on: codex });
  });

  it('does not read a rebuilt scheduled choice as a switch to itself', () => {
    const d = capacityDecide({
      choices: [{ choice: { ...claude, probe_model: 'claude-haiku-4-5' }, snapshot: snap([10]), refreshed: false }],
      isLoopRun: true,
      staleIterations: 0,
      thresholds,
      nowMs: NOW,
    });
    expect(d.act).toBe('continue');
  });
});

describe('capacityDecide — genuine exhaustion (matrix 4)', () => {
  it('continues on fresh Codex credits after included plan bars are exhausted (H-481)', () => {
    const credited = {
      ...snap([100], [48]),
      credit_capacity: {
        has_credits: true, unlimited: false, balance: '123.45',
        spend_control_reached: false, ordinary_usage_allowed: false,
      },
    };
    expect(capacityDecide({
      choices: [{ choice: codex, snapshot: credited, refreshed: false }],
      isLoopRun: true, staleIterations: 0, thresholds, nowMs: NOW,
    })).toEqual({ act: 'continue', on: codex });
  });
  it('waits out a reset inside the horizon', () => {
    const d = capacityDecide({
      choices: [
        { choice: claude, snapshot: snap([99], [1]), refreshed: false },
        { choice: codex, snapshot: snap([99], [1.5]), refreshed: false },
      ],
      isLoopRun: true,
      staleIterations: 0,
      thresholds,
      nowMs: NOW,
    });
    expect(d).toMatchObject({ act: 'wait', seconds: 3660 });
  });

  it('schedules its own resume past the horizon instead of asking a human', () => {
    // A weekly cap resetting in two days. This is the branch that used to be
    // `blocked`, and blocked meant waiting for Arthur.
    const d = capacityDecide({
      choices: [{ choice: claude, snapshot: snap([99], [48]), refreshed: false }],
      isLoopRun: true,
      staleIterations: 0,
      thresholds,
      nowMs: NOW,
    });
    expect(d.act).toBe('scheduled_resume');
    expect(d).toMatchObject({ resumeAt: new Date(NOW + 48 * 3_600_000).toISOString() });
  });

  it('resumes at the soonest reset across every choice', () => {
    const d = capacityDecide({
      choices: [
        { choice: claude, snapshot: snap([99], [72]), refreshed: false },
        { choice: codex, snapshot: snap([99], [30]), refreshed: false },
      ],
      isLoopRun: true,
      staleIterations: 0,
      thresholds,
      nowMs: NOW,
    });
    expect(d).toMatchObject({ act: 'scheduled_resume', resumeAt: new Date(NOW + 30 * 3_600_000).toISOString() });
  });

  it('blocks past the exhaustion ceiling, where the telemetry is wrong not the plan', () => {
    const d = capacityDecide({
      choices: [{ choice: claude, snapshot: snap([99], [24 * 30]), refreshed: false }],
      isLoopRun: true,
      staleIterations: 0,
      thresholds,
      nowMs: NOW,
    });
    expect(d.act).toBe('blocked');
  });

  it('blocks rather than guessing when an out bar reports no reset time', () => {
    const d = capacityDecide({
      choices: [{ choice: claude, snapshot: snap([99], [null]), refreshed: false }],
      isLoopRun: true,
      staleIterations: 0,
      thresholds,
      nowMs: NOW,
    });
    expect(d.act).toBe('blocked');
    expect((d as { reason: string }).reason).toContain('none reports a reset time');
  });

  it('parks briefly when the reset has passed but the bars have not moved', () => {
    const d = capacityDecide({
      choices: [{ choice: claude, snapshot: snap([99], [-1]), refreshed: false }],
      isLoopRun: true,
      staleIterations: 0,
      thresholds,
      nowMs: NOW,
    });
    expect(d).toMatchObject({ act: 'wait', seconds: 60 });
  });
});

describe('capacityDecide — stale or missing telemetry (matrix 5)', () => {
  it('asks for one refresh first', () => {
    const d = capacityDecide({
      choices: [{ choice: claude, snapshot: null, refreshed: false }],
      isLoopRun: true,
      staleIterations: 0,
      thresholds,
      nowMs: NOW,
    });
    expect(d).toEqual({ act: 'refresh', providers: ['claude'] });
  });

  it('then continues under a bounded grace, and waits once it is spent', () => {
    const stale = [{ choice: claude, snapshot: null, refreshed: true }];
    const d = capacityDecide({ choices: stale, isLoopRun: true, staleIterations: 5, thresholds, nowMs: NOW });
    expect(d).toMatchObject({ act: 'continue_stale', remaining: 1 });
    const spent = capacityDecide({ choices: stale, isLoopRun: true, staleIterations: 6, thresholds, nowMs: NOW });
    expect(spent).toMatchObject({ act: 'wait', seconds: 900 });
  });

  it('treats a snapshot older than the freshness window as stale', () => {
    expect(snapshotStale(snap([10], [], 31 * 60_000), NOW)).toBe(true);
    expect(snapshotStale(snap([10], [], 60_000), NOW)).toBe(false);
    expect(snapshotStale({ ...snap([10]), stale: true }, NOW)).toBe(true);
    expect(snapshotStale(null, NOW)).toBe(true);
  });

  it('never invents a percent — an unreadable bar is not an exhausted one', () => {
    // The scheduled provider is unreadable and the other is genuinely free:
    // the free one runs, rather than the fleet stopping on numbers it lacks.
    const d = capacityDecide({
      choices: [
        { choice: claude, snapshot: null, refreshed: true },
        { choice: codex, snapshot: snap([30]), refreshed: false },
      ],
      isLoopRun: true,
      staleIterations: 0,
      thresholds,
      nowMs: NOW,
    });
    expect(d).toMatchObject({ act: 'switch', on: codex });
  });
});

describe('anomalyDecide — a runaway is a slope, not a total (matrix 3)', () => {
  it('trips on a single iteration taking 12 plan points', () => {
    const d = anomalyDecide({ observedUsd: 0.4, meanUsd: 0.5, windowSize: 5, planPointsUsed: 12, thresholds: anomaly });
    expect(d.act).toBe('trip');
    expect((d as { reason: string }).reason).toContain('12.0 percentage points');
  });

  it('trips on the plan-points rule before a mean exists', () => {
    expect(anomalyDecide({ observedUsd: undefined, meanUsd: 0, windowSize: 0, planPointsUsed: 40, thresholds: anomaly }).act).toBe('trip');
  });

  it('trips on a real cost blowout and names the numbers it measured', () => {
    // builder 2026-09-27T23:50 — $5.17 against a $0.60 mean, the one window in
    // the fleet's whole history that clears both the multiple and the floor.
    const d = anomalyDecide({ observedUsd: 5.17, meanUsd: 0.6, windowSize: 5, planPointsUsed: 1, thresholds: anomaly });
    expect(d.act).toBe('trip');
    expect((d as { reason: string }).reason).toBe('anomaly: observed=$5.17 mean=$0.60 window=5 over=8.6x the 6x rate multiple');
  });

  it.each([
    ['builder H-273', 1.71, 0.19],
    ['cyber H-303', 2.30, 0.19],
    ['cyber H-306', 2.55, 0.33],
  ])('does not mistake the %s cheap-pass to build transition for a runaway', (_incident, observedUsd, meanUsd) => {
    expect(anomalyDecide({ observedUsd, meanUsd, windowSize: 5, planPointsUsed: 1, thresholds: anomaly }).act).toBe('ok');
  });

  it('does not trip on a productive straight line', () => {
    expect(anomalyDecide({ observedUsd: 6.49, meanUsd: 5.8, windowSize: 5, planPointsUsed: 2, thresholds: anomaly }).act).toBe('ok');
  });

  it('does not trip on a cache-heavy iteration, whatever its token count', () => {
    // builder 2026-09-29T05:39 read 84x its mean in tokens and cost 0.45x its
    // mean in money. On a tokens axis that is the fleet's biggest "anomaly";
    // it is in fact the cheapest shape there is, and stopping for it would
    // punish a loop for reading its own context efficiently.
    expect(anomalyDecide({ observedUsd: 1.56, meanUsd: 3.47, windowSize: 5, planPointsUsed: 1, thresholds: anomaly }).act).toBe('ok');
  });

  it('does not trip on a multiple of a trivial base', () => {
    // tester at $0.72 against a $0.12 mean is 6x, and 72 cents is not a
    // runaway. Halting a loop over it is the false alarm that teaches everyone
    // to ignore the alarm.
    expect(anomalyDecide({ observedUsd: 0.72, meanUsd: 0.12, windowSize: 5, planPointsUsed: 1, thresholds: anomaly }).act).toBe('ok');
  });

  it('never trips on a cost the shim could not determine', () => {
    // The token-log carries `cost_usd=?` lines; they are unknown, not zero.
    expect(anomalyDecide({ observedUsd: undefined, meanUsd: 0.5, windowSize: 5, thresholds: anomaly }).act).toBe('ok');
    expect(anomalyDecide({ observedUsd: NaN, meanUsd: 0.5, windowSize: 5, thresholds: anomaly }).act).toBe('ok');
  });

  it('holds its peace before there is a mean to compare against', () => {
    expect(anomalyDecide({ observedUsd: 40, meanUsd: 0, windowSize: 0, thresholds: anomaly }).act).toBe('ok');
  });
});

describe('planPointsConsumed', () => {
  it('compares only the same plan window and reports its largest movement', () => {
    const before = snap([20], [10]);
    const after = snap([32], [10]);
    expect(planPointsConsumed(before, after)).toBe(12);
    expect(planPointsConsumed(before, snap([2], [11]))).toBeUndefined();
  });
});
