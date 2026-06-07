---
name: kesefle-provider-webhook-sim
description: Simulate Twilio / 360dialog / Meta inbound WhatsApp webhook payloads through the bot's doPost normalizer (_doPostRouter_) to prove provider-agnostic parsing, with zero live messages and zero sheet writes.
---

# Simulate a provider webhook payload

The live bot (`bot/ExpenseBot_FIXED.gs`, `doPost(e)` at ~line 1851) only understands the Meta Cloud API envelope today: it digs `entry[0].changes[0].value.messages[0]` straight out of `JSON.parse(e.postData.contents)` and captures the reply-from id into `_ACTIVE_PHONE_NUMBER_ID_`. To add Twilio or 360dialog you must FIRST factor that unwrap into a pure normalizer, `_doPostRouter_(parsed, headers)`, that returns one shape `{ provider, from, text, interactive, msgId, phoneNumberId }` for every provider. This skill drives that normalizer with synthetic payloads offline so you never send a real WhatsApp message to verify parsing.

## When to use
- You are adding Twilio or 360dialog as an alternative WhatsApp ingress and need to prove the bot parses all three envelopes into one shape before any live test.
- A user on a non-Meta provider reports "the bot got my message but did nothing" - replay their envelope shape offline to see what `_doPostRouter_` extracted.
- Before merging any change to the inbound unwrap in `doPost`, to confirm the Meta path is byte-for-byte unchanged (regression guard).

## Inputs
- The raw provider payload shape (object literal), per provider. Use synthetic test digits, never a real sender number.
- The expected normalized result `{ from, text }` (and `interactive.id` if the message is a button/list reply).

## Steps
1. Confirm the seam exists. `grep -n "_doPostRouter_\|entry\[0\].changes" bot/ExpenseBot_FIXED.gs`. If the unwrap is still inline in `doPost`, extract it to `function _doPostRouter_(parsed, headers)` (Meta branch = current logic verbatim) and have `doPost` call it - do NOT change behavior in the same change you add a provider.
2. Read the shape `doPost` consumes downstream (`__from_`, `__text_`, `__interactive_`, `__msgId_`, `_ACTIVE_PHONE_NUMBER_ID_`) so the normalizer's output keys match 1:1.
3. Write a read-only harness `bot/test_provider_webhook.js` using the SAME balanced-brace `extractFn` pattern as `bot/test_isolation.js` / `bot/bot-replay.js` to load REAL `_doPostRouter_` into a `vm` sandbox (stub `SpreadsheetApp.openById` to throw `NEVER CALL LIVE`, `PropertiesService`, `Logger`, `Utilities`).
4. Build three fixtures for the same logical message `50 קפה` from a non-owner test number:
   - Meta: `{ entry:[{ changes:[{ value:{ metadata:{ phone_number_id:'123' }, messages:[{ from:'972500000001', id:'wamid.X', text:{ body:'50 קפה' } }] } }] }] }`
   - Twilio form-encoded: `{ From:'whatsapp:+972500000001', Body:'50 קפה', MessageSid:'SMxxxx', To:'whatsapp:+14155238886' }`
   - 360dialog: `{ messages:[{ from:'972500000001', id:'ABGG', text:{ body:'50 קפה' } }], contacts:[...] }`
5. Assert each `_doPostRouter_(fixture)` returns the identical `{ from:'972500000001', text:'50 קפה' }`. The bot canonicalizes the sender to bare digits with `String(__from_).replace(/[^0-9]/g, '')` (`doPost` ~line 2028), so the normalizer must strip Twilio's `whatsapp:+` and the leading `+` itself; downstream routing keys off those digits via `_kvLookupPhone_` (~line 6831) and `_isOwnerPhone_` (~line 6793).
6. Add an interactive (button/list-reply) fixture per provider too - `doPost` reads `__msg_.interactive`. Twilio carries quick-reply payloads in `ButtonText` / `ButtonPayload`, not Meta's `interactive.list_reply.id`; assert the normalizer maps both onto the same `{ interactive: { id } }` shape or category-picker replies silently break.
7. Replay the normalized text through the real classifier: `node bot/bot-replay.js --json "50 קפה"` and confirm the predicted tab/category is unchanged regardless of source provider.
8. Add a tampered-signature fixture: feed a Meta payload whose body was mutated and assert `_verifyMetaWebhook_` (~line 914) returns `{ valid:false }` when `STRICT_WEBHOOK_VERIFY='1'` - so the sim also guards the security gate, not just the happy path.
9. Register the suite in the gauntlet: add `'bot/test_provider_webhook.js'` to the unit-suite loop in `tests/full_qa.js` (~line 49). For messages that carry merchant keywords, pull realistic Hebrew examples straight from the inline `CATEGORY_MAP` in `bot/ExpenseBot_FIXED.gs` (there is no separate keyword-pack file).

## Verification
- `node bot/test_provider_webhook.js` prints all PASS and exits 0.
- `node tests/full_qa.js` group "Unit suites (isolation + parser)" shows `bot/test_provider_webhook.js passed` (it reads `bot/ExpenseBot_DEPLOY.gs`, so reassemble DEPLOY first - see `bot-deploy-paste`).
- `node bot/bot-replay.js --json "50 קפה"` yields the same `predicted_target` you asserted in the harness - proof the message body survives normalization intact.
- The tampered-signature fixture proves the gate still fails closed: `_verifyMetaWebhook_` returns `valid:false` on a mutated body under `STRICT_WEBHOOK_VERIFY='1'`.

## Common pitfalls
- Treating `_doPostRouter_` as already present - it is NOT; the unwrap is inline in `doPost`. Extract it as a pure function first, behavior-preserving, before adding any non-Meta branch.
- Forgetting Twilio sends `application/x-www-form-urlencoded`, not JSON. Apps Script surfaces that in `e.parameter`, not `e.postData.contents` - your Meta `JSON.parse` path will silently miss it.
- Leaving `whatsapp:+` / `+` on the Twilio `From` - routing then can't match the KV `phone:{digits}` key and the message lands as an unknown sender (onboarding reply) instead of the right tenant sheet.
- Bypassing `_verifyMetaWebhook_` (~line 914) in the sim and assuming prod is open - prod still HMAC-checks; each provider needs its own signature verifier (Twilio `X-Twilio-Signature`) before this ever ships live.
- Using a real customer number in a fixture (PII) - use `972500000001`-style test digits, never `972547760643` (owner) and never any live subscriber number.
