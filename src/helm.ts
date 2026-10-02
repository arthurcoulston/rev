// Rev's only knowledge of Helm: the helm-cli subprocess contract.
// Deliberately a subprocess, not a library import — the CLI is Helm's public
// programmatic surface, and consuming it keeps that contract honest.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadRoster } from './config.js';
import { notifyOperator } from './health.js';
import { processObservation, sHas } from './sentinels.js';
import { GlobalConfig, LoopConfig } from './types.js';
import type { LaunchReceipt } from './launch-journal.js';

export interface WakeCheck {
  max_seq: number;
  ready_count: number;
  /** in_progress tickets in the loop's own hands — absent from a helmo that
   *  predates it, and absent for store-wide loops (no assignee in scope). */
  held_count?: number;
  changed_since: boolean;
  newly_ready_count?: number;
  newly_ready_ids?: string[];
  ready_ids?: string[];
}

export function readyTicketIds(g: GlobalConfig, l: LoopConfig): string[] {
  if (l.workstream === '*') return [];
  const list = (args: string[]) => (run(g, ['list', '--ready', ...args, '--limit', '100'], loopActor(l)) as { tickets: { id: string }[] }).tickets;
  return [...new Set([
    ...list(['--workstream', l.workstream]),
    ...list(['--assignee', seatName(l)]),
  ].map((t) => t.id))];
}

export interface WorkstreamInfo {
  name: string;
  budget_usd: number | null;
  spent_usd: number;
  remaining_usd: number | null;
}

