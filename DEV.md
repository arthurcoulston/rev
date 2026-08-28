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
- `usage.ts` — usage bars per provider. Claude: the undocumented
  `api.anthropic.com/api/oauth/usage` (H-278; security design approved in
  H-280, landed-code check is H-298), polled by the supervisor every 10 min
  into `~/.rev/usage.json`. Parse the `limits` array, not the top-level
  `five_hour` / `seven_day` objects: it is self-describing and it NAMES the
  model a scoped weekly cap belongs to, which is the only way the Fable cap is
  legible rather than an opaque codename. Codex: no poller and no credential
  (H-479) — every `codex exec` run writes its rate-limit standing into its own
  rollout file under `$CODEX_HOME/sessions`, and the shim lifts the freshest
  block into `~/.rev/usage-codex.json` after each run, so the numbers are as
  fresh as the last iteration. `rev usage [--poll]`, `rev status` and the view
  header read both. Every failure is soft — keep the last numbers, mark
  stale, back off; nothing in rev may wait on a usage bar.
- `health.ts` — fleet-down detection (H-448). A failing wake-check is modelled
  as "no news, try next poll", which is right for contention and wrong for
  anything permanent; past `wedge_cap` consecutive failures the loop is marked
  WEDGED and an alarm is raised. **The alarm cannot go through Helmo** — Helmo
  is what a wedged loop cannot reach — so it leaves by another door
  (`osascript` notification on darwin, best-effort, never fatal). Raised once
  per episode; the sentinel clears the moment a wake-check succeeds.
- `burn.ts` — reads the token-log back as a per-loop rolling window (hour and
  day) for the breaker. A file scan, not an in-memory total, because the two
  burns it exists for both spanned process restarts; the window is floored at
  `.burn_floor` (stamped at loop start) so a resumed loop starts clean instead
  of tripping again on money already accounted for (H-412).
- `shim.ts` — the runtime adapter (claude / codex / mock). Owns non-interactive
  flags, constitution injection (fail-closed), `cleanEnv()` (strips parent
  CLAUDE/ANTHROPIC/CODEX env — the auth-leak fix; don't weaken it), per-session
  token metering, transient-API detection, and the strict MCP surface (sessions
  see ONLY Helmo + the loop's `mcp_extra`): claude via `--strict-mcp-config`,
  codex via the whole-table `-c mcp_servers={...}` override (H-479). Codex
  gotchas the adapter encodes, all verified on codex-cli 0.150.1: the prompt
  goes in on stdin (`exec -`) because argv is ps-readable and size-capped;
  `--ignore-user-config` silently drops `-c`-supplied MCP servers, so it is
  not used; MCP tools need `default_tools_approval_mode = "auto"` AND the
  approvals/sandbox bypass or every call hard-fails under `approval_policy =
  never`; exit 0 without a `turn.completed` event is a real failure
  (openai/codex #19309), so results are gated on the event stream; codex under
  plan auth reports no dollar cost, so cost is notional from the roster's
  `[providers.codex.prices]` — absent prices, the burn breaker is blind to
  that provider and the token-log shows `cost_usd=?`.
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
  (H-247); a missing skill fails the session closed like a missing constitution.
  Providers (H-479): `[providers.<name>]` is an adapter plus the operator's
  tier→model table (and prices) — the machine copy of crew
  `skills/model-selection.md`; model names live in the roster, never in rev's
  code, so name churn is a roster edit. A loop says `provider` + `tier`
  (`probe_tier` for the probe pass) or the v0 `runtime` + `model` strings;
  `rotation = ["claude", "codex"]` alternates providers per iteration and
  `fallback = ["codex:mid"]` names where to run when every scheduled
  provider's cap is out. All references resolve at load and fail the roster
  loudly. Instance data
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
- **The iteration prompt loads the tools before the work** (H-448). An agent
  picks its tool set from a guess about the session ahead, and "I might need to
  file a ticket" is what you discover halfway through: 13% of loop sessions
  since 2026-08-20 started without `create_ticket` — every loop, not one. One
  of them found no tool for the job and reasoned its way into writing Helmo's
  SQLite file by hand, wedging the whole fleet for forty minutes. The prompt now
  names the tools to load up front and says plainly that a missing tool is never
  grounds to go around Helmo.
- **Production means work advanced, not bytes written** (H-412). The
  produced-check calls helm-cli `actor-activity --advancing`, so a note-only
  update does not count. It matters because `ladderDecide` returns `continue`
  on production and `continue` skips the wake gate entirely: an agent that
  honestly recorded "nothing actionable" was certifying itself busy and buying
  another full iteration. Known gap, latent rather than observed: a scoped
  loop's wake still fires on `ready_count > 0` alone, so a ready ticket the
  agent keeps declining re-wakes it each poll. That belongs to the wake gate.
- **The usage poller never touches the token except in one header** (H-278/
  H-280). Read from the keychain per poll and discarded when the call returns;
  never held for the process lifetime, never written to disk, never in argv —
  which is why it uses `fetch` and not `curl`, since process args are readable
  via `ps`. `usage.json` holds PARSED values only: agents read that file into
  prompts, so no raw upstream text may pass through, and an error line carries
  our own words plus a status code, never a response body.
- **A cap that resets beyond the horizon is a decision, not a retry** (H-402).
  `limitDecide` reads the usage snapshot on any transient condition: if a bar
  is at/over `limit_exhausted_percent` the wait runs to its actual `resets_at`,
  and if that is further out than `limit_block_horizon_seconds` the loop blocks
  immediately with the cap NAMED. Unidentifiable conditions keep the old
  twenty-attempt ladder. The shim no longer reduces a 429 to `API 429` — the
  response body is what distinguishes an exhausted quota from a rate limit, and
  discarding it is what made 2026-08-26 opaque for 34-42 hours.
- **WEDGED is not a halt.** `halted()` deliberately does not include it: the
  fault is outside the loop and may clear, so it keeps polling. It sorts above
  RUNNING/IDLE in the status label because a wedged loop looks busy from the
  outside while drawing no work at all.
- **An empty-handed iteration is a probe and runs on the probe model** (H-412;
  crew `skills/model-selection.md`). A loop with `probe_model` in the roster
  runs an iteration on it when the wake-check shows nothing ready AND nothing
  in_progress in the loop's own hands (`held_count`, from helmo) — that session
  can only read the queue and stop, and running it at the working tier is pure
  waste. Decided fresh each iteration (`probeDecide`), never sticky; the
  actor identity, token-log, and spend note all carry the model actually used.
  An unknown `held_count` (older helmo) never probes — real work misrouted to
  the small tier is the worse mistake — and store-wide loops never probe:
  their motion-only wakes ARE the triage work.
- **A provider choice is decided fresh each iteration, never sticky** (H-479).
  `choiceDecide` takes the rotation cycle at the iteration's position, skips
  any provider whose cap the fresh snapshot says is out (then fallbacks), and
  when everything is out returns the scheduled choice so the transient ladder
  — not the selector — decides what stopping looks like. On an IDENTIFIED cap
  with another provider standing, the transient path switches instead of
  waiting or blocking; an unidentified transient (529, outage) keeps the
  ladder, so a network wobble never becomes a migration. The probe pass runs
  on the provider actually chosen. The actor identity, token-log, run-start
  event, and spend note all carry the provider/model actually used.
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
