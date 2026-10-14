#!/usr/bin/env bash
# install.sh -- set up memory-os data directories and print the Claude Code hook snippet.
#   bash install.sh --check     only check prerequisites and run offline self-tests; changes nothing outside a temp dir
#   bash install.sh             create $MEMORY_OS_HOME layout, copy example config, print what to add to your settings
# Never edits ~/.claude/settings.json or ~/.config/qmd/index.yml.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEMORY_OS_HOME="${MEMORY_OS_HOME:-$HOME/.memory-os}"
MODE="install"
[ "${1:-}" = "--check" ] && MODE="check"

fail=0
ok()   { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*"; fail=1; }

echo "== prerequisites"
if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 -c 'import sys;print("%d.%d.%d"%sys.version_info[:3])')"
  python3 -c 'import sys;sys.exit(0 if sys.version_info>=(3,8) else 1)' || bad "python3 >= 3.8 required"
else
  bad "python3 not found (required: notes generator and recall hook)"
fi
if command -v bun >/dev/null 2>&1; then ok "bun $(bun --version)"; else warn "bun not found (only needed for search/ MCP server)"; fi
if command -v qmd >/dev/null 2>&1; then ok "qmd $(qmd --version 2>/dev/null | head -n 1)"; else warn "qmd not found (only needed for search/; see README)"; fi
if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${MEMORY_NOTES_KEY_FILE:-}" ] || [ -n "${MEMORY_NOTES_SECURITY_SERVICE:-}" ]; then
  ok "API key source configured (value not read)"
else
  warn "no API key source configured (needed for notes generation; --dry-run works without)"
fi

echo "== self-tests (offline, temp directory)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/memory-os-check.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
if command -v python3 >/dev/null 2>&1; then
  for f in notes/memory_notes_nightly.py notes/chatlog_redact.py recall/recall_router_inject.py; do
    if python3 -c "import ast,sys;ast.parse(open('$HERE/$f',encoding='utf-8').read())" 2>/dev/null; then ok "syntax $f"; else bad "syntax $f"; fi
  done
  mkdir -p "$TMP/cards" "$TMP/skills" "$TMP/chats/raw"
  cp -R "$HERE/examples/cards/." "$TMP/cards/"
  cp -R "$HERE/examples/skills/." "$TMP/skills/"
  cp "$HERE/examples/skill-routes.md" "$TMP/skill-routes.md"
  cp -R "$HERE/examples/chats/raw/." "$TMP/chats/raw/"
  out="$(printf '%s' '{"prompt":"please dim the lights"}' | MEMORY_OS_HOME="$TMP" bash "$HERE/recall/inject.sh")"
  case "$out" in *demo-skill*) ok "recall hook returns a capsule for the demo prompt";; *) bad "recall hook returned no capsule for the demo prompt";; esac
  if MEMORY_OS_HOME="$TMP" python3 "$HERE/notes/chatlog_redact.py" >/dev/null 2>&1; then ok "redaction mirror built"; else bad "redaction step failed"; fi
  if MEMORY_OS_HOME="$TMP" python3 -I "$HERE/notes/memory_notes_nightly.py" --day 2026-01-01 --dry-run >"$TMP/dry.out" 2>&1 && grep -q "訊息總數: 3" "$TMP/dry.out"; then
    ok "notes generator --dry-run parsed 3 demo messages"
  else
    bad "notes generator dry-run failed (see below)"; sed 's/^/        /' "$TMP/dry.out"
  fi
  if python3 -I "$HERE/tests/test_redact.py" >"$TMP/t1.out" 2>&1; then ok "redaction tests"; else bad "redaction tests failed"; sed 's/^/        /' "$TMP/t1.out"; fi
  if python3 "$HERE/tests/test_max_usd.py" >"$TMP/t2.out" 2>&1; then ok "--max-usd budget test (local mock server, no network)"; else bad "--max-usd budget test failed"; sed 's/^/        /' "$TMP/t2.out"; fi
fi

