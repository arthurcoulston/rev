// Liveness is identity, not a pid (H-154). The fleet spent a night down because
// a recycled pid made the supervisor's "is one already running?" check answer
// yes about an unrelated Apple process, so every launchd restart aborted.
import { describe, it, expect, afterEach } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'rev-sentinels-'));
process.env.REV_HOME = home; // before the module reads it
const { NO_OWNER_PID, occupiedPid, paceAutoRelease, pidAlive, processObservation, runningStamp, sOwner, sReleaseOwned, sSet, sSetOwned, sValue } = await import('../src/sentinels.js');

function marker(loop: string, contents: string): void {
  mkdirSync(join(home, 'state', loop), { recursive: true });
  writeFileSync(join(home, 'state', loop, 'RUNNING'), contents);
}

const strays: ChildProcess[] = [];
function stray(): number {
  // Any live process that is emphatically not rev — the recycled-pid stand-in.
  const p = spawn('sleep', ['30'], { stdio: 'ignore' });
  strays.push(p);
  return p.pid!;
}

afterEach(() => {
  for (const p of strays.splice(0)) p.kill('SIGKILL');
});

describe('pidAlive', () => {
  it('rejects a live pid that is running something other than the marker owner', () => {
    marker('supervisor', `${stray()}\nstarted 2026-08-11T18:05:25.133Z\ncmd /Users/x/projects/rev/dist/cli.js run\n`);
    expect(pidAlive('supervisor')).toBe(null);
  });

  it('accepts the marker its own process just wrote', () => {
    marker('self', runningStamp());
    expect(pidAlive('self')).toBe(process.pid);
  });

  it('records the physical launcher for a pinned supervisor, but not its loop children', () => {
    const saved = { argv: [...process.argv], launcher: process.env['REV_SERVICE_LAUNCHER'] };
    const launcher = join(home, 'service', 'launch.mjs');
    process.env['REV_SERVICE_LAUNCHER'] = launcher;
    process.argv.splice(1, process.argv.length - 1, '/release/rev/dist/cli.js', 'run');
    expect(runningStamp()).toContain(`cmd ${launcher} run\n`);
    process.argv.push('mason');
    expect(runningStamp()).toContain('cmd /release/rev/dist/cli.js run mason\n');
    process.argv.splice(0, process.argv.length, ...saved.argv);
    if (saved.launcher === undefined) delete process.env['REV_SERVICE_LAUNCHER'];
    else process.env['REV_SERVICE_LAUNCHER'] = saved.launcher;
  });

  it('reports denied inspection as unknown and keeps the marker occupied', () => {
    marker('hidden', runningStamp());
    expect(processObservation('hidden', () => null)).toEqual({ state: 'unknown', pid: process.pid });
    expect(pidAlive('hidden')).toBe(process.pid);
    expect(occupiedPid('hidden', () => null)).toBe(process.pid);
  });

  it('distinguishes a reused pid from unavailable inspection', () => {
    marker('reused', runningStamp());
    expect(processObservation('reused', () => 'sleep 30')).toEqual({ state: 'dead', pid: null });
  });

  it('rejects a dead pid without consulting the command at all', () => {
    const p = stray();
    strays.splice(strays.indexOf(strays.find((s) => s.pid === p)!), 1);
    process.kill(p, 'SIGKILL');
    marker('dead', `${p}\nstarted 2026-08-11T18:05:25.133Z\ncmd sleep 30\n`);
    expect(pidAlive('dead')).toBe(null);
  });

  it("does not let the supervisor's command match a loop's, whose pid may be recycled to one", () => {
    // ownCommand() for a loop ends in the loop name; the supervisor's is its
    // prefix. A substring test would call this stale marker alive.
    const p = stray();
    const loopCmd = `/Users/x/projects/rev/dist/cli.js run ward`;
    marker('supervisor', `${p}\nstarted 2026-08-11T18:05:25.133Z\ncmd /Users/x/projects/rev/dist/cli.js run\n`);
    expect(pidAlive('supervisor')).toBe(null);
    expect(loopCmd.endsWith('/Users/x/projects/rev/dist/cli.js run')).toBe(false);
  });

  it('falls back to the pid for a marker written before the command was recorded', () => {
    // Upgrade path: an old two-line marker still reads as alive rather than
    // being declared stale under a running process.
    marker('legacy', `${stray()}\nstarted 2026-08-11T18:05:25.133Z\n`);
    expect(pidAlive('legacy')).not.toBe(null);
  });

  it('reads no marker as not running', () => {
    expect(pidAlive('never-existed')).toBe(null);
  });
});

