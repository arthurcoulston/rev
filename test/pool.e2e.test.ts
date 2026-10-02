// Pool workers (H-574): several roster loops sharing one accountable seat,
// each launching only on a ticket Helmo claimed for it atomically. Real store,
// real helm-cli, mock runtime — the claim race, the binding of a session to
// its ticket, and every path that must put a claim back down.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELMO_CLI as HELM_CLI, HELMO_SERVER, HELMO_STORE } from './helmo.js';

const { Store } = await import(HELMO_STORE);

const REV_CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

interface Env { home: string; db: string; env: NodeJS.ProcessEnv }

// The bound ticket is read back out of the prompt, which is the only place a
// real model session learns it.
const BOUND = `T=$(printf '%s' "$REV_PROMPT" | grep -o 'claimed ticket H-[0-9]*' | grep -o 'H-[0-9]*'); echo "$REV_LOOP $T" >> $REV_HOME/bound`;
const FINISH = `node ${HELM_CLI} update --ticket $T --note "done by $REV_LOOP" --status done --evidence-kind other --evidence-ref pool`;

function worker(name: string, home: string, mock: string, extra = ''): string {
  return `[loops.${name}]
seat = "builder"
workstream = "rev-test"
cwd = "${join(home, name)}"
runtime = "mock"
mock_cmd = '''
${mock}
'''
${extra}`;
}

function setup(loops: (home: string) => string, cli = HELM_CLI): Env {
  const home = mkdtempSync(join(tmpdir(), 'rev-pool-'));
  const db = join(home, 'helm.db');
  for (const w of ['w1', 'w2']) mkdirSync(join(home, w), { recursive: true });
  writeFileSync(join(home, 'roster.toml'), `[global]
helmo_cli = "${cli}"
helmo_mcp_server = "${HELMO_SERVER}"
helmo_db = "${db}"
poll_seconds = 0.1
fail_cap = 1
wedge_cap = 3
usage_poll_seconds = 0
${loops(home)}`);
  return { home, db, env: { ...process.env, REV_HOME: home, HELMO_DB: db } };
}

function helm(e: Env, args: string[]): Record<string, unknown> {
  return JSON.parse(execFileSync('node', [HELM_CLI, ...args], {
    env: { ...e.env, HELMO_ACTOR: '{"name":"seeder","kind":"agent","model":"t","version":"0"}' }, encoding: 'utf8',
  })) as Record<string, unknown>;
}

// helm-cli has no --project flag on create, so a lane's ticket is filed
// through the store itself.
function seed(e: Env, title: string, project?: string): string {
  if (!project) return (helm(e, ['create', '--title', title, '--body', 'pool work', '--workstream', 'rev-test', '--type', 'ops']) as { id: string }).id;
  const store = new Store(e.db);
  try {
    return store.createTicket({ name: 'seeder', kind: 'agent', model: 't', version: '0' }, { title, body: 'pool work', workstream: 'rev-test', type: 'ops', project }).id;
  } finally { store.close?.(); }
}

function ticket(e: Env, id: string): { status: string; assignee: string | null } {
  return helm(e, ['get', id]) as { status: string; assignee: string | null };
}

function runAsync(e: Env, loop: string): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', REV_CLI, 'run', loop, '--count', '1'], { env: e.env, cwd: join(import.meta.dirname, '..'), stdio: 'ignore' });
}

const exited = (child: ChildProcess) => new Promise<void>((r) => (child.exitCode !== null ? r() : child.once('exit', () => r())));

function events(e: Env, loop: string): string {
  const f = join(e.home, 'state', loop, 'events.log');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

function journal(e: Env, loop: string): Record<string, unknown>[] {
  const dir = join(e.home, 'state', loop, 'launches');
  return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, unknown>);
}

async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (!check()) throw new Error('condition never held');
}

