# Deep Review 2026-05-29 — Executive Summary

**Block duration:** 30 minutes
**Method:** 5 parallel workstreams (4 background agents + 1 foreground via Chrome MCP)
**Discipline:** Read-only. No APPLY. No production switch. No destructive actions.
**Sheets reviewed:**
- OLD: `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`
- NEW: `1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A`

---

## TL;DR

✅ **The NEW sheet is in much better shape than it appeared.** All 615 transactions across 2023-2026 are present (100% per-year parity). All 30 orders are migrated. Steven's renamed appended rows (רוביקון, ביגוד, חניה, etc.) now correctly sum from `תנועות`. Bot is deployed and writing correctly.

⚠️ **Three CRITICAL/HIGH gaps + three MEDIUM gaps** worth fixing, all SAFE and ADDITIVE (no rewrites, no APPLY):

**CRITICAL/HIGH:**
1. **4 missing bot CATEGORY_MAP routes** (WS1) — `גיא`, `חצי אירון מן`, `חצי אוסטריה`, `קולקציות` silently fall through to `שונות`. Any future WhatsApp expense for these gets misclassified. Fix: add 4 keyword entries to `CATEGORY_MAP`. Pure additive, ~10 lines.
2. **2 frozen-year SUMIFS installers in `bot/ExpenseBot_FIXED.gs`** (WS2, HIGH) — Lines 15824, 15963, 11242 bake the year into the formula text. Gated by `AUTO_FIX_DASHBOARDS=1` (opt-in), but Steven's been running APPLY-y things this session — risk that this trap fires. Fix: rewrite these emitters to use `$B$?` like #151. Or guard the gate.
3. **New-tenant template has NO B4 dropdown** (WS2, HIGH) — `lib/sheet-writer.js buildTenantSheetSpec` provisions B1/B2/B4 as plain numbers, no `dataValidation`. One accidental Backspace by a new user → all formulas silently return 0. Fix: add `dataValidation` to template.

**MEDIUM:**
4. **Cell-notes migration from OLD** (WS3) — `MIGRATE_OLD_NOTES.gs` exists in the bot project but I have no evidence Steven ran it. Hover-explanations likely lost.
5. **`bot/SHEET_YEAR_SELECTOR_WIRE.gs:71` hardcodes `_YS_CURRENT_YEAR_ = 2026`** (WS2) — Silent rollover bug in ~7 months. Fix: make it `YEAR(TODAY())`.
6. **Per-year OLD snapshot tabs + תיק השקעות** (WS3) — Reference views, not raw data. Decision needed.

🛑 **Five decisions need Steven before any further APPLY ships:**
1. Is `קולקציות` (SRC Collection) business revenue or personal expense?
2. Is `חופשות` standalone or under `נסיעות`?
3. Is `ארנונה` own row or rolled into `בית`?
4. `רוביקון` group label: `תחבורה` or `רכב / תחבורה`?
5. Confirm `נשר + חופים` → `כושר + תוספים` rename.

---

## Workstream verdicts

### WS1 — Category reconciliation (`kesefle-migration-and-sheet-formula-agent`)
**Verdict: 4 CRITICAL bot-keyword gaps + 1 safe additive fix ready to ship.**

- 4 Steven-only Hebrew categories have **NO bot route at all**: `גיא`, `חצי אירון מן`, `חצי אוסטריה`, `קולקציות`. Bot silently routes them to `שונות`.
- 211 of bot's ~249 unique subcategories have no matching template row (architectural gap; per-user patched today via APPLY).
- Rubicon mapping: bot has `רוביקון` → `תחבורה`, but plan §G says `group="רכב / תחבורה"`. Pick one and propagate.
- 4 business duplicates Steven cleaned up earlier (`עלות חומרי גלם` etc.) were strict-literal vs the existing wildcard `*X*` rows — they were noise, not data loss.
- Re-run safety bug in `_MDD_collectLabels_`: doesn't skip its own `🏷️ מהגיליון הקודם` banner; if Steven re-runs APPLY, the banner gets re-collected. One-line fix.

