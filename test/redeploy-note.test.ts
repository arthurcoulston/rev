// The landing note a redeploy writes on the ticket that asked for it (H-1118).
//
// Five redeploys in one day logged `redeploy-note-failed` and the note never
// arrived. The reason recorded was `Error: Command failed: node .../cli.js
// update ...` — the command line and nothing else — which read as Rev calling
// Helm without an identity. It was not: every one of those five tickets was
// already `done`, because the loop that asks for a redeploy closes its work
// before the drain it asked for lands, and Helm refuses writes on a terminal
// ticket by design. These run against a real Helm store, so a refusal here is
// Helm's own and not a stub's idea of one.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELMO_CLI } from './helmo.js';
import { GlobalConfig } from '../src/types.js';

const home = mkdtempSync(join(tmpdir(), 'rev-redeploy-note-'));
process.env.REV_HOME = home; // before sentinels reads it
const { reportRedeployLanded, eventsPath } = await import('../src/redeploy.js');

const db = join(home, 'helm.db');
const g = { helmo_cli: HELMO_CLI, helmo_db: db } as GlobalConfig;
const request = { by: 'shipper', reason: 'activate the fix this iteration landed', requested_at: '2026-09-07T09:40:00.000Z' };

/** Seeded by one agent and worked by another, because Helm withholds a ticket
 *  from the agent that filed it until a second pair of eyes touches it. The
 *  seat stamp in `session` is what makes a claim a loop's rather than a desk's,
 *  which Helm also requires. */
function helm(args: string[], who = 'seeder'): Record<string, unknown> {
  return JSON.parse(execFileSync('node', [HELMO_CLI, ...args], {
    env: { ...process.env, HELMO_DB: db, HELMO_ACTOR: `{"name":"${who}","kind":"agent","model":"t","version":"0","session":"rev:${who}"}` },
    encoding: 'utf8',
  })) as Record<string, unknown>;
}

function seed(): string {
  return (helm(['create', '--title', 'a fix in rev itself', '--body', 'x', '--workstream', 'ws-ship', '--type', 'build']) as { id: string }).id;
}

/** Only the lines this call added, so an earlier test's events cannot pass for
 *  a later one's. */
function newEvents(before: number): string {
  return readFileSync(eventsPath(), 'utf8').slice(before);
}

function sizeOfEvents(): number {
  try { return readFileSync(eventsPath(), 'utf8').length; } catch { return 0; }
}

describe('the landing note on the ticket that asked for the redeploy', () => {
  it('lands on a live ticket, with the events.log as its evidence', () => {
    const id = seed();
    helm(['update', '--ticket', id, '--note', 'claimed', '--status', 'in_progress'], 'shipper');
    const before = sizeOfEvents();

    reportRedeployLanded(g, { ...request, ticket: id }, 4242);

    const t = helm(['get', id]) as { evidence: { ref: string }[] };
    expect(t.evidence.map((x) => x.ref)).toContain(eventsPath());
    const events = newEvents(before);
    expect(events).toMatch(/redeploy-done\s+by=shipper/);
    expect(events).not.toContain('redeploy-note-failed');
  });

  it('records a closed ticket as a skip, not a failure — the record staying permanent is not a fault', () => {
    const id = seed();
    helm(['update', '--ticket', id, '--note', 'claimed', '--status', 'in_progress'], 'shipper');
    helm(['update', '--ticket', id, '--note', 'the fix is committed and tested', '--status', 'done'], 'shipper');
    const before = sizeOfEvents();

    reportRedeployLanded(g, { ...request, ticket: id }, 4243);

    const events = newEvents(before);
    expect(events).toContain(`redeploy-note-skipped ticket=${id} is done`);
    expect(events).not.toContain('redeploy-note-failed');
    // The landing is still recorded; it is the note that had nowhere to go.
    expect(events).toMatch(/redeploy-done\s+by=shipper/);
  });

  it('a real failure carries what Helm said, not just the command line', () => {
    const before = sizeOfEvents();

    reportRedeployLanded(g, { ...request, ticket: 'H-999999' }, 4244);

    const events = newEvents(before);
    const line = events.split('\n').find((l) => l.includes('redeploy-note-failed'))!;
    expect(line).toContain('H-999999');
    // The store's own words. Without them the line is `Error: Command failed:
    // node .../cli.js get H-999999` — true, and useless.
    expect(line).toMatch(/H-999999/);
    expect(line).not.toContain('Command failed');
  });
});
