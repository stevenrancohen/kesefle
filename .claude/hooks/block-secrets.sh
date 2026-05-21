#!/usr/bin/env bash
# block-secrets.sh — prevent committing API keys / tokens / private keys.
#
# Two modes:
#   1) Claude Code PreToolUse hook: reads the tool-call JSON on stdin. If the
#      Bash command is a `git commit`, scans STAGED content for secrets.
#   2) Manual / git pre-commit: run with no stdin; scans staged content.
#
# Exit 0 = allow. Exit 2 = block (Claude treats non-zero PreToolUse as deny).
# Fails OPEN for any non-commit command so it never blocks normal work.
set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 0

# If invoked as a Claude hook, stdin carries the tool input JSON.
INPUT=""
if [ ! -t 0 ]; then INPUT="$(cat 2>/dev/null || true)"; fi

# Only gate git commits. Anything else: allow.
if [ -n "$INPUT" ]; then
  case "$INPUT" in
    *'git commit'*|*'git'*'commit'*) : ;;   # proceed to scan
    *) exit 0 ;;
  esac
fi

# Collect staged content (added/modified). If nothing staged, allow.
STAGED="$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)"
[ -z "$STAGED" ] && exit 0

# High-confidence secret patterns (avoid matching placeholders/examples).
PATTERNS='AIzaSy[0-9A-Za-z_-]{20,}|sk-[a-zA-Z0-9]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|-----BEGIN ((RSA|EC|OPENSSH) )?PRIVATE KEY-----|ghp_[0-9A-Za-z]{30,}|AKIA[0-9A-Z]{16}'

HITS=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *.example|*.md|*.sample) continue ;;   # docs/examples may show formats
  esac
  # Scan only the staged version of the file.
  match="$(git show ":$f" 2>/dev/null | grep -nEI "$PATTERNS" || true)"
  if [ -n "$match" ]; then
    echo "🚫 block-secrets: possible secret in staged file: $f" >&2
    echo "$match" | sed 's/^/    /' >&2
    HITS=1
  fi
done <<< "$STAGED"

if [ "$HITS" -ne 0 ]; then
  echo "Commit blocked. Remove the secret, use an env var / Script Property, and rotate the exposed key." >&2
  exit 2
fi
exit 0
