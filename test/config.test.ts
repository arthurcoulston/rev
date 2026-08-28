import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRoster } from '../src/config.js';
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
    expect(l.choices).toEqual([{ provider: 'claude', runtime: 'claude', model: 'm', probe_model: 'p', prices: undefined }]);
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
