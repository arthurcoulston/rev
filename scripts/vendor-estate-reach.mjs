#!/usr/bin/env node
/* Vendors the estate's reach table into src/estate-reach.generated.ts
   (R-11 H-832).

   Third vendored artifact, same seam as scripts/vendor-estate-{tokens,avatars}
   and for the same reason: rev is published standalone and holds no import of
   a sibling repo, so what it needs from the estate it copies in.

   WHAT IS COPIED, AND WHY IT IS NOT AN ADDRESS. A surface has two true
   addresses — `url`, the product on its own port, correct at the desk and dead
   from anywhere else; and the same-origin path the estate shell composes it
   at, correct through the Mac's LAN address and through the tunnel alike. The
   registry decides the prefix once and no service hand-keeps an address of its
   own (services.json, "_reach"), so rev vendors the PAIR for every navigable
   surface and picks between them in the browser, where the reader's origin is
   the only thing that can answer. Rev's own cross-link to Helm was
   `http://localhost:4400` until this ticket: perfect at the desk, dead on the
   phone the composed view was built for.

   The copy is derived, not verbatim — a registry entry carries a plist path, a
   log path and an expectation rev has no business holding. What it must not do
   is invent: the path comes from the registry's own rule, `reach` + id, and a
   registry that stopped declaring a prefix refuses to vendor rather than
   emitting a table of localhost addresses that look fine on this Mac.

   Usage:
     node scripts/vendor-estate-reach.mjs           # refresh the copy
     node scripts/vendor-estate-reach.mjs --check   # exit 1 on drift

   ESTATE_REGISTRY overrides the source path; it defaults to the sibling
   checkout. --check with no source present exits 2 and says so — a check that
   goes quiet when its input is missing is the one shape that can never go red.
   The test that wraps it (test/estate-reach.test.ts) is the thing allowed to
   skip, and it skips aloud.
*/

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SOURCE =
  process.env.ESTATE_REGISTRY ??
  join(ROOT, '..', 'crew', 'tools', 'estate', 'services.json');
export const VENDORED = join(ROOT, 'src', 'estate-reach.generated.ts');

/** The reach table for a parsed registry: every navigable surface's two
 *  addresses, keyed by id.
 *
 *  The path rule is the registry's, restated in the registry's own terms: the
 *  declared prefix plus the id, unless the service states a `reach` of its own
 *  — the shell does, because it is the origin the others are reached THROUGH.
 *  The same rule lives in estate/tools/generate.mjs and
 *  crew/tools/estate/registry.mjs; all three read the prefix out of the file
 *  rather than spelling it, which is what keeps a change to it a one-line
 *  change in one place. */
export function table(reg) {
  const prefix = reg?.reach;
  if (typeof prefix !== 'string' || !prefix.startsWith('/') || !prefix.endsWith('/'))
    throw new Error(
      'the estate registry declares no `reach` prefix (a leading and trailing slash) — ' +
        'see "_reach" in services.json; without it every link here would be a localhost ' +
        'address, which is exactly the defect this file exists to end',
    );
  const surfaces = (reg.services ?? []).filter((s) => s.nav && s.url);
  // An empty table compiles, renders, and links nowhere — the silent shape.
  if (!surfaces.length)
    throw new Error('the estate registry has no navigable surface with a `url` — nothing to vendor');
  return Object.fromEntries(
    surfaces.map((s) => [s.id, { url: s.url, path: s.reach ?? `${prefix}${s.id}/` }]),
  );
}

/** The vendored module's exact contents for a given registry file. */
export function render(json) {
  const entries = Object.entries(table(JSON.parse(json)));
  return [
    '// VENDORED — do not edit. Source: the crew repo, tools/estate/services.json',
    '// Refresh: node scripts/vendor-estate-reach.mjs',
    '// Drift is a test failure: npm test (skipped, loudly, with no crew checkout)',
    '//',
    '// Where each estate surface is reached: `url` is the product on its own',
    '// port, right at the desk and dead from anywhere else; `path` is the',
    '// same-origin path the estate shell composes it at (R-11). Which one a',
    '// link should use is a property of the reader’s origin, so it is asked',
    '// in the browser — see src/reach.ts.',
    '',
    'export const ESTATE_REACH: Record<string, { url: string; path: string }> = {',
    ...entries.map(([id, r]) => `  ${JSON.stringify(id)}: { url: ${JSON.stringify(r.url)}, path: ${JSON.stringify(r.path)} },`),
    '};',
    '',
  ].join('\n');
}

function run() {
  const check = process.argv.includes('--check');
  let json;
  try {
    json = readFileSync(SOURCE, 'utf8');
  } catch {
    console.error(`no estate registry at ${SOURCE} — set ESTATE_REGISTRY or clone the crew repo alongside rev`);
    process.exit(2);
  }
  const want = render(json);
  if (!check) {
    writeFileSync(VENDORED, want);
    console.log(`wrote src/estate-reach.generated.ts from ${SOURCE}`);
    return;
  }
  let have = null;
  try {
    have = readFileSync(VENDORED, 'utf8');
  } catch {
    /* missing counts as drift */
  }
  if (have === want) {
    console.log('ok    src/estate-reach.generated.ts');
    return;
  }
  console.error(
    `DRIFT src/estate-reach.generated.ts — ${have === null ? 'missing' : 'stale'}; ` +
      `run node scripts/vendor-estate-reach.mjs`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) run();
