// The single-loop driver: wake on the Helm cursor, spawn one session, classify
// the outcome through the ladder, idle or halt. v0 runs one loop in the
// foreground; the multi-loop supervisor is the next milestone.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, tokenLogPath } from './config.js';
import { LaunchAdmission, LaunchClaim, WakeCheck, WorkstreamInfo, actorActivity, actorSelfSpend, actorTickets, escalateBlocked, escalateSilentDeclines, launchAdmit, launchClaim, launchId, launchQuarantine, launchReceipt, launchRevalidate, openEscalation, poolWorker, readyTicketIds, recordSpend, releaseClaim, scopeLabel, seatHolds, seatId, seatName, seatStreams, wakeCheck, workstreamInfo } from './helm.js';
import { burnWindow, markBurnFloor, recentCosts } from './burn.js';
import { exhaustedLimit, pollUsage, readCodexUsage, readUsage, refreshCodexUsage, refreshFor, usageForModel } from './usage.js';
import { anomalyDecide, capacityDecide, planPointsConsumed } from './capacity.js';
import { choiceExhausted, selectRun } from './routing.js';
import { raiseWedgeAlarm, wedgeDecide } from './health.js';
import { breakerDecide, declineDecide, ladderDecide, limitDecide, probeDecide, rollingMean, seatDecide, velocityToPause, wakeDecide } from './ladder.js';
import { logEvent, occupiedPid, paceAutoRelease, pidAlive, runningStamp, sClear, sGet, sHas, sOwner, sReleaseOwned, sSet, sSetOwned, sValue, streak, streakMap, streakMapSet, streakReset } from './sentinels.js';
import { ancestryBroken, ancestryStamp } from './ancestry.js';
import { runSession } from './shim.js';
import { GlobalConfig, LoopConfig, RunChoice } from './types.js';
import { recordLaunchAdmission, recordLaunchClaim, recordLaunchDispatch, recordLaunchIntent, settleLaunch, unsettledLaunches } from './launch-journal.js';

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

function writeBlockedDetail(
  dir: string,
  detail: { kind: 'anomaly' | 'capacity'; reason: string; observed: unknown; measured_against: unknown; at: string; investigation_ticket: string | null },
): void {
  writeFileSync(join(dir, 'BLOCKED.json'), `${JSON.stringify(detail, null, 2)}\n`);
}

/** Helm is reachable across a subprocess boundary, so a poll can fail for
 *  reasons that have nothing to do with the work: a locked store, a moment's
 *  contention. That is a transient condition — the state rev already models —
 *  never grounds to kill the loop, which is what an uncaught throw here used to
 *  do (H-134). Failure reads as "no news": the next poll decides. */
function tryWakeCheck(g: GlobalConfig, l: LoopConfig, sinceSeq: number): WakeCheck | null {
  try {
    const w = wakeCheck(g, l, sinceSeq);
    // Reached Helm: any wedge is over, and a later one may alarm again.
    streakReset(l.name, 'wakefail');
    sClear(l.name, 'WEDGED');
    return w;
  } catch (e) {
    logEvent(l.name, 'wake-check-failed', String(e).slice(0, 200));
    console.error(`rev: wake-check failed for '${l.name}' — retrying next poll. ${String(e).slice(0, 200)}`);
    // "No news, try next poll" is right for contention and wrong for anything
    // permanent. Past the cap this stops being a retry and becomes an outage
    // nobody was told about (H-448).
    const decision = wedgeDecide(streak(l.name, 'wakefail', true), g.wedge_cap);
    if (decision.act === 'wedge') raiseWedgeAlarm(l.name, decision.reason);
    return null;
  }
}

// Steering is numbers in fixed wording (H-1186): the budget figures from the
// store and nothing else. A stream's goal used to ride here as prose —
// standing instruction in every prompt, from a store field no cap or review
// covered — and the roster's `prompt` tail was the same channel one level up.
// Several budgeted streams are each named, because one stream's close-out cue
// says nothing about another (H-954); streams without a budget add nothing
// and stay out of the preamble (H-1127).
export function steeringText(streams: WorkstreamInfo[]): string {
  const budgets = streams.filter((w) => w.budget_usd !== null);
  if (budgets.length === 0) return '';
  const uncapped = budgets.filter((w) => w.budget_usd === 0);
  const finite = budgets.filter((w) => (w.budget_usd ?? 0) > 0);
  const uncappedText = uncapped
    .map((w) => `Spending cap for '${w.name}': none (budget_usd 0 sentinel); $${w.spent_usd.toFixed(2)} measured spend disclosed. Runnable work remains runnable. `)
    .join('');
  const money = (w: WorkstreamInfo) =>
    `$${w.spent_usd.toFixed(2)} of $${(w.budget_usd ?? 0).toFixed(2)} spent, $${(w.remaining_usd ?? 0).toFixed(2)} remains`;
  if (finite.length === 0) return uncappedText;
  if (finite.length === 1) {
    const w = finite[0]!;
    return uncappedText + `Budget for '${w.name}': ${money(w)}. The budget is the plan — take the highest-value work first; if it is exhausted, close out honestly with residuals documented rather than starting more. `;
  }
  return (
    uncappedText +
    `You hold finite-budget work in more than one workstream (${finite.map((w) => `'${w.name}'`).join(', ')}). ` +
    finite.map((w) => `Budget for '${w.name}': ${money(w)}. `).join('') +
    `A budget is the plan — take the highest-value work first; where one is exhausted, close out that stream honestly with residuals documented rather than starting more. `
  );
}

export interface RunOptions {
  count?: number; // bounded run for troubleshooting; 0/undefined = unbounded to the ceiling
}

