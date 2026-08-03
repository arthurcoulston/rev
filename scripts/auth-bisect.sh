#!/bin/bash
# auth-bisect.sh — pin down why a Capstan-spawned claude session reads as
# logged out. Run from YOUR terminal. Four cases, cheapest-first; each prints
# PASS/FAIL. Total cost: a few cents if auth works, nothing if it doesn't.
#
# Case 1 failing means the CLI itself is logged out (its keychain credential
# is separate from the desktop app's) — fix is `claude /login` once, then
# re-run this script and scripts/real-smoke.sh. Cases 2-4 isolate Capstan's
# spawn specifics (node spawnSync, env scrub, stdio) only if case 1 passes.
set -uo pipefail

CAPSTAN="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT='reply with exactly: ok'

check() { # name, output
  if echo "$2" | grep -q '"is_error":false'; then
    echo "  $1: PASS"
  else
    echo "  $1: FAIL — $(echo "$2" | head -c 200)"
  fi
}

echo "1) plain claude -p from this terminal:"
OUT=$(claude -p "$PROMPT" --output-format json 2>&1)
check "plain" "$OUT"
if ! echo "$OUT" | grep -q '"is_error":false'; then
  echo
  echo "VERDICT: the claude CLI itself is not logged in — Capstan is not the problem."
  echo "Fix: run \`claude\` interactively, /login, then re-run this script."
  exit 1
fi

echo "2) spawned from node (inherited env, piped stdio) — Capstan-style minus scrub:"
check "node-inherit" "$(node -e '
const {spawnSync}=require("child_process");
const r=spawnSync("claude",["-p",process.argv[1],"--output-format","json"],{encoding:"utf8"});
process.stdout.write(r.stdout||r.stderr||("rc="+r.status));' "$PROMPT" 2>&1)"

echo "3) spawned from node with Capstan cleanEnv:"
check "node-clean" "$(node -e '
const {spawnSync}=require("child_process");
import(process.argv[2]+"/dist/shim.js").then(({cleanEnv})=>{
  const r=spawnSync("claude",["-p",process.argv[1],"--output-format","json"],{encoding:"utf8",env:cleanEnv()});
  process.stdout.write(r.stdout||r.stderr||("rc="+r.status));
});' "$PROMPT" "$CAPSTAN" 2>&1)"

echo "4) cleanEnv + stdin ignored (the shipped Capstan posture):"
check "node-clean-noin" "$(node -e '
const {spawnSync}=require("child_process");
import(process.argv[2]+"/dist/shim.js").then(({cleanEnv})=>{
  const r=spawnSync("claude",["-p",process.argv[1],"--output-format","json"],{encoding:"utf8",env:cleanEnv(),stdio:["ignore","pipe","pipe"]});
  process.stdout.write(r.stdout||r.stderr||("rc="+r.status));
});' "$PROMPT" "$CAPSTAN" 2>&1)"

echo
echo "Read: first FAIL row after a PASS names the ingredient that breaks auth."
echo "If all four PASS, re-run scripts/real-smoke.sh — the original failure was environmental."
