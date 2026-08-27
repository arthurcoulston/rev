# DEV — coding context for rev

Rev keeps agent loops turning: process supervision for autonomous loops
that draw work from Helmo. Rev never reads ticket content; Helmo never
manages a process. Product doc: `rev-product-description.md`.
Renamed from Capstan 2026-08-05 (H-53); Helm event history before then carries
the old name, and the `capstan-dev` workstream merged into `rev-dev` (H-62).

## Architecture (src/)

- `loop.ts` — the single-loop driver: wake on Helmo's event cursor (zero tokens
  while idle), spawn one fresh session per iteration, classify the outcome,
  idle or halt. The iteration prompt ("work ONE ticket to a natural stopping
  point") lives here, and it opens with the workstream's steering when set
  (helm-cli `workstream`: goal + remaining budget, helmo H-55) — disclosure
  before planning, and a steering fetch failure never stops the loop.
  `workstream = "*"` makes a loop store-wide (H-92, built for bosun): wake is
  unscoped but fires on MOTION ONLY (changed_since, never ready_count — the
  whole store's standing backlog would wake a judge every poll forever), no
  steering fetch, and the prompt defers to the constitution instead of naming
  a stream or the ONE-ticket rule. After
  each iteration it writes the session's metered spend back to the
  most-touched ticket via helm-cli `record-spend` (H-19) — as the rev
  actor, since Rev is the meter, not the spender — net of anything the agent
  self-reported in the window (`actor-spend`, H-57): a session lands in the
  totals exactly once. Each guess is cancelled on the ticket that carries it
  and the meter lands on the primary alone (H-187) — a session-wide
  correction once left a ticket at −62k beside a neighbour's +80k guess.
- `burn.ts` — reads the token-log back as a per-loop rolling window (hour and
  day) for the breaker. A file scan, not an in-memory total, because the two
  burns it exists for both spanned process restarts; the window is floored at
  `.burn_floor` (stamped at loop start) so a resumed loop starts clean instead
  of tripping again on money already accounted for (H-412).
- `shim.ts` — the runtime adapter (claude / codex / mock). Owns non-interactive
  flags, constitution injection (fail-closed), `cleanEnv()` (strips parent
  CLAUDE/ANTHROPIC env — the auth-leak fix; don't weaken it), per-session token
  metering, transient-API detection, and `--strict-mcp-config` (sessions see
  ONLY Helmo + the loop's `mcp_extra`).
- `ladder.ts` — pure decision functions for the failure ladder (transient ≠
  failure ≠ apparatus). Unit-tested; change with tests.
- `supervisor.ts` — the fleet (v1, H-18): one child process per roster loop
  (the shim is spawnSync, so a loop process can only drive one loop), respawn
  decided by `respawnDecide` in the ladder (halt sentinel → await clearance;
  healthy clean exit → fresh spawn; crash/short-lived → exponential backoff,
  BACKOFF sentinel). Drain = SIGTERM cascade: loop processes defer signals
  past the in-flight session, so iterations always finish their close-out.
  Child stdout/err goes to state/<loop>/console.log; supervisor decisions to
  state/supervisor/events.log. 'supervisor' is a reserved loop name.
- `service.ts` — reboot resilience: launchd plist (KeepAlive on crash only —
  a drain exits 0 and stays down) / systemd user unit. Units embed
  install-time PATH and REV_HOME because service managers strip env.
- `sentinels.ts` / `config.ts` — sentinel files + roster loading. A loop's
  optional `skills = [...]` (paths) are appended whole to its constitution at
  spawn — how a Drive-touching loop carries crew `skills/file-stewardship.md`
  (H-247); a missing skill fails the session closed like a missing constitution. Instance data
  lives in `~/.rev/` (roster.toml, mcp/, state/<loop>/, token-log), NEVER
  in this repo — publishability is structural.
- `view.ts` — read-only machine dashboard at :4500. `cli.ts` — run / status /
  stop / resume / pace / service / tail. `rev run`/`rev stop` with no argument
  mean the whole machine (Arthur's ruling: the operator starts the machine,
  not a named worker).

## Commands

- `npm run build`, `npm test` (ladder units + e2e with mock runtime).
- Start the machine: `node dist/cli.js run` (supervisor over the whole roster).
  Drive one loop: `node dist/cli.js run <loop> [--count N]` (foreground;
  `--count 1` is the assess-early lever).
- Dashboard: `node dist/view.js` (`REV_VIEW_PORT`, default 4500; binds
  127.0.0.1, `REV_VIEW_HOST` to change) — restart after rebuild.

## Invariants that bite

- Roster `version` is constitution provenance — bump it when a loop's profile
  changes.
- Reboot resilience is opt-in: `rev service install` (launchd/systemd user
  service). Installing changes what runs at login — operator's call, never an
  agent's.
- The supervisor never overrides a halt sentinel: STOP/HOLD/BLOCKED keep a
  loop down until an operator (or Helm answer) clears them; clearance is
  picked up within one poll.
- **Production means work advanced, not bytes written** (H-412). The
  produced-check calls helm-cli `actor-activity --advancing`, so a note-only
  update does not count. It matters because `ladderDecide` returns `continue`
  on production and `continue` skips the wake gate entirely: an agent that
  honestly recorded "nothing actionable" was certifying itself busy and buying
  another full iteration. Known gap, latent rather than observed: a scoped
  loop's wake still fires on `ready_count > 0` alone, so a ready ticket the
  agent keeps declining re-wakes it each poll. That belongs to the wake gate.
- **The burn breaker is a ceiling, not a pacer** (H-412). It checks only
  `continue` iterations — every other ladder action is already stopping — and
  trips to BLOCKED with the usual escalation, so a runaway reaches Arthur's
  queue rather than a log. Defaults (`burn_usd_per_hour` 30, `burn_usd_per_day`
  75, `continue_cap` 15, per-loop overridable) sit above every figure in the
  token-log's history: a trip means new territory, never a busy afternoon. It
  deliberately does NOT catch a small spin — ward's five iterations against a
  one-ticket wake cost $5.70 — because that is a question of what counts as
  production, not of spend.
- Escalations must land as Helmo tickets, never only in logs; a BLOCKED loop
  that couldn't escalate prints loudly and relies on the dashboard.
- Liveness is identity, never a bare pid. A RUNNING marker records the command
  that owns it (`runningStamp()` — use it anywhere RUNNING is written), and
  `pidAlive` requires the live process to still be running that command. Pids
  are recycled across a reboot: a stale marker whose number had been reused by
  an unrelated process made the supervisor abort as "already running" through
  57 launchd retries, with the whole fleet down and unable to converge (H-154).
- A store-wide loop (`workstream = '*'`) wakes on motion only, and its
  wake-check must carry NO scope at all — assignee included. Helm ORs the
  scope clauses, so any one of them narrows the whole store back down to
  tickets already assigned and silences the fresh-filing signal these loops
  exist for. Cost us bosun's entire wake path until H-138.

## Neighbors

Helmo is the work record (`~/projects/helmo`, must be built — roster points at
its dist/). Loop identities/constitutions live in `~/projects/crew`.
Map: `~/projects/crew/FLEET.md`.
