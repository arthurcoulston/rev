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
import { HELMO_CLI as HELM_CLI, HELMO_SERVER } from './helmo.js';
import { Store } from '../../helmo/src/store.js';

const REV_CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

interface Env {
  home: string;
  env: NodeJS.ProcessEnv;
}

function setup(loopsToml: string, extraGlobal = ''): Env {
  const home = mkdtempSync(join(tmpdir(), 'rev-fleet-'));
  const db = join(home, 'helm.db');
  writeFileSync(
    join(home, 'roster.toml'),
    `[global]
helmo_cli = "${HELM_CLI}"
helmo_mcp_server = "${HELMO_SERVER}"
helmo_db = "${db}"
poll_seconds = 1
respawn_backoff_seconds = 1
respawn_backoff_cap_seconds = 4
min_uptime_seconds = 1
${extraGlobal}
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

function answerResume(e: Env, ticketId: string): void {
  const store = new Store(join(e.home, 'helm.db'));
  try {
    store.answerTicket(
      { name: 'Arthur', kind: 'human' },
      ticketId,
      { answer: 'Resume this loop once.', chosen_option: 'resume', resolution: 'resume' },
    );
  } finally {
    store.close();
  }
}

function answerInvestigate(e: Env, ticketId: string): void {
  const store = new Store(join(e.home, 'helm.db'));
  try {
    store.answerTicket(
      { name: 'Arthur', kind: 'human', session: 'dashboard' },
      ticketId,
      {
        answer: 'Ratified from the dashboard',
        chosen_option: 'investigate — consecutive failures usually mean something real',
        resolution: 'resume',
      },
    );
  } finally {
    store.close();
  }
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

  it('turns a human resume answer into a healthy running loop and closes the escalation (H-1038)', { timeout: 60000 }, async () => {
    const e = setup(`[loops.resume-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
continue_cap = 1
mock_cmd = '''
if [ -f "$REV_HOME/resume-succeeds" ]; then exit 0; fi
ID=$(node ${HELM_CLI} list --assignee resume-loop --status in_progress --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -z "$ID" ]; then
  ID=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
fi
node ${HELM_CLI} update --ticket $ID --note "kept producing" --evidence-kind other --evidence-ref burn
'''
`);
    helm(e, ['create', '--title', 'work that burns', '--body', 'x', '--workstream', 'rev-test', '--type', 'ops']);
    const { proc } = startFleet(e);
    try {
      await waitFor(() => existsSync(join(e.home, 'state', 'resume-loop', 'BLOCKED')), 'burn breaker halt');
      await waitFor(() => (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets.length === 1, 'burn breaker escalation');
      const escalation = (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { id: string }[] }).tickets[0]!;
      writeFileSync(join(e.home, 'resume-succeeds'), '');
      answerResume(e, escalation.id);

      await waitFor(() => loopPid(e, 'resume-loop') !== null, 'answered loop running');
      await waitFor(() => (helm(e, ['get', escalation.id]) as { status: string }).status === 'done', 'resume ticket closed');
      expect(existsSync(join(e.home, 'state', 'resume-loop', 'BLOCKED'))).toBe(false);
      expect(readFileSync(join(e.home, 'state', 'resume-loop', 'events.log'), 'utf8')).toMatch(/resume-complete.*ticket=H-/);
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('leaves a blocked loop down when the dashboard answer chooses investigate (H-1320)', { timeout: 60000 }, async () => {
    const e = setup(`[loops.investigate-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
continue_cap = 1
mock_cmd = '''
ID=$(node ${HELM_CLI} list --assignee investigate-loop --status in_progress --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -z "$ID" ]; then
  ID=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
fi
node ${HELM_CLI} update --ticket $ID --note "kept producing" --evidence-kind other --evidence-ref burn
'''
`);
    helm(e, ['create', '--title', 'work that reaches the breaker', '--body', 'x', '--workstream', 'rev-test', '--type', 'ops']);
    const { proc } = startFleet(e);
    try {
      await waitFor(() => existsSync(join(e.home, 'state', 'investigate-loop', 'BLOCKED')), 'burn breaker halt');
      await waitFor(() => (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets.length === 1, 'burn breaker escalation');
      const escalation = (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { id: string }[] }).tickets[0]!;
      answerInvestigate(e, escalation.id);

      await sleep(3000); // several supervisor polls: the answer must not restart it
      expect(loopPid(e, 'investigate-loop')).toBeNull();
      expect(existsSync(join(e.home, 'state', 'investigate-loop', 'BLOCKED'))).toBe(true);
      expect((helm(e, ['get', escalation.id]) as { status: string }).status).toBe('open');
      expect(readFileSync(join(e.home, 'state', 'investigate-loop', 'events.log'), 'utf8')).not.toContain('answer-resume');
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('blocks again and returns the answered ticket when the restarted loop fails (H-1038)', { timeout: 60000 }, async () => {
    const e = setup(`[loops.resume-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
continue_cap = 1
mock_cmd = '''
if [ -f "$REV_HOME/resume-fails" ]; then exit 1; fi
ID=$(node ${HELM_CLI} list --assignee resume-loop --status in_progress --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -z "$ID" ]; then
  ID=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
fi
node ${HELM_CLI} update --ticket $ID --note "kept producing" --evidence-kind other --evidence-ref burn
'''
`);
    helm(e, ['create', '--title', 'work that burns', '--body', 'x', '--workstream', 'rev-test', '--type', 'ops']);
    const { proc } = startFleet(e);
    try {
      await waitFor(() => existsSync(join(e.home, 'state', 'resume-loop', 'BLOCKED')), 'burn breaker halt');
      await waitFor(() => (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets.length === 1, 'burn breaker escalation');
      const escalation = (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { id: string }[] }).tickets[0]!;
      writeFileSync(join(e.home, 'resume-fails'), '');
      answerResume(e, escalation.id);

      await waitFor(() => {
        const t = helm(e, ['get', escalation.id]) as { status: string; question?: { situation: string } };
        return t.status === 'awaiting_human' && !!t.question?.situation.includes('restarted worker failed');
      }, 'restart failure returned to human');
      expect(existsSync(join(e.home, 'state', 'resume-loop', 'BLOCKED'))).toBe(true);
      expect(readFileSync(join(e.home, 'state', 'resume-loop', 'events.log'), 'utf8')).toMatch(/resume-failed.*ticket=H-/);
    } finally {
      proc.kill('SIGKILL');
    }
  });

  it('an abandoned tree drains itself: killing an ancestor takes the whole fleet down (H-281)', { timeout: 60000 }, async () => {
    const e = setup(`[loops.stray]
workstream = "ws-stray"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`);
    const { proc } = startFleet(e);
    try {
      await waitFor(() => loopPid(e, 'stray') !== null, 'loop up');
      expect(loopPid(e, 'supervisor')).not.toBeNull();
      // Kill only the outermost wrapper (npx). The real supervisor and its
      // loop survive with every inner ppid link intact — the exact shape of
      // the 2026-08-28 orphan swarm. The lineage watchdog must notice the
      // broken chain and drain the whole tree.
      proc.kill('SIGKILL');
      await waitFor(() => loopPid(e, 'supervisor') === null && loopPid(e, 'stray') === null, 'orphaned tree self-terminated', 30000);
      const log = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(log).toContain('orphaned');
      expect(log).toMatch(/fleet-stop\s+drained/);
    } finally {
      // If the watchdog failed, reap the real pids so the suite leaves no swarm.
      for (const n of ['supervisor', 'stray']) {
        const p = loopPid(e, n);
        if (p) process.kill(p, 'SIGKILL');
      }
    }
  });
  it('the drain escalation ends the straggler\'s session, not just its loop (H-1089)', { timeout: 60000 }, async () => {
    // The shape that cost H-1086 a gate run: a redeploy drains while an agent
    // CLI is mid-turn, the grace expires, the loop is SIGKILLed — and the CLI,
    // in its own detached group (H-467), reparents to init and keeps working
    // while the returning fleet starts a second session for the same seat.
    // The mock stands in for the CLI: it records its own pid and outlives any
    // grace. What must be true after the drain is that pid is gone.
    const e = setup(
      `[loops.slow]
workstream = "ws-slow"
cwd = "/tmp"
runtime = "mock"
mock_cmd = '''
echo $$ > "$REV_HOME/session.pid"
sleep 300
'''
`,
      'drain_grace_seconds = 3',
    );
    const { proc } = startFleet(e);
    const sessionPid = (): number => parseInt(readFileSync(join(e.home, 'session.pid'), 'utf8').trim(), 10);
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let session = 0;
    try {
      await waitFor(() => existsSync(join(e.home, 'session.pid')), 'session started');
      session = sessionPid();
      // Two assertions, not one: the session must be genuinely mid-flight when
      // the drain lands, or its absence afterwards proves nothing.
      expect(alive(session)).toBe(true);

      const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
      rev(e, ['stop']);
      expect(await exited).toBe(0);

      await waitFor(() => !alive(session), 'session ended with its loop', 10000);
      const log = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(log).toMatch(/drain-kill\s+loop=slow/);
      expect(log).toMatch(new RegExp(`drain-kill-session\\s+loop=slow group=${session}`));
    } finally {
      proc.kill('SIGKILL');
      try {
        if (session) process.kill(-session, 'SIGKILL');
      } catch {
        /* already gone: the point of the test */
      }
    }
  });

  it('a loop redeploys the fleet to activate its own fix, with no human in the path (H-1046)', { timeout: 90000 }, async () => {
    const e = setup(`[loops.shipper]
workstream = "ws-ship"
cwd = "${join(import.meta.dirname, '..')}"
runtime = "mock"
mock_cmd = '''
set -e
if [ -f "$REV_HOME/asked" ]; then exit 0; fi
ID=$(node ${HELM_CLI} list --ready --workstream ws-ship --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -z "$ID" ]; then exit 0; fi
node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
touch "$REV_HOME/asked"
npx tsx ${REV_CLI} redeploy --ticket $ID --reason "activate the fix this iteration landed"
'''
`);
    const t = (helm(e, ['create', '--title', 'a fix in rev itself', '--body', 'x', '--workstream', 'ws-ship', '--type', 'build']) as { id: string }).id;

    const first = startFleet(e);
    let supEvents = '';
    try {
      // The supervisor drains itself and exits UNSUCCESSFULLY on purpose:
      // that is the exit launchd and systemd bring back on the new code.
      const exited = new Promise<number | null>((r) => first.proc.on('exit', (code) => r(code)));
      expect(await exited).toBe(75);
      supEvents = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(supEvents).toMatch(/redeploy-ask\s+by=shipper ticket=H-/);
      expect(supEvents).toMatch(/drain\s+signal=redeploy/);
      expect(supEvents).toMatch(/fleet-stop\s+drained for redeploy/);
      expect(existsSync(join(e.home, 'state', 'supervisor', 'REDEPLOY'))).toBe(true);
      // Nothing was asked of the human anywhere in that.
      expect((helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets).toHaveLength(0);
    } finally {
      first.proc.kill('SIGKILL');
    }

    // The service manager's part, played by hand: start it again. The new
    // supervisor treats the sentinel as the record of a landing, not a fresh
    // ask — otherwise a redeploy would loop forever — and says so on the ticket.
    const second = startFleet(e);
    try {
      await waitFor(() => !existsSync(join(e.home, 'state', 'supervisor', 'REDEPLOY')), 'redeploy record cleared at startup');
      await waitFor(() => (helm(e, ['get', t]) as { evidence: unknown[] }).evidence.length > 0, 'landing noted on the ticket');
      const ticket = helm(e, ['get', t]) as { status: string; evidence: { ref: string }[] };
      expect(ticket.status).toBe('in_progress');
      expect(ticket.evidence[0]!.ref).toBe(join(e.home, 'state', 'supervisor', 'events.log'));
      const after = readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8');
      expect(after).toMatch(/redeploy-done\s+by=shipper ticket=H-/);
      expect(after.slice(supEvents.length)).toContain('fleet-start');
      // It stays landed: the record is gone, so no second drain follows.
      await sleep(3000);
      expect(loopPid(e, 'supervisor')).not.toBeNull();
    } finally {
      second.proc.kill('SIGKILL');
      const p = loopPid(e, 'shipper');
      if (p) process.kill(p, 'SIGKILL');
    }
  });

  it('a redeploy nothing comes back from reaches the human, named (H-1046)', { timeout: 90000 }, async () => {
    const e = setup(
      `[loops.quiet]
workstream = "ws-quiet"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`,
      'redeploy_deadline_seconds = 6',
    );
    const { proc } = startFleet(e);
    try {
      await waitFor(() => loopPid(e, 'quiet') !== null, 'loop up');
      const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
      rev(e, ['redeploy', '--reason', 'activate a fix', '--by', 'tester']);
      expect(await exited).toBe(75);

      // Nothing restarts it. The watch armed at the drain is the only thing
      // still running, and the outage must not be silent.
      await waitFor(
        () => (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: unknown[] }).tickets.length === 1,
        'the failed redeploy reached the human',
        40000,
      );
      const filed = (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { id: string; title: string }[] }).tickets[0]!;
      expect(filed.title).toContain('no supervisor came back');
      const full = helm(e, ['get', filed.id]) as { question: { situation: string } };
      expect(full.question.situation).toContain('no supervisor returned within 6s');
      expect(readFileSync(join(e.home, 'state', 'supervisor', 'events.log'), 'utf8')).toContain('redeploy-failed');
    } finally {
      proc.kill('SIGKILL');
      const p = loopPid(e, 'quiet');
      if (p) process.kill(p, 'SIGKILL');
    }
  });
});
