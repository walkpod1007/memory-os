#!/usr/bin/env bash
# run_nightly.sh -- redact chat logs, then generate observation notes for one day (default: yesterday).
#
# API key lookup order (first hit wins):
#   1. $ANTHROPIC_API_KEY already exported
#   2. file named by $MEMORY_NOTES_KEY_FILE (first line = key)
#   3. macOS generic password item: service $MEMORY_NOTES_SECURITY_SERVICE, account $MEMORY_NOTES_SECURITY_ACCOUNT
# Extra args are passed to memory_notes_nightly.py (e.g. --day 2026-01-01, --from/--to, --dry-run, --max-usd).
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MEMORY_OS_HOME="${MEMORY_OS_HOME:-$HOME/.memory-os}"

DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done

if [ "$DRY" = 0 ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  if [ -n "${MEMORY_NOTES_KEY_FILE:-}" ] && [ -r "$MEMORY_NOTES_KEY_FILE" ]; then
    ANTHROPIC_API_KEY="$(head -n 1 "$MEMORY_NOTES_KEY_FILE")"
  elif [ -n "${MEMORY_NOTES_SECURITY_SERVICE:-}" ] && command -v security >/dev/null 2>&1; then
    ANTHROPIC_API_KEY="$(security find-generic-password -s "$MEMORY_NOTES_SECURITY_SERVICE" ${MEMORY_NOTES_SECURITY_ACCOUNT:+-a "$MEMORY_NOTES_SECURITY_ACCOUNT"} -w 2>/dev/null || true)"
  fi
  export ANTHROPIC_API_KEY
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "no API key found (see README: environment variables)" >&2
    exit 3
  fi
fi

if [ -d "$MEMORY_OS_HOME/chats/raw" ]; then
  python3 "$HERE/chatlog_redact.py" || { echo "redaction failed" >&2; exit 5; }
else
  echo "note: $MEMORY_OS_HOME/chats/raw missing, skipping redaction step" >&2
fi

exec python3 -I "$HERE/memory_notes_nightly.py" "$@"
