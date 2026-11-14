#!/bin/bash
# Save a secret from the clipboard into .env without ever printing it.
# Usage: scripts/set-key.sh ANTHROPIC_API_KEY   (copy the key first)
set -euo pipefail
NAME="${1:?usage: set-key.sh NAME}"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
VALUE="$(pbpaste | tr -d '[:space:]')"

case "$NAME" in
  ANTHROPIC_API_KEY) PREFIX="sk-ant-" ;;
  RESEND_API_KEY) PREFIX="re_" ;;
  *) echo "Unknown key name: $NAME"; exit 1 ;;
esac

if [[ "$VALUE" != "$PREFIX"* || ${#VALUE} -lt 20 ]]; then
  echo "The clipboard doesn't look like a $NAME (expected it to start with $PREFIX). Nothing saved."
  exit 1
fi

touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
grep -v "^$NAME=" "$ENV_FILE" > "$ENV_FILE.tmp" || true
printf '%s=%s\n' "$NAME" "$VALUE" >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
printf '' | pbcopy
echo "$NAME saved to .env and the clipboard was cleared."
