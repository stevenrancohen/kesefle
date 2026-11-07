#!/usr/bin/env bash
# Builds the file the Claude inbox ships: a git bundle of every commit on the
# current branch that is not on origin/main yet. Upload it on GitHub to a new
# branch named claude-inbox/<name> (Add file > Upload files > "Create a new
# branch"); .github/workflows/claude-inbox.yml checks it, runs the gauntlet and
# fast forwards main, then Vercel deploys. No terminal or token on the owner's side.
#
#   bash scripts/kfx/make-inbox-bundle.sh [out.bundle]
set -euo pipefail
OUT="${1:-inbox-$(date +%Y%m%d-%H%M).bundle}"
git fetch -q origin main
BASE="$(git rev-parse origin/main)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git merge-base --is-ancestor "$BASE" HEAD || { echo "rebase on origin/main first (main moved)"; exit 1; }
[ "$(git rev-list --count "$BASE"..HEAD)" -gt 0 ] || { echo "nothing to ship"; exit 1; }
if git diff --name-only "$BASE" HEAD | grep -q '^\.github/'; then echo ".github changes are not shipped by the inbox, do them on GitHub"; exit 1; fi
git bundle create "$OUT" "$BASE..$BRANCH"
git bundle verify "$OUT" >/dev/null
echo "bundle: $OUT ($(git rev-list --count "$BASE"..HEAD) commit(s) on top of ${BASE:0:7}, tip $(git rev-parse --short HEAD))"
