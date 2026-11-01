#!/bin/bash
# Sends this hook event to the plan's backend when the session owns a /ship plan (its marker file); any other session: nothing.
input=$(cat)
sid=$(printf %s "$input" | jq -r '.session_id // empty' 2>/dev/null)
marker="$HOME/.claude/ship/sessions/$sid"
[ -n "$sid" ] && [ -f "$marker" ] || exit 0
url=$(jq -r '.hook // empty' "$marker" 2>/dev/null)
[ -n "$url" ] || exit 0
printf %s "$input" | curl -s -m 3 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- "$url" >/dev/null 2>&1 &
exit 0
