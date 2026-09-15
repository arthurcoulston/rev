import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const HELMO_ROOT = resolve(
  process.env['REV_TEST_HELMO'] ?? join(import.meta.dirname, '..', '..', 'helmo'),
);
export const HELMO_CLI = join(HELMO_ROOT, 'dist', 'cli.js');
export const HELMO_SERVER = join(HELMO_ROOT, 'dist', 'server.js');
// The supervisor e2e opens the store directly to assert what the loops wrote.
// It must come from the same checkout HELMO_ROOT names: a hard-coded sibling
// path silently ignored REV_TEST_HELMO, so that one suite still demanded a
// ../helmo directory and no scratch clone could ever run it (H-1400).
export const HELMO_STORE = join(HELMO_ROOT, 'src', 'store.ts');

for (const file of [HELMO_CLI, HELMO_SERVER, HELMO_STORE]) {
  if (!existsSync(file)) {
    throw new Error(
      `Rev's integration tests require a built Helmo checkout. Set REV_TEST_HELMO to its root; missing ${file}`,
    );
  }
}
