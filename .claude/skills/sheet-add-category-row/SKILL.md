---
name: sheet-add-category-row
description: Add a new category row to a tenant's sheet via _addCategoryRows_ — the safer alternative to restructuring the template in lib/sheet-writer.js.
---

# Add a category row (`_addCategoryRows_`)

`_addCategoryRows_(fromPhone, rawNames)` in `bot/ExpenseBot_FIXED.gs:3837` calls `/api/sheet/add-category-row` to APPEND a new category section to a user's existing sheet — no template changes, no migration. This is the right tool when a user requests a category we don't have, or when we want to add one without rebuilding `buildTenantSheetSpec`.

## Steps
1. Determine the category name (Hebrew, short, no slashes; subcategories handled separately).
2. From the bot: trigger via the existing user flow (a message that resolves to `_addCategoryRows_`). Existing call sites: ~line 4484 (pet name), 4495 (car), 4544 (free-form add).
3. From the API: POST `/api/sheet/add-category-row` with `{ phone, names: ['קטגוריה חדשה'], botSecret }`. See `api/sheet/add-category-row.js`.
4. Backend: appends a row to the תנועות or categories block, extends the dashboard SUMIFS range, returns the new row index.
5. The bot replies to the user confirming the new category is live.

## Verification
- Send a test message that creates a new category for a test user. Confirm the row appears AND a dashboard cell tracks it.
- `_addCategoryRows_` logs HTTP errors (line ~3885) — read the Apps Script execution log if the bot replies "couldn't add".
- Run `node bot/test_isolation.js` after — the add path must respect tenant isolation.

## Common pitfalls
- Calling `_addCategoryRows_` for the owner — the owner's master sheet uses `buildTenantSheetSpec` semantics; the helper may or may not be wired the same way (check the gate at line ~4117).
- Adding the same category twice — endpoint should dedupe; if it doesn't, you'll see duplicate rows.
- Long names break the dashboard column width — keep under ~20 chars.
