import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REV_CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const GP_REV_CLI = join(import.meta.dirname, '..', 'bin', 'gp-rev.js');
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

describe('gp-rev instance binding (H-2277)', () => {
  it('always reads ~/.rev-gp, even when the caller supplies another REV_HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'gp-rev-cli-'));
    const gpHome = join(home, '.rev-gp');
    const crossedHome = roster();
    writeFileSync(join(home, '.keep'), '');
    mkdirSync(gpHome);
    writeFileSync(join(gpHome, 'roster.toml'), `[global]
helmo_cli = "/tmp/helmo-cli.js"
helmo_mcp_server = "/tmp/helmo-server.js"

[loops.builder]
workstream = "goodplumb"
cwd = "/tmp"
runtime = "mock"
`);

    const result = spawnSync(process.execPath, [GP_REV_CLI, 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, REV_HOME: crossedHome, REV_TEST_SOURCE: '1' },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('builder');
    expect(result.stdout).not.toContain('alpha');
  });
});

describe('Prime team control (H-2301)', () => {
  function gp(home: string, args: string[], prime = true) {
    return spawnSync(process.execPath, [GP_REV_CLI, ...args], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, HOME: home, REV_LOOP: prime ? 'prime' : 'builder', REV_TEST_SOURCE: '1' },
    });
  }

  it('stops and resumes only Prime-owned stops while preserving holds', () => {
    const home = mkdtempSync(join(tmpdir(), 'gp-team-'));
    const gpHome = join(home, '.rev-gp'); mkdirSync(gpHome);
    writeFileSync(join(gpHome, 'roster.toml'), `[global]\nhelmo_cli = "/tmp/h"\nhelmo_mcp_server = "/tmp/m"\n[loops.prime]\nworkstream="governance"\ncwd="/tmp"\nruntime="mock"\n[loops.builder]\nworkstream="goodplumb"\ncwd="/tmp"\nruntime="mock"\n`);
    expect(gp(home, ['team', 'stop', 'all']).status).toBe(0);
    expect(existsSync(join(gpHome, 'state', 'builder', 'STOP'))).toBe(true);
    expect(existsSync(join(gpHome, 'state', 'prime', 'STOP'))).toBe(true);
    writeFileSync(join(gpHome, 'state', 'builder', 'HOLD'), 'cyber\n');
    expect(gp(home, ['team', 'resume', 'all']).status).toBe(1);
    expect(existsSync(join(gpHome, 'state', 'builder', 'STOP'))).toBe(true);

    writeFileSync(join(gpHome, 'state', 'builder', 'STOP'), '');
    expect(gp(home, ['team', 'stop', 'builder']).status).toBe(1);
    expect(readFileSync(join(gpHome, 'state', 'builder', 'STOP'), 'utf8')).toBe('');
  });

  it('reaches every worker of a pooled role (H-676)', () => {
    const home = mkdtempSync(join(tmpdir(), 'gp-team-role-'));
    const gpHome = join(home, '.rev-gp'); mkdirSync(gpHome);
    writeFileSync(join(gpHome, 'roster.toml'), `[global]\nhelmo_cli = "/tmp/h"\nhelmo_mcp_server = "/tmp/m"\n[loops.prime]\nworkstream="governance"\ncwd="/tmp/p"\nruntime="mock"\n[loops.builder]\nworkstream="goodplumb"\ncwd="/tmp/b"\nruntime="mock"\n[loops.builder-product]\nseat="builder"\nworkstream="goodplumb"\ncwd="/tmp/bp"\nruntime="mock"\n`);
    expect(gp(home, ['team', 'stop', 'builder']).status).toBe(0);
    expect(existsSync(join(gpHome, 'state', 'builder', 'STOP'))).toBe(true);
    expect(existsSync(join(gpHome, 'state', 'builder-product', 'STOP'))).toBe(true);
    expect(existsSync(join(gpHome, 'state', 'prime', 'STOP'))).toBe(false);
    expect(gp(home, ['team', 'resume', 'builder']).status).toBe(0);
    expect(existsSync(join(gpHome, 'state', 'builder-product', 'STOP'))).toBe(false);
  });

  it('refuses non-Prime callers', () => {
    const home = mkdtempSync(join(tmpdir(), 'gp-team-auth-'));
    const gpHome = join(home, '.rev-gp'); mkdirSync(gpHome);
    writeFileSync(join(gpHome, 'roster.toml'), `[global]\nhelmo_cli="/tmp/h"\nhelmo_mcp_server="/tmp/m"\n`);
    expect(gp(home, ['team', 'stop', 'all'], false).status).toBe(1);
  });
});

