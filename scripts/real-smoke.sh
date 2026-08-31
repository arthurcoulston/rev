#!/bin/bash
# real-smoke.sh — one-command real-runtime verification. Run from YOUR terminal
# (a spawned claude session reads its credential from the keychain, which is
# typically only granted to your terminal app — an agent-run shell may not
# have access; the mock e2e suite covers everything else without credentials).
#
# Creates an isolated REV_HOME and Helm DB in a temp dir, seeds one
# synthetic ticket, runs ONE real agent iteration, and reports pass/fail.
# Touches nothing outside the temp dir. Usage:
#   scripts/real-smoke.sh /path/to/helm [model] [runtime]
set -euo pipefail

HELM="${1:?usage: real-smoke.sh /path/to/helm [model] [runtime]}"
MODEL="${2:-claude-sonnet-5}"
RUNTIME="${3:-claude}"
REV="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$(mktemp -d -t rev-real-smoke)"
DB="$HOME_DIR/helm.db"

[ -f "$HELM/dist/cli.js" ] || { echo "No built helm at $HELM (run npm run build there)"; exit 1; }
[ -f "$REV/dist/cli.js" ] || { echo "Rev not built (run npm run build)"; exit 1; }

mkdir -p "$HOME_DIR/constitutions" "$HOME_DIR/work"
cat > "$HOME_DIR/roster.toml" <<EOF
[global]
helmo_cli = "$HELM/dist/cli.js"
helmo_mcp_server = "$HELM/dist/server.js"
helmo_db = "$DB"
poll_seconds = 5

[loops.smoke-worker]
workstream = "rev-test"
cwd = "$HOME_DIR/work"
runtime = "$RUNTIME"
model = "$MODEL"
constitution = "constitutions/smoke-worker.md"
EOF

cat > "$HOME_DIR/constitutions/smoke-worker.md" <<'EOF'
You are smoke-worker, a test agent verifying the Rev loop harness. You have Helm MCP tools (helm_*). Each iteration: list ready work in your workstream, claim ONE ticket, do exactly what its body says, mark it done with evidence, and end the session. Be brief; this is a plumbing test.
EOF

HELMO_DB="$DB" HELMO_ACTOR='{"name":"seeder","kind":"agent","model":"smoke","version":"0"}' \
  node "$HELM/dist/cli.js" create --title "Smoke: write the proof file" \
  --body "Create a file named proof.txt in your working directory containing exactly the line: rev turns. Then mark this ticket done with a file evidence link to it." \
  --workstream rev-test --type ops > /dev/null

echo "Running one real iteration ($MODEL)..."
REV_HOME="$HOME_DIR" node "$REV/dist/cli.js" run smoke-worker --count 1

echo
STATUS=$(HELMO_DB="$DB" node "$HELM/dist/cli.js" get H-1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.status+' evidence='+(j.evidence?.length??0))})" 2>/dev/null || echo "unreadable")
PROOF="missing"
[ -f "$HOME_DIR/work/proof.txt" ] && grep -q "rev turns" "$HOME_DIR/work/proof.txt" && PROOF="present"

echo "ticket: $STATUS | proof file: $PROOF | temp home: $HOME_DIR"
if [[ "$STATUS" == done* && "$PROOF" == present ]]; then
  echo "REAL-SMOKE PASS — the full circle works: wake -> claude session -> Helm ticket -> evidence."
else
  echo "REAL-SMOKE FAIL — inspect $HOME_DIR/state/smoke-worker/events.log"
  exit 1
fi
