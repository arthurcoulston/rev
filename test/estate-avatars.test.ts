// The vendored estate crew avatar sprite (R-11 H-714). Same seam as
// test/estate-tokens.test.ts, and the same one skip: a clone with no estate
// checkout beside it has no source to compare against, so the verbatim test
// uses `it.skipIf` and is counted as skipped rather than passing quietly.
//
// What makes this set worth having is that almost everything it guards fails
// SILENTLY. A `<use>` pointing at a symbol that is not in the sprite draws
// nothing — no error in the console, no failed request, no red anywhere; the
// page just serves seats with no marks and looks like a design choice. So the
// checks below are all aimed at that one shape: the id the view builds, the
// symbols the sprite actually carries, and the sprite reaching the page at all.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE, VENDORED, index, render } from '../scripts/vendor-estate-avatars.mjs';
import { AVATAR_KINDS, AVATAR_MARKS } from '../src/estate-avatars.generated.js';
import { loadRoster } from '../src/config.js';

const view = readFileSync(new URL('../src/view.ts', import.meta.url), 'utf8');

describe('vendored estate avatars', () => {
  const haveSource = existsSync(SOURCE);

  it.skipIf(!haveSource)('is the estate sprite verbatim', () => {
    expect(readFileSync(VENDORED, 'utf8')).toBe(render(readFileSync(SOURCE, 'utf8')));
  });

  it('carries a composed symbol for every mark at every kind', () => {
    // The view builds `crew-${mark}-${kind}` from a record it did not choose:
    // the mark is a roster key, which is instance data living in ~/.rev and
    // never in this repo. Any gap in that grid is a seat that renders without
    // a mark. Reads the vendored copy — what ships is what matters.
    const svg = readFileSync(VENDORED, 'utf8');
    const missing = AVATAR_MARKS.flatMap((m) =>
      AVATAR_KINDS.filter((k) => !svg.includes(`<symbol id="crew-${m}-${k}"`)).map((k) => `crew-${m}-${k}`),
    );
    expect(missing).toEqual([]);
  });

  it('composes a symbol at the one kind rev draws', () => {
    // The seam nothing else watches. The grid test above only compares the
    // sprite against itself, so a sprite that stopped composing `agent`
    // entirely would pass it and take every mark off this page. The kind is
    // read out of the view rather than restated here: a rename that missed
    // this file would otherwise leave the check passing on the old word.
    const kind = /const LOOP_KIND = '([a-z]+)'/.exec(view)?.[1] ?? '';
    expect(kind).not.toBe('');
    expect([...AVATAR_KINDS] as string[]).toContain(kind);
  });

  it('rests that kind on the roster refusing a loop with no constitution', () => {
    // Rev asserts `agent` for every row, which is the one thing the estate's
    // rule says not to do — so it has to rest on the record, and this is the
    // line it rests on. A loop names the profile its process runs under or it
    // does not load at all; that is what makes "every seat here is an agent" a
    // property of the roster rather than a guess from a name. If this refusal
    // is ever relaxed, LOOP_KIND has to become a read, and this goes red.
    const home = mkdtempSync(join(tmpdir(), 'rev-avatars-'));
    mkdirSync(join(home, 'work'));
    writeFileSync(
      join(home, 'roster.toml'),
      `[global]\nhelmo_cli = "x"\nhelmo_mcp_server = "y"\n` +
        `[loops.a]\nworkstream = "w"\ncwd = "${join(home, 'work')}"\nruntime = "claude"\nmodel = "m"\n`,
    );
    process.env['REV_HOME'] = home;
    expect(() => loadRoster()).toThrow(/missing 'constitution'/);
  });

  it('emits a crew mark from exactly one place, and that place emits the name too', () => {
    // The rule the avatar set ships under (H-713): a crew hue is a retrieval
    // accelerator, never an identifier, because ten members cannot have ten
    // mutually distinguishable hues. A mark must therefore never appear without
    // its name. That is enforced by there being ONE function that draws one,
    // and that function taking the name it prints — so this holds the page to
    // the shape rather than trusting whoever adds the next surface.
    const uses = [...view.matchAll(/href="#crew-/g)];
    expect(uses).toHaveLength(1);
    const body = /function actor\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(view)?.[1] ?? '';
    expect(body).toContain('href="#crew-');
    expect(body).toContain('${esc(name)}');
  });

  it('inlines the sprite into the page it serves', () => {
    // Cross-document `<use>` is not what this page does: the symbols have to be
    // in the document that references them. Drop this one interpolation and
    // every mark on the page disappears at once, with tsc clean, every other
    // test green and the view serving 200.
    //
    // Anchored inside the served template, not the file: the import alone
    // satisfies "the name appears in view.ts" while the page ships without it.
    const html = view.slice(view.indexOf('res.end(`<!doctype html>'));
    expect(html).toContain('${ESTATE_AVATARS}');
    // And after the stylesheet closes, not inside it — a sprite emitted into
    // <style> is invisible in exactly the same silent way.
    expect(html.indexOf('${ESTATE_AVATARS}')).toBeGreaterThan(html.indexOf('</style>'));
  });

  it('does not mistake the frames themselves for a mark', () => {
    // `crew-frame-agent` matches the composed id shape exactly and is not a
    // mark. Recognising a composed symbol by its body — it lays a frame under a
    // mark — is what keeps "frame" out of the mark list without this code
    // hardcoding the word.
    //
    // The fixture carries a frame at BOTH kinds on purpose. With only one, the
    // grid check would already refuse and this would be testing that instead;
    // with both, a "frame" mark slips through every other guard and shows up on
    // the page as a member nobody has ever met.
    const withFrames =
      '<svg>' +
      '<symbol id="crew-frame-agent"><path d="M0 0"/></symbol>' +
      '<symbol id="crew-frame-human"><path d="M0 0"/></symbol>' +
      '<symbol id="crew-mason-agent"><use href="#crew-frame-agent"/><use href="#crew-mason"/></symbol>' +
      '<symbol id="crew-mason-human"><use href="#crew-frame-human"/><use href="#crew-mason"/></symbol>' +
      '</svg>';
    expect(index(withFrames).marks).toEqual(['mason']);
    // And what ships agrees: a real member, and no frame.
    expect([...AVATAR_MARKS]).toContain('mason');
    expect([...AVATAR_MARKS]).not.toContain('frame');
  });

  it('refuses a sprite it can find no composed symbols in', () => {
    // An id shape that changed upstream would otherwise vendor as an empty
    // index: no marks, no error, every avatar gone.
    expect(() => index('<svg><symbol id="avatar-mason-agent"></symbol></svg>')).toThrow(/would be empty/);
  });

  it('refuses a sprite that is missing a mark at some kind', () => {
    const ragged =
      '<svg>' +
      '<symbol id="crew-mason-agent"><use href="#crew-frame-agent"/></symbol>' +
      '<symbol id="crew-mason-human"><use href="#crew-frame-human"/></symbol>' +
      '<symbol id="crew-ward-agent"><use href="#crew-frame-agent"/></symbol>' +
      '</svg>';
    expect(() => index(ragged)).toThrow(/crew-ward-human/);
  });

  it('refuses a source that cannot be vendored verbatim', () => {
    // The copy lands inside a template literal, so a backtick or `${` in the
    // source would escape it. The script stops rather than escaping — an
    // escaped copy is no longer a copy.
    //
    // The fixture is otherwise a valid sprite, so this reddens on the backtick
    // alone: given a scrap of SVG, index() would refuse first and the test
    // would pass while proving nothing about this refusal.
    const ok =
      '<svg>' +
      '<symbol id="crew-mason-agent"><use href="#crew-frame-agent"/></symbol>' +
      '<symbol id="crew-mason-human"><use href="#crew-frame-human"/></symbol>' +
      '</svg>';
    expect(() => render(ok)).not.toThrow();
    expect(() => render(ok.replace('<svg>', '<svg><!-- ` -->'))).toThrow(/should not/);
    expect(() => render(ok.replace('<svg>', '<svg><!-- ${1} -->'))).toThrow(/should not/);
  });
});
