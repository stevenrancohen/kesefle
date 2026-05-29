# Workstream 3 — Historical Data + Notes/Comments Review

**Date:** 2026-05-29
**Agent:** Foreground (Claude via Chrome MCP + repo audit)
**Scope:** Read-only. No APPLY. No writes to either sheet.

## Source data already collected this session

### From the SHEET_DIFF_OLD_VS_NEW DRY_RUN (#143, run by Steven earlier today)

```
OLD: 1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo (24 tabs)
NEW: 1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A (6 tabs)

§ 1 Tab Inventory — 24 OLD tabs, 6 NEW tabs (delta: 18)
  Tabs that exist only in OLD:
   - Auto Synonyms, ML Audit (now also in NEW), _BACKUPS_, QA_DUPLICATES,
     _QA_REPORT_, backup 20260528_0607, dontdelete, אתחים, חברה 2026 לא לגעת,
     לא לגעת — אופציות, מאזן אישי 2023, מאזן אישי 2024, מאזן אישי 2025,
     מאזן שנתי — לא לגעת, מילון לימוד, תיק השקעות (twice), תנועות, מאזן חברה

§ 2 Row Counts Parity:
   - תנועות:  OLD 629 / NEW 617 / 100% parity (delta: -12 rows are pre-migration)
   - הזמנות:  OLD 29  / NEW 0   / 2900%  ← business orders DID NOT MIGRATE
   - מאזן אישי: OLD 58 / NEW 88  / 66%
   - מאזן חברה: OLD 14 / NEW 800 / 2%
```

### From AUDIT_APPENDED_ROWS (run live via Chrome MCP this session)

```
Distinct col-E values in NEW תנועות: 51
Top 25 col-E values:
  67 אוכל בחוץ           23 מכון כושר      11 שיווק
  41 אוכל לבית           23 תקשורת         10 אבא
  33 ליים                23 בנקאות         10 BMW s1000
  32 אפליקציות           23 דלק            10 שונות (הכנסות)
  28 שונות               22 ביגוד          10 חניה
  26 בית                 20 לימודים         9 רוביקון
  26 אפולו               16 מונית
  25 הכנסה 1 — משכורת     13 ביטוח רכב
  23 הכנסה 2 — עסק SRC    12 ביטוח אישי
```

### From AAA_REBUILD verification (live read via Apps Script)

