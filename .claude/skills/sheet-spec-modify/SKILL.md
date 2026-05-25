---
name: sheet-spec-modify
description: Modify buildTenantSheetSpec in lib/sheet-writer.js without breaking SUMIFS/INDIRECT formulas that depend on hard-coded row positions in the tenant template.
---

# Modify `buildTenantSheetSpec`

`lib/sheet-writer.js` line ~726 builds the per-tenant Google Sheet at provision time. Dashboard formulas (`SUMIFS`, `QUERY`, `INDIRECT`) reference specific rows by NUMBER. Insert a row anywhere above an existing reference and you silently break every dashboard for every new user provisioned after that commit.

## Steps
1. Open `lib/sheet-writer.js`, find `buildTenantSheetSpec` (~line 726). Read it fully before changing.
2. Before adding a row to the תנועות / categories block: search the spec for `SUMIFS(`, `'תנועות'!`, `INDIRECT(`. Note every row number referenced.
3. PREFER appending at the bottom or using `_addCategoryRows_` post-provision (see `sheet-add-category-row`) instead of editing the template.
4. If you MUST insert mid-template:
   - Add the row.
   - Update EVERY row-numbered reference (formulas + range definitions) by the offset.
   - Update `buildPieChartRequests` (line ~767) if the chart's data range moved.
5. Test by provisioning a new sheet for a throwaway user and visually checking the dashboard renders, then add a permanent line of data and confirm SUMIFS picks it up.

## Verification
- `node tests/full_qa.js` (it loads the builder).
- Provision a fresh sheet in dev: `node -e "import('./lib/sheet-writer.js').then(m=>console.log(m.buildTenantSheetSpec('test',{}).sheets.length))"`.
- Open the new sheet; every dashboard cell renders (no `#REF!` or `#N/A`).

## Common pitfalls
- "Just add one row" is the #1 source of broken-dashboard tickets. Use `_addCategoryRows_` instead.
- Editing the template doesn't backfill EXISTING tenants — old sheets keep their old layout. Plan a migration if needed.
- Forgetting that the retry path at ~line 875–909 rebuilds the spec twice — both invocations must produce the same result.
