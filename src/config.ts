import { readFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, dirname, basename, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import { BillingMode, GlobalConfig, LoopConfig, ModelPrice, ProviderConfig, RunChoice, Runtime } from './types.js';

// All instance data lives under the Rev home (never in the repo):
//   roster.toml, constitutions/, state/<loop>/, token-log
export function revHome(): string {
  return process.env['REV_HOME'] ?? join(homedir(), '.rev');
}

// How long a graceful drain may take before stragglers are SIGKILLed. systemd
// can outwait it; launchd clamps ExitTimeOut at 60 seconds, so its bootout is a
// hard path and detached sessions are the safety boundary (H-877).
export const DEFAULT_DRAIN_GRACE_SECONDS = 600;

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
  // Same-seat guard (H-558): a fresh in_progress hold in the loop's name that
  // its own iterations did not claim means another live instance is working
  // the seat — stand down rather than work over it. 24h matches Helmo's own
  // stale-claim convention: past it the hold is takeover territory, not a
  // live session, and blocking on it would let one abandoned claim idle a
  // loop forever.
  seat_stale_seconds: 86400,
  // Drain escalation (H-281): a drain that waits forever on a wedged child
  // ends with an operator kill -9 and an orphan. Past the grace, SIGKILL.
  // Generous because in-flight iterations legitimately run minutes.
  drain_grace_seconds: DEFAULT_DRAIN_GRACE_SECONDS,
  // Redeploy watch (H-1046). Five minutes covers launchd's respawn throttle
  // and a slow start many times over, so a deadline reached means the fleet is
  // genuinely down rather than slow.
  redeploy_deadline_seconds: 300,
  // Capacity and runaway detection (H-179/H-185, after the 7h08m stop of
  // 2026-09-29 on a full backlog and two thirds-full accounts). Every one of
  // these reproduces today's behaviour until a roster declares a provider
  // `billing = "subscription"`, which is what makes the change safe to ship to
  // estates that have not asked for it.
  //
  // 5 points of the plan window held back from loops: the bars are shared with
  // the operator's own desk sessions, and the fleet should hit the wall first.
  shared_reserve_percent: 5,
  // Six iterations on unreadable bars before parking. Measured against this
  // fleet's own cadence that is 7 minutes for the fastest loop and 54 for the
  // slowest — bounded either way, and the alternative to a bounded grace is
  // another silent night on a telemetry fault.
  stale_grace_iterations: 6,
  // 30 minutes is the shortest response a peer loop's wake cadence can
  // actually meet, and the incident it answers cost 7h08m.
  investigation_target_seconds: 1800,
  // A second trip on the same reason inside the hour is a real anomaly, not a
  // false alarm, and goes to a human. This is the anti-blind-restart rule.
  relapse_window_seconds: 3600,
  // Calibrated against 597 rolling windows of this fleet's token-log: a cost
  // multiple of 4 would have tripped 23 times, 5 seven times, 6 twice. See
  // capacity.ts for why the axis is cost rather than tokens, and why the
  // multiple carries an absolute floor beneath it.
  anomaly_rate_multiple: 6,
  anomaly_min_usd: 1.0,
  // No productive iteration has ever taken 10 percentage points of a plan
  // window: a whole week of one loop's work reached 65 points across roughly
  // 130 iterations, so 10 is about twenty times the observed per-iteration
  // draw. This one is a ceiling, not a percentile.
  anomaly_abs_percent: 10,
  // Eight days — longer than any weekly window, so a reset further out than
  // this means the telemetry is wrong rather than the plan.
  exhaustion_ceiling_seconds: 691200,
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
    // Billing is a declaration of fact about the account, not a policy knob
    // (H-185). It defaults to 'metered' so an estate that says nothing keeps
    // every dollar gate it has; a flat-plan account says so and the notional
    // dollars stop gating its work.
    const billing = (p['billing'] ?? 'metered') as BillingMode;
    if (billing !== 'metered' && billing !== 'subscription') {
      throw new Error(`Provider '${name}': billing must be 'metered' or 'subscription' — it says what the account IS, not what rev should do about it.`);
    }
    providers[name] = {
      name,
      runtime,
      billing,
      models: (p['models'] ?? {}) as Record<string, string>,
      prices: p['prices'] as Record<string, ModelPrice> | undefined,
      config: p['config'] as Record<string, unknown> | undefined,
    };
  }
  for (const [name, runtime] of Object.entries(BUILTIN_PROVIDERS)) {
    if (!providers[name]) providers[name] = { name, runtime, billing: 'metered', models: {} };
  }
  return providers;
}

/** Resolve a "provider" or "provider:tier" reference to a runnable choice.
 *  The tier after the colon must exist in that provider's models table;
 *  probe_tier resolves against the same table so a rotation's probe always
 *  runs on the provider actually being probed. */
