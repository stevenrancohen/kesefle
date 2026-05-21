#!/usr/bin/env bash
# format-on-write.sh — lint-only formatting reporter (does NOT mutate files).
#
# Auto-rewriting hand-edited RTL/Hebrew HTML is risky (can strip meaningful
# whitespace or stray bidi marks), so this only REPORTS issues for a human/agent
# to fix intentionally. Pass a file path, or run with no args to check staged.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 0

files=("$@")
if [ ${#files[@]} -eq 0 ]; then
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(js|gs|html|css|json|md|sh)$' || true)
fi

issues=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  # trailing whitespace
  if grep -nE ' +$' "$f" >/dev/null 2>&1; then
    echo "• $f: trailing whitespace on $(grep -cE ' +$' "$f") line(s)"; issues=1
  fi
  # stray bidi control chars (LRM/RLM/embeddings) — common Hebrew-paste artifact
  if grep -nP '[\x{200E}\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}]' "$f" >/dev/null 2>&1; then
    echo "• $f: stray Unicode bidi control char(s) — likely a Hebrew paste artifact"; issues=1
  fi
  # missing trailing newline
  if [ -n "$(tail -c1 "$f" 2>/dev/null)" ]; then
    echo "• $f: no trailing newline"; issues=1
  fi
done
[ "$issues" -eq 0 ] && echo "format: clean"
exit 0   # advisory only — never blocks
