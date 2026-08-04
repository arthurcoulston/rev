# AGENTS — session routing for capstan

Canonical apparatus file (vendor-neutral). `CLAUDE.md` is a shim pointing here.
The context envelope is a design decision: what a session does NOT load is part
of its role.

## What kind of session is this?

- **Summoned role** — "summon the watch officer" or any request to inspect or
  control the running machine: read `WATCH-OFFICER.md` **whole, to its last
  line**, and reproduce its canary line before acting. Read nothing else here —
  the watch officer operates sentinels and reads state; it does not need the
  TypeScript.
- **Coding / dev session** — working on Capstan itself: read `DEV.md`, then go.
- **Loop sessions** never start here — Capstan launches them in their own
  loop's cwd with their constitution injected; if that's you, your constitution
  already governs.

## Universal expectations

- Work is tracked in Helm: claim before working, note progress when reality
  changes, close with evidence.
- Cross-project context (dev sessions only): `~/projects/crew/FLEET.md`.
- Projects the enclosing instructions mark as **sovereign** — no
  writes, ever. Guard denials are the boundary working; never route around.
