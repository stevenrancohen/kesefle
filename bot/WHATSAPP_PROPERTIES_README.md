# Apps Script Properties — WhatsApp send credentials

The bot's `sendWhatsAppReply()` (in `BOT_COMMANDS.gs`) reads three Script Properties.
Without them, sends return `{ ok: false, error: 'missing_wa_credentials' }` and you'll see this in the execution log of `RUN_WEEKLY_DIGEST_NOW`.

## Required properties

Open Apps Script → ⚙ (gear) → Project Settings → Script Properties → Edit:

| Property | Value | Example |
|---|---|---|
| `WA_TOKEN` | Meta Cloud API access token (System User permanent, ideally) | `EAAR...` (long string) |
| `WA_PHONE_ID` | Meta WhatsApp Business Phone Number ID | `123456789012345` (15-digit number) |
| `WA_GRAPH_VERSION` | (optional) Meta Graph API version | `v18.0` (default) |
| `SUBSCRIBERS` | JSON array of recipient phones (international, no `+`) | `["972547760643"]` |

## Where to get the values

### `WA_TOKEN`
1. https://business.facebook.com → Business Settings → System Users
2. Create a new system user named `kesefle-bot` (role: Admin)
3. Click "Generate New Token" → select your WhatsApp Business App → scopes: `whatsapp_business_messaging`, `whatsapp_business_management`
4. Copy the long token (starts with `EAA...`)
5. **Token expires after 60 days for app-level tokens, but permanent for System User tokens** — use System User.

### `WA_PHONE_ID`
1. https://developers.facebook.com → My Apps → your Kesefle app
2. WhatsApp → API Setup
3. Find "From" → next to your test/business number you'll see "Phone number ID" — copy that.
4. It's a 15-digit number, NOT the phone number itself.

### `WA_GRAPH_VERSION`
Default is `v18.0`. Update to latest stable when Meta announces breaking changes (rare). Check https://developers.facebook.com/docs/graph-api/changelog.

## After setting

1. Go back to the Apps Script editor
2. Run `RUN_WEEKLY_DIGEST_NOW`
3. Execution log should now show `{ ok: true, message_id: "wamid....." }` instead of `missing_wa_credentials`
4. Your phone receives the digest via WhatsApp within 15 seconds.

## DO NOT confuse with `WHATSAPP_TOKEN`

You may have an old Script Property called `WHATSAPP_TOKEN` from an earlier iteration. The current code does NOT read it — only `WA_TOKEN`. You can delete `WHATSAPP_TOKEN` to avoid confusion.

## Why it's separate from the Vercel webhook credentials

| Property | Where | Purpose |
|---|---|---|
| `WA_TOKEN` (Apps Script) | Outbound: bot SENDS messages from the spreadsheet's Apps Script side |
| `META_ACCESS_TOKEN` (Vercel env var) | Outbound: web server SENDS messages from `/api/whatsapp/webhook` for confirmations |
| `META_VERIFY_TOKEN` (Vercel env var) | Inbound: lets Meta verify our webhook URL (one-time handshake) |
| `META_APP_SECRET` (Vercel env var) | Inbound: HMAC verification on every incoming message Meta posts to us |

Both `WA_TOKEN` and `META_ACCESS_TOKEN` are the **same** Meta Cloud API access token — but stored in two places because Apps Script and Vercel are separate runtimes.

You can use the same token value in both. Or generate two System Users if you want to revoke them independently.

## Daily / monthly send limits

- New WA Business accounts: 1,000 messages/day to unique customers (auto-scales to 100,000+ with quality maintenance)
- Apps Script: 100 emails/day via MailApp (not relevant for WhatsApp)
- Vercel functions: 100,000 invocations/month on Hobby plan
- Upstash KV: 10,000 commands/day on free tier

For pre-launch usage (under 100 users), all of these are way more than enough.
