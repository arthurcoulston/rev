// Abandoned-tree detection (H-281). The 2026-08-28 swarm proved a direct
// ppid check is not enough: what died was the SHELL above the tsx wrapper,
// so every parent link inside the orphaned tree stayed intact while the
// whole tree ran unattended for six days. The unforgeable signal is the
// ancestor chain recorded at start: any link dead or reparented since means
// nobody who started this process is still watching it. A launchd-parented
// process starts at ppid 1 with an empty chain, which can never break —
// deliberate daemons go through `rev service`, never nohup.
import { execFileSync } from 'node:child_process';

/** Parent pid of `pid` right now, or null if the process is gone. */
export function ppidOf(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const p = parseInt(out, 10);
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

/** Ancestors of this process at start, nearest first, stopping before pid 1. */
export function ancestryStamp(): number[] {
  const chain: number[] = [];
  let p: number | null = process.ppid;
  while (p !== null && p > 1 && chain.length < 10) {
    chain.push(p);
    p = ppidOf(p);
  }
  return chain;
}

/** True when any recorded ancestor died or was reparented — the tree is abandoned. */
export function ancestryBroken(stamp: number[]): boolean {
  if (stamp.length === 0) return false; // launchd-parented from birth
  if (process.ppid !== stamp[0]) return true;
  for (let k = 0; k < stamp.length; k++) {
    const cur = ppidOf(stamp[k]!);
    if (cur === null) return true; // ancestor gone
    // The last recorded link only has to be alive. A complete walk ends just
    // below pid 1, whose parent (launchd) never dies, so asserting parent==1
    // there was vacuous — and when the 10-link cap TRUNCATED the walk, that
    // same assertion misread the real parent as a reparenting and drained the
    // fleet within a second of start (H-635: deep process trees, e.g. a CI
    // runner above npm above vitest, hit the cap deterministically).
    if (k + 1 >= stamp.length) break;
    if (cur !== stamp[k + 1]!) return true; // reparented — its own parent died
  }
  return false;
}
