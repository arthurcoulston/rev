// Reading back what the fleet has spent. The token-log is append-only and
// written by the shim after every session (loop, runtime, model, tokens, cost),
// so it is already the record — this just windows it per loop for the breaker.
//
// Deliberately a file scan and not a running total held in memory: the log
// survives loop restarts, supervisor restarts and reboots, and a breaker whose
// memory resets when the process does is exactly the breaker that misses a
// burn (H-412).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, tokenLogPath } from './config.js';

export interface BurnWindow {
  hourUsd: number;
  dayUsd: number;
}

const LINE = /^(\S+) loop=(\S+).*?cost_usd=(\S+)/;

function floorPath(loop: string): string {
  return join(stateDir(loop), '.burn_floor');
}

/** Stamp the moment this loop process started. The breaker never counts spend
 *  from before it, so an operator who has seen the alarm and resumed gets a
 *  fresh window instead of tripping again on money already accounted for. */
export function markBurnFloor(loop: string, now = Date.now()): void {
  writeFileSync(floorPath(loop), String(now));
}

export function burnFloor(loop: string): number {
  const p = floorPath(loop);
  if (!existsSync(p)) return 0;
  return parseInt(readFileSync(p, 'utf8'), 10) || 0;
}

/** Metered spend for one loop over the trailing hour and day, never reaching
 *  back past the floor. Unparseable lines are skipped: the breaker must never
 *  be the thing that halts a loop because a log line was malformed. */
export function burnWindow(loop: string, now = Date.now(), path = tokenLogPath()): BurnWindow {
  if (!existsSync(path)) return { hourUsd: 0, dayUsd: 0 };
  const floor = burnFloor(loop);
  const hourAgo = Math.max(floor, now - 3_600_000);
  const dayAgo = Math.max(floor, now - 86_400_000);
  let hourUsd = 0;
  let dayUsd = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = LINE.exec(line);
    if (!m || m[2] !== loop) continue;
    const t = Date.parse(m[1]!);
    const cost = Number(m[3]);
    if (!Number.isFinite(t) || !Number.isFinite(cost)) continue;
    if (t >= dayAgo) dayUsd += cost;
    if (t >= hourAgo) hourUsd += cost;
  }
  return { hourUsd, dayUsd };
}