// H-676: with pool workers a role is several loops, and its first worker
// usually keeps the role's name. A control aimed at the role has to reach all
// of them; one aimed at a single worker has to leave its siblings alone.
describe('role-level control of pool workers (H-676)', () => {
  function pool(): string {
    const home = mkdtempSync(join(tmpdir(), 'rev-pool-cli-'));
    const loop = (name: string, extra = '') => `[loops.${name}]\n${extra}workstream = "w"\ncwd = "${join(home, name)}"\nruntime = "mock"\n`;
    writeFileSync(join(home, 'roster.toml'), `[global]\nhelmo_cli = "/tmp/h"\nhelmo_mcp_server = "/tmp/m"\n${loop('builder')}${loop('builder-harness', 'seat = "builder"\nproject = "R-29"\n')}${loop('reviewer')}`);
    return home;
  }
  const stopped = (home: string, name: string) => existsSync(join(home, 'state', name, 'STOP'));

  it('stops and resumes every worker of a pooled role, and no other seat', () => {
    const home = pool();
    const stop = rev(home, ['stop', 'builder']);
    expect(stop.status, stop.stderr).toBe(0);
    expect(stop.stdout).toContain("STOP set for 'builder', 'builder-harness'");
    expect([stopped(home, 'builder'), stopped(home, 'builder-harness'), stopped(home, 'reviewer')]).toEqual([true, true, false]);

    writeFileSync(join(home, 'state', 'builder-harness', 'HOLD'), 'operator\n');
    expect(rev(home, ['resume', 'builder']).status).toBe(0);
    expect([stopped(home, 'builder'), stopped(home, 'builder-harness')]).toEqual([false, false]);
    expect(existsSync(join(home, 'state', 'builder-harness', 'HOLD'))).toBe(false);
  });

  it('narrows to the one loop of that name with --worker', () => {
    const home = pool();
    expect(rev(home, ['stop', 'builder', '--worker']).status).toBe(0);
    expect([stopped(home, 'builder'), stopped(home, 'builder-harness')]).toEqual([true, false]);
    expect(rev(home, ['pace', 'builder-harness', 'park']).status).toBe(0);
    expect(existsSync(join(home, 'state', 'builder', 'PACE'))).toBe(false);
    expect(rev(home, ['pace', 'builder', 'park']).status).toBe(0);
    expect(existsSync(join(home, 'state', 'builder', 'PACE'))).toBe(true);
  });

  it('prints each loop with its seat and claim scope under status --json', () => {
    const home = pool();
    rev(home, ['stop', 'builder-harness']);
    const result = rev(home, ['status', '--json']);
    expect(result.status, result.stderr).toBe(0);
    const status = JSON.parse(result.stdout) as { supervisor: string; loops: Record<string, unknown>[] };
    expect(status.supervisor).toBe('down');
    expect(status.loops.map(({ loop, seat, pool, state, workstream, project }) => ({ loop, seat, pool, state, workstream, project }))).toEqual([
      { loop: 'builder', seat: 'builder', pool: true, state: 'halted', workstream: 'w', project: null },
      { loop: 'builder-harness', seat: 'builder', pool: true, state: 'STOP', workstream: 'w', project: 'R-29' },
      { loop: 'reviewer', seat: 'reviewer', pool: false, state: 'halted', workstream: 'w', project: null },
    ]);
  });
});

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

  // Same spelling gap as `--installation`, on the flags a command reads for
  // itself: `--tier=high` used to leave `--tier` unseen, so the command ran on
  // a default it was explicitly told not to take (H-2526).
  it('reads --<flag>=<value> as well as the space-separated spelling', () => {
    const { home } = seatRoster();
    const result = rev(home, ['session-spec', 'alpha', '--tier=high', '--session=meeting:t7']);

    expect(result.status, result.stderr).toBe(0);
    const spec = JSON.parse(result.stdout);
    expect(spec.model).toBe('claude-fable-5-1');
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

// H-2473: every command says which installation it is about, and a mutation
// refuses rather than redirects when the target it was given disagrees with
// the one the environment resolves. These build an environment rather than a
// command line, because the environment is where the target has always come
// from. The two-install proof that watches the OTHER installation's files stay
// byte-identical is H-2475's, against crew:tools/installs.
describe('installation target (H-2473)', () => {
  function install(label = 'dev.rev.a'): { home: string; account: string; label: string } {
    const account = mkdtempSync(join(tmpdir(), 'rev-install-'));
    const home = join(account, '.rev');
    mkdirSync(home);
    writeFileSync(join(home, 'roster.toml'), `[global]
helmo_cli = "/tmp/helmo-cli.js"
helmo_mcp_server = "/tmp/helmo-server.js"

[loops.alpha]
workstream = "test"
cwd = "/tmp"
runtime = "mock"
`);
    return { home, account, label };
  }

  // $HOME is where the service definition file lives, so it is redirected;
  // nothing is inherited from the fleet running this suite.
  function run(i: { home: string; account: string; label?: string }, args: string[]) {
    const env = { ...process.env, HOME: i.account, REV_HOME: i.home, REV_LABEL: i.label };
    if (!i.label) delete env.REV_LABEL;
    return spawnSync(process.execPath, ['--import', 'tsx/esm', REV_CLI, ...args], { cwd: ROOT, encoding: 'utf8', env });
  }

  /** A definition on disk for `label`, installed for some OTHER Rev home. */
  function foreignService(i: { account: string; label: string }, owner: string): void {
    const dir = join(i.account, 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${i.label}.plist`), `<key>REV_HOME</key><string>${owner}</string>`);
  }

  const stopped = (i: { home: string }) => existsSync(join(i.home, 'state', 'alpha', 'STOP'));

  it('names the installation a read surface read, with no flag and nothing set', () => {
    const i = install();
    const result = run({ ...i, label: undefined }, ['status']);

    expect(result.status, result.stderr).toBe(0);
    // Derived, because a home outside the account's own home is not covered by
    // the suffixed-home convention: readable part plus a digest of the path.
    expect(result.stdout.split('\n')[0]).toMatch(/^installation: dev\.rev\..+\.[0-9a-f]{8} \(/);
    expect(result.stdout).toContain(i.home);
  });

  it.each(['label', 'home'])('accepts --installation naming this installation by %s, and writes', (spelling) => {
    const i = install();
    const result = run(i, ['stop', 'alpha', '--installation', spelling === 'label' ? i.label : i.home]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`installation: dev.rev.a (${i.home})`);
    expect(stopped(i)).toBe(true);
  });

  it('refuses a mutation aimed at another installation, before writing, naming both', () => {
    const i = install();
    const result = run(i, ['stop', 'alpha', '--installation', 'dev.rev.b']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dev.rev.b');
    expect(result.stderr).toContain('dev.rev.a');
    expect(result.stderr).toContain(i.home);
    expect(stopped(i)).toBe(false);
  });

  it('refuses --installation with no value rather than guessing', () => {
    const i = install();
    const result = run(i, ['stop', 'alpha', '--installation']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--installation was given no value');
    expect(stopped(i)).toBe(false);
  });

  // The inherited case, which needs no flag to go wrong: every session Rev
  // spawns carries the supervisor's REV_LABEL, so a command run with another
  // REV_HOME is named by one installation and aimed at another.
  it('refuses a mutation whose inherited label belongs to another installation', () => {
    const i = install();
    foreignService(i, '/tmp/other/.rev');
    const result = run(i, ['stop', 'alpha']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/tmp/other/.rev');
    expect(result.stderr).toContain(i.home);
    expect(stopped(i)).toBe(false);
  });

  // Reads stay safe from any context (the watch officer uses them): a read
  // under that conflict still reads, and says the name cannot be trusted.
  it('lets a read through under the same conflict, saying the target is unclear', () => {
    const i = install();
    foreignService(i, '/tmp/other/.rev');
    const result = run(i, ['status']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('installation: UNCLEAR');
    expect(result.stdout).toContain('/tmp/other/.rev');
  });

  // H-2526. The assertion used to be an argument only the writing surfaces
  // passed, so every one of these took a wrong name and exited 0 — the exact
  // surface a consumer scripts the check ON. `usage` and `routing` were not in
  // the original report; they had the same hole, which is why the gate is now
  // at the door rather than per handler.
  it.each([['status'], ['service', 'status'], ['release', 'status'], ['usage'], ['routing']])(
    'refuses a read aimed at another installation: %s',
    (...command) => {
      const i = install();
      const result = run(i, [...command, '--installation', 'dev.rev.b']);

      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toContain('dev.rev.b');
      expect(result.stderr).toContain('dev.rev.a');
      expect(result.stderr).toContain(i.home);
      // Not the normal output with a refusal bolted on: the read never ran.
      expect(result.stdout).toBe('');
    },
  );

  // The joined spelling, which Helmo and the roadmap both take. Rev matched
  // only `--installation`, so `--installation=x` fell through as a positional
  // and `stop` — which reads rest[0] and ignores the rest — wrote anyway. A
  // silently discarded assertion is worse than a rejected one (H-2526).
  it('takes --installation=<value>, and still refuses the wrong one', () => {
    const i = install();
    const refused = run(i, ['stop', 'alpha', '--installation=dev.rev.b']);

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--installation named \'dev.rev.b\'');
    expect(stopped(i)).toBe(false);

    const accepted = run(i, ['stop', 'alpha', '--installation=dev.rev.a']);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(stopped(i)).toBe(true);
  });

  it('leaves a command’s own positional arguments alone wherever the flag sits', () => {
    const i = install();
    const result = run(i, ['pace', 'alpha', '--installation', 'dev.rev.a', '0.5']);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(i.home, 'state', 'alpha', 'PACE'), 'utf8')).toContain('0.5');
  });
});
