#!/bin/bash
# PreToolUse hook for Claude Chat Bridge
# When CHAT_BRIDGE_SESSION is set, this hook forwards permission requests
# to the bridge server. When running in terminal, it auto-allows everything.

# Only gate tools when running through the bridge
if [ -z "$CHAT_BRIDGE_SESSION" ]; then
  exit 0
fi

# Read hook input from stdin
input=$(cat)

tool_name=$(echo "$input" | jq -r '.tool_name // empty')
tool_input=$(echo "$input" | jq -c '.tool_input // {}')
session_id=$(echo "$input" | jq -r '.session_id // empty')

if [ -z "$tool_name" ] || [ -z "$session_id" ]; then
  exit 0
fi

# POST to bridge server and wait for decision
# Uses -k for self-signed certs on localhost
response=$(curl -sk -X POST https://localhost:3456/api/permissions/request \
  -H "Content-Type: application/json" \
  -d "{\"tool_name\": \"$tool_name\", \"tool_input\": $tool_input, \"session_id\": \"$session_id\"}" \
  --max-time 130 \
  2>/dev/null)

decision=$(echo "$response" | jq -r '.decision // "deny"')

if [ "$decision" = "allow" ]; then
  exit 0
else
  # Output deny decision in hook format
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"decision\":{\"behavior\":\"deny\",\"message\":\"Permission denied via Chat Bridge\"}}}"
  exit 2
fi
