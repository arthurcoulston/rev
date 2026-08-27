import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { burnWindow, markBurnFloor } from '../src/burn.js';

const NOW = Date.parse('2026-08-25T16:00:00.000Z');
const at = (iso: string, loop: string, cost: string) =>
  `${iso} loop=${loop} runtime=claude model=claude-fable-5 tokens=1000 cost_usd=${cost}`;

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

  it('skips malformed lines rather than halting a loop over a bad log line', () => {
    writeFileSync(log, ['garbage', at('2026-08-25T15:30:00.000Z', 'ward', 'NaN'), at('2026-08-25T15:31:00.000Z', 'ward', '2.00'), ''].join('\n'));
    expect(burnWindow('ward', NOW, log)).toEqual({ hourUsd: 2, dayUsd: 2 });
  });

  it('is zero when there is no log at all', () => {
    expect(burnWindow('ward', NOW, join(home, 'absent'))).toEqual({ hourUsd: 0, dayUsd: 0 });
  });
});
