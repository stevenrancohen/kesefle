---
name: kesefle-sheet-note-format-check
description: Verify a Kesefle expense cell-note (original FX amount + rate, === YYYY === separator, full dd/MM/yyyy date) matches the live convention in bot/ExpenseBot_FIXED.gs before any note write or migration ships.
---

# Kesefle sheet note format check

Every expense the bot books leaves a human-readable cell note (column F / the dashboard detail cell) so a row can be audited months later. The live convention is fixed and tested. Use this skill before editing any note-building code, before a notes migration, or when a customer says "the note on my row looks wrong". It guards the exact strings produced by `_kfl_buildOriginalNote` + `_composeNoteWithYearSeparator_` + `_dashboardDetailNote_` in `bot/ExpenseBot_FIXED.gs`.

## Steps
1. Read the canonical emitters first; do not invent a format. The three pieces are:
   - FX line — `bot/ExpenseBot_FIXED.gs` around the `processExpense` append (line ~9548): `'FX: ' + foreignAmount + foreignSymbol + ' → ₪' + ilsAmount + ' (rate ' + fxRate + ')'`. So a $12 charge renders `FX: 12$ → ₪44 (rate 3.7)` — original amount + symbol, the arrow, the ILS result, and the rate in parentheses.
   - Year separator + entry line — `_composeNoteWithYearSeparator_`: a `=== YYYY ===` header precedes the first entry of each year, and every entry line is `dd/MM/yyyy HH:mm · ₪<amount> · <description>` (full date INCLUDING the year, middle-dot ` · ` between fields). Example: `=== 2026 ===` then `28/05/2026 23:06 · ₪490 · דלק`.
2. Confirm the three invariants in source, not from memory:
   - Year header is literally `=== ` + year + ` ===` (no localization, no `שנה`): `grep -n "'=== '" bot/ExpenseBot_FIXED.gs`.
   - Date carries the year, not just `dd/MM HH:mm`: `grep -n "dd/MM/yyyy" bot/ExpenseBot_FIXED.gs`.
   - FX line keeps the original foreign amount AND the rate (never just the ILS result): re-read the `__noteExtras.push('FX: '...)` line.
3. A cross-year append must INSERT a new `=== YYYY ===` header before the new line and leave prior years untouched (notes accrete, they are never rewritten). A legacy note with no header gets one inserted before the first new entry.
4. Hebrew in the description segment is fine (it is string data). The `·` is a real middle dot (U+00B7), not a hyphen or a Latin dot — verify the byte if you hand-build an example.
5. If you are bulk-fixing historical notes, this is a financial-data write: go through `kesefle-financial-data-integrity-guard` (backup -> DRY_RUN -> approval -> apply), use `bot/CELL_NOTES_INVENTORY_TAB_BY_TAB.gs` to inventory current notes first, and never touch the OLD sheet `1UKrXDk...` (rollback-comment only; the live target is the new sheet).
6. The original raw WhatsApp text is preserved on its own line by `_kfl_buildOriginalNote('Original WhatsApp', ...)`; the FX line is an EXTRA appended to it, not a replacement. Both must survive the note, alongside the dated dashboard-detail lines.

## Worked example
A row first booked in 2024, then a same-year and a next-year add, with one FX entry — the note should read top-to-bottom:
```
=== 2024 ===
10/01/2024 12:00 · ₪100 · גז
=== 2026 ===
28/05/2026 23:06 · ₪490 · דלק
29/05/2026 10:00 · ₪44 · קפה
FX: 12$ → ₪44 (rate 3.7)
```
- `2024` and its line are untouched when the `2026` entries land; a single `=== 2026 ===` header precedes the first 2026 line only.
- The `₪44` line and its `FX:` extra both carry the original `12$` and the `(rate 3.7)`; the ILS amount alone is never enough.
- Every separator is the U+00B7 middle dot; every date carries the four-digit year.

## Verification
- `node bot/test_cell_note_year_separator.js` exits 0 — its 6 pure-helper cases pin the header insertion, same-year append, different-year append, legacy-note upgrade, and a third-year entry; the wrapper cases pin the `yearTag` + date prefix.
- Manually compose your example and diff against the test's expected strings (e.g. `=== 2026 ===\n28/05/2026 23:06 · ₪490 · דלק`); they must match character-for-character including the `·` and the `===` spacing.
- For an FX case, run `node bot/bot-replay.js --json "12$ קפה"` and confirm the predicted note carries `FX: ...→ ₪... (rate ...)` with the original `12$` preserved.
- After any note-code edit, `node --check bot/ExpenseBot_FIXED.gs` exits 0 and the broader gate (`tests/full_qa.js`, the bot test suites) stays green.

## Common pitfalls
- Dropping the year from the date (`dd/MM HH:mm`) — multi-year rows become un-disambiguatable; the test fails on exactly this.
- Collapsing the FX line to only the ILS amount — the original foreign amount + rate is the whole point of the note; auditing FX is impossible without it.
- Replacing the `·` separator with `-` or `,`, or using a Latin middle dot look-alike — string-equality assertions fail silently in callers keyed on the format.
- REWRITING an existing note instead of appending — notes are an accreting ledger; only insert the missing `=== YYYY ===` header and the new line.
- Editing the note format in `bot/ExpenseBot_FIXED.gs` but testing against the stale `bot/ExpenseBot_DEPLOY.gs`; reassemble via `bot-deploy-paste` and remember the live bot updates only after Steven manually re-pastes (agents never push main).
