#!/usr/bin/env bash
# Remove SmartModel hooks and files from ~/.claude. Keeps config.json and decisions.log unless --purge.
set -euo pipefail
CLAUDE="$HOME/.claude"
DEST="$CLAUDE/smartmodel"
SETTINGS="$CLAUDE/settings.json"

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "$SETTINGS.bak-smartmodel-$(date +%s)"
  tmp="$(mktemp)"
  jq '
    def isSm: (.hooks // []) | any(.command? // "" | test("smartmodel\\.js"));
    if .hooks then
      .hooks |= with_entries(.value |= (if type == "array" then map(select(isSm | not)) else . end))
      | .hooks |= with_entries(select((.value | type) != "array" or (.value | length) > 0))
      | if (.hooks | length) == 0 then del(.hooks) else . end
    else . end
  ' "$SETTINGS" > "$tmp"
  mv "$tmp" "$SETTINGS"
fi
rm -f "$CLAUDE/commands/smartmodel.md" "$DEST/smartmodel.js"
if [ "${1:-}" = "--purge" ]; then rm -rf "$DEST"; else
  echo "Kept $DEST (config.json, decisions.log). Re-run with --purge to delete it."
fi
echo "SmartModel uninstalled."
