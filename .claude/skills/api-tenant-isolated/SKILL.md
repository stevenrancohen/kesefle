---
name: api-tenant-isolated
description: Verify a new or changed API endpoint cannot read/write across tenant boundaries — review the identity-to-sheet resolution chain end-to-end.
---

# Tenant isolation review (new endpoint)

Run this for any endpoint that touches a Google Sheet, KV user record, or any per-user data. One mistake here = wrong-tenant data leak. The non-negotiable invariant is documented in the `security-scan` skill and enforced by `tests/full_qa.js`.

## Checklist
1. **Identity source**: `req.user.sub` (auth'd) or resolved from `phone:{digits}` → `{ sub }` (bot). Reject if missing.
2. **Authorization**: the identity has the right to access the requested object. Never trust an object id passed in the body — derive it from identity:
   - `const userRec = await kvGet('user:' + sub)`.
   - `const sheetId = userRec?.sheet_id`. If absent, return `no_sheet`.
3. **No hardcoded sheet id**: grep your new file for `SHEET_ID`, `KESEFLE_TEMPLATE_SHEET_ID`, hardcoded `1UKr...`. Should not appear except as a fallback the bot's owner-only path explicitly takes.
4. **Cross-check helpers**: if you call `appendRowToUserSheet` (`lib/sheet-writer.js:1123`), the helper enforces identity. If you call sheets API directly, you've bypassed the guard — refactor to use the helper.
5. **Read paths**: same rule. A "summary" endpoint must read from the caller's `sheet_id`, not a passed-in id.
6. **Logs**: never log full refresh tokens, full sheet IDs, raw expense rows. Use `lib/log.js` redactors.

## Verification
- Add a static assertion to `tests/full_qa.js` that the new endpoint sources its sheet id from `user:{sub}`. The existing guard for append + recurring is a model.
- Manual: create two test users with different sheets. Auth as user A, hit the endpoint with user B's id in the body → must return 403 / ignore the body id.
- Run `node bot/test_isolation.js`.

## Common pitfalls
- Accepting `sheet_id` in the body "for convenience".
- Trusting a phone number passed in body without re-resolving through KV.
- Owner path writing through the SAME helper as tenant path but with a special-case branch that bypasses the identity check — keep the helper closed and put the owner-only path in a separate code path.
