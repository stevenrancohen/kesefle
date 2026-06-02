# Workstream 5 — QA + Security + Data Integrity (Read-Only)

Date: 2026-05-29
Agent: kesefle-qa-security-data-integrity-officer (workstream 5)
Branch reviewed: `fix-mdd-sumproduct-year-criterion` (commit `7f38fc5`)
Scope: today's PRs #144 (cell-note year separator), #145 (agents/skills + plan), #146 (MIGRATE_DASHBOARD_FROM_OLD), #149 (label filter), #150 (AUDIT_AND_CLEANUP), #151 (SUMPRODUCT+LEFT fix).

---

## Repo baseline

**`git status`**: clean working tree on `fix-mdd-sumproduct-year-criterion`, up-to-date with origin.

**Last 15 commits** (most recent first):
- `7f38fc5` fix(tool): SUMPRODUCT+LEFT(B,4) for category formulas — bypass Sheets' arithmetic-parsing of "2025-01"
- `fc75d98` Merge PR #150 — AUDIT_AND_CLEANUP_APPENDED
- `9b81388` feat(tool): AUDIT_AND_CLEANUP_APPENDED — diagnose and surgically remove zero-sum rows
- `00520d2` Merge PR #149 — strict label filter
- `87f6c38` fix(tool): label filter — text blocklist only, drop the SUMIFS-only formula check
- `b1955e4` Merge PR #147 — MDD_SELF_TEST visible
- `921ff26` fix(tool): rename _MDD_SELF_TEST_HEBREW_ -> MDD_SELF_TEST_HEBREW (visible in Apps Script dropdown)
- `c11c88f` Merge PR #146 — MIGRATE_DASHBOARD_FROM_OLD
- `6ec875a` feat(tool): MIGRATE_DASHBOARD_FROM_OLD — append OLD-only labels to visible NEW dashboards
- `81b2890` Merge PR #145 — 3 agents + 5 skills + reconciliation plan
- `108b94e` feat(agents+skills): 3 permanent Kesefle agents + 5 reusable skills + category reconciliation plan
- `a32f538` Merge PR #144 — cell-note year separator
- `0e5cf3b` feat(bot): dashboard cell notes — full year in date + === YYYY === year separators
- `2e264e0` Merge PR #143 — sheet diff OLD vs NEW
- `3107f27` Merge PR #139 — LLM profession boost

