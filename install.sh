#!/usr/bin/env bash
# Install SmartModel into ~/.claude (idempotent).
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="$HOME/.claude"
DEST="$CLAUDE/smartmodel"
SETTINGS="$CLAUDE/settings.json"

command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node is required (Node 18+)"; exit 1; }

mkdir -p "$DEST" "$CLAUDE/commands"
cp "$SRC/smartmodel.js" "$DEST/smartmodel.js"
cp "$SRC/commands/smartmodel.md" "$CLAUDE/commands/smartmodel.md"

[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.bak-smartmodel-$(date +%s)"

HOOK="$NODE $DEST/smartmodel.js hook"
PICK="$NODE $DEST/smartmodel.js pick"
tmp="$(mktemp)"
jq --arg hook "$HOOK" --arg pick "$PICK" '
  def isSm: (.hooks // []) | any(.command? // "" | test("smartmodel\\.js"));
  .hooks //= {}
  | .hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) | map(select(isSm | not))
      + [{hooks: [{type: "command", command: $hook, timeout: 10}]}])
  | .hooks.PostToolUse = ((.hooks.PostToolUse // []) | map(select(isSm | not))
      + [{matcher: "AskUserQuestion", hooks: [{type: "command", command: $pick, timeout: 10}]}])
' "$SETTINGS" > "$tmp"
mv "$tmp" "$SETTINGS"

echo "SmartModel installed to $DEST"
echo "Hooks added to $SETTINGS (backup saved next to it). Restart Claude Code, then try: /smartmodel status"
