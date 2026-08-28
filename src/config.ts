import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { parse } from 'smol-toml';
import { GlobalConfig, LoopConfig, ModelPrice, ProviderConfig, RunChoice, Runtime } from './types.js';

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
  providers: Record<string, ProviderConfig>;
}

// The two runtimes rev ships adapters for get their provider entry for free —
// declaring [providers.claude] in the roster is only needed to add a tier
// table or prices. Model names are deliberately NOT defaulted here: the
// tier→model map is operator-owned roster data (crew skills/model-selection.md
// is its human copy), so a loop may not say `tier = "mid"` until the roster
// says what mid means for that provider.
const BUILTIN_PROVIDERS: Record<string, Runtime> = { claude: 'claude', codex: 'codex' };

function parseProviders(raw: Record<string, unknown>): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};
  const rawProviders = (raw['providers'] ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, p] of Object.entries(rawProviders)) {
    const runtime = (p['runtime'] ?? BUILTIN_PROVIDERS[name]) as Runtime | undefined;
    if (!runtime) throw new Error(`Provider '${name}' in roster.toml needs 'runtime' (claude | codex | mock) — only 'claude' and 'codex' default it.`);
    providers[name] = {
      name,
      runtime,
      models: (p['models'] ?? {}) as Record<string, string>,
      prices: p['prices'] as Record<string, ModelPrice> | undefined,
      config: p['config'] as Record<string, unknown> | undefined,
    };
  }
  for (const [name, runtime] of Object.entries(BUILTIN_PROVIDERS)) {
    if (!providers[name]) providers[name] = { name, runtime, models: {} };
  }
  return providers;
}

/** Resolve a "provider" or "provider:tier" reference to a runnable choice.
 *  The tier after the colon must exist in that provider's models table;
 *  probe_tier resolves against the same table so a rotation's probe always
 *  runs on the provider actually being probed. */
function resolveRef(
  ref: string, providers: Record<string, ProviderConfig>, defaults: { tier?: string; probe_tier?: string }, where: string,
): RunChoice {
  const [name, tier = defaults.tier] = ref.split(':', 2);
  const p = providers[name!];
  if (!p) throw new Error(`${where}: unknown provider '${name}' — declare [providers.${name}] in roster.toml.`);
  if (!tier) throw new Error(`${where}: '${ref}' names no tier and the loop sets none — use '${name}:<tier>' or set the loop's 'tier'.`);
  const model = p.models[tier];
  if (!model) throw new Error(`${where}: provider '${name}' has no model for tier '${tier}' — add it to [providers.${name}.models].`);
  const probe = defaults.probe_tier ? p.models[defaults.probe_tier] : undefined;
  if (defaults.probe_tier && !probe) throw new Error(`${where}: provider '${name}' has no model for probe_tier '${defaults.probe_tier}'.`);
  return { provider: name!, runtime: p.runtime, model, probe_model: probe, prices: p.prices, config: p.config };
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
  const providers = parseProviders(raw);

  const loops: Record<string, LoopConfig> = {};
  const rawLoops = (raw['loops'] ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, l] of Object.entries(rawLoops)) {
    if (name === 'supervisor') throw new Error("'supervisor' is a reserved name (the fleet supervisor's own state dir).");
    const selection = resolveSelection(name, l, providers);
    const allMock = [...selection.choices, ...selection.fallbacks].every((c) => c.runtime === 'mock');
    for (const key of ['workstream', 'cwd', 'constitution']) {
      if (l[key] === undefined && !(allMock && key === 'constitution')) {
        throw new Error(`Loop '${name}' in roster.toml is missing '${key}'.`);
      }
    }
    loops[name] = {
      name,
      workstream: String(l['workstream']),
      cwd: expand(String(l['cwd'])),
      runtime: selection.primary.runtime,
      model: selection.primary.model,
      probe_model: selection.primary.probe_model,
      choices: selection.choices,
      fallbacks: selection.fallbacks,
      constitution: l['constitution'] ? resolveHome(String(l['constitution'])) : '',
      version: String(l['version'] ?? '0.1'),
      pace: Number(l['pace'] ?? 1),
      idle_floor_s: Number(l['idle_floor_s'] ?? 0),
      prompt: l['prompt'] ? String(l['prompt']) : undefined,
      mcp_extra: l['mcp_extra'] ? resolveHome(String(l['mcp_extra'])) : undefined,
      skills: Array.isArray(l['skills']) ? (l['skills'] as unknown[]).map((s) => resolveHome(String(s))) : undefined,
      mock_cmd: l['mock_cmd'] ? String(l['mock_cmd']) : undefined,
      burn_usd_per_hour: l['burn_usd_per_hour'] === undefined ? undefined : Number(l['burn_usd_per_hour']),
      burn_usd_per_day: l['burn_usd_per_day'] === undefined ? undefined : Number(l['burn_usd_per_day']),
      continue_cap: l['continue_cap'] === undefined ? undefined : Number(l['continue_cap']),
    };
  }
  return { global, loops, providers };
}

