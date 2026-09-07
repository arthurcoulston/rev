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
  point") lives here. Its first sentence declares the run a Rev loop rather
  than a summon, before tool or routing context can be misread; it then gives
  the workstream's steering when set
  (helm-cli `workstream`: goal + remaining budget, helmo H-55) — disclosure
  before planning, and a steering fetch failure never stops the loop.
  Steering covers EVERY stream the seat has work in, not just the one it
  watches (H-954): `seatStreams` lists the tickets assigned to the seat, and
  the watched stream plus their streams are what `steeringText` speaks for.
  One stream keeps the wording every seat has been running; several are named
  individually, and the close-out cue becomes per-stream — because the old
  singular "if the goal is already met, closing out is the right move" was
  said about the WATCHED stream while the session's actual work sat in
  another. A held stream with no goal is still named, as unsteered rather
  than finished; dropping it would restore the singular wording and the
  defect with it. `workstream = "*"` makes a loop store-wide (H-92, built for
  bosun): wake is unscoped but fires on MOTION ONLY (changed_since, never
  ready_count — the whole store's standing backlog would wake a judge every
  poll forever), no steering fetch at all — its prompt carries none of the
  close-out framing steering is written for — and it defers to the
  constitution instead of naming a stream or the ONE-ticket rule. Per-loop `idle_floor_s` holds wakes after
  an unproductive pass: motion accumulates but cannot re-wake the loop until
  the floor elapses (H-336: a live desk session woke ward ~$1/2min against an
  empty queue; H-545: bosun's own sweep records were the motion that woke it,
  16 straight iterations to the burn breaker). The first successful poll after
  a process start bypasses a surviving `IDLE_AT`: the floor spaces passes from
  the same process, but must not make a restarted seat sleep on queued work
  (H-995). BOTH prompts tell a no-change
  pass to end WITHOUT filing or noting — its own exhaust is fresh motion, so a
  no-change record re-wakes the loop it closes. The scoped prompt says it in
  the terms a scoped seat actually meets (queue empty, or every ticket blocked,
  time-gated, or with the human) and carves out an unasked human question,
  which triage duty still requires; only the '*' prompt carried the
  instruction until H-740.
  Both prompts also make oversized work stop at the planning boundary: the
  loop files iteration-sized children and closes the parent as a plan in the
  same pass, instead of carrying one ticket across repeated iterations
  (H-1057). The sentence sits after the two draw variants so neither scope can
  omit it. Both prompts also require every considered ready ticket to receive a
  recorded disposition rather than remain invisibly declined (H-1071). For a
  scoped seat, Rev snapshots ready IDs around each clean, unproductive pass and
  keeps a per-ticket streak in `.silent_decline_streaks.json`; the third pass
  creates one deduplicated human escalation and quarantines those tickets with
  `needs_human`, without halting the rest of the seat. Any advancing work, or a
  ticket leaving the ready set, resets its streak. Store-wide `'*'` loops are
  excluded: their job is judgment, and a recorded disposition is the action.
  An IDLE sentinel keeps the wake cursor on its first line and a bounded reason
  on its second (H-954): either no executable work exists in the seat's scope,
  held work is non-executable, or a session left executable work untouched.
  The view and `/health.json` expose that reason; it stays local so observing a
  wait cannot create Helmo motion and wake the same seat again. A SEAT_HELD
  sentinel makes the same-seat guard visible while the loop stands down for
  another live session; the view, health feed, and CLI show the hold instead
  of calling it a running iteration, and the marker clears with the hold. After
  each iteration it writes the session's metered spend back to the
  most-touched ticket via session-filtered helm-cli event queries and
  `record-spend` (H-19, H-878), so desk writes under the same actor name cannot
  capture the loop's charge — as the rev
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
  legible rather than an opaque codename. Codex: no network poller and no credential
  (H-479) — every `codex exec` run writes its rate-limit standing into its own
  rollout file under `$CODEX_HOME/sessions`, and the shim lifts the freshest
  block into `~/.rev/usage-codex.json` after each run. Before selecting a
  provider, Rev also reads bounded tails of the twenty newest rollouts in
  today's/yesterday's folders, so local desk meetings count too (H-892).
  Only parsed shared-Codex usage survives; Spark's separate bucket is ignored.
  Event timestamps are preserved: rereading an old event never refreshes it.
  `rev usage [--poll]`, `rev status` and the view
  header read both. Every failure is soft — keep the last numbers, mark
  stale, back off; nothing in rev may wait on a usage bar.
