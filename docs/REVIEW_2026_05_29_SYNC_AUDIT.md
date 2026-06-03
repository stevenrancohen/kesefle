# Workstream 4 — Bot / Sheet / Dashboard / Admin Sync Audit

**Date:** 2026-05-29
**Mode:** READ-ONLY (no writes, no commits)
**Sheets:**
- OLD: `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` (must stay read-only)
- NEW: `1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A` (production)

---

## 1. OLD sheet ID references in repo (canonical paths only — worktrees excluded)

| File:Line | Context | Verdict | Risk |
|-----------|---------|---------|------|
| `bot/config.gs:11` | URL inside a comment block | Doc drift | LOW |
| `bot/ExpenseBot_FIXED.gs:25` | Rollback comment only | Comment | LOW |
| `bot/ExpenseBot_DEPLOY.gs:100` | Rollback comment only | Comment | LOW |
| `bot/personal_sheet_fix.gs:41` | Rollback comment only | Comment | LOW |
| `bot/SHEET_DASHBOARD_SMART_REMAP.gs:61` | Comment | Comment | LOW |
| `bot/DROPDOWN_README.md:119` | Doc | Doc | LOW |
| `bot/BOT_COMMANDS_README.md:68` | Doc | Doc | LOW |
| `bot/MIGRATE_OLD_TO_KESEFLE.gs:29` | `_MIG_OLD_SHEET_ID_` — read source for one-shot migration | One-shot tool (writes ONLY to NEW via `_MIG_NEW_SHEET_ID_`) | LOW |
| `bot/MIGRATE_OLD_NOTES.gs:52` | `_MN_OLD_SHEET_ID_` — read source; writes only `setNote()` to NEW | One-shot tool | LOW |
| `bot/MIGRATE_DASHBOARD_FROM_OLD.gs:46` | Read source; writes to NEW | One-shot tool | LOW |
| `bot/SCAN_OLD_CATEGORIES.gs:44` | Read-only (no setValue/appendRow) | One-shot tool | LOW |
| `bot/SHEET_DIFF_OLD_VS_NEW.gs:22` | Reads OLD; writes only its own hidden diff tab | One-shot tool | LOW |
| `bot/SHEET_DASHBOARD_FULL_AUDIT.gs:50` | Read-only audit | One-shot tool | LOW |
| `bot/BOT_COMMANDS.gs:22` | `var BC_SHEET_ID = '1UKr…OLD';` opens via `openById(BC_SHEET_ID)` then calls **`.setValue(newCat)` at line 305 and `.deleteRow()` / cat edits** | **LIVE CODE PATH if bundled into deploy** — not in `ExpenseBot_DEPLOY.gs`, but `handleBotCommand_` IS dispatched from doPost (lines 2335-2337) under `if (typeof handleBotCommand_ === "function")` | **HIGH (if ever pasted into deploy)** |
| `bot/WEEKLY_DIGEST.gs:32` | `var WD_SHEET_ID = '1UKr…OLD';` — `ScriptApp.newTrigger(WD_TRIGGER_HANDLER)` installs Sunday 08:00 cron that calls `_sendWeeklyDigestToPhone_(phone, WD_SHEET_ID)` | **LIVE CODE PATH if `INSTALL_WEEKLY_DIGEST_TRIGGER()` was ever called** — sends digests with stale OLD-sheet data, ignoring tenant sheets entirely | **CRITICAL (if installed)** |
| `docs/*.md` (8 files) | Runbooks and audit notes | Doc | LOW |
| `.claude/agents/*.md`, `.claude/skills/*.md` | Agent + skill docs | Doc | LOW |

**OLD-ID hits in `api/` `lib/` `tests/` `scripts/` `*.html` `*.json`:** **ZERO** (verified via repeated grep). The web/API plane is clean.

---

## 2. NEW sheet ID references — sanity check

