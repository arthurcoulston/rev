// End-to-end: a mock-runtime loop against a real (temp) Helm store, via the
// real helm-cli. Proves the full circle: wake on cursor → session claims and
// completes a ticket through Helm → produced-check → idle → escalation on
// repeated failure. No agent CLI, no tokens.
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELMO_CLI as HELM_CLI, HELMO_SERVER } from './helmo.js';

const REV_CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

interface Env {
  home: string;
  db: string;
  env: NodeJS.ProcessEnv;
}

function setup(loopToml: string): Env {
  const home = mkdtempSync(join(tmpdir(), 'rev-e2e-'));
  const db = join(home, 'helm.db');
  writeFileSync(
    join(home, 'roster.toml'),
    `[global]
helmo_cli = "${HELM_CLI}"
helmo_mcp_server = "${HELMO_SERVER}"
helmo_db = "${db}"
poll_seconds = 1
fail_cap = 1
wedge_cap = 3
usage_poll_seconds = 0
${loopToml}`,
  );
  mkdirSync(join(home, 'work'), { recursive: true });
  return { home, db, env: { ...process.env, REV_HOME: home, HELMO_DB: db } };
}

function helm(e: Env, args: string[], actor = '{"name":"seeder","kind":"agent","model":"t","version":"0"}'): Record<string, unknown> {
  return JSON.parse(
    execFileSync('node', [HELM_CLI, ...args], { env: { ...e.env, HELMO_ACTOR: actor }, encoding: 'utf8' }),
  ) as Record<string, unknown>;
}

function rev(e: Env, args: string[]): string {
  return execFileSync('npx', ['tsx', REV_CLI, ...args], { env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });
}

