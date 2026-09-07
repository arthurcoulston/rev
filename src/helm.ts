// Rev's only knowledge of Helm: the helm-cli subprocess contract.
// Deliberately a subprocess, not a library import — the CLI is Helm's public
// programmatic surface, and consuming it keeps that contract honest.
import { execFileSync } from 'node:child_process';
import { GlobalConfig, LoopConfig } from './types.js';

export interface WakeCheck {
  max_seq: number;
  ready_count: number;
  /** in_progress tickets in the loop's own hands — absent from a helmo that
   *  predates it, and absent for store-wide loops (no assignee in scope). */
  held_count?: number;
  changed_since: boolean;
}

export function readyTicketIds(g: GlobalConfig, l: LoopConfig): string[] {
  if (l.workstream === '*') return [];
  const list = (args: string[]) => (run(g, ['list', '--ready', ...args, '--limit', '100'], loopActor(l)) as { tickets: { id: string }[] }).tickets;
  return [...new Set([
    ...list(['--workstream', l.workstream]),
    ...list(['--assignee', l.name]),
  ].map((t) => t.id))];
}

export interface WorkstreamInfo {
  name: string;
  goal: string | null;
  budget_usd: number | null;
  spent_usd: number;
  remaining_usd: number | null;
}

function run(g: GlobalConfig, args: string[], actor?: object): unknown {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (g.helmo_db) env['HELMO_DB'] = g.helmo_db;
  if (actor) env['HELMO_ACTOR'] = JSON.stringify(actor);
  const out = execFileSync('node', [g.helmo_cli, ...args], { env, encoding: 'utf8' });
  return JSON.parse(out);
}

// The seat stamp (H-558): every write a loop session makes carries this in the
// actor's session field, so a claim's provenance says WHICH live instance of a
// crew name holds it — the loop's own iterations, or a desk/subagent sharing
// the name. seatDecide compares against it.
export function seatId(l: LoopConfig): string {
  return `rev:${l.name}`;
}

// The actor's model field is the model actually running the session — a probe
// iteration on the small tier must not sign the record as the working model.
export function loopActor(l: LoopConfig, model?: string): object {
  return { name: l.name, kind: 'agent', model: model ?? l.model, version: l.version, session: seatId(l) };
}

export interface SeatHold {
  ticket_id: string;
  claim_actor: { session?: string } | null;
  claimed_at: string | null;
}

export function seatHolds(g: GlobalConfig, l: LoopConfig): SeatHold[] {
  return (run(g, ['seat-check', '--assignee', l.name]) as { holds: SeatHold[] }).holds;
}

export function revActor(): object {
  return { name: 'rev', kind: 'agent', model: 'rev-harness', version: '0.1.0' };
}

/** Human-readable scope for logs and escalations: '*' loops watch the whole store. */
export function scopeLabel(l: LoopConfig): string {
  return l.workstream === '*' ? 'all workstreams' : `workstream '${l.workstream}'`;
}

export function wakeCheck(g: GlobalConfig, l: LoopConfig, sinceSeq: number): WakeCheck {
  // workstream '*' (store-wide loops, H-92): no scope filter — any event wakes.
  // The assignee must drop with it: Helm ORs the scope clauses, so keeping it
  // narrows the whole store back down to tickets already assigned, and fresh
  // filings — the wake signal these loops exist for — never land (H-138).
  const scope =
    l.workstream === '*' ? [] : ['--workstream', l.workstream, '--assignee', l.name];
  return run(g, ['wake-check', ...scope, '--since-seq', String(sinceSeq)]) as WakeCheck;
}

// Steering disclosure (helmo H-55): the goal and remaining budget go into
// every iteration prompt. Failure here must never stop the loop — steering
// is guidance, and a loop that halts because guidance was unreadable has
// inverted the priority.
export function workstreamInfo(g: GlobalConfig, name: string): WorkstreamInfo | null {
  try {
    return run(g, ['workstream', '--name', name]) as WorkstreamInfo;
  } catch {
    return null;
  }
}

// "Did the agent advance anything?" — not "did it write anything" (H-412).
// --advancing drops note-only updates, so a session whose whole output was
// "still blocked, nothing to do" scores unproductive and the loop idles at the
// cursor instead of buying itself another iteration. Ward's cheapest passes
// were exactly that shape.
// Which workstreams this seat actually has work in: its claims and the work
// reserved to it, which is not the same as the stream it watches (H-954).
// Steering read only the watched stream, so a seat holding work routed in from
// elsewhere was told a goal that did not describe it — "if the goal is already
// met, closing out is the right move" and all. Failure returns nothing for the
// same reason workstreamInfo's does: guidance must never stop the loop.
export function seatStreams(g: GlobalConfig, l: LoopConfig): string[] {
  try {
    const rows = ['in_progress', 'open'].flatMap(
      (status) =>
        (run(g, ['list', '--assignee', l.name, '--status', status, '--limit', '100']) as {
          tickets: { workstream: string }[];
        }).tickets,
    );
    return [...new Set(rows.map((t) => t.workstream))];
  } catch {
    return [];
  }
}

