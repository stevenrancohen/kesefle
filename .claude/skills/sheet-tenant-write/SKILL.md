---
name: sheet-tenant-write
description: Pattern for writing a row to a tenant user's Google Sheet via /api/sheet/append, including phone resolution, encrypted refresh-token unwrap, and the isolation invariant.
---

# Tenant sheet write (`/api/sheet/append`)

`api/sheet/append.js` is the canonical bridge the bot uses to write to a non-owner user's sheet. Bot keeps the rich parser; this endpoint handles auth + Sheets API call. Use this pattern for ANY new tenant write you add.

## The invariant
phone → KV `phone:{digits}` → `{ sub: 'google-oauth-sub' }` → KV `user:{sub}` → `{ refresh_token (encrypted), sheet_id }`. Write target is `sheet:{sub}` (canonical). Abort if `phone:{digits}.sub` doesn't match the user record's identity.

## Steps
1. POST body MUST include: `phone`, `amount`, `category`, `rawText`, `messageId`, `botSecret` (or `x-kesefle-bot-secret` header).
2. Endpoint verifies `botSecret` against `process.env.KESEFLE_BOT_SECRET` — missing env → fail closed (501), never write.
3. Resolve `phone:{phone}` from KV. If absent, return `no_user_for_phone`. Do NOT fall back to a default sheet.
4. Use `appendRowToUserSheet` (`lib/sheet-writer.js:1123`) — never write directly via sheets API in a new endpoint; the helper enforces tenant isolation.
5. Use `buildExpenseRow` (`lib/sheet-writer.js:1066`) to construct the row — handles `sanitizeForSheet` (formula injection guard).
6. Rate-limit via `withRateLimit({ key: 'sheet_append', limit: 60, windowSec: 60 })` per phone.

## Verification
- `node tests/full_qa.js` — has a guard that asserts append.js + recurring.js use `appendRowToUserSheet`.
- New test: send a row for a known test phone, confirm the row lands in THAT phone's sheet and nowhere else.
- `node bot/test_isolation.js`.

## Common pitfalls
- Falling back to `SHEET_ID` (the owner's master) when phone is unknown → catastrophic data leak. Always fail.
- Skipping `sanitizeForSheet` → formula injection vector.
- Logging the refresh token or the encrypted bundle → PII leak in Vercel logs.
