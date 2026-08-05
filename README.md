# Rev

**Rev keeps agent loops turning.** Process supervision for autonomous AI agent loops that
draw their work from a [Helm](../helm) work record. Helm is where the human steers; Rev is
the engine room — it decides when agents run, keeps them alive, classifies their failures,
meters their spend, and files a ticket into Helm's awaiting-human queue when the machine needs
a decision.

- Product & architecture: [rev-product-description.md](rev-product-description.md)
- Agent-led install (the primary path): [AGENT-INSTALL.md](AGENT-INSTALL.md)
- Ops role for humans-with-agents: [WATCH-OFFICER.md](WATCH-OFFICER.md) — "summon the watch officer"

## Status

v1: the fleet. One supervisor runs every roster loop — respawn with backoff, graceful
stop-all (drain, never kill), per-loop pace, and reboot resilience as a user service
(launchd/systemd). End-to-end tested (mock runtime + real store).

## The shape of it

```
~/.rev/                 your instance (never in this repo)
  roster.toml               loops as data — see examples/roster.toml
  constitutions/            each loop's instruction file
  state/<loop>/             sentinels + event trace (the machine's true state)
  state/supervisor/         the supervisor's own pid + decision trace
  token-log                 spend meter

rev run                 start the machine: every roster loop under the supervisor;
                            each loop idles on Helm's event cursor (zero tokens), wakes on
                            ready work, spawns one fresh agent session per iteration
rev run <loop>          drive one loop in the foreground (debugging; --count 1 = one iteration)
rev stop                graceful stop-all: in-flight iterations finish, then the machine stops
rev status              supervisor + every loop at a glance
rev stop|resume|pace <loop>  per-loop control verbs (sentinel writes)
rev service install     survive reboots: launchd (macOS) / systemd user unit (Linux)
npm run view                read-only dashboard at :4500
```

Failure ladder (inherited from a battle-tested prototype): transient API/network conditions
park and retry — never treated as faults; runtime failures retry under a small consecutive cap;
apparatus faults (missing constitution) fail closed immediately; anything that halts a loop
arrives in Helm as a well-formed question, not a silent stall.

The supervisor extends the ladder to processes: a crashed loop respawns on an exponential
backoff (`BACKOFF` sentinel); a deliberate halt (STOP/HOLD/BLOCKED) is never overridden —
the loop stays down until `rev resume`, and the running supervisor then picks it up within
one poll. Stopping the machine is a drain: SIGTERM defers past the in-flight session, so
agents always finish their close-out.

## Development

```
npm install && npm run build
npm test        # ladder units + full e2e against a temp Helm store, mock runtime
```

Requires a built Helm checkout (`helmo_cli` / `helmo_mcp_server` in the roster point at it).
