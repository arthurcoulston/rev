// Abandoned-tree detection (H-281): the pure pieces. The live-orphan path —
// kill an ancestor, watch the tree drain itself — is in supervisor.e2e.test.ts.
import { describe, it, expect } from 'vitest';
import { ancestryBroken, ancestryStamp, ppidOf } from '../src/ancestry.js';

describe('ancestry', () => {
  it('stamps the live chain and reports it unbroken', () => {
    const stamp = ancestryStamp();
    // vitest runs under a real parent; the chain exists and holds.
    expect(stamp.length).toBeGreaterThan(0);
    expect(ancestryBroken(stamp)).toBe(false);
  });

  it('an empty lineage (launchd-parented from birth) can never break', () => {
    expect(ancestryBroken([])).toBe(false);
  });

  it('a dead ancestor breaks the chain', () => {
    // Keep our real parent as link 0 so the first ppid comparison passes,
    // then claim a grandparent that does not exist.
    expect(ppidOf(99999999)).toBeNull();
    expect(ancestryBroken([process.ppid, 99999999])).toBe(true);
  });

  it('a reparented ancestor breaks the chain', () => {
    // Claim our real parent answers to a wrong grandparent: the recorded
    // link no longer matches reality, which is what reparenting looks like.
    const stamp = ancestryStamp();
    if (stamp.length < 2) return; // chain too shallow in this runner to fake a mismatch
    expect(ancestryBroken([stamp[0]!, stamp[0]!])).toBe(true);
  });
});
