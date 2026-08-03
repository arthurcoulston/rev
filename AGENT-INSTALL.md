# Installing Capstan (agent-led)

You are an agent installing Capstan for a human. Run it end to end, verify each step, and
finish with the report-back template at the bottom. Capstan requires a working Helm install
(the work record it draws from) — if Helm is not installed, do that first via Helm's own
AGENT-INSTALL.md, then return here.

## Steps

### 1. Prerequisites

- Node.js >= 20, git.
- A built Helm checkout: confirm `<helm-path>/dist/cli.js` and `<helm-path>/dist/server.js`
  exist (build with `npm run build` in the Helm checkout if not).

### 2. Get and build

```bash
git clone <capstan-repo-url> ~/tools/capstan   # or use an existing local checkout
cd ~/tools/capstan
npm install && npm run build && npm test
```

All tests must pass (the e2e suite exercises a mock loop against a temp Helm store). If they
fail, report the failure and stop.

### 3. Create the instance home

```bash
mkdir -p ~/.capstan/constitutions
cp examples/roster.toml ~/.capstan/roster.toml
```

Edit `~/.capstan/roster.toml`: set `helm_cli` and `helm_mcp_server` to the Helm checkout's
built paths. Do not define worker loops yet unless the human has already authored a
constitution — a loop without a deliberate constitution is a worker without a character.

### 4. Verify with the mock loop

Add (or uncomment) the mock smoke loop in the roster, then:

```bash
node <helm-path>/dist/cli.js create --title "Capstan install check" \
  --body "synthetic ticket for install verification" --workstream capstan-test --type ops \
  # needs HELM_ACTOR env — see Helm's install doc
npx capstan run smoke --count 1
npx capstan status
```

Expect the iteration to run and `status` to show the loop `IDLE` or `halted`. Remove the
smoke loop from the roster afterwards if the human doesn't want it kept.

### 5. Start the dashboard

```bash
cd ~/tools/capstan && nohup npm run view > /tmp/capstan-view.log 2>&1 &
```

Read-only at `http://localhost:4500` (`CAPSTAN_VIEW_PORT` to change). Verify it responds.

### 6. Report back to the human

> Capstan is installed and verified.
>
> - **Dashboard** (read-only): http://localhost:4500 — every loop's state, pace, spend, and
>   recent trace. Work itself lives in Helm: http://localhost:4400.
> - **Run a loop**: `capstan run <name>` (foreground, v0). Control: `capstan stop|resume|pace`.
> - **When a loop needs you**, it files a ticket into Helm's awaiting-you queue — your normal
>   meeting surfaces it. No log-watching required.
> - **To inspect the machine conversationally**: say "summon the watch officer" in any agent
>   session and have it load `<capstan-path>/WATCH-OFFICER.md`.
> - **Next step**: define a worker loop — its constitution (identity, judgment, escalation
>   rules) is deliberate design work; write it with your agent, then add the roster entry.

### 5b. Real-runtime smoke (needs the human's terminal)

The mock e2e suite proves everything except live agent-CLI auth, which is usually
keychain-guarded and granted only to the human's terminal app — an agent-run shell will read
as logged-out even though the harness is fine. Ask the human to run, in their own terminal:

```bash
cd <capstan-path> && chmod +x scripts/real-smoke.sh && scripts/real-smoke.sh <helm-path>
```

One isolated iteration; prints `REAL-SMOKE PASS` on success. Include this ask in your report.

## Notes for maintainers

- Instance data (roster, constitutions, state) lives in `~/.capstan/` — nothing
  operator-specific ever enters this repo.
- The roster's `helm_cli`/`helm_mcp_server` point at built files: after updating Helm, rebuild
  it or loops get the stale server.
