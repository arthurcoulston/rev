// Runtime shim — the single point where Capstan binds to concrete agent CLIs.
// Contract: run one non-interactive session in the loop's cwd; return the exit
// code classified per the ladder (0 clean / 75 transient / 78 apparatus),
// token accounting when the runtime reports it, and the output tail.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenLogPath } from './config.js';
import { loopActor } from './helm.js';
import { GlobalConfig, LoopConfig, SessionResult } from './types.js';

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

export function runSession(g: GlobalConfig, l: LoopConfig, iterationPrompt: string): SessionResult {
  // Apparatus pre-flight, fail closed: never launch a half-instructed agent.
  if (l.runtime !== 'mock') {
    if (!l.constitution || !existsSync(l.constitution) || statSync(l.constitution).size === 0) {
      return { rc: 78, cls: 'apparatus', outputTail: `constitution missing or empty: ${l.constitution}` };
    }
  }
  switch (l.runtime) {
    case 'claude':
      return runClaude(g, l, iterationPrompt);
    case 'codex':
      return runCodex(g, l, iterationPrompt);
    case 'mock':
      return runMock(l, iterationPrompt);
    default:
      return { rc: 78, cls: 'apparatus', outputTail: `unsupported runtime '${l.runtime as string}' — add a shim branch` };
  }
}

// Sessions get exactly the roster's MCP surface: Helm (with this loop's actor
// identity) plus any extra servers the loop declares. --strict-mcp-config keeps
// ambient user-scope servers out of headless sessions.
function writeMcpConfig(g: GlobalConfig, l: LoopConfig, dir: string): string {
  const helmEnv: Record<string, string> = { HELM_ACTOR: JSON.stringify(loopActor(l)) };
  if (g.helm_db) helmEnv['HELM_DB'] = g.helm_db;
  const servers: Record<string, unknown> = {
    helm: { command: 'node', args: [g.helm_mcp_server], env: helmEnv },
  };
  if (l.mcp_extra && existsSync(l.mcp_extra)) {
    Object.assign(servers, (JSON.parse(readFileSync(l.mcp_extra, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {});
  }
  const path = join(dir, 'mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: servers }));
  return path;
}

function logTokens(l: LoopConfig, tokens?: number, cost?: number): void {
  try {
    appendFileSync(
      tokenLogPath(),
      `${new Date().toISOString()} loop=${l.name} runtime=${l.runtime} model=${l.model} tokens=${tokens ?? '?'} cost_usd=${cost ?? '?'}\n`,
    );
  } catch {
    /* metering must never affect the run */
  }
}

function runClaude(g: GlobalConfig, l: LoopConfig, prompt: string): SessionResult {
  const scratch = mkdtempSync(join(tmpdir(), 'capstan-'));
  try {
    const mcpConfig = writeMcpConfig(g, l, scratch);
    const res = spawnSync(
      'claude',
      [
        '-p', prompt,
        '--model', l.model,
        '--append-system-prompt-file', l.constitution,
        '--strict-mcp-config', '--mcp-config', mcpConfig,
        '--dangerously-skip-permissions',
        '--output-format', 'json',
      ],
      { cwd: l.cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
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
        return { rc: 75, cls: 'transient', outputTail: `API ${j.api_error_status}` };
      }
      tokens = (j.usage?.input_tokens ?? 0) + (j.usage?.output_tokens ?? 0);
      cost = j.total_cost_usd;
      tail = j.result ?? stdout;
      // claude can exit 0 with is_error:true (e.g. auth failure) — never let
      // that pass as a clean iteration.
      if ((j as { is_error?: boolean }).is_error && res.status === 0) {
        logTokens(l, tokens, cost);
        return { rc: 1, cls: 'failure', tokens, cost_usd: cost, outputTail: tail.slice(-4000) };
      }
    } catch {
      /* non-JSON output: keep raw tail */
    }
    logTokens(l, tokens, cost);
    const rc = res.status ?? 1;
    return { rc, cls: rc === 0 ? 'ok' : 'failure', tokens, cost_usd: cost, outputTail: `${tail}\n${res.stderr ?? ''}`.slice(-4000) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runCodex(_g: GlobalConfig, l: LoopConfig, prompt: string): SessionResult {
  // Ported shape from the prototype: ephemeral, no user config, last-message capture.
  const lastMsg = join(mkdtempSync(join(tmpdir(), 'capstan-')), 'last.md');
  const res = spawnSync(
    'codex',
    [
      'exec', '--ephemeral', '--ignore-user-config', '--dangerously-bypass-approvals-and-sandbox',
      '--output-last-message', lastMsg, '--model', l.model,
      `${readFileSync(l.constitution, 'utf8')}\n\n--- Iteration prompt ---\n\n${prompt}`,
    ],
    { cwd: l.cwd, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 32 * 1024 * 1024, env: cleanEnv() },
  );
  if (res.error) return { rc: 78, cls: 'apparatus', outputTail: `codex CLI not runnable: ${res.error.message}` };
  const tail = existsSync(lastMsg) ? readFileSync(lastMsg, 'utf8') : (res.stderr ?? '');
  logTokens(l);
  const rc = res.status ?? 1;
  return { rc, cls: rc === 0 ? 'ok' : 'failure', outputTail: tail.slice(-4000) };
}

// Mock runtime: runs a shell command with the loop's identity in env. Exists so
// the harness itself is testable (and installs verifiable) without an agent CLI
// or tokens. The command's exit code flows through the ladder unchanged, so
// tests can exercise every failure class.
function runMock(l: LoopConfig, prompt: string): SessionResult {
  if (!l.mock_cmd) return { rc: 78, cls: 'apparatus', outputTail: "mock runtime requires 'mock_cmd' in the roster" };
  const res = spawnSync('bash', ['-c', l.mock_cmd], {
    cwd: l.cwd,
    encoding: 'utf8',
    env: { ...cleanEnv(), CAPSTAN_LOOP: l.name, CAPSTAN_PROMPT: prompt, HELM_ACTOR: JSON.stringify(loopActor(l)) },
  });
  const rc = res.status ?? 1;
  const cls = rc === 0 ? 'ok' : rc === 75 ? 'transient' : rc === 78 ? 'apparatus' : 'failure';
  return { rc, cls, outputTail: `${res.stdout ?? ''}${res.stderr ?? ''}`.slice(-4000) };
}