export async function runLoop(g: GlobalConfig, l: LoopConfig, opts: RunOptions = {}): Promise<void> {
  const dir = stateDir(l.name);

  const existing = occupiedPid(l.name);
  if (existing) {
    throw new Error(`A '${l.name}' loop is already running (PID ${existing}). Check: rev status`);
  }
  sSet(l.name, 'RUNNING', runningStamp());
  sClear(l.name, 'SEAT_HELD');
  if (!sHas(l.name, 'PACE') && l.pace < 1) sSetOwned(l.name, 'PACE', { value: String(l.pace), by: 'rev', at: new Date().toISOString(), pid: process.pid, reason: 'configured loop pace', expires_at: 'never' });
  // Burn-breaker window floor: this process's start (H-412).
  const allChoices = [...l.choices, ...l.fallbacks, ...(g.probe ? [g.probe] : [])];
  markBurnFloor(l.name, allChoices.some((c) => (c.billing ?? 'metered') === 'metered') ? 'metered' : 'subscription');
  const cleanup = () => {
    sClear(l.name, 'RUNNING', 'PARKED', 'SEAT_HELD');
    if (!sGet(l.name, 'LIMIT')?.split('\n').some((line) => line.startsWith('resume_at='))) sClear(l.name, 'LIMIT');
  };
  process.on('exit', cleanup);

  const cycle = l.choices.map((c) => `${c.provider}/${c.model}`).join(' ⇄ ');
  console.log(`rev: loop '${l.name}' | ${scopeLabel(l)} | ${cycle} | cwd ${l.cwd}`);
  console.log(`rev: state ${dir} — stop it with: rev stop ${l.name}`);
  logEvent(l.name, 'loop-start', `pid=${process.pid} count=${opts.count ?? 0}`);

  // A prior process that died after admission left an ambiguous boundary.
  // Quarantine only that workflow attempt; ordinary work and sibling branches
  // remain runnable. Failed quarantine stays journaled for the next restart.
  // A pool worker's claim is put back as well (H-574): a claim the dead
  // process held would otherwise sit in progress under the seat, where no
  // sibling's launch-claim can reach it. An intent with no recorded answer is
  // replayed under its own launch id — Helmo returns the original receipt, or
  // claims afresh, and either way what it names is released.
  for (const recovered of unsettledLaunches(l.name)) {
    if (!recovered.admission_id && !recovered.claim) continue;
    try {
      if (recovered.admission_id) {
        launchQuarantine(g, recovered.admission_id, recovered.launch_id, `Rev recovered an unsettled ${recovered.phase} launch after process restart.`);
      }
      if (recovered.claim) {
        const ticket = recovered.ticket_id ?? launchClaim(g, l, recovered.launch_id).ticketId;
        if (ticket && releaseClaim(g, l, ticket, `recovered unsettled launch ${recovered.launch_id} after process restart`)) {
          logEvent(l.name, 'claim-released', `${ticket} recovered ${recovered.phase}`);
        }
      }
      settleLaunch(l.name, recovered.launch_id, 'quarantined');
      logEvent(l.name, 'launch-quarantined', `${recovered.launch_id} recovered ${recovered.phase}`);
    } catch (e) {
      logEvent(l.name, 'launch-quarantine-failed', `${recovered.launch_id} ${String(e).split('\n')[0]!.slice(0, 160)}`);
    }
  }

  let i = 0;
  let durWindow: number[] = [];
  let tAvg = 0;
  let firstPoll = true; // restart pickup: see the wake gate below (H-426)
  let seatHeld = false; // same-seat guard episode flag: log once per hold, not per poll (H-558)
  const lineage = ancestryStamp();

  // Bounded runs and the iteration ceiling. A helper because an iteration can
  // now end before a session is ever spent: the launch gate below refuses one.
  const countReached = (): boolean => {
    if (opts.count && i >= opts.count) {
      console.log(`rev: requested run count (${opts.count}) reached — halting '${l.name}'.`);
      logEvent(l.name, 'loop-stop', `reason=count runs=${i}`);
      return true;
    }
    if (i >= g.iteration_ceiling) {
      console.log(`rev: iteration ceiling (${g.iteration_ceiling}) reached — halting '${l.name}'.`);
      logEvent(l.name, 'loop-stop', `reason=ceiling runs=${i}`);
      return true;
    }
    return false;
  };

  // The drain's last step. A signal arriving mid-iteration cannot be delivered
  // until the event loop turns (see the yield below), so by the time this runs
  // the iteration it interrupted has finished — say so in the loop's own log,
  // which otherwise records nothing at all about why the process ended.
  const stopOnSignal = (code: number, reason: string) => () => {
    logEvent(l.name, 'loop-stop', `reason=${reason} runs=${i}`);
    process.exit(code);
  };
  process.on('SIGINT', stopOnSignal(130, 'SIGINT'));
  process.on('SIGTERM', stopOnSignal(143, 'drain'));

  while (true) {
    // One turn of the event loop, and the reason it has to be here (H-1109).
    // The shim runs a session with spawnSync, so a SIGTERM that arrives during
    // an iteration is held until something yields to libuv — and on the
    // continue path back to here, nothing does: every await between run-end
    // and the next run-start resolves synchronously, which drains microtasks
    // without ever letting the signal watcher fire. So the drain was not
    // deferred to the iteration boundary, as the supervisor's cascade
    // documents; it was swallowed. On 2026-09-07 six loops exited in
    // milliseconds while mason ran three more full-price iterations on the old
    // code and held the whole fleet down for ten minutes. The halt sentinels
    // below already promise that an operator signal between iterations always
    // wins; this is what makes that true for signals as well as files.
    await new Promise((r) => setImmediate(r));
    // Orphan watchdog (H-281): a broken ancestor chain is the one unforgeable
    // sign nobody who started this loop is still watching it — a SIGKILLed
    // supervisor, or a dead shell above a surviving tsx wrapper (the
    // 2026-08-28 swarm: ~28 such trees iterating on old code for days, every
    // ppid link inside them intact). Checked between iterations, so an
    // in-flight session always finishes its close-out first (H-467).
    if (ancestryBroken(lineage)) {
      logEvent(l.name, 'orphaned', `lineage [${lineage.join(' < ')}] broken runs=${i}`);
      console.log(`rev: lineage broken (an ancestor died) — loop '${l.name}' exiting.`);
      return;
    }
    // Halt sentinels, checked at the top so an operator signal between
    // iterations always wins.
    for (const s of ['STOP', 'HOLD', 'BLOCKED'] as const) {
      if (sHas(l.name, s)) {
        logEvent(l.name, 'loop-stop', `reason=${s} runs=${i}`);
        console.log(`rev: ${s} present — halting '${l.name}' after ${i} run(s).`);
        return;
      }
    }

    // Live park (command != state: PARKED is the ack a coordinator waits for).
    const paceOwner = sOwner(l.name, 'PACE');
    if (paceOwner?.value === 'park') {
      const event = paceAutoRelease(paceOwner);
      if (event) {
        if (sReleaseOwned(l.name, 'PACE', paceOwner)) logEvent(l.name, event, `by=${paceOwner.by} at=${paceOwner.at} pid=${paceOwner.pid}`);
        else logEvent(l.name, 'pace-superseded', `by=${paceOwner.by} at=${paceOwner.at} pid=${paceOwner.pid}`);
      }
    }
    if (sValue(l.name, 'PACE') === 'park') {
      if (!sHas(l.name, 'PARKED')) {
        sSet(l.name, 'PARKED', new Date().toISOString());
        logEvent(l.name, 'park');
        console.log(`rev: parked '${l.name}' (PACE=park); clear PACE to resume.`);
      }
      await sleep(g.poll_seconds);
      continue;
    } else if (sHas(l.name, 'PARKED')) {
      sClear(l.name, 'PARKED');
      logEvent(l.name, 'resume');
    }

    // Idle: poll the Helm cursor; zero tokens until there is real work.
    const idle = sGet(l.name, 'IDLE');
    if (idle !== null) {
      const since = parseInt(idle, 10) || 0;
      const w = tryWakeCheck(g, l, since);
      if (!w) {
        await sleep(g.poll_seconds);
        continue;
      }
      // All loops wake on motion only (H-426; store-wide since H-92): ready_count
      // is a standing property, not motion, so a loop that declines a ticket and
      // idles would be re-woken by that same ticket every poll, forever. The one
      // exception is the first successful poll after process start — standing
      // ready work counts once there, so a loop that went down with work queued
      // picks it up on restart instead of waiting for something else to move.
      const restartPoll = firstPoll;
      const wake = wakeDecide({
        changedSince: w.changed_since,
        firstPoll: restartPoll,
        workstream: l.workstream,
        readyCount: w.ready_count,
        newlyReadyCount: w.newly_ready_count,
        resyncDue: Date.now() - (parseInt(sGet(l.name, 'IDLE_AT') ?? '', 10) || Date.now()) >= 3_600_000,
      });
      firstPoll = false;
      // Idle floor (H-336/H-545): an unproductive pass costs the same whatever
      // it finds, and both burn incidents were wakes minutes apart from a live
      // desk session or the loop's own exhaust. Motion accumulates while held —
      // nothing is lost; the wake fires once the floor has elapsed. A fresh
      // process bypasses the old process's floor on its restart-pickup poll.
      const idleAt = parseInt(sGet(l.name, 'IDLE_AT') ?? '', 10) || 0;
      if (wake && (l.workstream !== '*' || restartPoll || l.idle_floor_s <= 0 || Date.now() - idleAt >= l.idle_floor_s * 1000)) {
        sClear(l.name, 'IDLE');
        sClear(l.name, 'IDLE_AT');
        logEvent(l.name, 'wake', `since=${since} ready=${w.ready_count}`);
      } else {
        await sleep(g.poll_seconds);
        continue;
      }
    }

    const before = tryWakeCheck(g, l, 0);
    if (!before) {
      await sleep(g.poll_seconds);
      continue;
    }
    // Same-seat guard (H-558): before spending a session, ask who already
    // holds in_progress work in this name. The loop's own claims carry its
    // seat stamp; anything else fresh is another live instance — a desk
    // session or subagent sharing the crew name — and working over it is how
    // H-542 and H-560 were both trampled. Stand down and keep polling; the
    // guard is best-effort and a check failure never stops the loop.
    try {
      const holds = seatHolds(g, l).map((h) => ({
        ticketId: h.ticket_id,
        claimSession: h.claim_actor?.session ?? null,
        ageSeconds: h.claimed_at && Number.isFinite(Date.parse(h.claimed_at)) ? Math.max(0, (Date.now() - Date.parse(h.claimed_at)) / 1000) : null,
      }));
      const seat = seatDecide({ holds, sessions: l.peer_sessions ?? [seatId(l)], staleSeconds: g.seat_stale_seconds });
      if (seat.act === 'stand_down') {
        sSet(l.name, 'SEAT_HELD', seat.reason);
        if (!seatHeld) {
          seatHeld = true;
          logEvent(l.name, 'seat-held', seat.reason);
          console.log(`rev: '${l.name}' standing down — ${seat.reason}. Polling until the seat clears.`);
        }
        await sleep(g.poll_seconds);
        continue;
      }
      if (seatHeld) {
        seatHeld = false;
        sClear(l.name, 'SEAT_HELD');
        logEvent(l.name, 'seat-clear');
      }
    } catch (e) {
      if (seatHeld) {
        seatHeld = false;
        sClear(l.name, 'SEAT_HELD');
      }
      logEvent(l.name, 'seat-check-failed', String(e).slice(0, 200));
    }
    // Workflow launch admission (H-2561): the last gate before a session is
    // spent. A ticket bound to a workflow attempt may only be started once its
    // requirements have passed, and the check, the admission record and the
    // attempt's own state have to move together or not at all — which only
    // Helmo can do. So Rev asks, and keeps no verdict: a denied seat re-idles
    // at the cursor it read and asks again on the next motion or the hourly
    // resync, and a fresh process asks again on its restart pickup rather than
    // walking through a denial it never saw. Even an old store is asked every
    // pass so an ordinary candidate cannot confer a later workflow bypass.
    const thisLaunchId = launchId(l, i + 1);
    let journaledLaunchId: string | null = null;
    let admission: LaunchAdmission;
    try {
      // A pool worker is admitted by its claim, taken just before dispatch.
      admission = poolWorker(l)
        ? { act: 'launch', how: 'nothing_gated', reason: 'pool worker claims at dispatch', ticketId: null }
        : launchAdmit(g, l, thisLaunchId, (candidate, stableLaunchId) => recordLaunchIntent(l.name, stableLaunchId, candidate));
      if (admission.how === 'admitted' && admission.admissionId && admission.workflowAttemptId && admission.launchId) {
        recordLaunchAdmission(l.name, launchReceipt(g, admission.admissionId, admission.launchId));
        journaledLaunchId = admission.launchId;
      }
    } catch (e) {
      admission = { act: 'deny' as const, how: 'unavailable' as const, ticketId: null, reason: `launch identity could not be persisted: ${String(e).split('\n')[0]!.slice(0, 160)}` };
    }
    if (admission?.act === 'deny') {
      i += 1;
      firstPoll = false;
      logEvent(l.name, 'launch-denied', admission.reason);
      console.log(`rev: '${l.name}' was not admitted to launch — ${admission.reason}`);
      sSet(l.name, 'IDLE', `${before.max_seq}\n${admission.reason}\n`);
      sSet(l.name, 'IDLE_AT', String(Date.now()));
      if (countReached()) return;
      await sleep(g.poll_seconds);
      continue;
    } else if (admission?.how === 'unsupported') {
      // This branch is reachable only for an ordinary candidate;
      // workflow-bound work takes the deny branch above. Ask on every pass so
      // a later workflow candidate cannot inherit an ordinary ticket's bypass.
      logEvent(l.name, 'launch-admit-unsupported', admission.reason);
    } else if (admission?.how === 'unavailable') {
      logEvent(l.name, 'launch-admit-failed', admission.reason);
    } else if (admission?.how === 'admitted') {
      logEvent(l.name, 'launch-admitted', `${admission.reason}${admission.ticketId ? ` (${admission.ticketId})` : ''}`);
    }
    i += 1;
    firstPoll = false; // an iteration IS the restart pickup — see the wake gate
    const started = Date.now();
    // Include desk meetings in Codex's shared allowance, without a model call.
    if ([...l.choices, ...l.fallbacks, ...(g.probe ? [g.probe] : [])].some((c) => c.runtime === 'codex')) refreshCodexUsage();
    const providerUsage = () => ({ claude: readUsage(), codex: readCodexUsage(), mock: null });
    const exhaustedChoice = (c: RunChoice) =>
      choiceExhausted(c, providerUsage(), g.limit_exhausted_percent);
    const sel = selectRun(l, providerUsage(), i, g.limit_exhausted_percent);
    let choice = sel.choice;
    if (sel.switched) {
      logEvent(l.name, 'provider-switch', `iter=${i} ${sel.switched}`);
      console.log(`rev: ${sel.switched}`);
    }
    if ((choice.billing ?? 'metered') === 'subscription') {
      const capacityThresholds = {
        exhaustedPercent: g.limit_exhausted_percent,
        sharedReservePercent: g.shared_reserve_percent,
        blockHorizonSeconds: g.limit_block_horizon_seconds,
        exhaustionCeilingSeconds: g.exhaustion_ceiling_seconds,
        staleGraceIterations: g.stale_grace_iterations,
        staleWaitSeconds: g.limit_wait_seconds,
      };
      const capacityChoices = () => {
        const ordered = [choice, ...l.choices, ...l.fallbacks].filter((c, n, a) =>
          a.findIndex((x) => x.provider === c.provider && x.model === c.model) === n,
        );
        return ordered.map((c) => ({
          choice: c,
          snapshot: c.runtime === 'mock' ? null : usageForModel(providerUsage()[c.runtime], c.model),
          refreshed: false,
        }));
      };
      let capacities = capacityChoices();
      let capacity = capacityDecide({
        choices: capacities,
        isLoopRun: true,
        staleIterations: streak(l.name, 'capacity_stale', false),
        thresholds: capacityThresholds,
      });
      if (capacity.act === 'refresh') {
        await Promise.all(capacity.providers.map((provider) =>
          refreshFor(capacities.find((c) => c.choice.provider === provider)?.choice.runtime ?? provider),
        ));
        const refreshed = new Set(capacity.providers);
        capacities = capacityChoices().map((c) => ({ ...c, refreshed: refreshed.has(c.choice.provider) }));
        capacity = capacityDecide({
          choices: capacities,
          isLoopRun: true,
          staleIterations: streak(l.name, 'capacity_stale', false),
          thresholds: capacityThresholds,
        });
      }
      if (capacity.act === 'switch') {
        choice = capacity.on;
        streakReset(l.name, 'capacity_stale');
        logEvent(l.name, 'capacity-switch', capacity.reason);
        console.log(`rev: ${capacity.reason}`);
      } else if (capacity.act === 'continue_stale') {
        choice = capacity.on;
        streak(l.name, 'capacity_stale', true);
        logEvent(l.name, 'capacity-stale', capacity.reason);
      } else if (capacity.act === 'continue') {
        choice = capacity.on;
        streakReset(l.name, 'capacity_stale');
      } else if (capacity.act === 'wait') {
        sSet(l.name, 'LIMIT', `kind=capacity\nretry_s=${capacity.seconds}\nreason=${capacity.reason}\n`);
        logEvent(l.name, 'capacity-wait', `seconds=${capacity.seconds} reason=${capacity.reason}`);
        await sleep(capacity.seconds);
        sClear(l.name, 'LIMIT');
        continue;
      } else if (capacity.act === 'scheduled_resume') {
        sSet(l.name, 'LIMIT', `kind=capacity\nresume_at=${capacity.resumeAt}\nreason=${capacity.reason}\n`);
        logEvent(l.name, 'capacity-scheduled', `resume_at=${capacity.resumeAt} reason=${capacity.reason}`);
        console.log(`rev: '${l.name}' has no plan capacity — scheduled to resume at ${capacity.resumeAt}.`);
        return;
      } else if (capacity.act === 'blocked') {
        const at = new Date().toISOString();
        sSet(l.name, 'BLOCKED', `kind=capacity\nreason=${capacity.reason}\nat=${at}\n`);
        logEvent(l.name, 'blocked', `kind=capacity reason=${capacity.reason}`);
        let investigationTicket: string | null = null;
        try {
          investigationTicket = escalateBlocked(g, l, capacity.reason, '', dir, 'capacity');
          console.log(`rev: '${l.name}' BLOCKED — escalated as Helm ticket ${investigationTicket}.`);
        } catch (e) {
          console.error(`rev: '${l.name}' BLOCKED — escalation failed (${String(e).slice(0, 200)}).`);
        }
        writeBlockedDetail(dir, {
          kind: 'capacity', reason: capacity.reason,
          observed: capacities.map(({ choice: c, snapshot }) => ({
            provider: c.provider, model: c.model,
            limits: snapshot?.limits.map(({ label, percent, resets_at }) => ({ label, percent, resets_at })) ?? null,
          })),
          measured_against: {
            exhausted_percent: g.limit_exhausted_percent - g.shared_reserve_percent,
            exhaustion_ceiling_seconds: g.exhaustion_ceiling_seconds,
          },
          at, investigation_ticket: investigationTicket,
        });
        return;
      }
    }
    // Pool workers (H-574): the claim is taken here, after every capacity exit
    // above and before a run is logged or anything spent, so no early return
    // can strand it.
    // Helmo selects, admits and claims in one transaction; the session is then
    // told the ticket rather than choosing one, because a sibling worker on
    // the same seat is reading the same queue.
    let claimedTicket: string | null = null;
    if (poolWorker(l)) {
      let claim: LaunchClaim | null = null;
      try {
        recordLaunchIntent(l.name, thisLaunchId, { claim: true });
        claim = launchClaim(g, l, thisLaunchId);
        if (claim.how === 'claimed') {
          if (claim.admissionId) recordLaunchAdmission(l.name, launchReceipt(g, claim.admissionId, thisLaunchId));
          else recordLaunchClaim(l.name, thisLaunchId, claim.ticketId!);
          journaledLaunchId = thisLaunchId;
          claimedTicket = claim.ticketId;
          admission = { ...admission, act: 'launch', how: 'admitted', reason: claim.reason, ticketId: claim.ticketId, admissionId: claim.admissionId, workflowAttemptId: claim.workflowAttemptId, launchId: thisLaunchId };
          logEvent(l.name, 'launch-claimed', claim.reason);
        } else if (claim.how !== 'unavailable') {
          // Nothing was claimed, so there is nothing for a restart to resolve.
          settleLaunch(l.name, thisLaunchId, 'complete');
        }
      } catch (e) {
        if (claim?.how === 'claimed' && claim.ticketId) {
          try { releaseClaim(g, l, claim.ticketId, `its launch could not be journaled`); } catch { /* the intent stays journaled for restart recovery */ }
        }
        claim = { act: 'deny', how: 'unavailable', ticketId: null, reason: `launch claim could not be persisted: ${String(e).split('\n')[0]!.slice(0, 160)}` };
      }
      if (!claimedTicket) {
        logEvent(l.name, claim.act === 'idle' ? 'launch-idle' : 'launch-denied', claim.reason);
        if (claim.act !== 'idle') console.log(`rev: pool worker '${l.name}' was not admitted to launch — ${claim.reason}`);
        sSet(l.name, 'IDLE', `${before.max_seq}\n${claim.reason}\n`);
        sSet(l.name, 'IDLE_AT', String(Date.now()));
        if (countReached()) return;
        await sleep(g.poll_seconds);
        continue;
      }
    }
    // The probe tier (H-412): nothing ready and nothing in hand means this
    // iteration can only read the queue and stop, so it runs on the cheap
    // model. Decided per iteration from the fresh wake-check, never sticky.
    // A [global] probe pin (H-625) routes the probe to its own provider while
    // that cap stands; otherwise it probes on the provider chosen above.
    const probe = probeDecide({
      probeModel: choice.probe_model,
      workstream: l.workstream,
      // A claimed ticket is work in hand, whatever the earlier read saw.
      readyCount: claimedTicket ? Math.max(1, before.ready_count) : before.ready_count,
      heldCount: before.held_count,
      pinned: g.probe,
      pinnedExhausted: g.probe ? exhaustedChoice(g.probe) : undefined,
      mock: choice.runtime === 'mock',
    });
    const run = probe?.on ?? choice;
    const model = probe?.model ?? choice.model;
    logEvent(l.name, 'run-start', `iter=${i} seq=${before.max_seq} provider=${run.provider}${probe ? ` probe=${model}` : ''}`);
    console.log(`=== ${l.name} run ${i} started ${new Date().toISOString()} (${run.provider}/${model}${probe ? ', probe' : ''}) ===`);

    // Steering disclosure up front (helmo H-55): a budget known before
    // planning changes what gets worked first; discovered at the end, it is
    // only a verdict. The streams are the seat's own — the one it watches, plus
    // every stream a ticket in its hands belongs to (H-954). Store-wide loops
    // still have no single stream to steer by, and their prompt does not carry
    // the close-out framing steering is written for, so they fetch nothing.
    const streams = l.workstream === '*' ? [] : [...new Set([l.workstream, ...seatStreams(g, l)])];
    const steering = steeringText(
      streams.map((n) => workstreamInfo(g, n)).filter((w): w is WorkstreamInfo => w !== null),
    );
    // Load the tools BEFORE the work, not when the need appears (H-448). An
    // agent picks its tool set from a guess about the session ahead, and
    // "I might need to file a ticket" is exactly what you discover halfway
    // through. Across the fleet, 13% of sessions since 2026-08-20 started
    // without create_ticket — and one of them, finding no tool for the job,
    // reasoned its way into writing to Helmo's SQLite file by hand and wedged
    // every loop in the estate for forty minutes.
    const toolset =
      (run.runtime === 'claude'
        ? `Load your full Helmo tool set before you start — create_ticket and return_to_human included, ` +
          `because you will not know you need them until you do (ToolSearch 'select:mcp__helmo__helmo_create_ticket'). `
        : `Your Helmo tools (helmo_*) are already loaded — create_ticket and return_to_human included; use them for all work tracking. `) +
      `A tool you did not load is never a reason to reach past Helmo: its store is guarded, and going around it once took the whole fleet down. `;
    // Both draws must teach the idle contract, because the ladder scores every
    // seat against it (H-740). Only the store-wide branch used to, and a scoped
    // seat cannot guess: every profile and doctrine tells an agent to record
    // what it found, so a blocked queue produced an honest "still blocked, base
    // still green" update — a real diff, so it clears helmo's advancing filter
    // and buys another full-price pass. H-412 closed that door for note-only
    // updates; evidence walked through the next one. The instruction is the fix,
    // not a narrower filter: the commit proving a build green is exactly the
    // evidence a ticket should carry when work HAS advanced.
    const putDown = (why: string) => {
      if (!claimedTicket) return;
      try {
        if (releaseClaim(g, l, claimedTicket, why)) logEvent(l.name, 'claim-released', `${claimedTicket} ${why}`);
      } catch (e) {
        logEvent(l.name, 'claim-release-failed', `${claimedTicket} ${String(e).split('\n')[0]!.slice(0, 160)}`);
      }
    };
    const draw = claimedTicket
      ? `Rev has already claimed ticket ${claimedTicket} for this launch, as seat '${seatName(l)}' from worker ${seatId(l)}. It is the only ticket you work this session: other workers on this seat hold their own claims, so do not claim, start or change any other ticket. You may file tickets you discover, linked to ${claimedTicket}. Work ${claimedTicket} to a natural stopping point, `
      : l.workstream === '*'
        ? `Use your Helmo tools: first list tickets assigned to you, then survey fresh activity and unclaimed filings across all workstreams — your constitution says what your work is. If nothing has materially changed since your last pass, end the session WITHOUT filing a ticket or writing a note: producing nothing is the idle signal this loop reads, and a no-change sweep record is itself fresh motion that wakes you again (H-545). Otherwise work to a natural stopping point, `
        : `Use your Helm tools: first list tickets assigned to you, then ready work in workstream '${l.workstream}'. A ticket reserved for you is yours to work whatever its workstream. If nothing in EITHER list is workable — both are empty, or every ticket is blocked, time-gated, or already sitting with the human — end the session WITHOUT filing a ticket or writing a note: producing nothing is the idle signal this loop reads, and recording the no-change finding re-certifies you as busy and buys another full-price pass, evidence attached or not (H-545, H-740). The one exception is a question only the human can answer that is not already pending — return that once, then stop. Otherwise work ONE ticket to a natural stopping point, `;
    const split =
      `If the ticket you pick will not reach a natural stopping point this pass, split it now: file children that each fit one iteration and close the parent as a plan with those children as evidence. `;
    const disposition =
      `Never leave ready work as found: record why and act — link its blocker, hand it to the right seat, return it or mark needs_human, set a genuine start date, or cancel with reason. ` +
      (l.workstream === '*'
        ? `For this store-wide sweep, a disposition note is action. `
        : `For a scoped seat, prevent that unchanged ticket waking it again. `);
    // Deploying a fix the crew has already committed and tested is the crew's
    // call, not a question for the operator (Arthur, H-1046) — and the bar the
    // draw sets for returning to the human is exactly where a loop decides to
    // ask. One clause, at the point of the decision (doctrine agent-context §9).
    const deploy =
      `A change you land that needs the Rev fleet restarted to take effect is yours to deploy, never a question for the human: run 'rev redeploy --ticket <id> --reason "<why>"' (node $REV_CLI redeploy ... if rev is not on your PATH) and it lands after your iteration ends. `;
    const prompt =
      `This is a Rev loop iteration, not a summon; AGENTS.md's summon clause does not apply; the queue is the work. ` +
      `Loop iteration ${i} for agent '${l.name}'. Working directory: ${l.cwd}. ` +
      toolset +
      steering +
      draw +
      split +
      (claimedTicket ? '' : disposition) +
      `record progress honestly, then end the session. ` +
      deploy;
    let readyBefore: string[] | null = null;
    if (l.workstream !== '*') {
      try { readyBefore = readyTicketIds(g, l); } catch (e) { logEvent(l.name, 'decline-check-failed', `before ${String(e).slice(0, 160)}`); }
    }
    const costBaseline = recentCosts(l.name, 5, tokenLogPath(), run.runtime);
    const usageBefore = (run.billing ?? 'metered') === 'subscription'
      ? usageForModel(providerUsage()[run.runtime], model)
      : null;
    if (journaledLaunchId && admission.admissionId) {
      try {
        launchRevalidate(g, admission.admissionId, journaledLaunchId);
      } catch (e) {
        try {
          launchQuarantine(g, admission.admissionId, journaledLaunchId, `Authority failed revalidation before dispatch: ${String(e).split('\n')[0]!.slice(0, 120)}`);
          settleLaunch(l.name, journaledLaunchId, 'quarantined');
        } catch { /* retain the unsettled journal for restart recovery */ }
        putDown('its workflow authority failed revalidation before dispatch');
        logEvent(l.name, 'launch-denied', `${journaledLaunchId} failed pre-dispatch revalidation`);
        sSet(l.name, 'IDLE', `${before.max_seq}\nworkflow launch ${journaledLaunchId} failed revalidation\n`);
        sSet(l.name, 'IDLE_AT', String(Date.now()));
        if (countReached()) return;
        await sleep(g.poll_seconds);
        continue;
      }
    }
    if (journaledLaunchId && !recordLaunchDispatch(l.name, journaledLaunchId)) {
      logEvent(l.name, 'launch-replay', `${journaledLaunchId} already reached dispatch`);
      putDown('its launch had already reached dispatch');
      console.error(`rev: suppressed replay of launch '${journaledLaunchId}' before model dispatch.`);
      sSet(l.name, 'IDLE', `${before.max_seq}\nworkflow launch ${journaledLaunchId} already reached dispatch\n`);
      sSet(l.name, 'IDLE_AT', String(Date.now()));
      if (countReached()) return;
      await sleep(g.poll_seconds);
      continue;
    }
    const res = runSession(g, l, prompt, model, run);
    let launchTrusted = true;

    if (journaledLaunchId && admission.admissionId) {
      try {
        launchRevalidate(g, admission.admissionId, journaledLaunchId);
        if (res.cls === 'ok') settleLaunch(l.name, journaledLaunchId, 'complete');
        else {
          launchQuarantine(g, admission.admissionId, journaledLaunchId, `Model session ended ${res.cls} before a trusted advance boundary.`);
          settleLaunch(l.name, journaledLaunchId, 'quarantined');
          logEvent(l.name, 'launch-quarantined', `${journaledLaunchId} session ${res.cls}`);
        }
      } catch (e) {
        launchTrusted = false;
        try {
          launchQuarantine(g, admission.admissionId, journaledLaunchId, `Authority failed revalidation after model output: ${String(e).split('\n')[0]!.slice(0, 120)}`);
          settleLaunch(l.name, journaledLaunchId, 'quarantined');
        } catch { /* recovery retries this exact affected launch */ }
        logEvent(l.name, 'launch-quarantined', `${journaledLaunchId} post-session revalidation failed`);
      }
    }
    // Whatever the session did, a claim it left in progress goes back to the
    // seat's queue, so the next free worker can continue it.
    if (claimedTicket && journaledLaunchId) {
      putDown(`session ended ${res.cls} with ${claimedTicket} still in progress`);
      if (!admission.admissionId) {
        try { settleLaunch(l.name, journaledLaunchId, res.cls === 'ok' ? 'complete' : 'quarantined'); }
        catch (e) { logEvent(l.name, 'launch-settle-failed', `${journaledLaunchId} ${String(e).split('\n')[0]!.slice(0, 160)}`); }
      }
    }

    const durSec = Math.round((Date.now() - started) / 1000);
    ({ window: durWindow, mean: tAvg } = rollingMean(durWindow, durSec));
    console.log(res.outputTail.slice(-2000));
    console.log(`=== ${l.name} run ${i} ended (rc=${res.rc} class=${res.cls} ${durSec}s) ===`);

    // Production means work advanced, not bytes written (H-412): a note-only
    // update does not count, so an agent that reports "nothing to do" idles
    // instead of re-certifying itself busy.
    const produced = res.cls === 'ok' && launchTrusted ? actorActivity(g, l, before.max_seq) > 0 : false;
    const failStreak = res.cls === 'failure' ? streak(l.name, 'fail', true) : 0;
    const limitStreak = res.cls === 'transient' ? streak(l.name, 'limit', true) : 0;
    let action = ladderDecide(res.cls, {
      produced,
      failStreak,
      limitStreak,
      failCap: g.fail_cap,
      limitCap: g.limit_cap,
      limitWait: g.limit_wait_seconds,
      storeWide: l.workstream === '*',
    });
    logEvent(l.name, 'run-end', `iter=${i} rc=${res.rc} class=${res.cls} produced=${produced} dur=${durSec}s action=${action.act}`);

    if (l.workstream !== '*' && res.cls === 'ok') {
      try {
        if (produced) {
          streakMapSet(l.name, 'silent_decline', {});
        } else if (readyBefore !== null) {
          const afterIds = readyTicketIds(g, l);
          const unchanged = readyBefore.filter((id) => afterIds.includes(id));
          const decline = declineDecide(streakMap(l.name, 'silent_decline'), unchanged, false);
          streakMapSet(l.name, 'silent_decline', decline.streaks);
          if (unchanged.length) {
            logEvent(l.name, 'silent-decline', `tickets=${unchanged.join(',')} streaks=${unchanged.map((id) => `${id}:${decline.streaks[id]}`).join(',')}`);
            console.log(`rev: '${l.name}' left ready work unchanged: ${unchanged.join(', ')}.`);
          }
          if (decline.escalate.length) {
            const id = escalateSilentDeclines(g, l, decline.escalate);
            logEvent(l.name, 'silent-decline-escalated', `ticket=${id} work=${decline.escalate.join(',')}`);
          }
        }
      } catch (e) {
        logEvent(l.name, 'decline-check-failed', `after ${String(e).slice(0, 160)}`);
      }
    }

    // Write metered spend back to the ticket(s) this iteration touched (H-19).
    // Whole session charged to the most-touched ticket — finer attribution
    // would be pretend precision; the note names any others. Runs after close
    // (record-spend accepts terminal tickets) and must never affect the run.
    if (res.tokens || res.cost_usd) {
      try {
        const touched = actorTickets(g, l, before.max_seq);
        if (touched.length) {
          const [primary, ...rest] = touched;
          // Net out anything the agent self-reported this session: the meter
          // is authoritative, and a session must land in the totals exactly
          // once (H-57). Each guess is cancelled on the ticket that carries it
          // — a session-wide correction on the primary once left it at −62k
          // while a side ticket kept the +80k guess (H-187).
          const self = actorSelfSpend(g, l, before.max_seq);
          const guess = new Map(self.by_ticket.map((t) => [t.id, t]));
          const primaryGuess = guess.get(primary!.id);
          const tokens = (res.tokens ?? 0) - (primaryGuess?.tokens ?? 0);
          const cost = (res.cost_usd ?? 0) - (primaryGuess?.cost_usd ?? 0);
          if (tokens || cost) {
            const note =
              `Metered by Rev: loop '${l.name}' iteration ${i} (${run.provider}/${model}), whole session charged to this ticket` +
              (rest.length ? `; session also touched ${rest.map((t) => t.id).join(', ')}` : '') +
              (primaryGuess
                ? `; net of ${primaryGuess.tokens} tokens / $${primaryGuess.cost_usd.toFixed(2)} the agent self-reported here (the meter is authoritative)`
                : '') + '.';
            recordSpend(g, primary!.id, tokens, cost, note);
            logEvent(l.name, 'spend', `iter=${i} ticket=${primary!.id} tokens=${tokens} cost=${cost}`);
          }
          for (const t of self.by_ticket) {
            if (t.id === primary!.id) continue;
            recordSpend(
              g, t.id, -t.tokens, -t.cost_usd,
              `Reconciled by Rev: loop '${l.name}' iteration ${i} self-reported ${t.tokens} tokens / $${t.cost_usd.toFixed(2)} here; cancelled — the metered session is charged to ${primary!.id}.`,
            );
            logEvent(l.name, 'spend', `iter=${i} ticket=${t.id} tokens=${-t.tokens} cost=${-t.cost_usd}`);
          }
        }
      } catch (e) {
        logEvent(l.name, 'spend-failed', `iter=${i} ${String(e).slice(0, 200)}`);
      }
    }

    // A flat-plan account is bounded by its plan bars, not cumulative notional
    // dollars, but a sudden change in either slope is still a real containment
    // signal. Compare against the baseline captured before this run, so the
    // iteration under judgment never dilutes its own rolling mean, and scoped to
    // its own runtime, so moving a loop between providers is not read as a burn
    // (H-585).
    if (res.cls === 'ok' && (run.billing ?? 'metered') === 'subscription') {
      const usageAfter = usageForModel(await refreshFor(run.runtime), model);
      const meanUsd = costBaseline.length
        ? costBaseline.reduce((sum, cost) => sum + cost, 0) / costBaseline.length
        : 0;
      const planPointsUsed = planPointsConsumed(usageBefore, usageAfter);
      const anomaly = anomalyDecide({
        observedUsd: res.cost_usd,
        meanUsd,
        windowSize: costBaseline.length,
        planPointsUsed,
        thresholds: {
          rateMultiple: g.anomaly_rate_multiple,
          minUsd: g.anomaly_min_usd,
          absPercent: g.anomaly_abs_percent,
        },
      });
      if (anomaly.act === 'trip') {
        const at = new Date().toISOString();
        logEvent(l.name, 'anomaly', anomaly.reason.replace(/^anomaly:\s*/, ''));
        sSet(l.name, 'BLOCKED', `kind=anomaly\nreason=${anomaly.reason}\nat=${at}\n`);
        let investigationTicket: string | null = null;
        try {
          investigationTicket = escalateBlocked(g, l, anomaly.reason, res.outputTail, dir, 'anomaly');
          logEvent(l.name, 'escalated', `ticket=${investigationTicket}`);
        } catch (e) {
          logEvent(l.name, 'escalate-failed', String(e).slice(0, 200));
        }
        writeBlockedDetail(dir, {
          kind: 'anomaly', reason: anomaly.reason,
          observed: { cost_usd: res.cost_usd ?? null, plan_points: planPointsUsed ?? null },
          measured_against: { mean_cost_usd: meanUsd, window: costBaseline.length, rate_multiple: g.anomaly_rate_multiple, absolute_plan_points: g.anomaly_abs_percent },
          at, investigation_ticket: investigationTicket,
        });
        console.log(`rev: ${anomaly.reason} — halting '${l.name}'.`);
        return;
      }
    }

    // A transient condition is the one moment the usage poller earns its keep
    // beyond a dashboard line (H-402). Poll it now — which cap is out, and when
    // it comes back, decides whether this is a wait or a decision. Before this,
    // every 429 got the same twenty blind fifteen-minute retries, which is how
    // 2026-08-26 became 34-42 hours of silence.
    if (res.cls === 'transient') {
      const snap =
        run.runtime === 'codex' ? readCodexUsage() : g.usage_poll_seconds > 0 ? await pollUsage() : readUsage();
      const ex = exhaustedLimit(usageForModel(snap, model), g.limit_exhausted_percent);
      if (ex) logEvent(l.name, 'limit-identified', `cap="${ex.label}" percent=${ex.percent} resets=${ex.resets_at ?? '-'}`);
      action = limitDecide({
        limitStreak,
        limitCap: g.limit_cap,
        limitWait: g.limit_wait_seconds,
        blockHorizonSeconds: g.limit_block_horizon_seconds,
        exhausted: ex ? { label: ex.label, percent: ex.percent, resets_at: ex.resets_at } : null,
        message: res.limit?.message,
      });
      // An identified cap with another provider still standing is a switch,
      // not a wait and not a block (H-479): the next iteration's choiceDecide
      // skips the exhausted provider because the same snapshot that named the
      // cap here is the one it reads. An unidentified transient (a 529, an
      // outage) keeps the ladder — switching providers over a network blip
      // would turn every wobble into a migration.
      if (ex && action.act !== 'continue') {
        const alt = selectRun(l, providerUsage(), i + 1, g.limit_exhausted_percent);
        if (alt.choice.provider !== run.provider && !exhaustedChoice(alt.choice)) {
          logEvent(l.name, 'limit-switch', `cap="${ex.label}" — continuing on ${alt.choice.provider}/${alt.choice.model}`);
          console.log(`rev: cap "${ex.label}" is out — continuing on ${alt.choice.provider}/${alt.choice.model}.`);
          streakReset(l.name, 'limit');
          action = { act: 'continue' };
        }
      }
    }

    // Burn breaker (H-412). The ladder judges how the iteration ended; this
    // judges what the loop has cost. Only 'continue' is checked — every other
    // action is already stopping. Evaluated after the spend write above so the
    // window includes the iteration that just ran.
    if (action.act === 'continue') {
      const continueStreak = streak(l.name, 'continue', true);
      const w = burnWindow(l.name);
      const trip = breakerDecide(
        { hourUsd: w.hourUsd, dayUsd: w.dayUsd, continueStreak },
        {
          usdPerHour: l.burn_usd_per_hour ?? g.burn_usd_per_hour,
          usdPerDay: l.burn_usd_per_day ?? g.burn_usd_per_day,
          continueCap: l.continue_cap ?? g.continue_cap,
        },
        run.billing ?? 'metered',
      );
      if (trip.act === 'trip') {
        logEvent(l.name, 'breaker', trip.reason);
        console.log(`rev: ${trip.reason} — halting '${l.name}'.`);
        streakReset(l.name, 'continue');
        action = { act: 'blocked', reason: trip.reason };
      }
    } else {
      streakReset(l.name, 'continue');
    }

    switch (action.act) {
      case 'blocked': {
        sSet(l.name, 'BLOCKED', `${action.reason}\nat=${new Date().toISOString()}\n`);
        logEvent(l.name, 'blocked', `reason=${action.reason}`);
        // Best-effort check only: a duplicate escalation beats a silent block.
        let standing: string | null = null;
        try {
          standing = openEscalation(g, l);
        } catch { /* fall through to escalate */ }
        if (standing) {
          console.log(`rev: '${l.name}' BLOCKED — escalation ${standing} already open; not filing another.`);
          logEvent(l.name, 'escalation-standing', `ticket=${standing}`);
          return;
        }
        try {
          const id = escalateBlocked(g, l, action.reason, res.outputTail, dir);
          console.log(`rev: '${l.name}' BLOCKED — escalated as Helm ticket ${id}.`);
          logEvent(l.name, 'escalated', `ticket=${id}`);
        } catch (e) {
          console.error(`rev: '${l.name}' BLOCKED — AND the escalation to Helm failed (${String(e).slice(0, 200)}). The operator must find this in the dashboard/status.`);
          logEvent(l.name, 'escalate-failed', String(e).slice(0, 200));
        }
        return;
      }
      case 'limit_wait': {
        sSet(l.name, 'LIMIT', `attempt=${action.attempt}\nretry_s=${action.waitSeconds}\n`);
        console.log(`rev: transient condition — parking '${l.name}' ${action.waitSeconds}s (attempt ${action.attempt}/${g.limit_cap}).`);
        let waited = 0;
        while (waited < action.waitSeconds && !sHas(l.name, 'STOP') && !sHas(l.name, 'BLOCKED')) {
          await sleep(Math.min(60, action.waitSeconds - waited));
          waited += 60;
        }
        sClear(l.name, 'LIMIT');
        continue;
      }
      case 'idle': {
        streakReset(l.name, 'fail', 'limit');
        // If the cursor read fails, idle at the seq we entered on rather than
        // guessing forward: too low costs one redundant wake, too high skips
        // motion silently.
        const after = tryWakeCheck(g, l, 0);
        // A store-wide session may make its final queue read before it exits.
        // Advancing to a snapshot taken after that exit would acknowledge any
        // event in between without ever showing it to the session. Retain the
        // pre-session cursor for store-wide passes: motion during the pass is
        // delivered at least once on the next wake. That can buy one bounded
        // reconciliation pass for the session's own writes; it cannot lose a
        // filing. Scoped loops use readiness edges and can advance normally.
        const cursor = l.workstream === '*' ? before.max_seq : (after?.max_seq ?? before.max_seq);
        const ready = after?.ready_count ?? before.ready_count;
        const held = after?.held_count ?? before.held_count ?? 0;
        const reason = produced
          ? 'store-wide pass complete; waiting for motion from someone else'
          : ready > 0
          ? `${ready} executable ticket${ready === 1 ? '' : 's'} remained after an iteration made no advancing change`
          : held > 0
            ? `${held} ticket${held === 1 ? ' remains' : 's remain'} in this seat's hands, but none is executable`
            : 'no executable work is owned by this seat or ready in its watched scope';
        // First line stays the cursor for compatibility with older readers;
        // the second makes an idle seat's wait legible without writing motion
        // back into Helmo and waking the same seat again (H-954).
        sSet(l.name, 'IDLE', `${cursor}\n${reason}\n`);
        sSet(l.name, 'IDLE_AT', String(Date.now()));
        console.log(`rev: ${produced ? 'pass complete' : 'no production this iteration'} — IDLE at seq ${cursor}: ${reason}.`);
        break;
      }
      case 'continue':
        if (res.cls === 'ok') streakReset(l.name, 'fail', 'limit');
        break;
    }

    if (countReached()) return;

    // Inter-iteration velocity throttle, honoring live sentinel changes.
    const pace = parseFloat(sValue(l.name, 'PACE') ?? '') || 1;
    let throttle = velocityToPause(pace, tAvg);
    while (throttle > 0 && !sHas(l.name, 'STOP') && !sHas(l.name, 'BLOCKED') && sValue(l.name, 'PACE') !== 'park') {
      const step = Math.min(g.poll_seconds, throttle);
      await sleep(step);
      throttle -= step;
    }
  }
}
