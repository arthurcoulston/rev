import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const HELMO_ROOT = resolve(
  process.env['REV_TEST_HELMO'] ?? join(import.meta.dirname, '..', '..', 'helmo'),
);
export const HELMO_CLI = join(HELMO_ROOT, 'dist', 'cli.js');
export const HELMO_SERVER = join(HELMO_ROOT, 'dist', 'server.js');

for (const file of [HELMO_CLI, HELMO_SERVER]) {
  if (!existsSync(file)) {
    throw new Error(
      `Rev's integration tests require a built Helmo checkout. Set REV_TEST_HELMO to its root; missing ${file}`,
    );
  }
}