- `ancestry.ts` — abandoned-tree detection (H-281). Every loop and the
  supervisor stamp their ancestor chain at start and self-terminate (loop:
  exit between iterations; supervisor: drain) when any link dies or is
  reparented. A direct ppid check is NOT enough — the 2026-08-28 swarm
  (~28 orphaned dev trees, some racing the live store for six days) died at
  the SHELL above the tsx wrapper, leaving every inner ppid link intact. A
  launchd-parented supervisor has an empty chain that can never break, so
  deliberate daemons go through `rev service`, never nohup. Drains also
  escalate: past `drain_grace_seconds` a straggler is SIGKILLed rather than
  waited on forever (a hung drain ends in an operator kill -9 and orphans) —
  and the escalation takes the straggler's session group with it (H-1089),
  because the loop alone is not the whole seat.
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
  CLAUDE/ANTHROPIC/CODEX env — the auth-leak fix; don't weaken it) and
  `sessionEnv()` over it (the seat's git committer identity, H-787), the session
  **process group**, per-session
  token metering, transient-API detection, and the strict MCP surface (sessions
  see ONLY Helmo + the loop's `mcp_extra`; only the Helmo server is handed the
  loop's actor identity in `env` — an `mcp_extra` server that wants to know who
  is writing gets it as a per-call parameter from the agent, or from its own
  `env` block in the loop's JSON, never from `HELMO_ACTOR`, which `cleanEnv()`
  does not carry into the session, H-324): claude via `--strict-mcp-config`,
  codex via the whole-table `-c mcp_servers={...}` override (H-479). Codex
  gotchas the adapter encodes, all verified on codex-cli 0.150.1: the prompt
  goes in on stdin (`exec -`) because argv is ps-readable and size-capped;
  `--ignore-user-config` is always passed (H-520) — fleet behavior must not
  change when the operator tweaks `~/.codex/config.toml` (auth.json and
  session rollouts are unaffected); anything a run needs beyond the MCP table
  arrives as `-c` overrides from `[providers.<name>.config]` in the roster
  (reasoning effort, future custom endpoints via `model_providers`); MCP
  tools need `default_tools_approval_mode = "auto"` AND the
  approvals/sandbox bypass or every call hard-fails under `approval_policy =
  never`; exit 0 without a `turn.completed` event is a real failure
  (openai/codex #19309), so results are gated on the event stream; codex under
  plan auth reports no dollar cost, so cost is notional from the roster's
  `[providers.codex.prices]` — absent prices, the burn breaker is blind to
  that provider and the token-log shows `cost_usd=?`.
  Astra additionally needs a current CLI: 0.150.1 was rejected by the server;
  Homebrew 0.153.2 passed a real Astra run on 2026-09-04 (H-892). Updating the
  desktop app alone does not update the CLI Rev invokes.
  **Every session is its own process group** (`SESSION_GROUP`, H-467). Without
  it the agent CLI shares the group of the loop and the supervisor above it, so
  anything that signals that group — launchd stopping the job, systemd killing
  the cgroup, a Ctrl-C or hangup on a shell-started fleet — lands on the agent
  mid-turn. It died `rc=143` after its file writes and before its Helmo close,
  and the next iteration met artifacts no ticket accounted for; twice against
  ward, once against bosun, once against mason. Detached, the signal reaches
  only the loop process. The cost is deliberate and worth naming: a SIGKILLed
  loop now leaves its session running to completion as an orphan — one
  session's tokens, spent finishing and closing its own work, which is the
  trade this bug was about. After a CLI returns normally, the shim terminates
  background children still in that session group (H-1013); this cleanup is
  deliberately unreachable when the loop dies during `spawnSync`, so H-467's
  orphaned session still finishes. `test/shim.test.ts` proves both sides with
  real process groups.

  **The one place that cost is not paid is the supervisor's drain escalation**
  (H-1089). A redeploy drains; a loop mid-iteration defers its SIGTERM past
  `drain_grace_seconds`; the supervisor SIGKILLs it — and the detached CLI
  reparented to init and kept working while the returning fleet spawned a
  SECOND session for the same seat, on the same ready queue, as the same Helmo
  actor, in the same working trees. It happened to mason on 2026-09-07 and cost
  H-1086 a trustworthy gate run. So the escalation now enumerates the loop's
  own session groups *before* the kill (after it, the children are init's and
  unfindable) and ends them: `sessionGroupsOf` / `endSessionGroup` in
  `shim.ts`. Only true group LEADERS are signalled — a child sharing its
  parent's group is skipped, because signalling that group would reach the loop
  and the supervisor, which is the broadcast H-467 exists to prevent. Past the
  grace the session has already had its finishing time; two seats is the worse
  failure. Proven in `test/supervisor.e2e.test.ts` — a mock that records its
  pid and outlives any grace must be gone once the drain completes.

- `ladder.ts` — pure decision functions for the failure ladder (transient ≠
  failure ≠ apparatus). Unit-tested; change with tests.
- `supervisor.ts` — the fleet (v1, H-18): one child process per roster loop
  (the shim is spawnSync, so a loop process can only drive one loop), respawn
  decided by `respawnDecide` in the ladder (halt sentinel → await clearance;
  healthy clean exit → fresh spawn; crash/short-lived → exponential backoff,
  BACKOFF sentinel). Drain = SIGTERM cascade: a loop process sits inside a
  blocking `spawnSync`, so its handler cannot run until the session returns —
  the deferral is real, and everything the loop does after a session (run-end,
  the ladder, `record-spend`) is synchronous, so it completes before the
  handler's first chance to fire. What that deferral never covered is a signal
  aimed at the process GROUP rather than the loop, which is where H-467's
  orphaned artifacts came from: see the session process group under `shim.ts`.
  Child stdout/err goes to state/<loop>/console.log; supervisor decisions to
  state/supervisor/events.log. 'supervisor' is a reserved loop name.
- `redeploy.ts` — activating rev's own committed, tested fix (H-1046). A loop
  that lands one cannot restart the fleet from inside its own iteration, so it
  writes a REDEPLOY sentinel (`rev redeploy --ticket <id> --reason ...`); the
  supervisor honours it at its next poll with an ordinary drain, then exits
  **75, unsuccessfully on purpose** — the only exit launchd and systemd bring
  back, and the supervisor that returns is the new code. Deliberately not the
  reinstall path: nothing boots the job out, so there is no race with launchd's
  60s ceiling. A REDEPLOY present at startup is the record of the restart that
  just happened, never a fresh ask — the new supervisor clears it before any
  poll can read it, which is what stops a redeploy looping forever, and notes
  the landing on the requesting ticket (best-effort: the loop may have closed
  it, and Helmo rightly refuses updates on terminal tickets). Asking mid-work
  is safe because the drain's SIGTERM to the requester's own driver is deferred
  past the in-flight iteration like any other, so the restart lands after the
  iteration ends with its run-end and metering intact. Measured on the live
  fleet: ask 02:19:59Z, drain 02:20:38Z (the next poll), the last straggler's
  iteration held it to 02:28:54Z, fleet back 160ms later.
- `service.ts` — reboot resilience: launchd plist (KeepAlive on crash only —
  a drain exits 0 and stays down) / systemd user unit. Units embed
  install-time PATH and REV_HOME because service managers strip env. Both must
  systemd gets `KillMode=mixed` and a timeout longer than rev's drain, so a stop
  signals the supervisor rather than every process in the cgroup (H-467).
  launchd is different: it clamps `ExitTimeOut` at 60s even when the plist asks
  for 660s (measured on Darwin 25.6, H-877). Its bootout/reinstall path is
  therefore a hard stop after the largest available 60s window; the detached
  session process group is what lets an agent finish and close its work. Use
  `rev stop` when the whole machine must drain gracefully before service work.
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
- `view.ts` — read-only machine dashboard at :4500; `/health.json` is the
  machine-readable snapshot (loop states, usage) for aggregators like the
  estate health page (crew tools/health, H-627) — consumers read it rather
  than re-deriving sentinel truth. `cli.ts` — run / status /
  stop / resume / pace / service / tail. `rev run`/`rev stop` with no argument
  mean the whole machine (Arthur's ruling: the operator starts the machine,
  not a named worker).

## Commands

- `npm run build`, `npm test` (ladder units + e2e with mock runtime).
- `node dist/cli.js routing` previews working-model selection without starting
  work. `usage --poll` refreshes Claude remotely and Codex from local rollouts.
- `npm run vendor:tokens` refreshes the vendored estate design tokens,
  `npm run vendor:avatars` the vendored crew avatar sprite, and
  `npm run vendor:reach` the vendored estate reach table; add `-- --check`
  to any of them to fail on drift instead. See below.
- Start the machine: `node dist/cli.js run` (supervisor over the whole roster).
  Drive one loop: `node dist/cli.js run <loop> [--count N]` (foreground;
  `--count 1` is the assess-early lever).
- Activate a committed fix on the running fleet: `node dist/cli.js redeploy
  --ticket <id> --reason "<why>"`. It returns immediately; the drain lands
  within one poll and the service manager brings the fleet back on the new
  code. Needs a running supervisor (a cold start already runs current code)
  and a service manager — with no service installed it warns that the fleet
  will drain and stay down.
- Dashboard: `node dist/view.js` (`REV_VIEW_PORT`, default 4500; binds
  127.0.0.1, `REV_VIEW_HOST` to change) — restart after rebuild.

## The estate design tokens (R-11 H-714)

`src/estate-tokens.generated.ts` is a **vendored copy** of the estate shell's
`tokens/estate-tokens.css` — the source of the visual system every estate
surface shares. `scripts/vendor-estate-tokens.mjs` refreshes it (also
`--check`); `test/estate-tokens.test.ts` fails on drift.

Vendoring, not importing, is the point: rev is published standalone, so a clone
with no estate checkout beside it must build and run unchanged. That is also
why the drift test uses `it.skipIf` rather than an early return — with no
source to compare against it reports **skipped**, which is visible in the run
summary, where a `console.log` from a passing test is not.

**Rev was the third adopter and the only one starting from nothing.** Helmo and
the roadmap already had token layers to alias; rev's view had fifteen literal
hex colours and no dark half at all — it served a white page at midnight. So
here the seam had to be built rather than re-pointed: a `:root` block of
aliases, and every rule below written against them. `ESTATE_TOKENS` is inlined
ahead of that block, which is what brings the dark values in under
`prefers-color-scheme` on a page with no theme switch.

Adopted: surfaces (`--page`), the grey ladder, `--hairline`. No radius ramp —
nothing on this page is rounded.

Status colours and the interactive `--link` blue were held back at first —
shadcn's neutral base ships no status ramp, and its own `--accent` is a hover
*surface*, not an interactive colour. Arthur's call on **H-771** was to put
both in the estate's token set, so they alias like everything else now and
rev's dark overrides for them are gone: the estate's ramp is themed.
`--warn-text` moved one step in that swap. Rev carried `#b60`, 4.19:1 on white,
and rev is the view that uses amber AS body text; the estate's light amber is
`#a60` at 4.56:1 — the value this file's own note reported upstream when the
health page measured it. That divergence is closed.

Two things rev needed that the other two did not:

- **Dark siblings for the status colours.** They were tuned for a white page
  that no longer exists at night. `#b00` red and `#b60` amber both drop under
  4.5:1 on the estate's dark surface, so each has a lightened step of the same
  hue in the `prefers-color-scheme` block. Amber's dark step *is* the shared
  `#fab219`; its light step stays rev's `#b60`, because the other two views use
  amber as a wash behind a badge and rev uses it as small text, where `#fab219`
  on white is unreadable.
- **A fourth grey.** Rev distinguished `#999` and `#bbb`; two percent apart is
  not a distinction anyone reads, so one faint step (`--ink-4`) serves both.

**Two traps worth knowing.** An alias that comes out self-referential
(`--hairline: var(--hairline)`) is *guaranteed-invalid* in CSS: the property
ends up with no value, every rule using it is dropped, and nothing goes red —
the page just quietly loses all its borders. That shipped for one render in the
roadmap and only a pixel sample caught it. And a hex left behind in a rule is
invisible to tsc and still renders — it is simply a colour picked for white
being shown on near-black. `test/estate-tokens.test.ts` asserts against both.

Rev also gained the `viewport` meta the other two views already had; without it
a phone rendered the page at 980px, zoomed out to illegibility. Seven columns
of machine detail still do not fit a phone and should not try to, so
`.tablewrap` scrolls the table horizontally and leaves the heading and usage
lines where they are.

That wrapper was briefly filed as a defect and is not one (H-889). The estate's
overflow detector used to flag any element whose rect reached past the
viewport, which is every cell of a table that scrolls on purpose; it reported
OVERFLOW on this page while printing, in the same line, that the document was
390px wide in a 390px viewport. The detector now stops at the first ancestor
whose `overflow-x` is not `visible`, so this page reads clean. Estate's `npm
run smoke` drives it at 390px in both themes along with the other products —
that check lives there because it needs a browser and this repo stays
zero-dependency; run it after touching `view.ts`'s HTML or CSS.

## The crew avatar sprite (R-11 H-714)

`src/estate-avatars.generated.ts` is a second **vendored copy** on the same
seam and for the same reason — the estate's `avatars/crew-avatars.svg`, refreshed
by `scripts/vendor-estate-avatars.mjs`, drift-checked by
`test/estate-avatars.test.ts`. The sprite is inlined into the page body and a
mark is drawn with `<use href="#crew-<mark>-<kind>">`. No colour travels with
it: a mark is `currentColor` over `var(--crew-<name>)`, which the vendored token
copy already defines, so the two files interlock and neither holds a value the
other owns.

Rev has one actor surface — the Loop column — and rev is the third adopter, so
the pattern transferred whole. **What is different here is the kind.** Helmo and
the roadmap read it from the record: they store mixed kinds and answer with the
one each name last wrote under. Rev's record holds no kind and has no field one
could arrive in, so `LOOP_KIND` in `src/view.ts` states it once — and it rests
on the roster's own contract rather than on the look of a name. `loadRoster`
refuses a loop with no `constitution`, the profile the process runs under; the
one exception is an all-mock loop, which is a test fixture. Every seat on this
page is an agent because the roster will not load anything else.
`test/estate-avatars.test.ts` pins both halves — the refusal, and the sprite
composing that kind at all — so relaxing either turns `LOOP_KIND` red instead
of turning every mark on the page invisible.

**Everything in this area fails silently**, which is what the ten checks are
for. A `<use>` at a symbol the sprite does not carry draws nothing: no console
error, no failed request, a 200 on the page and a column that looks like a
design choice. So the checks aim at that one shape — the id the view builds,
the symbols the copy actually carries, and the sprite reaching the served HTML
after `</style>` rather than inside it. Two traps inherited from the first
adopter are in the estate's DEV.md: recognise a composed symbol by its *body*
(`crew-frame-agent` matches the id shape exactly and is not a mark), and refuse
a ragged sprite, because the view names `crew-${mark}-${kind}` from a roster it
did not choose — roster keys are instance data in `~/.rev`, never in this repo.

The all-pairs rule is structural, not a habit: ten members cannot have ten
mutually distinguishable hues (H-713), so a mark must never stand without its
name. Exactly one function draws one and it takes the name it prints, and
`.actor { white-space: nowrap }` is part of the same rule — the Loop column is
the narrowest on the page and the first to wrap on a phone.

## Where the cross-surface link points (R-11 H-832)

`src/estate-reach.generated.ts` is the third **vendored copy** on the same
seam, and the first whose source is the crew repo rather than the estate:
`crew/tools/estate/services.json`, refreshed by
`scripts/vendor-estate-reach.mjs`, drift-checked by `test/estate-reach.test.ts`.
Unlike the other two it is derived rather than verbatim — a registry entry
carries plist and log paths rev has no business holding — so the vendor script
refuses a registry with no `reach` prefix or nothing navigable rather than
emitting a table of localhost addresses that look fine on this Mac.

**A surface has two true addresses.** `url` is the product on its own port,
right at the desk and dead from anywhere else; `path` is the same-origin path
the estate shell composes it at. Rev's one link out — "work lives in Helm" —
was `http://localhost:4400` until this ticket, which is exactly the defect
H-831 found across the estate: perfect on the machine that serves it, dead on
the phone. Which address is right is a property of the READER'S ORIGIN, not of
the surface, so it is decided in the browser: `reachLink()` in `src/reach.ts`
ships both (`href` and `data-reach`), and `REACH_SCRIPT` — the only script on
this page — swaps them when `location.hostname` is not this machine.

**The server cannot decide it**, which is the thing to know before deleting the
script. The estate shell's proxy fetches this page itself, so the `Host` header
rev sees is always its own port however far away the reader is. The same rule
lives in `estate/src/lib/reach.ts` and `crew/tools/estate/registry.mjs`
(`reachFrom`) — three runtimes, one registry deciding the addresses, and no
service hand-keeping one of its own. With scripting off the href stays the desk
address, which is every rev build before this one.

The checks aim at the silent shapes: a link shipped with only one of its two
addresses, the script placed above the anchors it rewrites (finds none, reports
nothing, looks like a working page), and a surface renamed in the registry —
which `reachLink` throws on, so it goes red in CI rather than on Arthur's phone.
The far-origin half of the proof is a real browser: `estate/tools/reach.test.mjs`
does it for the shell's own nav with `--host-resolver-rules=MAP estate.test
127.0.0.1`, and rev's equivalent is the unit test running `REACH_SCRIPT`
verbatim against a stubbed origin, because a browser harness is not a
dependency this repo should grow for one link.

## Invariants that bite

- Roster `version` is constitution provenance — bump it when a loop's profile
  changes.
- Reboot resilience is opt-in: `rev service install` (launchd/systemd user
  service). First install changes what runs at login — operator's call, never
  an agent's (H-874). Reinstall to activate a committed, tested fix is the
  crew's call, not a question for the operator (Arthur, 2026-09-07, H-1046).
  On launchd, reinstall writes the new plist, boots out any loaded supervisor,
  then bootstraps it again; the command names that running work is
  interrupted rather than leaving the old job silently loaded. The everyday
  path for activating a fix is `rev redeploy`, not a reinstall: it needs no
  bootout, so it cannot race the 60s ceiling.
- **Never `rev stop` from a loop session to activate a fix** (H-1046). Two
  things bite at once: the drain blocks on the caller's own driver, which is
  deferring SIGTERM until the session returns, so it cannot finish while the
  caller is still working; and when it finally does, it exits 0 — the one exit
  launchd and systemd deliberately leave down. The fleet stops with nothing to
  bring it back. `rev redeploy` exists so that neither happens.
- **A redeploy that never comes back must not be silent** (H-1046). The fleet
  is the thing that would have noticed, so the exiting supervisor arms a
  detached `redeploy-watch` first: past `redeploy_deadline_seconds` it alarms
  out of band and files a priority-0 ticket to the human. It always files a
  FRESH ticket — the requesting one may be closed, and returning a live one
  would release a claim its holder is still working.
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
  another full iteration. The filter is the floor, not the whole fix (H-740):
  an update carrying an `evidence` diff IS advancing, so a scoped seat's honest
  "still blocked, base still green" pass cleared it and bought the next
  iteration anyway — observed on mason 2026-09-03, iterations 14 and 15 both
  `produced=true action=continue` at ~$1.30 each against a queue blocked on
  Arthur. Narrowing the filter would be wrong (the commit proving a build green
  is exactly what a ticket should carry when work HAS advanced), so the fix is
  the instruction: teach every seat the contract the ladder scores it against.
  Known gap, latent rather than observed: a scoped loop's wake still fires on
  `ready_count > 0` alone, so a ready ticket the agent keeps declining re-wakes
  it each poll. That belongs to the wake gate.
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
  their motion-only wakes ARE the triage work. A `[global] probe =
  "provider:tier"` pin (H-625; live as `codex:small`, Arthur 2026-08-31)
  routes every probe to that provider while its cap stands — the whole
  RunChoice swaps, so runtime, prices, config, toolset wording, and the
  transient path all follow the pinned provider. The pin yields to the
  loop's own `probe_tier` when the pinned cap is out, and never touches a
  mock loop (tests stay hermetic).
- **Balance allowance before exhaustion, within the same tier** (H-892).
  Per-loop `routing = "headroom"` opts in; `rotation` lists at least two
  same-tier choices in preference order. `headroomRate` takes the minimum of
  `(limit_exhausted_percent - used_percent) / hours_until_reset` across the
  model's applicable bars; a weekly bar is required. The highest rate wins,
  with ties staying on the first configured provider. It is a routing
  heuristic, not a promise to consume exactly 95%: concurrent sessions and
  delayed telemetry cannot reserve future consumption. Never translate
  notional API dollars into subscription percentage or generate work to fill
  a quota. Fallback tiers remain cap-out only; original `rotation` remains
  the default for unopted loops. Missing, failed, older-than-30-minute or
  expired telemetry uses configured order. Fable's scoped cap only affects
  matching models, including in the transient path. `routing.ts` composes
  the same selector for loops and `rev routing`; each headroom decision logs
  its rates or why it used the configured order. Roster/model changes need a
  graceful worker restart; in-flight sessions keep their original model.
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
  that couldn't escalate prints loudly and relies on the dashboard. One live
  summons per loop (H-401): a block checks for a standing non-terminal
  escalation before filing (best-effort — a duplicate beats silence). And
  `rev resume` resets the fail/limit streaks: a resume is a statement the
  cause was looked at, so the loop gets its full retry budget back rather
  than one retry that re-blocks in seconds and files a duplicate.
- **A loop session commits as its seat** (H-787, Arthur's ruling). `sessionEnv`
  puts `GIT_COMMITTER_NAME=<loop>` / `GIT_COMMITTER_EMAIL=<loop>@crew.local`
  into every spawned session's environment, so `git log --committer=mason`
  answers "what did that seat commit" in any repo without depending on an
  agent having read an instruction. Author is left to the machine's git config
  — Arthur stays responsible for the work, and blame keeps naming him — and
  the harness's own `Co-Authored-By: Claude <model>` trailer is deliberately
  left alone: it is the vendors' standard channel for tool provenance and it
  is true. Use `sessionEnv(l)`, not `cleanEnv()`, at any new spawn site.
- Liveness is identity, never a bare pid. A RUNNING marker records the command
  that owns it (`runningStamp()` — use it anywhere RUNNING is written), and
  `pidAlive` requires the live process to still be running that command. Pids
  are recycled across a reboot: a stale marker whose number had been reused by
  an unrelated process made the supervisor abort as "already running" through
  57 launchd retries, with the whole fleet down and unable to converge (H-154).
- **One seat, one worker** (H-558). Before spending an iteration the loop asks
  Helmo who holds in_progress work in its name (`seat-check`) and stands down —
  polls, spawns nothing — while a FRESH hold its own iterations did not claim
  exists: a desk session or subagent sharing the crew name is live in the
  seat, and working over it is how H-542 and H-560 were both trampled. Loop
  sessions stamp `session: "rev:<loop>"` into their Helmo actor (`loopActor`),
  which is how the seat's own mid-flight work is recognized across
  iterations. Stale holds (past `seat_stale_seconds`, default 24h — Helmo's
  own takeover convention) and unattributable claims never block: the guard
  yields to live work, it does not wedge a seat on an abandoned one.
  Best-effort — a seat-check failure logs and proceeds. The race window
  (a desk claim landing mid-iteration) is accepted per Arthur's H-558 answer.
- Every loop wakes on motion only (H-426; store-wide since H-92): ready_count
  is a standing property, so a scoped loop that declined a ticket and idled
  was re-woken by that same ticket every poll, forever. One exception: a
  scoped loop's first successful poll after process start also counts standing
  ready work, so a loop that went down with work queued picks it up on restart
  instead of waiting for unrelated motion. A store-wide loop's (`workstream =
  '*'`) wake-check must additionally carry NO scope at all — assignee
  included. Helm ORs the scope clauses, so any one of them narrows the whole
  store back down to tickets already assigned and silences the fresh-filing
  signal these loops exist for. Cost us bosun's entire wake path until H-138.

## Neighbors

Helmo is the work record and must be built separately; runtime rosters point at
its `dist/cli.js` and `dist/server.js`, while integration tests use the built
checkout named by `REV_TEST_HELMO` (falling back to sibling `../helmo`). Loop
identities and constitutions live outside this repository and are referenced by
the instance roster. In a larger estate, its own project map owns the remaining
cross-project context.
