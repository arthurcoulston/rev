// The single-loop driver: wake on the Helm cursor, spawn one session, classify
// the outcome through the ladder, idle or halt. v0 runs one loop in the
// foreground; the multi-loop supervisor is the next milestone.
import { stateDir } from './config.js';
import { WakeCheck, actorActivity, actorSelfSpend, actorTickets, escalateBlocked, recordSpend, scopeLabel, wakeCheck, workstreamInfo } from './helm.js';
import { ladderDecide, rollingMean, velocityToPause } from './ladder.js';
import { logEvent, pidAlive, runningStamp, sClear, sGet, sHas, sSet, streak, streakReset } from './sentinels.js';
import { runSession } from './shim.js';
import { GlobalConfig, LoopConfig } from './types.js';

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

/** Helm is reachable across a subprocess boundary, so a poll can fail for
 *  reasons that have nothing to do with the work: a locked store, a moment's
 *  contention. That is a transient condition — the state rev already models —
 *  never grounds to kill the loop, which is what an uncaught throw here used to
 *  do (H-134). Failure reads as "no news": the next poll decides. */
function tryWakeCheck(g: GlobalConfig, l: LoopConfig, sinceSeq: number): WakeCheck | null {
  try {
    return wakeCheck(g, l, sinceSeq);
  } catch (e) {
    logEvent(l.name, 'wake-check-failed', String(e).slice(0, 200));
    console.error(`rev: wake-check failed for '${l.name}' — retrying next poll. ${String(e).slice(0, 200)}`);
    return null;
  }
}

export interface RunOptions {
  count?: number; // bounded run for troubleshooting; 0/undefined = unbounded to the ceiling
}

