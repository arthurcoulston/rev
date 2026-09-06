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
