# Dashboard Migration Runbook — bring Steven's OLD categories into NEW

**Purpose:** The 614 transactions migrated cleanly into NEW `תנועות`. The dashboard labels did not — so the bot's writes land in `תנועות` but no SUMIFS on `מאזן אישי` / `מאזן חברה` sums them. This tool appends the missing labels as a **visible** section on each dashboard with `$B$4`-wired SUMIFS formulas (no hidden tabs).

**Safety:**
- Read-only on OLD (`1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`)
- Append-only on NEW (`1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A`)
- Backed up to `DocumentProperties` before any write
- Gated by Script Property `CONFIRM_MIGRATE_DASHBOARD = YES I UNDERSTAND`
- Fully reversible via `ROLLBACK_MIGRATE_DASHBOARD`
- No formula hardcodes `2026` — every SUMIFS references `$B$4`

## Step 1 — Open the bot Apps Script project

https://script.google.com/home/projects/1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo/edit

## Step 2 — Create the script file

1. In the left **קבצים** panel, click **+** → **סקריפט**.
2. Name it `MIGRATE_DASHBOARD_FROM_OLD`.

## Step 3 — Paste the code

The repo is now private, so use the local file:

1. On your Mac, open `~/Documents/Claude/Projects/kesefle/bot/MIGRATE_DASHBOARD_FROM_OLD.gs` in any text editor (TextEdit, VS Code, etc.).
2. `Cmd+A` → `Cmd+C` to copy everything.
3. In Apps Script, click in the editor, `Cmd+V` to paste, `Cmd+S` to save.

## Step 4 — Self-test Hebrew

1. Top toolbar function dropdown → pick **`MDD_SELF_TEST_HEBREW`**.
2. Click **Run**.
3. Open the execution log (`Cmd+Enter` or **View → Logs**).
4. You should see:
   ```
   תנועות     -> תנועות
   מאזן אישי  -> מאזן אישי
   מאזן חברה  -> מאזן חברה
   banner     -> 🏷️ מהגיליון הקודם
   ```
5. If any of those look like `???` or boxes, **stop** — Hebrew got corrupted on paste. Re-copy from the source file.

## Step 5 — DRY_RUN (no writes)

1. Function dropdown → pick **`DRY_RUN_MIGRATE_DASHBOARD`**.
2. Click **Run**. Wait ~20 seconds.
3. Read the execution log. You'll see something like:
   ```
   === MDD DRY_RUN ===
   OLD sheet: 1UKrX...
   NEW sheet: 1rti...

   Year selector cells:
     מאזן אישי!B4  -> MISSING — will add
     מאזן חברה!B4  -> B4

   Personal dashboard:
     OLD labels: 49
     NEW labels: 52
     Missing in NEW: 20
       + רוביקון
       + אבא
       + גיא
       + חצי אירון מן
       ...

   Business dashboard:
     OLD labels: 98
     NEW labels: 13
     Missing in NEW: 42
       + ...

   APPLY would:
     1. Backup affected ranges to DocumentProperties
     2. Ensure $B$4 year selector on both dashboards
     3. Append "🏷️ מהגיליון הקודם" banner at the bottom of each dashboard
     4. Append 20 rows to מאזן אישי
     5. Append 42 rows to מאזן חברה
     6. Each row gets a yearly SUMIFS (col B) + 12 monthly SUMIFS (cols C..N), all $B$4-wired

   No writes performed.
   ```
4. **Read the missing-labels list carefully.** If you see any label you do NOT want migrated (e.g. duplicates, garbage), tell me — I'll patch the script before APPLY.

## Step 6 — Set the approval gate

1. In Apps Script: **Project Settings** (gear icon, bottom-left).
2. Scroll to **Script Properties**.
3. Click **Add script property**.
4. Property: `CONFIRM_MIGRATE_DASHBOARD`
5. Value: `YES I UNDERSTAND`
6. Click **Save script properties**.

## Step 7 — APPLY

1. Function dropdown → **`APPLY_MIGRATE_DASHBOARD`**.
2. Click **Run**. Wait ~60 seconds (writes ~60 rows × 14 columns = ~840 cells).
3. Execution log will say:
   ```
   [BACKUP] saved key mdd_backup_<timestamp>
   [YEAR_SEL] מאזן אישי!B4 ready
   [YEAR_SEL] מאזן חברה!B4 ready
   [APPEND] מאזן אישי!A<N> = רוביקון
   [APPEND] מאזן אישי!A<N+1> = אבא
   ...
   === APPLY done ===
   Personal rows appended: 20
   Business rows appended: 42
   Backup key: mdd_backup_<timestamp>
   ```

## Step 8 — Verify in the NEW sheet

1. Open https://docs.google.com/spreadsheets/d/1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A/edit
2. Switch to `מאזן אישי` → scroll to the bottom → you should see the yellow `🏷️ מהגיליון הקודם` banner + 20 new rows.
3. Each row's col B (yearly total) should show a non-zero number for categories you've had expenses in.
4. The `B4` cell should now be a dropdown with `2023 / 2024 / 2025 / 2026 / 2027 / ...`.
5. Click `B4` → change to `2024` → all totals refresh to 2024 data.
6. Click `B4` → change to `2023` → all totals refresh to 2023 data.
7. Repeat on `מאזן חברה`.

## If something looks wrong — ROLLBACK

1. Function dropdown → **`ROLLBACK_MIGRATE_DASHBOARD`**.
2. Click **Run**.
3. Log will say:
   ```
   === ROLLBACK done ===
   Restored from backup mdd_backup_<timestamp>
   Personal rows pruned to <N>
   Business rows pruned to <N>
   ```
4. The dashboards return to exactly the state they were in before APPLY.
5. `CONFIRM_MIGRATE_DASHBOARD` is auto-deleted so you can't accidentally re-APPLY.

## What this does NOT do (yet)

- It does NOT update the bot's `CATEGORY_MAP` — so if the bot is currently classifying `רוביקון` as `שונות`, the dashboard row will be zero (correctly) until we add `רוביקון` keywords to the bot. That's the next PR after this one.
- It does NOT delete or modify existing rows in your NEW dashboards.
- It does NOT touch your OLD sheet.
- It does NOT change `תנועות` or `הזמנות`.

## What to send me when you're done

Screenshot of:
1. The execution log after APPLY (so I see how many rows landed).
2. The bottom of `מאזן אישי` showing the new `🏷️ מהגיליון הקודם` banner + rows.
3. The `B4` dropdown changed to `2024` showing non-zero totals.

That tells me the year selector + SUMIFS are wired correctly, and I'll start the bot CATEGORY_MAP sync (so future expenses route to the right new rows).
