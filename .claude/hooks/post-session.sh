#!/bin/bash
# Post-session hook — triggers continuous learning pipeline after each session.
# Configured in settings.local.json as a "Stop" hook.
#
# Hook payload (stdin): JSON with session metadata
# Expected fields: sessionId, repoAlias, outcome

set -e

# Read JSON payload from stdin
PAYLOAD=$(cat)

SESSION_ID=$(echo "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || echo "")
REPO_ALIAS=$(echo "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('repo_alias',''))" 2>/dev/null || echo "")
OUTCOME=$(echo "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('outcome','unknown'))" 2>/dev/null || echo "unknown")

# Only run learning pipeline if we have session data
if [ -n "$SESSION_ID" ] && [ -n "$REPO_ALIAS" ]; then
  cd "$(dirname "$0")/../.."
  npx tsx agent/learning/session-reviewer.ts "$SESSION_ID" "$REPO_ALIAS" "$OUTCOME" &
  disown
fi

exit 0
