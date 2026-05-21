#!/usr/bin/env bash
# pre-commit-check.sh — fast safety gate before a commit.
# Runs: secret scan + node --check on staged JS + the test suites.
# Exit 0 = safe to commit. Non-zero = fix first. Run manually:
#   bash .claude/hooks/pre-commit-check.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 1

fail=0

echo "▶ secret scan"
bash .claude/hooks/block-secrets.sh < /dev/null || { echo "  ✗ secrets found"; fail=1; }

echo "▶ node --check on staged .js"
for f in $(git diff --cached --name-only --diff-filter=ACM | grep -E '\.js$' || true); do
  [ -f "$f" ] || continue
  node --check "$f" || { echo "  ✗ syntax: $f"; fail=1; }
done

echo "▶ bot DEPLOY.gs syntax (if bot staged)"
if git diff --cached --name-only | grep -q 'bot/ExpenseBot_'; then
  cp bot/ExpenseBot_DEPLOY.gs /tmp/_dep.js && node --check /tmp/_dep.js || { echo "  ✗ DEPLOY.gs syntax"; fail=1; }
  dups=$(grep -c "function doPost" bot/ExpenseBot_DEPLOY.gs)
  [ "$dups" = "1" ] || { echo "  ✗ doPost defined $dups times (assembly broken)"; fail=1; }
fi

echo "▶ test suites"
for t in bot/test_classify.js bot/test_parser.js bot/test_isolation.js tests/full_qa.js; do
  [ -f "$t" ] || continue
  node "$t" >/dev/null 2>&1 && echo "  ✓ $t" || { echo "  ✗ $t FAILED"; fail=1; }
done

[ "$fail" -eq 0 ] && echo "✅ pre-commit OK" || echo "❌ pre-commit FAILED — do not commit"
exit $fail