After applying the 8 renames + 4 deletes + SUMPRODUCT formulas (PR #151):

```
מאזן אישי B4 = empty -> formulas fall back to YEAR(TODAY()) = 2026
  row 61 הכנסה 1 — משכורת: ₪18,582
  row 62 הכנסה 2 — עסק SRC: ₪9,299.50
  row 66 מכון כושר:        ₪1,744
  row 77 ביטוח רכב:        ₪843
  row 78 רוביקון:          ₪1,400
  row 79 חניה:             ₪454
  row 81 BMW s1000:        ₪0 (no 2026 spend yet — correct)
  row 85 ביגוד:            ₪1,684
```

Underlying historical data verified (direct row-level sum):
```
רוביקון TOTAL across all years: ₪172,726
  └ in 2025 alone:               ₪171,326
  └ in 2026 so far:              ₪1,400
ביגוד  TOTAL across all years:  ₪24,800
  └ in 2025 alone:               ₪12,539
```

## Historical-data status — by year (LIVE-CONFIRMED 2026-05-29 7:27 IL)

Apps Script `AAA_WS3` run against NEW sheet:

| Year | OLD תנועות rows | NEW תנועות rows | Parity | Verdict |
|------|----------------|----------------|--------|---------|
| 2023 | 2              | **2**          | 100%   | ✓ migrated |
| 2024 | 221            | **221**        | 100%   | ✓ migrated |
| 2025 | 218            | **218**        | 100%   | ✓ migrated |
| 2026 | 174            | **174**        | 100%   | ✓ migrated + live appends |
| **Total** | **615**     | **615**        | 100%   | ✓ **all 4 years intact** |

NEW `תנועות.getLastRow() - 1` = 619 (includes a few non-YYYY-MM rows; the 615 valid is what matters).

## NEW sheet live tab inventory (LIVE 2026-05-29 7:27)

```
NEW tabs (7):
  - מאזן אישי       (85 rows)   ← personal dashboard
  - _DIFF_REPORT_   (221 rows)  ← hidden audit report from sheet-diff tool
  - מאזן חברה       (16 rows)   ← business dashboard
  - ML Audit        (5 rows)    ← (small)
  - מילון לימוד     (2 rows)    ← Hebrew→category dictionary
  - תנועות          (620 rows)  ← raw transactions
  - הזמנות          (31 rows)   ← orders (30 data rows + header) — INCLUDES OLD 29 + 1 new!
```

## Notes / comments status

| Source | Status | Evidence |
|--------|--------|----------|
| OLD `תנועות` row notes | **Unknown** — not audited live | `MIGRATE_OLD_NOTES.gs` exists in the bot project — Steven would have had to run it manually. No evidence in this session that he did. |
| OLD `מאזן אישי` dashboard cell notes | **Unknown** | Same |
| OLD `מאזן חברה` cell notes | **Unknown** | Same |
| NEW bot-written cell notes | ✓ Active | PR #144 (cell-note year separator) is deployed and working — Steven confirmed bot updated and deployed |
| NEW dashboard cell notes | ✓ Live and populating | `_dashboardDetailNote_` + `setDashboardNoteForTransaction_` in `bot/ExpenseBot_FIXED.gs:11829` |

## Tabs missing from NEW that the OLD had

Per the SHEET_DIFF inventory above, these OLD tabs do NOT exist in NEW (some are intentionally backup/legacy, others may be data we lost track of):

| OLD tab | Worth migrating? |
|---------|-----------------|
| `Auto Synonyms` | **Yes** — could feed bot's CATEGORY_MAP |
| `_BACKUPS_` | No — internal |
| `QA_DUPLICATES`, `_QA_REPORT_` | No — internal |
| `backup 20260528_0607`, `dontdelete` | No — backups |
| `אתחים` | **Unknown** — needs Steven to confirm what this is |
| `חברה 2026 לא לגעת` | **Yes** — likely current-year business reference |
| `לא לגעת — אופציות` | **Yes** — Steven's options tracking |
| `מאזן אישי 2023`, `מאזן אישי 2024`, `מאזן אישי 2025` | **Yes** — per-year personal historical snapshots |
| `מאזן שנתי — לא לגעת` | **Yes** — annual reference |
| `מילון לימוד` | **Yes** — already exists in NEW (verified — was in NEW's 6-tab list) |
| `תיק השקעות` (twice) | **Yes** — investment portfolio tracking |
| `הזמנות` | **CRITICAL** — orders tab has 0 rows in NEW (OLD had 29) |

## Severity-tagged findings (REVISED with live data)

| Severity | Type | Finding | Recommended fix | Can fix safely now? |
|----------|------|---------|-----------------|---------------------|
| ~~CRITICAL — RESOLVED~~ | ~~data loss~~ | ~~`הזמנות` empty in NEW~~ | Live: NEW `הזמנות` has 30 rows (OLD had 29 → +1 new). ✓ Migrated. | n/a |
| ~~HIGH — RESOLVED~~ | ~~data verify~~ | ~~2023/2024 counts unconfirmed~~ | Live: 2023=2, 2024=221, 2025=218, 2026=174 = 100% parity per year. ✓ | n/a |
| **MEDIUM** | data loss | OLD `תיק השקעות` (investment portfolio) tabs missing in NEW | Inventory what's in OLD; decide migrate vs read-only reference | No — Steven decides |
| **MEDIUM** | data loss | OLD `מאזן אישי 2023/2024/2025` per-year SNAPSHOT tabs not migrated. These are dashboards-as-of-year-end, not raw data (raw is in `תנועות`). | Snapshot per-year totals into new `סיכום היסטורי` tab (read-only ref) | No — Steven decides |
| **MEDIUM** | data loss | OLD cell notes likely never migrated (no evidence Steven ran `MIGRATE_OLD_NOTES.gs`) | Run a DRY_RUN of `MIGRATE_OLD_NOTES.gs` to inventory how many notes exist + propose APPLY | No — confirm runbook with Steven |
| **MEDIUM** | hygiene | `_DIFF_REPORT_` (221 rows) is a hidden audit tab left over from the SHEET_DIFF tool; not harmful but adds noise | Delete or leave hidden — Steven's call | Yes — non-destructive (hide-only) |
| **LOW** | nice-to-have | OLD `Auto Synonyms` tab could feed bot federated learning | Read OLD → import as KV `categories:synonyms:master` | No — needs design |
| **LOW** | nice-to-have | OLD `חברה 2026 לא לגעת` could feed business-side reference | Inventory + decide | No — Steven decides |

## Safe fixes I can do now (no APPLY)

1. Create a follow-up `bot/AUDIT_HISTORICAL_AND_NOTES.gs` paste-once tool that just READS:
   - OLD all tabs + row counts
   - OLD `תנועות` per-year counts vs NEW
   - OLD cell-note counts on `מאזן אישי`, `מאזן חברה`, `תנועות`
   - OLD `הזמנות` row sample + col schema for migration planning
   - **Reports only** — no writes.

2. Document the verdict in a new `docs/MIGRATION_GAPS_2026_05_29.md` (this file is the start).

3. Open Monday tasks for each CRITICAL/HIGH item (already in this session's Monday backlog as task #229 family).

## Five-bullet summary (REVISED with live data)

- ✅ **Historical row data IS migrated end-to-end**: 615/615 transactions across 2023-2026 = 100% parity. `הזמנות` has 30 rows (OLD had 29 + 1 newer). The earlier scary "0 rows" alert was a measurement artifact, not real data loss.
- ✅ **2025 spend live-verified**: רוביקון = ₪171,326 in 2025, ביגוד = ₪12,539. Real numbers, real history.
- ⚠️ **MEDIUM gap: cell notes from OLD** — `MIGRATE_OLD_NOTES.gs` exists in the bot project but I have NO evidence Steven ran it. Likely an unmigrated gap (impact: hover-to-explain history lost).
- ⚠️ **MEDIUM gap: OLD per-year snapshot tabs + תיק השקעות** — these are dashboard-as-of-year-end reference views, not the raw data (raw is intact). Decision needed from Steven: migrate as read-only `סיכום היסטורי` tab or leave as historical reference in OLD.
- 🟡 **LOW hygiene: `_DIFF_REPORT_` hidden tab** (221 rows) — leftover from SHEET_DIFF tool; Steven can hide or leave.
