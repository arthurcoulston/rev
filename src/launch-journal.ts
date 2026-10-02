import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { stateDir } from './config.js';

export interface LaunchReceipt {
  id: string;
  ticket_id: string;
  attempt_id: string;
  launch_id: string;
  definition_revision: string;
  evidence: { requirement: { id: string }; manifest: { id: string }; decision: { id: string } }[];
}

export interface LaunchJournalEntry {
  format: 1;
  phase: 'intent' | 'admitted' | 'dispatching' | 'complete' | 'quarantined';
  launch_id: string;
  intent_at: string;
  ticket_id?: string;
  workflow_attempt_id?: string;
  /** A pool worker's launch, which holds a Helmo claim from before dispatch
   *  (H-574). Set at intent, because the claim may land even when this
   *  process dies before learning which ticket it got. */
  claim?: true;
  admission_id?: string;
  definition_revision?: string;
  requirement_refs?: { requirement_id: string; manifest_id: string; decision_id: string }[];
  admitted_at?: string;
  dispatching_at?: string;
  completed_at?: string;
  quarantined_at?: string;
}

function journalDir(loop: string): string {
  const dir = join(stateDir(loop), 'launches');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function entryPath(loop: string, launchId: string): string {
  return join(journalDir(loop), `${createHash('sha256').update(launchId).digest('hex')}.json`);
}

function writeDurable(file: string, entry: LaunchJournalEntry): void {
  const dir = dirname(file);
  const tmp = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  try {
    const fd = openSync(tmp, 'w');
    try { writeFileSync(fd, `${JSON.stringify(entry, null, 1)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* no partial journal entry remains */ }
    throw e;
  }
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function readLaunch(loop: string, launchId: string): LaunchJournalEntry | null {
  const file = entryPath(loop, launchId);
  if (!existsSync(file)) return null;
  const entry = JSON.parse(readFileSync(file, 'utf8')) as LaunchJournalEntry;
  if (entry.format !== 1 || entry.launch_id !== launchId || !['intent', 'admitted', 'dispatching', 'complete', 'quarantined'].includes(entry.phase)) {
    throw new Error(`Launch journal entry for ${launchId} is corrupt.`);
  }
  return entry;
}

/** Launches a restart must resolve: anything admitted or dispatched, plus a
 *  claim whose intent was recorded but whose answer never was. */
export function unsettledLaunches(loop: string): LaunchJournalEntry[] {
  return readdirSync(journalDir(loop)).filter((name) => name.endsWith('.json')).map((name) => {
    const entry = JSON.parse(readFileSync(join(journalDir(loop), name), 'utf8')) as LaunchJournalEntry;
    if (entry.format !== 1 || !entry.launch_id) throw new Error(`Launch journal entry ${name} is corrupt.`);
    return entry;
  }).filter((entry) => entry.phase === 'admitted' || entry.phase === 'dispatching' || (entry.phase === 'intent' && entry.claim === true));
}

export function recordLaunchIntent(
  loop: string, launchId: string, identity?: { ticketId: string; workflowAttemptId: string } | { claim: true }, at = new Date().toISOString(),
): LaunchJournalEntry {
  const existing = readLaunch(loop, launchId);
  if (existing && identity && 'claim' in identity) {
    if (existing.claim !== true) throw new Error(`Launch journal identity ${launchId} was replayed as a claim.`);
    return existing;
  }
  if (existing) {
    if (identity && !('claim' in identity) && (existing.ticket_id !== identity.ticketId || existing.workflow_attempt_id !== identity.workflowAttemptId)) {
      throw new Error(`Launch journal identity ${launchId} was replayed for a different ticket or workflow attempt.`);
    }
    return existing;
  }
  const entry: LaunchJournalEntry = {
    format: 1, phase: 'intent', launch_id: launchId, intent_at: at,
    ...(identity && 'claim' in identity ? { claim: true as const } : {}),
    ...(identity && !('claim' in identity) ? { ticket_id: identity.ticketId, workflow_attempt_id: identity.workflowAttemptId } : {}),
  };
  writeDurable(entryPath(loop, launchId), entry);
  return entry;
}

export function recordLaunchAdmission(loop: string, receipt: LaunchReceipt, at = new Date().toISOString()): LaunchJournalEntry {
  const prior = readLaunch(loop, receipt.launch_id)
    ?? recordLaunchIntent(loop, receipt.launch_id, { ticketId: receipt.ticket_id, workflowAttemptId: receipt.attempt_id }, at);
  const exact = {
    ticket_id: receipt.ticket_id,
    workflow_attempt_id: receipt.attempt_id,
    admission_id: receipt.id,
    definition_revision: receipt.definition_revision,
    requirement_refs: receipt.evidence.map(({ requirement, manifest, decision }) => ({
      requirement_id: requirement.id, manifest_id: manifest.id, decision_id: decision.id,
    })),
  };
  if ((prior.ticket_id && prior.ticket_id !== exact.ticket_id)
      || (prior.workflow_attempt_id && prior.workflow_attempt_id !== exact.workflow_attempt_id)) {
    throw new Error(`Launch journal identity ${receipt.launch_id} was admitted for a different ticket or workflow attempt.`);
  }
  if (prior.phase !== 'intent') {
    for (const [key, value] of Object.entries(exact)) {
      if (JSON.stringify(prior[key as keyof LaunchJournalEntry]) !== JSON.stringify(value)) {
        throw new Error(`Launch journal identity ${receipt.launch_id} was replayed with different ${key}.`);
      }
    }
    return prior;
  }
  const entry: LaunchJournalEntry = { ...prior, ...exact, phase: 'admitted', admitted_at: at };
  writeDurable(entryPath(loop, receipt.launch_id), entry);
  return entry;
}

/** Record which ticket a pool worker's launch-claim took. A workflow-bound
 *  claim goes through recordLaunchAdmission instead, which keeps the claim
 *  marker set at intent. */
export function recordLaunchClaim(loop: string, launchId: string, ticketId: string, at = new Date().toISOString()): LaunchJournalEntry {
  const prior = readLaunch(loop, launchId);
  if (!prior?.claim) throw new Error(`Launch ${launchId} has no durable claim intent.`);
  if (prior.phase !== 'intent') {
    if (prior.ticket_id !== ticketId) throw new Error(`Launch journal identity ${launchId} was replayed for a different ticket.`);
    return prior;
  }
  const entry: LaunchJournalEntry = { ...prior, ticket_id: ticketId, phase: 'admitted', admitted_at: at };
  writeDurable(entryPath(loop, launchId), entry);
  return entry;
}

/** Durably claim the one allowed dispatch. The marker is written before the
 * model process starts, so a crash in the gap may lose a launch but can never
 * turn a replay of the same immutable identity into a second model process. */
export function recordLaunchDispatch(loop: string, launchId: string, at = new Date().toISOString()): boolean {
  const prior = readLaunch(loop, launchId);
  if (!prior || prior.phase === 'intent') throw new Error(`Launch ${launchId} has no durable admission.`);
  const claim = `${entryPath(loop, launchId)}.dispatch`;
  let fd: number;
  try { fd = openSync(claim, 'wx'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try { writeFileSync(fd, `${at}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  const dfd = openSync(dirname(claim), 'r');
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
  if (prior.phase === 'dispatching') return false;
  writeDurable(entryPath(loop, launchId), { ...prior, phase: 'dispatching', dispatching_at: at });
  return true;
}

export function settleLaunch(loop: string, launchId: string, phase: 'complete' | 'quarantined', at = new Date().toISOString()): void {
  const prior = readLaunch(loop, launchId);
  if (!prior?.admission_id && !prior?.claim) throw new Error(`Launch ${launchId} has no durable admission.`);
  writeDurable(entryPath(loop, launchId), {
    ...prior, phase,
    ...(phase === 'complete' ? { completed_at: at } : { quarantined_at: at }),
  });
}
