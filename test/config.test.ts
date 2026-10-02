import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlTargets, loadRoster } from '../src/config.js';
import { systemPrompt } from '../src/shim.js';

describe('roster skills (H-247)', () => {
  it('loads skill paths and appends each whole after the constitution', () => {
    const home = mkdtempSync(join(tmpdir(), 'rev-cfg-'));
    const cons = join(home, 'PROFILE.md');
    const skill = join(home, 'skill.md');
    writeFileSync(cons, '# Profile\n');
    writeFileSync(skill, '# Skill body\n');
    mkdirSync(join(home, 'work'));
    writeFileSync(
      join(home, 'roster.toml'),
      `[global]\nhelmo_cli = "x"\nhelmo_mcp_server = "y"\n[loops.a]\nworkstream = "w"\ncwd = "${join(home, 'work')}"\nruntime = "claude"\nmodel = "m"\nconstitution = "${cons}"\nskills = ["${skill}"]\n[loops.b]\nworkstream = "w"\ncwd = "${join(home, 'work')}"\nruntime = "claude"\nmodel = "m"\nconstitution = "${cons}"\n`,
    );
    process.env['REV_HOME'] = home;
    const r = loadRoster();
    expect(r.loops['a']!.skills).toEqual([skill]);
    expect(r.loops['b']!.skills).toBeUndefined();
    expect(systemPrompt(r.loops['a']!)).toBe(`# Profile\n\n\n--- Skill: ${skill} ---\n\n# Skill body\n`);
    expect(systemPrompt(r.loops['b']!)).toBe('# Profile\n');
  });
});