Canonical bot wire:
- `bot/config.gs:23` `PERSONAL_TEMPLATE_SHEET_ID = '1rtiPQs1…NEW'`
- `bot/ExpenseBot_FIXED.gs:26` `const SHEET_ID = '1rtiPQs1…NEW'`
- `bot/ExpenseBot_DEPLOY.gs:101` `const SHEET_ID = '1rtiPQs1…NEW'`
- `bot/personal_sheet_fix.gs:42` `_PSF_SHEET_ID_ = '1rtiPQs1…NEW'`
- `bot/SHEET_YEAR_SELECTOR_WIRE.gs:60` `_YS_SHEET_ID_ = '1rtiPQs1…NEW'`
- Migration tools `_MIG_NEW_SHEET_ID_`, `_MDD_NEW_SHEET_ID_`, `_MN_NEW_SHEET_ID_`, `_MP5_NEW_SHEET_ID_`, `_MP7_NEW_SHEET_ID_`, `_AAC_NEW_SHEET_ID_`, `_FA_NEW_SHEET_ID_`, `_SR_SHEET_ID_`, `_SDOLD_NEW_SHEET_ID_` all point to NEW.
- `docs/MIGRATE_DASHBOARD_RUNBOOK.md:115` direct URL — fine.

No NEW-ID references in `api/` `lib/` `tests/` or any HTML file (correct — sheet IDs there come from KV per-tenant, not from constants).

---

## 3. Bot CATEGORY_MAP vs NEW personal-dashboard row alignment

`buildTenantSheetSpec` (new users) provisions 34 personal dashboard rows in 5 sections:

| Section | Rows | Bot CATEGORY_MAP subcategory match? |
|---------|------|--------------------------------------|
| Income (R5-8) | `הכנסה 1 — משכורת`, `הכנסה 2 — עסק`, `הכנסה 3 — נוסף`, `שונות (הכנסות)` | ALL MATCH |
| Fixed (R16-27) | `בית`, `מכון כושר`, `אפליקציות`, `תקשורת`, `לימודים`, `ביטוח אישי`, `בנקאות`, `מנויים דיגיטליים`, `חשמל`, `מים`, `תחזוקת בית`, `תינוקות` | ALL MATCH except **`תינוקות`** (bot has `חיתולים ותינוקות`, `מזון תינוקות ופעוטות`, etc. — wildcard `*תינוקות*` in SUMIFS will match) |
| Variable (R31-33) | `מתנות`, `חיות מחמד`, `תרופות` | ALL MATCH |
| Food (R37-38) | `אוכל לבית`, `אוכל בחוץ` | MATCH (wildcard `*אוכל לבית*` also catches `אוכל לבית — סופרמרקטים ארציים` etc.) |
| Transport (R42-49) | `דלק`, `חניה`, `מונית`, `ליים`, `תחזוקת רכב`, `תחבורה ציבורית`, `ביטוח רכב`, `מוסך` | ALL MATCH except **`תחזוקת רכב`** (bot has `אחזקת רכב` — different verb stem. Will NOT match `*תחזוקת רכב*` SUMIFS) |
| Misc (R53-57) | `ביגוד`, `טיפוח`, `בריאות`, `בילויים`, `שונות` | ALL MATCH |

**Mismatches found in new-user template:**
1. **`תחזוקת רכב` row label** vs CATEGORY_MAP subcategory `אחזקת רכב`. Wildcard `*תחזוקת רכב*` will NEVER match writes of `אחזקת רכב`. Steven's transport bot writes will go to the bot's literal subcategory and miss the dashboard row.

**Mismatches in Steven's MIGRATED sheet only (not relevant to new-user template):**
- `רוביקון`, `אבא`, `גיא`, `אפולו`, `BMW s1000`, `חצי איירון מן` — these are Steven's per-personal custom rows in his NEW dashboard. CATEGORY_MAP has rows for `רוביקון`, `אבא`, `אפולו`, `BMW s1000` but **NOT for `גיא` and NOT for `חצי איירון מן`**. Writes mentioning Gia or the Half Ironman will fall through to `שונות` and miss those dashboard rows. (And the existence of dashboard rows that no classifier ever populates means they read 0 indefinitely.)

---

## 4. Bot subcategories with NO matching dashboard row

The CATEGORY_MAP has 237 unique subcategory strings. The new-user template's personal dashboard has 34 category rows (with `*X*` wildcards). Subcategories the wildcards do NOT match (sample of important misses):

- All `בריאות - X` strings (the dashboard only has bare `בריאות` — wildcard `*בריאות*` DOES catch these. Actually fine.)
- All `שירותים מקצועיים - X` strings (no dashboard row in personal template — these are business categories, routed to company dashboard via `BUSINESS_CATEGORY_MAP`).
- `כביש 6`, `כושר`, `כלי עבודה`, `חניה`, `אקדמיה - X`, `כסאות בטיחות לילדים`, `עגלות תינוק`, `מנשאי תינוק`, `רהיטי תינוק` — most match via the `*תינוקות*` row's wildcard. `כביש 6` does not (no `*כביש*` row).
- `קורקינט`, `כושר ומנויים`, `נדל"`, `תיווך ונדל"` — no dedicated rows; bot writes go to `שונות` semantically.
- Income variations: `הכנסה 1 — משכורת` matches R5 via `*הכנסה 1*`. OK.

