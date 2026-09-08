import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REV_CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const ROOT = join(import.meta.dirname, '..');

function rev(home: string, args: string[]) {
  return spawnSync('npx', ['tsx', REV_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, REV_HOME: home },
  });
}

function roster(): string {
  const home = mkdtempSync(join(tmpdir(), 'rev-cli-'));
  writeFileSync(join(home, 'roster.toml'), `[global]
helmo_cli = "/tmp/helmo-cli.js"
helmo_mcp_server = "/tmp/helmo-server.js"

[loops.alpha]
workstream = "test"
cwd = "/tmp"
runtime = "mock"
`);
  return home;
}

describe('rev command arguments (H-810)', () => {
  it.each(['run', 'stop', 'resume', 'pace', 'tail'])('honours %s --help before loading the roster or treating it as a loop', (command) => {
    const home = join(tmpdir(), `rev-cli-missing-${command}-${process.pid}`);
    const result = rev(home, [command, '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`usage: rev ${command}`);
    expect(result.stderr).toBe('');
    expect(existsSync(join(home, 'state'))).toBe(false);
  });

  it.each([
    ['run', 'missing'],
    ['stop', 'missing'],
    ['resume', 'missing'],
    ['pace', 'missing', '1'],
    ['tail', 'missing'],
  ])('refuses an unknown loop before %s changes state', (...args) => {
    const home = roster();
    const result = rev(home, args);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown loop 'missing'. Roster has: alpha");
    expect(existsSync(join(home, 'state', 'missing'))).toBe(false);
  });
});

// H-1152: Meetings runs a seat's session without being its loop. These cover
// the boundary the command has to hold — the seat stamp and the two facts rev
// cannot know for a seat with no loop — rather than the JSON shape, which
// test/shim.test.ts owns.
describe('rev session-spec (H-1152)', () => {
  function seatRoster(): { home: string; constitution: string } {
    const home = mkdtempSync(join(tmpdir(), 'rev-spec-cli-'));
    const constitution = join(home, 'PROFILE.md');
    writeFileSync(constitution, 'I am alpha.\n');
    writeFileSync(join(home, 'roster.toml'), `[global]
helmo_cli = "/tmp/helmo-cli.js"
helmo_mcp_server = "/tmp/helmo-server.js"

[providers.claude.models]
high = "claude-fable-5-1"

[loops.alpha]
workstream = "test"
cwd = "/tmp"
provider = "claude"
tier = "high"
constitution = "${constitution}"
version = "0.4"
`);
    return { home, constitution };
  }

  it('resolves the asked-for tier and stamps the actor the caller named', () => {
    const { home } = seatRoster();
    const result = rev(home, ['session-spec', 'alpha', '--tier', 'high', '--session', 'meeting:t7']);

    expect(result.status, result.stderr).toBe(0);
    const spec = JSON.parse(result.stdout);
    expect(spec.model).toBe('claude-fable-5-1');
    expect(spec.in_roster).toBe(true);
    expect(JSON.parse(spec.mcp_servers.helmo.env.HELMO_ACTOR).session).toBe('meeting:t7');
  });

  // Defaulting the stamp would let a consumer sign as `rev:<seat>` by
  // omission, and its Helm writes would read as the loop's own hold (H-558).
  it('refuses without --session rather than defaulting to the loop seat stamp', () => {
    const { home } = seatRoster();
    const result = rev(home, ['session-spec', 'alpha', '--tier', 'high']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--session');
    expect(result.stdout).toBe('');
  });

  it('composes a seat with no roster loop from --cwd and --constitution, and says so', () => {
    const { home, constitution } = seatRoster();
    const result = rev(home, [
      'session-spec', 'herald', '--tier', 'high', '--session', 'meeting:t8',
      '--cwd', '/tmp', '--constitution', constitution,
    ]);

    expect(result.status, result.stderr).toBe(0);
    const spec = JSON.parse(result.stdout);
    expect(spec.seat).toBe('herald');
    expect(spec.in_roster).toBe(false);
    expect(JSON.parse(spec.mcp_servers.helmo.env.HELMO_ACTOR).name).toBe('herald');
  });

  it('refuses a seat with no loop and no cwd/constitution, naming both', () => {
    const { home } = seatRoster();
    const result = rev(home, ['session-spec', 'herald', '--tier', 'high', '--session', 'meeting:t9']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--cwd and --constitution');
  });

  // Same fail-closed rule runSession applies: never describe a session that
  // would start half-instructed.
  it('refuses an empty constitution', () => {
    const { home } = seatRoster();
    const empty = join(home, 'empty.md');
    writeFileSync(empty, '');
    const result = rev(home, [
      'session-spec', 'herald', '--tier', 'high', '--session', 'meeting:t9', '--cwd', '/tmp', '--constitution', empty,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('constitution missing or empty');
  });
});
