import { describe, it, expect } from 'vitest';
import { codexMcpArg, notionalCost, parseCodexEvents, tomlString } from '../src/shim.js';
import { parse } from 'smol-toml';

// Real event lines captured from codex exec --json (codex-cli 0.150.1,
// 2026-08-27). The stream is undocumented; this fixture is the contract.
const EVENTS = [
  '{"type":"thread.started","thread_id":"01a046bb-c063-77c3-b739-65580be909e1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"working on it"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"helmo","tool":"helmo_list_tickets","status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"H-1 done"}}',
  '{"type":"turn.completed","usage":{"input_tokens":11949,"cached_input_tokens":9984,"cache_write_input_tokens":0,"output_tokens":6,"reasoning_output_tokens":3}}',
].join('\n');

describe('parseCodexEvents (H-479)', () => {
  it('reads the thread id, the last agent message, and the usage', () => {
    const run = parseCodexEvents(EVENTS);
    expect(run.threadId).toBe('01a046bb-c063-77c3-b739-65580be909e1');
    expect(run.tail).toBe('H-1 done');
    expect(run.turnCompleted).toBe(true);
    expect(run.failure).toBeUndefined();
    // reasoning tokens are output tokens: they were generated and billed
    expect(run.usage).toEqual({ input: 11949, cached: 9984, output: 9 });
  });

  it('a stream with no turn.completed is not a clean run, whatever the exit code said', () => {
    const run = parseCodexEvents(EVENTS.split('\n').slice(0, 3).join('\n'));
    expect(run.turnCompleted).toBe(false);
  });

  it('keeps the failure message whole (the H-402 rule: never reduce a limit to a number)', () => {
    const run = parseCodexEvents(
      EVENTS + '\n{"type":"turn.failed","error":{"message":"Rate limit exceeded: weekly cap, resets 2026-09-03T09:38:26Z"}}',
    );
    expect(run.failure).toContain('resets 2026-09-03');
  });

  it('skips non-JSON lines rather than throwing', () => {
    expect(parseCodexEvents('Reading additional input from stdin...\n' + EVENTS).turnCompleted).toBe(true);
    expect(parseCodexEvents('').turnCompleted).toBe(false);
  });
});

describe('notionalCost (H-479)', () => {
  it('prices uncached input, discounted cached input, and output per MTok', () => {
    // terra prices: $2/$12; cached at the standard input/10
    const usd = notionalCost({ input: 1_000_000, cached: 500_000, output: 100_000 }, { input: 2, output: 12 });
    expect(usd).toBeCloseTo(0.5 * 2 + 0.5 * 0.2 + 0.1 * 12, 6);
  });
  it('an explicit cached price wins over the default discount', () => {
    const usd = notionalCost({ input: 1_000_000, cached: 1_000_000, output: 0 }, { input: 2, output: 12, cached_input: 1 });
    expect(usd).toBeCloseTo(1, 6);
  });
  it('no price table means no cost — the burn breaker stays honest about not knowing', () => {
    expect(notionalCost({ input: 100, cached: 0, output: 10 }, undefined)).toBeUndefined();
  });
});

describe('codex MCP override (H-479)', () => {
  it('serializes the server table as valid TOML with tools auto-approved', () => {
    const actor = JSON.stringify({ name: 'bosun', kind: 'agent', model: 'gpt-5.6-terra', version: '0.3' });
    const arg = codexMcpArg({
      helmo: { command: 'node', args: ['/x/server.js'], env: { HELMO_ACTOR: actor } },
    });
    expect(arg.startsWith('mcp_servers=')).toBe(true);
    // The override must parse as the TOML codex will read.
    const parsed = parse(arg) as {
      mcp_servers: { helmo: { command: string; args: string[]; env: { HELMO_ACTOR: string }; default_tools_approval_mode: string } };
    };
    expect(parsed.mcp_servers.helmo.command).toBe('node');
    expect(parsed.mcp_servers.helmo.args).toEqual(['/x/server.js']);
    expect(parsed.mcp_servers.helmo.default_tools_approval_mode).toBe('auto');
    // The actor JSON round-trips through the TOML escaping intact.
    expect(JSON.parse(parsed.mcp_servers.helmo.env.HELMO_ACTOR)).toEqual({ name: 'bosun', kind: 'agent', model: 'gpt-5.6-terra', version: '0.3' });
  });

  it('a declared approval mode is not overridden', () => {
    const arg = codexMcpArg({ extra: { command: 'x', default_tools_approval_mode: 'prompt' } });
    const parsed = parse(arg) as { mcp_servers: { extra: { default_tools_approval_mode: string } } };
    expect(parsed.mcp_servers.extra.default_tools_approval_mode).toBe('prompt');
  });

  it('escapes quotes, backslashes, and newlines; strips raw control bytes', () => {
    expect(tomlString('a"b\\c\nd\te')).toBe('"a\\"b\\\\c\\nd\\te"');
    expect(tomlString('xy')).toBe('"xy"');
  });
});