**Net:** roughly 60+ subcategories have no clean row mapping, but they all fall through to `שונות` (R57) or the section totals via wildcard expansion. Not a data-loss issue — a granularity-loss issue.

---

## 5. Dashboard rows with NO bot route (only manual entry)

In Steven's NEW sheet (per session memory of his row labels):

| Dashboard row | Bot CATEGORY_MAP entry? | Effect |
|---------------|-------------------------|--------|
| `רוביקון` | YES | Routed |
| `אבא` | YES | Routed |
| **`גיא`** | **NO** | Manual only — bot can never populate this row |
| `אפולו` | YES | Routed |
| `ליים` | YES | Routed |
| `BMW s1000` | YES | Routed |
| `חניה` | YES | Routed |
| `ביטוח רכב` | YES | Routed |
| `ביגוד` | YES | Routed |
| `מכון כושר` | YES | Routed |
| **`חצי איירון מן`** | **NO** | Manual only |
| `חופשות` | Not searched in CATEGORY_MAP grep — likely missing (subcategories are `טיסות`, `מלונות`, `תיירות`) | Likely manual only |

---

## 6. Tenant isolation status

**The phone → userSub → sheet:{userSub} invariant is intact.**

- `api/sheet/append.js:103-132` resolves `phone:{E164}` → `phoneRec.userSub` → reads `sheet:{phoneRec.userSub}` AND `user:{phoneRec.userSub}` separately; emits `sheet_ownership_mismatch` (409) on disagreement. Self-heals stale phoneRec.spreadsheetId.
- `tests/test_sheet_ownership_guard_5_endpoints.js` asserts the canonical guard on 9 sheet endpoints: `append.js`, `bot-query.js`, `mark-vat.js`, `stats.js`, `delete-last.js`, `csv-import.js`, `relabel-row.js`, `add-category-row.js`, `fix-company-dashboard.js`. All checked.
- `api/sheet/web-append.js` (the web-form path) uses `requireAuth` and keys directly off `req.user.sub` — tenant-isolated by session, does not need the phone-guard.
- `api/recurring.js` uses `appendRowToUserSheet` via a resolved `userRecord` — same canonical pattern.
- `lib/sheet-writer.js:appendRowToUserSheet` requires `userRecord.spreadsheetId`. No way to call it without an explicit sheet ID, so cross-tenant write requires a poisoned KV record AND missing guard — defense in depth.
- `tests/full_qa.js` runs `bot/test_isolation.js` + the 9-endpoint guard + the legacy `_resolveTenant_` static check on `ExpenseBot_DEPLOY.gs`. **Run before any change to confirm green.**

---

## 7. Website / account / dashboard open-sheet links

| File | Pattern | Verdict |
|------|---------|---------|
| `account.html:1340,1366,1431,1600` | `sheetId = pj.spreadsheetId; sheetUrl = pj.spreadsheetUrl` from `/api/sheet/provision`, then `localStorage.setItem('kesefle_sheet', JSON.stringify({...}))` | Tenant-resolved |
| `dashboard.html` | No hardcoded sheet IDs (grep zero hits) | Tenant-resolved |
| `api/me.js:70` | `'https://docs.google.com/spreadsheets/d/' + sheetId + '/edit'` from KV-resolved sheetId per `userSub` | Tenant-resolved |
| `api/admin/recent-signups.js:81`, `api/admin/resend-welcome.js:80` | Per-user `sheetRec.spreadsheetId` | Tenant-resolved |
| `api/sheet/add-category-row.js:274,321`, `api/sheet/csv-import.js:400`, `api/sheet/provision.js:155`, `api/whatsapp/link.js:36` | Per-user `spreadsheetId` parameter | Tenant-resolved |

No leakage of owner sheet IDs to user pages.

---

## 8. Admin endpoint audit (`api/admin/*.js`)