// `quiet` captures the child's stderr instead of letting it through to ours.
// execFileSync does both by default, which is right for a surprise and wrong
// for a refusal the caller expects and handles: the launch gate below asks on
// every iteration, and on a store without the command that forwarded Helmo's
// whole usage text into the loop's log once per pass.
function run(g: GlobalConfig, args: string[], actor?: object, quiet = false): unknown {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (g.helmo_db) env['HELMO_DB'] = g.helmo_db;
  if (actor) env['HELMO_ACTOR'] = JSON.stringify(actor);
  const out = execFileSync('node', [g.helmo_cli, ...args], quiet
    ? { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    : { env, encoding: 'utf8' });
  return JSON.parse(out);
}

// The seat stamp (H-558): every write a loop session makes carries this in the
// actor's session field, so a claim's provenance says WHICH live instance of a
// crew name holds it — the loop's own iterations, or a desk/subagent sharing
// the name. seatDecide compares against it.
export function seatId(l: LoopConfig): string {
  return `rev:${l.name}`;
}

/** Accountable role identity. The fallback keeps programmatic LoopConfig
 * callers compatible with the pre-worker-pool shape. */
export function seatName(l: LoopConfig): string {
  return l.seat ?? l.name;
}

// The actor's model field is the model actually running the session — a probe
// iteration on the small tier must not sign the record as the working model.
// A session override is for a consumer that is NOT the loop: a meeting room
// runs the seat's composed session but must not sign as `rev:<seat>`, or the
// seat guard above reads a meeting's write as the loop's own hold (H-1152).
// A pool worker's launch also names its generation, which is the launch id
// (H-574): Helmo binds the claim to that one attempt, so every write the
// session makes must carry it, and a retired generation writes nothing.
export function loopActor(l: LoopConfig, model?: string, session?: string, generation?: string): object {
  return { name: seatName(l), kind: 'agent', model: model ?? l.model, version: l.version, session: session ?? seatId(l), ...(generation ? { generation } : {}) };
}

export interface SeatHold {
  ticket_id: string;
  claim_actor: { session?: string } | null;
  claimed_at: string | null;
}

export function seatHolds(g: GlobalConfig, l: LoopConfig): SeatHold[] {
  return (run(g, ['seat-check', '--assignee', seatName(l)]) as { holds: SeatHold[] }).holds;
}

export function revActor(): object {
  return { name: 'rev', kind: 'agent', model: 'rev-harness', version: '0.2.0' };
}

/** One visible Builder assignment for an owned intake-preparation attempt. */
export function createIntakeAssignment(g: GlobalConfig, body: string): string {
  return (run(g, [
    'create', '--title', 'Prepare the claimed meeting intake', '--body', body,
    '--workstream', 'goodplumb', '--type', 'build', '--priority', '0',
    '--assignee', 'builder',
  ], revActor()) as { id: string }).id;
}

/** Why a helmo-cli call failed, in the store's own words. execFileSync's
 *  message is the command line and nothing else, so a caller that logs
 *  String(e) records what it ran and never what Helm said back — which is how
 *  a refusal on a closed ticket read for a day as a missing actor (H-1118).
 *  The CLI prints {"error": ...} to stderr and exits 1; that is the reason. */
export function cliError(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  const raw = String(err.stderr ?? '').trim();
  try {
    return String((JSON.parse(raw) as { error?: unknown }).error ?? raw);
  } catch {
    return raw || String(err.message ?? e);
  }
}

/** Workflow launch admission (H-2561, helmo H-471). Asked immediately before a
 *  session is spent: may this seat launch at all? A ready candidate bound to a
 *  workflow attempt may be started only once its requirements have passed, and
 *  only Helmo can read those decisions, record the admission and move the
 *  attempt in one transaction — so Rev asks rather than deciding, and keeps no
 *  verdict. The question is put again on every pass, which is what keeps a
 *  restart from walking through a denial it never saw.
 *
 *  Three of Helmo's four answers are a launch, and only one of them is a yes:
 *  `admitted: true` admits a candidate; `admitted: false` means there was
 *  nothing READY to gate, which is not a refusal — a seat still has its own
 *  held work and its probe pass, and whether to spend an iteration on them is
 *  Rev's decision, not Helmo's; and a store with no launch-admit command (an
 *  installation that predates the protocol) answers with usage text, which a
 *  gate must not read as a refusal or it stops every loop in the estate. Only
 *  a thrown `workflow_admission_denied` holds a launch back. */
export interface LaunchAdmission {
  act: 'launch' | 'deny';
  how: 'admitted' | 'nothing_gated' | 'denied' | 'unsupported' | 'unavailable';
  reason: string;
  ticketId: string | null;
  workflowAttemptId?: string;
  admissionId?: string;
  launchId?: string;
}

interface LaunchCandidate {
  id: string;
  workflowAttemptId: string | null;
}

function launchCandidate(g: GlobalConfig, l: LoopConfig): LaunchCandidate | null {
  const res = run(g, ['list', '--ready', '--workstream', l.workstream, '--limit', '1'], loopActor(l)) as
    { tickets?: { id?: string; workflow_attempt_id?: string | null }[] };
  const ticket = res.tickets?.[0];
  if (!ticket?.id) return null;
  return { id: ticket.id, workflowAttemptId: ticket.workflow_attempt_id ?? null };
}

/** Names one launch attempt. Helmo records it with the admission and admits a
 *  retry carrying the same name, so one launch cannot become two admissions. */
export function launchId(l: LoopConfig, attempt: number): string {
  return `${seatId(l)}:${process.pid}:${attempt}:${Date.now()}`;
}

/** One workflow attempt has one launch identity across process restarts. */
export function workflowLaunchId(l: LoopConfig, candidate: { id: string; workflowAttemptId: string }): string {
  const identity = `${seatId(l)}\n${candidate.id}\n${candidate.workflowAttemptId}`;
  return `${seatId(l)}:workflow:${createHash('sha256').update(identity).digest('hex')}`;
}

function deniedReason(body: Record<string, unknown>, ticketId: string | null): string {
  const named = (['missing', 'stale', 'failed'] as const)
    .map((key) => [key, Array.isArray(body[key]) ? (body[key] as unknown[]).map(String) : []] as const)
    .filter(([, items]) => items.length > 0)
    .map(([key, items]) => `${key} ${items.join(', ')}`);
  const detail = named.length > 0 ? named.join('; ') : String(body['error'] ?? 'no detail given');
  return `Helmo refused this launch${ticketId ? ` for ${ticketId}` : ''}: ${detail}`;
}

export function launchAdmit(
  g: GlobalConfig, l: LoopConfig, id: string,
  onWorkflowIntent?: (candidate: { ticketId: string; workflowAttemptId: string }, launchId: string) => void,
): LaunchAdmission {
  // This is the same ordered query Helmo performs inside launch-admit. It does
  // not grant permission; it tells Rev whether a broken/old gate affects the
  // candidate, so ordinary work can retain its pre-gate behaviour while a
  // workflow-bound launch fails closed.
  let candidate: LaunchCandidate | null;
  try {
    candidate = launchCandidate(g, l);
  } catch (e) {
    return { act: 'deny', how: 'unavailable', reason: `launch candidate could not be identified: ${cliError(e).split('\n')[0]!.slice(0, 160)}`, ticketId: null };
  }
  const admittedLaunchId = candidate?.workflowAttemptId
    ? workflowLaunchId(l, { id: candidate.id, workflowAttemptId: candidate.workflowAttemptId })
    : id;
  try {
    if (candidate?.workflowAttemptId) onWorkflowIntent?.(
      { ticketId: candidate.id, workflowAttemptId: candidate.workflowAttemptId }, admittedLaunchId,
    );
    // The echoed launch_id is deliberately not compared with the one sent: the
    // answer is Helmo's record of a decision, not a token Rev validates.
    const res = run(g, ['launch-admit', '--workstream', l.workstream, '--assignee', seatName(l), '--launch-id', admittedLaunchId], revActor(), true) as
      { admitted?: boolean; ticket_id?: string; workflow_attempt_id?: string | null; admission_id?: string | null };
    const ticketId = res.ticket_id ?? null;
    const exactCandidate = candidate
      ? res.admitted === true && ticketId === candidate.id
        && (candidate.workflowAttemptId
          ? res.workflow_attempt_id === candidate.workflowAttemptId && Boolean(res.admission_id)
          : res.workflow_attempt_id == null && res.admission_id == null)
      : res.admitted !== true;
    if (!exactCandidate) {
      return { act: 'deny', how: 'unavailable', reason: `Helmo's launch answer did not match the selected candidate${candidate ? ` ${candidate.id}` : ''}`, ticketId: candidate?.id ?? ticketId };
    }
    if (res.admitted !== true) return { act: 'launch', how: 'nothing_gated', reason: 'nothing ready to admit', ticketId };
    const attempt = res.workflow_attempt_id ? ` for attempt ${res.workflow_attempt_id}` : '';
    return {
      act: 'launch', how: 'admitted', ticketId,
      launchId: admittedLaunchId,
      workflowAttemptId: res.workflow_attempt_id ?? undefined,
      admissionId: res.admission_id ?? undefined,
      reason: `admitted${res.admission_id ? ` as ${res.admission_id}` : ''}${attempt}`,
    };
  } catch (e) {
    const raw = String((e as { stderr?: string | Buffer }).stderr ?? '').trim();
    if (raw.includes('workflow_admission_denied')) {
      // Two shapes carry the same refusal: the protocol's own JSON body, and a
      // store error whose message is the keyword followed by that body.
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep the lists empty; the message is the detail */ }
      const ticketId = typeof body['ticket_id'] === 'string' ? body['ticket_id'] : null;
      return { act: 'deny', how: 'denied', reason: deniedReason(body, ticketId), ticketId };
    }
    // An absent command is the store's usage text, and nothing else looks like
    // it. A locked store or crash is 'unavailable'; either condition blocks a
    // workflow candidate but leaves ordinary work compatible.
    const detail = cliError(e).split('\n')[0]!.slice(0, 160);
    const affected = Boolean(candidate?.workflowAttemptId);
    return raw.startsWith('usage:')
      ? { act: affected ? 'deny' : 'launch', how: 'unsupported', reason: `this store has no launch-admit command: ${detail}`, ticketId: candidate?.id ?? null }
      : { act: affected ? 'deny' : 'launch', how: 'unavailable', reason: `launch admission could not be asked: ${detail}`, ticketId: candidate?.id ?? null };
  }
}

