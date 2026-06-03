#!/usr/bin/env bash
#
# scripts/gauntlet.sh -- the comprehensive regression gauntlet for Kesefle.
#
#   The ONE command to run after every batch of changes. If it exits 0, the
#   batch did not break the safety net. If it exits non-zero, something
#   regressed and the summary tells you exactly which group + item.
#
# Run it:
#   npm run gauntlet          (preferred)
#   bash scripts/gauntlet.sh
#
# What it runs (6 groups, all offline -- Node + bash only, no secrets/network):
#   1. QA gate          node tests/full_qa.js  (the consolidated offline gate)
#   2. Test suites      every tests/test_*.js + tests/golden_set.js +
#                       tests/recurring_detect.js + every bot/test_*.js
#                       (auto-discovered, so new suites are picked up for free)
#   3. JS syntax        node --check on every committed *.js + the two bot *.gs
#                       files (copied to a temp .js -- the originals are never
#                       touched)
#   4. HTML scripts     every inline <script> block in every *.html parses as
#                       valid JS, and every application/ld+json block is valid
#                       JSON (structured-data / SEO guard)
#   5. Sitemap          sitemap.xml is well-formed, <url> tags balance, every
#                       <loc> is an https://kesefle.com URL
#   6. Secret scan      no obvious API token (Meta EAA..., OpenAI sk-...,
#                       Anthropic sk-ant-..., Google AIza..., PEM private keys)
#                       committed to html/js/gs/md
#
# DESIGN: this script ORCHESTRATES the checks that already exist (full_qa, the
# per-suite tests, the deploy-checklist's node --check + inline-script loops,
# the CI sitemap/secret scans) into a single gate with per-group pass/fail
# counts -- it does not reimplement their logic. The three per-file validators
# (groups 3/4/5) live as small standalone Node helpers under
# scripts/gauntlet/ so they're independently runnable and so the bash stays
# portable to the bash 3.2 that ships on macOS (which mis-parses heredocs
# nested inside $()). Dependency-free: pure bash + the Node already required to
# run the suites. It NEVER edits any file.

set -u
cd "$(dirname "$0")/.." || { echo "cannot cd to repo root"; exit 2; }
ROOT="$PWD"
HELP="$ROOT/scripts/gauntlet"

