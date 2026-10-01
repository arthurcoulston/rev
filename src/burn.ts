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
import { BillingMode, ProviderConfig, RunChoice } from './types.js';

export interface BurnWindow {
  hourUsd: number;
  dayUsd: number;
}

const LINE = /^(\S+) loop=(\S+).*?cost_usd=(\S+)/;
const RUNTIME = /\bruntime=(\S+)/;

function floorPath(loop: string): string {
  return join(stateDir(loop), '.burn_floor');
}

/** Stamp the moment this loop process started. The breaker never counts spend
 *  from before it, so an operator who has seen the alarm and resumed gets a
 *  fresh window instead of tripping again on money already accounted for. */
export function meteredProviders(
  choices: RunChoice[],
  providers: Record<string, ProviderConfig>,
): Set<string> {
  return new Set(choices.filter((c) => (providers[c.provider]?.billing ?? 'metered') === 'metered').map((c) => c.provider));
}

export function markBurnFloor(loop: string, billingOrNow: BillingMode | number = 'metered', now = Date.now()): void {
  const billing = typeof billingOrNow === 'number' ? 'metered' : billingOrNow;
  if (typeof billingOrNow === 'number') now = billingOrNow;
  if (billing !== 'metered') return;
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

/** The last parseable per-iteration costs, newest last. Unknown costs never
 *  become zero: doing so would depress the baseline and make the next ordinary
 *  iteration look anomalous.
 *
 *  Pass `runtime` to count only the iterations that ran on the same one. Without
 *  it a provider switch is indistinguishable from a burn: per-token cost differs
 *  by two orders of magnitude between the runtimes a loop can be moved between
 *  (codex gpt-5.6-terra ~$0.48/Mtok against claude-sonnet-5 ~$47.7/Mtok), so
 *  tester's first claude iteration scored 17.9x against a mean built entirely
 *  from codex and halted a healthy loop (H-585). A runtime with no history yet
 *  has no dollar baseline, exactly as a brand-new loop does — the absolute
 *  plan-points rule is the guard in that window (H-388). */
export function recentCosts(loop: string, limit = 5, path = tokenLogPath(), runtime?: string): number[] {
  if (!existsSync(path) || limit <= 0) return [];
  const costs: number[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = LINE.exec(line);
    if (!m || m[2] !== loop) continue;
    if (runtime !== undefined && RUNTIME.exec(line)?.[1] !== runtime) continue;
    const cost = Number(m[3]);
    if (Number.isFinite(cost)) costs.push(cost);
  }
  return costs.slice(-limit);
}
