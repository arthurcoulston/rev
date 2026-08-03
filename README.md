# Capstan

**Capstan keeps agent loops turning.** Process supervision for autonomous AI agent loops that
draw their work from a [Helm](../helm) work record. Helm is where the human steers; Capstan is
the engine room — it decides when agents run, keeps them alive, classifies their failures,
meters their spend, and files a ticket into Helm's awaiting-human queue when the machine needs
a decision.

- Product & architecture: [capstan-product-description.md](capstan-product-description.md)
- Agent-led install (the primary path): [AGENT-INSTALL.md](AGENT-INSTALL.md)
- Ops role for humans-with-agents: [WATCH-OFFICER.md](WATCH-OFFICER.md) — "summon the watch officer"

## Status

v0: one supervised loop, end-to-end tested (mock runtime + real store). The multi-loop
supervisor is the next milestone.

## The shape of it

```
~/.capstan/                 your instance (never in this repo)
  roster.toml               loops as data — see examples/roster.toml
  constitutions/            each loop's instruction file
  state/<loop>/             sentinels + event trace (the machine's true state)
  token-log                 spend meter

capstan run <loop>          drive one loop: idle on Helm's event cursor (zero tokens),
                            wake on ready work, spawn one fresh agent session per iteration
capstan status              every loop at a glance
capstan stop|resume|pace    control verbs (sentinel writes)
npm run view                read-only dashboard at :4500
```

Failure ladder (inherited from a battle-tested prototype): transient API/network conditions
park and retry — never treated as faults; runtime failures retry under a small consecutive cap;
apparatus faults (missing constitution) fail closed immediately; anything that halts a loop
arrives in Helm as a well-formed question, not a silent stall.

## Development

```
npm install && npm run build
npm test        # ladder units + full e2e against a temp Helm store, mock runtime
```

Requires a built Helm checkout (`helm_cli` / `helm_mcp_server` in the roster point at it).
