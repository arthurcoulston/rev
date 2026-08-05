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
  before planning, and a steering fetch failure never stops the loop. After
  each iteration it writes the session's metered spend back to the
  most-touched ticket via helm-cli `record-spend` (H-19) — as the rev
  actor, since Rev is the meter, not the spender — net of anything the agent
  self-reported in the window (`actor-spend`, H-57): a session lands in the
  totals exactly once, and a negative delta is reconciliation, not refund.
- `shim.ts` — the runtime adapter (claude / codex / mock). Owns non-interactive
  flags, constitution injection (fail-closed), `cleanEnv()` (strips parent
  CLAUDE/ANTHROPIC env — the auth-leak fix; don't weaken it), per-session token
  metering, transient-API detection, and `--strict-mcp-config` (sessions see
  ONLY Helmo + the loop's `mcp_extra`).
- `ladder.ts` — pure decision functions for the failure ladder (transient ≠
  failure ≠ apparatus). Unit-tested; change with tests.
- `sentinels.ts` / `config.ts` — sentinel files + roster loading. Instance data
  lives in `~/.rev/` (roster.toml, mcp/, state/<loop>/, token-log), NEVER
  in this repo — publishability is structural.
- `view.ts` — read-only machine dashboard at :4500. `cli.ts` — run / status /
  stop / resume / pace / tail.

## Commands

- `npm run build`, `npm test` (ladder units + e2e with mock runtime).
- Drive a loop: `node dist/cli.js run <loop> [--count N]` (foreground; detach
  deliberately). `--count 1` is the assess-early lever.
- Dashboard: `node dist/view.js` (`REV_VIEW_PORT`, default 4500; binds
  127.0.0.1, `REV_VIEW_HOST` to change) — restart after rebuild.

## Invariants that bite

- Roster `version` is constitution provenance — bump it when a loop's profile
  changes.
- v0 loops die on reboot and must be restarted by hand (launchd is v1 — H-18).
- Escalations must land as Helmo tickets, never only in logs; a BLOCKED loop
  that couldn't escalate prints loudly and relies on the dashboard.

## Neighbors

Helmo is the work record (`~/projects/helmo`, must be built — roster points at
its dist/). Loop identities/constitutions live in `~/projects/crew`.
Map: `~/projects/crew/FLEET.md`.