/** A loop names where it runs either the v0 way (runtime + model strings) or
 *  the tiered way (provider/tier against the roster's providers tables), plus
 *  an optional rotation cycle and quota fallbacks (H-479). Everything is
 *  resolved here, at load, so a bad reference fails the whole roster loudly
 *  instead of surfacing mid-iteration. */
function resolveSelection(
  name: string, l: Record<string, unknown>, providers: Record<string, ProviderConfig>,
): { primary: RunChoice; choices: RunChoice[]; fallbacks: RunChoice[] } {
  const where = `Loop '${name}'`;
  const tier = l['tier'] ? String(l['tier']) : undefined;
  const probe_tier = l['probe_tier'] ? String(l['probe_tier']) : undefined;
  const rotation = l['rotation'] as string[] | undefined;
  const fallback = l['fallback'] as string[] | undefined;
  const defaults = { tier, probe_tier };

  // Primary: explicit model strings win (v0 form); otherwise provider + tier.
  const providerName = l['provider'] ? String(l['provider']) : (typeof l['runtime'] === 'string' ? String(l['runtime']) : undefined);
  let primary: RunChoice;
  if (l['model'] !== undefined || l['runtime'] === 'mock') {
    if (!l['runtime'] && !l['provider']) throw new Error(`${where} in roster.toml is missing 'runtime'.`);
    const p = providerName ? providers[providerName] : undefined;
    const probeFromTier = probe_tier ? p?.models[probe_tier] : undefined;
    if (probe_tier && !l['probe_model'] && !probeFromTier) {
      throw new Error(`${where}: probe_tier '${probe_tier}' has no model in [providers.${providerName}.models].`);
    }
    primary = {
      provider: providerName ?? String(l['runtime']),
      runtime: (p?.runtime ?? l['runtime']) as Runtime,
      model: String(l['model'] ?? 'mock'),
      probe_model: l['probe_model'] ? String(l['probe_model']) : probeFromTier,
      prices: p?.prices,
      config: p?.config,
    };
  } else if (providerName && tier) {
    primary = resolveRef(providerName, providers, defaults, where);
    if (l['probe_model']) primary = { ...primary, probe_model: String(l['probe_model']) };
  } else {
    throw new Error(`${where} in roster.toml needs either 'model' (with 'runtime') or 'tier' (with 'provider' or a claude/codex 'runtime').`);
  }

  let choices = [primary];
  if (rotation) {
    if (!Array.isArray(rotation) || rotation.length === 0) throw new Error(`${where}: 'rotation' must be a non-empty array of "provider" or "provider:tier" refs.`);
    if (l['probe_model']) throw new Error(`${where}: with 'rotation', use 'probe_tier' — a single 'probe_model' cannot follow the provider being probed.`);
    choices = rotation.map((r) => resolveRef(String(r), providers, defaults, `${where} rotation`));
  }
  const fallbacks = (fallback ?? []).map((r) => resolveRef(String(r), providers, defaults, `${where} fallback`));
  return { primary: choices[0]!, choices, fallbacks };
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
