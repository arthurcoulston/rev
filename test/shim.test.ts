import { describe, it, expect } from 'vitest';
import { codexArgs, codexMcpArg, notionalCost, parseCodexEvents, runSession, sessionEnv, sessionSpec, systemPrompt, tomlString } from '../src/shim.js';
import type { GlobalConfig, LoopConfig } from '../src/types.js';
import { parse } from 'smol-toml';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('codexArgs (H-520)', () => {
  it('is hermetic: user config ignored, everything explicit, prompt on stdin', () => {
    const args = codexArgs('gpt-5.6-terra', 'mcp_servers={}');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--json');
    expect(args[args.length - 1]).toBe('-');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
  });
  it('provider config entries become -c overrides in roster order', () => {
    const args = codexArgs('m', 'mcp_servers={}', { model_reasoning_effort: 'medium', model_providers: { or: { base_url: 'https://x', wire_api: 'responses' } } });
    const cs = args.filter((_, i) => args[i - 1] === '-c');
    expect(cs).toEqual([
      'mcp_servers={}',
      'model_reasoning_effort="medium"',
      'model_providers={or={base_url="https://x",wire_api="responses"}}',
    ]);
  });
});

// H-467: the agent session must live in its own process group, so a
// group-directed signal — launchd stopping the job, systemd killing the
// cgroup, a hangup on a shell-started fleet — cannot sever a turn between its
// file writes and its Helmo close. The loop process above it dies either way;
// what has to survive is the session finishing its own close-out, so that is
// what this asserts. Drop `detached` from the shim's spawn options and the
// session dies mid-run, the marker is never written, and the alarm rings.
describe('session process group (H-467)', () => {
  it('sweeps background children after a completed iteration (H-1013)', () => {
    const home = mkdtempSync(join(tmpdir(), 'rev-grp-'));
    const pidFile = join(home, 'background-pid');
    const loop = {
      name: 'grouptest', runtime: 'mock', model: 'm', version: '0', cwd: '/tmp',
      mock_cmd: `sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}`,
    } as LoopConfig;

    const res = runSession({} as GlobalConfig, loop, 'prompt');
    expect(res.rc, res.outputTail).toBe(0);
    const pid = Number(execFileSync('cat', [pidFile], { encoding: 'utf8' }).trim());
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('a signal to the whole process group does not reach the in-flight session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rev-grp-'));
    const started = join(home, 'session-started');
    const marker = join(home, 'session-closed');
    const file = join(home, 'driver.mts');
    writeFileSync(
      file,
      `import { runSession } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'shim.ts'))};\n` +
        `runSession({}, { name: 'grouptest', runtime: 'mock', model: 'm', version: '0', cwd: '/tmp',\n` +
        `  mock_cmd: 'echo started > ${started}; sleep 2; echo closed > ${marker}' }, 'prompt');\n`,
    );

    const child = spawn('npx', ['tsx', file], {
      detached: true, // the driver leads its own group, so the kill below is contained
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, REV_HOME: home },
    });

    let err = '';
    child.stderr!.on('data', (d: Buffer) => (err += d));

    // Signal the group once the session says it is genuinely in flight. This
    // kills the driver, the way a real drain kills the loop process.
    const startDeadline = Date.now() + 10_000;
    while (!existsSync(started) && Date.now() < startDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(started), 'session never started').toBe(true);
    expect(err, 'driver failed before the session started').toBe('');
    process.kill(-child.pid!, 'SIGTERM');
    await new Promise((r) => child.on('exit', r));
    expect(existsSync(marker), 'session killed before it could finish').toBe(false); // still sleeping

    // Give the orphaned session the rest of its run.
    const closeDeadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < closeDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(marker), 'the session did not survive the group signal').toBe(true);
  }, 30_000);
});

