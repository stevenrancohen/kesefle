# QA Run Report — Autonomous Audit Block 2026-05-28

**Branch**: `audit-autonomous-2026-05-28`
**Block duration**: 95-minute autonomous deep-work block (Steven offline)
**Scope**: full regression gauntlet + coverage gap analysis
**Hard rule**: no destructive actions, no live writes, no production switches

---

## 1. Regression results — summary

| Metric | Value |
|---|---|
| Total suites run | 33 |
| Passing | 32 |
| Failing | 1 |
| Pass rate | 96.97% |
| Full QA total checks | 118 / 118 ✅ |
| Classifier checks | 118 / 118 ✅ |
| Golden set accuracy | 95.2% (159/167, threshold 93%) ✅ |

---

## 2. Per-suite results

| Suite | Result |
|---|---|
| `tests/full_qa.js` | ✅ ALL 118 CHECKS PASSED |
| `bot/test_pending_state_hijack.js` | ✅ all assertions passed |
| `bot/test_trace_instrumentation.js` | ✅ all assertions passed |
| `bot/test_phase_a_v2_uncertainty.js` | ✅ all assertions passed |
| `bot/test_business_order_parser.js` | ✅ all assertions passed |
| `bot/test_bot_robustness.js` | ✅ all assertions passed |
| `bot/test_category_picker.js` | ✅ Category picker QA: ALL 17 PASSED |
| `bot/test_botloop.js` | ✅ 30 pass, 0 fail |
| `bot/test_broken_formula.js` | ✅ 15 pass, 0 fail |
| `bot/test_destructive_delete_confirm.js` | ✅ all assertions passed |
| `bot/test_expanded_category_picker.js` | ✅ all assertions passed |
| `bot/test_isolation.js` | ✅ ALL 19 CHECKS PASSED |
| `bot/test_bot_no_active_lies.js` | ✅ all assertions passed |
| `bot/test_classify.js` | ✅ ALL 118 CLASSIFICATION CHECKS PASSED |
| `tests/golden_set.js` | ✅ GOLDEN SET PASSED (95.2%) |
| `tests/test_bank_parsers.js` | ✅ ALL 67 BANK-PARSER CHECKS PASSED |
| `tests/test_csv_import.js` | ✅ ALL 28 CHECKS PASSED |
| `tests/test_ratelimit_arg_order.js` | ✅ all assertions passed |
| `tests/test_whatsapp_link_get_ratelimit.js` | ✅ all assertions passed |
| `tests/test_professions.js` | ✅ ALL 38 CHECKS PASSED |
| `tests/test_sheet_ownership_guard_5_endpoints.js` | ✅ all assertions passed |
| `tests/test_bot_q4_profession.js` | ✅ ALL 109 CHECKS PASSED |
| `tests/recurring_detect.js` | ✅ ALL 17 PASSED |
| `bot/test_parser.js` | ✅ ALL 23 PARSER CHECKS PASSED |
| `bot/test_marketing_formula.js` | ✅ 27/27 passed |
| `bot/test_picker_always_shown.js` | ✅ all assertions passed |
| `bot/test_migration.js` | ✅ all assertions passed |
| `bot/test_multibiz_naming.js` | ✅ 13/13 passed |
| `bot/test_objective_commands.js` | ✅ all assertions passed |
| `bot/test_goal_commands.js` | ✅ all assertions passed |
| `bot/test_migration_phase_5.js` | ✅ all assertions passed |
| **`bot/test_migration_phase_7.js`** | ❌ **4 assertions failed** |
| `bot/test_dashboard_repair.js` | ✅ all assertions passed |

---

## 3. The one failure — `bot/test_migration_phase_7.js`

This test was added by an earlier migration-phase agent and asserts that **no `.gs` file in `bot/` contains the OLD sheet ID `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` in a non-comment context**.

The test fails because today the OLD sheet ID still appears literally in **~12 utility `.gs` files** (config.gs, EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs, DASHBOARD_QUICK_WINS.gs, FINANCIAL_SUMMARY_TAB_CLEAN.gs, etc.) — these are one-off helper scripts Steven used during the OLD-sheet era, never tenant-aware.