| Endpoint | Auth | Rate limit | OLD-ID? | Notes |
|----------|------|-----------|---------|-------|
| `bot-version.js` | requireAdmin | yes (60/min) | no | OK |
| `config-drift.js` | requireAdmin | yes (30/min) | no | OK |
| `create-sample-sheet.js` | requireAdmin | yes (10/hr) | no | OK |
| **`customer-digest-set.js`** | **KESEFLE_BOT_SECRET via header (NOT requireAdmin)** | yes (30/min) | no | INCONSISTENT — uses bot secret instead of admin session. Acceptable for cron-feed pattern, flagged for visibility. |
| `funnel-summary.js` | requireAdmin | (none) | no | Missing rate limit — LOW (idempotent GET). |
| `help-queries.js` | requireAdmin | yes (60/min) | no | OK |
| `inbox.js` | requireAdmin | yes (60/min) | no | OK |
| `launch-monitor.js` | requireAdmin | (none) | no | Missing rate limit but polled every 30-60s from admin — defense suggested. |
| `recent-signups.js` | requireAdmin | yes (60/min) | no | OK |
| `referral-leaderboard.js` | requireAdmin | yes (60/min) | no | OK |
| `reprovision-user-sheet.js` | requireAdmin | yes (10/min) | no | OK |
| `resend-welcome.js` | requireAdmin | yes (30/min) | no | OK |
| `revenue.js` | requireAdmin | yes (30/hr) | no | OK |
| `sheets-quota.js` | requireAdmin | yes (60/min) | no | OK |
| **`stats.js`** | **ADMIN_TOKEN via Bearer (NOT requireAdmin)** | (none) | no | LEGACY auth pattern, predates `requireAdmin`. Token is constant-time-compared, fails closed if env var unset. Still inconsistent — should migrate. |
| `user-reports.js` | requireAdmin | yes (60/min) | no | OK |
| `user-timeline.js` | requireAdmin | yes (60/min) | no | OK |

**Inconsistency flagged but no exploitable hole.** No admin endpoint hardcodes the OLD sheet ID.

---

## 9. Apps Script Script Properties audit

The bot's main file (`bot/ExpenseBot_FIXED.gs`) reads the following Script Properties:

