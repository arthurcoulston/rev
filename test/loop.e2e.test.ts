// End-to-end: a mock-runtime loop against a real (temp) Helm store, via the
// real helm-cli. Proves the full circle: wake on cursor → session claims and
// completes a ticket through Helm → produced-check → idle → escalation on
// repeated failure. No agent CLI, no tokens.
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
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
});
