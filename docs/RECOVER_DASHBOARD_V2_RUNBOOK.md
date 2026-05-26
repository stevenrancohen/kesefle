# Safe RECOVER_DASHBOARD_V2 Runbook

**For:** Steven, running the dashboard recovery in Apps Script.
**Last updated:** 2026-05-26.
**Status:** Active. Use this every time `מאזן חברה` shows ₪0 in cells that should have values.

---

## TL;DR

You will run 3 functions in this exact order. **First two are read-only.** Only the third writes data, and even then it backs up first.

| Step | Function | Writes? | Time |
|------|----------|---------|------|
| 1 | `DIAGNOSE_DASHBOARD_DATA_LOSS_V2` | NO | ~5s |
| 2 | `RECOVER_DASHBOARD_DRY_RUN_V2` | NO | ~10s |
| 3 | `RECOVER_DASHBOARD_APPLY_V2` | YES (after backup) | ~30s |

**Stop between each step. Send me the log. Wait for my confirmation before the next.**

---

## Before-you-start checklist

- [ ] Browser open to Google Sheets — your sheet (ID `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`)
- [ ] Apps Script editor accessible (Tools → Apps Script, or its own tab if you bookmarked it)
- [ ] You have **5–10 minutes of uninterrupted time** (don't run this and walk away)
- [ ] You can take screenshots of the execution log
- [ ] The latest PRs are merged: PR #50, PR #52 (verify on GitHub the SIMPLE_FIX_DASHBOARD delegates to V2)
- [ ] **You have NOT manually edited `מאזן חברה` in the last hour** (the function preserves user > 0 values but a recent edit you haven't saved could be lost)

---

## Step 1 — Paste the latest code

1. Open Apps Script: **Tools → Apps Script** from inside the spreadsheet, or open `script.google.com` and find your kesefle project
2. Click `personal_sheet_fix.gs` in the left sidebar
3. Click anywhere inside the editor → press **Cmd+A** to select all
4. Press **Delete** to clear
5. Open this URL in a new browser tab: **https://raw.githubusercontent.com/stevenrancohen/kesefle/main/bot/personal_sheet_fix.gs**
6. Press **Cmd+A** → **Cmd+C** (copy all)
7. Back in Apps Script editor → click in editor → press **Cmd+V** (paste)
8. Press **Cmd+S** (save). Wait for the save indicator to disappear (no spinning circle).

### How to verify the paste landed

- Scroll to the **bottom** of the file
- The last function should be `_PSF_RECOVER_DASHBOARD_CORE_` — if you see this, you have the V2 code
- The line count at the bottom-left should be around **1,825** lines
- If you see less than 1,700 lines, the paste failed — repeat the steps

---

## Step 2 — Run DIAGNOSE (read-only, no writes)

This function only **reads** your data and tells me what state things are in. It writes **nothing**.

1. In the Apps Script editor, find the function selector dropdown at the top (next to the ▶ Run button)
2. Click the dropdown → scroll → click **`DIAGNOSE_DASHBOARD_DATA_LOSS_V2`**
3. Click **▶ Run**
4. First time only: Apps Script will ask for permissions → click **Review permissions** → choose your Google account → click **Allow**
5. Wait for the log to appear (View → Execution log, or Cmd+Enter)
6. **Screenshot the entire log** and send it to me

### What "success" looks like in the log

```
=== DIAGNOSE_DASHBOARD_DATA_LOSS_V2 ===
Sheet: מאזן אישי
Found N transaction-source tab(s): תנועות, ...
Total rows across all sources: 800 (or similar)
Distinct categories seen (with row counts):
  "" → X rows
  "אישי" → Y rows
  "עסק" → Z rows
  "עסק 1" → ... rows
  "עסק 2" → ... rows
...
With LOOSE filter (cat startsWith "עסק"):
  classified: 200+ (or some real number)
  skipped (cat ≠ עסק*): ...
Months with data: 12+
  2025-01: עלות שיווק=2000, מחזור ברוטו=5000, ...
  2025-02: ...
```

### What "fail" looks like

- `classified: 0` → no business rows match the loose filter either. Your bot is writing categories that don't start with "עסק". Stop and tell me.
- `Found 0 transaction-source tab(s)` → תנועות tab is missing or renamed. Stop.
- `Total rows: 0` → no data anywhere. Don't proceed.

### Do NOT click

- ❌ "Trigger" tab in the left sidebar (don't add or remove triggers yet)
- ❌ Run any other function
- ❌ Edit the code

---

## Step 3 — Run DRY_RUN (read-only, shows what WOULD change)

Still no writes. This function computes the new values and logs every cell it would update, but does not touch the sheet.

1. Function dropdown → **`RECOVER_DASHBOARD_DRY_RUN_V2`** → **▶ Run**
2. **Screenshot the log** and send it to me

### What "success" looks like

```
=== RECOVER_DASHBOARD_V2 (DRY-RUN) ===
Reading N source tab(s): ...
Classified XXX rows across YY months
Year blocks: 2023, 2024, 2025, 2026
  ✏️ WOULD WRITE 2025 עלות שיווק month 1: 0 → 5000
  ✏️ WOULD WRITE 2025 עלות שיווק month 2: 0 → 3200
  ✏️ WOULD WRITE 2026 מחזור ברוטו month 5: 0 → 3000
  🔒 PRESERVED 2026 עלות שיווק month 5 = 2100 (computed 0 — manual entry kept)
  ...
=== DRY-RUN SUMMARY ===
  Cells inspected: 240
  Cells changed:   ~60-100 (depends on your data)
  Cells preserved: 0-5 (manual entries we don't overwrite)
  Nothing was written. Re-run RECOVER_DASHBOARD_APPLY_V2() to apply.
```

### How to read the dry-run

- Each `✏️ WOULD WRITE` line shows: `<year> <bucket> month <N>: <old value> → <new value>`
- If the old value is 0 and new is a real number → recovery
- If the old value is real and new is 0 → preserved (we don't overwrite)
- The summary line tells you how many cells will change

### "Looks right" criteria — confirm BEFORE step 4

- The 2025 monthly totals for `מחזור ברוטו` should be non-zero in most months (because your 2025 annual shows ₪76,385)
- The 2026 marketing for May should still show 2,100 preserved (your manual override)
- No bucket should suddenly show a value 10× higher than the existing annual
- The total preserved count should be ≤10 (most cells were the bug-zero)

### Stop if you see

- "Cells changed: 0" → there's nothing to recover. Send me the log; the bug must be elsewhere.
- "Cells changed > 500" → something is wildly off. **Do not proceed.** Stop and tell me.

---

## Step 4 — APPLY (writes data, backs up first)

**Only proceed after I confirm step 3 looks right.**

1. Function dropdown → **`RECOVER_DASHBOARD_APPLY_V2`** → **▶ Run**
2. Wait. This takes 30–60 seconds.
3. **Screenshot the log** and send it to me

### What happens

- A **hidden backup tab** is created with today's timestamp: `_backup_20260526_HHmm`
- Your existing `מאזן חברה` is copied to that tab (so we can roll back)
- The function then writes the new values cell-by-cell
- Annual SUM formulas are refreshed at the end

### What "success" looks like

```
=== RECOVER_DASHBOARD_V2 (APPLY) ===
✅ Backup created: "_backup_20260526_1430" (hidden tab)
... (same WROTE / PRESERVED lines as dry-run) ...
=== APPLY SUMMARY ===
  Cells inspected: 240
  Cells changed:   ~80
  Cells preserved: 3
  Refresh sheet (Cmd+R). Backup tab is hidden — restore by un-hiding + copying values.
```

### After running

1. Refresh the spreadsheet: **Cmd+R**
2. Open `מאזן חברה` tab
3. Verify the cells now show real values (not all 0s)
4. Send me a screenshot of `מאזן חברה` so I can verify

---

## After-you-finish checklist

- [ ] Log screenshot from step 2 (diagnose) sent to me
- [ ] Log screenshot from step 3 (dry-run) sent to me
- [ ] Confirmation from me that step 3 looks safe
- [ ] Log screenshot from step 4 (apply) sent to me
- [ ] Screenshot of `מאזן חברה` after refresh sent to me
- [ ] Marketing for 2026-05 still shows ₪2,100 (manual override preserved)
- [ ] 2025 annual totals match the column B values you've always had (₪76,385 revenue, etc.)

---

## Rollback plan (if something goes wrong)

The hidden backup tab has your dashboard exactly as it was before this run. To roll back:

1. In Google Sheets, open the spreadsheet
2. **View → Hidden sheets** (or right-click any tab → "Show hidden sheets")
3. Click the backup tab named `_backup_YYYYMMDD_HHmm`
4. **Cmd+A** to select all → **Cmd+C** to copy
5. Click the `מאזן חברה` tab
6. Click cell A1
7. **Cmd+Shift+V** (paste values only — this overwrites the bad data with backup values)
8. Right-click the backup tab → **Delete** (optional, after you confirm rollback worked)

If you cannot find the backup tab, ping me — I can also reconstruct from `תנועות` directly.

---

## Common failure modes and fixes

| Symptom in log | What it means | What to do |
|---|---|---|
| `!! no תנועות tab` | The transactions tab is named differently or missing | Stop. Tell me the tab names you see |
| `classified: 0` | No rows match `cat startsWith "עסק"` either | Bot is writing wrong category. Stop |
| `Total rows: 0` | All source tabs are empty | Your data is genuinely gone. Stop, restore from Google version history |
| `Could not install trigger` | Permissions issue | Ignore — apply still ran |
| Apps Script times out (6 min) | Too many rows in source tabs | Tell me; we'll batch by year |
| `Logger.log` never appears | View → Execution log not opened | Cmd+Enter from inside the editor |

---

## What NOT to do

- ❌ Don't run **`SIMPLE_FIX_DASHBOARD`** alone — it's now a shim that calls V2, but only if you've pasted the latest code (PR #52)
- ❌ Don't run **`FIX_NOW`** until after you've successfully run V2 — `FIX_NOW` installs a daily trigger you don't need yet
- ❌ Don't run **`FIX_ALL_BUCKETS_ALL_YEARS`** — that's the old formula-based fixer; superseded by V2
- ❌ Don't manually edit `מאזן חברה` while V2 is running — wait for the summary line
- ❌ Don't delete the backup tab until you've confirmed recovery worked

---

## When to re-run V2

Run V2 again if:
- You added new transactions and want the dashboard refreshed (manual)
- The daily 6am trigger is broken (you'd see this as cells going stale after a day)
- You see ₪0 in months that should have data (the bug is back)

You can re-run V2 as often as you want. It's idempotent — running it twice writes the same values both times.

---

*Generated 2026-05-26. Ping me before each apply step.*
