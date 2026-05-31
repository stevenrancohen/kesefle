# WhatsApp webhook security audit — 2026-05-31

Scope: `api/whatsapp/webhook.js` (Vercel/Meta entry point) plus the bot's `doPost` in
`bot/ExpenseBot_FIXED.gs` for cross-validation. Audit-only; no source changes.

## Summary

| Control | Status | Notes |
|---|---|---|
| POST signature verification (HMAC-SHA256) | OK | `crypto.timingSafeEqual`, fails closed if `META_APP_SECRET` unset |
| GET verify-token comparison | BUG | Uses `===` (timing leak) AND fails-open if `META_VERIFY_TOKEN` is undefined |
| Replay protection / `wamid` dedup | OK | `seen:wa:{id}` KV key, TTL 24h (covers Meta retry window) |
| Tenant routing (webhook -> sheet) | OK | Webhook resolves phone -> `phone:{n}` KV record directly; no relay short-circuit |
| Bot relay secret usage | N/A | Webhook does NOT proxy to Apps Script bot; the bot has its own independent Meta webhook URL |
| Bot `doPost` HMAC verify | DEGRADED | `_verifyMetaWebhook_` runs but Apps Script does not expose request headers; HMAC is silently skipped unless `STRICT_WEBHOOK_VERIFY=1` (default off) |
| Rate limit (per-IP, pre-HMAC) | OK | `wa_inbound_ip` 120/min/IP via `lib/ratelimit.js` |
| Per-phone rate limit (webhook) | MISSING | Only IP-based at the front door; legitimate Meta edge IPs share traffic for many users |
| Pending-state race (`pending_expense`) | N/A | Webhook does NOT use pending state; appends to the sheet directly via Sheets API `INSERT_ROWS` (auto-incrementing index) |
| Logging PII | OK with caveats | `log.*` redacts `phone/email/usersub/spreadsheet` keys; but two raw `console.error` calls (lines 374, 447) bypass the redactor |
| `setTimeout` 30s in serverless handler | BUG | Lines 278-291 schedule a 30s callback inside the request handler — unsafe on Vercel; the function freezes after response |
| Test coverage for signature | MISSING | `tests/full_qa.js` and all suites contain zero assertions on signature verification, replay dedup, or GET handshake |

Bugs found: **5** (1 critical, 2 high, 2 medium).

## Findings

### F1 [CRITICAL] GET verify endpoint fails open when `META_VERIFY_TOKEN` is unset
`api/whatsapp/webhook.js:92` compares with `token === process.env.META_VERIFY_TOKEN`. If
the env var is unset on a fresh/misconfigured environment, the value is `undefined`. A
GET request that omits `hub.verify_token` will then evaluate `undefined === undefined`
which is `true`, and the endpoint will echo back any `hub.challenge` supplied by the
attacker. Unlike the POST path (which explicitly checks `if (!appSecret) return 503`),
the GET path has no equivalent guard. An attacker who can reach the URL during a window
of misconfiguration could hijack the webhook registration with their own WhatsApp app
and start receiving (and answering) messages addressed to Kesefle's number.

The comparison is also non-constant-time (`===` short-circuits). A patient attacker could
in principle measure response time to recover the verify token byte by byte. Severity is
lower than the fails-open issue but compounds it.

Fix: require `process.env.META_VERIFY_TOKEN` to be set (mirror the POST path's 503
behaviour) AND use `constantTimeEqual` from `lib/crypto.js` (already exported on
line 296). Reject `mode !== 'subscribe'` before the token compare so probers can't
fingerprint the endpoint either.

### F2 [HIGH] Bot `doPost` HMAC is effectively skipped in default config
`bot/ExpenseBot_FIXED.gs:907-996` (`_verifyMetaWebhook_`) attempts HMAC on
`e.headers / e.parameter / e.postData.headers`. Apps Script does NOT surface request
headers on `/macros/s/.../exec` web-app deployments (Google has never shipped that
feature). Code comments acknowledge this. As a result, `sigHeader` is always empty and
the function falls through to the `else` branch (line 972), which logs a warning and
returns `valid: true` UNLESS the Script Property `STRICT_WEBHOOK_VERIFY=1` is set.

The WABA-id fallback check on line 977 only runs when `WHATSAPP_BUSINESS_ACCOUNT_ID` is
also set as a Script Property; otherwise even that secondary check is skipped.

If anyone learns the bot's Apps Script web-app URL (it's a long random `/exec` path, but
not a secret per Google's threat model — it appears in HAR captures, request logs,
and any prior debug share), they can POST arbitrary forged Meta-shaped payloads directly
to the bot, bypassing the Vercel webhook entirely. The bot will write to the owner's
hardcoded SHEET_ID (any sender matched by `_isOwnerPhone_`) or trigger
`_kvLookupPhone_` -> `/api/whatsapp/link?phone=` lookups for any phone the attacker
chooses, and then write to that user's sheet.

This is the single largest residual risk in the bot. Mitigation requires either (a)
setting `STRICT_WEBHOOK_VERIFY=1` and `WHATSAPP_BUSINESS_ACCOUNT_ID` to enforce the WABA
check (lowest cost, no source change), or (b) moving inbound message intake fully to
`api/whatsapp/webhook.js` and having the bot expose ONLY relay endpoints protected by
`KESEFLE_BOT_SECRET`.

