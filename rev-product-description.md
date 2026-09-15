# Rev — Product Description

Open source, self-hosted, runtime-neutral. **Rev keeps agent loops turning.**

Rev is process supervision for autonomous AI agent loops that draw their work from a
[Helm](https://github.com/TBD/helm) work record. Helm is where the human steers — the record of
what needs doing, what happened, and what awaits a decision. Rev is the engine room: it decides
*when agents run*, keeps them alive, classifies their failures, meters their spend, and escalates to
the record when the machine needs a human. Rev never reads ticket content; Helm never manages a
process. The two meet only at Helm's public interface.

A rev is the shipboard winch that does heavy work through continuous rotation. That is the whole
product: dumb, reliable rotation — made trustworthy.

## Premise

The simplest agent loop — `while true; do agent -p "$(cat prompt.md)"; done` — works, and that fact
(the "Ralph" pattern) is the foundation everything here builds on. But an unsupervised while-loop
fails in production in known, recurring ways: it spins against a dead API, wedges silently on a
credential prompt, crashes and stays down, burns budget on empty iterations, duplicates work, and
tells no one. A battle-tested private prototype (~1,600 lines of supervision grown over months of
incidents) established what the loop actually needs; Rev is that experience rebuilt as a
generic, publishable tool with a work record — rather than git — as its coordination bus.

Design stance, inherited from the prototype and from published harness practice:

- **The harness owns process; the agent owns judgment.** Rev provisions, schedules, supervises,
  and accounts. Which ticket to take, how to do the work, when to ask a human — that lives in the
  agent and its constitution, and in the work record's own rules.
- **Event-driven, never cron.** Loops idle until the work record changes under their scope. An
  empty-queue check costs zero tokens; an agent is only ever spawned toward real work.
- **Failures have classes, and each class has an owner.** A transient API limit is not a crash; a
  crash is not an operator emergency until retries are exhausted. Misclassifying these wastes money
  at best (respawning into a dead API) and silences the fleet at worst.
- **Agents are drained, not killed.** Graceful stop lets in-flight iterations finish their close-out.
  The hard kill exists and is reserved for emergencies.

## The loop — Rev's unit

A **loop** is one supervised worker: an identity that repeatedly wakes, runs a fresh agent session
against ready work, and exits. Its full definition is instance data (the **roster**), not code:

| Field | Meaning |
|---|---|
| `name` | The loop's stable identity — also its Helm actor name. |
| `workstreams` | Which Helm workstream(s) it draws work from. |
| `cwd` | The project directory sessions run in (any folder on the machine — loops work across many projects). |
| `runtime` / `model` | Which agent CLI and model (the runtime shim binds them per loop). |
| `constitution` | Path to the loop's instruction file — identity, role, judgment rules, Helm usage. |
| `mcp` | The MCP servers this loop's sessions get (Helm plus whatever the work needs). Explicit allowlist; sessions are otherwise MCP-clean. |
| `pace` | Durable velocity tier (fraction of full speed). Live overridable. |
| `git` | Optional: worktree/branch mode for loops whose work product is commits. Off for non-code work. |

Sessions are stateless by design — every iteration is a fresh context. Continuity lives in the work
record (tickets carry resumption context) and in the project folder's own files. This is the
published-practice model: durable structured artifacts between sessions, one unit of work per
session.

## Instance data lives outside the repo

The Rev repo contains generic code and example configs only. Everything operator-specific — the
roster, constitutions, MCP allowlists, runtime state (sentinels, logs, meters) — lives in
`~/.rev/` (configurable). Publishability is structural: there is no personal context to scrub
because none can enter the repo. The prototype kept its instance layer in-repo behind discipline;
Rev moves the boundary into the filesystem.

```
~/.rev/
  roster.toml            # the loops, as data — add a loop, no code change
  constitutions/         # per-loop instruction files
  state/<loop>/          # sentinels, events.log, console.log — machine-local, gitignored by nature
  token-log              # spend meter, one line per session
```

## The wake model

Helm's append-only event log has a global sequence number; that cursor is Rev's coordination
bus. An idle loop remembers the seq at which it went idle and polls a cheap read-only query:
*any new ready ticket in my scope, or new event on work I hold, since seq N?* No tokens, no agent,
no git. On wake, Rev spawns one session; the agent selects work through Helm's own tools.

This replaces the prototype's git-as-bus machinery (wake paths over origin/main, mandatory
worktrees, push races, stranded-commit checks) for every loop that isn't producing commits — and
demotes git to an optional per-loop mode for those that are.

## Loop states and the failure ladder

Ported nearly verbatim from the prototype — its most valuable, most incident-tested asset. Each
state is a sentinel with a defined owner and escalation path:

| State | Owner | Meaning |
|---|---|---|
| `RUNNING` | rev | Iteration in flight (PID + start time). |
| `IDLE` | rev | Alive, waiting on the wake cursor. |
| `PACE` / `PARKED` | operator/agent → loop | Velocity command vs. the loop's acknowledgment (command ≠ state). |
| `STOP` | operator | Clean halt between iterations. Never set by agents. |
| `HOLD` | agent/operator | Intended hold — deliberate, not an anomaly, survives restart. |
| `LIMIT` | rev | Parked on a transient external condition (API 429/529, network outage). Retries on a timer; never treated as a fault — *a rescuer launched into the same dead API dies with the patient.* |
| `BLOCKED` | rev → human | Failure cap exceeded or unrecoverable fault. Escalates (below). |

