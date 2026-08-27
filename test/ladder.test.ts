import { describe, it, expect } from 'vitest';
import { breakerDecide, classifyExit, limitDecide, ladderDecide, probeDecide, respawnDecide, rollingMean, velocityToPause } from '../src/ladder.js';

const base = { produced: true, failStreak: 0, limitStreak: 0, failCap: 2, limitCap: 20, limitWait: 900 };

describe('classifyExit', () => {
  it('maps the shim contract', () => {
    expect(classifyExit(0)).toBe('ok');
    expect(classifyExit(75)).toBe('transient');
    expect(classifyExit(78)).toBe('apparatus');
    expect(classifyExit(1)).toBe('failure');
    expect(classifyExit(143)).toBe('failure');
  });
});

describe('ladderDecide', () => {
  it('ok+produced continues; ok+unproduced idles', () => {
    expect(ladderDecide('ok', base).act).toBe('continue');
    expect(ladderDecide('ok', { ...base, produced: false }).act).toBe('idle');
  });
  it('transient parks with the wait, never fails, until the cap', () => {
    const a = ladderDecide('transient', { ...base, limitStreak: 1 });
    expect(a).toEqual({ act: 'limit_wait', waitSeconds: 900, attempt: 1 });
    expect(ladderDecide('transient', { ...base, limitStreak: 21 }).act).toBe('blocked');
  });
  it('apparatus fails closed immediately', () => {
    expect(ladderDecide('apparatus', base).act).toBe('blocked');
  });
  it('failures retry under the cap then block', () => {
    expect(ladderDecide('failure', { ...base, failStreak: 1 }).act).toBe('continue');
    expect(ladderDecide('failure', { ...base, failStreak: 2 }).act).toBe('continue');
    expect(ladderDecide('failure', { ...base, failStreak: 3 }).act).toBe('blocked');
  });
});

describe('respawnDecide', () => {
  const base = { halted: false, exitCode: 0, uptimeSeconds: 300, restartStreak: 0, backoffBase: 30, backoffCap: 900, minUptime: 60 };
  it('a halt sentinel always wins — never respawn over a decision', () => {
    expect(respawnDecide({ ...base, halted: true }).act).toBe('await_clearance');
    expect(respawnDecide({ ...base, halted: true, exitCode: 1, restartStreak: 5 }).act).toBe('await_clearance');
  });
  it('clean exit after healthy uptime respawns immediately (the ceiling working)', () => {
    expect(respawnDecide(base)).toEqual({ act: 'respawn', waitSeconds: 0 });
  });
  it('crashes climb an exponential backoff to the cap', () => {
    expect(respawnDecide({ ...base, exitCode: 1, restartStreak: 1 })).toEqual({ act: 'respawn', waitSeconds: 30 });
    expect(respawnDecide({ ...base, exitCode: 1, restartStreak: 2 })).toEqual({ act: 'respawn', waitSeconds: 60 });
    expect(respawnDecide({ ...base, exitCode: 1, restartStreak: 4 })).toEqual({ act: 'respawn', waitSeconds: 240 });
    expect(respawnDecide({ ...base, exitCode: 1, restartStreak: 10 })).toEqual({ act: 'respawn', waitSeconds: 900 });
  });
  it('a signal kill and a too-young clean exit are both unhealthy', () => {
    expect(respawnDecide({ ...base, exitCode: null, restartStreak: 1 })).toEqual({ act: 'respawn', waitSeconds: 30 });
    expect(respawnDecide({ ...base, uptimeSeconds: 5, restartStreak: 1 })).toEqual({ act: 'respawn', waitSeconds: 30 });
  });
});

describe('velocityToPause', () => {
  it('full speed = no pause; fraction slows using measured duration', () => {
    expect(velocityToPause(1, 120)).toBe(0);
    expect(velocityToPause(0.5, 120)).toBe(120); // half speed => equal pause
    expect(velocityToPause(0.25, 100)).toBe(300);
    expect(velocityToPause(0.5, 0)).toBe(180); // default T_iter before measurement
  });
});

describe('rollingMean', () => {
  it('keeps a bounded window', () => {
    let w: number[] = [];
    let m = 0;
    for (const d of [10, 20, 30, 40, 50, 60]) ({ window: w, mean: m } = rollingMean(w, d));
    expect(w).toEqual([20, 30, 40, 50, 60]);
    expect(m).toBe(40);
  });
});

