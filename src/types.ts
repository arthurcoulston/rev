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
}

export interface LoopConfig {
  name: string;
  workstream: string;
  cwd: string;
  runtime: 'claude' | 'codex' | 'mock';
  model: string;
  constitution: string;    // path, relative to rev home or absolute
  version: string;         // loop version — part of the actor identity
  pace: number;            // velocity fraction (0,1]
  prompt?: string;         // iteration prompt tail
  mcp_extra?: string;      // optional path to JSON with additional MCP servers
  mock_cmd?: string;       // mock runtime only: shell command to run per iteration
}

// Session outcome classes, in the ladder's terms.
export type ExitClass = 'ok' | 'transient' | 'apparatus' | 'failure';

export interface SessionResult {
  rc: number;
  cls: ExitClass;
  tokens?: number;
  cost_usd?: number;
  outputTail: string; // last lines of session output, for traces and escalations
}

export const SENTINELS = ['STOP', 'HOLD', 'BLOCKED', 'LIMIT', 'IDLE', 'RUNNING', 'PACE', 'PARKED', 'BACKOFF'] as const;
export type Sentinel = (typeof SENTINELS)[number];