The ladder: transient conditions park and retry with a bounded streak; recoverable faults retry
with a consecutive-failure cap; apparatus faults (missing constitution, unresolvable runtime) fail
closed immediately. Network triage runs before classification — an unreachable origin makes
everything else moot. The prototype's autonomous self-heal tier (a leader agent that repairs failed
loops) is deliberately deferred: v0 escalates to the human faster instead, and the tier can return
once basic operation is boring.

**Escalation surfaces in the work record, not in a log file.** When a loop goes BLOCKED, Rev
files a ticket into Helm's awaiting-human queue — the operator's existing dashboard and meeting
absorb harness operations with no new ritual. (Requires Helm's programmatic write path; tracked
there.) A supervisor log line is a fact; a ticket is a summons.

## The watch officer — summonable ops role

Rev's interactive surface is a summonable context (the Helm orchestrator pattern): load
`WATCH-OFFICER.md` into any agent session and it can read the machine's true state — sentinels,
event traces, spend meter — explain it conversationally, and execute control verbs (pause, resume,
pace, clear) on the operator's spoken instruction. Every verb is a sentinel write, so the role is
safe by construction and needs no special privileges.

Boundary: **Helm meetings decide about work; the watch officer operates the machine.** Routine
anomalies arrive at meetings as tickets; the watch officer is summoned on demand for diagnosis and
control, not as a required ceremony.

## The dashboard

A read-only local web view (deliberately plain first, like Helm's): every loop's state, last
iteration and wake reason, failure streaks, pace, and spend — the at-a-glance answer to "is the
machine healthy," replacing terminal status tables. Where a row references work (a BLOCKED loop's
escalation ticket), it deep-links into Helm's dashboard. The two views stay separate products:
Helm shows the work; Rev shows the machine.

## The runtime shim

One small adapter per agent CLI (claude, codex, extensible by a case branch), owning: non-interactive
invocation with correct flags, constitution injection (fail-closed — a missing or truncated
instruction file blocks the loop rather than launching a half-instructed agent), per-session token
accounting, transient-API detection mapped to `LIMIT`, and config hygiene (sessions get exactly the
roster's MCP allowlist; no ambient user config). Loops select runtime and model per-loop from the
roster — different loops on different models is a one-line difference.

"Correct flags" includes the permission posture, and it is deliberate: every session runs with the
CLI's approval prompts and sandbox disabled (`--dangerously-skip-permissions` for claude,
`--dangerously-bypass-approvals-and-sandbox` for codex). An unattended loop cannot answer a prompt,
so a loop that asks is a loop that hangs; one permission story per fleet, whichever CLI runs the
iteration. What remains bounding a session is its constitution, its `cwd`, and its MCP surface —
so registering a loop is the consequential act, and the docs say so where an operator meets it.

## Implementation

TypeScript/Node, matching Helm: shared contributor stack, testable supervision logic (the
prototype's pure decision functions — respawn policy, velocity translation, failure classification —
become unit-tested modules), first-class JSON/TOML handling, and direct read-only SQLite access for
the zero-token wake query. Process control (detached process groups, signal cascades, graceful
drain) is owned by a small, carefully tested core. The v0 store integration is Helm-native;
the seam is one module so other work sources remain possible later without an abstraction tax now.

## Scope

**v0 — one loop, supervised.** Roster format designed for a fleet; implementation runs a single
loop end to end: wake on Helm cursor → spawn via shim → agent works tickets → park/halt per the
ladder → escalate to Helm on cap → dashboard row → watch officer can inspect and control it.
Acceptance: a real non-code loop runs unattended for days, and every anomaly it hits arrives as a
well-formed Helm ticket rather than a silent stall.

**v1 — the fleet.** The supervisor proper: many loops, respawn with backoff, graceful `stop-all`,
per-loop pace tiers, machine-restart resilience (launchd/systemd service).

**Later, earned by need:** autonomous self-heal tier; work-source adapters beyond Helm; multi-machine.

## Constraints

Self-hostable by others; agent-led install as the primary path (an agent can install, register a
loop, and hand back the dashboard link and summon instructions). No personal or instance context in
the repo — enforced by the `~/.rev/` boundary. Runtime-neutral: no agent CLI is privileged
beyond having a shim. macOS and Linux.

## Open questions

1. **Wake query coupling** — direct read-only SQLite against Helm's store file (fast, but couples to
   schema) vs. a `helm` CLI query (clean contract, tracked Helm-side). Lean: CLI, with direct-read as
   a fallback optimization.
2. **Rev's Helm actor identity** — loops write as themselves; when *Rev* files an escalation
   ticket, it writes as what? Proposed: `{name: "rev", kind: "agent"}` until Helm grows a
   dedicated actor kind for machinery.
3. **Iteration bounds** — the prototype caps iterations per launch (safety ceiling) and offers
   bounded runs for troubleshooting. Adopt as-is or simplify for v0?
4. **Roster format** — TOML proposed for human-editability; the prototype's pipe-delimited conf
   proved editable but unforgiving.

## Provenance

Rev generalizes a private prototype harness (2026) whose supervision model — sentinel state
machine, failure ladder, healer-trap lesson, graceful drain, roster-as-data — was developed over
months of continuous multi-loop operation, and whose orchestration philosophy (derive status from
committed artifacts, never narration) also shaped Helm's evidence model. Prior art: the Ralph
Wiggum loop (Huntley) for the primitive; Gas Town (Yegge) for the store-driven fleet pattern;
Anthropic's long-running-harness guidance for the session/artifact division of labor.
