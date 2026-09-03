#!/usr/bin/env node
/* Vendors the estate's design tokens into src/estate-tokens.generated.ts
   (R-11 H-714).

   Rev is published standalone and its view is a single zero-dependency file,
   so it cannot import a stylesheet from a sibling repo at runtime and cannot
   grow a CSS build step. Vendoring is the whole seam: a copy of the token file
   is checked in as a TypeScript string, the view inlines it, and a clone with
   no estate checkout anywhere near it builds and runs unchanged.

   The copy is verbatim. Nothing here rewrites selectors or values — the
   estate's generator already emits the shape a page with no theme switch
   needs (`:root, .light`, `.dark`, and the same dark values under
   `prefers-color-scheme`). If a future token file needs translating to be
   usable here, that is a change to make THERE, once, not four times in four
   products.

   Usage:
     node scripts/vendor-estate-tokens.mjs            # refresh the copy
     node scripts/vendor-estate-tokens.mjs --check     # exit 1 on drift

   ESTATE_TOKENS_CSS overrides the source path; it defaults to the sibling
   checkout. --check with no source present is not a pass — it exits 2 and
   says so, because a check that goes quiet when its input is missing is the
   one shape that can never go red. The test that wraps it (test/
   estate-tokens.test.ts) is the thing allowed to skip, and it says so aloud.
*/

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SOURCE =
  process.env.ESTATE_TOKENS_CSS ??
  join(ROOT, '..', 'estate', 'tokens', 'estate-tokens.css');
export const VENDORED = join(ROOT, 'src', 'estate-tokens.generated.ts');

/** The vendored module's exact contents for a given token stylesheet. */
export function render(css) {
  // A backtick or `${` in the source would break out of the template literal
  // and, worse, could execute. Neither belongs in a CSS custom-property file,
  // so refuse rather than escape: an escaped copy is no longer verbatim, and
  // the source is a generated file whose shape we get to insist on.
  const bad = /[`]|\$\{/.exec(css);
  if (bad)
    throw new Error(
      `estate token file holds ${JSON.stringify(bad[0])} at index ${bad.index} — ` +
        `a CSS custom-property file should not, and vendoring it as a template ` +
        `literal cannot be verbatim if it does`,
    );
  return [
    '// VENDORED — do not edit. Source: the estate repo, tokens/estate-tokens.css',
    '// Refresh: node scripts/vendor-estate-tokens.mjs',
    '// Drift is a test failure: npm test (skipped, loudly, with no estate checkout)',
    '//',
    '// The estate shell is the source of the visual system every estate surface',
    '// shares (R-11); rev consumes it as a copy so it stays publishable alone.',
    '',
    'export const ESTATE_TOKENS = `',
    css.trimEnd(),
    '`;',
    '',
  ].join('\n');
}

function run() {
  const check = process.argv.includes('--check');
  let css;
  try {
    css = readFileSync(SOURCE, 'utf8');
  } catch {
    console.error(`no estate token file at ${SOURCE} — set ESTATE_TOKENS_CSS or clone the estate repo alongside rev`);
    process.exit(2);
  }
  const want = render(css);
  if (!check) {
    writeFileSync(VENDORED, want);
    console.log(`wrote src/estate-tokens.generated.ts from ${SOURCE}`);
    return;
  }
  let have = null;
  try {
    have = readFileSync(VENDORED, 'utf8');
  } catch {
    /* missing counts as drift */
  }
  if (have === want) {
    console.log('ok    src/estate-tokens.generated.ts');
    return;
  }
  console.error(
    `DRIFT src/estate-tokens.generated.ts — ${have === null ? 'missing' : 'stale'}; ` +
      `run node scripts/vendor-estate-tokens.mjs`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) run();
