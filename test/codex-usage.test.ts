import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCodexRateLimits, recordCodexUsage, refreshCodexUsage } from '../src/usage.js';

afterEach(() => vi.unstubAllEnvs());

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'rev-usage-'));
  vi.stubEnv('REV_HOME', root);
  vi.stubEnv('CODEX_HOME', join(root, 'codex'));
  const now = new Date();
  const dir = join(root, 'codex', 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  return { root, dir, now };
}
function event(timestamp: Date, used: number, bucket = 'codex') {
  return JSON.stringify({ timestamp: timestamp.toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    limit_id: bucket, plan_type: 'prolite', primary: { used_percent: used, window_minutes: 10080, resets_at: Math.floor(timestamp.getTime() / 1000) + 86400 },
  } } }) + '\n';
}

describe('shared Codex allowance from local rollouts (H-892)', () => {
  it('includes the newest desk session without persisting conversation content', () => {
    const { root, dir, now } = setup();
    writeFileSync(join(dir, 'rollout-loop.jsonl'), event(new Date(+now - 120000), 15));
    writeFileSync(join(dir, 'rollout-desk.jsonl'), JSON.stringify({ type: 'response_item', payload: 'private meeting body' }) + '\n' + event(now, 62) + '{partial');
    expect(refreshCodexUsage(now)?.limits[0]?.percent).toBe(62);
    const saved = readFileSync(join(root, 'usage-codex.json'), 'utf8');
    expect(saved).not.toContain('private meeting');
    expect(saved).not.toContain('rate_limits');
    // Reading it again must not pretend that this old event just happened.
    expect(refreshCodexUsage(new Date(+now + 60000))?.fetched_at).toBe(now.toISOString());
  });

  it('ignores the independent Spark bucket and cannot replace fresh usage with an older loop', () => {
    const { dir, now } = setup();
    writeFileSync(join(dir, 'rollout-desk.jsonl'), event(now, 60) + event(now, 1, 'codex_bengalfox'));
    writeFileSync(join(dir, 'rollout-old-loop.jsonl'), event(new Date(+now - 120000), 10));
    expect(refreshCodexUsage(now)?.limits[0]?.percent).toBe(60);
    recordCodexUsage('old-loop');
    expect(refreshCodexUsage(now)?.limits[0]?.percent).toBe(60);
    expect(parseCodexRateLimits({ limit_id: 'codex_bengalfox', primary: { used_percent: 0 } }).limits).toEqual([]);
  });

  it('handles large rollouts and a partial tail without reading unbounded history', () => {
    const { dir, now } = setup();
    writeFileSync(join(dir, 'rollout-large.jsonl'), JSON.stringify({ payload: 'x'.repeat(600000) }) + '\n' + event(now, 33) + '{unfinished');
    expect(refreshCodexUsage(now)?.limits[0]?.percent).toBe(33);
  });
});
