---
name: sheet-add-tab
description: Add a new tab (e.g. budget, recurring, audit log) to the tenant sheet template in lib/sheet-writer.js without breaking existing per-tenant sheets.
---

# Add a new tab to the template

Sheets are provisioned by `buildTenantSheetSpec` in `lib/sheet-writer.js:726`. Adding a tab affects every NEW sheet from the next deploy on; OLD tenant sheets do not auto-gain the tab.

## Steps
1. Decide if the tab is essential (every user needs it) or optional (only some users). Optional → consider a per-user add via API instead.
2. In `buildTenantSheetSpec`, append a new entry to the `sheets` array. Specify:
   - `properties.title` (Hebrew, short — visible to the user).
   - `properties.tabColor` (use the existing palette so the tab strip stays consistent).
   - `properties.gridProperties.{frozenRowCount, frozenColumnCount}`.
3. Add a separate `requests` block for headers + initial formulas — keep formulas SELF-CONTAINED on the new tab (don't cross-reference יotted-row positions on תנועות).
4. Bump the spec version if you track it.
5. Write a small migration script in `scripts/` to add the tab to existing tenant sheets, gated on dry-run / opt-in. Run on Steven's own sheet first.

## Verification
- `node --check lib/sheet-writer.js`.
- Provision a brand-new test user end-to-end; the new tab appears with headers, no `#REF!`.
- Open one existing user (Steven) and confirm the tab doesn't appear UNTIL the migration script runs.

## Common pitfalls
- Cross-referencing the new tab from תנועות formulas — couples the tabs, fragile.
- Forgetting that `appendRowToTab` (lib/sheet-writer.js) must support the new tab name if anyone will write to it programmatically.
- Permissions: a new tab inherits sheet-level sharing; nothing to do unless you want it restricted.
