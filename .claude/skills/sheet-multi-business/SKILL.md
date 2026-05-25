---
name: sheet-multi-business
description: Pattern for routing "עסק N" (business N) messages to the correct business tab/section in a multi-business owner's sheet.
---

# Multi-business routing ("עסק N")

Owner-only feature. The owner writes `עסק 1 ...` or `עסק 880 לקוח ליה ...` to log to the Nth business's bucket. Parsed in `bot/ExpenseBot_FIXED.gs` (search the file for `'עסק '` — example at line ~737). Each business maps to its own column block on the דשבורד tab; rows go into תנועות tagged with the business id.

## Steps for adding business N
1. Confirm the user is an owner (`_isOwnerPhone_`) — non-owners must not see business routing.
2. Parse the leading `עסק <id>` token; the rest of the message is the normal expense.
3. Tag the תנועות row with the business id in the dedicated column (typically column H or the configured business-tag column — confirm in `buildExpenseRow` in `lib/sheet-writer.js:1066`).
4. Dashboard column for business N must already exist; if not, fail with a clear reply ("עסק לא קיים").
5. Run `_bucketForBizSub_` (in `bot/personal_sheet_fix.gs:535`) to map the parsed subcategory into the right bucket row.

## Verification
- Send a `עסק 1 ...` message — row appears in תנועות tagged with `1`, dashboard column for business 1 updates.
- Send `עסק 99 ...` (no such business) — bot replies with a clean error, no row written.
- `node bot/test_parser.js` covers your edge cases.

## Common pitfalls
- Non-owner sneaks `עסק 1` into a message — block early in the routing.
- Parsing `עסק` as the start of every message in some flows — anchor the regex (`/^עסק\s+(\d+)\b/`).
- Adding a new business but forgetting the dashboard column — leads to silent zero totals.
