# Privacy & Data Practices — Summary for Google Reviewers

If Google's verification team asks about data practices, paste this.

## What data we collect

1. **Google account identifier** (`sub`) — anonymous string from Google
2. **Email address** — from OAuth profile, for support and identification
3. **Name + profile picture URL** — for UI display only
4. **WhatsApp phone number (E.164)** — entered by the user at signup, used to route incoming bot messages
5. **Refresh token** — encrypted at rest (AES-256), used to write to the user's Sheet
6. **Sheet ID** — the ID of the Sheet we created in the user's Drive
7. **WhatsApp message content** — only messages sent TO the Kesefle bot number; we don't see any other WhatsApp conversation

## What we DON'T collect

- Bank account numbers, credit cards, financial credentials of any kind
- Other Drive files (we use `drive.file` scope which limits access to files we created)
- Other Gmail / Calendar / Contacts / YouTube data
- The user's other WhatsApp conversations
- Location data
- Device IDs or fingerprinting data
- Browsing history

## Where data is stored

| Data | Location | Encryption |
|---|---|---|
| Sheet contents (transactions) | User's own Google Drive | At rest by Google |
| User profile (sub, email, sheetId) | Vercel KV (Upstash Redis) | At rest by Upstash (AES-256) |
| Refresh token | Vercel KV | Application-level AES-256 (key in env var) |
| WhatsApp message routing | Meta WhatsApp Cloud API | At rest by Meta |

We do NOT use:
- AWS, GCP, Azure
- Third-party analytics (no Google Analytics, no Mixpanel, no Amplitude)
- Third-party advertising
- Third-party CRM (no Hubspot, Salesforce, etc.)

## Data flow diagram

```
User                Kesefle Frontend          Kesefle Backend           Google
  │                       │                          │                     │
  │  click "Sign in"     ───────────────────────────►│  OAuth /v2/auth     │
  │                       │                          │ ◄───────────────────│
  │  consent dialog       │                          │                     │
  │  click "Allow"        │                          │                     │
  │                       │  code, state             │                     │
  │ ◄──────────────────── │                          │                     │
  │  POST /api/auth/      │                          │                     │
  │  google-exchange      │                          │                     │
  │ ────────────────────► │ ───────────────────────► │  exchange code for  │
  │                       │                          │  refresh_token      │
  │                       │                          │ ◄───────────────────│
  │                       │                          │  encrypt + store    │
  │                       │                          │  refresh_token in   │
  │                       │                          │  Vercel KV          │
  │                       │                          │                     │
  │  click "Create sheet" │                          │                     │
  │ ────────────────────► │ ───────────────────────► │  files.copy(...)    │
  │                       │                          │ ◄────────────── new │
  │                       │                          │  Sheet ID           │
  │                       │                          │  save in KV         │
  │                       │                          │                     │
  │  WhatsApp message     │                          │                     │
  │ ────► Meta ─► our webhook ─► look up user ─► values.append on user's  │
  │                       │                          │  Sheet              │
```

## How users delete their data

1. **Self-service:** revoke OAuth grant at https://myaccount.google.com/permissions
   - This invalidates our refresh token immediately
   - The user's Sheet remains in their Drive (theirs to delete or keep)
2. **Self-service:** delete the Sheet from their own Drive
3. **Email us at srcslcollection@gmail.com** — within 7 days we delete:
   - Their Vercel KV record (instant)
   - All logs that contain their identifier (within 30 days due to log retention)
   - Their phone → user mapping

## Compliance

- **GDPR**: data minimization (we collect only what's needed), right to delete (above), right to portability (the user's data IS in their own Sheet — already portable)
- **Israeli Privacy Protection Law (תשמ"א-1981)**: registered with Israeli Privacy Authority [TBD], data not transferred out of Israel (Vercel EU region, Google EU + IL)
- **CCPA**: not applicable (we don't sell data, we don't have US-resident-specific opt-out)

## Audit trail

We log to Vercel for 30 days:
- API call to `/api/sheet/provision` (timestamp, userSub hash, success/error)
- WhatsApp message processed (timestamp, phone hash, character count of message, success/error)
- No actual message content is logged

## Security

- **Application secrets** (Meta access token, Anthropic API key, Vercel KV token, AES-256 master key) — stored in Vercel environment variables, never in code, never logged
- **OAuth refresh tokens** — encrypted at rest with AES-256, key derived from `ENCRYPTION_KEY` env var
- **HMAC verification** on Meta webhook calls (prevents spoofed messages)
- **Rate limiting** on `/api/sheet/provision`, `/api/whatsapp/link` (5 req/hour, 10 req/10min)

## Code transparency

The full source code is at https://github.com/stevenrancohen/kesefle. Reviewers can audit:
- `/api/sheet/provision.js` — the Drive copy logic (proves we only copy template)
- `/api/whatsapp/webhook.js` — message processing (proves we only handle our messages)
- `/lib/crypto.js` — encryption implementation