export function resolveRef(
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
  return { provider: name!, runtime: p.runtime, billing: p.billing, model, probe_model: probe, prices: p.prices, config: p.config };
}

/** The complete set of keys a [loops.<name>] table may carry. */
const LOOP_KEYS = new Set([
  'seat', 'project', 'tickets',
  'workstream', 'cwd', 'constitution', 'version', 'pace', 'idle_floor_s',
  'runtime', 'model', 'provider', 'tier', 'probe_tier', 'probe_model', 'rotation', 'fallback', 'routing',
  'mcp_extra', 'skills', 'mock_cmd', 'burn_usd_per_hour', 'burn_usd_per_day', 'continue_cap',
]);

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
  // Global probe pin (H-625): '[global] probe = "codex:small"' routes every
  // probe pass there while its cap stands. The ref must name its tier —
  // there is no loop context here to default from.
  global.probe = g['probe'] ? resolveRef(String(g['probe']), providers, {}, '[global] probe') : undefined;

  const loops: Record<string, LoopConfig> = {};
  const rawLoops = (raw['loops'] ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, l] of Object.entries(rawLoops)) {
    if (name === 'supervisor') throw new Error("'supervisor' is a reserved name (the fleet supervisor's own state dir).");
    // Every loop key is named in LOOP_KEYS; anything else fails the roster at
    // load. The guard exists for prose: a `prompt` tail used to append free
    // text from this file — uncapped, unreviewed, outside git — to every
    // iteration (retired H-1186). A seat's words live in its constitution
    // and roster skills, which the context check measures.
    for (const key of Object.keys(l)) {
      if (!LOOP_KEYS.has(key)) {
        throw new Error(`Loop '${name}': unknown key '${key}'. Prose for a seat belongs in its constitution or a roster skill, never in roster.toml.`);
      }
    }
    if (l['routing'] !== undefined && !['rotation', 'headroom'].includes(String(l['routing']))) {
      throw new Error(`Loop '${name}': routing must be 'rotation' or 'headroom'.`);
    }
    if (l['routing'] === 'headroom') {
      const refs = l['rotation'];
      if (!l['tier'] || !Array.isArray(refs) || refs.length < 2 ||
          refs.some((ref) => String(ref).includes(':') && String(ref).split(':')[1] !== l['tier'])) {
        throw new Error(`Loop '${name}': headroom routing needs a tier and at least two rotation choices on that same tier.`);
      }
    }
    const selection = resolveSelection(name, l, providers);
    const allMock = [...selection.choices, ...selection.fallbacks].every((c) => c.runtime === 'mock');
    for (const key of ['workstream', 'cwd', 'constitution']) {
      if (l[key] === undefined && !(allMock && key === 'constitution')) {
        throw new Error(`Loop '${name}' in roster.toml is missing '${key}'.`);
      }
    }
    loops[name] = {
      name,
      seat: String(l['seat'] ?? name),
      peer_sessions: [],
      project: l['project'] === undefined ? undefined : String(l['project']),
      tickets: l['tickets'] === undefined ? undefined : parseTickets(name, l['tickets']),
      workstream: String(l['workstream']),
      cwd: expand(String(l['cwd'])),
      runtime: selection.primary.runtime,
      model: selection.primary.model,
      probe_model: selection.primary.probe_model,
      choices: selection.choices,
      fallbacks: selection.fallbacks,
      routing: (l['routing'] ?? 'rotation') as LoopConfig['routing'],
      constitution: l['constitution'] ? resolveHome(String(l['constitution'])) : '',
      version: String(l['version'] ?? '0.1'),
      pace: Number(l['pace'] ?? 1),
      idle_floor_s: Number(l['idle_floor_s'] ?? 0),
      mcp_extra: l['mcp_extra'] ? resolveHome(String(l['mcp_extra'])) : undefined,
      skills: Array.isArray(l['skills']) ? (l['skills'] as unknown[]).map((s) => resolveHome(String(s))) : undefined,
      mock_cmd: l['mock_cmd'] ? String(l['mock_cmd']) : undefined,
      burn_usd_per_hour: l['burn_usd_per_hour'] === undefined ? undefined : Number(l['burn_usd_per_hour']),
      burn_usd_per_day: l['burn_usd_per_day'] === undefined ? undefined : Number(l['burn_usd_per_day']),
      continue_cap: l['continue_cap'] === undefined ? undefined : Number(l['continue_cap']),
    };
  }
  for (const loop of Object.values(loops)) {
    loop.peer_sessions = Object.values(loops)
      .filter((peer) => peer.seat === loop.seat)
      .map((peer) => `rev:${peer.name}`);
  }
  // A pool worker launches only on Helmo's atomic claim, which is scoped to
  // one exact workstream, and edits only its own checkout: two workers in one
  // writable cwd would overwrite each other however cleanly their tickets
  // were split. Refused at load, so a misconfigured pool never starts. The
  // comparison is of what the paths ARE, not how they are spelled (H-671): a
  // symlink alias, one checkout nested in another, or two directories inside
  // one git worktree (one index) are the same writable destination.
  for (const loop of Object.values(loops)) {
    if (loop.peer_sessions.length < 2) {
      if (loop.project !== undefined) throw new Error(`Loop '${loop.name}': 'project' scopes a pool worker's claims; it needs another loop sharing seat '${loop.seat}'.`);
      if (loop.tickets !== undefined) throw new Error(`Loop '${loop.name}': 'tickets' scopes a pool worker's claims; it needs another loop sharing seat '${loop.seat}'.`);
      continue;
    }
    if (loop.workstream === '*') throw new Error(`Loop '${loop.name}': a pool worker for seat '${loop.seat}' needs one exact workstream, not '*'.`);
  }
  const pool = Object.values(loops).filter((l) => l.peer_sessions.length > 1);
  const dest = new Map(pool.map((l) => [l.name, writableDestination(l.cwd)]));
  for (const [i, loop] of pool.entries()) {
    for (const peer of pool.slice(i + 1)) {
      if (peer.seat !== loop.seat) continue;
      const a = dest.get(loop.name)!, b = dest.get(peer.name)!;
      const why = a.real === b.real ? `cwd ${loop.cwd}${loop.cwd === peer.cwd ? '' : ` (${peer.cwd} is the same directory, ${a.real})`}`
        : within(a.real, b.real) || within(b.real, a.real) ? `nested checkouts ${a.real} and ${b.real}`
        : a.gitDir && a.gitDir === b.gitDir ? `one git worktree and index (${a.gitDir}) at ${a.real} and ${b.real}`
        : null;
      if (why) throw new Error(`Loops '${loop.name}' and '${peer.name}' share seat '${loop.seat}' and ${why}; each worker needs its own writable checkout.`);
      const overlap = loop.tickets?.filter((t) => peer.tickets?.includes(t)) ?? [];
      if (overlap.length) throw new Error(`Loops '${loop.name}' and '${peer.name}' both list ${overlap.join(', ')}; a ticket belongs to one worker's allowlist.`);
    }
  }
  // A worker with no allowlist would otherwise take a lane's ticket the moment
  // it became ready, so it is told which tickets its siblings own.
  for (const loop of pool) {
    if (loop.tickets) continue;
    const owned = pool.filter((p) => p.seat === loop.seat && p.tickets).flatMap((p) => p.tickets!);
    if (owned.length) loop.exclude_tickets = owned;
  }
  return { global, loops, providers };
}