echo "== embedding model consistency (read-only)"
# qmd resolves the embedding model as: index.yml models.embed, THEN $QMD_EMBED_MODEL, then its built-in default.
# search/ passes the one-line qmd-embed-model file as $QMD_EMBED_MODEL, so a different models.embed in index.yml silently wins.
first_uri() { awk '{ sub(/#.*/, ""); gsub(/^[ \t]+|[ \t\r]+$/, ""); if ($0 != "") { print; exit } }' "$1" 2>/dev/null; }
MODEL_FILE="${QMD_EMBED_MODEL_FILE:-$MEMORY_OS_HOME/qmd-embed-model}"
[ -f "$MODEL_FILE" ] || MODEL_FILE="$HERE/config/qmd-embed-model.example"
FILE_MODEL="$(first_uri "$MODEL_FILE")"
INDEX_YML="${QMD_INDEX_YML:-${XDG_CONFIG_HOME:-$HOME/.config}/qmd/index.yml}"
YML_MODEL=""
if [ -f "$INDEX_YML" ]; then
  YML_MODEL="$(awk '/^[ \t]*embed:[ \t]*/ { sub(/^[ \t]*embed:[ \t]*/, ""); sub(/[ \t]+#.*$/, ""); gsub(/["\047 \t\r]/, ""); if ($0 != "") { print; exit } }' "$INDEX_YML")"
fi
if [ -n "$YML_MODEL" ] && [ -n "$FILE_MODEL" ] && [ "$YML_MODEL" != "$FILE_MODEL" ]; then
  warn "models.embed in $INDEX_YML ($YML_MODEL) differs from $MODEL_FILE ($FILE_MODEL): qmd gives models.embed priority, so the model file is ignored and index/query models can mismatch"
elif [ -n "$YML_MODEL" ] && [ -n "${QMD_EMBED_MODEL:-}" ] && [ "$YML_MODEL" != "$QMD_EMBED_MODEL" ]; then
  warn "models.embed in $INDEX_YML ($YML_MODEL) differs from \$QMD_EMBED_MODEL ($QMD_EMBED_MODEL): models.embed wins, the environment variable is ignored"
elif [ -n "${QMD_EMBED_MODEL:-}" ] && [ -n "$FILE_MODEL" ] && [ "$QMD_EMBED_MODEL" != "$FILE_MODEL" ]; then
  warn "\$QMD_EMBED_MODEL in your shell ($QMD_EMBED_MODEL) differs from $MODEL_FILE ($FILE_MODEL): run 'qmd update && qmd embed' with the same value search/ uses ($FILE_MODEL), otherwise index and query dimensions mismatch"
else
  ok "no embedding model mismatch detected (model file: ${FILE_MODEL:-none}; index.yml models.embed: ${YML_MODEL:-not set})"
fi

if [ "$fail" != 0 ]; then echo "RESULT: FAIL"; exit 1; fi
if [ "$MODE" = "check" ]; then echo "RESULT: OK (check only, nothing installed)"; exit 0; fi

echo "== install into $MEMORY_OS_HOME"
mkdir -p "$MEMORY_OS_HOME"/{chats/raw,chats/redacted,notes,cards,skills,state}
[ -f "$MEMORY_OS_HOME/qmd-embed-model" ] || cp "$HERE/config/qmd-embed-model.example" "$MEMORY_OS_HOME/qmd-embed-model"
[ -f "$MEMORY_OS_HOME/skill-routes.md" ] || cp "$HERE/examples/skill-routes.md" "$MEMORY_OS_HOME/skill-routes.md"
[ -f "$MEMORY_OS_HOME/cards/MEMORY.md" ] || cp "$HERE/examples/cards/MEMORY.md" "$MEMORY_OS_HOME/cards/MEMORY.md"
# demo skill + demo card, so the README smoke test prints something right after install (never overwrites)
for d in "$HERE"/examples/skills/*/; do
  n="$(basename "$d")"
  [ -d "$MEMORY_OS_HOME/skills/$n" ] || cp -R "$d" "$MEMORY_OS_HOME/skills/$n"
done
for f in "$HERE"/examples/cards/*.md; do
  n="$(basename "$f")"
  [ -f "$MEMORY_OS_HOME/cards/$n" ] || cp "$f" "$MEMORY_OS_HOME/cards/$n"
done
ok "directories ready (demo skill and card copied; delete them when you add your own)"

echo
echo "== add this to the \"hooks\" section of your Claude Code settings.json (not applied automatically):"
HERE_ESC="$(printf '%s' "$HERE" | sed -e 's/[\\&#]/\\&/g')"
sed "s#__REPO__#$HERE_ESC#" "$HERE/config/claude-hook.example.json"
echo
echo "Also: export MEMORY_OS_HOME=\"$MEMORY_OS_HOME\" in the environment Claude Code runs in (or keep the default ~/.memory-os)."
echo "RESULT: OK"