export function launchReceipt(g: GlobalConfig, admissionId: string, launchId: string): LaunchReceipt {
  return run(g, ['launch-receipt', '--admission-id', admissionId, '--launch-id', launchId], revActor(), true) as LaunchReceipt;
}

export function launchRevalidate(g: GlobalConfig, admissionId: string, launchId: string): void {
  run(g, ['launch-revalidate', '--admission-id', admissionId, '--launch-id', launchId], revActor(), true);
}

export function launchQuarantine(g: GlobalConfig, admissionId: string, launchId: string, reason: string): void {
  run(g, ['launch-quarantine', '--admission-id', admissionId, '--launch-id', launchId, '--reason', reason], revActor(), true);
}

/** A loop is a pool worker when another roster loop shares its seat. Such a
 *  worker never lets its model session choose work: two sessions reading the
 *  same ready queue would both start the first ticket. It launches only on a
 *  ticket Helmo has already claimed for it. */
export function poolWorker(l: LoopConfig): boolean {
  return (l.peer_sessions?.length ?? 0) > 1;
}

/** Helmo's answer to one pool worker's launch-claim (H-574). Selection,
 *  workflow admission and the exclusive claim commit in one transaction, so a
 *  sibling worker asking at the same instant gets the next ticket or none.
 *  Unlike launch-admit, every failure here holds the launch: without the
 *  claim a pool worker has no safe way to pick work, so an older store that
 *  lacks the command must stop the pool rather than let it race. */