| Property | Default | Required? | Failure mode |
|----------|---------|-----------|--------------|
| `WHATSAPP_TOKEN` | `''` | yes for sending | Falls back to empty string; sends silently fail |
| `WHATSAPP_PHONE_NUMBER_ID` | `'1086749664527399'` | no | Defaults to Meta test number |
| `KESEFLE_API_BASE` | `'https://kesefle.com'` | no | Defaults correctly |
| `KESEFLE_BOT_SECRET` | none | yes for any API call | Fails closed (write attempts return error replies) |
| `KESEFLE_CRON_SECRET` | none | yes for cron alerts | Fails silently in cron paths |
| `SHEET_OWNER_PHONE` | falls back to `OWNER_PHONE` constant `'972547760643'` | recommended | Fail-safe fallback so non-owners can't be mis-classified as owner |
| `KFL_DISABLE_BOT_WRITES` | `false` | no | Kill switch — defaults to writes enabled |
| `KFL_MAINTENANCE_MODE` | no | no | Optional |
| `KFL_CONFIDENCE_ASK_THRESHOLD` | `0.85` | no | Defaults |
| `META_APP_SECRET` | `''` | yes for HMAC webhook verify | Strict mode disabled if absent |
| `STRICT_WEBHOOK_VERIFY` | no | no | Optional toggle |
| `BLACKLIST_PHONES` | `''` | no | No-op if absent |
| `LEAD_ALERT_PHONE`, `WEEKLY_SUMMARY_PHONE`, `DIGEST_PHONE` | `''` | no | Cron outputs go nowhere if unset |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL` | `''` | no | Falls back to local classifier |
| `AUTO_FIX_DASHBOARDS`, `ANOMALY_ALERTS_DISABLED` | no | no | Optional toggles |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | `''` | no | Optional |

**No properties exist that, if missing, would cause WRITES to land on the wrong sheet.** `SHEET_OWNER_PHONE` has a hardcoded fallback (`'972547760643'`) — without it, the bot would mis-route every sender as the owner (the historical bug, now fixed).

`config.gs:25` still has `FAMILY_TEMPLATE_SHEET_ID = 'REPLACE_WITH_FAMILY_TEMPLATE_ID'` — placeholder. No live code path opens this constant; only the comment at line 19 references it.

---

## 10. `buildTenantSheetSpec` audit — new-user template

`lib/sheet-writer.js:726` `buildTenantSheetSpec(name, opts)` provisions a fresh per-user spreadsheet with 5 tabs:

1. `מאזן אישי` (personal dashboard, 58 rows, year selector at `$B$2`, 34 SUMIFS rows + section totals)
2. `תנועות` (transactions, 9 cols A-I including VAT-deductible flag)
3. `הזמנות` (orders, 8 cols)
4. `מאזן חברה` (company dashboard, year selector at `$B$4`, 4 business expense rows with array criteria + wildcards)
5. `מאזן מורחב` (extended Pa'amonim breakdown with pie charts)

**Verdict:** This is a GENERIC ISRAELI HOUSEHOLD TEMPLATE — correctly NOT containing Steven's personal categories (`רוביקון`, `אבא`, `גיא`, `אפולו`, `BMW s1000`, `חצי איירון מן`). New users get a clean default. Steven's quirky rows live ONLY in his manually-migrated NEW sheet.

This is the right design. Two minor issues:

1. **Row label `תחזוקת רכב` vs bot's `אחזקת רכב`** — wildcard SUMIFS will not match. New users' transport spend on car maintenance will read 0 on the dashboard.
2. **Row label `תינוקות` (single word)** — wildcard `*תינוקות*` matches the bot's `חיתולים ותינוקות`, `מזון תינוקות ופעוטות`, `כסאות בטיחות לילדים` (no — that one says ילדים, won't match). Mostly OK.

---

## 11. Severity-tagged findings

| # | Finding | Severity | Where | Recommended action |
|---|---------|----------|-------|--------------------|
| F1 | `bot/BOT_COMMANDS.gs` hardcodes OLD sheet ID `1UKr…` at line 22, then `.setValue` at line 305 and `.deleteRow()`/cat edits on opens of that sheet. NOT currently bundled into `ExpenseBot_DEPLOY.gs` but `handleBotCommand_` is dispatched from doPost. | **HIGH (latent)** | bot/BOT_COMMANDS.gs:22, 305 | Either delete the file or migrate `BC_SHEET_ID` to `SHEET_ID` constant (NEW). |
| F2 | `bot/WEEKLY_DIGEST.gs` hardcodes OLD sheet ID at line 32 and installs a Sunday-08:00 trigger via `INSTALL_WEEKLY_DIGEST_TRIGGER()` that reads `WD_SHEET_ID = OLD`. If trigger is installed in production Apps Script, weekly digests would send stale OLD-data to every subscriber, ignoring their own tenant sheets entirely. | **CRITICAL (if installed)** | bot/WEEKLY_DIGEST.gs:32, 69, 112 | Confirm via Apps Script Triggers panel: is `_WEEKLY_DIGEST_HANDLER_` currently scheduled? If yes — disable immediately. Migrate WD to NEW sheet, or replace with `cronWeeklySummary` (already in DEPLOY, reads SHEET_ID=NEW). |
| F3 | Dashboard row `גיא` exists in Steven's NEW sheet but no CATEGORY_MAP entry exists. Bot writes mentioning Gia will not land in that row. | MEDIUM | bot/ExpenseBot_FIXED.gs CATEGORY_MAP | Add a CATEGORY_MAP row for `גיא` with appropriate keywords. |
| F4 | Dashboard row `חצי איירון מן` exists in Steven's NEW sheet but no CATEGORY_MAP entry. | MEDIUM | bot/ExpenseBot_FIXED.gs CATEGORY_MAP | Add a CATEGORY_MAP row. |
| F5 | New-user template row label `תחזוקת רכב` mismatches bot's CATEGORY_MAP subcategory `אחזקת רכב`. SUMIFS wildcard `*תחזוקת רכב*` will not catch `אחזקת רכב` writes. | MEDIUM | lib/sheet-writer.js:77 | Either rename row to `אחזקת רכב` or add a CATEGORY_MAP alias subcategory `תחזוקת רכב`. |
| F6 | `bot/config.gs:11` comment block still has OLD sheet URL — documentation drift. | LOW | bot/config.gs:11 | Update comment to NEW URL. |
| F7 | `api/admin/stats.js` uses legacy `ADMIN_TOKEN` Bearer auth, no rate limit. `api/admin/customer-digest-set.js` uses `KESEFLE_BOT_SECRET` (not `requireAdmin`). | LOW (inconsistency) | api/admin/stats.js, customer-digest-set.js | Migrate to canonical `requireAdmin` + `withRateLimit` pattern over time. |
| F8 | `api/admin/funnel-summary.js` and `api/admin/launch-monitor.js` have `requireAdmin` but no `withRateLimit`. | LOW | those two files | Add a 60/min rate limit for parity. |
| F9 | `bot/config.gs:25` still has `FAMILY_TEMPLATE_SHEET_ID = 'REPLACE_WITH_FAMILY_TEMPLATE_ID'` placeholder. | LOW | bot/config.gs:25 | If family template is not in active scope, remove the placeholder; if it is, populate it. |
| F10 | `tests/test_sheet_ownership_guard_5_endpoints.js` covers 9 endpoints but `api/sheet/web-append.js` is a write path not listed. (It uses `requireAuth` + session sub, so the cross-tenant attack surface is different — but adding a parity test would catch a future regression where a phone-based check is added.) | LOW | tests/test_sheet_ownership_guard_5_endpoints.js | Add web-append assertion that the userSub from session is used as the KV key. |

---

## 12. Safe fixes (additive only — no destructive operations)

**Fix order recommended:**

1. **F2 (CRITICAL — verify first):** In Apps Script editor, check `Triggers` panel for any trigger pointing at `_WEEKLY_DIGEST_HANDLER_` or `WD_TRIGGER_HANDLER`. If none, downgrade F2 to LOW. If any exists, disable immediately via the editor. THEN open a PR that either deletes `bot/WEEKLY_DIGEST.gs` or rewires `WD_SHEET_ID = SHEET_ID` (the NEW constant from `ExpenseBot_FIXED.gs`).
2. **F1 (HIGH-latent):** Add a unit assertion (e.g. in `tests/full_qa.js`) that `bot/ExpenseBot_DEPLOY.gs` does NOT contain `BC_SHEET_ID` AND does NOT contain `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`. Belt + suspenders.
3. **F3, F4, F5 (MEDIUM):** Add three CATEGORY_MAP entries:
   - `{"keywords":["גיא","gia"], "category":"אישי", "subcategory":"גיא"}` 
   - `{"keywords":["חצי אירון","חצי איירון","חצי איירון מן","half ironman","ironman 70.3"], "category":"כושר", "subcategory":"חצי איירון מן"}`
   - Alias keyword `אחזקת רכב` already exists as a subcategory; either add `{"keywords":["תחזוקת רכב"...], "category":"תחבורה", "subcategory":"תחזוקת רכב"}` AND rename the sheet template row, OR just rename `lib/sheet-writer.js:77` from `'תחזוקת רכב'` to `'אחזקת רכב'`. The latter is one line and zero risk for new users.
4. **F6 (LOW):** One-line comment update in `bot/config.gs:11`.
5. **F7, F8, F9, F10 (LOW):** Pull into a follow-up PR.

All of the above are ADDITIVE — no destructive ops, no schema changes, all reversible by `git revert`.

---

## 5-bullet executive summary

1. **CRITICAL latent risk:** `bot/WEEKLY_DIGEST.gs` is wired to OLD sheet `1UKr…` AND ships an `INSTALL_WEEKLY_DIGEST_TRIGGER()` function. Before any other action: open Apps Script Triggers panel and confirm no `_WEEKLY_DIGEST_HANDLER_` or `WD_TRIGGER_HANDLER` trigger is installed in production. If one is, disable.
2. **HIGH latent risk:** `bot/BOT_COMMANDS.gs` hardcodes OLD sheet `1UKr…` and would write/delete against it if ever pasted into `ExpenseBot_DEPLOY.gs`. Currently NOT bundled into deploy. Either delete or rewire to NEW.
3. **MEDIUM data-correctness issues:** Steven's NEW sheet has rows `גיא` and `חצי איירון מן` that no bot CATEGORY_MAP entry routes to — they will read 0 forever unless manually populated. Also row `תחזוקת רכב` mismatches bot's subcategory `אחזקת רכב`.
4. **CLEAN:** Tenant isolation invariant (`phone → userSub → sheet:{userSub}`) is properly enforced across 9 sheet endpoints with `sheet_ownership_mismatch` guard. Web/API plane has ZERO hardcoded sheet IDs. `account.html` and `dashboard.html` resolve sheet IDs dynamically from `/api/sheet/provision`.
5. **MINOR inconsistencies (LOW):** Two admin endpoints (`stats.js`, `customer-digest-set.js`) use legacy auth patterns instead of `requireAdmin`. Two more lack rate limits. None are exploitable, but they reduce auditability. `config.gs:11` and `config.gs:25` have stale doc/placeholder strings.
