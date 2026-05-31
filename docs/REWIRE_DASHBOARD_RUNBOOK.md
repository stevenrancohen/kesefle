# REWIRE_DASHBOARD_TO_B4 — Steven's live-dashboard fix

## Why this exists

Your `מאזן חברה` shows ₪0 for `מחזור ברוטו`, `מס׳ הזמנות`, etc. on every year (2023/2024/2025). When you flip `B4`, totals don't change. This is the **WS2 HIGH** finding from deep-review PR #152 hitting your **live** data.

**Root cause:** the installer that generated those rows baked the install-time year into the SUMIFS criterion text. PR #157 fixed the installer code — but your existing rows still have the frozen formulas. They show whatever year was current when the installer ran, and are blind to your `B4` selector.

**Fix:** this paste-once script reads each existing dashboard cell, detects the hardcoded year, and rewrites it to `SUMPRODUCT + LEFT(B,4) = $B$4` — the same pattern PR #151 used for your appended `רוביקון/אבא/גיא` rows that work correctly.

## Safety guarantees

- **Read-only OLD sheet** — script never opens `1UKrX...`.
- **Reads NEW sheet `מאזן חברה` + `מאזן אישי`** rows 5-100.
- **DRY_RUN** logs the planned changes; **writes nothing**.
- **APPLY** is gated by Script Property `CONFIRM_REWIRE_DASHBOARD = YES I UNDERSTAND`.
- **Snapshots every cell** before overwriting; `ROLLBACK_REWIRE_DASHBOARD` restores exactly.
- **LockService** prevents concurrent runs.
- **Skips cells already wired to `$B$4`** (your `רוביקון`/`אבא` rows from PR #151 + #156).

## Steps (5 minutes)

### Step 1 — Open Apps Script
https://script.google.com/home/projects/1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo/edit

### Step 2 — Create script file
1. Click **+** → **סקריפט** → name it `REWIRE_DASHBOARD_TO_B4`.

### Step 3 — Paste the code
1. On your Mac open `~/Documents/Claude/Projects/kesefle/bot/REWIRE_DASHBOARD_TO_B4.gs` in TextEdit.
2. `Cmd+A` → `Cmd+C`.
3. In Apps Script editor: click in code area → `Cmd+V` → `Cmd+S`.

### Step 4 — Self-test Hebrew
1. Function dropdown → **`RWD_SELF_TEST_HEBREW`** → **Run**.
2. Log should show `מאזן חברה / מאזן אישי / תנועות / הזמנות` rendered correctly.

### Step 5 — DRY_RUN (no writes)
1. Function dropdown → **`DRY_RUN_REWIRE_DASHBOARD`** → **Run**.
2. Wait ~10 seconds.
3. Log should look like:
   ```
   === DRY_RUN_REWIRE_DASHBOARD ===
   ## מאזן חברה
     row 5 (מחזור ברוטו): 13 frozen-year cells
       B [orders|year=2026]
       C [orders|year=2026]
       D [orders|year=2026]
       ... +10 more
     row 6 (מס׳ הזמנות): 13 frozen-year cells
     ...
     Total frozen-year cells in מאזן חברה: ~130
   
   ## מאזן אישי
     row 5 (...): N frozen-year cells
     Total: M
   ```
4. **Send me a screenshot of the DRY_RUN log** so I can confirm the proposed changes look right before APPLY.

### Step 6 — Set the gate (only after we verify DRY_RUN)

1. **Project Settings** (gear icon, bottom-left) → **Script Properties** → **Add property**:
   - Property: `CONFIRM_REWIRE_DASHBOARD`
   - Value: `YES I UNDERSTAND`
2. **Save**.

### Step 7 — APPLY
1. Function dropdown → **`APPLY_REWIRE_DASHBOARD`** → **Run**.
2. Wait ~30 seconds.
3. Log will show:
   ```
   === APPLY_REWIRE_DASHBOARD ===
   ## מאזן חברה
     Written: ~130, Skipped: N (already wired to $B$4)
   ## מאזן אישי
     Written: M, Skipped: N
   Backup key: rwd_backup_<timestamp>
   To roll back: run ROLLBACK_REWIRE_DASHBOARD
   ```

### Step 8 — Verify
1. Open the NEW sheet → `מאזן חברה`.
2. Click `B4` → **2024** → wait 1 sec → `מחזור ברוטו` should show your 2024 mahzor (₪163K+ per earlier screenshots).
3. Click `B4` → **2025** → mahzor should switch to 2025's number.
4. Click `B4` → **2026** → mahzor should switch to 2026's number.
5. Repeat on `מאזן אישי`.

If totals refresh per year → ✅ done.
If anything looks wrong → run **`ROLLBACK_REWIRE_DASHBOARD`** and ping me with the issue.

## What it does NOT touch

- OLD sheet — never opened.
- `תנועות` / `הזמנות` rows — read-only source data.
- Section headers / banners / totals like `רווח נטו חודשי` / `אחוז רווחיות` (these compute from other dashboard cells, not from raw data, so they don't need rewiring).
- Cells already wired to `$B$4` (your `רוביקון` / `אבא` / `מכון כושר` rows from PR #151).
- Cells without formulas (user-typed values).

## What to send me when done

Screenshot of:
1. The DRY_RUN log (Step 5) — so I confirm before APPLY.
2. The APPLY log (Step 7).
3. `מאזן חברה` with `B4` flipped to 2024 → mahzor showing a real number.
4. `B4` flipped to 2025 → mahzor showing a different number.

That tells me the year selector is now fully live across your entire dashboard.