**Why it's not critical**:
- `bot/ExpenseBot_FIXED.gs` and `bot/ExpenseBot_DEPLOY.gs` (the actually-deployed bot) have already switched to NEW sheet ID (`1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A`) at line 100 of DEPLOY.gs
- The 12 utility files would only be hazardous if Steven ran them; the bot does not invoke them
- `MIGRATE_OLD_TO_KESEFLE.gs` legitimately needs both IDs (source + target)
- `MIGRATE_OLD_NOTES.gs` same
- `SCAN_OLD_CATEGORIES.gs` same (read-only)

**Why it should still be fixed**:
- If Steven ever runs `SIMPLE_FIX_DASHBOARD()` or `FIX_NOW()` from one of those utilities, it would write to the OLD sheet, polluting his historical data
- Hard-coded refs to ONE user's personal sheet (Steven's own) make those scripts un-shareable as templates

**Remediation (Steven approves, agent ships)**:
1. Add a `// eslint-disable-line` and explicit `// SAFE_ONLY_FOR_STEVEN` marker to the 12 utility files OR
2. Delete the utility files now that the NEW migration is complete OR
3. Rename them to `*.gs.archive` so they're no longer parsed by Apps Script
4. Update `test_migration_phase_7.js` to allow comments + explicit `// MIGRATION_TOOL` markers

Recommended: option 3 (rename to `.gs.archive`) — it's reversible and immediately makes the test pass.

---

## 4. Coverage gap analysis

Tests currently MISSING that should exist before the OLD→NEW migration is declared "done":

### Gap 1: Year selector filtering test
- **Spec**: For each year 2023/24/25/26, assert that `מאזן אישי!B4=<year>` produces a dashboard where every monthly sum equals the corresponding `SUMIFS(תנועות!C:C, תנועות!B:B, "<year>-MM", תנועות!E:E, $A<row>)`.
- **Why it matters**: Steven's "view 2025 in dashboard" UX depends on this — a regression would silently show wrong year data.
- **Pass criteria**: 12 monthly cells × 4 years × 2 dashboards = 96 cells reconcile within ₪1.

### Gap 2: No-hardcoded-2026 source-code test
- **Spec**: Grep `bot/*.gs` + `bot/personal_sheet_fix.gs` + `lib/sheet-writer.js` for literal `"2026-"` / `DATE(2026,` / `YEAR(2026)` outside of test fixtures and comments. Fail if any found.
- **Why it matters**: Once Steven ages into 2027, hardcoded 2026 silently shows stale data.
- **Pass criteria**: 0 matches.

### Gap 3: Category import OLD→NEW mapping test
- **Spec**: For Steven's 23 OLD categories (`docs/PERSONALIZED_CATEGORY_PROFILES.md` table), assert each maps to a known normalized name + group + activation rule.
- **Why it matters**: A typo in the normalization map silently drops a category and Steven's history disappears.
- **Pass criteria**: 23 → 23 mapping, every entry has all 4 required fields.

### Gap 4: Pending clarification flow integration test
- **Spec**: Simulate this sequence: bot writes pending state → user sends "1" (option 1) → bot consumes pending + writes row. Then: same setup → user sends "ביטול" → pending cleared, no row. Then: same setup → 16 min passes → pending expires, no row.
- **Why it matters**: PR #67 + Steven 2026-05-28 bug-fix both depend on this resolver path. A regression silently double-writes or drops messages.
- **Pass criteria**: 3 scenarios produce correct write/skip behavior.

### Gap 5: Business/personal split via `עסק` prefix
- **Spec**: For each test message in the audit corpus, assert that the `עסק`-prefixed variant routes to `מאזן חברה` + a business category, while the non-prefixed variant routes to `מאזן אישי` + personal category. Edge case: `עסק 35 שיווק` vs `35 שיווק`.
- **Why it matters**: Multi-business Steven has 2+ businesses; ambiguity in this routing would mix personal + business totals.
- **Pass criteria**: ≥ 10 paired messages, each pair routes correctly.

### Gap 6: Notes migration idempotency
- **Spec**: Run `MIGRATE_OLD_NOTES.gs` simulation twice. Assert second run reports "0 to copy (already migrated)" and does NOT overwrite any existing note.
- **Why it matters**: Steven's discipline rule says never overwrite. The note migration must be idempotent.
- **Pass criteria**: Run 1 copies N notes. Run 2 copies 0. No diff in NEW sheet between Run 1 and Run 2.

