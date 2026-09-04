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
git clone <rev-repo-url> <rev-path>   # or use an existing local checkout anywhere
cd <rev-path>
npm ci
npm run build
REV_TEST_HELMO="<absolute-helmo-path>" npm test
```

All tests must pass. The e2e suite exercises a mock loop against a temporary Helmo store using the
built checkout named by `REV_TEST_HELMO`; the Rev and Helmo checkouts do not need to be adjacent.
If the tests fail, report the failure and stop.

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
HELMO_ACTOR='{"name":"<installer-name>","kind":"agent","model":"<model-id>","version":"<harness-version>"}' \
  node <helmo-path>/dist/cli.js create --title "Rev install check" \
  --body "synthetic ticket for install verification" --workstream rev-test --type ops
node <rev-path>/dist/cli.js run smoke --count 1
node <rev-path>/dist/cli.js status
```

Expect the iteration to run and `status` to show the loop `IDLE` or `halted`. Remove the
smoke loop from the roster afterwards if the human doesn't want it kept.

### 5. Start the dashboard

```bash
cd <rev-path> && nohup npm run view > /tmp/rev-view.log 2>&1 &
```

Read-only at `http://localhost:4500`, bound to 127.0.0.1 (`REV_VIEW_PORT` / `REV_VIEW_HOST` to change). Verify it responds.

### 6. Optional real-runtime smoke

The build and test suite use a mock runtime, so they do not spend agent tokens or require agent-CLI
credentials. When the operator wants a credentialed end-to-end check, run one isolated iteration:

```bash
cd <rev-path>
chmod +x scripts/real-smoke.sh
scripts/real-smoke.sh <helmo-path> [model] [runtime]
```

This invokes the selected agent CLI and may consume plan allowance or incur provider cost. If the
current shell cannot access that CLI's credentials, report that limit; do not treat it as a failed
mock install.

### 7. Report back to the human

> Rev is installed and verified.
>
> - **Dashboard** (read-only): http://localhost:4500 — every loop's state, pace, spend, and
>   recent trace. Work itself lives in Helmo: http://localhost:4400.
> - **Start the machine**: `node <rev-path>/dist/cli.js run` (every roster loop under the
>   supervisor). Stop it with `node <rev-path>/dist/cli.js stop` (graceful drain). Per-loop
>   control uses the same CLI with `stop|resume|pace <name>`.
> - **Survive reboots**: `rev service install` registers the supervisor as a user service
>   (launchd/systemd) — offer this, but install only on the human's say-so: it changes what
>   runs at login.
> - **When a loop needs you**, it files a ticket into Helmo's awaiting-you queue — your normal
>   meeting surfaces it. No log-watching required.
> - **To inspect the machine conversationally**: say "summon the watch officer" in any agent
>   session and have it load `<rev-path>/WATCH-OFFICER.md`.
> - **Next step**: define a worker loop — its constitution (identity, judgment, escalation
>   rules) is deliberate design work; write it with your agent, then add the roster entry.

## Notes for maintainers

- Instance data (roster, constitutions, state) lives in `~/.rev/` — nothing
  operator-specific ever enters this repo.
- The roster's `helmo_cli`/`helmo_mcp_server` point at built files: after updating Helmo, rebuild
  it or loops get the stale server.
