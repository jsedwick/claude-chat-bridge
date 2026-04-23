#!/usr/bin/env bash
# Validates whether Claude Code 2.1.118's pointer-based /fork resolves parent
# JSONL correctly when spawn cwd != parent cwd. If it does, we can remove
# ensureForkSessionAvailable() from claude-runner.ts.

set -euo pipefail

# Pin to the bridge's actual claude binary (the installer at ~/.local).
# Homebrew's copy may be a different (older) version.
export PATH="${HOME}/.local/bin:${PATH}"
echo "claude: $(command -v claude)  version: $(claude --version)"

PARENT_CWD="${HOME}/Projects/claude-chat-bridge"
FORK_CWD="${HOME}/Projects/obsidian-mcp-server"

projdir() { echo "${HOME}/.claude/projects/$(echo "$1" | sed 's![/.]!-!g')"; }

echo "=== Step 1: seed parent session in $PARENT_CWD ==="
cd "$PARENT_CWD"
PARENT_OUT=$(claude -p --output-format json "Reply with exactly the word SEED.")
PARENT_SID=$(echo "$PARENT_OUT" | jq -r '.session_id')
echo "parent session_id: $PARENT_SID"
PARENT_JSONL="$(projdir "$PARENT_CWD")/${PARENT_SID}.jsonl"
if [[ ! -f "$PARENT_JSONL" ]]; then
  echo "FAIL: parent JSONL not written at $PARENT_JSONL"
  exit 1
fi
echo "parent JSONL: $PARENT_JSONL"

echo "=== Step 2: ensure fork-target project dir has NO pre-copy ==="
FORK_TARGET="$(projdir "$FORK_CWD")/${PARENT_SID}.jsonl"
rm -f "$FORK_TARGET"
echo "confirmed absent: $FORK_TARGET"

echo "=== Step 3: fork from $PARENT_CWD → $FORK_CWD without pre-copy ==="
cd "$FORK_CWD"
FORK_OUT=$(claude -p --output-format json --resume "$PARENT_SID" --fork-session \
  "What word did you just say? One word only.")
echo "$FORK_OUT" | jq '{is_error, session_id, result: (.result // .text // null)}'

IS_ERROR=$(echo "$FORK_OUT" | jq -r '.is_error // false')
RESULT=$(echo "$FORK_OUT" | jq -r '.result // .text // ""')

echo "=== Verdict ==="
if [[ "$IS_ERROR" == "true" ]]; then
  echo "STILL BROKEN — ensureForkSessionAvailable() is still required."
  exit 2
elif echo "$RESULT" | grep -qi "seed"; then
  echo "FIXED — pointer-based fork resolved parent across cwd. Safe to delete the workaround."
  exit 0
else
  echo "AMBIGUOUS — no error, but response doesn't cite parent context. Inspect manually:"
  echo "$FORK_OUT"
  exit 3
fi
