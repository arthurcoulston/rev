# Rev

**Rev keeps agent loops turning.** Process supervision for autonomous AI agent loops that
draw their work from a [Helmo](https://github.com/arthurcoulston/helmo) work record. Helmo is where the human steers; Rev is
the engine room — it decides when agents run, keeps them alive, classifies their failures,
meters their spend, and files a ticket into Helmo's awaiting-human queue when the machine needs
a decision.

- Product & architecture: [rev-product-description.md](rev-product-description.md)
- Agent-led install (the primary path): [AGENT-INSTALL.md](AGENT-INSTALL.md)
- Ops role for humans-with-agents: [WATCH-OFFICER.md](WATCH-OFFICER.md) — "summon the watch officer"

## Status: MVP

The fleet capability is implemented and used in day-to-day operation: one supervisor runs every
roster loop, with respawn backoff, graceful stop-all (drain, never kill), per-loop pace, and reboot
resilience as a user service (launchd/systemd). The current package is `0.1.0` and the project is at
the MVP stage. Its automated floor includes build and integration tests, and independent review
still gates acceptance. Rev has not declared the additional 1.0 gates.

## The shape of it

```
~/.rev/                 your instance (never in this repo)
  roster.toml               loops as data — see examples/roster.toml
  constitutions/            each loop's instruction file
  state/<loop>/             sentinels + event trace (the machine's true state)
  state/supervisor/         the supervisor's own pid + decision trace
  token-log                 spend meter

rev run                 start the machine: every roster loop under the supervisor;
                            each loop idles on Helmo's event cursor (zero tokens), wakes on
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
arrives in Helmo as a well-formed question, not a silent stall.

The supervisor extends the ladder to processes: a crashed loop respawns on an exponential
backoff (`BACKOFF` sentinel); a deliberate halt (STOP/HOLD/BLOCKED) is never overridden —
the loop stays down until `rev resume`, and the running supervisor then picks it up within
one poll. Stopping the machine is a drain: SIGTERM defers past the in-flight session, so
agents always finish their close-out.

## Development

```bash
npm ci
npm run build
REV_TEST_HELMO=/absolute/path/to/helmo npm test
```

Rev deliberately depends on a built Helmo checkout for its integration tests and at runtime. The
test path is configurable with `REV_TEST_HELMO`; when omitted, the suite checks the historical
sibling location `../helmo` and fails with the missing path if it is unavailable. Runtime paths are
independent of the test setting and are always explicit as `helmo_cli` and `helmo_mcp_server` in
the instance roster.

See [AGENT-INSTALL.md](AGENT-INSTALL.md) for the full install and mock-loop verification. Security
issues should follow [SECURITY.md](SECURITY.md). Rev is available under the [MIT License](LICENSE).
