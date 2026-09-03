// The vendored estate design tokens (R-11 H-714). src/estate-tokens.generated.ts
// is a copy of a file another repo owns, so the only thing that can go wrong
// here is the copy going stale — and it would go stale invisibly, because a
// stale copy still compiles and still renders a page.
//
// One test here is allowed to skip, and that is the interesting part. Rev is
// published standalone: a clone with no estate checkout beside it has no source
// to compare against, and failing there would make the product depend on a repo
// it is not allowed to depend on. So the skip is deliberate — but it must be
// visible, because a check that quietly passes when its input is missing is a
// check that can never go red. `it.skipIf` is what makes it visible: the run
// summary counts it as skipped rather than passed. An early `return` with a
// console.log does NOT — vitest swallows console output from a passing test,
// which was measured on the Helmo adoption, not assumed.
//
// The run that matters is Arthur's machine and estate CI, where the sibling
// checkout exists. The other tests never skip: they read the vendored copy and
// the view alone, which are the files that actually ship.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { SOURCE, VENDORED, render } from '../scripts/vendor-estate-tokens.mjs';

const view = () => readFileSync(new URL('../src/view.ts', import.meta.url), 'utf8');

describe('vendored estate tokens', () => {
  const haveSource = existsSync(SOURCE);

  it.skipIf(!haveSource)('is the estate token file verbatim', () => {
    expect(readFileSync(VENDORED, 'utf8')).toBe(render(readFileSync(SOURCE, 'utf8')));
  });

  it('carries the SURFACE tokens under prefers-color-scheme, not on a class alone', () => {
    // The view has no theme switch, so this is the line between "adopted the
    // tokens" and "adopted the light half of the tokens and wore it at night".
    // It reads the vendored copy, not the source: what ships is what matters.
    //
    // The assertion has to name the block, not just count media queries. The
    // token file emits two of them — the surfaces and, since H-713, the crew
    // mark hues — so "a prefers-color-scheme block exists somewhere, and
    // --background is declared somewhere" is satisfied by the hues alone while
    // the surfaces quietly lose their dark half. `[^}]*` is what pins it: it
    // cannot leave the `:root:not(.light)` rule it started in.
    const css = readFileSync(VENDORED, 'utf8');
    const darkBlocks = css.split(/@media \(prefers-color-scheme: dark\) \{/).slice(1);
    expect(
      darkBlocks.some((b) => /^\s*:root:not\(\.light\) \{[^}]*--background: [^;]+;/.test(b)),
    ).toBe(true);
  });

  it('has no seam alias that resolves to itself', () => {
    // The seam is a block of `--ours: var(--theirs)` aliases, and a careless
    // rewrite turns one into `--ours: var(--ours)`. CSS calls that
    // guaranteed-invalid: the property ends up with no value at all, every
    // rule using it is dropped, and nothing anywhere goes red — the page just
    // quietly loses its borders. That happened adopting these tokens in the
    // roadmap, and only sampling pixels out of the render caught it.
    const selfRefs = [...view().matchAll(/--([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)/g)]
      .filter((m) => m[1] === m[2])
      .map((m) => m[0]);
    expect(selfRefs).toEqual([]);
  });

  it('leaves no bare hex outside the token declarations', () => {
    // Rev's page had fifteen hard-coded greys and status colours before
    // adoption and no dark half at all, so a colour left behind here is not a
    // style nit: it is a value that was tuned for white and will be rendered
    // on near-black. tsc cannot see it and the page still loads. So: hexes are
    // allowed only where the tokens are declared — the :root block and its
    // dark override — and nowhere in a rule below the seam.
    const css = view().slice(view().indexOf('<style>'), view().indexOf('</style>'));
    // Comments last: a hex named in prose renders nothing, and the notes below
    // the seam cite the values they replaced.
    const belowSeam = css.slice(css.lastIndexOf('} }') + 3).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(belowSeam.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
  });

  it('refuses a source that cannot be vendored verbatim', () => {
    // The copy lands inside a template literal. A backtick or `${` in the
    // source would escape it, so the script stops instead of escaping — an
    // escaped copy is no longer a copy.
    expect(() => render(':root { --x: `; }')).toThrow(/should not/);
    expect(() => render(':root { --x: ${1}; }')).toThrow(/should not/);
  });
});