export function actorActivity(g: GlobalConfig, l: LoopConfig, sinceSeq: number): number {
  return (run(g, ['actor-activity', '--name', l.name, '--session', seatId(l), '--since-seq', String(sinceSeq), '--advancing']) as { events: number }).events;
}

export function actorTickets(g: GlobalConfig, l: LoopConfig, sinceSeq: number): { id: string; events: number }[] {
  return (run(g, ['actor-tickets', '--name', l.name, '--session', seatId(l), '--since-seq', String(sinceSeq)]) as { tickets: { id: string; events: number }[] }).tickets;
}

export interface SelfSpend {
  tokens: number;
  cost_usd: number;
  /** The same figures split by the ticket that carries each guess (H-187). */
  by_ticket: { id: string; tokens: number; cost_usd: number }[];
}

export function actorSelfSpend(g: GlobalConfig, l: LoopConfig, sinceSeq: number): SelfSpend {
  const r = run(g, ['actor-spend', '--name', l.name, '--session', seatId(l), '--since-seq', String(sinceSeq)]) as SelfSpend;
  return { ...r, by_ticket: r.by_ticket ?? [] };
}

// Spend is written by Rev (the meter), not the loop's agent — the agent
// never saw its own usage, and the provenance should say who measured.
export function recordSpend(g: GlobalConfig, ticketId: string, tokens: number | undefined, cost: number | undefined, note: string): void {
  const args = ['record-spend', '--ticket', ticketId, '--note', note];
  if (tokens) args.push('--tokens', String(tokens));
  if (cost) args.push('--cost-usd', String(cost));
  run(g, args, revActor());
}

// The standing escalation for a loop, if one exists. Re-escalating while the
// first is unanswered files duplicate summonses — three loops × repeated
// resumes produced six open tickets for two underlying events (H-401).
export function openEscalation(g: GlobalConfig, l: LoopConfig): string | null {
  const title = escalationTitle(l);
  for (const status of ['awaiting_human', 'open', 'in_progress']) {
    const res = run(g, ['list', '--workstream', g.escalation_workstream, '--status', status, '--limit', '100']) as {
      tickets: { id: string; title: string }[];
    };
    const hit = res.tickets.find((t) => t.title === title);
    if (hit) return hit.id;
  }
  return null;
}

interface EscalationState {
  id: string;
  status: string;
  last_answer: { resolution: string } | null;
}

/** An answered resume is process-control input, not work for the halted seat. */
export function answeredResumeEscalation(g: GlobalConfig, l: LoopConfig): string | null {
  const id = openEscalation(g, l);
  if (!id) return null;
  const ticket = run(g, ['get', id]) as EscalationState;
  return ticket.status === 'open' && ticket.last_answer?.resolution === 'resume' ? id : null;
}

export function completeAnsweredResume(g: GlobalConfig, ticketId: string, runningPath: string): void {
  run(g, [
    'update', '--ticket', ticketId,
    '--note', 'Rev applied the human resume answer; the supervisor restarted the loop and confirmed it stayed running.',
    '--status', 'done', '--confidence', 'routine',
    '--evidence-kind', 'file', '--evidence-ref', runningPath,
  ], revActor());
}

export function failAnsweredResume(g: GlobalConfig, l: LoopConfig, ticketId: string, detail: string): void {
  run(g, [
    'return', '--ticket', ticketId,
    '--situation', `Rev applied the human resume answer for loop '${l.name}', but the restarted worker failed before it was healthy: ${detail}. The loop is blocked again.`,
    '--question', `Should loop '${l.name}' be investigated before another restart?`,
    '--recommendation', 'investigate — the requested restart was attempted and immediately failed, so repeating it would be a blind retry',
    '--if-unanswered', `${scopeLabel(l)} has no '${l.name}' worker until the new failure is resolved`,
  ], revActor());
}

function escalationTitle(l: LoopConfig): string {
  return `Loop '${l.name}' is blocked: needs a decision`;
}

/** The landing note for a redeploy the crew decided on its own (H-1046). The
 *  evidence is the supervisor's events.log, because that file is where the
 *  drain and the fleet-start that answered it both live. */
export function redeployLanded(
  g: GlobalConfig, ticketId: string, r: { by: string; reason: string }, pid: number, eventsPath: string,
): void {
  run(g, [
    'update', '--ticket', ticketId,
    '--note',
    `Rev redeployed the fleet to activate this work: the supervisor drained, the service manager started it again on the new code, and it is running as pid ${pid}. Asked for by ${r.by} — ${r.reason}.`,
    '--evidence-kind', 'file', '--evidence-ref', eventsPath,
  ], revActor());
}

/** A redeploy that never came back is a total outage, and the loops that would
 *  have noticed are exactly what is missing. Always a FRESH ticket: the
 *  requesting one may be closed, and returning a live one would release a claim
 *  its holder still has work in. */
