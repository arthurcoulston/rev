import { describe, it, expect } from 'vitest';
import { exhaustedLimit, parseCodexRateLimits, parseUsage, usageLine, worstSeverity } from '../src/usage.js';

// The real wire shape, captured from api/oauth/usage on 2026-08-27. The
// endpoint is undocumented, so this fixture is the contract: if a future
// response stops parsing, this test is what says so.
const LIVE = {
  five_hour: { utilization: 7, resets_at: '2026-08-27T23:40:00.090254+00:00' },
  seven_day: { utilization: 2, resets_at: '2026-09-03T18:00:00.090277+00:00' },
  seven_day_opus: null,
  nimbus_quill: { utilization: 0, resets_at: null },
  limits: [
    { kind: 'session', group: 'session', percent: 7, severity: 'normal', resets_at: '2026-08-27T23:39:59.714781+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 2, severity: 'normal', resets_at: '2026-09-03T17:59:59.714797+00:00', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: '2026-09-03T17:59:59.714979+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
};

describe('parseUsage (H-278)', () => {
  it('reads the limits array, and names the model a scoped cap belongs to', () => {
    const s = parseUsage(LIVE, '2026-08-27T20:00:00.000Z');
    expect(s.stale).toBe(false);
    expect(s.limits.map((l) => l.label)).toEqual(['session (5h)', 'weekly (all models)', 'weekly (Fable)']);
    expect(s.limits[2]!.kind).toBe('weekly_scoped');
    expect(s.limits[0]!.active).toBe(true);
  });

  it('keeps only parsed values — no raw upstream text reaches the file', () => {
    // usage.json is read into agent prompts, so every field must be one we
    // named ourselves (ward's third approval condition, H-298).
    const s = parseUsage(LIVE);
    for (const l of s.limits) {
      expect(Object.keys(l).sort()).toEqual(['active', 'kind', 'label', 'percent', 'resets_at', 'severity']);
    }
    expect(JSON.stringify(s)).not.toContain('nimbus_quill');
  });

  it('falls back to the top-level bars when limits is absent', () => {
    const s = parseUsage({ five_hour: { utilization: 42, resets_at: 'x' }, seven_day: { utilization: 61, resets_at: 'y' } });
    expect(s.limits.map((l) => [l.kind, l.percent])).toEqual([
      ['five_hour', 42],
      ['seven_day', 61],
    ]);
  });

  it('survives a shape it has never seen rather than throwing', () => {
    expect(parseUsage({}).limits).toEqual([]);
    expect(parseUsage(null).limits).toEqual([]);
    expect(parseUsage({ limits: [{}] }).limits).toEqual([]);
  });
});

describe('usageLine', () => {
  it('reads as one line, with the reset times', () => {
    expect(usageLine(parseUsage(LIVE))).toBe(
      'Max usage: session (5h) 7% (resets 08-27 23:39) · weekly (all models) 2% (resets 09-03 17:59) · weekly (Fable) 0% (resets 09-03 17:59)',
    );
  });

  it('says so when it never polled, and when the numbers are old', () => {
    expect(usageLine(null)).toBe('Max usage: not read yet');
    const stale = { ...parseUsage(LIVE), stale: true };
    expect(usageLine(stale)).toContain('STALE');
  });
});

describe('worstSeverity', () => {
  it('reports the endpoint\'s own worst word, never a threshold of ours', () => {
    expect(worstSeverity(parseUsage(LIVE))).toBe('normal');
    const hot = parseUsage(LIVE);
    hot.limits[1]!.severity = 'critical';
    expect(worstSeverity(hot)).toBe('critical');
    expect(worstSeverity(null)).toBe('unknown');
  });
});

describe('exhaustedLimit (H-402)', () => {
  it('finds nothing on an ordinary day', () => {
    expect(exhaustedLimit(parseUsage(LIVE))).toBeNull();
  });

  it('names the worst bar that is actually out', () => {
    const s = parseUsage(LIVE);
    s.limits[1]!.percent = 97;   // weekly (all models)
    s.limits[2]!.percent = 100;  // weekly (Fable)
    expect(exhaustedLimit(s)!.label).toBe('weekly (Fable)');
  });

  it("takes the endpoint's own 'critical' even below the percentage", () => {
    const s = parseUsage(LIVE);
    s.limits[0]!.severity = 'critical';
    expect(exhaustedLimit(s)!.label).toBe('session (5h)');
  });

  it('never lets stale numbers justify a wait', () => {
    const s = { ...parseUsage(LIVE), stale: true };
    s.limits[2]!.percent = 100;
    expect(exhaustedLimit(s)).toBeNull();
  });
});

describe('parseCodexRateLimits (H-479)', () => {
  // The real wire shape, captured from a codex-cli 0.150.1 rollout file's
  // token_count event on 2026-08-27. Like LIVE above, this fixture is the
  // contract with an undocumented format.
  const ROLLOUT_RL = {
    limit_id: 'codex',
    limit_name: null,
    primary: { used_percent: 12.5, window_minutes: 10080, resets_at: 1788497906 },
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: '0' },
    individual_limit: null,
    spend_control_reached: null,
    plan_type: 'prolite',
    rate_limit_reached_type: null,
  };

  it('maps windows to the snapshot shape, naming the plan', () => {
    const s = parseCodexRateLimits(ROLLOUT_RL, '2026-08-28T05:00:00.000Z');
    expect(s.stale).toBe(false);
    expect(s.limits).toHaveLength(1);
    expect(s.limits[0]).toMatchObject({
      kind: 'codex_primary',
      label: 'codex weekly [prolite]',
      percent: 12.5,
      severity: 'unknown',
      resets_at: '2026-09-04T04:58:26.000Z',
      active: false,
    });
  });

  it('keeps only parsed values — same posture as the Claude snapshot (H-298)', () => {
    const s = parseCodexRateLimits(ROLLOUT_RL);
    for (const l of s.limits) {
      expect(Object.keys(l).sort()).toEqual(['active', 'kind', 'label', 'percent', 'resets_at', 'severity']);
    }
    expect(JSON.stringify(s)).not.toContain('credits');
  });

  it('a reached cap is the endpoint speaking: fullest window goes critical, so exhaustedLimit sees it', () => {
    const s = parseCodexRateLimits({
      ...ROLLOUT_RL,
      primary: { used_percent: 41, window_minutes: 300, resets_at: 1788497906 },
      secondary: { used_percent: 87, window_minutes: 10080, resets_at: 1788497906 },
      rate_limit_reached_type: 'secondary',
    });
    expect(s.limits.map((l) => l.severity)).toEqual(['unknown', 'critical']);
    expect(s.limits.every((l) => l.active)).toBe(true);
    expect(exhaustedLimit(s)?.kind).toBe('codex_secondary');
  });

  it('survives a shape it has never seen rather than throwing', () => {
    expect(parseCodexRateLimits(null).limits).toEqual([]);
    expect(parseCodexRateLimits({}).limits).toEqual([]);
    expect(parseCodexRateLimits({ primary: {} }).limits).toEqual([]);
  });
});
