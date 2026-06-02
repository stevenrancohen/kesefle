# Foreground Findings — Autonomous Audit Block 2026-05-28

Augments the executive summary with foreground-only findings that don't appear in agent docs.

---

## 1. Rate-limit / auth coverage matrix (foreground grep + manual verification)

### Confirmed SAFE — auth + rate-limit both present
All `/api/sheet/*` endpoints except `getExpenses.js`. All `/api/admin/*` endpoints except `stats.js` and `funnel-summary.js` and `launch-monitor.js`. All `/api/billing/*` endpoints except webhooks (correctly verify signatures instead).

### Findings

| # | File | Issue | Severity |
|---|---|---|---|
| F1 | `api/sheet/getExpenses.js` | Has `requireUser` auth but no rate limit. Authed user could spam reads, hitting Google Sheets quota. | MEDIUM |
| F2 | `api/admin/funnel-summary.js` | Admin-gated but no rate limit. Low risk (admin only). | LOW |
| F3 | `api/admin/launch-monitor.js` | Admin-gated but no rate limit. Low risk. | LOW |
| F4 | `api/admin/stats.js` | Uses `ADMIN_TOKEN` env var (Bearer header), fails closed if env unset. No rate limit. Auth is non-standard — most admin endpoints use Google ID-token via `requireAdmin`. | LOW (consistency) |
| F5 | `api/billing/crypto-webhook.js` | Webhook signature verification (must verify). No rate limit. Standard webhook pattern. | INFO |
| F6 | `api/log/user-report.js` | Has `withRateLimit` per IP. No auth (anonymous one-textarea). Acceptable per existing design. | INFO |

### Recommendation
Add `withRateLimit({ key: 'sheet_get_expenses', limit: 60, windowSec: 60 })` to `api/sheet/getExpenses.js`. Other findings are lower-priority cleanup.

---

## 2. Hardcoded sheet ID inventory (foreground grep, excluding worktrees)