describe('parallel workers', () => {
  // extra is spliced in before cwd, so a test can override where a loop runs.
  function roster(loops: [name: string, extra?: string][]): string {
    const home = mkdtempSync(join(tmpdir(), 'rev-cfg-'));
    writeFileSync(join(home, 'PROFILE.md'), '# Profile\n');
    const loop = ([name, extra = '']: [string, string?]) => `[loops.${name}]\n${extra}workstream = "w"\n${extra.includes('cwd') ? '' : `cwd = "${join(home, name)}"\n`}runtime = "mock"\nmodel = "m"\nconstitution = "${join(home, 'PROFILE.md')}"\n`;
    writeFileSync(join(home, 'roster.toml'), `[global]\nhelmo_cli = "x"\nhelmo_mcp_server = "y"\n${loops.map(loop).join('')}\n`);
    process.env['REV_HOME'] = home;
    return home;
  }

  it('defaults one loop to one seat and groups explicitly shared workers by session', () => {
    roster([['builder'], ['builder-2', 'seat = "builder"\nproject = "R-29"\n'], ['reviewer']]);
    const loops = loadRoster().loops;
    expect(loops['builder']!.seat).toBe('builder');
    expect(loops['builder']!.peer_sessions).toEqual(['rev:builder', 'rev:builder-2']);
    expect(loops['builder-2']!.peer_sessions).toEqual(['rev:builder', 'rev:builder-2']);
    expect(loops['builder-2']!.project).toBe('R-29');
    expect(loops['builder']!.project).toBeUndefined();
    expect(loops['reviewer']!.peer_sessions).toEqual(['rev:reviewer']);
  });

  it('refuses two workers on one seat sharing a writable checkout (H-574)', () => {
    roster([['builder', 'cwd = "/tmp/shared"\n'], ['builder-2', 'seat = "builder"\ncwd = "/tmp/shared"\n']]);
    expect(() => loadRoster()).toThrow(/share seat 'builder' and cwd \/tmp\/shared/);
  });

  describe('writable destinations compare by what they are, not how they are spelled (H-671)', () => {
    function git(...args: string[]) { execFileSync('git', args, { stdio: 'ignore' }); }
    function repo(): string {
      const dir = mkdtempSync(join(tmpdir(), 'rev-cfg-repo-'));
      git('-C', dir, 'init', '-q');
      git('-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root');
      return dir;
    }
    const pair = (a: string, b: string) => roster([['builder', `cwd = "${a}"\n`], ['builder-2', `seat = "builder"\ncwd = "${b}"\n`]]);

    it('refuses a symlink alias of the same checkout', () => {
      const r = repo();
      const alias = join(mkdtempSync(join(tmpdir(), 'rev-cfg-alias-')), 'alias');
      symlinkSync(r, alias);
      pair(r, alias);
      expect(() => loadRoster()).toThrow(/is the same directory/);
    });

    it('refuses a checkout nested inside another worker\'s, existing or not', () => {
      const r = repo();
      pair(r, join(r, 'out', 'not-yet'));
      expect(() => loadRoster()).toThrow(/nested checkouts/);
    });

    it('refuses two directories of one worktree, which share its index', () => {
      const r = repo();
      mkdirSync(join(r, 'a')); mkdirSync(join(r, 'b'));
      pair(join(r, 'a'), join(r, 'b'));
      expect(() => loadRoster()).toThrow(/one git worktree and index/);
    });

    it('accepts distinct worktrees of one repository', () => {
      const r = repo();
      const wt = join(mkdtempSync(join(tmpdir(), 'rev-cfg-wt-')), 'wt');
      git('-C', r, 'worktree', 'add', '-q', '-b', 'second', wt);
      pair(r, wt);
      expect(Object.keys(loadRoster().loops)).toEqual(['builder', 'builder-2']);
    });
  });

  it('loads exact ticket allowlists and refuses one ticket in two (H-671)', () => {
    roster([['builder', 'tickets = ["H-655", "H-684"]\n'], ['builder-2', 'seat = "builder"\ntickets = ["H-654"]\n'], ['builder-3', 'seat = "builder"\n'], ['reviewer']]);
    const lanes = loadRoster().loops;
    expect(lanes['builder']!.tickets).toEqual(['H-655', 'H-684']);
    // The worker with no lane leaves every lane's tickets to its owner.
    expect(lanes['builder-3']!.exclude_tickets).toEqual(['H-655', 'H-684', 'H-654']);
    expect(lanes['builder']!.exclude_tickets).toBeUndefined();
    expect(lanes['reviewer']!.exclude_tickets).toBeUndefined();
    roster([['builder', 'tickets = ["H-655", "H-684"]\n'], ['builder-2', 'seat = "builder"\ntickets = ["H-684"]\n']]);
    expect(() => loadRoster()).toThrow(/both list H-684/);
    for (const bad of ['[]', '["H-1", "H-1"]', '["H 1"]', '"H-1"']) {
      roster([['builder', `tickets = ${bad}\n`], ['builder-2', 'seat = "builder"\n']]);
      expect(() => loadRoster()).toThrow(/distinct exact ticket ids/);
    }
    roster([['builder', 'tickets = ["H-1"]\n'], ['reviewer']]);
    expect(() => loadRoster()).toThrow(/'tickets' scopes a pool worker's claims/);
  });

  it('refuses a store-wide pool worker, whose claim has no exact workstream (H-574)', () => {
    const home = roster([['builder'], ['builder-2', 'seat = "builder"\n']]);
    const path = join(home, 'roster.toml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('[loops.builder-2]\nseat = "builder"\nworkstream = "w"', '[loops.builder-2]\nseat = "builder"\nworkstream = "*"'));
    expect(() => loadRoster()).toThrow(/needs one exact workstream, not '\*'/);
  });

  it('refuses a project lane on a loop with no pool to schedule (H-574)', () => {
    roster([['builder', 'project = "R-29"\n'], ['reviewer']]);
    expect(() => loadRoster()).toThrow(/'project' scopes a pool worker's claims/);
  });

  it('addresses a pooled role as every worker, and one worker only when asked (H-676)', () => {
    roster([['builder'], ['builder-harness', 'seat = "builder"\n'], ['reviewer'], ['design', 'seat = "critic"\n']]);
    const loops = loadRoster().loops;
    expect(controlTargets(loops, 'builder')).toEqual(['builder', 'builder-harness']);
    expect(controlTargets(loops, 'builder', true)).toEqual(['builder']);
    expect(controlTargets(loops, 'builder-harness')).toEqual(['builder-harness']);
    expect(controlTargets(loops, 'reviewer')).toEqual(['reviewer']);
    expect(controlTargets(loops, 'critic')).toEqual(['design']);
    expect(controlTargets(loops, 'critic', true)).toEqual([]);
    expect(controlTargets(loops, 'missing')).toEqual([]);
  });
});

describe('providers, tiers, rotation, fallbacks (H-479)', () => {
  function home(loops: string, providers = ''): string {
    const home = mkdtempSync(join(tmpdir(), 'rev-cfg-'));
    writeFileSync(join(home, 'PROFILE.md'), '# Profile\n');
    mkdirSync(join(home, 'work'));
    writeFileSync(
      join(home, 'roster.toml'),
      `[global]\nhelmo_cli = "x"\nhelmo_mcp_server = "y"\n${providers}\n${loops.replaceAll('CWD', join(home, 'work')).replaceAll('CONS', join(home, 'PROFILE.md'))}`,
    );
    process.env['REV_HOME'] = home;
    return home;
  }
  const TABLES = `
[providers.claude.models]
small = "c-small"
mid = "c-mid"
[providers.codex.models]
small = "x-small"
mid = "x-mid"
[providers.codex.prices]
"x-mid" = { input = 2.0, output = 12.0 }
`;
  const LOOP = `[loops.a]\nworkstream = "w"\ncwd = "CWD"\nconstitution = "CONS"\n`;

  it('resolves provider + tier to a model, with the probe tier on the same provider', () => {
    home(LOOP + 'provider = "codex"\ntier = "mid"\nprobe_tier = "small"\n', TABLES);
    const l = loadRoster().loops['a']!;
    expect(l.runtime).toBe('codex');
    expect(l.model).toBe('x-mid');
    expect(l.probe_model).toBe('x-small');
    expect(l.choices).toHaveLength(1);
    expect(l.choices[0]!.prices?.['x-mid']).toEqual({ input: 2.0, output: 12.0 });
  });

  it('a claude/codex runtime doubles as the provider name for tier resolution', () => {
    home(LOOP + 'runtime = "claude"\ntier = "mid"\n', TABLES);
    expect(loadRoster().loops['a']!.model).toBe('c-mid');
  });

  it('the v0 form (runtime + model strings) still loads unchanged', () => {
    home(LOOP + 'runtime = "claude"\nmodel = "m"\nprobe_model = "p"\n');
    const l = loadRoster().loops['a']!;
    expect(l.model).toBe('m');
    expect(l.probe_model).toBe('p');
    expect(l.choices).toEqual([{
      provider: 'claude', runtime: 'claude', billing: 'metered', model: 'm', probe_model: 'p', prices: undefined, config: undefined,
    }]);
    expect(l.fallbacks).toEqual([]);
  });

  it('rotation builds the cycle in order, defaulting each entry to the loop tier', () => {
    home(LOOP + 'provider = "claude"\ntier = "mid"\nprobe_tier = "small"\nrotation = ["claude", "codex"]\nfallback = ["codex:small"]\n', TABLES);
    const l = loadRoster().loops['a']!;
    expect(l.choices.map((c) => [c.provider, c.model, c.probe_model])).toEqual([
      ['claude', 'c-mid', 'c-small'],
      ['codex', 'x-mid', 'x-small'],
    ]);
    expect(l.fallbacks.map((c) => c.model)).toEqual(['x-small']);
    expect(l.model).toBe('c-mid'); // primary = first of the cycle
  });

  it('headroom routing is opt-in and refuses a proactive tier downgrade', () => {
    home(LOOP + 'provider = "codex"\ntier = "mid"\nrotation = ["codex", "claude"]\nrouting = "headroom"\n', TABLES);
    expect(loadRoster().loops['a']!.routing).toBe('headroom');
    home(LOOP + 'provider = "codex"\ntier = "mid"\n', TABLES);
    expect(loadRoster().loops['a']!.routing).toBe('rotation');
    for (const rotation of ['["codex", "claude:small"]', '["codex"]']) {
      home(LOOP + `provider = "codex"\ntier = "mid"\nrotation = ${rotation}\nrouting = "headroom"\n`, TABLES);
      expect(() => loadRoster()).toThrow(/same tier/);
    }
    home(LOOP + 'provider = "codex"\ntier = "mid"\nrouting = "mystery"\n', TABLES);
    expect(() => loadRoster()).toThrow(/routing must/);
  });

  it('fails the whole roster loudly on a reference that cannot run', () => {
    home(LOOP + 'provider = "codex"\ntier = "frontier"\n', TABLES);
    expect(() => loadRoster()).toThrow(/no model for tier 'frontier'/);
    home(LOOP + 'provider = "kimi"\ntier = "mid"\n', TABLES);
    expect(() => loadRoster()).toThrow(/unknown provider 'kimi'/);
    home(LOOP + 'provider = "claude"\ntier = "mid"\nrotation = ["codex"]\nprobe_model = "p"\n', TABLES);
    expect(() => loadRoster()).toThrow(/probe_tier/);
    home(LOOP + 'runtime = "claude"\n');
    expect(() => loadRoster()).toThrow(/needs either 'model'.*or 'tier'/);
  });

  it('refuses a loop key it does not name — the retired prompt tail first among them (H-1186)', () => {
    // A `prompt` used to append free text from this file to every iteration:
    // prose outside git, caps and review. Unknown keys fail at load so the
    // channel cannot come back under any name.
    home(LOOP + 'runtime = "claude"\nmodel = "m"\nprompt = "be brief"\n');
    expect(() => loadRoster()).toThrow(/unknown key 'prompt'/);
    home(LOOP + 'runtime = "claude"\nmodel = "m"\npreamble = "be brief"\n');
    expect(() => loadRoster()).toThrow(/unknown key 'preamble'/);
  });

  it('a future provider is a table entry naming its adapter, with config riding along (H-520)', () => {
    home(
      LOOP + 'provider = "kimi"\ntier = "mid"\n',
      TABLES + '[providers.kimi]\nruntime = "codex"\n[providers.kimi.models]\nmid = "k2"\n[providers.kimi.config]\nmodel_reasoning_effort = "low"\n',
    );
    const l = loadRoster().loops['a']!;
    expect(l.runtime).toBe('codex'); // kimi rides the codex adapter
    expect(l.choices[0]!.provider).toBe('kimi');
    expect(l.model).toBe('k2');
    expect(l.choices[0]!.config).toEqual({ model_reasoning_effort: 'low' });
  });
});

describe('capacity roster keys (H-185)', () => {
  function roster(body: string): string {
    const home = mkdtempSync(join(tmpdir(), 'rev-cfg-'));
    writeFileSync(join(home, 'PROFILE.md'), '# Profile\n');
    mkdirSync(join(home, 'work'));
    writeFileSync(
      join(home, 'roster.toml'),
      `[global]\nhelmo_cli = "x"\nhelmo_mcp_server = "y"\n${body}\n[loops.a]\nworkstream = "w"\ncwd = "${join(home, 'work')}"\nruntime = "claude"\nmodel = "m"\nconstitution = "${join(home, 'PROFILE.md')}"\n`,
    );
    process.env['REV_HOME'] = home;
    return home;
  }

  it('defaults every new key to today’s behaviour', () => {
    roster('');
    const g = loadRoster().global;
    expect(g.shared_reserve_percent).toBe(5);
    expect(g.stale_grace_iterations).toBe(6);
    expect(g.investigation_target_seconds).toBe(1800);
    expect(g.relapse_window_seconds).toBe(3600);
    expect(g.anomaly_rate_multiple).toBe(6);
    expect(g.anomaly_min_usd).toBe(1);
    expect(g.anomaly_abs_percent).toBe(10);
    expect(g.exhaustion_ceiling_seconds).toBe(691200);
    // The point of the defaults: the dollar gate is untouched until an estate
    // declares an account flat, so shipping this moves nobody.
    expect(g.burn_usd_per_day).toBe(75);
  });

  it('defaults a provider to metered, including the builtin entries', () => {
    roster('');
    const p = loadRoster().providers;
    expect(p['claude']!.billing).toBe('metered');
    expect(p['codex']!.billing).toBe('metered');
  });

  it('takes a declared subscription account', () => {
    roster('[providers.claude]\nbilling = "subscription"\n[providers.codex]\nbilling = "subscription"\n');
    const p = loadRoster().providers;
    expect(p['claude']!.billing).toBe('subscription');
    expect(p['codex']!.billing).toBe('subscription');
  });

  it('refuses a billing word it does not know', () => {
    roster('[providers.claude]\nbilling = "flat"\n');
    expect(() => loadRoster()).toThrow(/billing must be 'metered' or 'subscription'/);
  });

  it('takes an overridden threshold from [global]', () => {
    roster('');
    expect(loadRoster().global.anomaly_rate_multiple).toBe(6);
    roster('');
    const home = mkdtempSync(join(tmpdir(), 'rev-cfg-'));
    mkdirSync(join(home, 'work'));
    writeFileSync(join(home, 'PROFILE.md'), '# Profile\n');
    writeFileSync(
      join(home, 'roster.toml'),
      `[global]\nhelmo_cli = "x"\nhelmo_mcp_server = "y"\nanomaly_rate_multiple = 4\nshared_reserve_percent = 0\n[loops.a]\nworkstream = "w"\ncwd = "${join(home, 'work')}"\nruntime = "claude"\nmodel = "m"\nconstitution = "${join(home, 'PROFILE.md')}"\n`,
    );
    process.env['REV_HOME'] = home;
    expect(loadRoster().global.anomaly_rate_multiple).toBe(4);
    expect(loadRoster().global.shared_reserve_percent).toBe(0);
  });
});