export interface LaunchClaim {
  act: 'launch' | 'idle' | 'deny';
  how: 'claimed' | 'nothing_ready' | 'denied' | 'unsupported' | 'unavailable';
  reason: string;
  ticketId: string | null;
  workflowAttemptId?: string;
  admissionId?: string;
  /** The worker already held this ticket from an earlier launch, and Helmo
   *  handed it forward to this one, retiring the earlier generation. */
  resumed?: boolean;
}

export function launchClaimArgs(l: LoopConfig, id: string): string[] {
  return ['launch-claim', '--workstream', l.workstream, '--assignee', seatName(l), '--launch-id', id, ...(l.project ? ['--project', l.project] : [])];
}

export function launchClaim(g: GlobalConfig, l: LoopConfig, id: string): LaunchClaim {
  // Written as the worker itself, never as the harness: Helmo records the
  // claim against this session, which is what the seat guard and the replay
  // fence both read.
  try {
    const res = run(g, launchClaimArgs(l, id), loopActor(l, undefined, undefined, id), true) as {
      admitted?: boolean; claimed?: boolean; resumed?: boolean; ticket_id?: string; workflow_attempt_id?: string | null; admission_id?: string | null;
      launch_id?: string; scope?: { session?: string; assignee?: string; workstream?: string; project?: string | null };
    };
    if (res.admitted === false && res.claimed === undefined) return { act: 'idle', how: 'nothing_ready', reason: 'nothing ready to claim', ticketId: null };
    // The receipt must name THIS worker's exact scope: a replayed id answered
    // with someone else's claim would put this session on their ticket.
    const exact = res.claimed === true && typeof res.ticket_id === 'string' && res.launch_id === id
      && res.scope?.session === seatId(l) && res.scope.assignee === seatName(l)
      && res.scope.workstream === l.workstream && (res.scope.project ?? undefined) === l.project
      && Boolean(res.workflow_attempt_id) === Boolean(res.admission_id);
    if (!exact) return { act: 'deny', how: 'unavailable', reason: `Helmo's claim receipt for ${id} did not match this worker`, ticketId: res.ticket_id ?? null };
    return {
      act: 'launch', how: 'claimed', ticketId: res.ticket_id!,
      workflowAttemptId: res.workflow_attempt_id ?? undefined,
      admissionId: res.admission_id ?? undefined,
      resumed: res.resumed === true,
      reason: `${res.resumed === true ? 'resumed' : 'claimed'} ${res.ticket_id}${res.admission_id ? ` admitted as ${res.admission_id}` : ''}`,
    };
  } catch (e) {
    const raw = String((e as { stderr?: string | Buffer }).stderr ?? '').trim();
    if (raw.includes('workflow_admission_denied')) {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* the message is the detail */ }
      const ticketId = typeof body['ticket_id'] === 'string' ? body['ticket_id'] : null;
      return { act: 'deny', how: 'denied', reason: deniedReason(body, ticketId), ticketId };
    }
    const detail = cliError(e).split('\n')[0]!.slice(0, 160);
    return raw.startsWith('usage:') || /unknown (command|flag)/i.test(raw)
      ? { act: 'deny', how: 'unsupported', reason: `this store has no launch-claim command, so pool worker '${l.name}' cannot run: ${detail}`, ticketId: null }
      : { act: 'deny', how: 'unavailable', reason: `launch claim could not be asked: ${detail}`, ticketId: null };
  }
}

