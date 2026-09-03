#!/usr/bin/env node
/* Vendors the estate's crew avatar sprite into src/estate-avatars.generated.ts
   (R-11 H-714).

   Same seam as scripts/vendor-estate-tokens.mjs and for the same reason: rev
   is published standalone and stays free of estate imports, so it copies the
   asset in rather than reaching for a sibling checkout at runtime.
   The estate's own DEV.md names this as the supported path for a product view
   — inline the sprite, then `<use href="#crew-mason-agent">`.

   The copy is verbatim. What is derived is only the *index*: MARKS and KINDS
   are parsed back out of the composed symbol ids that are actually in the
   sprite, so this file can never claim a mark the sprite does not carry. That
   matters because the failure it prevents is silent — a `<use>` pointing at a
   missing symbol renders nothing at all, no error anywhere.

   Usage:
     node scripts/vendor-estate-avatars.mjs           # refresh the copy
     node scripts/vendor-estate-avatars.mjs --check   # exit 1 on drift

   ESTATE_AVATARS_SVG overrides the source path; it defaults to the sibling
   checkout. --check with no source present exits 2 and says so — a check that
   goes quiet when its input is missing is the one shape that can never go red.
   The test that wraps it (test/estate-avatars.test.ts) is the thing allowed to
   skip, and it skips aloud.
*/

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SOURCE =
  process.env.ESTATE_AVATARS_SVG ??
  join(ROOT, '..', 'estate', 'avatars', 'crew-avatars.svg');
export const VENDORED = join(ROOT, 'src', 'estate-avatars.generated.ts');

/** Marks and kinds, read from the composed `crew-<mark>-<kind>` symbols.
 *  Deriving both from the same symbols is what makes the pair consistent by
 *  construction: a kind the sprite stopped composing disappears from KINDS
 *  rather than staying in a list that no longer matches the asset.
 *
 *  "Composed" is recognised by structure, not by name: a composed symbol lays
 *  a frame under a mark, so its body carries a `<use>` of `#crew-frame-*`. The
 *  frame symbols themselves are `crew-frame-agent` and `crew-frame-human`,
 *  which match the id shape exactly and are not marks — reading the body is
 *  what tells them apart without this file hardcoding the word "frame". */
export function index(svg) {
  const marks = new Set();
  const kinds = new Set();
  for (const [, mark, kind, body] of svg.matchAll(
    /<symbol id="crew-([a-z0-9]+)-([a-z]+)"[^>]*>([\s\S]*?)<\/symbol>/g,
  )) {
    if (!body.includes('href="#crew-frame-')) continue;
    marks.add(mark);
    kinds.add(kind);
  }
  // A sprite whose symbols no longer match this shape would vendor as an empty
  // index and take every avatar off the page without failing anything.
  // Refusing is the difference between a loud break and a quiet one.
  if (!marks.size)
    throw new Error(
      'no composed crew-<mark>-<kind> symbols in the estate sprite — its shape changed, ' +
        'so the index this file exports would be empty and every avatar would silently vanish',
    );
  // The index is used as a cross product: the view builds `crew-${mark}-${kind}`
  // for whatever kind the record holds. A ragged sprite would let that name a
  // symbol that is not there, and a `<use>` of a missing symbol draws nothing
  // and reports nothing.
  const missing = [];
  for (const mark of marks)
    for (const kind of kinds)
      if (!svg.includes(`<symbol id="crew-${mark}-${kind}"`)) missing.push(`crew-${mark}-${kind}`);
  if (missing.length)
    throw new Error(
      `estate sprite is missing composed symbols ${missing.join(', ')} — every mark must be ` +
        `composed at every kind, because the view names one from a record it did not choose`,
    );
  return { marks: [...marks].sort(), kinds: [...kinds].sort() };
}

/** The vendored module's exact contents for a given sprite. */
export function render(svg) {
  // Same refusal as the token vendor: the copy lands in a template literal,
  // and an escaped copy is no longer verbatim. A generated SVG has no business
  // holding either of these.
  const bad = /[`]|\$\{/.exec(svg);
  if (bad)
    throw new Error(
      `estate avatar sprite holds ${JSON.stringify(bad[0])} at index ${bad.index} — ` +
        `an SVG should not, and vendoring it as a template literal cannot be verbatim if it does`,
    );
  const { marks, kinds } = index(svg);
  const list = (xs) => xs.map((x) => JSON.stringify(x)).join(', ');
  return [
    '// VENDORED — do not edit. Source: the estate repo, avatars/crew-avatars.svg',
    '// Refresh: node scripts/vendor-estate-avatars.mjs',
    '// Drift is a test failure: npm test (skipped, loudly, with no estate checkout)',
    '//',
    '// The estate shell is the source of the visual system every estate surface',
    '// shares (R-11); rev consumes it as a copy so it stays publishable alone.',
    '// Hues come from the vendored token file — a mark is currentColor',
    '// over var(--crew-<name>), so nothing here carries a colour of its own.',
    '',
    'export const ESTATE_AVATARS = `',
    svg.trimEnd(),
    '`;',
    '',
    '/** Marks the sprite carries. Read out of the sprite, never hand-listed. */',
    `export const AVATAR_MARKS = [${list(marks)}] as const;`,
    '',
    '/** Actor kinds the sprite composes a symbol for. */',
    `export const AVATAR_KINDS = [${list(kinds)}] as const;`,
    '',
  ].join('\n');
}

function run() {
  const check = process.argv.includes('--check');
  let svg;
  try {
    svg = readFileSync(SOURCE, 'utf8');
  } catch {
    console.error(`no estate avatar sprite at ${SOURCE} — set ESTATE_AVATARS_SVG or clone the estate repo alongside rev`);
    process.exit(2);
  }
  const want = render(svg);
  if (!check) {
    writeFileSync(VENDORED, want);
    console.log(`wrote src/estate-avatars.generated.ts from ${SOURCE}`);
    return;
  }
  let have = null;
  try {
    have = readFileSync(VENDORED, 'utf8');
  } catch {
    /* missing counts as drift */
  }
  if (have === want) {
    console.log('ok    src/estate-avatars.generated.ts');
    return;
  }
  console.error(
    `DRIFT src/estate-avatars.generated.ts — ${have === null ? 'missing' : 'stale'}; ` +
      `run node scripts/vendor-estate-avatars.mjs`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) run();
