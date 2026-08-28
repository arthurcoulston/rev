// Max plan usage — situational awareness of where the estate stands against
// its limits, before it hits one (H-278, design approved in H-280).
//
// THE ENDPOINT IS UNDOCUMENTED. `https://api.anthropic.com/api/oauth/usage`
// with the Claude Code OAuth token and `anthropic-beta: oauth-2025-04-20` is
// what Claude Code's own `/usage` reads. There is no published API for
// Pro/Max plan limits; the Console Admin and Enterprise Analytics APIs are
// org-only. If an official `claude usage` command or API ships
// (claude-code #44328, #45392), switch to it and delete this.
//
// It is rate limited and known to 429 persistently for Max users, so every
// failure here is soft: keep the last value, mark it stale, back off. Nothing
// in rev may ever block on this — a fleet that stops because it could not read
// a usage bar has inverted the priority.
//
// SECURITY POSTURE (the five conditions of ward's H-280 approval, verified in
// H-298). The token is read from the keychain per poll and discarded when the
// call returns — never held for the process lifetime, never copied to disk,
// no new credential minted. It travels only in the Authorization header of an
// HTTPS request to api.anthropic.com: never in argv (process args are world-
// readable via ps, which is why this uses fetch and not curl), never in a log,
// an error, or a crash dump. `usage.json` holds PARSED values only — agents
// read it into prompts, so no raw upstream text passes through.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { revHome } from './config.js';

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface UsageLimit {
  kind: string;        // 'session' | 'weekly_all' | 'weekly_scoped' | whatever ships next
  label: string;       // human phrasing, including the model scope when there is one
  percent: number;
  severity: string;    // the endpoint's own escalation word — not a threshold of ours
  resets_at: string | null;
  active: boolean;
}

export interface UsageSnapshot {
  fetched_at: string;
  stale: boolean;         // the read failed; these numbers are the last good ones
  error?: string;         // why, in one line, never carrying a response body
  limits: UsageLimit[];
}

export function usagePath(): string {
  return join(revHome(), 'usage.json');
}

/** The OAuth access token, read fresh and returned to the caller to use once.
 *  Never logged, never persisted, never passed as a command argument. */
function readToken(): string {
  const raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], // stderr dropped: it can echo the item
  });
  const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
  if (typeof token !== 'string' || !token) throw new Error('no accessToken in the keychain credential');
  return token;
}

/** Map the raw body to the parsed shape. Pure, so the wire format is tested
 *  without a network or a credential.
 *
 *  `limits` is the field worth reading: self-describing, and it names the model
 *  a scoped weekly cap belongs to — which is how the Fable cap becomes legible
 *  rather than an opaque codename. The older top-level `five_hour` /
 *  `seven_day` objects are a fallback for when `limits` is absent. */
export function parseUsage(body: unknown, now = new Date().toISOString()): UsageSnapshot {
  const d = (body ?? {}) as Record<string, unknown>;
  const limits: UsageLimit[] = [];

  if (Array.isArray(d['limits'])) {
    for (const raw of d['limits'] as Record<string, unknown>[]) {
      const scope = raw['scope'] as { model?: { display_name?: string } } | null;
      const model = scope?.model?.display_name;
      const kind = String(raw['kind'] ?? 'unknown');
      limits.push({
        kind,
        label: model ? `${labelFor(kind)} (${model})` : labelFor(kind),
        percent: Number(raw['percent'] ?? 0),
        severity: String(raw['severity'] ?? 'unknown'),
        resets_at: (raw['resets_at'] as string) ?? null,
        active: Boolean(raw['is_active']),
      });
    }
  } else {
    for (const [key, label] of [['five_hour', 'session'], ['seven_day', 'weekly (all models)']] as const) {
      const b = d[key] as Record<string, unknown> | null;
      if (b && typeof b === 'object' && b['utilization'] != null) {
        limits.push({
          kind: key,
          label,
          percent: Number(b['utilization']),
          severity: 'unknown',
          resets_at: (b['resets_at'] as string) ?? null,
          active: false,
        });
      }
    }
  }

  return { fetched_at: now, stale: false, limits };
}

export function readUsage(): UsageSnapshot | null {
  const p = usagePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as UsageSnapshot;
  } catch {
    return null;
  }
}

function labelFor(kind: string): string {
  if (kind === 'session') return 'session (5h)';
  if (kind === 'weekly_all') return 'weekly (all models)';
  if (kind === 'weekly_scoped') return 'weekly';
  return kind;
}

/** One poll. Returns the snapshot it wrote. Never throws: a failure keeps the
 *  last good numbers and marks them stale, because a usage bar is guidance and
 *  nothing in rev may stop for it. */
export async function pollUsage(): Promise<UsageSnapshot> {
  const previous = readUsage();
  try {
    const token = readToken();
    const res = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`endpoint returned ${res.status}`); // status only — never the body
    const snap = parseUsage(await res.json());
    writeFileSync(usagePath(), JSON.stringify(snap, null, 1) + '\n');
    return snap;
  } catch (e) {
    // One line, and only our own words plus a status code: an upstream body
    // could carry anything, and this file is read into agent prompts.
    const why = e instanceof Error ? e.message.slice(0, 120) : 'unknown error';
    const snap: UsageSnapshot = {
      fetched_at: previous?.fetched_at ?? new Date().toISOString(),
      stale: true,
      error: why,
      limits: previous?.limits ?? [],
    };
    writeFileSync(usagePath(), JSON.stringify(snap, null, 1) + '\n');
    return snap;
  }
}

