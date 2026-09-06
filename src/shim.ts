// Runtime shim — the single point where Rev binds to concrete agent CLIs.
// Contract: run one non-interactive session in the loop's cwd; return the exit
// code classified per the ladder (0 clean / 75 transient / 78 apparatus),
// token accounting when the runtime reports it, and the output tail.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenLogPath } from './config.js';
import { recordCodexUsage } from './usage.js';
import { loopActor } from './helm.js';
import { GlobalConfig, LoopConfig, ModelPrice, RunChoice, SessionResult } from './types.js';

// Loop sessions get a clean environment: ambient agent-session variables
// (a parent Claude/Codex session's proxy URLs, session ids, auth-refresh
// hints) must never leak into a spawned runtime — a child inheriting a
// parent session's ANTHROPIC_BASE_URL without its auth reads as logged-out.
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC|AI_AGENT$|BAGGAGE$|CODEX)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

// Every session commits as its seat (H-787). Author is left to the machine's
// git config — Arthur stays responsible for the work — and the harness's own
// model trailer is left alone, because it is true and it is the vendors'
// channel for tool provenance. Committer is git's own field for "who made
// this commit", so `git log --committer=mason` answers that in any repo
// without depending on an agent having read an instruction.
export function sessionEnv(l: LoopConfig): NodeJS.ProcessEnv {
  return { ...cleanEnv(), GIT_COMMITTER_NAME: l.name, GIT_COMMITTER_EMAIL: `${l.name}@crew.local` };
}

export function runSession(g: GlobalConfig, l: LoopConfig, iterationPrompt: string, model = l.model, choice?: RunChoice): SessionResult {
  const runtime = choice?.runtime ?? l.runtime;
  // Apparatus pre-flight, fail closed: never launch a half-instructed agent.
  if (runtime !== 'mock') {
    if (!l.constitution || !existsSync(l.constitution) || statSync(l.constitution).size === 0) {
      return { rc: 78, cls: 'apparatus', outputTail: `constitution missing or empty: ${l.constitution}` };
    }
    for (const s of l.skills ?? []) {
      if (!existsSync(s) || statSync(s).size === 0) return { rc: 78, cls: 'apparatus', outputTail: `skill missing or empty: ${s}` };
    }
  }
  switch (runtime) {
    case 'claude':
      return runClaude(g, l, iterationPrompt, model);
    case 'codex':
      return runCodex(g, l, iterationPrompt, model, choice);
    case 'mock':
      return runMock(l, iterationPrompt, model);
    default:
      return { rc: 78, cls: 'apparatus', outputTail: `unsupported runtime '${runtime as string}' — add a shim branch` };
  }
}