/** Put down a claim this worker's launch took but never got to work — the
 *  session did not start, or the launch was refused before dispatch — so the
 *  ticket returns to the seat's ready queue for the next worker. Work a
 *  session started is never put down here: it stays with this worker and its
 *  next launch resumes it. Written as the launch's own generation, which is
 *  the only identity Helmo lets move the claim, and which leaving in_progress
 *  retires. Only a ticket still in progress under this seat is touched.
 *  Releasing keeps the reservation (Helmo H-954), so the ticket stays the
 *  seat's. Returns whether it released. */
export function releaseClaim(g: GlobalConfig, l: LoopConfig, ticketId: string, generation: string, why: string): boolean {
  const t = run(g, ['get', ticketId]) as { status?: string; assignee?: string | null };
  if (t.status !== 'in_progress' || t.assignee !== seatName(l)) return false;
  run(g, ['update', '--ticket', ticketId, '--status', 'open', '--note', `Rev released ${seatId(l)}'s launch claim: ${why}`], loopActor(l, undefined, undefined, generation), true);
  return true;
}

/** A ticket's current status. A read, so no actor is needed. */
export function ticketStatus(g: GlobalConfig, ticketId: string): string {
  return (run(g, ['get', ticketId]) as { status: string }).status;
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
    l.workstream === '*' ? [] : ['--workstream', l.workstream, '--assignee', seatName(l)];
  return run(g, ['wake-check', ...scope, '--since-seq', String(sinceSeq)]) as WakeCheck;
}

// Steering disclosure (helmo H-55): the remaining budget goes into every
// iteration prompt. Failure here must never stop the loop — steering
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
        (run(g, ['list', '--assignee', seatName(l), '--status', status, '--limit', '100']) as {
          tickets: { workstream: string }[];
        }).tickets,
    );
    return [...new Set(rows.map((t) => t.workstream))];
  } catch {
    return [];
  }
}

export function actorActivity(g: GlobalConfig, l: LoopConfig, sinceSeq: number): number {
  return (run(g, ['actor-activity', '--name', seatName(l), '--session', seatId(l), '--since-seq', String(sinceSeq), '--advancing']) as { events: number }).events;
}

export function actorTickets(g: GlobalConfig, l: LoopConfig, sinceSeq: number): { id: string; events: number }[] {
  return (run(g, ['actor-tickets', '--name', seatName(l), '--session', seatId(l), '--since-seq', String(sinceSeq)]) as { tickets: { id: string; events: number }[] }).tickets;
}

export interface SelfSpend {
  tokens: number;
  cost_usd: number;
  /** The same figures split by the ticket that carries each guess (H-187). */
  by_ticket: { id: string; tokens: number; cost_usd: number }[];
}