### F3 [HIGH] `setTimeout` in serverless request handler is dropped on Vercel
`api/whatsapp/webhook.js:278-291` schedules a 30-second callback inside the request
handler to send a "demo nudge" follow-up to unregistered users. Vercel serverless
functions freeze the event loop the instant `res.end()` is called (and bill until
that point). On hobby/standard tier the callback will never fire; on edge/streaming
deployments behaviour is undefined. The KV `kfl_demo_nudge:{phone}` flag is written
BEFORE the timeout, so the cron-based fallback the comment alludes to will see
`sent: false` and could double-send if it ever runs. Also: an attacker can register
arbitrary phones (including phones they don't own) and burn KV writes via the demo
nudge path because the unregistered-user branch is reached before any rate limit
beyond the per-IP front door.

Fix: delete the inline `setTimeout` block; rely entirely on a cron that reads
`kfl_demo_nudge:*` keys with `sent: false` and `scheduledAt < now`.

### F4 [MEDIUM] Two `console.error` calls bypass the log redactor
Lines 374 and 447 use raw `console.error('access_token_refresh_failed', e.message)` and
`console.error('sheets_append_failed', resp.status, errText.slice(0, 300))`. These do
not go through `lib/log.js` `redact()`. The first is unlikely to leak (just the OAuth
error message) but the second includes up to 300 chars of the Sheets API error body,
which can contain the spreadsheetId and the response body's `range` field (the
quoted Hebrew tab name plus row range). Logged in plaintext to Vercel logs.

A regression test for exactly this class of leak exists at
`tests/test_log_redact_spreadsheet_id.js` — but it can only see calls that go through
`log.error`, not raw `console.error`. Worth grepping for any other raw `console.*` in
the api/ tree.

Fix: replace both with `log.error('wa.sheets_append_failed', { reqId, status, errText: errText.slice(0,200) })` — `errText` will be string-truncated by the redactor's 200-char rule.

### F5 [MEDIUM] No per-phone rate limit at the webhook (only per-IP)
`rateLimit(req, { key: 'wa_inbound_ip', limit: 120, windowSec: 60 })` is keyed on the
caller's IP (line 107). The caller is Meta's edge, which proxies traffic from millions
of WhatsApp users. A single abusive phone can therefore burn through KV reads/writes
(opt-out check, last-inbound stamp, seen-id mark, phone-record lookup, demo-nudge
flag, sheet append) at the per-IP cap of 120/min. Meta's quota for inbound message
delivery is far higher than 120/sec, so even at the IP rate limit a coordinated burst
from one phone can degrade KV.

The bot has a per-phone limit (`_isRateLimited_` at `ExpenseBot_FIXED.gs:1854`,
30 msgs/60s) but the webhook does not. Use `rateLimitId(fromPhone, ...)` from
`lib/ratelimit.js` (already exported, line 73) AFTER signature verification to add
a phone-level bucket of e.g. 30/min before the KV-write-heavy unregistered-user path.

### F6 [LOW] No regression test guards webhook signature verification
`tests/full_qa.js` references `api/whatsapp/link.js` (line 23) but never imports or
exercises `webhook.js`. No suite in `tests/` asserts that:
- POST without `x-hub-signature-256` returns 401
- POST with `META_APP_SECRET` unset returns 503
- POST with a tampered body (signature computed over original bytes but body mutated) is rejected
- GET with mismatched `hub.verify_token` returns 403
- Duplicate `wamid` POST is dropped as `ignored: duplicate`

Add a `tests/test_whatsapp_webhook_signature.js` that loads `webhook.js` and asserts
all five cases against a stubbed req/res. The existing
`tests/test_whatsapp_link_get_ratelimit.js` is a working template for this pattern.

## Recommendations (numbered, safe-to-ship PRs)

1. **PR-WW-1 [critical]** Fix the GET verify handshake: require `META_VERIFY_TOKEN`, use `constantTimeEqual`, reject `mode !== 'subscribe'` first. ~10 LOC change to `webhook.js` only. Includes new test asserting both fails-closed cases.
2. **PR-WW-2 [high]** Set `STRICT_WEBHOOK_VERIFY=1` and `WHATSAPP_BUSINESS_ACCOUNT_ID` as Script Properties on the production Apps Script bot. No source change — pure config flip — but document it in `docs/DEPLOY_BOT_SIMPLE.md` and add a startup check in `_verifyMetaWebhook_` that warns when the WABA id is unset.
3. **PR-WW-3 [high]** Delete the inline `setTimeout` demo-nudge block; rely on a cron under `api/cron/demo-nudge.js` that scans `kfl_demo_nudge:*` keys.
4. **PR-WW-4 [medium]** Replace the two raw `console.error` calls in `webhook.js` (lines 374, 447) with `log.error` and add a grep-based regression test that fails CI if any new `console.*` lands under `api/whatsapp/`.
5. **PR-WW-5 [medium]** Add per-phone rate limit via `rateLimitId(fromPhone, { key: 'wa_inbound_phone', limit: 30, windowSec: 60 })` immediately after signature verification, before any KV write.
6. **PR-WW-6 [low]** Add `tests/test_whatsapp_webhook_signature.js` covering the five cases in F6.

## Files reviewed

- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/api/whatsapp/webhook.js` (482 lines, full read)
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/ExpenseBot_FIXED.gs` (relevant ranges: 907-996 verify, 1726-1925 doPost entry, 5742-5778 tenant resolver)
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/lib/ratelimit.js` (full)
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/lib/log.js` (redactor verified)
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/lib/crypto.js` (`constantTimeEqual` exists, line 296)
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/tests/full_qa.js` and tests/* (zero webhook coverage found)