# -- colours (disabled when not a TTY) ---------------------------------------
if [ -t 1 ]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[1m'; D=$'\033[2m'; Z=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; D=''; Z=''
fi

# -- per-group + global tallies ----------------------------------------------
GG_ROWS=()         # "name|pass|fail" per group, for the final summary
                   # (NOT named GROUPS -- that is a read-only bash builtin array
                   #  of the user's group IDs; appending to it silently corrupts)
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_GROUPS=0

hr() { printf '%s\n' "------------------------------------------------------------"; }

# record_group <name> <pass> <fail>
record_group() {
  local name="$1" p="$2" f="$3"
  GG_ROWS+=("$name|$p|$f")
  TOTAL_PASS=$((TOTAL_PASS + p))
  TOTAL_FAIL=$((TOTAL_FAIL + f))
  if [ "$f" -gt 0 ]; then
    FAILED_GROUPS=$((FAILED_GROUPS + 1))
    printf '%s\n' "${R}${B}FAIL ${name}: ${f} failed, ${p} passed${Z}"
  else
    printf '%s\n' "${G}OK   ${name}: ${p} passed${Z}"
  fi
}

# Run a standalone Node validator that ends its stdout with "COUNT <pass> <fail> ...".
# Echoes everything except that COUNT line to stderr (so failures show), and
# sets RG_PASS / RG_FAIL from the COUNT line. If the helper crashes (no COUNT
# line), the group is failed.
run_counted_helper() {
  local out rc countline
  out="$("$@" 2>&1)"; rc=$?
  countline="$(printf '%s\n' "$out" | grep '^COUNT ' | tail -1)"
  printf '%s\n' "$out" | grep -v '^COUNT ' >&2
  if [ -z "$countline" ] || [ "$rc" -ne 0 ]; then
    RG_PASS=0; RG_FAIL=1; return 1
  fi
  # COUNT <pass> <fail> [extra...]
  RG_PASS="$(printf '%s\n' "$countline" | awk '{print $2}')"
  RG_FAIL="$(printf '%s\n' "$countline" | awk '{print $3}')"
  RG_EXTRA="$(printf '%s\n' "$countline" | cut -d' ' -f4-)"
  return 0
}

START_TS=$(date +%s)
printf '%s\n' "${B}==========================================================${Z}"
printf '%s\n' "${B}  Kesefle regression gauntlet${Z}  ${D}(offline -- Node + bash only)${Z}"
printf '%s\n' "${B}==========================================================${Z}"

# ============================================================================
# GROUP 1 -- Consolidated offline QA gate (tests/full_qa.js)
# ============================================================================
printf '\n%s\n' "${B}[1/6] QA gate -- node tests/full_qa.js${Z}"
hr
if node "$ROOT/tests/full_qa.js"; then
  record_group "1. QA gate (full_qa.js)" 1 0
else
  record_group "1. QA gate (full_qa.js)" 0 1
fi

# ============================================================================
# GROUP 2 -- Every test suite (auto-discovered)
#   full_qa.js already runs a curated subset; here we run the COMPLETE set so a
#   suite can never be silently orphaned. Each suite is `node <file>`; non-zero
#   exit = fail. Suites are pure-compute (no secrets / network) by convention.
# ============================================================================
printf '\n%s\n' "${B}[2/6] Test suites -- every tests/* + bot/test_* (auto-discovered)${Z}"
hr
g2_pass=0; g2_fail=0
# Stable, de-duplicated discovery. tests/full_qa.js is covered by group 1, so
# exclude it here to avoid running it twice.
SUITES=$( { \
    find tests -maxdepth 1 -type f -name 'test_*.js'; \
    [ -f tests/golden_set.js ] && echo tests/golden_set.js; \
    [ -f tests/recurring_detect.js ] && echo tests/recurring_detect.js; \
    find bot -maxdepth 1 -type f -name 'test_*.js'; \
  } | sort -u )
for suite in $SUITES; do
  if node "$ROOT/$suite" >/dev/null 2>&1; then
    g2_pass=$((g2_pass + 1))
  else
    g2_fail=$((g2_fail + 1))
    printf '  %s\n' "${R}x ${suite}${Z}"
    # Re-run visibly so the failure output lands in the log for triage.
    node "$ROOT/$suite" 2>&1 | sed 's/^/      /' | tail -25
  fi
done
record_group "2. Test suites ($((g2_pass + g2_fail)) total)" "$g2_pass" "$g2_fail"

# ============================================================================
# GROUP 3 -- JS syntax (`node --check`) across every committed .js + the bot .gs
# ============================================================================
printf '\n%s\n' "${B}[3/6] JS syntax -- node --check on all *.js + bot *.gs${Z}"
hr
if run_counted_helper node "$HELP/check-js-syntax.js" "$ROOT"; then
  record_group "3. JS syntax ($((RG_PASS + RG_FAIL)) files)" "$RG_PASS" "$RG_FAIL"
else
  record_group "3. JS syntax (node --check)" 0 1
fi

# ============================================================================
# GROUP 4 -- HTML inline scripts (JS parse) + structured data (JSON-LD parse)
# ============================================================================
printf '\n%s\n' "${B}[4/6] HTML -- inline <script> parse + JSON-LD validate${Z}"
hr
if run_counted_helper node "$HELP/check-html-scripts.js" "$ROOT"; then
  # RG_EXTRA = "<jsBlocks> <ldBlocks>"
  printf '  %s\n' "${D}${RG_EXTRA} (inline-JS blocks, JSON-LD blocks)${Z}"
  record_group "4. HTML scripts + JSON-LD" "$RG_PASS" "$RG_FAIL"
else
  record_group "4. HTML scripts + JSON-LD" 0 1
fi

# ============================================================================
# GROUP 5 -- sitemap.xml well-formedness + loc-origin sanity
# ============================================================================
printf '\n%s\n' "${B}[5/6] Sitemap -- sitemap.xml structure + <loc> origins${Z}"
hr
if run_counted_helper node "$HELP/check-sitemap.js" "$ROOT"; then
  record_group "5. Sitemap" "$RG_PASS" "$RG_FAIL"
else
  record_group "5. Sitemap" 0 1
fi

# ============================================================================
# GROUP 6 -- Secret scan (committed source only)
#   Mirrors + extends the CI grep. NOT a substitute for real secret-scanning,
#   but fails loudly on the obvious provider-token shapes.
# ============================================================================
printf '\n%s\n' "${B}[6/6] Secret scan -- committed html/js/gs/md${Z}"
hr
# Patterns: Meta long-lived (EAA...), OpenAI (sk-... / sk-proj-...), Anthropic
# (sk-ant-...), Google API key (AIza...), and PEM private-key headers.
SECRET_RE='(EAA[A-Za-z0-9_-]{40,}|sk-ant-[A-Za-z0-9_-]{40,}|sk-proj-[A-Za-z0-9_-]{40,}|sk-[A-Za-z0-9]{40,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
SECRET_HITS=$(grep -rEn "$SECRET_RE" \
  --include="*.html" --include="*.js" --include="*.gs" --include="*.md" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=.vercel \
  . 2>/dev/null || true)
if [ -n "$SECRET_HITS" ]; then
  # Print file:line only -- never echo the matched secret material itself.
  printf '%s\n' "$SECRET_HITS" | sed -E 's/:.*/  (match redacted)/' | sort -u | sed 's/^/  x /' >&2
  record_group "6. Secret scan" 0 1
else
  record_group "6. Secret scan" 1 0
fi

# ============================================================================
# SUMMARY
# ============================================================================
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
printf '\n%s\n' "${B}==========================================================${Z}"
printf '%s\n' "${B}  GAUNTLET SUMMARY${Z}  ${D}[${ELAPSED}s]${Z}"
printf '%s\n' "${B}==========================================================${Z}"
for row in "${GG_ROWS[@]}"; do
  name="${row%%|*}"; rest="${row#*|}"; p="${rest%%|*}"; f="${rest##*|}"
  if [ "$f" -gt 0 ]; then
    printf '  %s  %s\n' "${R}FAIL${Z}" "$name  ${R}[${f} failed / ${p} passed]${Z}"
  else
    printf '  %s  %s\n' "${G}PASS${Z}" "$name  ${D}[${p} passed]${Z}"
  fi
done
hr
if [ "$FAILED_GROUPS" -eq 0 ]; then
  printf '%s\n' "${G}${B}GAUNTLET PASSED${Z}  -- ${TOTAL_PASS} checks across ${#GG_ROWS[@]} groups, 0 failures."
  exit 0
else
  printf '%s\n' "${R}${B}GAUNTLET FAILED${Z}  -- ${FAILED_GROUPS} group(s) failed, ${TOTAL_FAIL} failing checks (${TOTAL_PASS} passed)."
  printf '%s\n' "${Y}   Fix the items marked x above, then re-run: npm run gauntlet${Z}"
  exit 1
fi
