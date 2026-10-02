export interface GlobalConfig {
  helmo_cli: string;        // path to helm's dist/cli.js
  helmo_mcp_server: string; // path to helm's dist/server.js (injected into agent sessions)
  helmo_db?: string;        // optional HELMO_DB override
  poll_seconds: number;    // idle wake-poll interval
  iteration_ceiling: number;
  fail_cap: number;        // consecutive runtime failures before BLOCKED
  limit_wait_seconds: number;   // park time on transient API/network conditions
  limit_cap: number;            // consecutive limit-waits before BLOCKED
  escalation_workstream: string; // where Rev files loop-blocked tickets
  respawn_backoff_seconds: number;     // supervisor: first-crash respawn wait, doubles per streak
  respawn_backoff_cap_seconds: number; // supervisor: backoff ceiling
  min_uptime_seconds: number;          // supervisor: exits younger than this count as unhealthy
  burn_usd_per_hour: number;   // breaker: metered spend per loop per rolling hour; 0 disables
  burn_usd_per_day: number;    // breaker: same over 24h; 0 disables
  continue_cap: number;        // breaker: consecutive iterations without idling; 0 disables
  usage_poll_seconds: number;  // Max-plan usage poll interval; 0 disables (H-278)
  limit_block_horizon_seconds: number;  // a cap resetting further out than this blocks for a human rather than waiting (H-402)
  limit_exhausted_percent: number;      // a usage bar at or above this counts as the cap that stopped us
  wedge_cap: number;                    // consecutive wake-check failures before a loop is declared wedged; 0 disables (H-448)
  seat_stale_seconds: number;           // a foreign in_progress hold older than this no longer stands the loop down (H-558); 0 disables the guard
  drain_grace_seconds: number;          // supervisor: seconds a drain waits before SIGKILLing stragglers; 0 waits forever (H-281)
  redeploy_deadline_seconds: number;    // seconds a redeploy's watch waits for the new supervisor before alarming; 0 disables the watch (H-1046)
  // Capacity and runaway detection (H-179/H-185). Every default reproduces
  // today's behaviour, so an estate that declares nothing is unaffected.
  shared_reserve_percent: number;       // plan allowance held back from loops so the operator's sessions outlast them
  stale_grace_iterations: number;       // iterations a loop may run on unreadable usage bars before waiting
  investigation_target_seconds: number; // a blocked loop unclaimed longer than this is itself a finding
  relapse_window_seconds: number;       // a second trip on the same reason inside this goes to a human, never auto-released
  anomaly_rate_multiple: number;        // x the loop's rolling mean of the last 5 iterations
  anomaly_min_usd: number;              // below this an iteration is too small for a multiple to mean anything
  anomaly_abs_percent: number;          // plan percentage points one iteration may consume
  exhaustion_ceiling_seconds: number;   // a reset further out than this is bad telemetry, not a plan
  probe?: RunChoice;                    // global probe pin ("provider:tier"): every probe pass runs here while its cap stands (H-625)
  intake_preparation_origin?: string;   // opt-in Good Plumb Worker origin; capability remains in Keychain
  intake_preparation_checkout?: string; // checkout receiving the verified signup source
}

export type Runtime = 'claude' | 'codex' | 'mock';

// How a provider's account is paid for (H-185). 'metered' is pay-per-token and
// keeps every dollar gate rev has; 'subscription' is a flat plan, where the
// token-log's dollars are notional and must never stop productive work — the
// plan bars are the only quantity that bounds it. Default everywhere is
// 'metered', so declaring nothing preserves today's behaviour exactly.
export type BillingMode = 'metered' | 'subscription';

// A provider is a place work can run: an adapter (runtime) plus the operator's
// tier→model table for it. Model names live in the roster, never in rev's code
// — the crew's model-selection skill is the human copy of the same table, and
// name churn must stay a roster edit, not a release.
export interface ProviderConfig {
  name: string;
  runtime: Runtime;
  billing: BillingMode;                  // how the account is paid for; 'metered' keeps every dollar gate (H-185)
  models: Record<string, string>;        // tier -> model name
  prices?: Record<string, ModelPrice>;   // model -> $/MTok, for notional metering when the CLI reports no cost
  config?: Record<string, unknown>;      // adapter config overrides applied to every run (codex: -c key=value)
}

export interface ModelPrice {
  input: number;         // $/MTok
  output: number;
  cached_input?: number; // default input/10 — the common cache discount
}

// One fully resolved way to run an iteration: the adapter, the provider it is
// billed against, and the models for the working and probe passes.
export interface RunChoice {
  provider: string;
  runtime: Runtime;
  billing?: BillingMode; // omitted by older/programmatic callers => metered
  model: string;
  probe_model?: string;
  prices?: Record<string, ModelPrice>;
  config?: Record<string, unknown>;
}

export interface LoopConfig {
  name: string;
  seat: string;               // accountable Helmo role; defaults to the loop name
  peer_sessions: string[];    // supervised workers allowed to share that seat
  project?: string;           // pool workers only: claim just this project's tickets
  tickets?: string[];         // pool workers only: claim just these exact tickets (H-671)
  exclude_tickets?: string[]; // derived, never a roster key: the tickets same-seat siblings' allowlists own
  workstream: string;
  cwd: string;
  runtime: Runtime;        // primary adapter (derived from 'provider' when that is set)
  model: string;           // primary working model (resolved from 'tier' when that is set)
  probe_model?: string;    // model for probe iterations — nothing ready, nothing held (H-412)
  constitution: string;    // path, relative to rev home or absolute
  version: string;         // loop version — part of the actor identity
  pace: number;            // velocity fraction (0,1]
  idle_floor_s: number;    // min seconds idle before a wake is honored; 0 = immediate (H-336/H-545)
  mcp_extra?: string;      // optional path to JSON with additional MCP servers
  skills?: string[];       // crew skill files appended to the constitution at spawn (H-247)
  mock_cmd?: string;       // mock runtime only: shell command to run per iteration
  burn_usd_per_hour?: number;  // breaker overrides for this loop (else the global)
  burn_usd_per_day?: number;
  continue_cap?: number;
  // Provider-general selection (H-479; crew skills/model-selection.md).
  choices: RunChoice[];    // the rotation cycle; length 1 when no rotation is set
  fallbacks: RunChoice[];  // tried in order when every scheduled choice's cap is out
  routing?: 'rotation' | 'headroom'; // headroom ranks same-tier choices by fresh allowance/reset data
}

// Session outcome classes, in the ladder's terms.
export type ExitClass = 'ok' | 'transient' | 'apparatus' | 'failure';

export interface SessionResult {
  rc: number;
  cls: ExitClass;
  limit?: { status: number; message: string };  // 429/529 detail, kept instead of discarded (H-402)
  tokens?: number;
  cost_usd?: number;
  outputTail: string; // last lines of session output, for traces and escalations
}

export const SENTINELS = ['STOP', 'HOLD', 'BLOCKED', 'LIMIT', 'IDLE', 'IDLE_AT', 'RUNNING', 'PACE', 'PARKED', 'SEAT_HELD', 'BACKOFF', 'WEDGED', 'REDEPLOY'] as const;
export type Sentinel = (typeof SENTINELS)[number];
