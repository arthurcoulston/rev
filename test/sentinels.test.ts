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
const { pidAlive, runningStamp } = await import('../src/sentinels.js');

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
