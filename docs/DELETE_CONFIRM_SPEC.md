# Spec: stage the "מחק / undo" delete behind a confirm (audit P0 #3)

Status: **deferred, ready to implement** (2026-06-27). Not rushed because it edits the
most destructive code path and cannot be unit-tested in Node (PropertiesService +
SpreadsheetApp + the tenant delete API). Needs the test harness in step 4.

## The bug
`_handleDeleteRowCommand_` (bot/ExpenseBot_FIXED.gs:1938), dispatched at ~2467 for
**both owner and tenant**, deletes the last row IMMEDIATELY (owner: `sh.deleteRow`
at 1958; tenant: a DELETE API call lower in the same function). There is NO confirm.
A stray "מחק" / "בטל" / "undo" / "מחק אחרון" irreversibly drops the user's last
expense.

## What already exists (reuse it)
A staged-confirm mechanism is already in the message flow:
- **Confirm interceptor** at ~9247 (`delPend:{phone}` ScriptProperty, 60s TTL): on a
  later "אישור/כן/yes/confirm" it runs the delete by `kind` — currently only
  `kind:'order'` (`deleteLastOrder()`) and `kind:'tx'` (`deleteLastTransaction()`),
  both **owner-sheet** deletes. Any non-confirm reply cancels cleanly.
- **Stagers** at ~9504 / ~9538 write `delPend` with those kinds.

`_handleDeleteRowCommand_` simply never routes through it.

## Plan
1. **Extract** the two immediate-delete bodies of `_handleDeleteRowCommand_` into one
   `_performRowDelete_(fromPhone)` that returns the same reply string (owner branch =
   the SpreadsheetApp delete + business-dashboard recompute; tenant branch = the API
   delete). No behaviour change yet — just a pure refactor; reassemble + gauntlet to
   prove the extraction is faithful.
2. **Stage instead of delete**: `_handleDeleteRowCommand_` now sets
   `delPend:{phone} = {kind:'rowdelete', ts: Date.now()}` (ScriptProperties, mirror the
   60s TTL) and returns `{handled:true, replyText:'🗑️ למחוק את ההוצאה האחרונה? שלח *אישור* (תוך 60 שניות).'}`.
   Keep the owner/tenant decision at *confirm* time (re-derive `_isOwnerPhone_`), not
   stage time, so a forwarded/poisoned record can't change the target between stage and
   confirm.
3. **Confirm branch**: in the interceptor at ~9247, add
   `if (__dpKind === 'rowdelete') return { reply: _performRowDelete_(fromPhone) };`
   BEFORE the generic error return. Verify dispatch order: "מחק" is caught by the 2467
   intercept (stages); "אישור" does NOT match `_DELETE_LAST_RE_`, so it falls through to
   the 9247 interceptor (confirms). Confirm both 2467 and 9247 run in the same per-
   message path (they do today for tx/order).
4. **Test harness** (the blocker): add `bot/test_delete_confirm.js` that stubs
   `PropertiesService` (in-memory map) + `SpreadsheetApp` (a fake sheet with N rows) +
   the tenant fetch, then asserts: (a) "מחק" stages + does NOT delete; (b) "אישור"
   within 60s deletes exactly one row; (c) any other reply cancels + deletes nothing;
   (d) ">60s later" expires (no delete); (e) owner vs tenant routes to the right sheet.
   Extract the two functions via the balanced-bracket eval pattern already used in
   `bot/test_income_dashboard_row.js`.
5. Bundle into the pending bot paste; bump KFL_BUILD_VERSION; gauntlet green.

## Gotchas
- Do NOT reuse `kind:'tx'` for the tenant delete — that calls `deleteLastTransaction()`
  on the OWNER sheet (SHEET_ID) and would delete the wrong sheet's row.
- The interceptor's TTL check + non-confirm-cancels behaviour must be preserved exactly.
- Owner-only sub-behaviour (business-dashboard recompute on a deleted עסק row) must move
  into `_performRowDelete_` so confirmed deletes still recompute.