// Sessions get exactly the roster's MCP surface: Helm (with this loop's actor
// identity) plus any extra servers the loop declares. Each adapter serializes
// this one record its CLI's way and keeps ambient user-scope servers out.
function mcpServers(g: GlobalConfig, l: LoopConfig, model: string): Record<string, Record<string, unknown>> {
  const helmEnv: Record<string, string> = { HELMO_ACTOR: JSON.stringify(loopActor(l, model)) };
  if (g.helmo_db) helmEnv['HELMO_DB'] = g.helmo_db;
  const servers: Record<string, Record<string, unknown>> = {
    helmo: { command: 'node', args: [g.helmo_mcp_server], env: helmEnv },
  };
  if (l.mcp_extra && existsSync(l.mcp_extra)) {
    Object.assign(servers, (JSON.parse(readFileSync(l.mcp_extra, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers ?? {});
  }
  return servers;
}

function writeMcpConfig(g: GlobalConfig, l: LoopConfig, dir: string, model: string): string {
  const path = join(dir, 'mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: mcpServers(g, l, model) }));
  return path;
}

// TOML basic-string escaping for the codex `-c` override. Values reaching this
// carry JSON (the Helmo actor), so quotes and backslashes are the normal case.
export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/[\u0000-\u0008\u000b-\u001f]/g, '')}"`;
}

function tomlValue(v: unknown): string {
  if (typeof v === 'string') return tomlString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, val]) => `${k}=${tomlValue(val)}`).join(',')}}`;
  }
  return '""';
}

/** The whole-table `mcp_servers={...}` override: codex's equivalent of
 *  --strict-mcp-config, since replacing the table drops ambient user-scope
 *  servers. Every server gets tools auto-approved — a headless session runs
 *  under `approval_policy = never`, where an unapproved MCP call hard-fails
 *  instead of prompting (verified against codex 0.150.1, H-479). */
export function codexMcpArg(servers: Record<string, Record<string, unknown>>): string {
  const withApproval = Object.fromEntries(
    Object.entries(servers).map(([name, s]) => [name, { default_tools_approval_mode: 'auto', ...s }]),
  );
  return `mcp_servers=${tomlValue(withApproval)}`;
}

function logTokens(l: LoopConfig, model: string, tokens?: number, cost?: number, runtime = l.runtime): void {
  try {
    appendFileSync(
      tokenLogPath(),
      `${new Date().toISOString()} loop=${l.name} runtime=${runtime} model=${model} tokens=${tokens ?? '?'} cost_usd=${cost ?? '?'}\n`,
    );
  } catch {
    /* metering must never affect the run */
  }
}

// Every session runs in its OWN process group (H-467). Without this the agent
// CLI shares the group of the loop and the supervisor above it, and a
// group-directed signal — launchd stopping the job, systemd killing the
// cgroup, a Ctrl-C or hangup on a shell-started fleet — lands on the agent
// mid-turn. The loop's careful signal deferral protects nothing then: the
// session dies rc=143 after its file writes and before its Helmo close, and
// the next iteration finds artifacts nobody's ticket accounts for. Detached,
// the signal reaches only the loop process, which defers past the in-flight
// session exactly as the drain is documented to. The cost is deliberate: a
// SIGKILLed loop leaves its session running to completion as an orphan —
// one session's tokens, spent finishing and closing its own work.
const SESSION_GROUP = { detached: true } as const;

// A completed CLI may leave background children in its detached group. Sweep
// that group only after the leader has returned; if the loop itself dies while
// spawnSync is blocked, this code never runs and H-467's close-out protection
// remains intact. TERM gets a short grace, then KILL bounds cleanup.
function cleanupSessionGroup(pid: number | undefined): void {
  if (!pid || process.platform === 'win32') return;
  const alive = (): boolean => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!alive()) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < 1000 && alive(); waited += 25) Atomics.wait(pause, 0, 0, 25);
  if (alive()) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* group exited between the liveness check and the signal */
    }
  }
}

// The system prompt a session carries: the constitution, then each roster
// skill whole (H-247) — a loop that touches Drive carries file-stewardship
// the way a desk session loads it. One file because the CLI takes one path.
export function systemPrompt(l: LoopConfig): string {
  const parts = [readFileSync(l.constitution, 'utf8')];
  for (const s of l.skills ?? []) parts.push(`\n\n--- Skill: ${s} ---\n\n${readFileSync(s, 'utf8')}`);
  return parts.join('');
}

function runClaude(g: GlobalConfig, l: LoopConfig, prompt: string, model: string): SessionResult {
  const scratch = mkdtempSync(join(tmpdir(), 'rev-'));
  try {
    const mcpConfig = writeMcpConfig(g, l, scratch, model);
    let systemFile = l.constitution;
    if (l.skills?.length) {
      systemFile = join(scratch, 'system.md');
      writeFileSync(systemFile, systemPrompt(l));
    }
    const res = spawnSync(
      'claude',
      [
        '-p', prompt,
        '--model', model,
        '--append-system-prompt-file', systemFile,
        '--strict-mcp-config', '--mcp-config', mcpConfig,
        '--dangerously-skip-permissions',
        '--output-format', 'json',
      ],
      { cwd: l.cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: sessionEnv(l), stdio: ['ignore', 'pipe', 'pipe'], ...SESSION_GROUP },
    );
    cleanupSessionGroup(res.pid);
    if (res.error) return { rc: 78, cls: 'apparatus', outputTail: `claude CLI not runnable: ${res.error.message}` };
    const stdout = res.stdout ?? '';
    let tokens: number | undefined, cost: number | undefined, tail = stdout;
    try {
      const j = JSON.parse(stdout) as Record<string, never> & {
        api_error_status?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
        total_cost_usd?: number;
        result?: string;
      };
      // Transient-API detection: a 429 (usage window exhausted) or 529
      // (overloaded) is a park-and-retry condition, never a failure.
      if (j.api_error_status === 429 || j.api_error_status === 529) {
        // Keep what the response said. Reducing this to "API 429" threw away
        // the one thing that distinguishes a rate limit from an exhausted
        // quota — and which quota, and when it resets. On 2026-08-26 that gap
        // cost three loops 34-42 hours of silence (H-402).
        const message = String(j.result ?? '').slice(0, 2000);
        return {
          rc: 75,
          cls: 'transient',
          limit: { status: j.api_error_status, message },
          outputTail: `API ${j.api_error_status}${message ? `: ${message}` : ''}`,
        };
      }
      tokens = (j.usage?.input_tokens ?? 0) + (j.usage?.output_tokens ?? 0);
      cost = j.total_cost_usd;
      tail = j.result ?? stdout;
      // claude can exit 0 with is_error:true (e.g. auth failure) — never let
      // that pass as a clean iteration.
      if ((j as { is_error?: boolean }).is_error && res.status === 0) {
        logTokens(l, model, tokens, cost);
        return { rc: 1, cls: 'failure', tokens, cost_usd: cost, outputTail: tail.slice(-4000) };
      }
    } catch {
      /* non-JSON output: keep raw tail */
    }
    logTokens(l, model, tokens, cost);
    const rc = res.status ?? 1;
    return { rc, cls: rc === 0 ? 'ok' : 'failure', tokens, cost_usd: cost, outputTail: `${tail}\n${res.stderr ?? ''}`.slice(-4000) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// What one codex exec --json run said, reduced to what rev needs. Pure, so the
// wire format is tested without a CLI or tokens.
export interface CodexRun {
  threadId?: string;                  // keys the rollout file that carries rate_limits
  tail: string;                       // last agent message
  usage?: { input: number; cached: number; output: number };
  turnCompleted: boolean;             // codex can exit 0 without finishing a turn — never trust rc alone
  failure?: string;                   // turn.failed / error message, when one arrived
}

export function parseCodexEvents(stdout: string): CodexRun {
  const run: CodexRun = { tail: '', turnCompleted: false };
  for (const line of stdout.split('\n')) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(e['type'] ?? '');
    if (type === 'thread.started') run.threadId = String(e['thread_id'] ?? '') || undefined;
    if (type === 'item.completed') {
      const item = e['item'] as { type?: string; text?: string } | undefined;
      if (item?.type === 'agent_message' && item.text) run.tail = item.text;
    }
    if (type === 'turn.completed') {
      run.turnCompleted = true;
      const u = (e['usage'] ?? {}) as Record<string, number>;
      run.usage = {
        input: u['input_tokens'] ?? 0,
        cached: u['cached_input_tokens'] ?? 0,
        output: (u['output_tokens'] ?? 0) + (u['reasoning_output_tokens'] ?? 0),
      };
    }
    if (type === 'turn.failed' || type === 'error') {
      run.failure = String((e['error'] as { message?: string } | undefined)?.message ?? e['message'] ?? 'unknown error');
    }
  }
  return run;
}

// A plan-auth CLI reports no dollar cost, but the burn breaker and spend
// write-back are calibrated in USD — so codex spend is priced notionally from
// the roster's per-model prices. Cached input gets the standard 90% discount
// unless the roster prices it explicitly.
export function notionalCost(usage: { input: number; cached: number; output: number }, price?: ModelPrice): number | undefined {
  if (!price) return undefined;
  const cachedRate = price.cached_input ?? price.input / 10;
  const usd = ((usage.input - usage.cached) * price.input + usage.cached * cachedRate + usage.output * price.output) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

const CODEX_LIMIT = /rate.?limit|too many requests|quota|usage.?limit|\b429\b|\boverloaded\b/i;

/** The full argv for one codex run. Pure, so the flag set is tested without a
 *  CLI. `--ignore-user-config` is the hermetic fleet home (H-520): fleet
 *  behavior must not change when the operator tweaks the desk config — the
 *  reasoning-effort, notify, and plugin settings in ~/.codex/config.toml all
 *  stay out, while auth.json and session rollouts are unaffected (verified on
 *  codex-cli 0.150.1; an earlier belief that this flag broke -c MCP servers
 *  was a misread — that failure was a malformed HELMO_ACTOR). Everything a
 *  fleet run needs arrives as explicit -c overrides: the MCP table, then the
 *  provider's [providers.<name>.config] entries — reasoning effort today,
 *  custom endpoints (model_providers) when a provider needs one. */
export function codexArgs(model: string, mcpArg: string, config?: Record<string, unknown>): string[] {
  return [
    'exec', '--json', '--skip-git-repo-check', '--ignore-user-config',
    '--dangerously-bypass-approvals-and-sandbox',
    '--model', model,
    '-c', mcpArg,
    ...Object.entries(config ?? {}).flatMap(([k, v]) => ['-c', `${k}=${tomlValue(v)}`]),
    '-',
  ];
}

function runCodex(g: GlobalConfig, l: LoopConfig, prompt: string, model: string, choice?: RunChoice): SessionResult {
  // Same contract as runClaude, codex's way: prompt via stdin (a constitution
  // in argv is world-readable via ps and bumps into argv limits), MCP via the
  // whole-table -c override, results from the --json event stream. Approvals
  // and sandbox off matches the claude posture — one permission story per
  // fleet, whichever CLI runs the iteration.
  const res = spawnSync(
    'codex',
    codexArgs(model, codexMcpArg(mcpServers(g, l, model)), choice?.config),
    {
      cwd: l.cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: sessionEnv(l),
      input: `${systemPrompt(l)}\n\n--- Iteration prompt ---\n\n${prompt}`,
      ...SESSION_GROUP,
    },
  );
  cleanupSessionGroup(res.pid);
  if (res.error) return { rc: 78, cls: 'apparatus', outputTail: `codex CLI not runnable: ${res.error.message}` };
  const run = parseCodexEvents(res.stdout ?? '');
  const tokens = run.usage ? run.usage.input + run.usage.output : undefined;
  const cost = run.usage ? notionalCost(run.usage, choice?.prices?.[model]) : undefined;
  logTokens(l, model, tokens, cost, 'codex');
  recordCodexUsage(run.threadId); // freshest cap standing, straight off this run's rollout

  // Transient detection: codex reports limits as failure text, not a status
  // field — keep the message whole for limitDecide (the H-402 rule).
  const limitText = run.failure && CODEX_LIMIT.test(run.failure) ? run.failure : res.status !== 0 && CODEX_LIMIT.test(res.stderr ?? '') ? (res.stderr ?? '') : null;
  if (limitText) {
    const message = limitText.slice(0, 2000);
    return { rc: 75, cls: 'transient', limit: { status: 429, message }, tokens, cost_usd: cost, outputTail: `API limit: ${message}` };
  }

  const tail = `${run.tail || run.failure || ''}\n${res.stderr ?? ''}`.slice(-4000);
  // rc 0 without a completed turn is a documented codex wart (openai/codex
  // #19309): treat it as the failure it is.
  const rc = res.status === 0 && (!run.turnCompleted || run.failure) ? 1 : (res.status ?? 1);
  return { rc, cls: rc === 0 ? 'ok' : 'failure', tokens, cost_usd: cost, outputTail: tail };
}

// Mock runtime: runs a shell command with the loop's identity in env. Exists so
// the harness itself is testable (and installs verifiable) without an agent CLI
// or tokens. The command's exit code flows through the ladder unchanged, so
// tests can exercise every failure class.
function runMock(l: LoopConfig, prompt: string, model: string): SessionResult {
  if (!l.mock_cmd) return { rc: 78, cls: 'apparatus', outputTail: "mock runtime requires 'mock_cmd' in the roster" };
  const res = spawnSync('bash', ['-c', l.mock_cmd], {
    cwd: l.cwd,
    encoding: 'utf8',
    env: { ...sessionEnv(l), REV_LOOP: l.name, REV_PROMPT: prompt, REV_MODEL: model, HELMO_ACTOR: JSON.stringify(loopActor(l, model)) },
    ...SESSION_GROUP,
  });
  cleanupSessionGroup(res.pid);
  const rc = res.status ?? 1;
  const cls = rc === 0 ? 'ok' : rc === 75 ? 'transient' : rc === 78 ? 'apparatus' : 'failure';
  // Mock sessions can report usage the way real runtimes do, so the metering
  // and spend write-back paths are testable without an agent CLI:
  //   echo "rev-mock-usage tokens=1200 cost_usd=0.25"
  const usage = /rev-mock-usage tokens=(\d+)(?: cost_usd=([\d.]+))?/.exec(res.stdout ?? '');
  const tokens = usage ? Number(usage[1]) : undefined;
  const cost = usage?.[2] ? Number(usage[2]) : undefined;
  if (usage) logTokens(l, model, tokens, cost);
  return { rc, cls, tokens, cost_usd: cost, outputTail: `${res.stdout ?? ''}${res.stderr ?? ''}`.slice(-4000) };
}
