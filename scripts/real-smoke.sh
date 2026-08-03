#!/bin/bash
# real-smoke.sh — one-command real-runtime verification. Run from YOUR terminal
# (a spawned claude session reads its credential from the keychain, which is
# typically only granted to your terminal app — an agent-run shell may not
# have access; the mock e2e suite covers everything else without credentials).
#
# Creates an isolated CAPSTAN_HOME and Helm DB in a temp dir, seeds one
# synthetic ticket, runs ONE real agent iteration, and reports pass/fail.
# Touches nothing outside the temp dir. Usage:
#   scripts/real-smoke.sh /path/to/helm [model]
set -euo pipefail

HELM="${1:?usage: real-smoke.sh /path/to/helm [model]}"
MODEL="${2:-claude-sonnet-5}"
CAPSTAN="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$(mktemp -d -t capstan-real-smoke)"
DB="$HOME_DIR/helm.db"

[ -f "$HELM/dist/cli.js" ] || { echo "No built helm at $HELM (run npm run build there)"; exit 1; }
[ -f "$CAPSTAN/dist/cli.js" ] || { echo "Capstan not built (run npm run build)"; exit 1; }

mkdir -p "$HOME_DIR/constitutions" "$HOME_DIR/work"
cat > "$HOME_DIR/roster.toml" <<EOF
[global]
helm_cli = "$HELM/dist/cli.js"
helm_mcp_server = "$HELM/dist/server.js"
helm_db = "$DB"
poll_seconds = 5

[loops.smoke-worker]
workstream = "capstan-test"
cwd = "$HOME_DIR/work"
runtime = "claude"
model = "$MODEL"
constitution = "constitutions/smoke-worker.md"
EOF

cat > "$HOME_DIR/constitutions/smoke-worker.md" <<'EOF'
You are smoke-worker, a test agent verifying the Capstan loop harness. You have Helm MCP tools (helm_*). Each iteration: list ready work in your workstream, claim ONE ticket, do exactly what its body says, mark it done with evidence, and end the session. Be brief; this is a plumbing test.
EOF

HELM_DB="$DB" HELM_ACTOR='{"name":"seeder","kind":"agent","model":"smoke","version":"0"}' \
  node "$HELM/dist/cli.js" create --title "Smoke: write the proof file" \
  --body "Create a file named proof.txt in your working directory containing exactly the line: capstan turns. Then mark this ticket done with a file evidence link to it." \
  --workstream capstan-test --type ops > /dev/null

echo "Running one real iteration ($MODEL)..."
CAPSTAN_HOME="$HOME_DIR" node "$CAPSTAN/dist/cli.js" run smoke-worker --count 1

echo
STATUS=$(HELM_DB="$DB" node "$HELM/dist/cli.js" get H-1 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.status+' evidence='+(j.evidence?.length??0))})" 2>/dev/null || echo "unreadable")
PROOF="missing"
[ -f "$HOME_DIR/work/proof.txt" ] && grep -q "capstan turns" "$HOME_DIR/work/proof.txt" && PROOF="present"

echo "ticket: $STATUS | proof file: $PROOF | temp home: $HOME_DIR"
if [[ "$STATUS" == done* && "$PROOF" == present ]]; then
  echo "REAL-SMOKE PASS — the full circle works: wake -> claude session -> Helm ticket -> evidence."
else
  echo "REAL-SMOKE FAIL — inspect $HOME_DIR/state/smoke-worker/events.log"
  exit 1
fi