### Gap 7: Currency conversion bot reads
- **Spec**: For messages `100$`, `50€`, `30£` → assert bot extracts ILS-equivalent amount + writes the rate used in a hidden col. For untrusted external rate failures → fall back to last cached.
- **Why it matters**: Steven wants currency-rate parity with the new dashboard cards. Bot must not silently mis-convert.
- **Pass criteria**: 3 currency symbols × 2 amounts = 6 assertions.

### Gap 8: Multi-business `עסק N` routing scalability
- **Spec**: `עסק 1 שיווק 100`, `עסק 2 חומרים 200`, `עסק 3 משלוח 50` — assert each routes to its own business tab/section. `עסק 9 שיווק` (no biz 9 exists) → bot asks "פתיחת עסק 9?" with confirm button.
- **Why it matters**: Steven has עסק 1 + עסק 2 today; adding עסק 3 must not break either.
- **Pass criteria**: 3 known biz + 1 unknown biz = 4 routing outcomes correct.

### Gap 9: Webhook signature verification across all webhook endpoints
- **Spec**: For each `api/billing/*-webhook.js`, `api/whatsapp/webhook.js`, anonymous-test the endpoint with a mangled signature header. Assert 401/403.
- **Why it matters**: PayPal/Coinbase/Meta webhook spoofing → unauthorized PRO upgrades or fake expense rows.
- **Pass criteria**: 4 webhook endpoints reject mangled sigs.

### Gap 10: KV usage growth budget
- **Spec**: Assert `lib/kv-usage.js` writes stay below 80% of Upstash free-tier quota. Simulated 100 signups + 100 expense writes — count KV calls.
- **Why it matters**: Steven declined paid Upstash. KV ceiling is a real launch blocker.
- **Pass criteria**: Per-signup KV calls < threshold (defined in `lib/kv-usage.js`).

---

## 5. Recommendations (priority order)

1. **Land Gap 1 + Gap 2 immediately** — they cover the year-selector regression Steven cares about most
2. **Fix the test_migration_phase_7 failure** via option 3 (rename utility .gs to .gs.archive)
3. **Land Gap 4 (pending clarification)** — Steven hit this bug today; a test prevents recurrence
4. **Defer Gap 5-10** to follow-up audit blocks

---

## 6. Commands run

```
node tests/full_qa.js                       # PASS 118/118
node bot/test_classify.js                   # PASS 118/118
node tests/golden_set.js                    # PASS 95.2%
node bot/test_pending_state_hijack.js       # PASS
node bot/test_trace_instrumentation.js      # PASS
node bot/test_phase_a_v2_uncertainty.js     # PASS
node bot/test_business_order_parser.js      # PASS
node bot/test_bot_robustness.js             # PASS
node bot/test_category_picker.js            # PASS 17/17
node bot/test_botloop.js                    # PASS 30/30
node bot/test_broken_formula.js             # PASS 15/15
node bot/test_destructive_delete_confirm.js # PASS
node bot/test_expanded_category_picker.js   # PASS
node bot/test_isolation.js                  # PASS 19/19
node bot/test_bot_no_active_lies.js         # PASS
node tests/test_bank_parsers.js             # PASS 67/67
node tests/test_csv_import.js               # PASS 28/28
node tests/test_ratelimit_arg_order.js      # PASS
node tests/test_whatsapp_link_get_ratelimit.js # PASS
node tests/test_professions.js              # PASS 38/38
node tests/test_sheet_ownership_guard_5_endpoints.js # PASS
node tests/test_bot_q4_profession.js        # PASS 109/109
node tests/recurring_detect.js              # PASS 17/17
node bot/test_parser.js                     # PASS 23/23
node bot/test_marketing_formula.js          # PASS 27/27
node bot/test_picker_always_shown.js        # PASS
node bot/test_migration.js                  # PASS
node bot/test_multibiz_naming.js            # PASS 13/13
node bot/test_objective_commands.js         # PASS
node bot/test_goal_commands.js              # PASS
node bot/test_migration_phase_5.js          # PASS
node bot/test_migration_phase_7.js          # FAIL 4 assertions
node bot/test_dashboard_repair.js           # PASS
```

---

## 7. Sign-off

- **Run by**: foreground worker in autonomous audit block 2026-05-28
- **No destructive actions taken**
- **No live writes**
- **No production switches**
- **No secret values disclosed**
- **PR-ready**: this report + 14 skill specs + 8 agent-produced docs land together in `audit-autonomous-2026-05-28`
