import { describe, it, expect } from 'vitest';
import { classifyExit, ladderDecide, respawnDecide, rollingMean, velocityToPause } from '../src/ladder.js';

const base = { produced: true, failStreak: 0, limitStreak: 0, failCap: 2, limitCap: 20, limitWait: 900 };

describe('classifyExit', () => {
  it('maps the shim contract', () => {
    expect(classifyExit(0)).toBe('ok');
    expect(classifyExit(75)).toBe('transient');
    expect(classifyExit(78)).toBe('apparatus');
    expect(classifyExit(1)).toBe('failure');
    expect(classifyExit(143)).toBe('failure');
  });
});

describe('ladderDecide', () => {
  it('ok+produced continues; ok+unproduced idles', () => {
    expect(ladderDecide('ok', base).act).toBe('continue');
    expect(ladderDecide('ok', { ...base, produced: false }).act).toBe('idle');
  });
  it('transient parks with the wait, never fails, until the cap', () => {
    const a = ladderDecide('transient', { ...base, limitStreak: 1 });
    expect(a).toEqual({ act: 'limit_wait', waitSeconds: 900, attempt: 1 });
    expect(ladderDecide('transient', { ...base, limitStreak: 21 }).act).toBe('blocked');
  });
  it('apparatus fails closed immediately', () => {
    expect(ladderDecide('apparatus', base).act).toBe('blocked');
  });
  it('failures retry under the cap then block', () => {
    expect(ladderDecide('failure', { ...base, failStreak: 1 }).act).toBe('continue');
    expect(ladderDecide('failure', { ...base, failStreak: 2 }).act).toBe('continue');
    expect(ladderDecide('failure', { ...base, failStreak: 3 }).act).toBe('blocked');
  });
});

describe('respawnDecide', () => {
  const base = { halted: false, exitCode: 0, uptimeSeconds: 300, restartStreak: 0, backoffBase: 30, backoffCap: 900, minUptime: 60 };
  it('a halt sentinel always wins — never respawn over a decision', () => {
    expect(respawnDecide({ ...base, halted: true }).act).toBe('await_clearance');
    expect(respawnDecide({ ...base, halted: true, exitCode: 1, restartStreak: 5 }).act).toBe('await_clearance');
  });
  it('clean exit after healthy uptime respawns immediately (the ceiling working)', () => {
    expect(respawnDecide(base)).toEqual({ act: 'respawn', waitSeconds: 0 });
  });
  it('crashes climb an exponential backoff to the cap', () => {
    expect(respawnDecide({ ...base, exitCode: 1, restartStreak: 1 })).toEqual({ act: 'respawn', waitSeconds: 30 });
    expect(respawnDecide({ ...base, exitCode: 1, restartStreak: 2 })).toEqual({ act: 'respawn', waitSeconds: 60 });
    expect(respawnDecide({ ...base, exitCode: 1, restartStreak: 4 })).toEqual({ act: 'respawn', waitSeconds: 240 });
    expect(respawnDecide({ ...base, exitCode: 1, restartStreak: 10 })).toEqual({ act: 'respawn', waitSeconds: 900 });
  });
  it('a signal kill and a too-young clean exit are both unhealthy', () => {
    expect(respawnDecide({ ...base, exitCode: null, restartStreak: 1 })).toEqual({ act: 'respawn', waitSeconds: 30 });
    expect(respawnDecide({ ...base, uptimeSeconds: 5, restartStreak: 1 })).toEqual({ act: 'respawn', waitSeconds: 30 });
  });
});

describe('velocityToPause', () => {
  it('full speed = no pause; fraction slows using measured duration', () => {
    expect(velocityToPause(1, 120)).toBe(0);
    expect(velocityToPause(0.5, 120)).toBe(120); // half speed => equal pause
    expect(velocityToPause(0.25, 100)).toBe(300);
    expect(velocityToPause(0.5, 0)).toBe(180); // default T_iter before measurement
  });
});

describe('rollingMean', () => {
  it('keeps a bounded window', () => {
    let w: number[] = [];
    let m = 0;
    for (const d of [10, 20, 30, 40, 50, 60]) ({ window: w, mean: m } = rollingMean(w, d));
    expect(w).toEqual([20, 30, 40, 50, 60]);
    expect(m).toBe(40);
  });
});
