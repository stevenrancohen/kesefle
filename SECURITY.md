# Kesefle — Security & Multi‑Tenant Isolation Model

This document records how tenant isolation works, the safeguards in place, and
the results of the security audits. **Isolation = each WhatsApp user's expenses
are written only to that user's own Google Sheet — never to anyone else's.**

## 1. Architecture

- Each user owns a private Google Sheet in **their own** Drive. The Kesefle
  backend never holds the cell data — it only negotiates the Sheets API call
  using **that user's own** OAuth refresh token (AES‑256‑GCM encrypted, AAD bound
  to the user's `userSub`, so a token can't be decrypted for the wrong user).
- KV maps: `phone:{E164}` → `{userSub, spreadsheetId, refreshTokenEnvelope}`;
  `sheet:{userSub}` → canonical sheet; `user:{userSub}` → profile.
- Two inbound write surfaces:
  1. **Apps Script bot** (`ExpenseBot_DEPLOY.gs`) — receives WhatsApp webhooks at
     `doPost`. It has a legacy single‑tenant path that writes to a hardcoded
     `SHEET_ID` (the **owner's** sheet) and a multi‑tenant path that POSTs parsed
     expenses to the Vercel bridge `/api/sheet/append`.
  2. **Vercel** (`/api/whatsapp/webhook.js`, `/api/sheet/append.js`) — resolves
     `phone → userRecord` and writes to that user's own sheet/token.

## 2. The owner gate (the core of isolation)

`SHEET_ID` is the owner's personal sheet. **Only the owner's phone may reach any
code that writes to `SHEET_ID`.** Everyone else is routed to their own sheet via
the bridge, or to an onboarding message.

- `_ownerPhoneDigits_()` → `SHEET_OWNER_PHONE` Script Property, else the hardcoded
  `OWNER_PHONE = '972547760643'`. **Never empty** (an empty owner phone was the
  original leak — it made every sender look like the owner).
- `_isOwnerPhone_(fromPhone)` → strict digit match. Empty/unknown ⇒ `false`.
- `_resolveTenant_(fromPhone)` → owner ⇒ legacy path; linked tenant ⇒ bridge;
  unknown ⇒ onboarding (no write). KV lookup failure **fails safe** (onboarding,
  not owner).
- `_assertOwnerLegacyWrite_(fromPhone, ctx)` → defense‑in‑depth guard placed
  before legacy `SHEET_ID` writes; a real non‑owner sender is **blocked + the
  owner is alerted**. (A null sender = trusted internal/cron context.)

Every inbound surface is gated:
- **Text & voice** → `processExpense` (non‑owner abort guard at the top of the
  legacy section; voice note‑tail owner‑gated).
- **Interactive button/list picks** → `handleInteractiveReply_` routes non‑owners
  to the bridge.
- **Receipt photos** → `_handleReceiptImage_` routes non‑owners to the bridge.
- **Owner‑only command routers** (subscription, budget, learning, category
  correction, `handleBotCommand_`/`BOT_COMMANDS.gs`, `SRC_ROUTER_handle`) — each
  dispatch in `doPost` requires `_isOwnerPhone_(__from_)`; `handleBotCommand_`
  also self‑guards (fails closed).

## 3. Vercel‑side safeguards

- `/api/sheet/append`: bot‑secret gated; resolves `phone → userRecord`; **hard
  assertion** that the record has `userSub` + `spreadsheetId` and that it matches
  the canonical `sheet:{userSub}` (409 on mismatch). Writes a `write_log:{ts}`
  audit entry (phone/userSub/sheetId, 30‑day TTL).
- `/api/whatsapp/link` confirm: the 6‑digit linking code is **bound to the phone**
  entered at request time, so a leaked code can't link a different phone.
- Identity for read/write endpoints (`summary`, `getExpenses`, `provision`,
  billing, referral) is derived from a **verified token**, not from request body
  params — no cross‑tenant IDOR found.
- Crons: recurring/reminders iterate **per‑tenant** and write to each tenant's own
  sheet/phone, gated by a separate `KESEFLE_CRON_SECRET`. The owner‑only digest/
  engagement crons read only `SHEET_ID` and message only owner‑configured phones.

## 4. Audit results (4 independent agents + automated test)

- ✅ **No cross‑tenant write or read leak** remains via any inbound path.
- ✅ **Vercel API**: no IDOR; webhook/bridge strictly phone→own‑record→own‑sheet.
- ✅ **Crons**: correctly per‑tenant; no wrong‑recipient messaging.
- ✅ **Other `.gs` files**: none expose a non‑owner/unauthenticated path to the
  owner's sheet through `doPost`.
- Fixed during the audit: removed an unauthenticated test webhook
  (`crypto-webhook-test.js`); bound the WhatsApp link code to the phone.
- `bot/test_isolation.js` runs the real functions through owner + 2 test phones
  (incl. the property‑unset condition) — **18/18 checks pass**, with static
  assertions locking every owner‑gate against regression.

## 5. Known / accepted

- Server‑side error logs in `webhook.js`/`provision.js` include `userSub`/
  `spreadsheetId` for debugging blocked writes — server logs only, not exposed to
  clients. Acceptable.
- `ExpenseBot_FIXED.gs` is the build *source* (has its own `doPost`); it must
  **not** be pasted into the Apps Script project alongside `DEPLOY.gs`. See
  `DEPLOYMENT_CHECKLIST.md` §1.
- Duplicate `_SRC_classify_v2_` exists in two optional keyword files
  (`KESEFLE_ALL_PATCHES.gs`, `KESEFLE_KEYWORDS_v2.gs`) — load‑order dependent but
  pure‑compute (no security impact). Paste at most one of them.

## 6. Reporting

Found a security issue? Email **info@kesefle.com**. Do not open a public issue
for anything that could expose user data.