export async function runLoop(g: GlobalConfig, l: LoopConfig, opts: RunOptions = {}): Promise<void> {
  const dir = stateDir(l.name);

  const existing = pidAlive(l.name);
  if (existing) {
    throw new Error(`A '${l.name}' loop is already running (PID ${existing}). Check: rev status`);
  }
  sSet(l.name, 'RUNNING', runningStamp());
  if (!sHas(l.name, 'PACE') && l.pace < 1) sSet(l.name, 'PACE', String(l.pace));
  const cleanup = () => sClear(l.name, 'RUNNING', 'PARKED', 'LIMIT');
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));

  console.log(`rev: loop '${l.name}' | ${scopeLabel(l)} | ${l.runtime}/${l.model} | cwd ${l.cwd}`);
  console.log(`rev: state ${dir} — stop it with: rev stop ${l.name}`);
  logEvent(l.name, 'loop-start', `pid=${process.pid} count=${opts.count ?? 0}`);

  let i = 0;
  let durWindow: number[] = [];
  let tAvg = 0;

  while (true) {
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
    if (sGet(l.name, 'PACE')?.trim() === 'park') {
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
      // Store-wide loops ('*', H-92) wake on motion only: their job is judging
      // fresh activity, and standing ready backlog anywhere in the store would
      // otherwise wake them every poll, forever.
      const wake = l.workstream === '*' ? w.changed_since : w.ready_count > 0 || w.changed_since;
      if (wake) {
        sClear(l.name, 'IDLE');
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
    i += 1;
    const started = Date.now();
    logEvent(l.name, 'run-start', `iter=${i} seq=${before.max_seq}`);
    console.log(`=== ${l.name} run ${i} started ${new Date().toISOString()} ===`);

    // Steering disclosure up front (helmo H-55): a budget known before
    // planning changes what gets worked first; discovered at the end, it is
    // only a verdict. Store-wide loops have no single stream to steer by.
    const ws = l.workstream === '*' ? null : workstreamInfo(g, l.workstream);
    const steering =
      (ws?.goal ? `The workstream's goal — what done means for the whole stream: ${ws.goal}. If the goal is already met, closing out is the right move; do not manufacture polish. ` : '') +
      (ws?.budget_usd
        ? `Budget: $${ws.spent_usd.toFixed(2)} of $${ws.budget_usd.toFixed(2)} spent, $${(ws.remaining_usd ?? 0).toFixed(2)} remains. The budget is the plan — take the highest-value work first; if it is exhausted, close out honestly with residuals documented rather than starting more. `
        : '');
    const draw =
      l.workstream === '*'
        ? `Use your Helmo tools: first list tickets assigned to you, then survey fresh activity and unclaimed filings across all workstreams — your constitution says what your work is. Work to a natural stopping point, `
        : `Use your Helm tools: first list tickets assigned to you, then ready work in workstream '${l.workstream}'. Work ONE ticket to a natural stopping point, `;
    const prompt =
      `Loop iteration ${i} for agent '${l.name}'. Working directory: ${l.cwd}. ` +
      steering +
      draw +
      `record progress honestly, then end the session. ${l.prompt ?? ''}`;
    const res = runSession(g, l, prompt);

    const durSec = Math.round((Date.now() - started) / 1000);
    ({ window: durWindow, mean: tAvg } = rollingMean(durWindow, durSec));
    console.log(res.outputTail.slice(-2000));
    console.log(`=== ${l.name} run ${i} ended (rc=${res.rc} class=${res.cls} ${durSec}s) ===`);

    const produced = res.cls === 'ok' ? actorActivity(g, l.name, before.max_seq) > 0 : false;
    const failStreak = res.cls === 'failure' ? streak(l.name, 'fail', true) : 0;
    const limitStreak = res.cls === 'transient' ? streak(l.name, 'limit', true) : 0;
    const action = ladderDecide(res.cls, {
      produced,
      failStreak,
      limitStreak,
      failCap: g.fail_cap,
      limitCap: g.limit_cap,
      limitWait: g.limit_wait_seconds,
    });
    logEvent(l.name, 'run-end', `iter=${i} rc=${res.rc} class=${res.cls} produced=${produced} dur=${durSec}s action=${action.act}`);

    // Write metered spend back to the ticket(s) this iteration touched (H-19).
    // Whole session charged to the most-touched ticket — finer attribution
    // would be pretend precision; the note names any others. Runs after close
    // (record-spend accepts terminal tickets) and must never affect the run.
    if (res.tokens || res.cost_usd) {
      try {
        const touched = actorTickets(g, l.name, before.max_seq);
        if (touched.length) {
          const [primary, ...rest] = touched;
          // Net out anything the agent self-reported this session: the meter
          // is authoritative, and a session must land in the totals exactly
          // once (H-57). Each guess is cancelled on the ticket that carries it
          // — a session-wide correction on the primary once left it at −62k
          // while a side ticket kept the +80k guess (H-187).
          const self = actorSelfSpend(g, l.name, before.max_seq);
          const guess = new Map(self.by_ticket.map((t) => [t.id, t]));
          const primaryGuess = guess.get(primary!.id);
          const tokens = (res.tokens ?? 0) - (primaryGuess?.tokens ?? 0);
          const cost = (res.cost_usd ?? 0) - (primaryGuess?.cost_usd ?? 0);
          if (tokens || cost) {
            const note =
              `Metered by Rev: loop '${l.name}' iteration ${i} (${l.runtime}/${l.model}), whole session charged to this ticket` +
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

    switch (action.act) {
      case 'blocked': {
        sSet(l.name, 'BLOCKED', `${action.reason}\nat=${new Date().toISOString()}\n`);
        logEvent(l.name, 'blocked', `reason=${action.reason}`);
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
        const cursor = after?.max_seq ?? before.max_seq;
        sSet(l.name, 'IDLE', String(cursor));
        console.log(`rev: no production this iteration — IDLE at seq ${cursor}.`);
        break;
      }
      case 'continue':
        if (res.cls === 'ok') streakReset(l.name, 'fail', 'limit');
        break;
    }

    if (opts.count && i >= opts.count) {
      console.log(`rev: requested run count (${opts.count}) reached — halting '${l.name}'.`);
      logEvent(l.name, 'loop-stop', `reason=count runs=${i}`);
      return;
    }
    if (i >= g.iteration_ceiling) {
      console.log(`rev: iteration ceiling (${g.iteration_ceiling}) reached — halting '${l.name}'.`);
      logEvent(l.name, 'loop-stop', `reason=ceiling runs=${i}`);
      return;
    }

    // Inter-iteration velocity throttle, honoring live sentinel changes.
    const pace = parseFloat(sGet(l.name, 'PACE') ?? '') || 1;
    let throttle = velocityToPause(pace, tAvg);
    while (throttle > 0 && !sHas(l.name, 'STOP') && !sHas(l.name, 'BLOCKED') && sGet(l.name, 'PACE')?.trim() !== 'park') {
      const step = Math.min(g.poll_seconds, throttle);
      await sleep(step);
      throttle -= step;
    }
  }
}