function seedTicket(e: Env, title: string): string {
  return (helm(e, ['create', '--title', title, '--body', 'test work: claim me, complete me', '--workstream', 'rev-test', '--type', 'ops']) as { id: string }).id;
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function instrumentSuccessfulWakeChecks(e: Env): string {
  const marker = join(e.home, 'wake-check-completed');
  const proxy = join(e.home, 'helmo-proxy.mjs');
  writeFileSync(
    proxy,
    `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, [${JSON.stringify(HELM_CLI)}, ...process.argv.slice(2)], { env: process.env, stdio: 'inherit' });
if (process.argv[2] === 'wake-check' && result.status === 0) appendFileSync(${JSON.stringify(marker)}, 'ok\\n');
process.exit(result.status ?? 1);
`,
  );
  const roster = join(e.home, 'roster.toml');
  writeFileSync(roster, readFileSync(roster, 'utf8').replace(`helmo_cli = "${HELM_CLI}"`, `helmo_cli = "${proxy}"`));
  return marker;
}

// These spawn real processes and drive a real store, so vitest's 5s unit
// default was never their budget: the slowest already measured 4.0s and 6.0s
// on a quiet machine, and vitest runs test FILES in parallel — adding one
// more e2e file elsewhere in the suite is enough to push them over (found
// while landing H-1089). Budget for the suite's own load, not the quiet case.
describe('rev e2e (mock runtime, real helm store)', { timeout: 30000 }, () => {
  it('wakes on ready work, session completes it via helm-cli, then idles', () => {
    // The mock "agent": claims the first ready ticket and completes it with evidence.
    const e = setup(`[loops.test-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = '''
set -e
ID=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -n "$ID" ]; then
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
  SIDE=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
  if [ -n "$SIDE" ]; then
    HELMO_ACTOR='{"name":"test-loop","kind":"agent","model":"mock","version":"0.1","session":"desk"}' node ${HELM_CLI} update --ticket $SIDE --note "desk claim" --status in_progress
    HELMO_ACTOR='{"name":"test-loop","kind":"agent","model":"mock","version":"0.1","session":"desk"}' node ${HELM_CLI} update --ticket $SIDE --note "desk progress"
    HELMO_ACTOR='{"name":"test-loop","kind":"agent","model":"mock","version":"0.1","session":"desk"}' node ${HELM_CLI} update --ticket $SIDE --note "desk done" --status done --evidence-kind other --evidence-ref desk
  fi
  node ${HELM_CLI} update --ticket $ID --note "completed by mock" --status done --evidence-kind file --evidence-ref /tmp/out
  echo "rev-mock-usage tokens=1200 cost_usd=0.25"
fi
'''
`);
    const id = seedTicket(e, 'Mock work item');
    const side = seedTicket(e, 'Desk work under the same actor name');
    const out = rev(e, ['run', 'test-loop', '--count', '2']);
    expect(out).toContain('run 1 started');

    const ticket = helm(e, ['get', id]) as { status: string; evidence: unknown[]; tokens_total: number; cost_usd_total: number };
    expect(ticket.status).toBe('done');
    expect(ticket.evidence.length).toBe(1);

    // H-19: the session's metered spend landed on the ticket it worked —
    // written by the rev actor AFTER the mock closed it.
    expect(ticket.tokens_total).toBe(1200);
    expect(ticket.cost_usd_total).toBeCloseTo(0.25);
    expect((helm(e, ['get', side]) as { tokens_total: number }).tokens_total).toBe(0);
    expect(readFileSync(join(e.home, 'token-log'), 'utf8')).toContain('tokens=1200 cost_usd=0.25');

    // Second iteration produced nothing -> loop idles at the cursor.
    const idle = join(e.home, 'state', 'test-loop', 'IDLE');
    expect(existsSync(idle)).toBe(true);
    expect(readFileSync(idle, 'utf8')).toContain('no executable work is owned by this seat or ready in its watched scope');
    const events = readFileSync(join(e.home, 'state', 'test-loop', 'events.log'), 'utf8');
    expect(events).toMatch(/run-end.*produced=true/);
    expect(events).toMatch(new RegExp(`spend\\s+iter=1 ticket=${id} tokens=1200 cost=0\\.25`));
    expect(events).toMatch(/action=idle/);
  });

  it('stands down while a desk session holds work in its name, resumes when the seat clears (H-558)', async () => {
    const e = setup(`[loops.seat-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`);
    // A desk session sharing the crew name claims a ticket reserved for it —
    // the exact H-542/H-560 shape. Same actor name, no rev seat stamp.
    const id = (helm(e, ['create', '--title', 'Seat collision', '--body', 'held by a desk session sharing the name', '--workstream', 'rev-test', '--type', 'ops', '--assignee', 'seat-loop']) as { id: string }).id;
    const desk = '{"name":"seat-loop","kind":"agent","model":"claude-fable-5","version":"claude-code-2.1.221","session":"desk"}';
    helm(e, ['update', '--ticket', id, '--note', 'claimed at the desk', '--status', 'in_progress'], desk);

    const dir = join(e.home, 'state', 'seat-loop');
    const events = () => (existsSync(join(dir, 'events.log')) ? readFileSync(join(dir, 'events.log'), 'utf8') : '');
    const until = async (re: RegExp) => {
      const deadline = Date.now() + 30_000;
      while (!re.test(events()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    };
    const child = spawn('npx', ['tsx', REV_CLI, 'run', 'seat-loop'], { env: e.env, cwd: join(import.meta.dirname, '..'), stdio: 'ignore' });
    try {
      await until(/seat-held/);
      expect(events()).toMatch(/seat-held.*another live session \('desk'\)/);
      expect(events()).not.toMatch(/run-start/); // no session spent over the foreign hold
      expect(readFileSync(join(dir, 'SEAT_HELD'), 'utf8')).toMatch(/another live session \('desk'\)/);
      // The desk session finishes its work; the seat clears and the loop runs.
      helm(e, ['update', '--ticket', id, '--note', 'done at the desk', '--status', 'done', '--evidence-kind', 'other', '--evidence-ref', 'x'], desk);
      await until(/run-start/);
      expect(existsSync(join(dir, 'SEAT_HELD'))).toBe(false);
      expect(events()).toMatch(/seat-clear/);
      expect(events()).toMatch(/run-start/);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('a note-only session is not production — the loop idles instead of running on (H-412)', async () => {
    // The exact shape that cost the most: an agent finds nothing actionable,
    // records that honestly, and ends. Before the advancing check that note
    // scored as production and bought another full iteration.
    const e = setup(`[loops.note-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = '''
set -e
ID=$(node ${HELM_CLI} list --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -n "$ID" ]; then
  node ${HELM_CLI} update --ticket $ID --note "checked the queue; nothing actionable yet"
  echo "rev-mock-usage tokens=1000 cost_usd=0.90"
fi
'''
`);
    seedTicket(e, 'A ticket the note loop will only comment on');
    const dir = join(e.home, 'state', 'note-loop');
    const polled = instrumentSuccessfulWakeChecks(e);
    // Two iterations requested, but only one can happen: the first idles, and
    // the standing ticket the mock keeps declining is not motion (H-426), so
    // the loop polls quietly until the test observes a completed post-idle
    // wake-check and stops it. Startup and idle classification make the first
    // two checks; reaching the fourth proves Rev consumed the third check and
    // completed the gate decision this regression protects.
    const eventsPath = join(dir, 'events.log');
    const child = spawn('npx', ['tsx', REV_CLI, 'run', 'note-loop', '--count', '2'], {
      env: e.env, cwd: join(import.meta.dirname, '..'), stdio: 'ignore',
    });
    try {
      await waitForFile(eventsPath, 30_000);
      const deadline = Date.now() + 30_000;
      while (!(/run-end.*iter=1.*produced=false.*action=idle/.test(readFileSync(eventsPath, 'utf8'))
        && existsSync(join(dir, 'IDLE'))
        && existsSync(polled)
        && readFileSync(polled, 'utf8').trim().split('\n').length >= 4)) {
        if (Date.now() >= deadline) throw new Error('timed out waiting for note-loop to idle');
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      child.kill('SIGKILL');
    }
    const events = readFileSync(eventsPath, 'utf8');
    expect(events).toMatch(/run-end.*iter=1.*produced=false.*action=idle/);
    expect(existsSync(join(dir, 'IDLE'))).toBe(true);
    expect(readFileSync(join(dir, 'IDLE'), 'utf8')).toContain('1 executable ticket remained after an iteration made no advancing change');

    // Every pass idles; none is scored as production, so none skips the gate —
    // and after the first idle, silence: no wake, no second iteration.
    expect(events).not.toMatch(/action=continue/);
    expect(events).not.toMatch(/run-start.*iter=2/);
    expect(events.slice(events.indexOf('action=idle'))).not.toMatch(/wake\s/);
  });

  it('names held-but-non-executable work without changing the compatible cursor line (H-954)', () => {
    const e = setup(`[loops.held-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`);
    helm(e, [
      'create', '--title', 'Mid-flight work', '--body', 'owned by this seat but not ready to draw',
      '--workstream', 'elsewhere', '--type', 'ops', '--assignee', 'held-loop', '--status', 'in_progress',
    ], '{"name":"held-loop","kind":"agent","model":"mock","version":"0.1","session":"rev:held-loop"}');

    rev(e, ['run', 'held-loop', '--count', '1']);
    const idle = readFileSync(join(e.home, 'state', 'held-loop', 'IDLE'), 'utf8').split('\n');
    expect(Number.isInteger(Number(idle[0]))).toBe(true);
    expect(idle[1]).toBe("1 ticket remains in this seat's hands, but none is executable");
  });

  it('a restarted loop ignores the old idle floor once, then goes motion-only (H-426/H-995)', async () => {
    const e = setup(`[loops.note-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
idle_floor_s = 3600
mock_cmd = '''
set -e
ID=$(node ${HELM_CLI} list --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -n "$ID" ]; then
  node ${HELM_CLI} update --ticket $ID --note "checked the queue; nothing actionable yet"
  echo "rev-mock-usage tokens=1000 cost_usd=0.90"
fi
'''
`);
    seedTicket(e, 'A ticket that outlives a restart');
    const dir = join(e.home, 'state', 'note-loop');
    // First process: runs once, declines, idles. IDLE survives its exit.
    rev(e, ['run', 'note-loop', '--count', '1']);
    expect(existsSync(join(dir, 'IDLE'))).toBe(true);
    expect(existsSync(join(dir, 'IDLE_AT'))).toBe(true);

    // Second process starts idle with the ticket still ready, no motion, and a
    // fresh one-hour floor. Restart pickup bypasses that old process's floor.
    const marker = readFileSync(join(dir, 'events.log'), 'utf8').length;
    const child = spawn('npx', ['tsx', REV_CLI, 'run', 'note-loop', '--count', '1'], {
      env: e.env, cwd: join(import.meta.dirname, '..'), stdio: 'ignore',
    });
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const tail = readFileSync(join(dir, 'events.log'), 'utf8').slice(marker);
        if (/run-end.*iter=1/.test(tail)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      child.kill('SIGKILL');
    }
    const events = readFileSync(join(dir, 'events.log'), 'utf8').slice(marker);
    expect(events).toMatch(/wake\s/);
    expect(events).toMatch(/run-end.*iter=1/);
  });

  it('a handoff wakes an idle scoped seat on the next poll, with the idle floor still fresh (H-1072)', async () => {
    // The incident this fixes: ward idled at 02:57Z, H-1053 was handed back at
    // 03:20Z, and the seat slept until 03:58Z because the floor was armed. The
    // floor is set to an hour here; waking inside it is the whole assertion.
    const e = setup(`[loops.handoff-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
idle_floor_s = 3600
mock_cmd = "true"
`);
    // Reserved elsewhere, so the seat's first pass is genuinely empty-handed.
    const id = (helm(e, [
      'create', '--title', 'Work that starts in another seat', '--body', 'handed over mid-idle',
      '--workstream', 'rev-test', '--type', 'ops', '--assignee', 'other-seat',
    ]) as { id: string }).id;

    const dir = join(e.home, 'state', 'handoff-loop');
    const child = spawn('npx', ['tsx', REV_CLI, 'run', 'handoff-loop', '--count', '2'], {
      env: e.env, cwd: join(import.meta.dirname, '..'), stdio: 'ignore',
    });
    try {
      await waitForFile(join(dir, 'IDLE_AT'), 30_000);
      const idleAt = parseInt(readFileSync(join(dir, 'IDLE_AT'), 'utf8'), 10);
      const marker = readFileSync(join(dir, 'events.log'), 'utf8').length;

      helm(e, ['update', '--ticket', id, '--note', 'yours now', '--handoff-to', 'handoff-loop']);

      const deadline = Date.now() + 25_000;
      let tail = '';
      while (!/run-start.*iter=2/.test(tail)) {
        if (Date.now() >= deadline) throw new Error(`the handoff never drew a second iteration; saw: ${tail}`);
        await new Promise((r) => setTimeout(r, 25));
        tail = readFileSync(join(dir, 'events.log'), 'utf8').slice(marker);
      }
      expect(tail).toMatch(/wake .*ready=1/);
      // Woken while the hour-long floor was still fresh — the old gate would
      // have held this wake until 3600s after idleAt. Read the wake's own
      // stamp, not the clock now, so a slow machine cannot flatter the number.
      const wokeAt = Date.parse(tail.match(/^(\S+) wake\s/m)![1]!);
      expect(wokeAt - idleAt).toBeLessThan(60_000);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('a note on in-scope work is motion, but never wakes an idle scoped seat (H-1072)', async () => {
    // The H-336 desk-noise shape, which is why the floor existed at all: a
    // ticket the seat cannot draw gets commented on. changed_since goes true
    // and nothing became ready. With the floor at 0 there is nothing else
    // holding the wake, so this proves the gate itself, not a debounce.
    const e = setup(`[loops.quiet-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
idle_floor_s = 0
mock_cmd = "true"
`);
    const id = (helm(e, [
      'create', '--title', 'Someone else’s work, in the watched stream', '--body', 'never ready for this seat',
      '--workstream', 'rev-test', '--type', 'ops', '--assignee', 'other-seat',
    ]) as { id: string }).id;

    const dir = join(e.home, 'state', 'quiet-loop');
    const polled = instrumentSuccessfulWakeChecks(e);
    const child = spawn('npx', ['tsx', REV_CLI, 'run', 'quiet-loop', '--count', '2'], {
      env: e.env, cwd: join(import.meta.dirname, '..'), stdio: 'ignore',
    });
    try {
      await waitForFile(join(dir, 'IDLE'), 30_000);
      const since = parseInt(readFileSync(join(dir, 'IDLE'), 'utf8').split('\n')[0]!, 10);
      const marker = readFileSync(join(dir, 'events.log'), 'utf8').length;
      const polls = () => (existsSync(polled) ? readFileSync(polled, 'utf8').trim().split('\n').length : 0);
      const before = polls();

      helm(e, ['update', '--ticket', id, '--note', 'a comment that changes nobody’s queue']);

      // The store agrees this is motion with no readiness edge — without this
      // the silence below could be silence about nothing.
      const w = helm(e, [
        'wake-check', '--workstream', 'rev-test', '--assignee', 'quiet-loop', '--since-seq', String(since),
      ]) as { changed_since: boolean; newly_ready_count: number };
      expect(w.changed_since).toBe(true);
      expect(w.newly_ready_count).toBe(0);

      // Two more completed polls saw that motion and declined to wake.
      const deadline = Date.now() + 25_000;
      while (polls() < before + 2) {
        if (Date.now() >= deadline) throw new Error('timed out waiting for post-note wake-checks');
        await new Promise((r) => setTimeout(r, 25));
      }
      const tail = readFileSync(join(dir, 'events.log'), 'utf8').slice(marker);
      expect(tail).not.toMatch(/wake\s/);
      expect(tail).not.toMatch(/run-start.*iter=2/);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('an hour asleep on standing ready work resyncs the seat (H-1072)', async () => {
    // The backstop for a readiness edge Rev never saw: no motion, nothing
    // newly ready, and a ticket the seat could draw sitting there. It is a
    // safety net and not a debounce — the handoff test above wakes on a fresh
    // IDLE_AT, so this hourly path never stands in front of an immediate wake.
    const e = setup(`[loops.resync-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
idle_floor_s = 0
mock_cmd = "true"
`);
    seedTicket(e, 'Standing ready work the seat left behind');

    const dir = join(e.home, 'state', 'resync-loop');
    const child = spawn('npx', ['tsx', REV_CLI, 'run', 'resync-loop', '--count', '2'], {
      env: e.env, cwd: join(import.meta.dirname, '..'), stdio: 'ignore',
    });
    try {
      await waitForFile(join(dir, 'IDLE_AT'), 30_000);
      const since = parseInt(readFileSync(join(dir, 'IDLE'), 'utf8').split('\n')[0]!, 10);
      const marker = readFileSync(join(dir, 'events.log'), 'utf8').length;

      // Nothing has moved and nothing became ready: only the clock can wake it.
      const w = helm(e, [
        'wake-check', '--workstream', 'rev-test', '--assignee', 'resync-loop', '--since-seq', String(since),
      ]) as { changed_since: boolean; newly_ready_count: number; ready_count: number };
      expect(w.changed_since).toBe(false);
      expect(w.newly_ready_count).toBe(0);
      expect(w.ready_count).toBe(1);

      writeFileSync(join(dir, 'IDLE_AT'), String(Date.now() - 2 * 3_600_000));

      const deadline = Date.now() + 25_000;
      let tail = '';
      while (!/run-start.*iter=2/.test(tail)) {
        if (Date.now() >= deadline) throw new Error(`the hourly resync never woke the seat; saw: ${tail}`);
        await new Promise((r) => setTimeout(r, 25));
        tail = readFileSync(join(dir, 'events.log'), 'utf8').slice(marker);
      }
      expect(tail).toMatch(/wake .*ready=1/);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('an empty-handed iteration runs on the probe model; one with work in reach does not (H-412)', () => {
    // Iteration 1 has a ready ticket: working model. The mock claims and
    // closes it, so iteration 2 finds nothing ready and nothing held — the
    // probe case — and must run on the probe model, signed as such everywhere:
    // the session env, the run-start event, and the token-log.
    const e = setup(`[loops.probe-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
model = "working-model"
probe_model = "probe-model"
mock_cmd = '''
set -e
echo "MODEL:$REV_MODEL"
ID=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -n "$ID" ]; then
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
  node ${HELM_CLI} update --ticket $ID --note "completed by mock" --status done --evidence-kind file --evidence-ref /tmp/out
fi
echo "rev-mock-usage tokens=100 cost_usd=0.01"
'''
`);
    seedTicket(e, 'Work for the probe loop');
    const out = rev(e, ['run', 'probe-loop', '--count', '2']);
    expect(out).toContain('MODEL:working-model');
    expect(out).toContain('MODEL:probe-model');
    expect(out).toContain('run 2 started');

    const events = readFileSync(join(e.home, 'state', 'probe-loop', 'events.log'), 'utf8');
    expect(events).toMatch(/run-start\s+iter=1 seq=\d+ provider=\S+\n/); // no probe tag with work ready
    expect(events).toMatch(/run-start\s+iter=2 seq=\d+ provider=\S+ probe=probe-model/);

    const tokenLog = readFileSync(join(e.home, 'token-log'), 'utf8');
    expect(tokenLog).toContain('model=working-model');
    expect(tokenLog).toContain('model=probe-model');
  });

  it('a rotation alternates providers every other run, signed everywhere (H-479)', () => {
    // Two mock providers on the same tier: iteration 1 runs provider-a,
    // iteration 2 runs provider-b — visible in the session env, the run-start
    // events, and the token-log. Iteration 1 closes the seeded ticket, so it
    // scores as production and chains straight into iteration 2 — a declined
    // standing ticket no longer re-wakes an idled loop (H-426).
    const e = setup(`[providers.prov-a]
runtime = "mock"
[providers.prov-a.models]
mid = "model-a"
[providers.prov-b]
runtime = "mock"
[providers.prov-b.models]
mid = "model-b"
[loops.rotator]
workstream = "rev-test"
cwd = "/tmp"
provider = "prov-a"
tier = "mid"
rotation = ["prov-a", "prov-b"]
mock_cmd = '''
set -e
echo "MODEL:$REV_MODEL"
ID=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -n "$ID" ]; then
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
  node ${HELM_CLI} update --ticket $ID --note "completed by mock" --status done --evidence-kind file --evidence-ref /tmp/out
fi
echo "rev-mock-usage tokens=10 cost_usd=0.01"
'''
`);
    seedTicket(e, 'Work for the rotator');
    const out = rev(e, ['run', 'rotator', '--count', '2']);
    expect(out).toContain('MODEL:model-a');
    expect(out).toContain('MODEL:model-b');

    const events = readFileSync(join(e.home, 'state', 'rotator', 'events.log'), 'utf8');
    expect(events).toMatch(/run-start\s+iter=1 seq=\d+ provider=prov-a/);
    expect(events).toMatch(/run-start\s+iter=2 seq=\d+ provider=prov-b/);

    const tokenLog = readFileSync(join(e.home, 'token-log'), 'utf8');
    expect(tokenLog).toContain('model=model-a');
    expect(tokenLog).toContain('model=model-b');
  });

  it('headroom selection reaches the Codex adapter and meters the selected high model (H-892)', () => {
    const e = setup(`[providers.claude.models]
high = "claude-fable-5-1"
[providers.codex.models]
high = "gpt-6-astra"
[providers.codex.prices]
"gpt-6-astra" = { input = 10, output = 50 }
[loops.balancer]
workstream = "rev-test"
cwd = "/tmp"
constitution = "PROFILE.md"
provider = "claude"
tier = "high"
rotation = ["claude", "codex"]
routing = "headroom"
`);
    writeFileSync(join(e.home, 'PROFILE.md'), '# Test identity\n');
    const now = Date.now();
    for (const [file, percent, hours] of [['usage.json', 80, 144], ['usage-codex.json', 15, 48]] as const) {
      writeFileSync(join(e.home, file), JSON.stringify({ fetched_at: new Date(now).toISOString(), stale: false, limits: [
        { kind: 'weekly_all', label: 'weekly', percent, severity: 'normal', active: false, resets_at: new Date(now + hours * 3600000).toISOString() },
      ] }));
    }
    // Both executables are fixtures: a broken selector cannot launch a real
    // model, and the rollout refresh cannot read the developer's home.
    const bin = join(e.home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/usr/bin/env node\nthrow new Error("wrong provider selected");\n');
    writeFileSync(join(bin, 'codex'), '#!/usr/bin/env node\n' +
      'if (process.argv[process.argv.indexOf("--model") + 1] !== "gpt-6-astra") process.exit(1);\n' +
      'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"fixture Astra ran"}}));\n' +
      'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:100,output_tokens:10}}));\n');
    chmodSync(join(bin, 'claude'), 0o755);
    chmodSync(join(bin, 'codex'), 0o755);
    e.env['PATH'] = `${bin}:${e.env['PATH']}`;
    e.env['CODEX_HOME'] = join(e.home, 'codex-home');
    seedTicket(e, 'High-tier work for the balancer');
    expect(rev(e, ['run', 'balancer', '--count', '1'])).toContain('fixture Astra ran');
    const events = readFileSync(join(e.home, 'state', 'balancer', 'events.log'), 'utf8');
    expect(events).toMatch(/provider-switch.*headroom routing: codex\/gpt-6-astra/);
    expect(events).toMatch(/run-start.*provider=codex/);
    const tokens = readFileSync(join(e.home, 'token-log'), 'utf8');
    expect(tokens).toContain('model=gpt-6-astra');
    expect(tokens).toContain('cost_usd=0.0015');
  });

  it('a loop that cannot reach Helm at all is declared wedged, not left polling (H-448)', async () => {
    // The 2026-08-27 outage in miniature: the helm-cli always fails, so every
    // wake-check throws. Before this, the loop logged politely once a minute
    // and told nobody. A wedged loop deliberately keeps polling (the fault is
    // outside it and may clear), so this drives it directly and stops it.
    const e = setup(`[loops.wedge-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "true"
`);
    const broken = join(e.home, 'broken-helm.cjs');
    writeFileSync(broken, 'process.stderr.write("SqliteError: UNIQUE constraint failed: tickets.id"); process.exit(1);\n');
    writeFileSync(join(e.home, 'roster.toml'), readFileSync(join(e.home, 'roster.toml'), 'utf8').replace(HELM_CLI, broken));
    // An IDLE cursor puts it on the wake-check path rather than straight into a run.
    const dir = join(e.home, 'state', 'wedge-loop');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'IDLE'), '0');

    const child = spawn('npx', ['tsx', REV_CLI, 'run', 'wedge-loop'], {
      env: e.env,
      cwd: join(import.meta.dirname, '..'),
      stdio: 'ignore',
    });
    try {
      const deadline = Date.now() + 30_000;
      while (!existsSync(join(dir, 'WEDGED')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      expect(existsSync(join(dir, 'WEDGED'))).toBe(true);
      // Let it poll on past the wedge, to prove the alarm does not repeat.
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      child.kill('SIGKILL');
    }

    const events = readFileSync(join(dir, 'events.log'), 'utf8');
    expect(events).toMatch(/wedged.*consecutive wake-check failures/);
    expect((events.match(/wedge-alarm/g) ?? []).length).toBe(1);
  }, 45_000);

  it('the burn breaker halts a loop that keeps spending and escalates it (H-412)', () => {
    // The mock always writes something, so every iteration scores produced=true
    // and the ladder says 'continue' forever — the shape of the burns this
    // exists for. At $0.60 an iteration against a $1 day cap it must stop on
    // the second, not run on.
    const e = setup(`[loops.burn-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
burn_usd_per_day = 1
mock_cmd = '''
set -e
ID=$(node ${HELM_CLI} list --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -n "$ID" ]; then
  node ${HELM_CLI} update --ticket $ID --note "busy, making no progress" --status in_progress
  echo "rev-mock-usage tokens=1000 cost_usd=0.60"
fi
'''
`);
    seedTicket(e, 'The ticket the burn loop keeps noting on');
    const out = rev(e, ['run', 'burn-loop', '--count', '5']);

    expect(out).toContain('burn breaker');
    expect(out).not.toContain('run 3 started'); // stopped on the second, not the fifth

    const dir = join(e.home, 'state', 'burn-loop');
    expect(existsSync(join(dir, 'BLOCKED'))).toBe(true);
    const events = readFileSync(join(dir, 'events.log'), 'utf8');
    expect(events).toMatch(/breaker.*metered in the last 24h/);
    expect(events).toMatch(/blocked/);

    // The alarm reached the human queue, not just the trace.
    const q = helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { title: string }[] };
    expect(q.tickets.some((t) => t.title.includes('burn-loop'))).toBe(true);
  });

  it('nets out agent self-reported spend so the session lands in the totals exactly once (H-57)', () => {
    // The mock misbehaves: it guesses its own usage in an update. The metered
    // figure must win — final totals equal the meter, not meter + guess.
    const e = setup(`[loops.guess-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = '''
set -e
ID=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -n "$ID" ]; then
  node ${HELM_CLI} update --ticket $ID --note "claimed by mock" --status in_progress
  node ${HELM_CLI} update --ticket $ID --note "guessing my spend" --tokens 5000 --cost-usd 5 --status done --evidence-kind file --evidence-ref /tmp/out
  echo "rev-mock-usage tokens=1200 cost_usd=0.25"
fi
'''
`);
    const id = seedTicket(e, 'Work the guessing loop will inflate');
    rev(e, ['run', 'guess-loop', '--count', '1']);
    const ticket = helm(e, ['get', id]) as { tokens_total: number; cost_usd_total: number };
    expect(ticket.tokens_total).toBe(1200);
    expect(ticket.cost_usd_total).toBeCloseTo(0.25);
    const events = readFileSync(join(e.home, 'state', 'guess-loop', 'events.log'), 'utf8');
    expect(events).toMatch(new RegExp(`spend\\s+iter=1 ticket=${id} tokens=-3800 cost=-4\\.75`));
  });

  it('cancels a self-report on the ticket that carries it, not on the ticket the session is charged to (H-187)', () => {
    // The mock works ticket A but guesses its usage onto side ticket B. A must
    // end at the meter; B must end at zero — never the old −(guess − meter).
    const e = setup(`[loops.side-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = '''
set -e
IDS=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 2 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets.map(t=>t.id).join(' '))})")
A=$(echo $IDS | cut -d' ' -f1); B=$(echo $IDS | cut -d' ' -f2)
if [ -n "$A" ]; then
  node ${HELM_CLI} update --ticket $A --note "claimed by mock" --status in_progress
  node ${HELM_CLI} update --ticket $B --note "guessing my spend on the side ticket" --tokens 80000
  node ${HELM_CLI} update --ticket $A --note "completed by mock" --status done --evidence-kind file --evidence-ref /tmp/out
  echo "rev-mock-usage tokens=17696 cost_usd=3.23"
fi
'''
`);
    const a = seedTicket(e, 'Main work');
    const b = seedTicket(e, 'Side ticket that gets the guess');
    rev(e, ['run', 'side-loop', '--count', '1']);
    const ta = helm(e, ['get', a]) as { tokens_total: number; cost_usd_total: number };
    const tb = helm(e, ['get', b]) as { tokens_total: number; cost_usd_total: number };
    expect(ta.tokens_total).toBe(17696);
    expect(ta.cost_usd_total).toBeCloseTo(3.23);
    expect(tb.tokens_total).toBe(0);
    expect(tb.cost_usd_total).toBe(0);
    const events = readFileSync(join(e.home, 'state', 'side-loop', 'events.log'), 'utf8');
    expect(events).toMatch(new RegExp(`spend\\s+iter=1 ticket=${a} tokens=17696 cost=3\\.23`));
    expect(events).toMatch(new RegExp(`spend\\s+iter=1 ticket=${b} tokens=-80000 cost=0`));
  });

  it('workstream steering (goal + budget) lands in the iteration prompt', () => {
    const e = setup(`[loops.steer-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = 'echo "PROMPT:$REV_PROMPT"'
`);
    seedTicket(e, 'Steered work item');
    helm(
      e,
      ['workstream-set', '--name', 'rev-test', '--goal', 'the gala happens', '--budget-usd', '50'],
      '{"name":"operator","kind":"human"}',
    );
    const out = rev(e, ['run', 'steer-loop', '--count', '1']);
    expect(out).toContain('what done means for the whole stream: the gala happens');
    expect(out).toContain('$0.00 of $50.00 spent');
  });

  it('steering names every stream the seat holds work in, not just the one it watches (H-954)', () => {
    // The defect this closes: steering was built from the SEAT's workstream and
    // never the assigned ticket's, so a seat holding work routed in from another
    // stream was told a goal that did not describe it — including "if the goal
    // is already met, closing out is the right move", over work in a stream
    // whose goal nobody had checked.
    const e = setup(`[loops.multi-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = 'echo "PROMPT:$REV_PROMPT"'
`);
    seedTicket(e, 'Work in the watched stream');
    helm(e, ['create', '--title', 'Routed in from elsewhere', '--body', 'reserved to this seat', '--workstream', 'rev-elsewhere', '--type', 'ops', '--assignee', 'multi-loop']);
    for (const [name, goal] of [['rev-test', 'the gala happens'], ['rev-elsewhere', 'the archive is catalogued']]) {
      helm(e, ['workstream-set', '--name', name!, '--goal', goal!], '{"name":"operator","kind":"human"}');
    }
    const out = rev(e, ['run', 'multi-loop', '--count', '1']);
    expect(out).toContain("'rev-test' — what done means for that stream: the gala happens");
    expect(out).toContain("'rev-elsewhere' — what done means for that stream: the archive is catalogued");
    expect(out).toContain('a goal met in one says nothing about the others');
    // The sentence that made the old behaviour dangerous rather than merely
    // wrong: one stream's goal must never authorize closing out another's.
    expect(out).not.toContain('If the goal is already met, closing out is the right move');
  });

  it('a held stream with no goal is named as unsteered, not left looking finished (H-954)', () => {
    // The commonest shape, and the one that bit: the watched stream has a goal
    // and the held stream has none. Dropping the goalless stream would restore
    // the singular wording and the whole defect with it.
    const e = setup(`[loops.quiet-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = 'echo "PROMPT:$REV_PROMPT"'
`);
    helm(e, ['create', '--title', 'Held work in a stream nobody steered', '--body', 'reserved to this seat', '--workstream', 'rev-quiet', '--type', 'ops', '--assignee', 'quiet-loop']);
    helm(e, ['workstream-set', '--name', 'rev-test', '--goal', 'the gala happens'], '{"name":"operator","kind":"human"}');
    const out = rev(e, ['run', 'quiet-loop', '--count', '1']);
    expect(out).toContain("'rev-quiet'");
    expect(out).toContain('treat them as unsteered, not as finished');
    expect(out).not.toContain('If the goal is already met, closing out is the right move');
  });

  it('the idle rule covers the assigned list, not only the watched stream (H-987)', () => {
    // The sentence after steering used to say "if nothing THERE is workable",
    // about the watched stream's ready list alone. A literal reader ended the
    // session whenever that list was empty, whatever the assigned list held:
    // five of five Codex-driven passes on the mason seat, one of them with four
    // reserved helmo-dev tickets named in its own steering.
    const e = setup(`[loops.literal-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = 'echo "PROMPT:$REV_PROMPT"'
`);
    helm(e, ['create', '--title', 'Routed in from elsewhere', '--body', 'reserved to this seat', '--workstream', 'rev-elsewhere', '--type', 'ops', '--assignee', 'literal-loop']);
    const out = rev(e, ['run', 'literal-loop', '--count', '1']);
    expect(out).toContain('A ticket reserved for you is yours to work whatever its workstream');
    expect(out).toContain('If nothing in EITHER list is workable');
    expect(out).not.toContain('If nothing there is workable');
  });

  it('held work in the seat\'s own stream keeps the single-stream wording (H-954)', () => {
    // The near miss: naming streams plurally whenever a seat holds anything
    // would reword every ordinary iteration in the fleet for no gain.
    const e = setup(`[loops.solo-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = 'echo "PROMPT:$REV_PROMPT"'
`);
    helm(e, ['create', '--title', 'Held work, same stream', '--body', 'reserved to this seat', '--workstream', 'rev-test', '--type', 'ops', '--assignee', 'solo-loop']);
    helm(e, ['workstream-set', '--name', 'rev-test', '--goal', 'the gala happens', '--budget-usd', '50'], '{"name":"operator","kind":"human"}');
    const out = rev(e, ['run', 'solo-loop', '--count', '1']);
    expect(out).toContain("what done means for the whole stream: the gala happens");
    expect(out).toContain('If the goal is already met, closing out is the right move');
    expect(out).toContain('$0.00 of $50.00 spent');
    expect(out).not.toContain('more than one workstream');
  });

  it('a scoped loop is told how to signal idle — the ladder scores it on that contract (H-740)', () => {
    const e = setup(`[loops.scoped-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = 'echo "PROMPT:$REV_PROMPT"'
`);
    seedTicket(e, 'Something to draw');
    const out = rev(e, ['run', 'scoped-loop', '--count', '1']);
    expect(out).toContain("PROMPT:This is a Rev loop iteration, not a summon; AGENTS.md's summon clause does not apply; the queue is the work.");
    expect(out).toContain('producing nothing is the idle signal this loop reads');
    // Named because a scoped seat's queue stalls in ways a store-wide sweep's
    // "nothing has changed" does not describe.
    expect(out).toContain('blocked, time-gated, or already sitting with the human');
    // Triage duty still outranks idling: the carve-out must survive rewording.
    expect(out).toContain('question only the human can answer');
    expect(out).toContain('file children that each fit one iteration and close the parent as a plan');
    expect(out).toContain('Never leave ready work as found');
    expect(out).toContain('prevent that unchanged ticket waking it again');
  });

  it('quarantines a ticket after three silent declines and deduplicates the escalation (H-1071)', () => {
    const e = setup(`[loops.decline-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = 'echo no-disposition'
`);
    const id = seedTicket(e, 'Silently declined work');
    for (let n = 0; n < 3; n += 1) rev(e, ['run', 'decline-loop', '--count', '1']);
    let ticket = helm(e, ['get', id]) as { needs_human: boolean };
    expect(ticket.needs_human).toBe(true);
    let escalations = (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { title: string }[] }).tickets;
    expect(escalations.filter((t) => t.title.includes('silently declined')).length).toBe(1);
    const events = readFileSync(join(e.home, 'state', 'decline-loop', 'events.log'), 'utf8');
    expect(events).toMatch(new RegExp(`silent-decline\\s+tickets=${id} streaks=${id}:1`));
    expect(events).toMatch(/silent-decline-escalated/);

    helm(e, ['update', '--ticket', id, '--note', 'release for replay proof', '--no-needs-human']);
    rev(e, ['run', 'decline-loop', '--count', '1']);
    ticket = helm(e, ['get', id]) as { needs_human: boolean };
    expect(ticket.needs_human).toBe(true);
    escalations = (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { title: string }[] }).tickets;
    expect(escalations.filter((t) => t.title.includes('silently declined')).length).toBe(1);
  });

  it('a real disposition resets silent-decline tracking (H-1071)', () => {
    const e = setup(`[loops.disposition-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = '''
ID=$(node ${HELM_CLI} list --ready --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
node ${HELM_CLI} update --ticket $ID --note "requires a human sitting" --needs-human
'''
`);
    seedTicket(e, 'Disposed work');
    rev(e, ['run', 'disposition-loop', '--count', '1']);
    const events = readFileSync(join(e.home, 'state', 'disposition-loop', 'events.log'), 'utf8');
    expect(events).not.toMatch(/silent-decline\s/);
  });

  it('evidence-only update counts as production — why the idle instruction has to exist (H-740)', () => {
    // The constraint the instruction compensates for. H-412 stopped a note-only
    // update re-certifying a loop as busy, but attaching evidence IS a real
    // diff, so an honest "still blocked, base still green" pass clears helmo's
    // advancing filter and buys another full-price iteration. Narrowing the
    // filter is the wrong fix (a commit proving a build green is exactly what a
    // ticket should carry) — so this stays true, and the prompt does the work.
    // If it ever goes false, the instruction above can be relaxed.
    const e = setup(`[loops.eviloop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = '''
set -e
ID=$(node ${HELM_CLI} list --workstream rev-test --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
node ${HELM_CLI} update --ticket $ID --note "still blocked; base still green" --evidence-kind commit --evidence-ref repo@abc1234
'''
`);
    seedTicket(e, 'Blocked on a human');
    rev(e, ['run', 'eviloop', '--count', '1']);
    const events = readFileSync(join(e.home, 'state', 'eviloop', 'events.log'), 'utf8');
    expect(events).toMatch(/run-end\s+iter=1 .*produced=true .*action=continue/);
    expect(existsSync(join(e.home, 'state', 'eviloop', 'IDLE'))).toBe(false);
  });

  it("store-wide loop ('*', H-92) draws work from any workstream under the wildcard prompt", () => {
    const e = setup(`[loops.judge]
workstream = "*"
cwd = "/tmp"
runtime = "mock"
mock_cmd = '''
set -e
echo "PROMPT:$REV_PROMPT"
ID=$(node ${HELM_CLI} list --ready --limit 1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.tickets[0]?.id??'')})")
if [ -n "$ID" ]; then
  node ${HELM_CLI} update --ticket $ID --note "judged by mock" --status in_progress
  node ${HELM_CLI} update --ticket $ID --note "disposed by mock" --status done --evidence-kind file --evidence-ref /tmp/out
fi
'''
`);
    // Work lives in a workstream no loop is scoped to: only a '*' loop sees it.
    const id = (helm(e, ['create', '--title', 'Filed far away', '--body', 'x', '--workstream', 'elsewhere', '--type', 'ops']) as { id: string }).id;
    const out = rev(e, ['run', 'judge', '--count', '2']);
    expect(out).toContain("PROMPT:This is a Rev loop iteration, not a summon; AGENTS.md's summon clause does not apply; the queue is the work.");
    expect(out).toContain('across all workstreams'); // the wildcard prompt, not a stream's
    expect(out).toContain('file children that each fit one iteration and close the parent as a plan');
    expect(out).toContain('Never leave ready work as found');
    expect(out).toContain('For this store-wide sweep, a disposition note is action');
    expect((helm(e, ['get', id]) as { status: string }).status).toBe('done');
    expect(existsSync(join(e.home, 'state', 'judge', 'IDLE'))).toBe(true);
  });

  it("store-wide loop ('*', H-92) wakes on motion only — standing backlog never wakes it", async () => {
    // Echo-only mock: never claims, so ready backlog stays standing when the
    // loop idles. A scoped loop would wake on ready_count>0 every poll; the
    // whole store's backlog would do that to a '*' loop forever.
    const e = setup(`[loops.judge]
workstream = "*"
cwd = "/tmp"
runtime = "mock"
mock_cmd = 'echo "PROMPT:$REV_PROMPT"'
`);
    helm(e, ['create', '--title', 'Standing backlog', '--body', 'x', '--workstream', 'elsewhere', '--type', 'ops']);
    rev(e, ['run', 'judge', '--count', '1']); // one no-production iteration -> IDLE at cursor, backlog still ready
    expect(existsSync(join(e.home, 'state', 'judge', 'IDLE'))).toBe(true);
    const eventsBefore = readFileSync(join(e.home, 'state', 'judge', 'events.log'), 'utf8');
    const polled = instrumentSuccessfulWakeChecks(e);
    const child = spawn('npx', ['tsx', REV_CLI, 'run', 'judge', '--count', '1'], {
      env: e.env, cwd: join(import.meta.dirname, '..'), stdio: 'ignore',
    });
    try {
      await waitForFile(polled);
      expect(child.exitCode, 'loop exited after a motion-less successful poll').toBeNull();
      const eventsAfter = readFileSync(join(e.home, 'state', 'judge', 'events.log'), 'utf8');
      expect(eventsAfter.slice(eventsBefore.length)).not.toMatch(/wake/);
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
      }
    }
  });

  it('repeated failure hits the cap, sets BLOCKED, and escalates into the Helm queue', () => {
    const e = setup(`[loops.bad-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "exit 1"
`);
    seedTicket(e, 'Work the bad loop will fail at');
    const out = rev(e, ['run', 'bad-loop', '--count', '5']);
    expect(out).toContain('BLOCKED');

    expect(existsSync(join(e.home, 'state', 'bad-loop', 'BLOCKED'))).toBe(true);
    // The escalation is a real awaiting_human ticket, filed by the rev actor.
    const q = helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { title: string }[] };
    expect(q.tickets.some((t) => t.title.includes("Loop 'bad-loop'"))).toBe(true);
  });

  it('resume restores the retry budget; a re-block does not file a duplicate escalation (H-401)', () => {
    const e = setup(`[loops.bad-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = "exit 1"
`);
    seedTicket(e, 'Work the bad loop will fail at');
    rev(e, ['run', 'bad-loop', '--count', '5']);
    expect(existsSync(join(e.home, 'state', 'bad-loop', '.fail_streak'))).toBe(true);

    rev(e, ['resume', 'bad-loop']);
    // The resume is a statement the cause was looked at: full budget back.
    expect(existsSync(join(e.home, 'state', 'bad-loop', '.fail_streak'))).toBe(false);

    const out = rev(e, ['run', 'bad-loop', '--count', '5']);
    expect(out).toContain('already open; not filing another');
    const escalations = (helm(e, ['list', '--status', 'awaiting_human']) as { tickets: { title: string }[] }).tickets
      .filter((t) => t.title.includes("Loop 'bad-loop'"));
    expect(escalations.length).toBe(1);
  });

  it('STOP halts before any iteration; apparatus fault fails closed', () => {
    const e = setup(`[loops.app-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "claude"
model = "claude-sonnet-5"
constitution = "constitutions/missing.md"
`);
    mkdirSync(join(e.home, 'state', 'app-loop'), { recursive: true });
    writeFileSync(join(e.home, 'state', 'app-loop', 'STOP'), '');
    const stopped = rev(e, ['run', 'app-loop']);
    expect(stopped).toContain('STOP present');

    // Clear STOP: with ready work, the missing constitution must fail closed.
    seedTicket(e, 'Constitution is missing');
    rev(e, ['resume', 'app-loop']);
    const out = rev(e, ['run', 'app-loop', '--count', '1']);
    expect(out).toContain('BLOCKED');
    expect(readFileSync(join(e.home, 'state', 'app-loop', 'BLOCKED'), 'utf8')).toContain('apparatus');
  });

  it('survives a wake-check failure instead of dying with it (H-134)', () => {
    // A locked store used to kill the loop process outright: helm-cli threw,
    // nothing caught it, and the supervisor found a corpse. A failed poll is
    // transient — the loop must log it and try again on the next one.
    //
    // THIS TEST PRINTS `{"error":"SqliteError: database is locked"}` AND
    // `rev: wake-check failed for 'flaky-loop'` ON A PASSING RUN. Both are the
    // point: the first is the shim below writing what a locked store writes,
    // the second is the loop noticing it and carrying on. An R-11 proof review
    // read them as a symptom and filed them (H-865); they are the alarm
    // ringing. Do not silence either — the loop logging a failed poll is the
    // behaviour under test, and a run that printed nothing here would be a
    // run where the shim never fired.
    const e = setup(`[loops.flaky-loop]
workstream = "rev-test"
cwd = "/tmp"
runtime = "mock"
mock_cmd = '''
echo "rev-mock-usage tokens=10 cost_usd=0.01"
'''
`);
    seedTicket(e, 'Work behind a briefly locked store');

    // A helm-cli stand-in that fails its first call the way a locked store
    // does, then delegates every later call to the real one.
    const shim = join(e.home, 'flaky-helm.cjs');
    const counter = join(e.home, 'calls');
    writeFileSync(
      shim,
      `const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const n = fs.existsSync(${JSON.stringify(counter)}) ? parseInt(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'), 10) : 0;
fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
if (n === 0) { process.stderr.write('{"error":"SqliteError: database is locked"}\\n'); process.exit(1); }
process.stdout.write(execFileSync('node', [${JSON.stringify(HELM_CLI)}, ...process.argv.slice(2)], { encoding: 'utf8' }));
`,
    );
    writeFileSync(
      join(e.home, 'roster.toml'),
      readFileSync(join(e.home, 'roster.toml'), 'utf8').replace(HELM_CLI, shim),
    );

    const out = rev(e, ['run', 'flaky-loop', '--count', '1']);

    const events = readFileSync(join(e.home, 'state', 'flaky-loop', 'events.log'), 'utf8');
    expect(events).toMatch(/wake-check-failed/); // the failure was recorded, not swallowed
    expect(out).toContain('run 1 started'); // and the loop went on to work
    expect(events).toMatch(/run-end/);
  });
});