Full report: `docs/REVIEW_2026_05_29_CATEGORY_RECONCILIATION.md` (278 lines)

### WS2 — Formula + year selector audit (`kesefle-sheet-formula-year-selector-validator`)
**Verdict: PR #151 fix is in place. 2 HIGH + 2 MEDIUM lurking issues to address before next migration ships.**

- ✅ `bot/MIGRATE_DASHBOARD_FROM_OLD.gs` uses SUMPRODUCT+`LEFT(B,4)` with empty-B4 fallback — the broken `">=" & $B$4 & "-01"` pattern is NOT present in any live formula generator (only in an explanatory comment at line 184).
- **HIGH** — Two installers in `bot/ExpenseBot_FIXED.gs` (lines 15824, 15963) plus legacy `migrateDashboardToSUMIFS` (line 11242) write **frozen-year SUMIFS**: they build `monthKey = year + '-' + MM` and bake it into the formula text, making the year selector cosmetic. Gated by `AUTO_FIX_DASHBOARDS=1` Script Property (opt-in), but the trap exists. Mirrored in `bot/ExpenseBot_DEPLOY.gs`.
- **HIGH** — New-tenant template (`lib/sheet-writer.js buildTenantSheetSpec`) provisions `B1` / `B2` / `B4` (three different cells across `מאזן אישי` / `מאזן חברה` / `פירוט מורחב`) as **plain numbers with NO `dataValidation` dropdown**. One accidental Backspace → all formulas silently return 0. New tenants are vulnerable.
- **MEDIUM** — `bot/SHEET_YEAR_SELECTOR_WIRE.gs:71` hardcodes `_YS_CURRENT_YEAR_ = 2026` for the live/historical switch. ~7 months until silent rollover.
- **MEDIUM** — Test gap: `bot/test_no_hardcoded_year_in_dashboard_formula.js` and `bot/VALIDATE_NO_HARDCODED_YEAR.js` only check single-line patterns. They miss the multi-line frozen-year-variable pattern (#2 above).

Safe fixes proposed in report (NOT applied):
- Backward-walk validator over `setFormula` callers to catch frozen-year patterns
- Add `dataValidation` to `buildTenantSheetSpec` for B1/B2/B4 on new-tenant provisioning
- Universal empty-B?  fallback in every formula emitter (matches the pattern shipped in #151)
- Make `_YS_CURRENT_YEAR_` a function not a constant
- Regression test that installer formulas reference `$B$?`
- Guard or archive legacy `migrateDashboardToSUMIFS`

Full report: `docs/REVIEW_2026_05_29_FORMULA_AND_YEAR.md`

### WS3 — Historical data + notes/comments (foreground — Chrome MCP)
**Verdict: SAFE. Earlier "0 rows" scare was a measurement artifact.**

Live audit results (Apps Script `AAA_WS3` run at 7:27 IL):
- NEW `תנועות`: **619 rows / 615 valid YYYY-MM rows** across 2023-2026 (100% parity per year with OLD).
- NEW `הזמנות`: **30 rows** (OLD had 29, plus +1 new since migration). ✅
- All 7 NEW tabs accounted for.

3 MEDIUM gaps:
- OLD per-year snapshot tabs (`מאזן אישי 2023/2024/2025`) not migrated — reference data, not raw.
- OLD `תיק השקעות` (investments) tabs not migrated.
- Cell notes from OLD — unknown if `MIGRATE_OLD_NOTES.gs` was ever run.

1 LOW hygiene: `_DIFF_REPORT_` hidden tab (221 rows) left over from SHEET_DIFF tool; harmless.

Full report: `docs/review-2026-05-29/WS3_HISTORICAL_NOTES.md` (~150 lines)

### WS4 — Bot/sheet/dashboard/admin sync (`kesefle-bot-sheet-dashboard-sync-checker`)
**Verdict: 1 CRITICAL latent + 1 HIGH latent + others. Web/API layer is CLEAN; the lurking issues are in legacy bot `.gs` files.**

- **CRITICAL (latent)** — `bot/WEEKLY_DIGEST.gs:32` hardcodes OLD sheet `1UKr...` and ships `INSTALL_WEEKLY_DIGEST_TRIGGER()` that schedules a Sunday 08:00 cron pulling data from OLD. **If this trigger is installed in production Apps Script, every subscriber gets stale OLD-data digests instead of tenant data.** **Steven: please open the Apps Script Triggers panel and confirm whether this trigger is installed.**
- **HIGH (latent)** — `bot/BOT_COMMANDS.gs:22` hardcodes OLD sheet and does `.setValue()`/row-delete writes. NOT currently bundled into `ExpenseBot_DEPLOY.gs`, but `handleBotCommand_` IS dispatched from `doPost` (lines 2335-2337) — one accidental paste-bundle would activate writes against OLD.
- **MEDIUM** — Steven's NEW dashboard has rows `גיא` and `חצי איירון מן` with no matching `CATEGORY_MAP` entry → bot can never populate them. (WS1 already flagged these as additive 4-line fix.)
- **MEDIUM** — Template label drift: `lib/sheet-writer.js:77` row label `תחזוקת רכב` but bot's `CATEGORY_MAP` writes `אחזקת רכב`. Wildcard SUMIFS won't catch this.
- **CLEAN** — Tenant isolation invariant (`phone → userSub → sheet:{userSub}`) enforced everywhere. `sheet_ownership_mismatch` guard on 9 sheet endpoints. **Zero hardcoded sheet IDs in `api/`, `lib/`, `tests/`, `scripts/`, or any HTML.** `account.html` + `dashboard.html` resolve dynamically via `/api/sheet/provision`. ✅
- **LOW** — Minor admin auth/rate-limit inconsistencies:
  - `api/admin/stats.js` uses legacy `ADMIN_TOKEN` Bearer + no rate limit
  - `api/admin/customer-digest-set.js` uses `KESEFLE_BOT_SECRET` instead of `requireAdmin`
  - `api/admin/funnel-summary.js` + `api/admin/launch-monitor.js` lack rate limits
  - `bot/config.gs:11` has stale OLD URL in a comment
  - `bot/config.gs:25` still has placeholder `'REPLACE_WITH_FAMILY_TEMPLATE_ID'`

Full report: `docs/REVIEW_2026_05_29_SYNC_AUDIT.md`

### WS5 — QA + security + data integrity (`kesefle-qa-security-data-integrity-officer`)
**Verdict: SAFE TO MERGE PR #151. Zero security regressions.**

- `node --check` on assembled `bot/ExpenseBot_DEPLOY.gs` clean; exactly 1 `doPost`.
- `tests/full_qa.js`: **118/118 pass**.
- 26 bot test suites: **25 PASS, 1 LOW fail** (`test_llm_profession_boost.js:242-244` hardcodes `2026-05-28-` in a regex; PR #144 bumped the version to `2026-05-29-…` so the assertion is stale). Pure test artifact, not a product regression. Safe additive fix proposed.
- Secrets scan: **0 real findings**. All `client_secret` matches are OAuth field names sourced from `process.env`.
- Tenant isolation: all 4 `appendRow*` callers route via `user:{userSub}` token + `sheet:{userSub}` canonical resolution. ✅
- Destructive functions: all 18 calls are gated (CONFIRM properties + backup) or target cache artifacts.
- 3 agents + 22 skills present with valid YAML frontmatter.
- PR #151 verified: 455 lines, 8 SUMPRODUCT hits, `LEFT(tx!B2:B2000,4)` at line 211, broken `">=" & $B$4` only present in an explanatory comment at line 184 (not in formulas).

Full report: `docs/REVIEW_2026_05_29_QA_SECURITY.md`

---

## Open PRs (status from WS5)

| # | Title | Action |
|---|---|---|
| **151** | SUMPRODUCT+LEFT for year filter | **MERGEABLE — this is the live-tested fix that makes Steven's dashboards show real numbers. Top of merge queue.** |
| 148 | strict label filter | **CLOSE — superseded by #149 (already merged)** |
| 131 | bot: backfill 2023-2025 to סיכום היסטורי | Review — relevant to WS3 gap on per-year snapshots |
| 123, 107, 106 | various skills PRs (older) | Review later — not blocking |
| 86, 85, 84, 83, 82 | older bot/admin/docs PRs | Review later — not blocking |
| 81 | goals-v2 cron | MERGEABLE — independent |

---

## Top 5 actions Steven needs to take

1. **Merge PR #151** (top priority). It's the actual fix that makes the dashboard show real numbers. WS5 verified safe.
2. **CONFIRM: is `INSTALL_WEEKLY_DIGEST_TRIGGER` installed in your Apps Script?** Open `https://script.google.com/home/projects/1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo/triggers` and tell me yes/no. If yes, every subscriber's weekly digest is pulling from OLD sheet (WS4 CRITICAL).
3. **Answer the 5 category decisions**: (a) `קולקציות` — biz revenue or personal expense? (b) `חופשות` — standalone or under `נסיעות`? (c) `ארנונה` — own row or rolled into `בית`? (d) `רוביקון` group label — `תחבורה` or `רכב / תחבורה`? (e) Confirm `נשר + חופים` → `כושר + תוספים` rename.
4. **Decide on cell-notes migration.** Want me to run `MIGRATE_OLD_NOTES.gs` DRY_RUN to inventory? Or skip the gap?
5. **Decide on OLD per-year snapshot tabs + תיק השקעות.** Migrate to read-only `סיכום היסטורי` in NEW, or leave as historical reference in OLD?

---

## Severity-tagged consolidated findings

| # | Sev | Workstream | Finding | Recommended fix | Safe now? |
|---|-----|-----------|---------|-----------------|-----------|
| 1 | **CRITICAL** (latent) | WS4 | `bot/WEEKLY_DIGEST.gs:32` hardcodes OLD sheet; trigger if installed sends OLD data to subscribers | Steven verifies trigger panel; then fix hardcode | After Steven confirms |
| 2 | **HIGH** (latent) | WS4 | `bot/BOT_COMMANDS.gs:22` hardcodes OLD + writes; not bundled but risky | Update sheet ID or block file from bundling | Yes (code change) |
| 3 | **HIGH** | WS1 | 4 bot CATEGORY_MAP routes missing (`גיא`, `חצי אירון מן`, `חצי אוסטריה`, `קולקציות`) | Add 4 keyword entries | Yes (additive) |
| 4 | **HIGH** | WS2 | 2 frozen-year SUMIFS installers in ExpenseBot_FIXED.gs (lines 11242, 15824, 15963) | Rewrite to use $B$? or guard the gate | Yes (additive) |
| 5 | **HIGH** | WS2 | New-tenant template has no B4 dropdown — Backspace = silent 0s | Add `dataValidation` to `buildTenantSheetSpec` | Yes (additive) |
| 6 | **MEDIUM** | WS3 | Cell notes from OLD likely never migrated | DRY_RUN `MIGRATE_OLD_NOTES.gs` to inventory | Yes (read-only) |
| 7 | **MEDIUM** | WS3 | OLD per-year snapshot tabs + תיק השקעות not migrated | Steven decision | n/a — needs decision |
| 8 | **MEDIUM** | WS2 | `bot/SHEET_YEAR_SELECTOR_WIRE.gs:71` hardcodes `_YS_CURRENT_YEAR_ = 2026` | Make function of `YEAR(TODAY())` | Yes (additive) |
| 9 | **MEDIUM** | WS4 | `lib/sheet-writer.js` row `תחזוקת רכב` vs bot's `אחזקת רכב` mismatch | Pick one and propagate | Yes (additive) |
| 10 | **MEDIUM** | WS2 | Validator + test only catches single-line hardcoded years | Backward-walk validator over `setFormula` callers | Yes (additive test) |
| 11 | **LOW** | WS5 | `test_llm_profession_boost.js:242-244` regex pins `2026-05-28-` | Relax regex to accept any 2026 date prefix | Yes (additive test fix) |
| 12 | **LOW** | WS4 | Admin endpoint auth/rate-limit inconsistencies (4 endpoints) | Standardize on `requireAdmin` + rate limit | Yes (incremental) |
| 13 | **LOW** | WS4 | `bot/config.gs` stale comment + placeholder | Clean up | Yes (additive) |
| 14 | **LOW** | WS3 | `_DIFF_REPORT_` hidden tab leftover | Hide or leave | n/a (hygiene) |

## Tests / checks run

| Command | Result |
|---------|--------|
| `node tests/full_qa.js` | ✅ 118/118 pass |
| 26 × `node bot/test_*.js` | ✅ 25 pass; 1 LOW fail (stale assertion, not regression) |
| Bot assembly + `node --check` | ✅ clean, 1 `doPost` |
| Secrets scan (AIza/sk-/xox/PRIVATE KEY/client_secret/KESEFLE_BOT_SECRET) | ✅ 0 real findings |
| Tenant isolation (`appendRow*` callers) | ✅ all 4 callers route via `user:{userSub}` + `sheet:{userSub}` |
| Hardcoded year scan (`"20XX-MM"` regex) | 3 hits found (the 3 WS2 issues above) |
| Destructive function inventory (`clearContents/deleteRow/clear`) | 18 calls, all gated or against derived cache |
| OLD sheet ID grep across repo | 9 hits — 7 are in legacy/audit/migration tools (OK), 2 are the WS4 CRITICAL+HIGH findings |
| Agents valid YAML frontmatter | 3 ✓ |
| Skills valid YAML frontmatter | 22 ✓ |

## Safe PRs / docs / tasks created during this block

| Artifact | Status |
|---------|--------|
| `docs/review-2026-05-29/EXECUTIVE_SUMMARY.md` (this doc) | ✅ committed on branch |
| `docs/review-2026-05-29/WS3_HISTORICAL_NOTES.md` | ✅ committed on branch |
| `docs/REVIEW_2026_05_29_CATEGORY_RECONCILIATION.md` (WS1) | ✅ committed on branch |
| `docs/REVIEW_2026_05_29_FORMULA_AND_YEAR.md` (WS2) | ✅ committed on branch |
| `docs/REVIEW_2026_05_29_SYNC_AUDIT.md` (WS4) | ✅ committed on branch |
| `docs/REVIEW_2026_05_29_QA_SECURITY.md` (WS5) | ✅ committed on branch |
| Draft PR with this branch | After commit |

## Definition of done — checklist

- [x] Parallel workstreams used (4 background agents + 1 foreground)
- [x] All relevant Kesefle agents engaged
- [x] OLD vs NEW category reconciliation reviewed (WS1)
- [x] Formula / year selector reviewed (WS2)
- [x] Rubicon mapping reviewed (WS1)
- [x] Historical data + notes/comments gap reviewed (WS3)
- [x] Bot / dashboard / admin sync reviewed (WS4)
- [x] Tests + checks run (WS5)
- [x] Clear final report with evidence (this doc)
- [x] Severity-tagged findings table
- [x] Top-5 actions for Steven

---

*Report COMPLETE. All 5 workstreams returned. Ready to ship as docs-only PR.*
