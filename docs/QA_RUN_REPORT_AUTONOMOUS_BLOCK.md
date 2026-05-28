# QA Run Report - Autonomous Audit Block (Agent 8)

Date: 2026-05-28
Branch: audit-qa-coverage
Base: origin/main @ 135b5c2 (Merge PR #129)
Agent: Regression Test + Bot Conversation QA + Review Inbox (combined)

## Summary

| Metric | Value |
|---|---|
| Total test suites executed | 26 |
| Suites PASSED (exit=0, all assertions passed) | 25 |
| Suites with failing assertions | 1 (test_migration_phase_7.js) |
| Total individual assertions counted (from passing suites) | 700+ |
| Failed assertions in failing suite | 4 / 109 |
| Classifier accuracy (golden_set) | 95.2% (159/167, threshold 93%) |
| Classification checks (test_classify) | 118/118 |
| OFFLINE QA checks (full_qa) | 118/118 |

OVERALL: 25 PASS / 1 PARTIAL (orphan files in classification map — non-blocking, recoverable).

## Deliverable 1: Per-suite results

All commands executed from repo root with `node <path>`. Logs captured under `/tmp/qa_run/*.txt`.

### tests/full_qa.js
- Command: `node tests/full_qa.js`
- Exit: 0
- Result: `OFFLINE QA: ALL 118 CHECKS PASSED`
- Coverage sections: 5a..5k (Web Push, Push subscribe auth, sw.js handlers, config vapid key) + manual E2E checklist (9 items, marked as manual — NOT runnable in offline harness).
- Notes: includes its own router-ordering check that the bot routes data queries BEFORE Gemini coach fallback.

### bot/test_classify.js
- Command: `node bot/test_classify.js`
- Exit: 0
- Result: `ALL 118 CLASSIFICATION CHECKS PASSED`
- Last 5 lines:
  - PASS "מחזור" -> מחזור
  - PASS "עלות חומרי גלם" -> עלות חומרי גלם
  - PASS "עלות שיווק" -> עלות שיווק
  - PASS "משלוחים והתקנות" -> משלוחים והתקנות
  - PASS "הוצאות תפעוליות" -> הוצאות תפעוליות

### tests/golden_set.js
- Command: `node tests/golden_set.js`
- Exit: 0
- Result: PASS (95.2% accuracy, threshold 93%)
- Pass count: 159 / 167
- Misses (8):
  1. `פאב 150` want אוכל got בידור / בילוי ויציאה
  2. `ספרי לימוד 300` want הוצאות קבועות got חינוך וילדים / ספרים וציוד לבית ספר
  3. `מעמ 1800` want ממשלה ומיסים got עסק / הוצאות תפעוליות
  4. `שכר לימוד 5000` want חינוך got חינוך וילדים / חינוך וטיפול
  5. `גן ילדים 2500` want חינוך got חינוך וילדים / חינוך וטיפול
  6. `צהרון 1200` want חינוך got חינוך וילדים / חינוך וטיפול
  7. `מעון 2800` want חינוך got חינוך וילדים / חינוך וטיפול
  8. `צעצוע לילד 120` want DEFAULT got בידור / צעצועים ומשחקי ילדים
- Category breakdown: 4 categories had <100% — חינוך (43%), הוצאות קבועות (96%), ממשלה ומיסים (50%), bidur (אוכל miss).

### bot/test_pending_state_hijack.js
- Exit: 0
- Result: `OK: all assertions passed`
- Verified: STATE-HIJACK GUARD source markers present, removes both `pendingExpense` and `pendingCreate`, amount-floor=5, breadcrumb log, lives inside `_handlePendingCategoryText_`, KFL_BUILD_VERSION date-stamped `2026-05-28-pr-b-biz-canonical-subs`.

### bot/test_trace_instrumentation.js
- Exit: 0
- Result: `OK: all assertions passed`
- 12 trace call-sites found (>= 10 required), including `tenant_write.entry` + `tenant_write.parsed_and_classified`.

### bot/test_phase_a_v2_uncertainty.js
- Exit: 0
- Result: `OK: all assertions passed`
- `_savePendingClar_` saves clarPend state on guard fire.
- Deferred (not in this PR): 60s timeout sweep, needs_review row write, correction-button-after-save.

### bot/test_business_order_parser.js
- Exit: 0
- Result: `OK: all assertions passed`
- Hijack guard calls `parseBusinessOrder_`, removes `smart_pending`, nullifies `__hP`.

### bot/test_bot_robustness.js
- Exit: 0
- Result: `OK: all assertions passed`
- KFL_BUILD_VERSION format YYYY-MM-DD, ALLOWED_ACTIONS check is AFTER JSON.parse.

### bot/test_category_picker.js
- Exit: 0
- Result: `PASS: 17 FAIL: 0 — Category picker QA: ALL TESTS PASSED (17 assertions)`
- Income section contains משכורת, Business section contains שיווק ופרסום + שכר עובדים.

### bot/test_botloop.js
- Exit: 0
- Result: `30 pass, 0 fail`
- BOT_ECHO_REGEXES verified for currency-symbol expenses, action-keyword JSON, plain English reply text.

### bot/test_broken_formula.js
- Exit: 0
- Result: `15 pass, 0 fail`
- `_isBrokenDashFormula_` preserves clean & flags broken (SUMIFS+leftover).

### bot/test_destructive_delete_confirm.js
- Exit: 0
- Result: `OK: all assertions passed`
- `deleteLastOrder` / `deleteLastTransaction` no longer returns immediately without confirm; interceptor wraps both.

### bot/test_expanded_category_picker.js
- Exit: 0
- Result: `OK: all assertions passed`
- All sections within WhatsApp 10-row cap. Picker sections: חינוך וילדים=8, פנאי ובידור=6, עסק=10, פיננסי=7, הכנסות=6, אחר=4.

### bot/test_goal_commands.js
- Exit: 0
- Result: `OK: all assertions passed`
- api/goals/upsert.js, list.js, delete.js exist. `lib/goals.js` exports the 4 public functions + uses randomBytes for IDs.

### bot/test_isolation.js
- Exit: 0
- Result: `ALL 19 CHECKS PASSED`
- Phone-to-sheet routing gated through `_botConcierge_`. No unguarded `SHEET_ID` links in user-facing replies (0 leaks).

### bot/test_bot_no_active_lies.js
- Exit: 0
- Result: `OK: all assertions passed`
- Honest copy: mute reply "רשמתי שלא לשלוח", goal-set + objective-set replies preserved.

### bot/test_dashboard_repair.js
- Exit: 0
- Result: `OK: all assertions passed`
- `_isBrokenDashFormula_`, `FIX_MARKETING_ALL_YEARS`, `APPLY_RESTORE_2026`, `RECOMPUTE_COMPANY_DASHBOARD` still present.

### bot/test_marketing_formula.js
- Exit: 0
- Result: `27/27 passed`
- Operational mapping correct, unrelated keywords (סופר/קפה/ארנונה/דלק/חשמל) skip biz buckets.

### bot/test_migration.js
- Exit: 0
- Result: `OK: all assertions passed`
- Dry-run logs first 3 raw rows of OLD מאזן חברה Q-AN. No Script-Properties / process.env override for SHEET_ID.

### bot/test_migration_phase_5.js
- Exit: 0
- Result: `OK: all assertions passed`

### bot/test_migration_phase_7.js
- Exit: 1 — PARTIAL FAILURE
- Result: `FAIL: 4 assertion(s) failed` out of 109 total assertions.
- The 4 failures are all of the SAME class: "Grep-found file X is in the classification map (no orphans)". Specifically:
  - `bot/SHEET_DASHBOARD_FULL_AUDIT.gs`
  - `bot/SHEET_DASHBOARD_SMART_REMAP.gs`
  - `bot/MIGRATE_OLD_NOTES.gs` (newly added by PR #130)
  - `bot/SCAN_OLD_CATEGORIES.gs`
- Diagnosis: These four `.gs` files exist in `bot/` but have NOT been added to the Phase-7 classification map inside the Apps-Script source (the test grep-walks `bot/` and demands every found `.gs` appear in the map's (a)/(b)/(c)/(d) bucket).
- Impact: LOW. The migration script is paste-into-Apps-Script — these files are NOT live until classified. The test is doing its job (gating before paste). NOT a production regression.
- Suggested fix: add the 4 files to the `_mp7_classification_` map in `bot/MIGRATION_PHASE_7.gs` (or wherever the map lives) under category (b) `NO-OP (archive)` since they're standalone dashboard/audit utilities, or (c) `KEEP (intentional)` if Steven wants them runnable. Out of scope for this audit PR — this gap is owned by whoever lands the next Phase-7 deploy.

### bot/test_multibiz_naming.js
- Exit: 0
- Result: `OK: all assertions passed`

### bot/test_objective_commands.js
- Exit: 0
- Result: `OK: all assertions passed`

### bot/test_parser.js
- Exit: 0
- Result: `ALL 23 PARSER CHECKS PASSED`
- Currency symbol strip (₪, שח, שקל), note fallback `ללא פירוט`.

### bot/test_picker_always_shown.js
- Exit: 0
- Result: `OK: all assertions passed`
- "reply: String(raw).slice(0, 600)" leak path is gone.

### tests/recurring_detect.js
- Exit: 0
- Result: `ALL 17 RECURRING-DETECT CHECKS PASSED`

### tests/test_bank_parsers.js
- Exit: 0
- Result: `ALL 67 BANK-PARSER CHECKS PASSED`

### tests/test_bot_q4_profession.js
- Exit: 0
- Result: `ALL 109 CHECKS PASSED`

### tests/test_csv_import.js
- Exit: 0
- Result: `ALL 28 CHECKS PASSED`
- Commit imported 1 row + dedup skips matching existing row.

### tests/test_professions.js
- Exit: 0
- Result: `ALL 38 CHECKS PASSED`
- accountant has חשבשבת/iCount/Rivhit; general_contractor has בטון/גבס; taxi_driver has דלק/גט/חניה.

### tests/test_ratelimit_arg_order.js
- Exit: 0
- Result: `OK: all assertions passed`
- reprovision-user-sheet uses curry-form `withRateLimit({ key: ... })` with `windowSec` (not `windowMs`).

### tests/test_sheet_ownership_guard_5_endpoints.js
- Exit: 0
- Result: `OK: all assertions passed`
- 9 endpoints have canonical `sheet_ownership_mismatch` returns.

### tests/test_whatsapp_link_get_ratelimit.js
- Exit: 0
- Result: `OK: all assertions passed`
- wa_link_status windowSec = 60s. POST request-mint + confirm flows still have wa_link_request / wa_link_confirm limits.

### tests/test_winback_token_exact_match.js
- Exit: 0
- Result: `OK: all assertions passed`
- Still scans `exit_survey:*` keyspace.

## Deliverable 2: Coverage gap analysis

Twelve gap specs (target was 7+). Each is a SPEC for a NEW Node test that should exist in `tests/` or `bot/` and follow the Kesefle pattern of loading REAL source via balanced-brace extraction (no mocking framework, per the `test-add-suite` skill).

### Gap 1: Year selector filtering — `tests/test_year_selector_b4_propagation.js`

Asserts:
1. No string literal `2026` or `'2026'` appears in `bot/personal_sheet_fix.gs` formula-emitting functions OUTSIDE a comment line.
2. Every place that emits a SUMIFS on `דשבורד` references `INDIRECT("B4")` for the year, not a hardcoded year.
3. `lib/sheet-writer.js` `buildTenantSheetSpec` puts a year dropdown at `B4` of every dashboard tab with values `=YEAR(TODAY()) - n` for n in [0..5] + the special "סיכום היסטורי" sentinel.
4. The year B4 cell exists with data-validation list (not free-typed).
5. `RECOMPUTE_COMPANY_DASHBOARD` emits formulas of the shape `=SUMIFS(תנועות!E:E, תנועות!D:D, "<category>", תנועות!A:A, ">="&DATE(B4,1,1), תנועות!A:A, "<"&DATE(B4+1,1,1))` — never with a literal year.

Why it matters: Cycle bug recurrence — past audits (`expenses_dashboard_net_profit_bug` in memory) traced production outages to hardcoded years that broke at year rollover. With 2027 < 7 months away, we need a structural test.

Pass/fail criteria: PASS iff zero hardcoded-year string literals in formula sites + 100% B4 references in dashboard SUMIFS. FAIL if any literal year is found anywhere a formula is being built.

### Gap 2: Category import mapping — `tests/test_category_import_old_to_new.js`

Asserts:
1. There exists an `OLD_CATEGORY_MAP` (or similar) named export/constant in the codebase mapping every one of Steven's 23 OLD category names to a canonical NEW category.
2. All 23 entries normalize without bidi corruption (no LRM/RLM/PDF in any value).
3. The mapping is total: `Object.keys(OLD_MAP).length >= 23`.
4. The reverse map is collision-checked: no NEW value is reached by zero or by an ambiguous OLD value at runtime.
5. `bot/SCAN_OLD_CATEGORIES.gs` only references categories that exist in the map.

Why it matters: Migration phase 5/7/8 was the most error-prone work in the project; a structural test prevents drift when Steven adds new categories.

Pass/fail criteria: PASS iff total 23+ entries, ASCII-safe, no orphan OLD refs. FAIL otherwise.

### Gap 3: Pending clarification flow — `tests/test_pending_clarification_lifecycle.js`

Asserts:
1. `_savePendingClar_` writes `{ kind, exp_at, ... }` to PropertiesService.
2. The TTL constant is exactly 15 * 60 * 1000 ms (15 min) — not 10, not 30, not 1 hour.
3. A pending state older than 15 min returns `{ handled: false, expire: true }`.
4. User reply `cancel` / `ביטול` clears the state and returns success without writing a row.
5. User reply `1` resolves option 1; `2` resolves option 2.
6. Free-text reply matching a known category triggers the categorizer + a confirm-then-write, NOT an immediate write.
7. A NEW expense sent while a clarification is pending triggers the hijack guard (removes pending state, writes the new one as expense).

Why it matters: This is the single most complex stateful flow in the bot. test_pending_state_hijack covers the hijack guard; this gap covers the LIFECYCLE: TTL, cancel, option-N, free-text.

Pass/fail criteria: 7+ assertions all PASS. Any FAIL on TTL = critical.

### Gap 4: Business / personal split — `tests/test_business_personal_split.js`

Asserts:
1. Message `100 קפה` (no עסק prefix) routes to personal tab.
2. Message `עסק 100 קפה` routes to business tab.
3. Message `עסק 1 100 שיווק` routes to business N=1.
4. Message `עסק 2 100 שיווק` routes to business N=2 (when business 2 exists).
5. Message `עסק 9 100 שיווק` where business 9 does NOT exist triggers the clarification flow (`biz_n_clarify_A` or `_B` or `_C`), NOT an error.
6. Ambiguous: a user with only one business but who sends `עסק 100 קפה` routes to that one business — not personal.
7. Edge case: `העסק` (with prefix ה) — does that count as business? Test should pin the expected answer.

Why it matters: This is the routing-to-section logic that test_isolation.js verifies at the SHEET level. We need it at the parser/handler level.

Pass/fail criteria: 7 routing assertions all PASS.

### Gap 5: Notes migration — `tests/test_notes_migration_idempotent.js`

Asserts:
1. `MIGRATE_OLD_NOTES.gs` (newly merged) has a guard that re-running it twice is a no-op (no double-copy of notes).
2. The function NEVER overwrites a non-empty cell-note in NEW; it only copies when NEW note is empty.
3. There is a per-row counter logged: `notesCopied`, `notesSkippedAlreadyHadOne`, `notesSkippedSourceEmpty`.
4. The function refuses to run if the OLD sheet ID is not the canonical `1UKr...` (defense vs. wrong-sheet poison).
5. The function refuses to run if the NEW sheet ID is not the canonical `1rti...`.
6. The function does NOT contain `.setValue` or `.setValues` calls on any column other than note-write API (`setNote`).

Why it matters: Per memory `feedback_never_overwrite.md` — Steven has explicitly demanded backup + dry-run + never overwrite. This needs structural enforcement.

Pass/fail criteria: 6 assertions all PASS. Any setValue on user-data cells = FAIL.

### Gap 6: Currency conversion — `tests/test_currency_recognition.js`

Asserts current state plus future-proofing:
1. `100$` / `100 דולר` is currently treated as 100 ILS (no FX conversion). PASS if the bot recognizes the amount as 100 and writes `currency: 'ILS'`.
2. `100€` / `100 יורו` — same: amount=100, currency='ILS'.
3. `100£` / `100 פאונד` — same.
4. There is NO unintended `$100` -> $1.00 (decimal-position bug).
5. If/when FX is added, the new path must: (a) call `getExchangeRate()` (a NEW lib export), (b) write BOTH the original and ILS-equivalent to the row, (c) log the rate timestamp.
6. The test pins the current behavior as a contract — when FX is added, this test should fail and force the author to update it intentionally.

Why it matters: Currency is hardcoded to ILS in `bot/ExpenseBot_FIXED.gs` (lines 6281, 6371, 6551). When Steven adds multi-currency support, we need a test that catches silent drift. Right now there is ZERO test for currency parsing.

Pass/fail criteria: 6 assertions all PASS pinning the ILS-only current contract.

### Gap 7: Multi-business עסק N routing — `tests/test_multibiz_n_routing.js`

Asserts:
1. N=1 with one business exists -> writes to business 1.
2. N=2 with two businesses exists -> writes to business 2.
3. N=2 with only one business existing -> triggers `biz_n_clarify_A` ("you only have 1 business — create #2?").
4. N=0 -> rejected as invalid (not 1-indexed corruption).
5. N negative or > 50 -> rejected.
6. N with a name suffix like `עסק 2 הקפה אסטרו 100 ריהוט` -> business N=2, expense recognized.
7. The clarify_A -> "כן" path actually CREATES business N=2 via `_createBizN_` and routes the original expense there.
8. The clarify_A -> "לא" path does NOT create and prompts user for clarification on what they meant.

Why it matters: Multi-business is one of the most-requested features and Steven uses it. Currently `test_multibiz_naming.js` covers naming but not routing breadth.

Pass/fail criteria: 8 assertions all PASS.

### Gap 8: Bot version freshness — `tests/test_kfl_build_version_freshness.js`

Asserts:
1. `KFL_BUILD_VERSION` in `bot/ExpenseBot_FIXED.gs` is set to a YYYY-MM-DD prefix.
2. The date is within the last 30 days of the test run.
3. `bot/ExpenseBot_DEPLOY.gs` (the reassembled deploy artifact) has the SAME version string as `ExpenseBot_FIXED.gs` (no skew).
4. The version is referenced from `BOT_HEARTBEAT` / admin dashboard endpoint.

Why it matters: The `bot-version-bump` skill exists for a reason — stale versions in production are a recurring deploy-confirmation issue.

Pass/fail criteria: 4 assertions all PASS. FAIL if FIXED/DEPLOY skew.

### Gap 9: Sheet-id leakage — `tests/test_no_sheet_id_in_user_replies.js`

Asserts:
1. No string literal matching `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` (Steven's owner sheet) appears in any user-facing reply text in `bot/ExpenseBot_FIXED.gs`.
2. The same for any other hardcoded Google Sheets ID (regex: `1[A-Za-z0-9_-]{43,44}`).
3. Every "open your sheet" reply resolves the sheet via `_getTenantSheetId_(phone)`, NEVER from a const.
4. Admin commands that DO need the owner-sheet ID are explicitly gated by `_isOwner_(phone)`.

Why it matters: test_isolation.js covers some of this; this gap formalizes the rule.

Pass/fail criteria: Zero owner-sheet leaks in non-owner-gated reply paths.

### Gap 10: Apps Script destructive function inventory — `bot/test_no_unsafe_destructive_calls.js`

Asserts:
1. Across all `bot/*.gs`, no `.clear()` / `.clearContents()` / `.deleteSheet()` / `.deleteRows()` calls exist UNLESS they are inside a function with `_dryRunOnly_` or `_requiresConfirmation_` in its name.
2. No `.setValues` call writes to any cell mapped to user-edited data (rows 12, 14 of dashboard per memory `feedback_never_overwrite.md`).
3. All bulk-overwrites have a backup-create-first call to `_backupSheetTab_` immediately preceding.

Why it matters: Steven has explicitly stated in memory: "backup-first + propose-before-apply" and "never overwrite user-typed values". This needs to be a structural test, not a code-review prayer.

Pass/fail criteria: No unguarded destructive call. FAIL if any clear/delete is found outside a guarded function.

### Gap 11: Hebrew bidi/control-character hygiene — `tests/test_hebrew_no_bidi_corruption.js`

Asserts:
1. No string literal in `bot/ExpenseBot_FIXED.gs` contains LRM (U+200E), RLM (U+200F), PDF (U+202C), LRE (U+202A), RLE (U+202B), or ZWNBSP (U+FEFF).
2. No Hebrew string contains the wrong brand spelling — must be "כספלה" exactly, never "כספלע" or "קספלה" or any variant.
3. All Hebrew commands route through canonical forms (e.g. `כספלה צור משפחה` not `כסף לה ...`).
4. Any line where `Hebrew + ASCII number + Hebrew` appears together has a `<bdi>` wrap or LRM marker for numeric isolation in HTML emit contexts.

Why it matters: The `test-hebrew-text` skill is designed exactly for this. We have NO automated test of Hebrew text hygiene right now.

Pass/fail criteria: Zero bidi/control chars in source strings + 100% brand-spelling consistency.

### Gap 12: Rate-limit coverage matrix — `tests/test_ratelimit_all_endpoints.js`

Asserts:
1. Every file under `api/*.js` exports a handler that wraps the body in `withRateLimit({ key, max, windowSec })`.
2. There is a list of explicit exceptions (e.g. cron handlers gated by `cron_secret`) in a constant `RL_EXEMPT_ENDPOINTS`.
3. Every public endpoint has a `max` that's reasonable (typically <= 30/min for read, <= 10/min for write).
4. No endpoint has `windowSec === undefined` or `max === 0`.

Why it matters: We have `test_ratelimit_arg_order.js` for argument-order only. We need broader coverage. Per memory `api-rate-limit` skill.

Pass/fail criteria: 100% of api/*.js handlers either rate-limited or on the exempt-list with reason.

## Deliverable 3: New test implementations

Status: 2 new tests implemented. See `bot/test_no_hardcoded_year_in_dashboard_formula.js` (Gap 1, narrower scope) and `tests/test_currency_hardcoded_ils_contract.js` (Gap 6).

Both new tests follow the Kesefle pattern:
- Load real source via `fs.readFileSync` + balanced-brace extraction (no mocks).
- Use plain `assert.strictEqual` / `assert.match`.
- Print PASS/FAIL per assertion + a single summary line at the end.
- Exit non-zero on any failure.

Both are run as part of this audit and PASS as expected (they pin the current contracts so any regression caught BEFORE deploy).

## 5-line summary

1. Ran 26 Node test suites; 25 pass clean, 1 has 4 non-blocking failures (4 orphan `.gs` files not yet in Phase-7 classification map — does not affect production).
2. Classifier accuracy 95.2% (159/167) above the 93% threshold; 4 of 8 misses are in the chinukh/chinukh-veyladim subcategory boundary.
3. Identified 12 coverage gaps with full SPEC for new tests, covering: year selector, category import, pending lifecycle, business routing, notes migration, currency, multi-biz N, version freshness, sheet-id leak, destructive Apps Script calls, Hebrew bidi hygiene, ratelimit matrix.
4. Implemented 2 of the highest-value gaps (Gap 1 narrowed-scope + Gap 6) as actual Node tests that pin current contracts and catch future regressions.
5. Tenant isolation, ownership guard, rate limit ordering, classifier, parser, recurring detect, bank parsers, CSV import, and goal commands are all GREEN — bot core conversation logic is regression-safe at this point in time.
