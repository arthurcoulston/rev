# DEV — coding context for capstan

Capstan keeps agent loops turning: process supervision for autonomous loops
that draw work from Helm. Capstan never reads ticket content; Helm never
manages a process. Product doc: `capstan-product-description.md`.

## Architecture (src/)

- `loop.ts` — the single-loop driver: wake on Helm's event cursor (zero tokens
  while idle), spawn one fresh session per iteration, classify the outcome,
  idle or halt. The iteration prompt ("work ONE ticket to a natural stopping
  point") lives here.
- `shim.ts` — the runtime adapter (claude / codex / mock). Owns non-interactive
  flags, constitution injection (fail-closed), `cleanEnv()` (strips parent
  CLAUDE/ANTHROPIC env — the auth-leak fix; don't weaken it), per-session token
  metering, transient-API detection, and `--strict-mcp-config` (sessions see
  ONLY Helm + the loop's `mcp_extra`).
- `ladder.ts` — pure decision functions for the failure ladder (transient ≠
  failure ≠ apparatus). Unit-tested; change with tests.
- `sentinels.ts` / `config.ts` — sentinel files + roster loading. Instance data
  lives in `~/.capstan/` (roster.toml, mcp/, state/<loop>/, token-log), NEVER
  in this repo — publishability is structural.
- `view.ts` — read-only machine dashboard at :4500. `cli.ts` — run / status /
  stop / resume / pace / tail.

## Commands

- `npm run build`, `npm test` (ladder units + e2e with mock runtime).
- Drive a loop: `node dist/cli.js run <loop> [--count N]` (foreground; detach
  deliberately). `--count 1` is the assess-early lever.
- Dashboard: `node dist/view.js` (`CAPSTAN_VIEW_PORT`, default 4500) — restart
  after rebuild.

## Invariants that bite

- Roster `version` is constitution provenance — bump it when a loop's profile
  changes.
- v0 loops die on reboot and must be restarted by hand (launchd is v1 — H-18).
- Escalations must land as Helm tickets, never only in logs; a BLOCKED loop
  that couldn't escalate prints loudly and relies on the dashboard.

## Neighbors

Helm is the work record (`~/projects/helm`, must be built — roster points at
its dist/). Loop identities/constitutions live in `~/projects/crew`.
Map: `~/projects/crew/FLEET.md`.
