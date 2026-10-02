import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { launchGroupFile, launchSessionRunning, readLaunch, recordLaunchAdmission, recordLaunchClaim, recordLaunchDispatch, recordLaunchIntent, settleLaunch, unsettledLaunches, type LaunchReceipt } from '../src/launch-journal.js';

const receipt: LaunchReceipt = {
  id: 'admission:attempt-1:launch:7',
  ticket_id: 'H-7',
  attempt_id: 'attempt-1',
  launch_id: 'rev:builder:42:1:1000',
  definition_revision: 'v3',
  evidence: [{ requirement: { id: 'technical' }, manifest: { id: 'candidate-3' }, decision: { id: 'pass-9' } }],
};

describe('launch journal', () => {
  beforeEach(() => { process.env['REV_HOME'] = mkdtempSync(join(tmpdir(), 'rev-launch-journal-')); });

  it('durably records intent and the exact admitted authority before dispatch', () => {
    recordLaunchIntent('builder', receipt.launch_id, { ticketId: 'H-7', workflowAttemptId: 'attempt-1' }, '2026-10-01T00:00:00.000Z');
    recordLaunchAdmission('builder', receipt, '2026-10-01T00:00:01.000Z');

    expect(readLaunch('builder', receipt.launch_id)).toEqual({
      format: 1, phase: 'admitted', launch_id: receipt.launch_id, intent_at: '2026-10-01T00:00:00.000Z',
      ticket_id: 'H-7', workflow_attempt_id: 'attempt-1', admission_id: 'admission:attempt-1:launch:7',
      definition_revision: 'v3', requirement_refs: [{ requirement_id: 'technical', manifest_id: 'candidate-3', decision_id: 'pass-9' }],
      admitted_at: '2026-10-01T00:00:01.000Z',
    });
    const files = readdirSync(join(process.env['REV_HOME']!, 'state', 'builder', 'launches'));
    expect(files).toHaveLength(1);
    expect(() => JSON.parse(readFileSync(join(process.env['REV_HOME']!, 'state', 'builder', 'launches', files[0]!), 'utf8'))).not.toThrow();
  });

  it('makes replay idempotent and rejects a changed identity', () => {
    recordLaunchAdmission('builder', receipt);
    expect(recordLaunchAdmission('builder', receipt)).toEqual(readLaunch('builder', receipt.launch_id));
    expect(() => recordLaunchAdmission('builder', { ...receipt, ticket_id: 'H-other' })).toThrow(/different ticket/);
    expect(() => recordLaunchIntent('builder', receipt.launch_id, { ticketId: 'H-other', workflowAttemptId: 'attempt-1' })).toThrow(/different ticket/);
  });

  it('suppresses a second dispatch after a crash in the pre-dispatch gap', () => {
    recordLaunchAdmission('builder', receipt);
    expect(recordLaunchDispatch('builder', receipt.launch_id, '2026-10-01T00:00:02.000Z')).toBe(true);
    // A restarted caller sees the marker written before the first model spawn.
    expect(recordLaunchDispatch('builder', receipt.launch_id, '2026-10-01T00:00:03.000Z')).toBe(false);
    expect(readLaunch('builder', receipt.launch_id)).toMatchObject({ phase: 'dispatching', dispatching_at: '2026-10-01T00:00:02.000Z' });
  });

  it('exposes only unsettled recovered launches and durably settles them', () => {
    recordLaunchAdmission('builder', receipt);
    expect(unsettledLaunches('builder')).toHaveLength(1);
    settleLaunch('builder', receipt.launch_id, 'quarantined', '2026-10-01T00:00:04.000Z');
    expect(unsettledLaunches('builder')).toEqual([]);
    expect(readLaunch('builder', receipt.launch_id)).toMatchObject({ phase: 'quarantined', quarantined_at: '2026-10-01T00:00:04.000Z' });
  });
});

describe('a dead launch\'s session (H-685)', () => {
  beforeEach(() => { process.env['REV_HOME'] = mkdtempSync(join(tmpdir(), 'rev-launch-session-')); });

  const dispatched = (id: string, at = new Date().toISOString()) => {
    recordLaunchIntent('w1', id, { claim: true });
    recordLaunchClaim('w1', id, 'H-9');
    recordLaunchDispatch('w1', id, at);
    return readLaunch('w1', id)!;
  };
  // A detached child leads its own group, the way the shim starts a session.
  const group = () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    child.unref();
    return child.pid!;
  };
  const ended = (pid: number) => new Promise<void>((resolve) => {
    process.kill(-pid, 'SIGKILL');
    // macOS answers EPERM, not ESRCH, while the killed leader awaits reaping.
    const poll = () => { try { process.kill(-pid, 0); setTimeout(poll, 20); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') resolve(); else setTimeout(poll, 20); } };
    poll();
  });

  it('reads a launch that never dispatched, or whose session never wrote its group, as not running', () => {
    recordLaunchIntent('w1', 'rev:w1:1:1:1', { claim: true });
    recordLaunchClaim('w1', 'rev:w1:1:1:1', 'H-9');
    expect(launchSessionRunning('w1', readLaunch('w1', 'rev:w1:1:1:1')!)).toMatchObject({ running: false, why: 'never dispatched' });
    expect(launchSessionRunning('w1', dispatched('rev:w1:1:1:2'))).toMatchObject({ running: false, why: 'its session never started' });
    writeFileSync(launchGroupFile('w1', 'rev:w1:1:1:2'), '');
    expect(launchSessionRunning('w1', readLaunch('w1', 'rev:w1:1:1:2')!)).toMatchObject({ running: false, why: 'its session never started' });
  });

  it('holds while the session group runs and releases once it has ended', async () => {
    const entry = dispatched('rev:w1:1:1:3');
    const pid = group();
    writeFileSync(launchGroupFile('w1', entry.launch_id), `${pid}\n`);
    expect(launchSessionRunning('w1', entry)).toEqual({ running: true, group: pid, why: `session group ${pid} is still running` });
    await ended(pid);
    expect(launchSessionRunning('w1', entry)).toEqual({ running: false, group: pid, why: `session group ${pid} has ended` });
  });

  it('does not mistake a later process that was given the same group id for the session', async () => {
    // The launch dispatched an hour before this group's leader started.
    const entry = dispatched('rev:w1:1:1:4', new Date(Date.now() - 3_600_000).toISOString());
    const pid = group();
    writeFileSync(launchGroupFile('w1', entry.launch_id), `${pid}\n`);
    try {
      expect(launchSessionRunning('w1', entry)).toEqual({ running: false, group: pid, why: `group id ${pid} now belongs to a later process` });
    } finally { await ended(pid); }
  });
});

