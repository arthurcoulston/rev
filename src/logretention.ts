// console.log and events.log are debug/operational transcripts, not records
// Arthur needs kept indefinitely — nothing rotated them, so they grew forever
// and accumulated plaintext contact data surfaced by outreach-grading work
// (H-434). Rotate in place once a log crosses MAX_LOG_BYTES, keeping the most
// recent KEEP_TAIL_BYTES so `rev view` (events.log tail) and escalateBlocked
// (console tail) still have enough history to diagnose from.
import { ftruncateSync, readFileSync, statSync, writeFileSync } from 'node:fs';

export const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB
export const KEEP_TAIL_BYTES = 1 * 1024 * 1024; // retained across rotation

// console.log's fd stays open for the life of the child (supervisor.ts opens
// it once with O_APPEND and hands it to the child as stdio) and offset is
// shared between parent and child. So rotation is copy-truncate in place —
// ftruncate the live fd, rewrite the tail — rather than reopen, which would
// orphan the child's writes onto a renamed file nobody rotates again.
export function rotateOpenFd(path: string, fd: number): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= MAX_LOG_BYTES) return;
  try {
    const tail = readFileSync(path).subarray(-KEEP_TAIL_BYTES);
    ftruncateSync(fd, 0);
    writeFileSync(fd, tail);
  } catch {
    /* rotation must never take down the loop */
  }
}

// events.log is appended via a fresh open/close per write (sentinels.ts),
// so there's no shared fd to preserve — rotate by rewriting the file.
export function rotateIfOversized(path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= MAX_LOG_BYTES) return;
  try {
    const tail = readFileSync(path).subarray(-KEEP_TAIL_BYTES);
    writeFileSync(path, tail);
  } catch {
    /* rotation must never take down the loop */
  }
}
