import { describe, it, expect } from 'vitest';
import { wedgeDecide } from '../src/health.js';

describe('wedgeDecide (H-448)', () => {
  it('treats early failures as contention, exactly as before', () => {
    for (let n = 0; n < 5; n++) expect(wedgeDecide(n, 5).act).toBe('ok');
  });

  it('declares a wedge once "transient" has stopped being credible', () => {
    const d = wedgeDecide(5, 5);
    expect(d.act).toBe('wedge');
    if (d.act !== 'wedge') throw new Error('unreachable');
    expect(d.reason).toContain('5 consecutive');
    expect(d.reason).toContain('drawing no work');
  });

  it('a zero cap disables it', () => {
    expect(wedgeDecide(999, 0).act).toBe('ok');
  });
});
