// Redeploying the fleet to activate rev's own committed, tested fix is the
// crew's call, never a question for the operator (Arthur, H-1046). A loop that
// lands such a fix cannot activate it from inside its own iteration: the
// supervisor and every live loop driver hold the old code until they restart,
// and a restart run mid-iteration races the service manager's 60s drain
// ceiling (H-877) with the requester's own session in the blast — which is
// exactly why the loop that hit it asked a human instead.
//
// So the ask is a sentinel. The supervisor honours it at its next poll with an
// ordinary graceful drain — in-flight iterations finish their close-out, the
// drain is in events.log like any other — and then exits UNSUCCESSFULLY,
// because that is the only exit launchd and systemd bring back (service.ts).
// The supervisor that returns is the new code. It clears the sentinel at
// startup and notes the landing on the requesting ticket; a detached watch
// says so out loud if no supervisor ever returns.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { stateDir } from './config.js';
import { notifyOperator } from './health.js';
import { cliError, redeployFailed, redeployLanded, ticketStatus } from './helm.js';
import { logEvent, pidAlive, sGet, sSet } from './sentinels.js';
import { GlobalConfig } from './types.js';

const SUP = 'supervisor';

/** Never 0: launchd's KeepAlive and systemd's Restart=on-failure only bring
 *  back an unsuccessful exit, and a redeploy that stays down is an outage. */
export const REDEPLOY_EXIT = 75;

export interface RedeployRequest {
  by: string;
  reason: string;
  ticket?: string;
  requested_at: string;
}

/** One key=value per line, like BACKOFF and WEDGED — a human reading the state
 *  dir during an outage should need nothing but `cat`. */
function serialize(r: RedeployRequest): string {
  const line = (s: string) => s.replace(/\s+/g, ' ').trim();
  return [
    `by=${line(r.by)}`,
    `ticket=${r.ticket ?? ''}`,
    `requested_at=${r.requested_at}`,
    `reason=${line(r.reason)}`,
    '',
  ].join('\n');
}

export function readRedeploy(): RedeployRequest | null {
  const raw = sGet(SUP, 'REDEPLOY');
  if (raw === null) return null;
  const f = new Map(
    raw.split('\n').filter(Boolean).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)] as [string, string];
    }),
  );
  return {
    by: f.get('by') || 'unknown',
    reason: f.get('reason') || 'no reason recorded',
    ticket: f.get('ticket') || undefined,
    requested_at: f.get('requested_at') || new Date().toISOString(),
  };
}

export function requestRedeploy(r: RedeployRequest): void {
  sSet(SUP, 'REDEPLOY', serialize(r));
  logEvent(SUP, 'redeploy-ask', `by=${r.by} ticket=${r.ticket ?? '-'} ${r.reason}`.slice(0, 300));
}

export function eventsPath(): string {
  return join(stateDir(SUP), 'events.log');
}

/** Report a landing on the requesting ticket. Best-effort by design: the
 *  ticket may have been closed by the loop that asked (Helmo refuses updates on
 *  terminal tickets, rightly), and the landing is on the events.log the request
 *  attached either way. A failed note must never affect the fleet coming up.
 *
 *  A closed ticket is the ordinary case, not a fault: the asking loop finishes
 *  its close-out before the drain it asked for lands, so it is done by the time
 *  a supervisor is back to write. Every note lost before H-1118 was that, and
 *  logging them as failures — with only the command line for a reason — read
 *  for a day as a Helm identity Rev was not sending. Ask the store first, so
 *  the permanent record staying permanent is recorded as the skip it is, and
 *  anything left in the failure branch is a real one with the store's own
 *  words attached. */
export function reportRedeployLanded(g: GlobalConfig, r: RedeployRequest, pid: number): void {
  logEvent(SUP, 'redeploy-done', `by=${r.by} ticket=${r.ticket ?? '-'} pid=${pid} asked=${r.requested_at}`);
  if (!r.ticket) return;
  try {
    const status = ticketStatus(g, r.ticket);
    if (status === 'done' || status === 'cancelled') {
      logEvent(SUP, 'redeploy-note-skipped', `ticket=${r.ticket} is ${status}; the landing stands in the redeploy-done line above`);
      return;
    }
    redeployLanded(g, r.ticket, r, pid, eventsPath());
  } catch (e) {
    logEvent(SUP, 'redeploy-note-failed', `ticket=${r.ticket} ${cliError(e)}`.slice(0, 300));
  }
}

/** Arm the watch that speaks when nothing comes back. Detached and unref'd:
 *  its whole job is to outlive the supervisor that spawned it. Re-invokes this
 *  same entry (dist/cli.js, or the .ts under tsx in dev), as the supervisor
 *  does for its loop drivers. */
export function armRedeployWatch(g: GlobalConfig): void {
  const deadline = g.redeploy_deadline_seconds;
  if (deadline <= 0) return;
  try {
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1]!, 'redeploy-watch', '--deadline', String(deadline)],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    logEvent(SUP, 'redeploy-watch', `pid=${child.pid} deadline=${deadline}s`);
  } catch (e) {
    logEvent(SUP, 'redeploy-watch-failed', String(e).slice(0, 200));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The watch itself. Success is the new supervisor clearing the sentinel AND
 *  being alive — either alone would pass on a corpse. Past the deadline the
 *  fleet is down and nobody is running to notice: alarm out of band, then put
 *  it in front of the human with the failure named. */
export async function watchRedeploy(g: GlobalConfig, deadlineSeconds: number): Promise<boolean> {
  const req = readRedeploy();
  if (!req) return true; // already landed, before this watch drew breath
  const until = Date.now() + deadlineSeconds * 1000;
  while (Date.now() < until) {
    await sleep(2000);
    if (readRedeploy() === null && pidAlive(SUP)) return true;
  }
  const detail =
    `no supervisor returned within ${deadlineSeconds}s of the drain (requested ${req.requested_at} by ${req.by}: ${req.reason})`;
  logEvent(SUP, 'redeploy-failed', detail.slice(0, 300));
  console.error(`rev: redeploy failed — ${detail}. The fleet is down.`);
  notifyOperator('Rev: redeploy failed', 'The fleet drained to redeploy and no supervisor came back. No work is being drawn.');
  try {
    redeployFailed(g, req, detail);
  } catch (e) {
    logEvent(SUP, 'redeploy-alarm-failed', String(e).slice(0, 200));
  }
  return false;
}