/** One line for a dashboard or a status command. */
export function usageLine(s: UsageSnapshot | null, label = 'Max'): string {
  if (!s) return `${label} usage: not read yet`;
  if (!s.limits.length) return `${label} usage: unavailable${s.stale ? ' (stale)' : ''}`;
  const parts = s.limits.map((l) => `${l.label} ${l.percent}%${l.resets_at ? ` (resets ${l.resets_at.slice(5, 16).replace('T', ' ')})` : ''}`);
  return `${label} usage: ${parts.join(' · ')}${s.stale ? ' — STALE, last good read' : ''}`;
}

/** The worst thing the snapshot says, for anyone deciding whether to care.
 *  Severity is the endpoint's own word; we do not invent a threshold. */
export function worstSeverity(s: UsageSnapshot | null): string {
  if (!s?.limits.length) return 'unknown';
  const order = ['normal', 'warning', 'critical'];
  return s.limits.reduce((worst, l) => (order.indexOf(l.severity) > order.indexOf(worst) ? l.severity : worst), 'normal');
}

/** The bar that has actually run out, if one has. Returns the worst offender.
 *
 *  This is why the poller is worth having beyond a dashboard line: when a 429
 *  arrives, the error text is prose and may or may not name the limit, but the
 *  usage endpoint names it exactly — which cap, what percent, and when it
 *  resets. Reading the two together is how "API 429" becomes "the Fable weekly
 *  cap, back at 18:00 on Thursday". */
export function exhaustedLimit(s: UsageSnapshot | null, atPercent = 95): UsageLimit | null {
  if (!s || s.stale) return null; // stale numbers must never justify a long wait
  const hit = s.limits.filter((l) => l.percent >= atPercent || l.severity === 'critical');
  if (!hit.length) return null;
  return hit.reduce((worst, l) => (l.percent > worst.percent ? l : worst));
}

// ---------------------------------------------------------------------------
// Codex usage. No poller and no credential: every `codex exec` run writes its
// own rate-limit standing (used_percent, window, reset) into the session's
// rollout file under $CODEX_HOME/sessions, so the freshest numbers are read
// off disk after each run and parked in usage-codex.json in the same parsed
// shape the Claude snapshot uses. Verified against codex-cli 0.150.1 (H-479).

export function codexUsagePath(): string {
  return join(revHome(), 'usage-codex.json');
}

function codexHome(): string {
  return process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
}

interface CodexRateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number; // epoch seconds
}

interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
}

function codexWindowLabel(minutes: number | undefined): string {
  if (minutes === 300) return 'codex session (5h)';
  if (minutes === 10080) return 'codex weekly';
  return minutes ? `codex ${Math.round(minutes / 60)}h window` : 'codex window';
}

/** Map codex's rate_limits block to the snapshot shape. Pure, tested without
 *  a CLI. A non-null rate_limit_reached_type is the endpoint itself saying a
 *  cap bound, so the fullest window is marked critical — otherwise severity
 *  stays unknown and the percent does the talking. */
export function parseCodexRateLimits(raw: unknown, now = new Date().toISOString()): UsageSnapshot {
  const rl = (raw ?? {}) as CodexRateLimits;
  const limits: UsageLimit[] = [];
  for (const [kind, w] of [['codex_primary', rl.primary], ['codex_secondary', rl.secondary]] as const) {
    if (!w || typeof w !== 'object') continue;
    limits.push({
      kind,
      label: rl.plan_type ? `${codexWindowLabel(w.window_minutes)} [${rl.plan_type}]` : codexWindowLabel(w.window_minutes),
      percent: Number(w.used_percent ?? 0),
      severity: 'unknown',
      resets_at: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null,
      active: Boolean(rl.rate_limit_reached_type),
    });
  }
  if (rl.rate_limit_reached_type && limits.length) {
    const worst = limits.reduce((a, l) => (l.percent > a.percent ? l : a));
    worst.severity = 'critical';
  }
  return { fetched_at: now, stale: false, limits };
}

export function readCodexUsage(): UsageSnapshot | null {
  const p = codexUsagePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as UsageSnapshot;
  } catch {
    return null;
  }
}

/** Find the rollout file a codex exec run left behind. Rollouts are filed by
 *  local date, so a run that straddles midnight lands in yesterday's folder —
 *  both days are checked. */
function findRollout(threadId: string, now = new Date()): string | null {
  for (const daysBack of [0, 1]) {
    const d = new Date(now.getTime() - daysBack * 86_400_000);
    const dir = join(
      codexHome(), 'sessions',
      String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'),
    );
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((f) => f.endsWith(`-${threadId}.jsonl`));
    if (hit) return join(dir, hit);
  }
  return null;
}

/** After a codex run: lift the freshest rate_limits from its rollout into
 *  usage-codex.json. Soft on every failure — a usage bar is guidance, and
 *  nothing in rev may stop for it (the H-278 posture, unchanged). */
export function recordCodexUsage(threadId: string | undefined): UsageSnapshot | null {
  try {
    if (!threadId) return null;
    const rollout = findRollout(threadId);
    if (!rollout) return null;
    const lines = readFileSync(rollout, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(lines[i]!) as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload = e['payload'] as { type?: string; rate_limits?: unknown } | undefined;
      if (e['type'] === 'event_msg' && payload?.type === 'token_count' && payload.rate_limits) {
        const snap = parseCodexRateLimits(payload.rate_limits);
        writeFileSync(codexUsagePath(), JSON.stringify(snap, null, 1) + '\n');
        return snap;
      }
    }
    return null;
  } catch {
    return null;
  }
}
