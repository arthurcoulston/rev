# Installing Rev (agent-led)

You are an agent installing Rev for a human. Run it end to end, verify each step, and
finish with the report-back template at the bottom. Rev requires a working Helmo install
(the work record it draws from) — if Helmo is not installed, do that first via Helmo's own
AGENT-INSTALL.md, then return here.

## Steps

### 1. Prerequisites

- Node.js >= 20, git.
- A built Helmo checkout: confirm `<helmo-path>/dist/cli.js` and `<helmo-path>/dist/server.js`
  exist (build with `npm run build` in the Helmo checkout if not).

### 2. Get and build

```bash
git clone <rev-repo-url> ~/tools/rev   # or use an existing local checkout
cd ~/tools/rev
npm install && npm run build && npm test
```

All tests must pass (the e2e suite exercises a mock loop against a temp Helmo store). If they
fail, report the failure and stop.

### 3. Create the instance home

```bash
mkdir -p ~/.rev/constitutions
cp examples/roster.toml ~/.rev/roster.toml
```

Edit `~/.rev/roster.toml`: set `helmo_cli` and `helmo_mcp_server` to the Helmo checkout's
built paths. Do not define worker loops yet unless the human has already authored a
constitution — a loop without a deliberate constitution is a worker without a character.

### 4. Verify with the mock loop

Add (or uncomment) the mock smoke loop in the roster, then:

```bash
node <helmo-path>/dist/cli.js create --title "Rev install check" \
  --body "synthetic ticket for install verification" --workstream rev-test --type ops \
  # needs HELMO_ACTOR env — see Helmo's install doc
npx rev run smoke --count 1
npx rev status
```

Expect the iteration to run and `status` to show the loop `IDLE` or `halted`. Remove the
smoke loop from the roster afterwards if the human doesn't want it kept.

### 5. Start the dashboard

```bash
cd ~/tools/rev && nohup npm run view > /tmp/rev-view.log 2>&1 &
```

Read-only at `http://localhost:4500`, bound to 127.0.0.1 (`REV_VIEW_PORT` / `REV_VIEW_HOST` to change). Verify it responds.

### 6. Report back to the human

> Rev is installed and verified.
>
> - **Dashboard** (read-only): http://localhost:4500 — every loop's state, pace, spend, and
>   recent trace. Work itself lives in Helmo: http://localhost:4400.
> - **Run a loop**: `rev run <name>` (foreground, v0). Control: `rev stop|resume|pace`.
> - **When a loop needs you**, it files a ticket into Helmo's awaiting-you queue — your normal
>   meeting surfaces it. No log-watching required.
> - **To inspect the machine conversationally**: say "summon the watch officer" in any agent
>   session and have it load `<rev-path>/WATCH-OFFICER.md`.
> - **Next step**: define a worker loop — its constitution (identity, judgment, escalation
>   rules) is deliberate design work; write it with your agent, then add the roster entry.

### 5b. Real-runtime smoke (needs the human's terminal)

The mock e2e suite proves everything except live agent-CLI auth, which is usually
keychain-guarded and granted only to the human's terminal app — an agent-run shell will read
as logged-out even though the harness is fine. Ask the human to run, in their own terminal:

```bash
cd <rev-path> && chmod +x scripts/real-smoke.sh && scripts/real-smoke.sh <helmo-path>
```

One isolated iteration; prints `REAL-SMOKE PASS` on success. Include this ask in your report.

## Notes for maintainers

- Instance data (roster, constitutions, state) lives in `~/.rev/` — nothing
  operator-specific ever enters this repo.
- The roster's `helmo_cli`/`helmo_mcp_server` point at built files: after updating Helmo, rebuild
  it or loops get the stale server.
