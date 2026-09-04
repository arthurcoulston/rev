import { describe, it, expect } from 'vitest';
import { choiceDecide } from '../src/ladder.js';
import { selectRun, choiceExhausted } from '../src/routing.js';
import { headroomRate, UsageSnapshot, usageForModel, parseUsage, parseCodexRateLimits } from '../src/usage.js';
import { LoopConfig, RunChoice } from '../src/types.js';

const NOW = Date.parse('2026-09-04T19:00:00Z');
const claude: RunChoice = { provider: 'claude', runtime: 'claude', model: 'claude-fable-5-1' };
const codex: RunChoice = { provider: 'codex', runtime: 'codex', model: 'gpt-6-astra' };
function snap(percent: number, hours: number): UsageSnapshot {
  return {
    fetched_at: new Date(NOW).toISOString(), stale: false,
    limits: [{ kind: 'weekly_all', label: 'weekly', percent, severity: 'normal', active: false, resets_at: new Date(NOW + hours * 3_600_000).toISOString() }],
  };
}
const loop = { routing: 'headroom', choices: [codex, claude], fallbacks: [] } as unknown as LoopConfig;

describe('allowance-aware routing (H-892)', () => {
  it('uses the provider with allowance expiring sooner, not merely the lower percentage', () => {
    const usage = { claude: snap(20, 144), codex: snap(40, 48) };
    expect(selectRun(loop, usage, 2, 95, NOW).choice).toBe(codex);
    expect(selectRun(loop, { claude: snap(10, 24), codex: snap(70, 48) }, 1, 95, NOW).choice).toBe(claude);
  });

  it('reverses course after meeting usage changes the shared balance', () => {
    const usage = { claude: snap(27, 143), codex: snap(15, 57) };
    expect(selectRun(loop, usage, 1, 95, NOW).choice).toBe(codex);
    usage.codex = snap(85, 57);
    expect(selectRun(loop, usage, 2, 95, NOW).choice).toBe(claude);
  });

  it('preserves tier and cannot select a cheap fallback just to burn its allowance', () => {
    const fallback = { provider: 'other', runtime: 'codex', model: 'small' } as RunChoice;
    const selected = choiceDecide({ choices: [claude, codex], fallbacks: [fallback], iteration: 1, exhausted: () => false, headroom: (c) => c === fallback ? 100 : 1 });
    expect(selected.choice).toBe(claude);
    expect(choiceDecide({ choices: [claude, codex], fallbacks: [fallback], iteration: 1, exhausted: (c) => c !== fallback, headroom: () => 1 }).choice).toBe(fallback);
  });

  it('stale, missing, malformed or expired telemetry keeps configured order without inventing headroom', () => {
    for (const bad of [null, { ...snap(0, 24), stale: true }, { ...snap(0, 24), fetched_at: new Date(NOW - 31 * 60_000).toISOString() }, { ...snap(0, 24), fetched_at: 'bad' }, snap(0, -1)]) {
      expect(selectRun(loop, { claude: bad, codex: snap(80, 144) }, 2, 95, NOW).choice).toBe(codex);
      expect(headroomRate(bad, claude.model, 95, NOW)).toBeNull();
    }
    expect(parseUsage({ limits: [{ kind: 'weekly_all', percent: null }] }).limits).toEqual([]);
    expect(parseCodexRateLimits({ primary: { used_percent: null } }).limits).toEqual([]);
  });

  it('skips exhausted candidates, including a binding short window', () => {
    const usage = { claude: snap(20, 144), codex: snap(10, 24) };
    usage.codex.limits.push({ ...snap(96, 1).limits[0]!, kind: 'session', label: 'session' });
    expect(selectRun(loop, usage, 1, 95, NOW).choice).toBe(claude);
    usage.codex.limits[1]!.percent = 94.9;
    expect(headroomRate(usage.codex, codex.model, 95, NOW)).toBeCloseTo(0.1);
    expect(selectRun(loop, usage, 1, 95, NOW).choice).toBe(claude);
  });

  it('the Fable weekly bucket cannot exhaust Opus or the probe model', () => {
    const usage = { claude: snap(20, 144), codex: snap(10, 24) };
    usage.claude.limits.push({ ...snap(99, 144).limits[0]!, kind: 'weekly_scoped', label: 'weekly (Fable)' });
    expect(choiceExhausted(claude, usage, 95, NOW)).toBe(true);
    expect(choiceExhausted({ ...claude, model: 'claude-opus-5' }, usage, 95, NOW)).toBe(false);
    expect(choiceExhausted({ ...claude, model: 'claude-haiku-4-5-20251001' }, usage, 95, NOW)).toBe(false);
    expect(usageForModel(snap(99, -1), claude.model, NOW)).toBeNull();
  });

  it('does not change the established alternating policy for unopted loops', () => {
    const rotation = { ...loop, routing: 'rotation' as const };
    const usage = { claude: snap(10, 144), codex: snap(10, 24) };
    expect(selectRun(rotation, usage, 1, 95, NOW).choice).toBe(codex);
    expect(selectRun(rotation, usage, 2, 95, NOW).choice).toBe(claude);
  });
});
