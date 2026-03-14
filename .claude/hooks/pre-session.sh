#!/bin/bash
# Pre-session hook — loads relevant memory context before a Claude session starts.
# Configured in settings.local.json as a "UserPromptSubmit" hook.
#
# Hook payload (stdin): JSON with the user's prompt
# This hook can inject additional context by outputting to stdout.

set -e

PAYLOAD=$(cat)
TASK=$(echo "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('prompt','')[:500])" 2>/dev/null || echo "")

# Could optionally pre-load memory here and inject via hook stdout
# For now, just log the session start
echo "[pre-session] Session started for task: ${TASK:0:80}" >&2

exit 0