function parseTickets(loop: string, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((t) => typeof t !== 'string' || !/^\S+$/.test(t)) || new Set(raw).size !== raw.length) {
    throw new Error(`Loop '${loop}': 'tickets' must be a non-empty array of distinct exact ticket ids.`);
  }
  return raw as string[];
}

function within(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Where a cwd actually writes: its real path (resolving symlinks through the
 *  deepest part that exists yet, so a checkout not created yet still compares)
 *  and the git directory owning it, whose index two workers must not share. */
export function writableDestination(cwd: string): { real: string; gitDir: string | null } {
  let head = resolve(cwd), tail = '';
  while (!existsSync(head) && dirname(head) !== head) { tail = tail ? join(basename(head), tail) : basename(head); head = dirname(head); }
  const real = tail ? join(realpathSync(head), tail) : realpathSync(head);
  for (let dir = realpathSync(head); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return { real, gitDir: realpathSync(dotGit) };
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      const gitDir = m ? resolve(dir, m[1]!.trim()) : dotGit;
      return { real, gitDir: existsSync(gitDir) ? realpathSync(gitDir) : gitDir };
    }
    if (dirname(dir) === dir) return { real, gitDir: null };
  }
}

/** The loops a control command's name reaches (H-676). With pool workers a
 *  role is no longer one loop, and its first worker usually keeps the role's
 *  name, so `stop builder` reading only loop `builder` would leave every other
 *  builder running. A seat name therefore addresses the whole role whenever
 *  more than one loop sits in it, or no loop carries that name; `worker`
 *  narrows it back to the one loop of exactly that name. Empty means unknown. */
export function controlTargets(loops: Record<string, LoopConfig>, name: string, worker = false): string[] {
  const role = Object.values(loops).filter((l) => l.seat === name).map((l) => l.name);
  if (!worker && role.length > 0 && (role.length > 1 || !loops[name])) return role;
  return loops[name] ? [name] : [];
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
      billing: p?.billing ?? 'metered',
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