describe('owned sentinels', () => {
  it('keeps legacy and malformed controls readable but unowned', () => {
    mkdirSync(join(home, 'state', 'legacy-owned'), { recursive: true });
    sSet('legacy-owned', 'PACE', 'park');
    expect(sValue('legacy-owned', 'PACE')).toBe('park');
    expect(sOwner('legacy-owned', 'PACE')).toBe(null);
    sSet('legacy-owned', 'PACE', 'park\nby=maintenance\n');
    expect(sOwner('legacy-owned', 'PACE')).toBe(null);
    sSet('legacy-owned', 'PACE', 'park\nby=maintenance\nat=not-a-timestamp\npid=123\nreason=window\nexpires_at=not-a-timestamp\n');
    expect(sValue('legacy-owned', 'PACE')).toBe('park');
    expect(sOwner('legacy-owned', 'PACE')).toBe(null);
  });

  it('parses owned controls and releases only the exact observation', () => {
    mkdirSync(join(home, 'state', 'owned'), { recursive: true });
    const first = { value: 'park', by: 'maintenance', at: '2026-09-29T15:00:00.000Z', pid: 123, reason: 'window', expires_at: '2026-09-29T16:00:00.000Z' };
    sSetOwned('owned', 'PACE', first);
    expect(sOwner('owned', 'PACE')).toEqual(first);
    const newer = { ...first, at: '2026-09-29T15:30:00.000Z', pid: 456 };
    sSetOwned('owned', 'PACE', newer);
    expect(sReleaseOwned('owned', 'PACE', first)).toBe(false);
    expect(sOwner('owned', 'PACE')).toEqual(newer);
    expect(sReleaseOwned('owned', 'PACE', newer)).toBe(true);
    expect(sValue('owned', 'PACE')).toBe(null);
  });

  it('auto-releases only expired or orphaned maintenance controls', () => {
    const base = { value: 'park', by: 'maintenance', at: '2026-09-29T15:00:00.000Z', pid: 123, reason: 'window', expires_at: '2026-09-29T16:00:00.000Z' };
    expect(paceAutoRelease(null, Date.now(), () => false)).toBe(null);
    expect(paceAutoRelease({ ...base, by: 'human' }, Date.now(), () => false)).toBe(null);
    expect(paceAutoRelease(base, Date.parse('2026-09-29T16:00:00.000Z'), () => true)).toBe('pace-expired');
    expect(paceAutoRelease({ ...base, expires_at: 'never' }, Date.now(), () => false)).toBe('pace-orphaned');
    expect(paceAutoRelease({ ...base, expires_at: 'never' }, Date.now(), () => true)).toBe(null);
    expect(paceAutoRelease({ ...base, at: 'not-a-timestamp', expires_at: 'not-a-timestamp' }, Date.now(), () => false)).toBe(null);
  });

  it('holds an unowned control by its expiry alone, never as orphaned (H-738)', () => {
    const cli = { value: 'park', by: 'builder', at: '2026-09-29T15:00:00.000Z', pid: NO_OWNER_PID, reason: 'rev pace', expires_at: '2026-09-29T16:00:00.000Z' };
    expect(paceAutoRelease(cli, Date.parse('2026-09-29T15:30:00.000Z'), () => false)).toBe(null);
    expect(paceAutoRelease(cli, Date.parse('2026-09-29T16:00:00.000Z'), () => false)).toBe('pace-expired');
  });
});