export function actorSelfSpend(g: GlobalConfig, l: LoopConfig, sinceSeq: number): SelfSpend {
  const r = run(g, ['actor-spend', '--name', seatName(l), '--session', seatId(l), '--since-seq', String(sinceSeq)]) as SelfSpend;
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

export function investigatorFor(_g: GlobalConfig, stopped: LoopConfig): LoopConfig | null {
  for (const loop of Object.values(loadRoster().loops)) {
    if (loop.name === stopped.name || processObservation(loop.name).state !== 'alive') continue;
    if ((['BLOCKED', 'STOP', 'HOLD', 'PARKED'] as const).some((s) => sHas(loop.name, s))) continue;
    return loop;
  }
  return null;
}

interface EscalationState {
  id: string;
  status: string;
  last_answer: { resolution: string; chosen_option?: string } | null;
  evidence?: { kind: string; ref: string }[];
}

export function agentFalseAlarmDisposition(g: GlobalConfig, ticketId: string, reason: string): boolean {
  const ticket = run(g, ['get', ticketId]) as EscalationState;
  return ['open', 'in_progress'].includes(ticket.status) && (ticket.evidence ?? []).some(
    (e) => e.kind === 'other' && e.ref === `rev:false_alarm:${encodeURIComponent(reason)}`,
  );
}

/** An answered resume is process-control input, not work for the halted seat.
 *  `resolution: resume` only reopens the ticket: investigate and hold use the
 *  same lifecycle transition. The recorded choice is the authority to clear
 *  BLOCKED. Dashboard ratification records the recommendation text, so accept
 *  either the option label or that label followed by its rationale. */
export function answeredResumeEscalation(g: GlobalConfig, l: LoopConfig): string | null {
  const id = openEscalation(g, l);
  if (!id) return null;
  const ticket = run(g, ['get', id]) as EscalationState;
  const choice = ticket.last_answer?.chosen_option?.trim().toLowerCase();
  return ticket.status === 'open' && ticket.last_answer?.resolution === 'resume' &&
    (choice === 'resume' || choice?.startsWith('resume —')) ? id : null;
}

/** Closes the escalation once the resumed loop has stayed up. Returns false
 *  when someone already closed it — an agent reading the answer can beat the
 *  min-uptime check, and Helmo refuses every write to a terminal ticket, so
 *  retrying would fail every poll forever (H-2164). */
export function completeAnsweredResume(g: GlobalConfig, ticketId: string, runningPath: string): boolean {
  const status = ticketStatus(g, ticketId);
  if (status === 'done' || status === 'cancelled') return false;
  run(g, [
    'update', '--ticket', ticketId,
    '--note', 'Rev applied the human resume answer; the supervisor restarted the loop and confirmed it stayed running.',
    '--status', 'done', '--confidence', 'routine',
    '--evidence-kind', 'file', '--evidence-ref', runningPath,
  ], revActor());
  return true;
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

// A BLOCKED loop is a summons, not a log line. Investigable subscription
// anomalies go to the first live peer; every other block reaches the human.
export function escalateBlocked(g: GlobalConfig, l: LoopConfig, reason: string, outputTail: string, stateDir: string, kind?: 'anomaly' | 'capacity'): string {
  const investigator = kind ? investigatorFor(g, l) : null;
  const created = run(
    g,
    [
      'create',
      '--title', escalationTitle(l),
      '--body',
      `Rev halted loop '${l.name}' (${scopeLabel(l)}). Reason: ${reason}.\n\nState dir: ${stateDir} (events.log has the trace; console tail below).` +
      (investigator ? `\n\nInvestigate the trace. If this is a false alarm, add evidence kind 'other' with this exact ref and leave the ticket in progress while Rev proves the restart (do not clear a sentinel yourself):\nrev:false_alarm:${encodeURIComponent(reason)}` : `\nTo resume after fixing: remove the BLOCKED sentinel and run \`rev run ${l.name}\`.`) +
      `\n\nLast session output:\n${outputTail.slice(-1500)}`,
      '--workstream', g.escalation_workstream,
      '--type', 'ops',
      '--priority', investigator ? '0' : '1',
      ...(investigator ? ['--assignee', investigator.name] : []),
    ],
    revActor(),
  ) as { id: string };
  if (investigator) return created.id;
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
  if (kind) notifyOperator('Rev: investigation needs a human', `Loop '${l.name}' is blocked and no live peer is available to investigate.`);
  return created.id;
}

export function returnRelapseToHuman(g: GlobalConfig, l: LoopConfig, ticketId: string, reason: string): void {
  run(g, ['return', '--ticket', ticketId,
    '--situation', `Loop '${l.name}' tripped again for the same reason inside the relapse window: ${reason}. The peer's earlier false-alarm disposition cannot authorize a second restart.`,
    '--question', `Should loop '${l.name}' be resumed again?`,
    '--recommendation', 'investigate — a repeated trip is a real anomaly until a human rules otherwise',
    '--if-unanswered', `${scopeLabel(l)} has no '${l.name}' worker until this repeat trip is resolved`,
  ], revActor());
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
  // The marker carries the line the sitting needs (helmo H-1761). A bare
  // `--needs-human` reads the slot after itself, so it arrived as no value at
  // all and the quarantine silently stopped marking anything (H-1782).
  const sitting = `Decide what to do with a ticket loop '${l.name}' declined three times unchanged: read it and route it, cancel it, or answer what it is waiting on — a few minutes.`;
  for (const id of ids) run(g, ['update', '--ticket', id, '--note', `Rev quarantined this ticket after loop '${l.name}' left it ready and unchanged for three consecutive passes; escalation ${standing}.`, '--needs-human', sitting], revActor());
  return standing;
}
