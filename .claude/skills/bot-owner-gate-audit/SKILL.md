---
name: bot-owner-gate-audit
description: Find every owner-only handler in the bot that doesn't call _isOwnerPhone_ before privileged work; report violations so we never accidentally expose owner functions to non-owners.
---

# Owner-gate audit

Owner-only paths in the bot — multi-business commands (`עסק N`), subscription mgmt, learning corrections, budget commands, the SRC router, etc. — must all gate on `_isOwnerPhone_` (defined `bot/ExpenseBot_FIXED.gs:5424`). A missed gate exposes the owner's accounting to anyone who messages the bot.

## Steps

1. List every function name that should be owner-gated:
   ```
   grep -nE "function _handle(Subscription|Budget|Learning|CategoryCorrection)|function _parseBusinessNumberPrefix_|function handleBotCommand_|function SRC_ROUTER_handle" bot/ExpenseBot_FIXED.gs
   ```
2. For each, find every call site:
   ```
   for fn in _handleSubscriptionCommand_ _handleBudgetCommand_ _handleLearningCommand_ _handleCategoryCorrection_ _parseBusinessNumberPrefix_ handleBotCommand_ SRC_ROUTER_handle ; do
     echo "=== $fn ==="
     grep -nE "typeof $fn|$fn\(" bot/ExpenseBot_FIXED.gs
   done
   ```
3. For each call site, confirm `_isOwnerPhone_(__from_)` (or equivalent) is checked in the same `if` condition. The known-good pattern (search at line ~1951):
   ```
   if (typeof _handleX_ === "function" && _isOwnerPhone_(__from_)) {
   ```
4. Flag any call site that calls the handler WITHOUT the `_isOwnerPhone_` AND clause. Capture file:line.
5. Also audit direct sheet writes (`SpreadsheetApp.openById(SHEET_ID).getSheetByName(...).appendRow`) — they must either be inside an `_isOwnerPhone_` block or use a tenant-aware path:
   ```
   grep -nE "openById\(SHEET_ID\).*appendRow|openById\(COMPANY_SHEET_ID\).*appendRow" bot/ExpenseBot_FIXED.gs
   ```
6. For each direct write, walk up to the nearest `if (_isOwnerPhone_(...))` ancestor. If none → violation.

## Verification
- For every owner handler invocation, the same line contains `_isOwnerPhone_`.
- For every owner-only sheet write, an `_isOwnerPhone_` gate exists in the same function / surrounding if-block.
- `node bot/test_isolation.js` still passes — it catches the most obvious leaks.

## Common pitfalls
- A NEW handler added without the gate (PR-time regression). Run this skill in `pr-review`.
- The gate exists at the top of an outer function, but a code refactor moves the privileged call into a sibling branch that bypasses it.
- `_isOwnerPhone_` is checked early-return at function top, then the function calls a helper that ALSO writes — the helper has no gate; refactor moves the helper into a path that the gate doesn't cover.

## Examples
- "Audit the bot before the next major paste" → run this, expect zero violations.
- "After PR #N changed owner routing" → re-run, confirm no new gaps.