describe('breakerDecide (H-412)', () => {
  const caps = { usdPerHour: 30, usdPerDay: 75, continueCap: 15 };
  const quiet = { hourUsd: 2, dayUsd: 12, continueStreak: 3 };

  it('passes an ordinary loop day', () => {
    expect(breakerDecide(quiet, caps).act).toBe('ok');
  });

  it('trips on the hour cap, and says what it saw', () => {
    const d = breakerDecide({ ...quiet, hourUsd: 31 }, caps);
    expect(d.act).toBe('trip');
    expect(d.act === 'trip' && d.reason).toContain('$31.00');
  });

  it("trips on the day cap — bosun's $86 and rolo's $108 would both have been caught", () => {
    expect(breakerDecide({ ...quiet, dayUsd: 85.99 }, caps).act).toBe('trip');
    expect(breakerDecide({ ...quiet, dayUsd: 108.31 }, caps).act).toBe('trip');
  });

  it("trips on a loop that never idles — rolo's 52-iteration run", () => {
    expect(breakerDecide({ ...quiet, continueStreak: 52 }, caps).act).toBe('trip');
    expect(breakerDecide({ ...quiet, continueStreak: 15 }, caps).act).toBe('ok');
  });

  it('leaves every legitimate figure in the token-log alone', () => {
    // Highest hour ever metered ($27.65), highest ordinary day ($36.39), and
    // the longest continue run outside rolo (ward's five).
    expect(breakerDecide({ hourUsd: 27.65, dayUsd: 36.39, continueStreak: 5 }, caps).act).toBe('ok');
  });

  it('does not catch a small spin, and should not pretend to', () => {
    // Ward's five iterations against a one-ticket wake cost $5.70 in 13 minutes.
    // That is a question of what counts as production, not of spend.
    expect(breakerDecide({ hourUsd: 5.7, dayUsd: 18.86, continueStreak: 5 }, caps).act).toBe('ok');
  });

  it('a zero cap disables that limb', () => {
    expect(breakerDecide({ hourUsd: 999, dayUsd: 999, continueStreak: 999 }, { usdPerHour: 0, usdPerDay: 0, continueCap: 0 }).act).toBe('ok');
  });
});

describe('limitDecide (H-402)', () => {
  const NOW = Date.parse('2026-08-26T04:00:00Z');
  const base = { limitStreak: 1, limitCap: 20, limitWait: 900, blockHorizonSeconds: 7200, exhausted: null, nowMs: NOW };

  it('with no identifiable cap, behaves exactly as the old ladder did', () => {
    expect(limitDecide(base)).toEqual({ act: 'limit_wait', waitSeconds: 900, attempt: 1 });
    expect(limitDecide({ ...base, limitStreak: 21 }).act).toBe('blocked');
  });

  it('waits to the reset when the cap comes back soon', () => {
    const a = limitDecide({
      ...base,
      exhausted: { label: 'session (5h)', percent: 100, resets_at: '2026-08-26T04:30:00Z' },
    });
    expect(a).toEqual({ act: 'limit_wait', waitSeconds: 1860, attempt: 1 }); // 30 min + a minute
  });

  it('blocks with the cap named when the reset is beyond the horizon — the 2026-08-26 case', () => {
    const a = limitDecide({
      ...base,
      exhausted: { label: 'weekly (Fable)', percent: 100, resets_at: '2026-08-27T18:00:00Z' },
      message: 'You have reached your usage limit for this model.',
    });
    expect(a.act).toBe('blocked');
    if (a.act !== 'blocked') throw new Error('unreachable');
    expect(a.reason).toContain('weekly (Fable)');
    expect(a.reason).toContain('2026-08-27T18:00:00Z');
    expect(a.reason).toContain('The API said: You have reached your usage limit');
  });

  it('blocks rather than waiting forever when the cap names no reset time', () => {
    expect(limitDecide({ ...base, exhausted: { label: 'weekly (all models)', percent: 99, resets_at: null } }).act).toBe('blocked');
  });

  it('a reset already past retries shortly rather than computing a negative wait', () => {
    const a = limitDecide({ ...base, exhausted: { label: 'session (5h)', percent: 100, resets_at: '2026-08-26T03:00:00Z' } });
    expect(a).toEqual({ act: 'limit_wait', waitSeconds: 60, attempt: 1 });
  });
});

describe('probeDecide (H-412)', () => {
  const small = 'claude-haiku-4-5-20251001';
  const base = { probeModel: small, workstream: 'security', readyCount: 0, heldCount: 0 };

  it('nothing ready and nothing in hand is the probe case', () => {
    expect(probeDecide(base)).toBe(small);
  });
  it('ready work runs at the working tier', () => {
    expect(probeDecide({ ...base, readyCount: 1 })).toBeNull();
  });
  it('work already in hand runs at the working tier — resuming an in_progress ticket is not a probe', () => {
    expect(probeDecide({ ...base, heldCount: 1 })).toBeNull();
  });
  it('an unknown held_count (older helmo) never probes — misrouting real work is the worse mistake', () => {
    expect(probeDecide({ ...base, heldCount: undefined })).toBeNull();
  });
  it('no probe model configured means no probe', () => {
    expect(probeDecide({ ...base, probeModel: undefined })).toBeNull();
  });
  it("store-wide loops never probe: their motion-only wakes ARE the triage work", () => {
    expect(probeDecide({ ...base, workstream: '*' })).toBeNull();
  });
});