// H-787: the seat is stamped into git's own identity fields by the spawn env,
// not by asking an agent to write a trailer. Author stays the machine's git
// config (the operator is responsible for the work); the harness's model trailer is
// left alone. Drop either var from sessionEnv and the commit below comes back
// authored and committed by the same person, and the alarm rings.
describe('session git identity (H-787)', () => {
  const loop = { name: 'mason', runtime: 'mock', model: 'm', version: '0', cwd: '/tmp' } as LoopConfig;

  it('sets committer to the seat and touches neither author nor the rest of the env', () => {
    const env = sessionEnv(loop);
    expect(env['GIT_COMMITTER_NAME']).toBe('mason');
    expect(env['GIT_COMMITTER_EMAIL']).toBe('mason@crew.local');
    expect(env['GIT_AUTHOR_NAME']).toBeUndefined();
    expect(env['GIT_AUTHOR_EMAIL']).toBeUndefined();
    expect(env['PATH']).toBe(process.env['PATH']); // still the cleaned parent env
  });

  it('a real session commit carries the seat as committer and the human as author', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rev-git-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Example Operator');
    git('config', 'user.email', 'operator@example.test');
    writeFileSync(join(repo, 'f.txt'), 'work\n');

    const res = runSession({} as GlobalConfig, { ...loop, cwd: repo, mock_cmd: 'git add -A && git commit -q -m "session work"' }, 'prompt');
    expect(res.rc, res.outputTail).toBe(0);

    const [an, ae, cn, ce] = git('log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce').split('\x00');
    expect(cn).toBe('mason');
    expect(ce).toBe('mason@crew.local');
    expect(an).toBe('Example Operator');
    expect(ae).toBe('operator@example.test');
  });
});

// H-1152: a meeting IS the seat's loop session with a different entry, so the
// composition has to be one thing rev exports rather than two that drift.
// These assert the parts a second consumer depends on and could not see.
describe('sessionSpec (H-1152)', () => {
  const g = { helmo_mcp_server: '/tmp/helmo-server.js' } as GlobalConfig;
  const scratch = mkdtempSync(join(tmpdir(), 'rev-spec-'));
  const constitution = join(scratch, 'PROFILE.md');
  const skill = join(scratch, 'skill.md');
  writeFileSync(constitution, 'I am mason.');
  writeFileSync(skill, 'How to publish.');
  const loop = {
    name: 'mason', runtime: 'claude', model: 'claude-opus-5', version: '0.6',
    cwd: '/tmp/crew', constitution, skills: [skill],
  } as LoopConfig;

  it('carries the same system prompt the loop spawn writes to its system file', () => {
    expect(sessionSpec(g, loop).system_prompt).toBe(systemPrompt(loop));
  });

  it('carries the roster MCP surface with the seat as the Helm actor', () => {
    const spec = sessionSpec(g, loop, { model: 'claude-fable-5-1' });
    expect(spec.mcp_servers['helmo']!['args']).toEqual(['/tmp/helmo-server.js']);
    const actor = JSON.parse((spec.mcp_servers['helmo']!['env'] as Record<string, string>)['HELMO_ACTOR']!);
    expect(actor).toMatchObject({ name: 'mason', kind: 'agent', model: 'claude-fable-5-1', version: '0.6' });
    expect(spec.model).toBe('claude-fable-5-1');
  });

  // The stamp is how seatDecide tells a live loop's own hold from a foreign
  // one (H-558). A meeting wearing `rev:mason` would stand the mason loop down
  // against itself, so the override has to reach the actor the server sees —
  // not just the copy printed for the reader.
  it('a session override reaches the Helm server env, not only the readable actor', () => {
    const spec = sessionSpec(g, loop, { session: 'meeting:thread-7' });
    const actor = JSON.parse((spec.mcp_servers['helmo']!['env'] as Record<string, string>)['HELMO_ACTOR']!);
    expect(actor.session).toBe('meeting:thread-7');
    expect(spec.actor).toMatchObject({ session: 'meeting:thread-7' });
    expect(sessionSpec(g, loop).actor).toMatchObject({ session: 'rev:mason' });
  });

  // A spec is printed to stdout. sessionEnv() copies this process's whole
  // environment, so exporting it would publish the fleet's secrets; the export
  // carries the RULE (env_strip) and the overrides, and nothing of the caller.
  it('exports what rev sets and none of the caller environment', () => {
    process.env['REV_SPEC_FIXTURE_SECRET'] = 'do-not-export';
    try {
      const spec = sessionSpec(g, loop);
      expect(spec.env).toEqual({
        GIT_COMMITTER_NAME: 'mason',
        GIT_COMMITTER_EMAIL: 'mason@crew.local',
        REV_LOOP: 'mason',
        REV_CLI: process.argv[1] ?? '',
      });
      expect(JSON.stringify(spec)).not.toContain('do-not-export');
      expect(new RegExp(spec.env_strip).test('ANTHROPIC_API_KEY')).toBe(true);
      expect(new RegExp(spec.env_strip).test('PATH')).toBe(false);
    } finally {
      delete process.env['REV_SPEC_FIXTURE_SECRET'];
    }
  });

  it('declares the flags a loop actually runs with', () => {
    expect(sessionSpec(g, loop).flags).toEqual({ strict_mcp_config: true, dangerously_skip_permissions: true });
  });
});
