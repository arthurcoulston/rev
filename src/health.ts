// Fleet-down detection (H-448). Rev already models a failing wake-check as
// "no news, try next poll" — right for a locked store or a moment's
// contention, and wrong for anything permanent.
//
// On 2026-08-27 a corrupt id counter in Helmo made every wake-check throw. Both
// loops sat dead for forty minutes, polling once a minute, logging faithfully,
// escalating nothing. It cost nothing — which is exactly why nothing noticed:
// the burn breaker watches spend, and this outage was free, silent, and total.
// Free and total is the same combination that produced the 34-42 hour outage of
// 2026-08-26.
//
// The hard part is that rev's escalation path IS Helmo. When Helmo is what
// broke, a ticket cannot be filed — so the alarm has to leave the building by
// another door. It still tries Helmo (it costs nothing and often Helmo is fine
// and the fault is elsewhere), then raises an out-of-band notification.
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { logEvent, sHas, sSet } from './sentinels.js';

export type WedgeAction = { act: 'ok' } | { act: 'wedge'; reason: string };

/** A loop is wedged when it cannot reach Helm for long enough that "transient"
 *  has stopped being a credible explanation. Pure, so the threshold is testable
 *  without breaking a store. */
export function wedgeDecide(consecutiveFailures: number, cap: number): WedgeAction {
  if (cap <= 0 || consecutiveFailures < cap) return { act: 'ok' };
  return {
    act: 'wedge',
    reason: `cannot reach Helm: ${consecutiveFailures} consecutive wake-check failures. A poll that keeps failing is not contention any more — the store or its path is broken, and this loop is drawing no work.`,
  };
}

/** Out-of-band alarm: the one thing that does not depend on the system that
 *  might be broken. Best-effort by design — a failed alarm must never take a
 *  loop down on top of whatever is already wrong. */
export function notifyOperator(title: string, message: string): boolean {
  try {
    if (platform() === 'darwin') {
      // Passed as argv to osascript, which is fine — these are our own strings,
      // never a credential and never upstream text.
      execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message.slice(0, 400))} with title ${JSON.stringify(title.slice(0, 100))} sound name "Basso"`], {
        stdio: 'ignore',
        timeout: 5000,
      });
      return true;
    }
  } catch {
    /* an alarm that fails is not grounds to fail anything else */
  }
  return false;
}

/** Raise the wedge alarm at most once per episode. The sentinel is cleared when
 *  a wake-check next succeeds, so a recovered loop can alarm again if it wedges
 *  a second time — but a wedged loop does not notify every sixty seconds. */
export function raiseWedgeAlarm(loop: string, reason: string): void {
  if (sHas(loop, 'WEDGED')) return;
  sSet(loop, 'WEDGED', `${reason}\nat=${new Date().toISOString()}\n`);
  logEvent(loop, 'wedged', reason.slice(0, 200));
  console.error(`rev: loop '${loop}' is WEDGED — ${reason}`);
  const notified = notifyOperator('Rev: fleet down', `Loop '${loop}' cannot reach Helm. No work is being drawn.`);
  logEvent(loop, 'wedge-alarm', `notified=${notified}`);
}
