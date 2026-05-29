---
name: kesefle-formula-validator
description: Validate Kesefle dashboard formulas — no hardcoded years, no #REF!/#NAME?, no references to OLD sheet, all SUMIFS use the canonical category sub names from _BIZ_DASH_SUBS.
---

# kesefle-formula-validator

When invoked: scan formula bodies for known anti-patterns.

## Inputs
- `target` — either a sheet ID (live read) or a path to a `.gs` file (static scan)

## Anti-patterns (fail conditions)
1. Hardcoded year strings: `"2026-"`, `"2025-01"`, `DATE(2026,`, `YEAR(2026)` — must use `$B$4`
2. `#REF!`, `#NAME?`, `#VALUE!`, `#DIV/0!` literals in cell results
3. References to OLD sheet ID `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`
4. SUMIFS criteria using short sub names where dashboard expects canonical (e.g. `שיווק` instead of `עלות שיווק`) — cross-ref `_BIZ_DASH_SUBS`
5. Cell-range references that include the row 4 header (typical off-by-one)
6. `INDIRECT` against constructed tab names — fragile, flag for review

## Pass criteria
- 0 fail-condition matches
- All year refs go through `$B$4` or `Settings!active_year`

## Outputs
- Console exit code: 0 = pass, 1 = fail
- Markdown report: `formula-validation-{YYYY-MM-DD}.md` listing every match with file:line:formula
- Optional `--fix-suggestions` flag emits a remediation patch (does NOT apply)

## Hard NO
- No automatic formula rewrite
- No live sheet modification
