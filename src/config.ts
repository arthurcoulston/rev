import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { parse } from 'smol-toml';
import { GlobalConfig, LoopConfig } from './types.js';

// All instance data lives under the Rev home (never in the repo):
//   roster.toml, constitutions/, state/<loop>/, token-log
export function revHome(): string {
  return process.env['REV_HOME'] ?? join(homedir(), '.rev');
}

const GLOBAL_DEFAULTS = {
  poll_seconds: 60,
  iteration_ceiling: 2000,
  fail_cap: 2,
  limit_wait_seconds: 900,
  limit_cap: 20,
  escalation_workstream: 'rev',
  respawn_backoff_seconds: 30,
  respawn_backoff_cap_seconds: 900,
  min_uptime_seconds: 60,
  // Burn breaker (H-412). Set above every figure in the token-log's history so
  // a trip means new territory: no loop hour has exceeded $28, no ordinary day
  // $36, and only rolo has ever run more than five iterations without idling.
  burn_usd_per_hour: 30,
  burn_usd_per_day: 75,
  continue_cap: 15,
  // Max usage poll (H-278). Ten minutes: the endpoint is undocumented and rate
  // limited, and the bars move slowly enough that anything faster buys nothing.
  usage_poll_seconds: 600,
  // A quota that resets inside two hours is worth waiting out; one that resets
  // in two days is a decision, and 2026-08-26 is what waiting through it looks
  // like — three loops down 34-42h while the ladder burned its 20 attempts.
  limit_block_horizon_seconds: 7200,
  limit_exhausted_percent: 95,
  // Five consecutive failures is five minutes at the default poll — long past
  // contention, and short enough that nobody loses an afternoon (H-448).
  wedge_cap: 5,
};

export interface Roster {
  global: GlobalConfig;
  loops: Record<string, LoopConfig>;
}

export function loadRoster(): Roster {
  const path = join(revHome(), 'roster.toml');
  if (!existsSync(path)) {
    throw new Error(
      `No roster at ${path}. Create it from the repo's examples/roster.toml — loops are instance data and live in ${revHome()}, never in the repo.`,
    );
  }
  const raw = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const g = (raw['global'] ?? {}) as Record<string, unknown>;
  for (const key of ['helmo_cli', 'helmo_mcp_server']) {
    if (!g[key]) throw new Error(`roster.toml [global] is missing '${key}' — the path to Helm's ${key === 'helmo_cli' ? 'dist/cli.js' : 'dist/server.js'}.`);
  }
  const global = { ...GLOBAL_DEFAULTS, ...g } as unknown as GlobalConfig;

  const loops: Record<string, LoopConfig> = {};
  const rawLoops = (raw['loops'] ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, l] of Object.entries(rawLoops)) {
    if (name === 'supervisor') throw new Error("'supervisor' is a reserved name (the fleet supervisor's own state dir).");
    for (const key of ['workstream', 'cwd', 'runtime', 'model', 'constitution']) {
      if (l[key] === undefined && !(l['runtime'] === 'mock' && (key === 'model' || key === 'constitution'))) {
        throw new Error(`Loop '${name}' in roster.toml is missing '${key}'.`);
      }
    }
    loops[name] = {
      name,
      workstream: String(l['workstream']),
      cwd: expand(String(l['cwd'])),
      runtime: l['runtime'] as LoopConfig['runtime'],
      model: String(l['model'] ?? 'mock'),
      probe_model: l['probe_model'] ? String(l['probe_model']) : undefined,
      constitution: l['constitution'] ? resolveHome(String(l['constitution'])) : '',
      version: String(l['version'] ?? '0.1'),
      pace: Number(l['pace'] ?? 1),
      prompt: l['prompt'] ? String(l['prompt']) : undefined,
      mcp_extra: l['mcp_extra'] ? resolveHome(String(l['mcp_extra'])) : undefined,
      skills: Array.isArray(l['skills']) ? (l['skills'] as unknown[]).map((s) => resolveHome(String(s))) : undefined,
      mock_cmd: l['mock_cmd'] ? String(l['mock_cmd']) : undefined,
      burn_usd_per_hour: l['burn_usd_per_hour'] === undefined ? undefined : Number(l['burn_usd_per_hour']),
      burn_usd_per_day: l['burn_usd_per_day'] === undefined ? undefined : Number(l['burn_usd_per_day']),
      continue_cap: l['continue_cap'] === undefined ? undefined : Number(l['continue_cap']),
    };
  }
  return { global, loops };
}

export function stateDir(loop: string): string {
  const d = join(revHome(), 'state', loop);
  mkdirSync(d, { recursive: true });
  return d;
}

export function tokenLogPath(): string {
  return join(revHome(), 'token-log');
}

function expand(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

function resolveHome(p: string): string {
  const e = expand(p);
  return isAbsolute(e) ? e : join(revHome(), e);
}
