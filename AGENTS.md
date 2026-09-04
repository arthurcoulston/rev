# AGENTS — session routing for rev

Canonical apparatus file (vendor-neutral). `CLAUDE.md` is a shim pointing here.
The context envelope is a design decision: what a session does NOT load is part
of its role.

## What kind of session is this?

- **Summoned role** — "summon the watch officer" or any request to inspect or
  control the running machine: read `WATCH-OFFICER.md` **whole, to its last
  line**, and reproduce its canary line before acting. Read nothing else here —
  the watch officer operates sentinels and reads state; it does not need the
  TypeScript.
- **Coding / dev session** — working on Rev itself: read `DEV.md`, then go.
- **Loop sessions** never start here — Rev launches them in their own
  loop's cwd with their constitution injected; if that's you, your constitution
  already governs.

## Universal expectations

- Work is tracked in Helmo: claim before working, note progress when reality
  changes, close with evidence.
- Cross-project context (dev sessions only): load the host estate's project map
  when its enclosing instructions provide one.
- A project marked **sovereign** by its own or the enclosing instructions is
  read-only. Guard denials are the boundary working; never route around them.
