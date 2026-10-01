import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { burnWindow, markBurnFloor, meteredProviders, recentCosts } from '../src/burn.js';

const NOW = Date.parse('2026-08-25T16:00:00.000Z');
const at = (iso: string, loop: string, cost: string, runtime = 'claude') =>
  `${iso} loop=${loop} runtime=${runtime} model=claude-fable-5 tokens=1000 cost_usd=${cost}`;

let home: string;
let log: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rev-burn-'));
  process.env['REV_HOME'] = home;
  log = join(home, 'token-log');
});

describe('burnWindow', () => {
  it('sums only the named loop, and only inside each window', () => {
    writeFileSync(
      log,
      [
        at('2026-08-25T15:30:00.000Z', 'ward', '1.00'), // in hour, in day
        at('2026-08-25T15:45:00.000Z', 'ward', '2.50'), // in hour, in day
        at('2026-08-25T09:00:00.000Z', 'ward', '4.00'), // day only
        at('2026-08-24T09:00:00.000Z', 'ward', '99.00'), // outside both
        at('2026-08-25T15:50:00.000Z', 'bosun', '50.00'), // another loop
      ].join('\n') + '\n',
    );
    expect(burnWindow('ward', NOW, log)).toEqual({ hourUsd: 3.5, dayUsd: 7.5 });
    expect(burnWindow('bosun', NOW, log)).toEqual({ hourUsd: 50, dayUsd: 50 });
  });

  it('never reaches back past the floor — a resumed loop starts clean', () => {
    writeFileSync(
      log,
      [at('2026-08-25T09:00:00.000Z', 'ward', '60.00'), at('2026-08-25T15:59:00.000Z', 'ward', '1.00')].join('\n') + '\n',
    );
    expect(burnWindow('ward', NOW, log).dayUsd).toBe(61);
    markBurnFloor('ward', Date.parse('2026-08-25T15:00:00.000Z'));
    expect(burnWindow('ward', NOW, log).dayUsd).toBe(1);
  });

  it('does not stamp a burn floor for a subscription provider', () => {
    writeFileSync(log, at('2026-08-25T15:59:00.000Z', 'ward', '1.00') + '\n');
    markBurnFloor('ward', 'subscription', NOW);
    expect(burnWindow('ward', NOW, log).dayUsd).toBe(1);
  });

  it('selects only metered providers from runnable choices', () => {
    const choices = [
      { provider: 'claude', runtime: 'claude' as const, model: 'large' },
      { provider: 'codex', runtime: 'codex' as const, model: 'large' },
    ];
    const providers = {
      claude: { name: 'claude', runtime: 'claude' as const, billing: 'subscription' as const, models: {} },
      codex: { name: 'codex', runtime: 'codex' as const, billing: 'metered' as const, models: {} },
    };
    expect([...meteredProviders(choices, providers)]).toEqual(['codex']);
  });

  it('skips malformed lines rather than halting a loop over a bad log line', () => {
    writeFileSync(log, ['garbage', at('2026-08-25T15:30:00.000Z', 'ward', 'NaN'), at('2026-08-25T15:31:00.000Z', 'ward', '2.00'), ''].join('\n'));
    expect(burnWindow('ward', NOW, log)).toEqual({ hourUsd: 2, dayUsd: 2 });
  });

  it('keeps the last five parseable costs without turning unknowns into zero', () => {
    writeFileSync(log, [
      at('2026-08-25T10:00:00.000Z', 'ward', '1'),
      at('2026-08-25T11:00:00.000Z', 'ward', '?'),
      ...[2, 3, 4, 5, 6].map((cost, i) => at(`2026-08-25T1${i + 1}:30:00.000Z`, 'ward', String(cost))),
      at('2026-08-25T15:59:00.000Z', 'bosun', '99'),
    ].join('\n') + '\n');
    expect(recentCosts('ward', 5, log)).toEqual([2, 3, 4, 5, 6]);
  });

  it('counts only the runtime under judgment, so a provider switch is not a burn (H-585)', () => {
    writeFileSync(log, [
      ...[0.01, 0.15, 0.30, 0.01, 0.06].map((cost, i) =>
        at(`2026-08-25T1${i}:00:00.000Z`, 'ward', String(cost), 'codex')),
      at('2026-08-25T15:00:00.000Z', 'ward', '1.80', 'claude'),
    ].join('\n') + '\n');
    // Unscoped, the claude iteration is judged against a codex-only mean.
    expect(recentCosts('ward', 5, log)).toEqual([0.15, 0.3, 0.01, 0.06, 1.8]);
    // Scoped, each runtime sees only its own history — and a runtime with none
    // yet gets an empty baseline rather than a borrowed one.
    expect(recentCosts('ward', 5, log, 'codex')).toEqual([0.01, 0.15, 0.3, 0.01, 0.06]);
    expect(recentCosts('ward', 5, log, 'claude')).toEqual([1.8]);
    expect(recentCosts('ward', 5, log, 'gemini')).toEqual([]);
  });

  it('is zero when there is no log at all', () => {
    expect(burnWindow('ward', NOW, join(home, 'absent'))).toEqual({ hourUsd: 0, dayUsd: 0 });
  });
});
