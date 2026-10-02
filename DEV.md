# DEV — coding context for rev

Rev keeps agent loops turning: process supervision for autonomous loops
that draw work from Helmo. Rev never reads ticket content; Helmo never
manages a process. Product doc: `rev-product-description.md`.
The accepted A01–A14 workflow launch proof and its exact cross-repository
boundary are recorded in `WORKFLOW-GATE-VERIFICATION.md`.
`INSTALLATIONS.md` is the consumer's account of install identity, pinned
releases, upgrade, rollback and removal — what `install.ts`, `release.ts`,
`remove.ts` and the service-definition section below look like from outside.
It is a published promise: a change to any of those modules' behaviour is a
change to that document in the same pass.
Renamed from Capstan 2026-08-05 (H-53); Helm event history before then carries
the old name, and the `capstan-dev` workstream merged into `rev-dev` (H-62).

## Architecture (src/)

- `loop.ts` — the single-loop driver: wake on Helmo's event cursor (zero tokens
  while idle), spawn one fresh session per iteration, classify the outcome,
  idle or halt. The iteration prompt ("work ONE ticket to a natural stopping
  point") lives here. Its first sentence declares the run a Rev loop rather
  than a summon, before tool or routing context can be misread; it then gives
  the workstream's budget when set
  (helm-cli `workstream`: remaining budget, helmo H-55) — disclosure
  before planning, and a steering fetch failure never stops the loop.
  Zero is Helmo's uncapped sentinel (H-267): the prompt says there is no cap
  and keeps runnable work runnable; only positive finite budgets carry
  exhaustion guidance.
  Steering covers EVERY stream the seat has work in, not just the one it
  watches (H-954): `seatStreams` lists the tickets assigned to the seat, and
  the watched stream plus their streams are what `steeringText` speaks for,
  each budgeted stream named individually with its own close-out cue. Only
  streams with a budget appear in the preamble; routed streams without one
  add nothing and naming them in every iteration is prompt noise (H-1127).
  **The prompt carries no prose from outside git** (H-1186, Arthur's ruling
  2026-09-08): the store's workstream `goal` and the roster's per-loop
  `prompt` tail were both free text — uncapped, unreviewed — appended to
  every iteration. Both are gone: `steeringText` speaks numbers in fixed
  wording, and `loadRoster` rejects any loop key outside `LOOP_KEYS`, so a
  prose channel cannot reappear under any name. A seat's words are its
  constitution and roster skills, which the crew's context check measures.
  `workstream = "*"` makes a loop store-wide (H-92,
  built for bosun): wake is unscoped but fires on MOTION ONLY (changed_since, never
  ready_count — the whole store's standing backlog would wake a judge every
  poll forever), no steering fetch at all — its prompt carries none of the
  close-out framing steering is written for — and it defers to the
  constitution instead of naming a stream or the ONE-ticket rule. Per-loop `idle_floor_s` holds wakes after
  an unproductive pass, and since H-1072 it holds them for `'*'` loops ONLY:
  motion accumulates but cannot re-wake the loop until the floor elapses
  (H-336: a live desk session woke ward ~$1/2min against an empty queue;
  H-545: bosun's own sweep records were the motion that woke it, 16 straight
  iterations to the burn breaker). A store-wide loop also idles after a
  *productive* clean pass. Its idle cursor deliberately remains at the
  pre-session snapshot: a filing can land after the session's final queue read
  but before Rev's post-session snapshot, and advancing through that event
  would acknowledge work no triager ever saw. Motion during a store-wide pass
  is therefore delivered at least once on the next wake. The loop may buy one
  bounded reconciliation pass for its own writes, then advances on the quiet
  pass; the idle floor still caps that cost. Before this, the floor
  only ever gated wakes, and a produced pass used to `continue` straight
  into the next one, so bosun's pass-closing sweep record, which drew a
  done_without_evidence finding that the next pass disposed of, ran it back to back
  at ~$0.40 a pass (H-2164). One sweep covers the whole store; only someone
  else's motion justifies another. Motion is still what wakes a store-wide
  loop, so the floor is still what caps its burn. A scoped loop no longer
  needs one: it wakes on a readiness edge, and work newly ready for the seat
  is by definition not the churn the floor was built to absorb. The key is
  still parsed for those loops but never consulted, and it has been dropped
  from every scoped loop in the instance roster. The first successful poll after
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
  `needs_human`, carrying the one line the sitting needs — Helmo refuses a bare
  marker — without halting the rest of the seat. Any advancing work, or a
  ticket leaving the ready set, resets its streak. Store-wide `'*'` loops are
  excluded: their job is judgment, and a recorded disposition is the action.
  An IDLE sentinel keeps the wake cursor on its first line and a bounded reason
  on its second (H-954): either no executable work exists in the seat's scope,
  held work is non-executable, or a session left executable work untouched.
  The view and `/health.json` expose that reason; it stays local so observing a
  wait cannot create Helmo motion and wake the same seat again. A SEAT_HELD
  sentinel makes the same-seat guard visible while the loop stands down for
  another live session; the view, health feed, and CLI show the hold instead
  of calling it a running iteration, and the marker clears with the hold.
  Multiple roster loops may explicitly share an accountable `seat`: each
  keeps its own state directory and `rev:<loop>` session identity, while
  Helmo sees the role name for assignment, authorship and self-review. The
  guard exempts only the peer sessions derived from the loaded roster; an
  unlisted desk session or subagent still holds every worker in the seat.
  Their `cwd` paths must be separate writable workspaces; the roster refuses
  two workers of one seat in the same `cwd`, and refuses a `'*'` pool.
  **Pool workers launch on a claim, not a choice** (H-574). A loop sharing its
  seat skips `launch-admit` and, just before `run-start` (after every capacity
  exit, before the probe decision), calls helm-cli `launch-claim --workstream W
  --assignee <seat> --launch-id <id> [--project P]` written by the worker
  itself — seat name, `rev:<loop>` session, `generation` = the launch id — so
  Helmo selects, workflow-admits and claims in one transaction, bound to that
  one attempt. The session's `HELMO_ACTOR` (MCP env, and the mock's env)
  carries the same generation; Helmo refuses execution writes on the ticket
  from any other session or generation (`execution_claim_held`) and any write
  from a retired one (`stale_generation`). The prompt names the one ticket and
  forbids touching any other. The journal records `claim: true` at intent and
  the ticket on the receipt. **Unfinished work stays with its worker**: a
  session that ends with the ticket in progress logs `claim-kept`, and the
  same worker's next `launch-claim` returns it with `resumed: true` — retiring
  the old generation — and the prompt says it was resumed, names the
  workspace, and points at the ticket's last recorded step. A restart after a
  crash settles the dead launch's journal and keeps the claim the same way, so
  a child that outlived its loop can write nothing after the resume. Only a
  claim never worked goes back to `open` (seat reservation kept), released as
  the launch's own generation: a session that never started (`apparatus`), a
  failed pre-dispatch revalidation, a suppressed replay, or a journal write
  that failed. A resumed workflow claim carries the admission its first launch
  consumed (Helmo revalidates it at resume), so Rev journals it claim-only. A
  store without `launch-claim` denies every pool launch — without the atomic
  claim two workers race the same ticket. Nothing ready means `launch-idle`
  and no session. `project` is the worker's lane; it is refused on a loop
  with no pool.
  **A role is addressed as a role** (H-676). The first worker usually keeps
  the role's name, so `stop`/`resume`/`pace`/`team` resolve through
  `controlTargets` (config.ts): a seat with more than one loop, or a seat no
  loop is named after, reaches every worker of it, and `--worker` narrows it
  to the one loop of exactly that name. Sentinels stay per loop; a role-level
  halt is written to each worker. Anything that routes work to a role must ask
  which worker can draw it: `drawsScope` (helm.ts) says a one-worker seat
  draws its seat's work in any stream, a pool worker only in its exact
  workstream and lane. The anomaly investigator is chosen with it and
  assigned by seat, never by loop name — a pool worker's own name is no
  assignee anything wakes on. `status --json` prints each loop's `seat`,
  `pool`, `workstream` and `project` beside its state, for consumers outside
  Rev (gp-crew's handoff guard) that must answer "can this role take this
  ticket"; the human table is unchanged because estate tools parse its header.
  **Workflow launch admission** is the last gate before a session is spent
  (H-2561, helmo H-471): `launchAdmit` asks helm-cli `launch-admit --workstream
  W --assignee A --launch-id <identity>`, and Helmo picks the
  seat's ready candidate, checks it, and records the admission in one
  transaction — so the verdict cannot drift between the check and the launch.
  Rev asks rather than deciding and keeps no verdict: the question is put again
  every pass, and a fresh process asks again on its restart pickup rather than
  walking through a denial it never saw. Helmo's echoed `launch_id` is
  deliberately not compared with the one sent; it is there so Helmo can admit a
  retry of the same launch without recording a second admission. For
  workflow-bound work that identity is a digest of the seat, ticket and
  workflow-attempt id, so a process restart asks with the same name and the
  durable pre-dispatch claim suppresses a second model session. Ordinary and
  probe launches retain their process-local unique identity because they have
  no workflow attempt to recover.
  Rev also requires the atomic answer to identify the same candidate as its
  immediately preceding compatibility read; a queue substitution fails closed
  instead of borrowing the earlier candidate's workflow classification.
  **Three of the four answers are a launch, and only one of them is a yes.**
  `admitted: true` admits a candidate (`launch-admitted`). `admitted: false`
  means nothing READY was there to gate — not a refusal: the seat still has its
  held work and its probe pass, and whether to spend an iteration on those is
  Rev's decision, so it is not even recorded as one. A thrown
  `workflow_admission_denied` is an explicit refusal: it logs `launch-denied`,
  spends nothing, and re-idles at the cursor it read, so the question returns
  on the next motion or the hourly resync. An installation that predates the
  command answers with its usage text. Rev first reads Helmo's same ordered
  next-candidate query: ordinary work keeps its prior behaviour and logs
  `launch-admit-unsupported`. The question is repeated on every pass so a later
  workflow candidate cannot inherit an ordinary ticket's bypass. Workflow-bound
  work instead fails closed until an exact immutable admission is returned.
  A corrupt or temporarily unavailable gate follows
  the same affected-work-only rule and is asked again next pass.
  Workflow admissions are durably revalidated immediately before dispatch and
  again after the model returns. A restart quarantines any admitted or
  dispatching journal entry it recovers: that boundary is ambiguous, so only
  the affected attempt is withheld while ordinary work and sibling branches
  continue. Failed quarantine remains unsettled for the next restart rather
  than being mistaken for safe output.
  Revocation is therefore bounded by one already in-flight model session: a
  killed driver cannot stop that detached session, but the next Rev boundary
  quarantines its attempt and refuses to launch it again or count its output as
  success. This relies on the host OS and process tree reporting honestly;
  unrestricted local process access remains outside Rev's trust boundary.
  That stderr is captured rather than forwarded (`run`'s `quiet`) —
  `execFileSync` does both by default, which would put Helmo's whole usage text
  in the loop log once per pass.
  After
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
  Parsed Codex credit capacity survives with it: a fresh positive balance (in
  credits, never dollars) or explicit unlimited allowance keeps the account
  runnable after included bars fill, while missing/zero credits and provider
  spend-control refusal remain out. Credit availability does not bypass the
  subscription anomaly detector; it only answers whether another run can start.
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
- `sentinels.ts` — process identity is three-state. A missing or mismatched
  process is dead; a matching command is alive; unavailable process inspection
  is `unknown`, shown that way by status surfaces while conservatively keeping
  the RUNNING marker occupied so a restricted observer cannot start a duplicate.
  Process-control sentinels keep their value on line one and may carry `by`,
  `at`, `pid`, `reason` and `expires_at` provenance below it. Legacy or malformed
  controls are presumed deliberate and never auto-cleared. Only an expired or
  orphaned non-human PACE is released, and cleanup compares the observed
  by+at+pid tuple before unlinking so it cannot erase a replacement owner.
- `burn.ts` — reads the token-log back as a per-loop rolling window (hour and
  day) for the breaker. A file scan, not an in-memory total, because the two
  burns it exists for both spanned process restarts; the window is floored at
  `.burn_floor` (stamped at loop start) so a resumed loop starts clean instead
  of tripping again on money already accounted for (H-412).
- `capacity.ts` — plan capacity and runaway detection, pure (H-185), consumed
  by the loop before subscription-provider runs (H-186). Metered providers
  retain the legacy dollar and transient-limit gates; declaring a provider
  `billing = "subscription"` makes its fresh plan bars the capacity gate.
  It exists because a breaker metering *notional* dollars stopped a loop for
  7h08m on a full backlog while both accounts had a third of their weekly
  allowance spare (H-178, 2026-09-29). Three quantities it refuses to
  substitute for one another: plan capacity (the provider's own percent bars —
  the only one that says whether more work is possible), notional metered
  equivalent (token-log dollars — accounting, and the axis a runaway shows on),
  and billed spend (not observable on a flat plan, so it is said rather than
  approximated). `capacityDecide` returns continue / switch / refresh /
  continue_stale / wait / scheduled_resume / blocked; the scheduled-resume
  branch persists `resume_at` in LIMIT, exits the loop, and lets the supervisor
  relaunch it at the reset without clearing STOP, HOLD or BLOCKED. A reset past
  the exhaustion ceiling still blocks for a human because the telemetry is
  wrong rather than the plan.
  `anomalyDecide` measures a rate against the loop's own rolling mean, never a
  cumulative total. After a subscription run the loop compares its notional
  cost with the preceding five parseable iterations *on the same runtime* and
  refreshes the same plan window to measure percentage-point movement. A trip
  writes both the halt sentinel and `BLOCKED.json` with the observed values,
  baseline, time and escalation ticket, which `/health.json` and the dashboard
  surface. An anomaly or terminal-capacity trip is assigned at priority 0 to
  the first live, unblocked roster peer. A peer can authorize one restart by
  attaching an exact `rev:false_alarm:<encoded reason>` evidence ref; the
  supervisor matches it to `BLOCKED.json`, clears only BLOCKED, and proves
  minimum uptime before closing the investigation. A same-reason relapse
  inside the configured window, or the absence of a live peer, routes to the
  human instead. **No percent is ever converted to tokens or dollars**, in
  either direction.
- `shim.ts` — the runtime adapter (claude / codex / mock). Owns non-interactive
  flags, constitution injection (fail-closed), `cleanEnv()` (strips parent
  CLAUDE/ANTHROPIC/CODEX env — the auth-leak fix; don't weaken it) and
  `sessionEnv()` over it (the seat's git committer identity, H-787 — the
  variables rev SETS are `sessionEnvOverrides()`, separable because a spec
  printed to stdout must never carry the caller's own environment), the session
  **process group**, per-session
  token metering, transient-API detection, and the strict MCP surface (sessions
  see ONLY Helmo + the loop's `mcp_extra`; only the Helmo server is handed the
  loop's actor identity in `env` — an `mcp_extra` server that wants to know who
  is writing gets it as a per-call parameter from the agent, or from its own
  `env` block in the loop's JSON, never from `HELMO_ACTOR`, which `cleanEnv()`
  does not carry into the session, H-324): claude via `--strict-mcp-config`,
  codex via the whole-table `-c mcp_servers={...}` override (H-479) — and that
  override is argv, so an `mcp_extra` server's `env` block is `ps`-readable by
  every local user for the session's lifetime where claude's copy is a 0700
  scratch file; a loop that may run on codex must not carry a secret there
  (documented in `examples/roster.toml`, H-1417). Codex
  gotchas the adapter encodes, all verified on codex-cli 0.150.1: the prompt
  goes in on stdin (`exec -`) because argv is ps-readable and size-capped;
  `--ignore-user-config` is always passed (H-520) — fleet behavior must not
  change when the operator tweaks `~/.codex/config.toml` (auth.json and
  session rollouts are unaffected); anything a run needs beyond the MCP table
  arrives as `-c` overrides from `[providers.<name>.config]` in the roster
  (reasoning effort, future custom endpoints via `model_providers`). Project
  hooks remain in scope, and Rev passes `--dangerously-bypass-hook-trust`
  because an unattended loop cannot answer Codex's interactive trust prompt;
  the estate reviews those hook definitions in git. MCP
  tools need `default_tools_approval_mode = "auto"` AND the
  approvals/sandbox bypass or every call hard-fails under `approval_policy =
  never`; exit 0 without a `turn.completed` event is a real failure
  (openai/codex #19309), so results are gated on the event stream, and a
  failed run's tail carries a `rev: codex failed — exit N, turn …, error
  event: …` line even when the agent sent a final message, which used to
  hide the reason entirely (H-2164); codex under
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

  **`sessionSpec()` is that composition as data** (H-1152), so a consumer that
  is not a loop can run a seat's session without a second copy of the recipe.
  Its one caller today is the Meetings room, where Arthur types instead of the
  queue: same cwd, same skills, same Helm surface, same model routing. Two
  things it does NOT do the way a loop does. The exported `env` is
  `sessionEnvOverrides()` only, plus `env_strip` as the rule for the rest — a
  spec goes to stdout, and `sessionEnv()` copies the fleet's whole environment.
  And the actor's session stamp is a required argument, never defaulted:
  `rev:<seat>` is the seat stamp `seatDecide` reads (H-558), so a consumer that
  signed by omission would make its Helm writes read as the loop's own hold.
  Ward's H-1151 ruling names the meeting form: `meeting:<thread id>`.

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
  handler's first chance to fire. That synchronous stretch used to run straight
  past the iteration boundary and into the NEXT session (H-1109): `await` on an
  already-resolved promise drains microtasks without turning libuv, so the
  signal watcher never got its turn and a busy loop swallowed the drain
  outright — six loops gone in milliseconds while mason ran three more
  full-price iterations on the old code and held the fleet down for ten
  minutes. `loop.ts` yields once (`setImmediate`) at the top of every
  iteration, which is the only thing making the deferral end where it is
  documented to end, and the handler logs `loop-stop reason=drain` so the
  loop's own events.log says why it went. What that deferral never covered is
  a signal aimed at the process GROUP rather than the loop, which is where
  H-467's orphaned artifacts came from: see the session process group under
  `shim.ts`.
  Child stdout/err goes to state/<loop>/console.log; supervisor decisions to
  state/supervisor/events.log. 'supervisor' is a reserved loop name.
  An installation may also opt this same poll into the narrow Good Plumb
  intake-preparation adapter with `intake_preparation_origin` and
  `intake_preparation_checkout`. `intake-preparation.ts` signs outbound
  claim/heartbeat/failure/result requests with the macOS Keychain service
  `plumb-intake-executor-secret`, validates the occurrence identity and exact
  signup hash before writing, and creates one identifiers-only Builder ticket
  using only Helmo CLI-supported fields; project metadata is not passed because
  that CLI refuses fields which exist only on the MCP create surface.
  Attempt state contains no signup text and lives under state/supervisor; a
  stale result is discarded on the Worker's 409. Before heartbeat or result,
  the adapter re-reads that ticket and retains the lease only while it is open
  or in progress; any other status discards the local attempt and result so the
  Worker can recover it after lease expiry. There is no listener or
  second scheduler, and an installation declaring neither key is unchanged.
- A human answer reopens a Helmo ticket with `resolution: resume` regardless
  of whether its operational choice was resume, hold, or investigate. The
  supervisor clears `BLOCKED` only when `last_answer.chosen_option` is the
  `resume` choice (or the dashboard's `resume — rationale` recommendation);
  ticket lifecycle state alone is not process-control authority (H-1320).
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
  the landing on the requesting ticket. That note is best-effort by design, and
  a **closed ticket is the ordinary case, not a fault** (H-1118): the loop that
  asks finishes its close-out during the drain it asked for, so it is done by
  the time a supervisor is back to write, and Helm rightly refuses writes on a
  terminal ticket. So the status is read first and a terminal one logged as
  `redeploy-note-skipped`; only a real failure is `redeploy-note-failed`, and
  it now carries Helm's own words via `cliError` rather than execFileSync's
  message, which is the command line and nothing else. Five landings in one day
  were logged as failures with that message, and it read as Rev calling Helm
  without an identity — it never was. **Nothing is dropped and no new record is
  filed for it:** the landing is the `redeploy-done` line in events.log, which
  is the very file the note offers as its evidence, so a skipped note costs a
  reader nothing. Filing a fresh ticket per successful routine redeploy would
  put noise in the human's queue to record a success. Asking mid-work
  is safe because the drain's SIGTERM to the requester's own driver is deferred
  past the in-flight iteration like any other, so the restart lands after the
  iteration ends with its run-end and metering intact. Measured on the live
  fleet: ask 02:19:59Z, drain 02:20:38Z (the next poll), the last straggler's
  iteration held it to 02:28:54Z, fleet back 160ms later.
- `service.ts` — reboot resilience: launchd plist (KeepAlive on crash only —
  a drain exits 0 and stays down) / systemd user unit. Units embed
  install-time PATH and REV_HOME because service managers strip env.
  **The service identity is the resolved Rev home** (`serviceLabel()`,
  `systemdUnitName()`, H-2210 then H-2452). It was the constant `dev.rev`, and
  that one string is also the plist filename and the bootout/kickstart address —
  so two fleets under one login fought over one job and one file, and the second
  install silently replaced the first. H-2210 derived it from the home's
  basename, which was still one identity for many installs:
  `/tmp/customer-a/.rev` and `/tmp/customer-b/.rev` are both `.rev`. Redirecting
  `HOME` does not separate them either — a plist *filename* lives under `$HOME`,
  but launchd's namespace is the uid's (`gui/<uid>/<label>`), so two installs
  under one account share one bootout and kickstart address whatever `HOME`
  says. Hence:
  - A **conventional home** keeps the label it is already bootstrapped under,
    by rule and not by name: a direct child of the **account's** home directory
    called `.rev` or `.rev-<suffix>` cannot collide with another such home.
    `~/.rev` → `dev.rev`, `~/.rev-gp` → `dev.rev.gp` and systemd `rev-gp`. This
    must hold whether `REV_HOME` is unset or explicitly the default, because the
    installed plist exports `REV_HOME=~/.rev` back to the process.
  - **Anywhere else** the label carries eight hex of a SHA-256 of the resolved
    home path, after a readable part taken from the home's basename or, when
    that is a bare `.rev`, from the directory holding it:
    `/tmp/customer-a/.rev` → `dev.rev.customer-a.3f9a…`. Stable across restarts,
    distinct per install, no new state store.
  - The account's home comes from the **password database** (`userInfo()`), not
    from `$HOME`, for the same reason the plist is a hazard here: a service
    manager hands a daemon an environment the software under test may have
    written, so an identity keyed on `$HOME` is keyed on something a second
    install can set. `$HOME` still decides *where* the definition file goes —
    that is `serviceFile()`, and it must stay that way, because it is also what
    lets a test fixture contain a write.
  - The input is `resolve()`d, not `realpath`ed: a home reached through a
    symlink is a second identity, and `REV_LABEL` is the override for that.
  `REV_LABEL` overrides the derivation outright, and **`serviceInstall` writes it
  into the service environment** (plist `EnvironmentVariables`, systemd
  `Environment=`), so a job restarted with the bare environment a service
  manager gives daemons resolves the identity it was installed under rather than
  re-deriving a different one. The label is a parameter of `launchdPlist`,
  `systemdUnit` and `installLaunchd` rather than a module constant, so the plist
  a call writes and the job it boots out can never disagree.
  **Ownership before a destructive act.** The derivation can no longer collide,
  but an operator can still point two installs at one explicit `REV_LABEL`, and
  then the label says nothing about who a service belongs to. `install`,
  `uninstall` and `start` therefore read the definition already on disk and
  refuse when its `REV_HOME` is a different installation's (`definedHome()`,
  `assertOwnService()`), naming both homes and the way out; the `rev service`
  CLI prints that refusal as an error rather than a stack trace. A definition
  carrying no `REV_HOME` reads as unowned, which is what keeps a pre-H-2210
  install upgradeable.
  **Migration.** A non-conventional home's label gains its digest, so a service
  installed under the old basename-only name is still on disk and still loaded.
  `serviceInstall` retires it (`legacyServiceLabel()`, `retireLegacyService()`)
  — but only when that definition names *this* home, which is what makes the
  removal this installation's own business rather than a guess. Conventional
  homes are unaffected: `~/.rev` and `~/.rev-gp` compute the same labels they
  always did, verified against both live plists.
  **A pinned definition names a launcher, never a release** (H-2511). A
  definition is written once and nothing rewrites it, so the path it carries is
  frozen at install time. It used to be `process.argv[1]`, which under a release
  selection is a `cli.js` *inside* a release directory — so after `rev release
  upgrade` the job the service manager brought back exec'd the release the
  installation had just left, was stopped by `selectedRelease()` as an uncaught
  throw, and under `KeepAlive` was brought back to fail again, with launchd.log
  the only account of it. The upgrade's own output promises the opposite. So
  when `INSTALLATION_RELEASE` is set, `serviceInstall` writes
  `<REV_HOME>/service/launch.mjs` (`launcherPath()`, `writeLauncher()`) and the
  definition names that:
  - It resolves the selection at **start**, so a release change is picked up by
    a restart with no reinstall — which is exactly what the upgrade says.
  - It hands over **in the same process** (`process.argv[1] = cli; await
    import(...)`), so the manager's signals, its exit timeout and the pid it
    supervises all reach the supervisor itself, and everything downstream — the
    loop drivers the supervisor spawns, `REV_CLI`, the command line the
    sentinels record — is what it would have been had the manager named that
    file directly.
  - It decides as little as possible: it is the one file a release change cannot
    update. *Verifying* the set stays in `selectedRelease()`, which now passes
    because the code came from the directory the selection names.
  - A selection it cannot resolve still refuses, as **one line** naming the
    installation and the repair rather than a stack trace, and exits non-zero on
    purpose: the manager retries, so a repaired selection brings the supervisor
    back with no command run.
  - **Unpinned installations are untouched** — no launcher, and the definition
    still names the `cli.js` it was installed from.
  The launcher records its physical path in `REV_SERVICE_LAUNCHER` before it
  corrects `argv[1]`. `runningStamp()` uses that path only for the supervisor's
  exact `run` invocation; inherited loop processes keep their cli.js command.
  Thus liveness matches the kernel command line without weakening loop identity.
  A definition installed before this change still names a release directory;
  `stalePinnedService()` finds it and `rev release upgrade|rollback` says so,
  where the promise is made, rather than leaving it for launchd.log.
  systemd gets `KillMode=mixed` and a timeout longer than rev's drain, so a stop
  signals the supervisor rather than every process in the cgroup (H-467).
  launchd is different: it clamps `ExitTimeOut` at 60s even when the plist asks
  for 660s (measured on Darwin 25.6, H-877). Its bootout/reinstall path is
  therefore a hard stop after the largest available 60s window. Installation
  waits until that job has actually released its label before bootstrap, and a
  failed bootstrap restores the prior definition and job. The detached
  session process group is what lets an agent finish and close its work. Use
  `rev stop` when the whole machine must drain gracefully before service work.
- `build.ts` — **what did this process load?** (H-2489). `snapshot()` reads a
  code directory as it is now; `loaded()` holds what the running process read
  at startup; `compare()` says whether they are still the same bytes. See "What
  built `dist`, and what is RUNNING it" below — the two are never one claim.
- `install.ts` — **which installation is this command about?** (H-2473). The
  identity above answers what an installation is called; this answers the
  question every command was assuming. `target()` returns the label, the
  resolved home, and a conflict if there is one; `targetLine()` is the line
  each command prints to say which Rev it read or wrote; `requireTarget()` is
  the gate a mutation passes before it writes.
  When `INSTALLATION_RELEASE` names an `ADOPTED.json`, every CLI/supervisor
  start verifies all three component commits against that release's
  `RELEASE.json` and verifies Rev runs from its selected directory. Missing,
  mixed, or shared-checkout code refuses before the roster is read. Service
  definitions and spawned Helmo MCP servers carry the selector.
  - **Every command names its target.** `status`, `usage`, `routing`,
    `service status` and the bare-usage footer print it, and so does each
    mutation's own confirmation, because the mutation's output is where an
    operator looks to see what they just did. The two exceptions are `tail` and
    `session-spec`, whose stdout is a machine value a caller substitutes — a
    prose line there would break the caller, and both already carry the home
    (a state path, a roster-composed spec).
  - **`--installation <name|home>` asserts; it never redirects.** It takes
    either spelling because those are the two an operator has in front of them
    — a label a status line printed, a home path a roster or plist names,
    joined by a space or an `=` — and a disagreement is a refusal, not a
    precedence rule. An inherited value quietly beating an explicit one is the
    case that must be impossible, so there is deliberately no flag that
    *changes* the target: `REV_HOME` does that, and the flag is how you say you
    meant it.
  - **The assertion is made at the door, for every command including reads**
    (`assertInstallation()`, called in `cli.ts` before the switch). It was a
    parameter of `requireTarget()` until H-2526, which meant it held only where
    a handler remembered to pass it — and the read surfaces, which are exactly
    where a script puts an assertion, returned before reaching it and exited 0.
    One check before the switch is the same discipline as the `UNPINNED` list:
    a surface added later cannot forget it. It reads the target `unchecked`, so
    the two escapes from a broken selection stay reachable while still being
    held to the name they were given.
  - **The inherited conflict needs no flag to go wrong.** `cleanEnv()` copies
    the supervisor's environment into every session, `REV_LABEL` included, so a
    command run with another `REV_HOME` is named by one installation and aimed
    at another. The label cannot detect this — any process can set it — but the
    definition installed under it can, because it carries the `REV_HOME` it was
    installed for. `inheritedConflict()` is `assertOwnService()`'s question
    asked for every mutation rather than only the `service` verbs.
  - Reads still read under a conflict — they are safe from any context and the
    watch officer depends on that — but they print `installation: UNCLEAR` and
    name both homes rather than claiming a name they cannot stand behind.
  - `bin/gp-rev.js` deletes an inherited `REV_LABEL`: it fixes the home, so the
    name must come from the home. Without that, a crew session running `gp-rev`
    would be refused every mutation it asked for, correctly.
- `release.ts` — **changing which release an installation runs** (H-2493).
  `install.ts` verifies the pin; this is the only thing that moves it, because
  until now the write half was a text editor. `rev release status | upgrade
  <dir> | rollback`.
  - **The whole set is verified before the pointer moves.** For each of rev,
    helmo and helmo-roadmap: `dist` holds JavaScript, and its `BUILD.json`
    stamp names exactly the commit `RELEASE.json` does, built clean. A dirty
    component is refused — `stamp-build.mjs` records a dirty tree rather than
    refusing it, which is right for a build and not enough for a release: the
    manifest's commit would not identify the bytes. `releaseProblems()` returns
    every fault at once so a set is fixed in one pass, not three rebuilds.
  - **`MIGRATION.json` is required in the release directory**, authored rather
    than generated: `data_compatibility` (`compatible` | `one_way`) and
    `rollback` (`{supported:true}`, or `{supported:false, limit}` saying what
    cannot be recovered and how to recover from a backup). A release that has
    not declared it cannot be selected — after the upgrade is too late to ask.
    It is copied INTO the selection when selected, so a rollback can be refused
    in the limit's own words with the release directory long gone. **This repo
    ships the declaration for the release it is tagged as**, at `MIGRATION.json`
    in the root: the consumer builds the three `dist` directories and assembles
    the release directory, so upstream's claim about consequences has to travel
    inside the source rather than be left for them to invent. It carries no
    `release` field on purpose — the id is the directory's basename, which is
    theirs to choose, and a declaration naming an id is refused in a directory
    named anything else. `test/release.test.ts` selects a set built from the
    shipped file, so an edit that makes it unselectable reddens.
  - **The replacement is atomic and durable**: temp file in the same directory,
    `fsync`, `rename`, then `fsync` on the directory — without the last one the
    bytes are durable and the name pointing at them is not. The selection it
    replaces is retained whole INSIDE the new one, so a rollback is the same
    write in the other direction and one rename moves both or neither.
  - **`rev release` is one of the two families exempt from the pin check** in
    cli.ts (`install` is the other), and has to be: it is how a broken
    selection is repaired, so gating it on the selection being sound would put
    the repair behind the fault. `status` reports the incoherence as lines
    instead of throwing, and `upgrade` over an unreadable selection says
    plainly that nothing was retained to roll back to. The exemption lives in
    `UNPINNED` at the top of cli.ts and nowhere else — a handler passing
    `requireTarget` its `'unchecked'` argument never reaches that argument if
    the module gate stopped it first, which is exactly how `install remove`
    shipped unreachable (H-2522).
  - It changes one file and restarts nothing: a running process keeps the code
    it loaded and takes the release when it next starts. Operating a service
    here would be operating one the command has not established it owns.
- `deployment.ts` — **the durable activation record** (H-2572), stored as
  `activation.json` beside the release selection. Built, published, selected,
  activating, running, failed, and rolled-back are distinct; every record
  carries exact component refs, effective installation identity and an owned
  recovery instruction. `rev release status` combines it with the selection
  and reports missing, partial, or stale evidence rather than treating selected
  artifacts as live processes. A running record declares its required process
  set; status checks coverage, exact commands, loaded refs, installation
  identity and PID liveness, and keeps activation recovery visible even when
  the selection is unreadable. Activation code writes running only after its
  process probes supply their loaded refs, identities and identity write/readback.
  `rev release activate` (H-2571) is the supported write path: it records
  `activating`, reuses the redeploy sentinel so the current iteration closes
  before the bounded supervisor drain, and lets only the replacement supervisor
  record `running`. The detached restart watch records `failed` and recovery if
  no supervisor returns; identity conflicts refuse at the CLI door before any
  activation record or sentinel is written.
- `remove.ts` — **the one command that deletes an installation's records**
  (H-2512). `rev install remove [--confirm]`. Every other removal rev has keeps
  the data: `rev service uninstall` takes the definition and leaves the store,
  the controls and the selection byte-for-byte. That left the
  independent-installations contract with a line nothing could satisfy — the
  spec asks a release to prove that "uninstall of A, deleting only A's data,
  leaves B's store and controls untouched" — and the only removal an operator
  had was a hand `rm -rf` in a shell carrying the other installation's
  `REV_HOME`, which is the H-2431 shape with no product refusal in the way.
  - **It is a separate verb, not a flag.** `rev service uninstall --also-data`
    would make the difference between keeping and deleting every record a word
    someone can miss. The two removals are distinguishable at the command line.
  - **The plan is printed before anything goes, and `--confirm` is a second
    act.** Without it the command writes nothing and exits 0, which is also how
    an operator finds out what the installation actually owns.
  - **The boundary is the directories the installation OWNS, named** —
    `removalBounds`. It was `dirname` of the resolved Rev home, which is right
    for a parent dedicated to one installation (`/srv/installs/alpha/.rev` beside
    `/srv/installs/alpha/.helmo`, the shape the fixture proves) and wrong for the
    layout this product calls conventional: `~/.rev-b` beside `~/.helmo-b` makes
    that parent the ACCOUNT HOME, so every path under `~` read as ours. Ward
    found it in the H-2542 clearance, and the plausible route in is `cp -a ~/.rev
    ~/.rev-b`, which brings `roster.toml` and its `helmo_db = ~/.helmo/helmo.db`
    with it — the first installation's records, named by the second, inside the
    boundary (H-2544). So a conventionally NAMED home gets a named set instead:
    itself plus the Helmo family's homes beside it carrying the same tail
    (`conventionalTail`, exported from service.ts because it is the same
    uniqueness the label rests on). A tail beginning `-roadmap` at a name
    boundary is reserved: `.helmo-roadmap[-…]` is another installation's
    roadmap home, so removal never pairs it as this installation's Helmo home
    (H-2553). The name, not the location, decides — so
    `.rev-a` and `.rev-b` are separate wherever they sit, and the rule is
    provable in a tmpdir rather than against the real account home. Any other
    name keeps the enclosing directory, because there is nothing to pair with;
    that is the remaining gap, and the docs say so rather than implying a guard.
    A selection file in the directory the homes share is now reported rather than
    taken — under the conventional layout that directory is the account home, so
    the documented place for it is inside the Rev home. Rev's home, the Helmo
    store the roster names, the roadmap store `ROADMAP_DB`/`ROADMAP_HOME` names,
    and the selection, each with its SQLite `-wal`/`-shm` beside it. A product
    this installation names no store for gets no default assumed — the default is
    the shared one.
  - **Order, each refusal naming the command that clears it.** A standing
    service definition blocks it (`rev service uninstall` first, or a manager
    keeps bringing back a supervisor whose home this deleted); a live supervisor
    blocks it (`rev stop` first — it writes state back into a home being
    removed); a `REV_HOME` that contains the account's own home directory is
    refused outright. Like `rev release`, it runs `unchecked`: a removal is one
    of the two ways out of a broken selection, so gating it on the selection
    being sound would leave an installation that can neither run nor be
    removed. That takes BOTH halves — the `'unchecked'` argument here and the
    `install` entry in cli.ts's `UNPINNED`. It shipped with only the first, so
    the exemption was unreachable until H-2522.
  - **A liveness read must not create what it reads.** `occupiedPid` goes
    through `stateDir`, which `mkdir`s — so asking it of an already-removed
    installation rebuilt that installation's Rev home, and the next plan had
    something to take again. The check is skipped when there is no home.
  - Release directories are never touched: a release is shared between
    installations, and `rev release` is what a version change goes through.
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
- `launch-journal.ts` — the durable, per-loop record between workflow
  admission and model dispatch. Rev writes an intent, expands Helmo's immutable
  launch receipt into the exact ticket, workflow attempt, admission, definition
  revision and requirement/manifest/decision refs, then fsyncs an exclusive
  dispatch claim before starting the model process. The claim is at-most-once:
  replaying one launch id cannot start a second model process, including after
  a crash in the pre-dispatch gap. Entries live under
  `state/<loop>/launches/`; recovery and revalidation build on them rather than
  reconstructing authority from current workflow state.
- `view.ts` — read-only machine dashboard at :4500; `/health.json` is the
  machine-readable snapshot (loop states, usage) for aggregators like the
  estate health page (crew tools/health, H-627) — consumers read it rather
  than re-deriving sentinel truth. `cli.ts` — run / status /
  stop / resume / pace / service / tail. `rev run`/`rev stop` with no argument
  mean the whole machine (Arthur's ruling: the operator starts the machine,
  not a named worker). `bin/gp-rev.js` is the Good Plumb operator entrypoint:
  it fixes `REV_HOME` to `~/.rev-gp` before loading that same CLI, so every
  verb stays shared while neither a shell override nor remembered flag can
  cross estates. Its displayed commands and roster source follow that name.

## Commands

- `npm run build`, `npm test` (ladder units + e2e with mock runtime). The
  verbose reporter is deliberate: the real-process e2e files can take several
  minutes on a loaded fleet host, and per-case progress distinguishes that
  bounded work from a hung run without inspecting or killing its fixtures.
- The release CLI fixture clears inherited `INSTALLATION_RELEASE` and product
  identity/store variables before applying explicit fixture overrides, and its
  `HOME` is the disposable parent of `REV_HOME`. Redirecting `REV_HOME` alone
  leaves an inherited absolute selection writable (H-2579). The regression
  runs an unpinned command beneath a disposable pinned parent and requires the
  parent's selection to remain byte-for-byte unchanged.
- **`npm test` runs two test files at a time, not eight (H-1347).** Vitest's
  default is `availableParallelism() - 1`, and this suite's parallel unit is
  not a worker, it is everything a worker spawns: the five e2e files each
  drive a real supervisor, real loops and a real Helm store. The cap is free
  — measured on 159cb11, a quiet-ish machine, 225/225 green each time:
  workers 8 → 83.8s wall / 111s CPU, 2 → 83.3s / 105s, 1 → 145.3s. Wall time
  here is set by the slowest single file (`loop.e2e.test.ts`, ~80s), not by
  how many run beside it, so two costs nothing and one costs a minute. What
  the cap buys is resident weight: peak vitest processes 10 → 6.

  Do not read that as the cure for a red CI run. On 2026-09-13 this suite
  read red in CI with nothing wrong in it — both attempts failed, the first
  killed at the runner's 600s cap and the retry failing seven tests, every
  one a timeout and every one absurd (a 5s budget reported at 106000ms, a
  450ms test at 106251ms). The same commit passes in 84s here. It was the
  machine: that night `connectors` took **971s** for a build and a typecheck,
  a step with no fan-out at all, and four of six repos ran red or flaky. The
  cap bounds what this suite asks for; it cannot make a starved box compute.
  What ends that class of red is CI not reading a machine already carrying
  the live fleet — H-1352.

  One red-under-load case was neither slowness nor a starved box. The
  resume-failure case in `supervisor.e2e.test.ts` (H-1038) failed only on a
  busy machine, and giving it more time made it worse: with its wait budget
  raised from 20s to the whole 60s of the case it still timed out, at 55s
  instead of 25s. It was racing, not waiting. The supervisor calls a resume
  healthy once the restarted child has stayed alive for `min_uptime_seconds`,
  and the fixture set that to 1s — while the loop under test needs two failed
  runs and the burn breaker to die, a couple of seconds out. Idle, death won
  and the case passed; loaded, liveness won, the resume was recorded healthy,
  and the failure return the case asserts never came. The cure was fixture
  shape, not budget: that case sets `min_uptime_seconds = 20` and now passes
  at three times the load that broke it (H-1419). The healthy path can also
  lose the race to an agent: bosun closed H-2152 from the answer before the
  supervisor's min-uptime check, and Helmo refuses every write to a terminal
  ticket, so completion retried and failed every poll for as long as the
  supervisor ran. `completeAnsweredResume` now reads the status first and stands down
  on a closed escalation (H-2164). So when a case is red only
  under load, ask first whether it is waiting on something slow or racing
  something fast. A timeout raised on a race only buys a longer red.
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
  127.0.0.1, `REV_VIEW_HOST` to change; `REV_HELMO_VIEW_URL` overrides only
  the standalone Helm link while preserving the composed-estate reach) — restart after rebuild. It has no
  authentication: widening the host serves every loop's home path, spend and
  event trace to anyone who reaches the port.
- Delete an installation: `node dist/cli.js install remove` prints exactly what
  would go and removes nothing; `--confirm` does it. There is no undo and no
  other command brings it back. To remove only the service and keep every
  record, that is still `service uninstall`.
- What a seat's session is made of, as JSON, without running one:
  `node dist/cli.js session-spec <seat> --session <actor stamp> [--provider
  claude] [--tier high] [--model M] [--cwd P] [--constitution P] [--version V]`.
  Reads state, writes none. `--session` is required (see `shim.ts` above), and
  a tier resolves through the roster's providers table — a meeting can ask for
  `claude:high` while the seat's loop runs codex/frontier. A seat with no
  roster loop is composable by supplying `--cwd` and `--constitution`, the two
  facts rev has no business knowing; the spec then says `in_roster: false`.

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

## What built `dist`, and what is RUNNING it (H-2442, H-2489)

### The artifact (H-2442, R-39 Q8)

`dist/` is gitignored and `rev redeploy` restarts the fleet WITHOUT building,
so the supervisor has always loaded an artifact with no provenance. On
2026-09-30 `dist/cli.js` was built 2026-09-29 19:46 while the supervisor
running it had started 2026-09-27 18:01 — the fleet was executing code that
no longer existed on disk, and the iteration prompt every loop runs is
compiled from `src/loop.ts`.

`npm run build` now stamps `dist/BUILD.json` through a `postbuild` hook, so
there is no second step to forget. The stamp travels WITH the artifact rather
than living in a central log directory: two installs of rev on one machine
(the personal supervisor and `~/.rev-gp`'s) build into different checkouts,
and a file keyed by repo basename could only ever describe one of them
(H-2435, H-2436). `node scripts/stamp-build.mjs --check` fails when the stamp
is missing or older than the code beside it, and never counts itself as
evidence of its own freshness.

A dirty tree is RECORDED, not refused — `tsc` compiles the working tree, so
the sha would not certify the artifact, and a refusal only produces builds
with no record at all. crew's `tools/estate/builds.mjs --check` reads this
stamp and reports `dirty` as a failure there.

Because building and restarting are separate acts here, a build alone does not
change what the fleet runs: the supervisor keeps executing what it read at
spawn until `rev redeploy`.

### The running process (H-2489)

Which is why the stamp can never be the answer to "what is the fleet running".
The two come apart at every rebuild, and reading the stamp beside the code was
going to report the NEW commit as the running one — the single answer that is
certainly wrong. So `src/build.ts` reports them as two different questions, and
`status`, `service status`, `/health.json` and the dashboard print both:

- `build:` the artifact in the directory the reading process ran from, now.
- `running:` what the live process recorded when IT loaded, or `STALE` /
  `UNVERIFIABLE`. It never falls back to the artifact's sha: on divergence that
  sha appears only as the thing nobody is executing.

**The record rides in the `RUNNING` marker.** A long-lived process writes that
marker at startup and clears it on exit, which is exactly the lifetime of the
bytes it loaded — so `runningStamp()` adds `loaded <digest> <dir>` and
`build <commit> clean|dirty <built_at>`, and no new file gets a new lifecycle to
get wrong. A marker from before this simply lacks the lines, and a reader calls
that UNVERIFIABLE rather than guessing: a supervisor started before the change
reports UNVERIFIABLE until its next `rev redeploy`.

**What is compared is bytes, not the sha** — `digestOf()` over the `.js` in the
directory, because a dirty tree's sha did not produce the artifact and two
rebuilds of one commit differ. `.d.ts` files and `BUILD.json` are excluded:
they move on a rebuild without changing a byte any process executes, so
counting them would report divergence where there is none.

`loaded()` holds ONE reading, taken at startup, and `view.ts` calls it before
it serves. A process that asked later would read whatever replaced its code and
call that running — which is the whole defect, restated.

Limit, stated plainly: the digest is the bytes on disk when the snapshot was
taken, which for a statically imported ESM graph is load time. It does not
follow a module imported dynamically much later.

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
- **Never assert on the iteration prompt through rev's stdout** (H-2496). The
  console prints `res.outputTail.slice(-2000)` — a bounded tail, by design, on
  top of the shim's own 4000-char cap. The prompt is one long line, so as it
  grows its head falls out of that window, and an assertion reading stdout
  fails for a reason that has nothing to do with the prompt. The `not.toContain`
  direction is worse: it passes because the text was truncated away, not
  because the prompt lacks it — a mutation putting "what done means" at the
  head of the prompt left the old steering test green. Mocks in
  `test/loop.e2e.test.ts` write `$REV_PROMPT` to `$REV_HOME/prompt.txt`
  (`CAPTURE_PROMPT`) and assertions read `promptOf(e)`.
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
- **A ceiling in dollars only bounds work that is billed in dollars** (H-185).
  `[providers.<name>] billing` says what an account IS — `metered`
  (pay-per-token) or `subscription` (flat plan). It defaults to `metered`
  everywhere, including the builtin claude and codex entries, so an estate that
  declares nothing keeps every gate above exactly as it is. Where an estate
  declares a flat plan, the token-log's dollars for it are notional — codex's
  come from roster prices × tokens and claude's from the CLI's API-equivalent
  estimate — and notional dollars must never stop productive work; the plan
  bars are what bounds it. The burn caps stay in the roster as the recorded
  ceilings they are, and a pay-per-token provider gets them back by saying so.
  The anomaly thresholds beside it (`anomaly_rate_multiple` 6,
  `anomaly_min_usd` 1.00, `anomaly_abs_percent` 10) are calibrated against 597
  rolling windows of a real token-log, not chosen: see the comments in
  `capacity.ts` for why the rate axis is cost rather than tokens (the two
  largest token ratios in that record cost *less* than their own means — they
  are cache reads) and why the multiple needs an absolute floor beneath it
  (6× a $0.12 mean is 72 cents, which is not a runaway). The baseline is scoped
  to the runtime under judgment (H-585): the notional dollars of two runtimes
  are not the same scale — this bullet already says why, since codex's come from
  roster prices × tokens and claude's from the CLI's API-equivalent estimate —
  and the gap as billed here is ~100x per token. Unscoped, tester's first claude
  iteration after a day of codex scored 17.9x against a codex-only mean and
  halted a productive loop. A runtime with no history has no dollar baseline,
  exactly as a brand-new loop does, and the absolute plan-points rule is the
  guard in that window.
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
- Wake is MOTION for store-wide loops and READINESS for scoped ones (H-426
  and H-92, rewritten by H-1072). A scoped loop wakes when Helmo's wake-check
  reports `newly_ready_count > 0` — currently-ready tickets carrying a
  readiness-causing event after the idle cursor — and no longer on
  `changed_since`, which fired on any event in scope and therefore on pure
  noise. That noise is what made the idle floor necessary, and the floor is
  what cost real work: ward idled 02:57Z, H-1053 was handed back to it 03:20Z,
  and it woke 03:58Z on the timer. Three rules sit alongside the edge. The
  restart pickup stands (first successful poll after process start counts
  standing ready work, so a seat that went down with work queued does not wait
  for unrelated motion, H-995). An hourly resync wakes a seat that has been
  idle an hour with ready work in reach — a backstop for a readiness edge Rev
  never saw, never a debounce: the immediate path does not consult it, so it
  cannot delay a handoff. And an absent `newly_ready_count` falls back to the
  old rule, so a Rev running against an older Helmo degrades to the previous
  behaviour instead of wedging a seat.
  THE OLD OBJECTION, and why it no longer holds: readiness was rejected here
  because ready_count is a standing property, so a ticket a seat silently
  declined would re-wake it every poll, forever. Two things changed. H-1071
  makes every pass-over a recorded disposition, which takes the ticket out of
  ready; and "newly ready SINCE THE CURSOR" means an untouched ticket cannot
  wake a seat a second time even where H-1071 is not yet perfectly obeyed.
  Neither half would be enough on its own.
  A store-wide loop keeps `changed_since` exactly as it was — fresh filings
  are bosun's work — and its wake-check must additionally carry NO scope at
  all, assignee included. Helm ORs the scope clauses, so any one of them
  narrows the whole store back down to tickets already assigned and silences
  the fresh-filing signal these loops exist for. Cost us bosun's entire wake
  path until H-138.

## Neighbors

Helmo is the work record and must be built separately; runtime rosters point at
its `dist/cli.js` and `dist/server.js`. Integration tests run the source checkout
named by `REV_TEST_HELMO` (falling back to sibling `../helmo`) through dedicated
CLI and server shims, so an immutable Rev candidate needs neither shared build —
every reference through `test/helmo.ts`, never a written-out `../../helmo`
path, which resolves only where the two checkouts are adjacent. That
prerequisite is declared to the release gate as `publish.cold.requires_env` in
package.json, so its scratch clone is given the variable instead of failing at
collection; see crew's PUBLISHING.md, "Works cold" (H-1400). Loop
identities and constitutions live outside this repository and are referenced by
the instance roster. Meetings (`~/projects/meetings`, R-31) is a consumer, not a
dependency: it shells out to `session-spec` to run a seat's session under a
human's typing instead of the queue, so a change to what a loop session carries
changes what a meeting carries too — which is the point. In a larger estate, its
own project map owns the remaining cross-project context.
# Prime team control

`gp-rev team stop|resume <loop|all>` is the Good Plumb leadership surface. It
is admitted only for `REV_LOOP=prime`; its STOP records carry Prime provenance,
and resume clears only those records while preserving every HOLD and BLOCKED
marker. Test it only against disposable `REV_HOME` state until the GP release
hold is independently cleared.
