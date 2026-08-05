// Capstan's only knowledge of Helm: the helm-cli subprocess contract.
// Deliberately a subprocess, not a library import — the CLI is Helm's public
// programmatic surface, and consuming it keeps that contract honest.
import { execFileSync } from 'node:child_process';
import { GlobalConfig, LoopConfig } from './types.js';

export interface WakeCheck {
  max_seq: number;
  ready_count: number;
  changed_since: boolean;
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
  if (g.helm_db) env['HELMO_DB'] = g.helm_db;
  if (actor) env['HELMO_ACTOR'] = JSON.stringify(actor);
  const out = execFileSync('node', [g.helm_cli, ...args], { env, encoding: 'utf8' });
  return JSON.parse(out);
}

export function loopActor(l: LoopConfig): object {
  return { name: l.name, kind: 'agent', model: l.model, version: l.version };
}

export function capstanActor(): object {
  return { name: 'capstan', kind: 'agent', model: 'capstan-harness', version: '0.1.0' };
}

export function wakeCheck(g: GlobalConfig, l: LoopConfig, sinceSeq: number): WakeCheck {
  return run(g, [
    'wake-check', '--workstream', l.workstream, '--assignee', l.name, '--since-seq', String(sinceSeq),
  ]) as WakeCheck;
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

export function actorActivity(g: GlobalConfig, name: string, sinceSeq: number): number {
  return (run(g, ['actor-activity', '--name', name, '--since-seq', String(sinceSeq)]) as { events: number }).events;
}

export function actorTickets(g: GlobalConfig, name: string, sinceSeq: number): { id: string; events: number }[] {
  return (run(g, ['actor-tickets', '--name', name, '--since-seq', String(sinceSeq)]) as { tickets: { id: string; events: number }[] }).tickets;
}

// Spend is written by Capstan (the meter), not the loop's agent — the agent
// never saw its own usage, and the provenance should say who measured.
export function recordSpend(g: GlobalConfig, ticketId: string, tokens: number | undefined, cost: number | undefined, note: string): void {
  const args = ['record-spend', '--ticket', ticketId, '--note', note];
  if (tokens) args.push('--tokens', String(tokens));
  if (cost) args.push('--cost-usd', String(cost));
  run(g, args, capstanActor());
}

// A BLOCKED loop is a summons, not a log line: file it straight into the
// awaiting-human queue so the operator's existing dashboard and meeting see it.
export function escalateBlocked(g: GlobalConfig, l: LoopConfig, reason: string, outputTail: string, stateDir: string): string {
  const created = run(
    g,
    [
      'create',
      '--title', `Loop '${l.name}' is blocked: needs a decision`,
      '--body',
      `Capstan halted loop '${l.name}' (workstream ${l.workstream}). Reason: ${reason}.\n\nState dir: ${stateDir} (events.log has the trace; console tail below).\nTo resume after fixing: remove the BLOCKED sentinel and run \`capstan run ${l.name}\`.\n\nLast session output:\n${outputTail.slice(-1500)}`,
      '--workstream', g.escalation_workstream,
      '--type', 'ops',
      '--priority', '1',
    ],
    capstanActor(),
  ) as { id: string };
  run(
    g,
    [
      'return',
      '--ticket', created.id,
      '--situation', `Loop '${l.name}' halted itself: ${reason}. The loop stays down until a human decides; no work in workstream '${l.workstream}' is being drawn.`,
      '--question', `How should loop '${l.name}' proceed?`,
      '--options', JSON.stringify([
        { label: 'resume', consequence: 'clear BLOCKED and restart the loop as-is (right if the cause was external and has passed)' },
        { label: 'hold', consequence: 'leave the loop down deliberately (converts to an intended HOLD)' },
        { label: 'investigate', consequence: 'a human or agent digs into the trace before any restart' },
      ]),
      '--recommendation', reason.includes('transient') ? 'resume — the condition was external and has likely lifted' : 'investigate — consecutive failures usually mean something real',
      '--if-unanswered', `workstream '${l.workstream}' has no worker until this is answered`,
    ],
    capstanActor(),
  );
  return created.id;
}