export function redeployFailed(g: GlobalConfig, r: { by: string; reason: string; ticket?: string }, detail: string): void {
  const created = run(g, [
    'create',
    '--title', 'The fleet drained to redeploy and no supervisor came back',
    '--body',
    `Rev drained the fleet to activate a fix, and no supervisor returned: ${detail}.\n\n` +
      `Asked for by ${r.by}${r.ticket ? ` while working ${r.ticket}` : ''} — ${r.reason}.\n\n` +
      `Nothing is drawing work until a supervisor is running. Check: rev status, then the supervisor's events.log ` +
      `and the service log; start the machine with 'rev service start' (or 'rev run').`,
    '--workstream', g.escalation_workstream,
    '--type', 'ops',
    '--priority', '0',
  ], revActor()) as { id: string };
  run(g, [
    'return', '--ticket', created.id,
    '--situation', `The fleet drained to redeploy${r.ticket ? ` for ${r.ticket}` : ''} and no supervisor came back: ${detail}. Every loop is down.`,
    '--question', 'Start the machine by hand, or is the new build broken?',
    '--recommendation', "start it — 'rev service start' brings the supervisor back; if it exits again, the build that was deployed is the suspect",
    '--if-unanswered', 'No loop draws any work until a supervisor is running.',
  ], revActor());
}

// A BLOCKED loop is a summons, not a log line: file it straight into the
// awaiting-human queue so the operator's existing dashboard and meeting see it.
export function escalateBlocked(g: GlobalConfig, l: LoopConfig, reason: string, outputTail: string, stateDir: string): string {
  const created = run(
    g,
    [
      'create',
      '--title', escalationTitle(l),
      '--body',
      `Rev halted loop '${l.name}' (${scopeLabel(l)}). Reason: ${reason}.\n\nState dir: ${stateDir} (events.log has the trace; console tail below).\nTo resume after fixing: remove the BLOCKED sentinel and run \`rev run ${l.name}\`.\n\nLast session output:\n${outputTail.slice(-1500)}`,
      '--workstream', g.escalation_workstream,
      '--type', 'ops',
      '--priority', '1',
    ],
    revActor(),
  ) as { id: string };
  run(
    g,
    [
      'return',
      '--ticket', created.id,
      '--situation', `Loop '${l.name}' halted itself: ${reason}. The loop stays down until a human decides; no work in ${scopeLabel(l)} is being drawn.`,
      '--question', `How should loop '${l.name}' proceed?`,
      '--options', JSON.stringify([
        { label: 'resume', consequence: 'clear BLOCKED and restart the loop as-is (right if the cause was external and has passed)' },
        { label: 'hold', consequence: 'leave the loop down deliberately (converts to an intended HOLD)' },
        { label: 'investigate', consequence: 'a human or agent digs into the trace before any restart' },
      ]),
      '--recommendation', reason.includes('transient') ? 'resume — the condition was external and has likely lifted' : 'investigate — consecutive failures usually mean something real',
      '--if-unanswered', `${scopeLabel(l)} has no '${l.name}' worker until this is answered`,
    ],
    revActor(),
  );
  return created.id;
}

const silentDeclineTitle = (l: LoopConfig) => `Loop '${l.name}' silently declined ready work three times`;

export function escalateSilentDeclines(g: GlobalConfig, l: LoopConfig, ids: string[]): string {
  let standing: string | null = null;
  for (const status of ['awaiting_human', 'open', 'in_progress']) {
    const rows = run(g, ['list', '--workstream', g.escalation_workstream, '--status', status, '--limit', '100']) as { tickets: { id: string; title: string }[] };
    standing = rows.tickets.find((t) => t.title === silentDeclineTitle(l))?.id ?? null;
    if (standing) break;
  }
  if (!standing) {
    standing = (run(g, ['create', '--title', silentDeclineTitle(l), '--body', `Rev observed three consecutive passes in which loop '${l.name}' left these ready tickets unchanged: ${ids.join(', ')}. The tickets are quarantined for a human sitting; the seat continues running.`, '--workstream', g.escalation_workstream, '--type', 'ops', '--priority', '1'], revActor()) as { id: string }).id;
    run(g, ['return', '--ticket', standing, '--situation', `Loop '${l.name}' left ready tickets ${ids.join(', ')} unchanged for three consecutive passes. Rev quarantined them instead of halting the seat.`, '--question', 'Should these tickets be rerouted, clarified, or released back to the seat?', '--recommendation', 'inspect the named tickets and the loop trace, then release only those whose next action is explicit', '--if-unanswered', 'The named tickets remain withheld from agent queues; the rest of the seat continues running.'], revActor());
  }
  for (const id of ids) run(g, ['update', '--ticket', id, '--note', `Rev quarantined this ticket after loop '${l.name}' left it ready and unchanged for three consecutive passes; escalation ${standing}.`, '--needs-human'], revActor());
  return standing;
}
