#!/usr/bin/env bash
# inject.sh — entry point of the UserPromptSubmit additive injector
#
# Rules:
#   - No file writes except the optional index cache in the system temp directory
#     (written by recall_router_inject.py with mkstemp + os.replace, symlink-safe);
#     no background tasks, no network.
#   - stdin is passed unchanged to recall_router_inject.py.
#   - Any error (malformed JSON, helper unavailable, empty prompt, Python crash) fails open:
#     rc=0 and empty stdout, so the user's message is never blocked.
#   - stderr never carries a traceback or the prompt text.

set -u

# Python entry point
INJECT_PY="${BASH_SOURCE[0]%/*}/recall_router_inject.py"

# Take all of stdin and hand it to Python unchanged; any Python error is swallowed
out=$(python3 "$INJECT_PY" 2>/dev/null) || true

# Even if Python already printed an empty string, make sure here too
printf '%s' "$out"
exit 0