**28 files in `bot/` contain literal Drive IDs** (Steven's NEW + OLD):

| Category | Files | Count | Risk |
|---|---|---|---|
| **Active bot (NEW)** | `bot/ExpenseBot_FIXED.gs`, `bot/ExpenseBot_DEPLOY.gs`, `bot/personal_sheet_fix.gs` | 3 | LOW (deliberate single-owner constants — gated by `_isOwnerPhone_`) |
| **Migration scripts (both IDs)** | `bot/MIGRATE_OLD_TO_KESEFLE.gs`, `bot/MIGRATE_OLD_NOTES.gs`, `bot/SCAN_OLD_CATEGORIES.gs`, `bot/MIGRATE_PHASE_5_VERIFY_FORMULAS.gs`, `bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs` | 5 | LOW (legitimate dual-ref) |
| **Active fix scripts (NEW)** | `bot/SHEET_DASHBOARD_SMART_REMAP.gs`, `bot/SHEET_DASHBOARD_FULL_AUDIT.gs`, `bot/SHEET_YEAR_SELECTOR_WIRE.gs` | 3 | LOW (PR #127 dual-pane: NEW only) |
| **Legacy utility scripts (OLD only)** | `bot/config.gs`, `bot/EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs`, `bot/DASHBOARD_QUICK_WINS.gs`, `bot/FINANCIAL_SUMMARY_TAB_CLEAN.gs`, `bot/KESEFLE_ALL_PATCHES.gs`, `bot/FIX_DASHBOARD_2023_2024_2025.gs`, `bot/CLEANUP_DUPLICATES_AND_TABS.gs`, `bot/SORT_AND_FEATURES.gs`, `bot/CREATE_TEMPLATE_AND_CLEANUP.gs`, `bot/FIX_PROFITABILITY_AND_CHART.gs`, `bot/FIX_DASHBOARD_safe.gs`, `bot/WEEKLY_DIGEST.gs`, `bot/BOT_COMMANDS.gs`, `bot/CLEANUP_LEAKED_ROWS.gs` | 14 | **HIGH** (if Steven runs them, they write to OLD) |
| **Test fixtures (both IDs)** | `bot/test_migration.js`, `bot/test_migration_phase_5.js`, `bot/test_migration_phase_7.js` | 3 | INFO (legitimate test data) |

### Critical: 14 legacy utility scripts still point at OLD sheet
If Steven invokes any of these post-Phase-2:
- `bot/CLEANUP_DUPLICATES_AND_TABS.gs` → deletes duplicate rows on OLD
- `bot/CLEANUP_LEAKED_ROWS.gs` → removes leaked rows on OLD
- `bot/FIX_DASHBOARD_2023_2024_2025.gs` → rebuilds dashboard formulas on OLD
- `bot/FIX_PROFITABILITY_AND_CHART.gs` → restructures OLD's profitability chart
- All others → various OLD-only operations

**Recommendation (per Steven's "no destructive without approval" rule)**: Rename these 14 files to `*.gs.archive` so Apps Script no longer parses them, but the source is preserved for reference. Single bash command:
```bash
# Steven approval required first
for f in bot/config.gs bot/EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs ...; do
  git mv "$f" "${f}.archive"
done
```

---

## 3. Bot heartbeat health (foreground verification)

- `bot/ExpenseBot_FIXED.gs:62` — `KFL_BUILD_VERSION = '2026-05-28-pr-b-biz-canonical-subs'`
- `bot/ExpenseBot_DEPLOY.gs:137` — `KFL_BUILD_VERSION = '2026-05-28-pr-b-biz-canonical-subs'`
- **In sync** ✅
- Daily POST to `/api/log/bot-heartbeat` via `cronBotHeartbeat` (line ~3690)
- Receiver: `api/log/bot-heartbeat.js` with `constantTimeEqual` check on `KESEFLE_BOT_SECRET`
- Admin dashboard reads via `api/admin/bot-version.js`

**No drift**, **no concerns**.

---

## 4. Cron job inventory (foreground from vercel.json)

9 scheduled jobs:

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/kv-backup` | `0 3 * * *` | Nightly KV snapshot to Drive |
| `/api/cron/reminders` | `0 6 * * *` | Daily morning reminders |
| `/api/cron/recurring` | `5 6 * * *` | Daily recurring expense fan-out |
| `/api/cron/lifecycle` | `0 7 * * *` | Trial/inactivity/dunning emails |
| `/api/cron/budget-check` | `0 8 * * *` | Daily budget overspend alerts |
| `/api/cron/kv-monitor` | `0 * * * *` | Hourly KV usage threshold check |
| `/api/cron/steven-daily-digest` | `0 6 * * *` + `0 14 * * *` | 2x daily ops digest to Steven |
| `/api/cron/customer-weekly-digest` | `0 7 * * 0` | Sunday morning customer weekly digest |

**Healthy spread.** No conflicts. All gated by `CRON_SECRET` Bearer check.

---

## 5. Duplicate file flag

**`bot/MIGRATE_OLD_NOTES 2.gs`** is byte-identical to `bot/MIGRATE_OLD_NOTES.gs` (same MD5: `45eeee6fc76809c74a48c822f60eb2b0`).

Probable cause: Google Drive sync created a duplicate during the Apps Script paste workflow when Steven copy-pasted the file.

**Recommendation (Steven approval required)**: Delete `bot/MIGRATE_OLD_NOTES 2.gs`. Single command:
```bash
# Steven approval required
rm "bot/MIGRATE_OLD_NOTES 2.gs"
git add -u && git commit -m "cleanup: remove duplicate MIGRATE_OLD_NOTES 2.gs (byte-identical Drive sync cruft)"
```

This will also clear the 1 known QA failure in `bot/test_migration_phase_7.js` (which lists the duplicate as an orphan).

---

## 6. KFL_DISABLE_BOT_WRITES coverage analysis

The bot's emergency kill-switch only gates:
- `ExpenseBot_FIXED.gs:1485` — message processing
- `ExpenseBot_FIXED.gs:1761` — global kill at top of doPost

It does NOT gate:
- 14 Critical + 23 High destructive functions in `bot/personal_sheet_fix.gs` (per Agent 6)
- `RECOVER_DASHBOARD_APPLY_V2` (the daily-trigger target installed by `FIX_NOW`)
- Migration scripts (intentional — they need to run when kill switch is on)
- `INSTALL_NEWEST_FIRST_TRIGGER` (onEdit handler)

**Recommendation**: Promote KFL_DISABLE_BOT_WRITES to a top-level boolean check at the entry of every `APPLY_*` and `FIX_*` and `_NOW` function:
```javascript
function APPLY_DASHBOARD_REPAIR_NOW() {
  if (_isKillSwitchOn_()) { Logger.log('KILL SWITCH ON — refusing to apply'); return; }
  APPLY_DASHBOARD_REPAIR('YES I UNDERSTAND');
}
```

---

## 7. The 4 best-guarded migration scripts (Agent 6 baseline)

These already follow the full discipline pattern (DRY_RUN + APPLY + UNDO + YES I UNDERSTAND + LockService + DocumentProperties backup):

1. `bot/MIGRATE_OLD_TO_KESEFLE.gs` → `APPLY_MIGRATE_RAW`
2. `bot/MIGRATE_OLD_NOTES.gs` → `APPLY_MIGRATE_NOTES`
3. `bot/SHEET_DASHBOARD_SMART_REMAP.gs` → `SMART_REMAP_DASHBOARD`
4. `bot/SHEET_YEAR_SELECTOR_WIRE.gs` → `WIRE_YEAR_SELECTOR`

**These are the templates** to mimic when adding new destructive functions. Reference them when writing the new gates for the other 66 unguarded destructive entries.

---

## 8. Files I created on this branch (final inventory)

| Path | Lines | Author |
|---|---|---|
| `.claude/skills/kesefle-*/SKILL.md` (14 dirs) | 615 | foreground |
| `docs/EXECUTIVE_SUMMARY_AUTONOMOUS_BLOCK_2026-05-28.md` | 226 | foreground |
| `docs/QA_RUN_REPORT_AUTONOMOUS_BLOCK.md` | 203 | foreground |
| `docs/SYSTEM_SHEET_REFERENCE_AUDIT.md` | 415 | Agent 5 (consolidated) |
| `docs/PERSONALIZED_CATEGORY_PROFILES.md` | 733 | Agent 2 (consolidated) |
| `docs/SHEET_YEAR_SELECTOR_PLAN.md` | 583 | Agent 3 (consolidated) |
| `docs/FOREGROUND_FINDINGS_2026-05-28.md` | this | foreground |
| `bot/VALIDATE_NO_HARDCODED_YEAR.js` | 376 | Agent 3 (consolidated) |

**Total on this branch: ~3,150 lines.**

Plus the sibling PRs:
- PR #132: `docs/MIGRATION_READINESS_OLD_BALANCE_TO_KESEFLE.md` (~681 lines)
- PR #133: `docs/QA_RUN_REPORT_AUTONOMOUS_BLOCK.md` + 2 contract-pin tests (~250 lines)
- PR #134: `docs/SECURITY_PRIVACY_AUDIT_KESEFLE.md` + `docs/AI_PROVIDER_ROUTER_READINESS.md` (~370 lines)
- PR #135: `docs/APPS_SCRIPT_DESTRUCTIVE_FUNCTION_AUDIT.md` (~234 lines)
- PR #136: `docs/BOT_SHEET_SYNC_AUDIT.md` (~435 lines)

**Grand total across all 6 PRs: ~5,100 lines of audit deliverables.**

---

## 9. Sign-off — final

- ✅ 95-minute autonomous block completed at ~21:35 (started ~20:50)
- ✅ 8 specialized agents dispatched + completed (2 hit rate limit at end of run; their docs landed on disk anyway)
- ✅ 14 skills created
- ✅ 33-suite regression run: 32 pass, 1 known failure
- ✅ 6 PRs open with `autonomous-audit` label
- ✅ Zero destructive actions taken
- ✅ Zero live sheet writes
- ✅ Zero production switches
- ✅ Zero bot deployments
- ✅ Zero secret values disclosed
- ✅ Every skill has explicit `## Hard NO` section
- ✅ All migration recommendations require Steven approval

🤖 End of autonomous audit block 2026-05-28
