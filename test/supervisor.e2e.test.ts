// End-to-end for the v1 fleet: a real supervisor process over mock-runtime
// loops against a real (temp) Helm store. Proves: general start runs the whole
// roster; a SIGKILLed loop comes back through the backoff; STOP is honored
// until resume, then picked up without touching the supervisor; `rev stop`
// drains the machine to a clean exit.
import { describe, it, expect } from 'vitest';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELM = join(import.meta.dirname, '..', '..', 'helmo');
const HELM_CLI = join(HELM, 'dist', 'cli.js');
const REV_CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

interface Env {
  home: string;
  env: NodeJS.ProcessEnv;
}

function setup(loopsToml: string): Env {
  const home = mkdtempSync(join(tmpdir(), 'rev-fleet-'));
  const db = join(home, 'helm.db');
  writeFileSync(
    join(home, 'roster.toml'),
    `[global]
helmo_cli = "${HELM_CLI}"
helmo_mcp_server = "${join(HELM, 'dist', 'server.js')}"
helmo_db = "${db}"
poll_seconds = 1
respawn_backoff_seconds = 1
respawn_backoff_cap_seconds = 4
${loopsToml}`,
  );
  return { home, env: { ...process.env, REV_HOME: home, HELMO_DB: db } };
}

function helm(e: Env, args: string[], actor = '{"name":"seeder","kind":"agent","model":"t","version":"0"}'): Record<string, unknown> {
  return JSON.parse(
    execFileSync('node', [HELM_CLI, ...args], { env: { ...e.env, HELMO_ACTOR: actor }, encoding: 'utf8' }),
  ) as Record<string, unknown>;
}

function rev(e: Env, args: string[]): string {
  return execFileSync('npx', ['tsx', REV_CLI, ...args], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });
}

function startFleet(e: Env): { proc: ChildProcess; out: () => string } {
  let buf = '';
  const proc = spawn('npx', ['tsx', REV_CLI, 'run'], { env: e.env, cwd: join(import.meta.dirname, '..') });
  proc.stdout!.on('data', (d: Buffer) => (buf += d.toString()));
  proc.stderr!.on('data', (d: Buffer) => (buf += d.toString()));
  return { proc, out: () => buf };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, timeoutMs = 20000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(200);
  }
}

function loopPid(e: Env, loop: string): number | null {
  const p = join(e.home, 'state', loop, 'RUNNING');
  if (!existsSync(p)) return null;
  const pid = parseInt(readFileSync(p, 'utf8').split('\n')[0] ?? '', 10);
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

const claimAndClose = (ws: string) => `'''
set -e
ID=$(node ${HELM_CLI} list --ready --workstream ${ws} --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -n "$ID" ]; then
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
  node ${HELM_CLI} update --ticket $ID --note "completed by mock" --status done --evidence-kind file --evidence-ref /tmp/out
fi
'''`;

describe('rev fleet e2e (supervisor over mock loops, real helm store)', () => {
  it('general start runs every roster loop; both complete their work; rev stop drains cleanly', { timeout: 60000 }, async () => {
    const e = setup(`[loops.alpha]
workstream = "ws-a"
cwd = "/tmp"
runtime = "mock"
mock_cmd = ${claimAndClose('ws-a')}

[loops.beta]
workstream = "ws-b"
cwd = "/tmp"
runtime = "mock"
mock_cmd = ${claimAndClose('ws-b')}
`);
    const a = (helm(e, ['create', '--title', 'work A', '--body', 'x', '--workstream', 'ws-a', '--type', 'ops']) as { id: string }).id;
    const b = (helm(e, ['create', '--title', 'work B', '--body', 'x', '--workstream', 'ws-b', '--type', 'ops']) as { id: string }).id;

    const { proc, out } = startFleet(e);
    try {
      await waitFor(
        () =>
          (helm(e, ['get', a]) as { status: string }).status === 'done' &&
          (helm(e, ['get', b]) as { status: string }).status === 'done',
        'both tickets done',
      );
      // Both loops settle at the cursor; child output landed in per-loop console logs.
      await waitFor(() => existsSync(join(e.home, 'state', 'alpha', 'IDLE')) && existsSync(join(e.home, 'state', 'beta', 'IDLE')), 'both loops idle');
      expect(existsSync(join(e.home, 'state', 'alpha', 'console.log'))).toBe(true);

      const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
      rev(e, ['stop']);
      expect(await exited).toBe(0);

      const sup = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(sup).toContain('fleet-start');
      expect(sup).toMatch(/spawn\s+loop=alpha/);
      expect(sup).toMatch(/spawn\s+loop=beta/);
      expect(sup).toContain('drain');
      expect(sup).toMatch(/fleet-stop\s+drained/);
      expect(out()).toContain('draining the fleet');
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('a SIGKILLed loop returns through the backoff; STOP holds until resume', { timeout: 60000 }, async () => {
    const e = setup(`[loops.solo]
workstream = "ws-solo"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`);
    const { proc } = startFleet(e);
    try {
      await waitFor(() => loopPid(e, 'solo') !== null, 'solo loop up');
      const pid1 = loopPid(e, 'solo')!;

      // Crash it: the supervisor must notice, mark BACKOFF, and respawn.
      process.kill(pid1, 'SIGKILL');
      await waitFor(() => {
        const p = loopPid(e, 'solo');
        return p !== null && p !== pid1;
      }, 'respawn with a new pid');
      const sup1 = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(sup1).toMatch(/exit\s+loop=solo code=null .*action=respawn/);

      // STOP: the loop exits and stays down — the supervisor waits for clearance.
      rev(e, ['stop', 'solo']);
      await waitFor(() => loopPid(e, 'solo') === null, 'solo halted');
      await sleep(3000); // several polls: it must NOT come back on its own
      expect(loopPid(e, 'solo')).toBe(null);

      // Resume: the running supervisor picks it back up, no rev run needed.
      rev(e, ['resume', 'solo']);
      await waitFor(() => loopPid(e, 'solo') !== null, 'picked up after resume');
    } finally {
      proc.kill('SIGKILL');
    }
  });
});
