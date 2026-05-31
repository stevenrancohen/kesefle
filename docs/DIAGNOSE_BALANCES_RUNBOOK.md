# DIAGNOSE_BALANCES — read-only sheet diagnostic

## Why
You reported (1) `הכנסה 2 — עסק` is empty (should be the business net profit) and
(2) lots of errors in `מאזן אישי` — e.g. `סה״כ הוצאות` sums only the fixed section.
The browser shows cell **values**, not **formulas** — so I need Apps Script to read
the actual formulas off your live sheet before I build any fix. This tool only
**reads**. It cannot change anything.

## Steps (1 minute)

1. Open Apps Script:
   https://script.google.com/home/projects/1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo/edit
2. Click **+** → **סקריפט** → name it `DIAGNOSE_BALANCES`.
3. On your Mac open `~/Documents/Claude/Projects/kesefle/bot/DIAGNOSE_BALANCES.gs`
   in TextEdit → `Cmd+A` → `Cmd+C`.
4. In the Apps Script editor: click in the code area → `Cmd+V` → `Cmd+S`.
5. Function dropdown → **`DB_SELF_TEST_HEBREW`** → **Run**. The log should print
   `מאזן אישי / מאזן חברה / רווח נטו` readably. (If it shows garbage, tell me — encoding issue.)
6. Function dropdown → **`DB_RUN_ALL`** → **Run**. Wait ~10 seconds.
7. **View → Logs** (or the Executions panel) → copy the **entire** log and send it to me.

## What I do with it
From the dump I will:
- find the exact buggy `סה״כ הוצאות` formula + every other broken total in `מאזן אישי`,
- see how many `מאזן חברה*` tabs you have today and where each net-profit row sits,
- then build ONE gated fix tool (DRY_RUN → APPLY → ROLLBACK, backup-first) that:
  1. fixes `סה״כ הוצאות` to sum **all** expense sections,
  2. relabels income to משכורת / עסק 1 / עסק 2 / עסק 3 / הכנסה נוסף / שונות,
  3. wires each `עסק N` to the net profit of `מאזן חברה N`, **all years** via the year selector.

Nothing gets written until you see the DRY_RUN and approve it.

## Safety
- Read-only: zero `setValue`/`setFormula`/`setNote`/`insertSheet`/`deleteRow` in the file.
- Never opens the OLD sheet.
- Safe to run repeatedly.
