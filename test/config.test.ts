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
