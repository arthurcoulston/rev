import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VIEW = join(import.meta.dirname, '..', 'src', 'view.ts');
const reasons = {
  empty: 'no executable work is owned by this seat or ready in its watched scope',
  held: "2 tickets remain in this seat's hands, but none is executable",
  untouched: '1 executable ticket remained after an iteration made no advancing change',
};

let home: string;
let child: ChildProcess;
let origin: string;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function request(path: string): Promise<Response> {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return await fetch(`${origin}${path}`);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'rev-view-'));
  writeFileSync(join(home, 'roster.toml'), `[global]
helmo_cli = "/tmp/helmo-cli"
helmo_mcp_server = "/tmp/helmo-server"

[loops.empty]
workstream = "test"
cwd = "/tmp"
runtime = "mock"
model = "mock"

[loops.held]
workstream = "test"
cwd = "/tmp"
runtime = "mock"
model = "mock"

[loops.untouched]
workstream = "test"
cwd = "/tmp"
runtime = "mock"
model = "mock"
`);
  Object.entries(reasons).forEach(([name, reason], index) => {
    const state = join(home, 'state', name);
    mkdirSync(state, { recursive: true });
    // A legacy pid-only RUNNING stamp remains valid. Distinct cursor values
    // prove the reason reader ignores the compatible first line.
    writeFileSync(join(state, 'RUNNING'), `${process.pid}\n`);
    writeFileSync(join(state, 'IDLE'), `${[0, 42, 999][index]}\n${reason}\n`);
  });

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  child = spawn('npx', ['tsx', VIEW], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, REV_HOME: home, REV_VIEW_PORT: String(port) },
    stdio: 'ignore',
  });
  await request('/health.json');
});

afterAll(() => {
  child?.kill('SIGTERM');
  rmSync(home, { recursive: true, force: true });
});

describe('view idle reasons (H-954)', () => {
  it('presents all three bounded reasons in the HTML view', async () => {
    const html = await (await request('/')).text();
    for (const reason of Object.values(reasons)) expect(html).toContain(reason);
  });

  it('presents all three bounded reasons in /health.json', async () => {
    const body = await (await request('/health.json')).json() as {
      loops: Array<{ name: string; state: string; reason?: string }>;
    };
    expect(body.loops.map(({ name, state, reason }) => ({ name, state, reason }))).toEqual([
      { name: 'empty', state: 'IDLE', reason: reasons.empty },
      { name: 'held', state: 'IDLE', reason: reasons.held },
      { name: 'untouched', state: 'IDLE', reason: reasons.untouched },
    ]);
  });
});
