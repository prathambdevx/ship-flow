#!/bin/bash
# One-line install: curl -fsSL https://raw.githubusercontent.com/prathambhatia/ship-flow/main/install.sh | bash
# Clones (or updates) ship-flow, puts `ship` on your PATH and installs the Claude Code plugin.
set -euo pipefail
DIR="${SHIP_FLOW_DIR:-$HOME/.ship-flow}"
command -v git >/dev/null || { echo "ship-flow needs git"; exit 1; }
command -v bun >/dev/null || { echo "ship-flow needs Bun: curl -fsSL https://bun.sh/install | bash"; exit 1; }
command -v jq >/dev/null || echo "note: the hooks need jq (brew install jq); without it the page shows no live subagents"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q --ff-only; else git clone -q https://github.com/prathambhatia/ship-flow.git "$DIR"; fi
chmod +x "$DIR/bin/ship" "$DIR/hooks/ship-hook.sh"
mkdir -p "$HOME/.local/bin" "$HOME/.claude/ship"
ln -sf "$DIR/bin/ship" "$HOME/.local/bin/ship"
[ -f "$HOME/.claude/ship/config.json" ] || printf '{\n  "backends": {},\n  "projects": {}\n}\n' > "$HOME/.claude/ship/config.json"
CLAUDE="$(command -v claude || echo "$HOME/.local/bin/claude")"
"$CLAUDE" plugin marketplace add "$DIR" >/dev/null 2>&1 || "$CLAUDE" plugin marketplace update ship-flow >/dev/null
"$CLAUDE" plugin install ship-flow@ship-flow >/dev/null 2>&1 || "$CLAUDE" plugin update ship-flow@ship-flow >/dev/null
echo "ship-flow installed in $DIR"
echo "Next: add your backend to ~/.claude/ship/config.json (see $DIR/BACKEND.md), then run: ship ui"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to your PATH to use ship";; esac
