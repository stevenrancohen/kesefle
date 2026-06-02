# CELL_NOTES_INVENTORY_TAB_BY_TAB — paste-once inventory tool

## Why this exists

Inventory cell notes (`setNote` / `getNote`) across:
- OLD `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`
- NEW `1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A`

A previous full-sweep tool hit the **6-minute Apps Script cap** because
OLD has multiple year tabs (2023/2024/2025/2026) plus דשבורד / תנועות /
הזמנות. This tool processes **ONE TAB PER RUN** via Script Property
`CNI_TAB_NAME`. Fits under 6 min because we use a single batched
`getNotes()` per tab and iterate the 2D array in memory.

## Safety guarantees

- **OLD sheet is READ-ONLY FOREVER.** This tool never calls `setNote`,
  `setValue`, `setFormula`, `clearContents`, or `deleteRow` on OLD.
- **No APPLY variant.** This is inventory-only. No mutation paths exist.
- **NEW is also never written.** Inventory-only on both sides.
- **LockService.getScriptLock + tryLock(30000)** at every entry point so
  concurrent runs don't race.
- **Output capped at 200 cells per tab.** Anything beyond is summarized
  ("... +N more"), so the Logger never overflows.

## Steps (per-tab workflow)

### Step 1 — Paste the code
1. Open the Kesefle Apps Script project.
2. Create a new script file `CELL_NOTES_INVENTORY_TAB_BY_TAB`.
3. Paste the contents of `bot/CELL_NOTES_INVENTORY_TAB_BY_TAB.gs`.
4. Save (`Cmd+S`).

### Step 2 — Self-test Hebrew
1. Function dropdown → `CNI_SELF_TEST_HEBREW` → Run.
2. The log should show `תנועות / הזמנות / מאזן חברה / מאזן אישי / דשבורד`
   rendered correctly. If you see boxes or `?` — re-paste the file
   (clipboard mangled the UTF-8 escapes).

### Step 3 — List tabs in OLD and NEW
1. Function dropdown → `CNI_LIST_TABS_OLD` → Run. Copy the log.
2. Function dropdown → `CNI_LIST_TABS_NEW` → Run. Copy the log.
3. You now have the exact Hebrew tab name strings to use in Step 4.

### Step 4 — Inventory one OLD tab
1. Project Settings → Script Properties → add:
   - Key: `CNI_TAB_NAME`
   - Value: paste the exact Hebrew tab name from Step 3 (e.g. `תנועות`).
2. Function dropdown → `CNI_INVENTORY_ONE_TAB_OLD` → Run.
3. The log will show:
   ```
   === CNI_INVENTORY_ONE_TAB_OLD ===
   Tab: <name>  Rows: <N>  Cols: <M>
   Cells with notes: <count>
     A1 [<first 80 chars of note>]
     B5 [<first 80 chars>]
     ...
   ```
4. Copy the log to a safe place — Apps Script logs are wiped after ~7 days.

### Step 5 — Next tab
1. Change `CNI_TAB_NAME` in Script Properties to the next OLD tab.
2. Run `CNI_INVENTORY_ONE_TAB_OLD` again.
3. Repeat for every OLD tab (2023, 2024, 2025, 2026, דשבורד, תנועות,
   הזמנות, etc.).

### Step 6 — NEW sheet (faster path)
NEW is post-migration and smaller. Two options:
- **Per-tab** (mirrors the OLD workflow): set `CNI_TAB_NAME`, run
  `CNI_INVENTORY_ONE_TAB_NEW`, repeat.
- **All at once**: run `CNI_INVENTORY_ALL_TABS_NEW`. It scans every NEW
  tab in a single execution and prints one block per tab plus a
  grand-total summary. Fits in 6 minutes because NEW is smaller.

## Troubleshooting
- "another run is in progress" → wait 30s, re-run (lock auto-releases).
- "Tab X not found" → re-run `CNI_LIST_TABS_*` and copy the exact name
  from the log output (chat-paste can inject bidi marks).
