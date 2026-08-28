// H-434: console.log and events.log grew forever — no rotation anywhere in
// rev's source — and accumulated plaintext contact data. Proves both rotation
// paths actually bound file size and preserve a usable tail.
import { describe, it, expect, afterEach } from 'vitest';
import { closeSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_LOG_BYTES, KEEP_TAIL_BYTES, rotateIfOversized, rotateOpenFd } from '../src/logretention.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rev-logretention-'));
  dirs.push(d);
  return d;
}
afterEach(() => dirs.splice(0));

describe('rotateIfOversized (events.log)', () => {
  it('leaves an under-cap file untouched', () => {
    const p = join(tmpDir(), 'events.log');
    const line = `${'x'.repeat(100)}\n`;
    writeFileSync(p, line);
    rotateIfOversized(p);
    expect(readFileSync(p, 'utf8')).toBe(line);
  });

  it('truncates an over-cap file down to the tail', () => {
    const p = join(tmpDir(), 'events.log');
    const line = 'A'.repeat(1000) + '\n';
    const lines = Math.ceil((MAX_LOG_BYTES + 10_000) / line.length);
    writeFileSync(p, line.repeat(lines));
    rotateIfOversized(p);
    const after = readFileSync(p);
    expect(after.length).toBeLessThanOrEqual(KEEP_TAIL_BYTES);
    expect(after.length).toBeGreaterThan(0);
    // What's kept is genuinely the tail, not arbitrary bytes.
    const original = line.repeat(lines);
    expect(original.endsWith(after.toString('utf8'))).toBe(true);
  });

  it('does nothing for a path that does not exist yet', () => {
    expect(() => rotateIfOversized(join(tmpDir(), 'missing.log'))).not.toThrow();
  });
});

describe('rotateOpenFd (console.log)', () => {
  it('copy-truncates in place and further writes append from the new end', () => {
    const dir = tmpDir();
    const p = join(dir, 'console.log');
    const fd = openSync(p, 'a');
    try {
      const chunk = Buffer.from('B'.repeat(1000) + '\n');
      const chunks = Math.ceil((MAX_LOG_BYTES + 10_000) / chunk.length);
      for (let i = 0; i < chunks; i++) writeSync(fd, chunk);
      expect(statSync(p).size).toBeGreaterThan(MAX_LOG_BYTES);

      rotateOpenFd(p, fd);
      const rotatedSize = statSync(p).size;
      expect(rotatedSize).toBeLessThanOrEqual(KEEP_TAIL_BYTES);
      expect(rotatedSize).toBeGreaterThan(0);

      // O_APPEND on the still-open fd: this write must land after the tail,
      // not clobber it or reopen at a stale offset.
      writeSync(fd, 'MARKER\n');
      const finalContent = readFileSync(p, 'utf8');
      expect(finalContent.endsWith('MARKER\n')).toBe(true);
      expect(finalContent.length).toBe(rotatedSize + 'MARKER\n'.length);
    } finally {
      closeSync(fd);
    }
  });

  it('leaves an under-cap open file untouched', () => {
    const dir = tmpDir();
    const p = join(dir, 'console.log');
    const fd = openSync(p, 'a');
    try {
      writeSync(fd, 'small\n');
      rotateOpenFd(p, fd);
      expect(readFileSync(p, 'utf8')).toBe('small\n');
    } finally {
      closeSync(fd);
    }
  });
});
