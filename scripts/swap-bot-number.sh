#!/usr/bin/env bash
# scripts/swap-bot-number.sh
#
# Replace the Meta TEST bot number ("+1 555 640 8123") with the real
# WhatsApp Business API number across the entire repo (45+ hardcoded
# `wa.me/...` anchors + the `KESEFLE_BOT_NUMBER` constant + a few
# diagnostic strings).
#
# Run BEFORE the WABA-number cutover so Steven can verify the diff,
# THEN push to trigger a Vercel deploy with the real number live.
#
# Usage:
#   scripts/swap-bot-number.sh <new_number>
#
# Examples:
#   scripts/swap-bot-number.sh 972527760643      # full E.164 without +
#   scripts/swap-bot-number.sh +972527760643      # the leading + is stripped
#
# After running:
#   1. Review with `git diff`.
#   2. `node tests/full_qa.js` -- should still pass.
#   3. Commit + push.
#   4. ALSO update the bot script properties WHATSAPP_PHONE_NUMBER_ID and
#      BOT_PHONE_E164 in Apps Script (this script can't touch those).

set -euo pipefail

OLD='15556408123'
NEW="${1:-}"

if [[ -z "$NEW" ]]; then
  echo "usage: $0 <new_number_e164_no_plus>" >&2
  exit 2
fi

# Strip a leading '+' if the user pasted it.
NEW="${NEW#+}"

# Sanity-check: digits only, 10-15 chars (E.164 range).
if ! [[ "$NEW" =~ ^[0-9]{10,15}$ ]]; then
  echo "error: '$NEW' is not a valid digits-only E.164 phone number (10-15 digits)" >&2
  exit 2
fi

if [[ "$NEW" == "$OLD" ]]; then
  echo "error: new number is the same as the old one ($OLD) -- nothing to do" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Count BEFORE so we can report what we changed.
COUNT=$(grep -rE --include='*.html' --include='*.js' --include='*.gs' --include='*.md' "${OLD}" . 2>/dev/null | grep -v node_modules | wc -l | tr -d ' ')

if [[ "$COUNT" == "0" ]]; then
  echo "no occurrences of '$OLD' found -- already swapped?" >&2
  exit 0
fi

echo "Found $COUNT references to ${OLD}. Swapping to ${NEW}..."

# macOS sed needs -i ''; GNU sed accepts -i. Use a portable approach.
case "$(uname -s)" in
  Darwin) SED_INPLACE=( -i '' ) ;;
  *)      SED_INPLACE=( -i ) ;;
esac

# Scope: only HTML/JS/GS/MD in the repo, skip node_modules + .git + the
# script itself + the digest doc (which describes historical state).
FILES=$(grep -rlE --include='*.html' --include='*.js' --include='*.gs' --include='*.md' "${OLD}" . 2>/dev/null \
  | grep -v node_modules \
  | grep -v "/\.git/" \
  | grep -v "scripts/swap-bot-number.sh" \
  | grep -v "docs/PROGRESS_DIGEST.md")

if [[ -z "$FILES" ]]; then
  echo "no editable files found after exclusions" >&2
  exit 0
fi

echo "Files to be modified:"
printf "  %s\n" $FILES

# Swap.
echo "$FILES" | xargs sed "${SED_INPLACE[@]}" "s/${OLD}/${NEW}/g"

NEW_COUNT=$(grep -rE --include='*.html' --include='*.js' --include='*.gs' --include='*.md' "${NEW}" . 2>/dev/null | grep -v node_modules | wc -l | tr -d ' ')
REMAINING_OLD=$(grep -rE --include='*.html' --include='*.js' --include='*.gs' --include='*.md' "${OLD}" . 2>/dev/null | grep -v node_modules | wc -l | tr -d ' ')

echo ""
echo "Done."
echo "  New number now appears: $NEW_COUNT times"
echo "  Old number remaining:   $REMAINING_OLD times (should be 0 outside digest doc)"
echo ""
echo "Next steps:"
echo "  1. git diff       # review the changes"
echo "  2. node tests/full_qa.js"
echo "  3. git commit + push"
echo "  4. In Apps Script: update WHATSAPP_PHONE_NUMBER_ID + BOT_PHONE_E164 script properties"
echo "  5. In Meta Business: confirm webhook still points at https://kesefle.com/api/whatsapp/webhook"