describe('pool workers on one seat (H-574)', { timeout: 60000 }, () => {
  it('two workers launched together each claim, are told, and finish a different ticket', async () => {
    // The sessions overlap on purpose: each waits until both have started, so
    // a pass here is two live sessions on one seat, not two in a row.
    const both = `${BOUND}; touch $REV_HOME/started-$REV_LOOP; for i in $(seq 100); do [ -f $REV_HOME/started-w1 ] && [ -f $REV_HOME/started-w2 ] && break; sleep 0.1; done; [ -f $REV_HOME/started-w1 ] && [ -f $REV_HOME/started-w2 ] && echo overlapped >> $REV_HOME/overlap; ${FINISH}`;
    const e = setup((h) => worker('w1', h, both) + worker('w2', h, both));
    const a = seed(e, 'First pool ticket');
    const b = seed(e, 'Second pool ticket');

    const kids = [runAsync(e, 'w1'), runAsync(e, 'w2')];
    await Promise.all(kids.map(exited));

    const bound = readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n').map((l) => l.split(' '));
    expect(bound).toHaveLength(2);
    expect(new Set(bound.map(([, t]) => t))).toEqual(new Set([a, b]));
    expect(new Set(bound.map(([w]) => w))).toEqual(new Set(['w1', 'w2']));
    expect(readFileSync(join(e.home, 'overlap'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(ticket(e, a).status).toBe('done');
    expect(ticket(e, b).status).toBe('done');
    for (const w of ['w1', 'w2']) {
      expect(events(e, w)).toMatch(/launch-claimed\s+claimed H-\d+/);
      expect(journal(e, w)).toEqual([expect.objectContaining({ phase: 'complete', claim: true, ticket_id: expect.stringMatching(/^H-\d+$/) })]);
    }
    // Helmo recorded each claim against the worker that took it: each worker
    // session touched exactly the ticket it was told.
    for (const [w, t] of bound) {
      const touched = (helm(e, ['actor-tickets', '--name', 'builder', '--session', `rev:${w}`, '--since-seq', '0']) as { tickets: { id: string }[] }).tickets;
      expect(touched.map((x) => x.id)).toEqual([t]);
    }
  });

  it('a worker that finds the only ticket taken idles without spending a session', async () => {
    const slow = `${BOUND}; sleep 1; ${FINISH}`;
    const e = setup((h) => worker('w1', h, slow) + worker('w2', h, slow));
    const only = seed(e, 'The only ticket');

    const kids = [runAsync(e, 'w1'), runAsync(e, 'w2')];
    await Promise.all(kids.map(exited));

    expect(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(ticket(e, only).status).toBe('done');
    const idle = ['w1', 'w2'].filter((w) => /launch-idle\s+nothing ready to claim/.test(events(e, w)));
    expect(idle).toHaveLength(1);
    expect(events(e, idle[0]!)).not.toMatch(/run-start/);
  });

  it('puts a claim back on the seat when the session ends without settling it', () => {
    // The session works the ticket and stops mid-way, leaving it in progress.
    const e = setup((h) => worker('w1', h, `${BOUND}; node ${HELM_CLI} update --ticket $T --note "partial progress"; exit 1`) + worker('w2', h, 'true'));
    const id = seed(e, 'Unfinished work');

    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    expect(ticket(e, id)).toMatchObject({ status: 'open', assignee: 'builder' });
    expect(events(e, 'w1')).toMatch(new RegExp(`claim-released\\s+${id} session ended failure`));
    expect(journal(e, 'w1')).toEqual([expect.objectContaining({ phase: 'quarantined', ticket_id: id })]);
  });

  it('releases the claim a killed worker held, and the next launch picks it up again', async () => {
    const e = setup((h) => worker('w1', h, `${BOUND}; touch $REV_HOME/model-started; [ -f $REV_HOME/second ] || sleep 30; ${FINISH}`) + worker('w2', h, 'true'));
    const id = seed(e, 'Work interrupted by a crash');

    const child = runAsync(e, 'w1');
    await waitFor(() => existsSync(join(e.home, 'model-started')));
    expect(ticket(e, id).status).toBe('in_progress');
    const loopPid = Number(/loop-start\s+pid=(\d+)/.exec(events(e, 'w1'))![1]);
    process.kill(loopPid, 'SIGKILL');
    child.kill('SIGKILL');
    await exited(child);
    writeFileSync(join(e.home, 'second'), '');

    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    const log = events(e, 'w1');
    expect(log).toMatch(new RegExp(`claim-released\\s+${id} recovered dispatching`));
    expect(log).toMatch(/launch-quarantined.*recovered dispatching/);
    expect(ticket(e, id).status).toBe('done');
    expect(readFileSync(join(e.home, 'bound'), 'utf8').trim().split('\n')).toEqual([`w1 ${id}`, `w1 ${id}`]);
  });

  it('claims only inside its project lane', () => {
    const e = setup((h) => worker('w1', h, `${BOUND}; ${FINISH}`, 'project = "R-lane"\n') + worker('w2', h, 'true'));
    const outside = seed(e, 'Outside the lane');
    const inside = seed(e, 'Inside the lane', 'R-lane');

    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    expect(readFileSync(join(e.home, 'bound'), 'utf8').trim()).toBe(`w1 ${inside}`);
    expect(ticket(e, outside).status).toBe('open');
  });

  it('refuses to launch against a store with no launch-claim, leaving the ticket untouched', () => {
    // An installation that predates the command answers with its usage text.
    const home = mkdtempSync(join(tmpdir(), 'rev-pool-old-'));
    const proxy = join(home, 'old-helmo.mjs');
    writeFileSync(proxy, `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === 'launch-claim') { process.stderr.write('usage: helmo-cli <command> [flags]\\n'); process.exit(1); }
const r = spawnSync(process.execPath, [${JSON.stringify(HELM_CLI)}, ...args], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
`);
    const e = setup((h) => worker('w1', h, `touch $REV_HOME/session-launched`) + worker('w2', h, 'true'), proxy);
    const id = seed(e, 'Must not be raced');

    execFileSync('npx', ['tsx', REV_CLI, 'run', 'w1', '--count', '1'], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });

    expect(existsSync(join(e.home, 'session-launched'))).toBe(false);
    expect(events(e, 'w1')).toMatch(/launch-denied\s+this store has no launch-claim command/);
    expect(ticket(e, id).status).toBe('open');
  });
});
