// End-to-end: a mock-runtime loop against a real (temp) Helm store, via the
// real helm-cli. Proves the full circle: wake on cursor → session claims and
// completes a ticket through Helm → produced-check → idle → escalation on
// repeated failure. No agent CLI, no tokens.
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELM = join(import.meta.dirname, '..', '..', 'helmo');
const HELM_CLI = join(HELM, 'dist', 'cli.js');
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
helmo_mcp_server = "${join(HELM, 'dist', 'server.js')}"
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

describe('rev e2e (mock runtime, real helm store)', () => {
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
  node ${HELM_CLI} update --ticket $ID --note "completed by mock" --status done --evidence-kind file --evidence-ref /tmp/out
  echo "rev-mock-usage tokens=1200 cost_usd=0.25"
fi
'''
`);
    const id = seedTicket(e, 'Mock work item');
    const out = rev(e, ['run', 'test-loop', '--count', '2']);
    expect(out).toContain('run 1 started');

    const ticket = helm(e, ['get', id]) as { status: string; evidence: unknown[]; tokens_total: number; cost_usd_total: number };
    expect(ticket.status).toBe('done');
    expect(ticket.evidence.length).toBe(1);

    // H-19: the session's metered spend landed on the ticket it worked —
    // written by the rev actor AFTER the mock closed it.
    expect(ticket.tokens_total).toBe(1200);
    expect(ticket.cost_usd_total).toBeCloseTo(0.25);
    expect(readFileSync(join(e.home, 'token-log'), 'utf8')).toContain('tokens=1200 cost_usd=0.25');

    // Second iteration produced nothing -> loop idles at the cursor.
    const idle = join(e.home, 'state', 'test-loop', 'IDLE');
    expect(existsSync(idle)).toBe(true);
    const events = readFileSync(join(e.home, 'state', 'test-loop', 'events.log'), 'utf8');
    expect(events).toMatch(/run-end.*produced=true/);
    expect(events).toMatch(new RegExp(`spend\\s+iter=1 ticket=${id} tokens=1200 cost=0\\.25`));
    expect(events).toMatch(/action=idle/);
  });

  it('a note-only session is not production — the loop idles instead of running on (H-412)', () => {
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
    rev(e, ['run', 'note-loop', '--count', '3']);

    const dir = join(e.home, 'state', 'note-loop');
    const events = readFileSync(join(dir, 'events.log'), 'utf8');
    expect(events).toMatch(/run-end.*iter=1.*produced=false.*action=idle/);
    expect(existsSync(join(dir, 'IDLE'))).toBe(true);

    // Every pass idles; none is scored as production, so none skips the gate.
    expect(events).not.toMatch(/action=continue/);

    // What this does NOT fix, and the reason there are wakes here at all: the
    // seeded ticket stays ready because the mock never claims it, and a scoped
    // loop's wake gate fires on `ready_count > 0` alone. So a ready ticket the
    // agent keeps declining still re-wakes it each poll. Latent rather than
    // observed — ward's traces show idles landing on genuinely empty queues —
    // and it belongs to the wake gate, not to what counts as production.
    expect((events.match(/wake\s/g) ?? []).length).toBeGreaterThan(0);
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
    expect(out).toContain('across all workstreams'); // the wildcard prompt, not a stream's
    expect((helm(e, ['get', id]) as { status: string }).status).toBe('done');
    expect(existsSync(join(e.home, 'state', 'judge', 'IDLE'))).toBe(true);
  });

  it("store-wide loop ('*', H-92) wakes on motion only — standing backlog never wakes it", () => {
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
    try {
      execFileSync('npx', ['tsx', REV_CLI, 'run', 'judge', '--count', '1'], {
        env: e.env, encoding: 'utf8', cwd: join(import.meta.dirname, '..'), timeout: 4000,
      });
      expect.unreachable('a motion-less start must stay idle until killed');
    } catch {
      /* killed while idling: expected */
    }
    const eventsAfter = readFileSync(join(e.home, 'state', 'judge', 'events.log'), 'utf8');
    expect(eventsAfter.slice(eventsBefore.length)).not.toMatch(/wake/);
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
