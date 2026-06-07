---
name: kesefle-twilio-sandbox-setup
description: Steven-facing numbered steps to wire the Twilio WhatsApp sandbox as a second, test-only provider for Kesefle (join code, webhook URL, Script Properties WHATSAPP_PROVIDER + TWILIO_*) without touching the live Meta number.
---

# Wire the Twilio WhatsApp sandbox (test path)

The live bot runs on the Meta Cloud API direct, on Steven's real number `972547760643`. Twilio's sandbox is a SEPARATE shared test number you join with a code - use it to test new flows without risking the production line. This is additive: the Meta path keeps working untouched. Prereq: the bot must already understand non-Meta payloads (`_doPostRouter_` + a Twilio branch - see `kesefle-provider-webhook-sim`). If that branch is not merged yet, STOP and ship it first; otherwise the sandbox webhook will hit `doPost` and parse nothing.

These are click-by-click steps to give Steven. Do not skip the "do not echo the secret" rule.

## When to use
- You want to test a new bot flow end-to-end over real WhatsApp without risking the production number `972547760643`.
- A customer is on Twilio (not Meta) and you need a like-for-like environment to reproduce their issue.
- You are validating the `_doPostRouter_` Twilio branch (see `kesefle-provider-webhook-sim`) against a live provider after the offline harness passes.

## Steps
1. In the Twilio Console, open Messaging -> Try it out -> Send a WhatsApp message. Note the sandbox number (e.g. `+1 415 523 8886`) and the join phrase like `join <two-words>`.
2. From the phone you will test with, send that exact join phrase (for example `join blue-koala`) to the sandbox number on WhatsApp. Wait for the "you are connected" reply.
3. Find your Kesefle webhook URL: it is `https://kesefle.com/api/whatsapp/webhook` (the Vercel ingress at `api/whatsapp/webhook.js`). Confirm it is live: it answers Meta's GET handshake, and you will add a Twilio branch to its POST handler.
4. Back in the Twilio sandbox settings, set "When a message comes in" to that webhook URL, method POST. Twilio posts `application/x-www-form-urlencoded` with `From`, `Body`, `MessageSid` - your `_doPostRouter_` Twilio branch must read those.
5. Add the provider switch as Apps Script Script Properties (Apps Script editor -> Project Settings -> Script Properties), the SAME place `META_APP_SECRET` / `WHATSAPP_BUSINESS_ACCOUNT_ID` already live (read by `_verifyMetaWebhook_` in `bot/ExpenseBot_FIXED.gs` ~line 914):
   - `WHATSAPP_PROVIDER` = `twilio` (set to `meta` to flip back to production)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (= `whatsapp:+14155238886`)
   Paste the values directly into the editor field; never paste a secret into chat, a commit, a log, or a Bash echo.
6. If the Vercel ingress (`api/whatsapp/webhook.js`) is the one that must call Twilio's API to reply, add the same `TWILIO_*` as Vercel Environment Variables in the Vercel dashboard (Settings -> Environment Variables), not in any committed file. `.env.example` documents Vercel keys by NAME only.
7. The sandbox test phone is a NON-owner number, so the bot routes it through the tenant path (`_isOwnerPhone_` ~line 6793 returns false) and writes to that test user's own sheet via the Vercel bridge - it never touches the owner master sheet. Make sure that test number is linked to a throwaway test account first, or it gets the onboarding reply.
8. Send `50 קפה` from the joined phone. Expect the normal Hebrew confirmation reply. If nothing comes back, read the cause in Verification.

## Verification
- Twilio Console -> Monitor -> Logs -> Messaging shows your inbound `50 קפה` and the bot's outbound reply with status `delivered`.
- `mcp__8ba1f04e-...__get_runtime_logs` (or `vercel logs`) on `api/whatsapp/webhook.js` shows the POST arriving with a Twilio body and a 200 response.
- Offline proof the parse is right regardless of provider: `node bot/test_provider_webhook.js` is green and `node bot/bot-replay.js --json "50 קפה"` predicts the expected category - run before asking Steven to test live.
- Flip `WHATSAPP_PROVIDER` back to `meta`; send a message on the real number; confirm production still replies (the sandbox change touched nothing on the Meta side).
- If you want the sandbox to fail closed on a bad signature, set `STRICT_WEBHOOK_VERIFY` = `1` and confirm a forged POST is rejected (logged reason), matching the Meta path's `_verifyMetaWebhook_` behavior.

## Common pitfalls
- The sandbox join expires after ~72h of inactivity; if replies stop, re-send the `join <code>` phrase before assuming the webhook broke.
- Twilio posts form-encoded, not JSON - a Meta-only `JSON.parse(e.postData.contents)` path sees an empty message and silently drops it (Apps Script puts form fields in `e.parameter`).
- Pointing the LIVE Meta webhook at Twilio, or setting `WHATSAPP_PROVIDER=twilio` in production, hijacks the real number `972547760643`. Keep Twilio test-only; never repoint Meta.
- Changing Script Properties does NOT redeploy the bot. If you also edited `bot/ExpenseBot_FIXED.gs`, reassemble and re-paste `bot/ExpenseBot_DEPLOY.gs` (see `bot-deploy-paste`) - properties alone won't ship code.
- Echoing `TWILIO_AUTH_TOKEN` into a terminal or commit. Treat it like a password: editor/dashboard field only, value never leaves the box.
- Confusing the kill switch with the provider switch. To halt ALL writes in an incident, flip `KFL_DISABLE_BOT_WRITES` (see `bot-kill-switch`); `WHATSAPP_PROVIDER` only changes which ingress is parsed.
- Sending a sandbox test from Steven's own owner number `972547760643` - it would route as the owner and write to the master sheet. Always test from a separate, non-owner phone.