**Open PRs** (12 total):
| # | Title | Mergeable |
|---|---|---|
| 151 | fix(tool): SUMPRODUCT+LEFT for year filter | MERGEABLE |
| 148 | fix(tool): strict label filter | UNKNOWN (superseded by #149) |
| 131 | bot: backfill 2023-2025 to sikum histori | UNKNOWN |
| 123 | feat(skills): 20 project skills | UNKNOWN |
| 107 | feat(skills): design-from-screenshot | UNKNOWN |
| 106 | feat(skills): steven-unblock-checklist | UNKNOWN |
| 86 | feat(bot): PR-2 menu-first wizard | UNKNOWN |
| 85 | docs: BOT_MENU_FIRST_POLICY | UNKNOWN |
| 84 | fix(admin): light-first by default | UNKNOWN |
| 83 | fix(bot): NL budget-intent guard | UNKNOWN |
| 82 | docs: PROGRESS_DIGEST update | UNKNOWN |
| 81 | feat(goals-v2): PR-G2-cron | MERGEABLE |

---

## Bot assembly + node --check result

```
head -95 bot/ExpenseBot_DEPLOY.gs > /tmp/x.js
tail -n +21 bot/ExpenseBot_FIXED.gs >> /tmp/x.js
node --check /tmp/x.js  →  OK_DEPLOY
grep -c "function doPost" bot/ExpenseBot_DEPLOY.gs  →  1
```

**Verdict: PASS**. Bot deploy file parses cleanly with exactly one `doPost` entry point.

---

## tests/full_qa.js result

```
✅ OFFLINE QA: ALL 118 CHECKS PASSED
```

Covers signup/account, family/group, recurring, receipt OCR, voice, category correction, premium, GDPR delete, budgets cron, push, web-append, bot-query. All offline checks pass; manual end-to-end flows still marked as `☐` (require live env + real phone).

**Verdict: PASS**.

---

## All bot/test_*.js results (26 suites)

| Suite | Result |
|---|---|
| test_b1_income_flag_propagation.js | PASS (49 assertions) |
| test_bot_no_active_lies.js | PASS |
| test_bot_robustness.js | PASS |
| test_botloop.js | PASS (30/30) |
| test_broken_formula.js | PASS (15/15) |
| test_business_order_parser.js | PASS |
| test_category_picker.js | PASS (17/17) |
| test_cell_note_year_separator.js | PASS (14/14) — PR #144 |
| test_classify.js | PASS (118 classification checks) |
| test_dashboard_repair.js | PASS |
| test_destructive_delete_confirm.js | PASS |
| test_eska_prefix_b2.js | PASS |
| test_expanded_category_picker.js | PASS |
| test_goal_commands.js | PASS |
| test_isolation.js | PASS (19/19) |
| test_llm_profession_boost.js | **FAIL** — 1 failed (stale assertion, see below) |
| test_marketing_formula.js | PASS (27/27) |
| test_migration.js | PASS |
| test_multibiz_naming.js | PASS (13/13) |
| test_no_hardcoded_year_in_dashboard_formula.js | PASS |
| test_objective_commands.js | PASS |
| test_parser.js | PASS (23/23) |
| test_pending_state_hijack.js | PASS |
| test_phase_a_v2_uncertainty.js | PASS |
| test_picker_always_shown.js | PASS |
| test_trace_instrumentation.js | PASS |

**Summary: 25 of 26 suites PASS, 1 stale-assertion FAIL.**

### `test_llm_profession_boost.js` failure detail

```js
// line 242-244 of bot/test_llm_profession_boost.js
check('KFL_BUILD_VERSION bumped (date-prefixed)',
  /KFL_BUILD_VERSION\s*=\s*['"]2026-05-28-[\w-]+['"]/.test(SRC),
  'KFL_BUILD_VERSION not bumped or not date-prefixed');
```

Current bot version: `2026-05-29-cell-note-year-separator` (from `bot/ExpenseBot_FIXED.gs` line 62).

The test hardcodes `2026-05-28-` as a date prefix instead of accepting any date-prefix (`2026-MM-DD-`). It was correct on the day it was written (May 28) and went stale when PR #144 bumped the version to May 29.

**Severity: LOW** — this is a test-side regression, not a product regression. The version is correctly bumped, the regex is just too specific.

**Safe fix (additive)**: relax the test regex to match any date prefix. Below in "Safe fixes" section.

---

## Secrets scan

```
grep -rnEi 'AIza[0-9A-Za-z_-]{20,}|sk-[a-zA-Z0-9]{20,}|xox[baprs]-|
   -----BEGIN (RSA|EC|OPENSSH|PRIVATE)|client_secret"?\s*[:=]|
   KESEFLE_BOT_SECRET\s*=\s*["\x27][^"\x27]'
```

Hits in current branch (excluding worktrees and node_modules):

| File:Line | Context | Verdict |
|---|---|---|
| `tests/test_csv_import.js:5` | `process.env.KESEFLE_BOT_SECRET = 'test-' + Date.now()` | SAFE — test-only fixture |
| `tests/test_csv_import.js:10` | `process.env.GOOGLE_CLIENT_SECRET = 'fake'` | SAFE — test-only fixture |
| `lib/sheet-writer.js:1104` | `client_secret: clientSecret` (variable, not literal) | SAFE — reads from env |
| `api/health.js:41` | `google_client_secret: !!process.env.GOOGLE_CLIENT_SECRET` | SAFE — boolean health probe, never leaks value |
| `api/account.js:58` | `client_secret: clientSecret` | SAFE — reads from env |
| `api/auth/google-exchange.js:99` | `client_secret: clientSecret` | SAFE — reads from env |
| `api/sheet/getExpenses.js:33` | `client_secret: clientSecret` | SAFE — reads from env |
| `api/sheet/summary.js:30` | `client_secret: clientSecret` | SAFE — reads from env |
| `api/whatsapp/webhook.js:460` | `client_secret: clientSecret` | SAFE — reads from env |
| `api/cron/kv-backup.js:114` | `client_secret: clientSecret` | SAFE — reads from env |

**Worktrees** (`.claude/worktrees/agent-a08b431f9934bfe88/`, `.claude/worktrees/agent-a1f175a47e63cb111/`): each has the same 8 `client_secret` field-name hits as main; all reads-from-env. No raw secret strings.

**Verdict: ZERO real findings.** No hardcoded API keys, OAuth secrets, private keys, or bot secrets in source. All `client_secret` occurrences are OAuth POST-body field names with values sourced from `process.env`.

---

## Tenant isolation

Callers of `appendRowToUserSheet` / `appendRowToTab`:

| Caller | Token source | Verdict |
|---|---|---|
| `api/sheet/append.js:179` | `userRecord` constructed at line 151 from `user:{userSub}` (refresh token) + `sheet:{userSub}` (canonical spreadsheetId) + cross-writer alert if `userSub` set in `sheetwriters:{spreadsheetId}` ever grows past 1 — calls Slack | SAFE |
| `api/sheet/web-append.js:88` | `userRecord` constructed at line 67 from `user:{userSub}` via `kvGet('user:' + userSub)` at line 58 | SAFE |
| `api/recurring.js:218` | `resolved.userRecord` from `resolveTenantWriteRecord` (line 177) which: (a) reads `phone:{E164}` → gets `userSub`; (b) reads `sheet:{userSub}` → gets canonical spreadsheetId; (c) reads `user:{userSub}` → gets refresh token; (d) rejects with `sheet_ownership_mismatch` if `phoneRec.spreadsheetId` disagrees with canonical | SAFE |
| `api/group.js:84` | `appendRowToTab` called with `userRec` from `kvGet('user:' + phoneRec.userSub)` line 42 | SAFE |

**Note on `api/recurring.js`**: variables named `userRecord` at lines 323/354/399 actually hold the `phone:{E164}` record — misleading naming, but the actual write goes through `logOccurrence` → `resolveTenantWriteRecord` which re-resolves through `user:{userSub}`. Functionally safe; readability nit only.

**Verdict: PASS** — no tenant-isolation regression. All four append callers source the refresh token from `user:{userSub}` and the spreadsheetId from `sheet:{userSub}` (with cross-writer-alert guard on the main append path).

---

## Destructive function inventory

| File | Line | Function | Gated? | Backup? | Risk |
|---|---|---|---|---|---|
| `bot/AUDIT_AND_CLEANUP_APPENDED.gs` | 262, 266 | `personal.deleteRow / biz.deleteRow` | YES — `CONFIRM_CLEANUP_APPENDED = "YES I UNDERSTAND"` Script Property gate + dedicated `DRY_RUN_CLEANUP_APPENDED` reviewer fn | YES — full row snapshot (values + formulas, col A-N) saved to `DocumentProperties.aac_backup_{stamp}` before any delete | LOW |
| `bot/BOT_COMMANDS.gs` | 291, 331 | `ctx.sheet.deleteRow / sh.deleteRow` | YES — user-initiated WhatsApp command after pending-confirmation flow (per `test_destructive_delete_confirm.js`) | NO — single-row delete on user "מחק אחרון" command | LOW |
| `bot/EMBEDDING_FALLBACK.gs` | 182 | `sh.clearContents()` | N/A — operates on `_EMBED_CACHE_TAB_NAME` hidden cache tab, not user data | NO — cache is a derived artifact rebuilt from תנועות | LOW |
| `bot/MIGRATE_DASHBOARD_FROM_OLD.gs` | 434, 438 | `newPersonal.deleteRows / newBiz.deleteRows` | YES — only in the `UNDO_MIGRATION` reversal path; restores prior backup snapshot | YES — operation paired with `_mdd_backup_{stamp}` restore | LOW |
| `bot/personal_sheet_fix.gs` | 1815 | `ss.deleteSheet(existing)` | YES — deletes only a previously-created `_backup_*` hidden snapshot tab, immediately before creating a new one | YES — this IS the backup-create step | LOW |
| `bot/ExpenseBot_FIXED.gs` | 1603 | `sh.deleteRow(lastRow)` | YES — gated behind `_handleDeleteLast_` requiring user-side confirmation token | NO — last-row delete, user-initiated | LOW |
| `bot/ExpenseBot_FIXED.gs` | 3021 | `sheet.deleteRow(last)` | YES — same pattern, last-row on customer order tab | NO | LOW |
| `bot/ExpenseBot_FIXED.gs` | 10639 | `sh.deleteRow(rowNumber)` | YES — user-initiated "מחק זיכרון X" against `_LEARNED_TAB_NAME` (learned-memory only, not user data) | NO | LOW |
| `bot/ExpenseBot_FIXED.gs` | 10654 | `sh.deleteRows(2, count)` | YES — user-initiated "נקה זיכרון" against `_LEARNED_TAB_NAME` (learned-memory only) | NO | LOW |
| `bot/ExpenseBot_FIXED.gs` | 10724 | `sheet.deleteRow(lastRow)` | YES — alternate code path for "מחק אחרון" | NO | LOW |

**ExpenseBot_DEPLOY.gs lines 1678 / 3096 / 10714 / 10729 / 10799**: identical to the FIXED-side hits, reflected through assembly. No new risk surface.

**Verdict: PASS** — every destructive call falls into one of three safe categories:
1. **APPLY-gate + backup-first** (MIGRATE, AUDIT_AND_CLEANUP, personal_sheet_fix's hidden-tab swap)
2. **User-initiated WhatsApp command with confirm gate** (BOT_COMMANDS, ExpenseBot delete-last + learned-memory clears)
3. **Derived cache rebuild** (EMBEDDING_FALLBACK on hidden cache tab)

No silent-deletion live code paths.

---

## Hardcoded year scan

```
grep -rnE '"2026-(0[1-9]|1[0-2])"|"2025-(0[1-9]|1[0-2])"|"2024-(0[1-9]|1[0-2])"'
```

Live-code hits (excluding `test_*`, `node_modules`, worktrees):

| File:Line | Context | Verdict |
|---|---|---|
| `api/sheet/tax-report.js:21` | `// byMonth: { "2026-01": 1200, "2026-02": 800, ... }` | COMMENT — safe |
| `bot/personal_sheet_fix.gs:766` | `// filters תנועות by month key (e.g. "2026-05")` | COMMENT — safe |
| `bot/MIGRATE_DASHBOARD_FROM_OLD.gs:185-187` | `// '">=" & $B$4 & "-01"' gets parsed as arithmetic — Sheets evaluates the "2025-01" tail as subtraction (2024)...` | COMMENT — documents the bug PR #151 fixes |
| `bot/ExpenseBot_DEPLOY.gs:10762` | `// Column B can be either a String "2026-05" or a Date` | COMMENT — safe |
| `bot/ExpenseBot_FIXED.gs:10687` | `// Column B can be either a String "2026-05" or a Date` | COMMENT — safe |
| `bot/VALIDATE_NO_HARDCODED_YEAR.js:72, 77` | `// hyphen) so we hit SUMIFS month-keys like "2026-05" ...` and `// 'תנועות'!B:B,"2026-05"` | COMMENT — validator's own doc |

**Verdict: PASS** — zero hardcoded-year data-affecting hits. All matches are comments explaining month-key formats or the recently-fixed bug. The validator script `bot/VALIDATE_NO_HARDCODED_YEAR.js` exists specifically to catch this category of regression.

---

## Agents present

3 permanent kesefle agents, all with valid YAML frontmatter (`---` opener, `name:`, `description:`, `model: opus`, `tools: ...`):

| File | Name |
|---|---|
| `.claude/agents/kesefle-cto-product-architect.md` | kesefle-cto-product-architect |
| `.claude/agents/kesefle-migration-and-sheet-formula-agent.md` | kesefle-migration-and-sheet-formula-agent |
| `.claude/agents/kesefle-qa-security-data-integrity-officer.md` | kesefle-qa-security-data-integrity-officer (this workstream) |

All shipped in commit `108b94e` (PR #145).

---

## Skills present

22 kesefle-* skills under `.claude/skills/`. The 5 created today in PR #145 (commit `108b94e`):

1. kesefle-adaptive-category-profile-builder
2. kesefle-autonomous-deep-audit-runner
3. kesefle-bot-sheet-dashboard-sync-checker
4. kesefle-financial-data-integrity-guard
5. kesefle-sheet-formula-year-selector-validator

Plus 3 more added earlier in the same day's session (commit `8fc13a7`):

6. kesefle-bot-decision-trace
7. kesefle-bot-replay
8. kesefle-bot-self-heal-check

All 22 SKILL.md files start with `---` (valid frontmatter delimiter). Spot-checking: `kesefle-financial-data-integrity-guard/SKILL.md`, `kesefle-bot-sheet-dashboard-sync-checker/SKILL.md`, and `kesefle-sheet-formula-year-selector-validator/SKILL.md` are all picked up by this conversation's skill index.

Full list:
```
kesefle-adaptive-category-profile-builder
kesefle-admin-health-check
kesefle-apps-script-safety-audit
kesefle-autonomous-deep-audit-runner
kesefle-bot-conversation-audit
kesefle-bot-decision-trace
kesefle-bot-replay
kesefle-bot-self-heal-check
kesefle-bot-sheet-dashboard-sync-checker
kesefle-category-profile-audit
kesefle-daily-improvement-report
kesefle-dashboard-financial-audit
kesefle-financial-data-integrity-guard
kesefle-formula-validator
kesefle-link-checker
kesefle-migration-dry-run-validator
kesefle-monday-sync
kesefle-regression-runner
kesefle-security-privacy-audit
kesefle-sheet-audit
kesefle-sheet-formula-year-selector-validator
kesefle-user-template-audit
```

---

## PR #151 verification

| Check | Expected | Actual | Verdict |
|---|---|---|---|
| Line count of `bot/MIGRATE_DASHBOARD_FROM_OLD.gs` | 455 | 455 | PASS |
| Contains `SUMPRODUCT` | yes | 8 occurrences | PASS |
| Contains `LEFT(' + tx + '!B2:B2000,4)` | yes | line 211 | PASS |
| Contains the old broken `">=" & $B$4 & "-01"` pattern | NO in active code | 1 hit at line 184 — INSIDE A COMMENT documenting the bug fix | PASS (commentary only) |

PR #151 is the correct surgical fix: replaces SUMIFS-with-text-arithmetic-criterion with SUMPRODUCT+LEFT(B,4)=year. The pattern that broke "2025-01" → arithmetic-evaluated-as-2024 is now isolated to the explanatory comment.

---

## Severity-tagged findings

| Severity | Finding | Recommendation |
|---|---|---|
| **LOW** | `bot/test_llm_profession_boost.js:242-244` hardcodes the date prefix `2026-05-28-` in the KFL_BUILD_VERSION regex, fails after bot version bump to `2026-05-29-...` | Relax regex to `/2026-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])-[\w-]+/` (any 2026 date prefix). Safe additive change; doesn't relax the underlying assertion (version is still date-prefixed). |
| **LOW (nit)** | `api/recurring.js` lines 323, 354, 399 name the `phone:{E164}` record `userRecord`, which is misleading — actual user record is resolved inside `logOccurrence` via `resolveTenantWriteRecord`. | Rename callsite variables to `phoneRec` to match the resolver's parameter name. No behavior change. Defer to a cleanup PR. |
| **INFO** | 11 open PRs have mergeable status `UNKNOWN` per `gh pr list`. May indicate stale base or pending GitHub computation. | Re-trigger by rebasing or pushing an empty commit on each. Not in scope for this workstream. |
| **INFO** | The 5 PRs in scope (#144, #145, #146, #149, #150) are all already merged to main (visible in commit history `0e5cf3b`, `108b94e`, `6ec875a`, `87f6c38`, `9b81388`). PR #151 is still open and mergeable. | PR #151 is safe to merge per the integrity checks above. |

---

## Safe fixes

Read-only workstream — no writes to main. The one safe additive change identified:

### Fix #1: relax `test_llm_profession_boost.js` regex (LOW)

**File**: `bot/test_llm_profession_boost.js`
**Diff** (suggestion, not applied):

```diff
-check('KFL_BUILD_VERSION bumped (date-prefixed)',
-  /KFL_BUILD_VERSION\s*=\s*['"]2026-05-28-[\w-]+['"]/.test(SRC),
-  'KFL_BUILD_VERSION not bumped or not date-prefixed');
+// Accept any 2026 date prefix — the original intent was "bumped AND date-prefixed",
+// not "the exact day this test was authored on".
+check('KFL_BUILD_VERSION bumped (date-prefixed)',
+  /KFL_BUILD_VERSION\s*=\s*['"]2026-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])-[\w-]+['"]/.test(SRC),
+  'KFL_BUILD_VERSION not bumped or not date-prefixed');
```

**Why safe**: tightens nothing, just makes the test resilient to legitimate version bumps. Same pattern as `test_picker_always_shown.js` and `test_pending_state_hijack.js` which use loose date matching.

**Where to land**: draft PR after this review, separate from the in-flight migration work.

---

## 5-bullet summary

- **Regression status: clean.** 25 of 26 bot test suites and tests/full_qa.js (118/118) all pass against the current branch `fix-mdd-sumproduct-year-criterion`. The one failure (`test_llm_profession_boost.js`) is a stale-assertion bug in the test itself — the test hardcoded `2026-05-28-` instead of accepting any date prefix, then PR #144 legitimately bumped the version to `2026-05-29-cell-note-year-separator`. Not a product regression.

- **Security: clean.** Zero real secrets in source. All ten `client_secret` matches are OAuth field-name strings reading from `process.env`. Bot deploy file (`ExpenseBot_DEPLOY.gs`) reassembles cleanly with `node --check` and has exactly one `doPost`. Tenant-isolation chain holds across all four `appendRowToUserSheet` / `appendRowToTab` callers (`api/sheet/append.js`, `api/sheet/web-append.js`, `api/recurring.js`, `api/group.js`) — every write resolves the refresh token from `user:{userSub}` and the spreadsheetId from `sheet:{userSub}`, with `sheet_ownership_mismatch` guard.

- **Destructive-function inventory: safe.** All 18 destructive calls (`deleteRow`, `deleteRows`, `deleteSheet`, `clearContents`) across `bot/*.gs` either (a) are gated by `CONFIRM = "YES I UNDERSTAND"` script-property + DocumentProperties backup (`AUDIT_AND_CLEANUP_APPENDED`, `MIGRATE_DASHBOARD_FROM_OLD`), (b) are user-initiated WhatsApp commands with a confirm-flow (`ExpenseBot_FIXED` delete-last + learned-memory clears), or (c) target derived cache artifacts only (`EMBEDDING_FALLBACK`, hidden `_backup_*` swap). No silent destructive paths.

- **PR #151 verified.** `bot/MIGRATE_DASHBOARD_FROM_OLD.gs` is 455 lines, contains 8 SUMPRODUCT occurrences plus the `LEFT(tx!B2:B2000,4)` bounded-range year filter at line 211. The only remaining `">=" & $B$4` hit is the comment block at lines 184-187 explaining why the previous SUMIFS formula was broken — that's correct documentation, not leftover broken code. Zero hardcoded "YYYY-MM" hits in any live-code path (all hits are in comments documenting month-key formats).

- **Agents + skills + reconciliation plan landed cleanly.** All 3 permanent agents (`.claude/agents/kesefle-cto-product-architect.md`, `kesefle-migration-and-sheet-formula-agent.md`, `kesefle-qa-security-data-integrity-officer.md`) have valid YAML frontmatter with `model: opus` and explicit `tools:` arrays. All 22 kesefle skills under `.claude/skills/` carry the `---` frontmatter delimiter; the 5 new ones from today (PR #145) are present and well-formed; 3 more bot-* skills (PR-merged via commit `8fc13a7`) are also present. The only follow-up: ship the one-line regex relaxation in `bot/test_llm_profession_boost.js` to keep the gauntlet green after each version bump. **Workstream verdict: SAFE TO MERGE PR #151.**
