# Data Classification & Retention — Kesefle

**Owner:** Security & Data
**Last updated:** 2026-05-16
**Applies to:** every byte of user-derived data the Kesefle backend handles.

This document is the authoritative map between (a) every piece of data the system touches and (b) how it must be stored, transmitted, retained, and accessed. Engineering changes that move data across classes (e.g. starting to log a previously-untouched field) MUST update this file in the same PR.

## Classification scheme

| Class | One-liner | Examples here |
|---|---|---|
| **PUBLIC** | Could be put on a billboard without harm. | Marketing copy, plan names, public app version. |
| **INTERNAL** | Operational; non-personal but non-public. | Build SHA, region, anon counters, sheet template ID. |
| **CONFIDENTIAL** | Personal data — limited harm if leaked but still PII under Israeli Amendment 13 + GDPR. | Email, name, phone number (hashed in logs), sheet ID. |
| **RESTRICTED** | Compromise enables impersonation, financial loss, or regulatory breach. | OAuth refresh tokens, Stripe customer IDs in combo with email, Meta access tokens, the app encryption key itself. |

**Rule of thumb:** if leaking a single record could cause a single user real harm, it's at least CONFIDENTIAL. If leaking it could let an attacker act AS that user, it's RESTRICTED.

## Israeli Privacy Law (Amendment 13) — minimum retention obligations

The 2024 amendment requires:
- A documented retention period per data category (this doc).
- Self-serve deletion (existing: `/api/account/delete`).
- An audit log of every privileged action against personal data, kept ≥ 24 months (we use 730 days).
- "Reasonable security measures" proportional to sensitivity (encryption at rest for RESTRICTED is required by precedent).

## Data inventory

### Identity & authentication

| Field | Class | Storage | Encrypted at rest | TLS in transit | Retention | Access control |
|---|---|---|---|---|---|---|
| `user.sub` (Google/Apple/Facebook subject) | CONFIDENTIAL | Vercel KV (`user:<sub>`) | No (it's the key) — but hashed in audit logs and request logs | Yes | Active life + 90 d after account deletion (then key purged) | Server-only token; never returned to other users; included in user's own JWT only |
| `user.email` | CONFIDENTIAL | Vercel KV (in user record) | No — needed for billing match | Yes | Same as `sub` | Server-only on read; returned to the owning user's own session |
| `user.name`, `user.picture` | CONFIDENTIAL | Vercel KV | No | Yes | Until deletion | As above |
| `user.phoneE164` | CONFIDENTIAL | Vercel KV (`user:<sub>` + `phone:<E.164>` pointer) | No — pointer key needs to be lookup-able | Yes | Until deletion or opt-out + 730 d | Server-only; phone→sub pointer is server-only |
| `user.locale` | INTERNAL | Vercel KV | No | Yes | Until deletion | Same |
| `user.firstSeen`, `user.lastSeen`, `user.connectedAt` | INTERNAL | Vercel KV | No | Yes | Until deletion | Owner only |

### OAuth tokens

| Field | Class | Storage | Encrypted at rest | TLS in transit | Retention | Access control |
|---|---|---|---|---|---|---|
| `user.refreshToken` (Google) | **RESTRICTED** | Vercel KV (AES-256-GCM envelope via `lib/crypto.js` `KESEFLE_DB_KEY`, purpose `oauth.refresh`) | **Yes** | Yes | Deleted on `/api/account/delete`; revoked at Google on the same call | **Server only.** Never logged. Never returned to browser. Used only by: webhook write, summary read, account delete |
| `user.accessToken` (Google, short-lived) | **RESTRICTED** | Vercel KV (AES-256-GCM envelope, purpose `oauth.access`) — only when cached | **Yes** | Yes | ≤ 1 h (cached until exchange; refreshed on 401) | Server only |
| Google ID token | RESTRICTED while in flight | Memory only (verified, then discarded). Identity payload extracted into `sub`/`email`. | n/a | Yes | Transient — not stored | Server only |
| Apple identity token | RESTRICTED while in flight | Memory only | n/a | Yes | Transient | Server only |
| Facebook access token | RESTRICTED while in flight | Memory only (debugged via `debug_token`, then discarded) | n/a | Yes | Transient | Server only |
| `KESEFLE_DB_KEY` / `KESEFLE_APP_KEY` | **RESTRICTED** | Vercel env (encrypted at Vercel platform level) + 1Password vault | Vercel-managed | n/a | Annual rotation; `_PREV` retained for ≤ 7 d during rolling rotation | Server runtime only; never read by browser code; never logged |

### Spreadsheet pointer

| Field | Class | Storage | Encrypted at rest | TLS in transit | Retention | Access control |
|---|---|---|---|---|---|---|
| `user.spreadsheetId` | CONFIDENTIAL | Vercel KV (`user:<sub>` + `sheet:<sub>`) | No — the user already sees this in their own Drive URL; encrypting adds no real protection | Yes | Until deletion | Returned to the owning user's session; never returned to other users |
| `user.spreadsheetUrl` | CONFIDENTIAL | Same | No | Yes | Same | Same |

### Transactions (the user's expenses)

| Field | Class | Storage | Encrypted at rest | TLS in transit | Retention | Access control |
|---|---|---|---|---|---|---|
| Inbound WhatsApp `message.text` (raw) | CONFIDENTIAL | **NOT stored** in KV/DB. Transient — written into the user's own Google Sheet, never logged. | n/a in our stores | Yes (Meta→us, us→Sheets API) | Transient on our side; lives in user's own Drive thereafter | Server processes once; the user controls the sheet thereafter |
| `transaction.amount`, `category`, `subcategory`, `merchant`, `description` | CONFIDENTIAL | User's own Google Sheet (their Drive) | At rest by Google Drive (per their policy) — not by us | Yes | User-controlled (they can delete the sheet anytime) | Sheet owner (user) + service-account write via user's refresh token |
| `transaction.whatsapp_msg_id` | INTERNAL | Sheet column I — also `seen:wa:<msg_id>` in KV for dedup (24 h TTL) | No | Yes | 24 h in KV; lifetime of row in user sheet | Server-only in KV; user-owned in sheet |
| `last_inbound:<phone>` | INTERNAL | Vercel KV | No | Yes | 25 h TTL (compliance: WhatsApp 24h messaging window) | **Server only.** Never returned to browser. |
| `optout:<phone>` | INTERNAL | Vercel KV | No | Yes | 730 d (Israeli Communications Law direct-marketing audit) | Server only |

### Billing

| Field | Class | Storage | Encrypted at rest | TLS in transit | Retention | Access control |
|---|---|---|---|---|---|---|
| `user.stripeCustomerId` | CONFIDENTIAL (with email = PII) | Vercel KV (in user record) | No — Stripe-side ID, needed for customer reuse | Yes | Until deletion | Server-only writes; not returned to other users |
| `user.stripeSubscriptionId`, `user.subscriptionStatus`, `user.currentPeriodEnd` | CONFIDENTIAL | Vercel KV | No | Yes | Same | Returned to owning user only |
| `user.plan` | INTERNAL | Vercel KV | No | Yes | Same | Returned to owning user only |
| Card number / CVV / billing address | **NEVER touched** | n/a — Stripe-hosted Checkout only; never enters our backend | n/a | n/a | n/a | n/a |
| `stripe_event:<id>` (idempotency marker) | INTERNAL | Vercel KV | No | Yes | 30 d | Server only |

### Audit & operational logs

| Field | Class | Storage | Encrypted at rest | TLS in transit | Retention | Access control |
|---|---|---|---|---|---|---|
| `audit:<action>:<ts>:<sub8>` entries | CONFIDENTIAL (contain `subHash`, IP) | Vercel KV | No (entries already mask secrets via `maskFields`) | Yes | 730 d (Israeli Amendment 13 minimum) | Server only; restricted-tier admin endpoint required to read |
| Vercel function logs (stdout) | CONFIDENTIAL | Vercel platform | Vercel-managed | Yes | Vercel default retention (30 d on Hobby, 90 d on Pro) | Vercel team members; production should ship to Sentry/Datadog with redaction proven via `lib/log.js` |
| `req.ip` (in audit entries) | CONFIDENTIAL | Vercel KV | No | Yes | 730 d in audit; ephemeral in app logs | Server only |
| `req.headers.user-agent` | INTERNAL | Same | No | Yes | Same | Same |

### Rate-limit & dedup state

| Field | Class | Storage | Encrypted at rest | TLS in transit | Retention | Access control |
|---|---|---|---|---|---|---|
| `rl:wl:ip:<ip>` counters | INTERNAL | Vercel KV | No | Yes | TTL = window (1 h for waitlist) | Server only |
| `seen:wa:<msg_id>` | INTERNAL | Vercel KV | No | Yes | 24 h TTL | Server only |
| `stripe_event:<id>` | INTERNAL | Vercel KV | No | Yes | 30 d | Server only |

### Waitlist (pre-launch)

| Field | Class | Storage | Encrypted at rest | TLS in transit | Retention | Access control |
|---|---|---|---|---|---|---|
| `wait:<ts>:<rand>` (email + ts + UA + IP) | CONFIDENTIAL | Vercel KV | No | Yes | Until launch + 90 d after conversion (or 730 d unconverted then purge) | Server-only; one-way export to ConvertKit/Buttondown on launch |

## Field-level access matrix (who can read/write what)

The columns describe code paths that can legitimately touch the field. Anything not in this matrix MUST be blocked.

| Field | Read: browser (own session) | Read: server (webhook) | Read: server (summary) | Read: server (account.delete) | Write: browser | Write: server (auth callback) | Write: server (webhook) | Write: server (billing webhook) |
|---|---|---|---|---|---|---|---|---|
| `user.sub` | yes (their own, via JWT `sub`) | yes (resolved via `phone:`) | yes (X-User-Sub) | yes | no | yes | no | no |
| `user.email` | yes (their own) | no (not needed) | no | yes | no | yes | no | no |
| `user.name`, `user.picture` | yes (their own) | no | no | yes | no | yes | no | no |
| `user.phoneE164` | yes (their own) | yes (the inverse lookup) | no | yes | yes (account flow only) | no | no | no |
| `user.spreadsheetId` | **yes (their own)** | yes | yes | yes | no | no (created by `/api/sheet/provision`) | no | no |
| `user.refreshToken` | **NO. Never.** | yes (decrypted via `secure-kv.getUser`) | yes | yes (to revoke) | no | yes (encrypted by `secure-kv.saveUser`) | no | no |
| `user.accessToken` (cached) | no | yes | yes | no | no | yes | no | no |
| `user.plan`, `subscriptionStatus`, `currentPeriodEnd` | yes (their own) | no | no | no | no | no | no | yes |
| `user.stripeCustomerId` | no (not needed) | no | no | no | no | no | no | yes |
| `last_inbound:<phone>` | **NO. Never.** | yes (write only) | no | no | no | no | yes | no |
| `optout:<phone>` | no | yes | no | no | no | no | yes | no |
| Audit log entries | no (admin-only future endpoint) | no | no | yes (writes own delete entry) | no | yes | yes | yes |

## Encryption-at-rest specifics

We layer two keys to give us per-purpose blast radius:

- `KESEFLE_APP_KEY` — short-lived data: cookies, signed URLs, in-flight CSRF tokens. Compromise of this key would allow forging sessions but NOT decrypting refresh tokens.
- `KESEFLE_DB_KEY` — long-lived OAuth refresh tokens (and access tokens during cache). Compromise of this key alone (without KV access) yields nothing; combined with a KV dump, an attacker recovers user refresh tokens. **This is why these keys live in Vercel env, not in KV, and have an annual rotation calendar.**

Envelopes include a 1-byte `keyId`, so `lib/crypto.js` can decrypt both `_CURRENT` and `_PREV` keys during a rolling rotation (≤ 7-day window).

Refresh tokens are also bound to an AAD of `kfl:v1:oauth.refresh` so a stolen access-token envelope cannot be replayed as a refresh-token envelope.

## Deletion semantics

When a user invokes `/api/account/delete`:

1. **Google OAuth grant revoked** at `oauth2.googleapis.com/revoke` (kills access tokens immediately, refresh token universe-wide).
2. **KV keys deleted**: `user:<sub>`, `sheet:<sub>`, `phone:<E.164>` (if present).
3. **Audit entry written** to `audit:account_deleted:...` with TTL 730 d — required for Amendment 13 compliance to prove the deletion happened.
4. **NOT deleted (intentional):**
   - The user's Google Sheet — it's in their Drive, under their control. Stated explicitly in the response.
   - `optout:<phone>` — kept so a re-onboard requires explicit START.
   - Vercel function logs — they roll off on Vercel's schedule; we cannot delete on demand. Logs use `lib/log.js` redaction so the `sub` was never written in clear in the first place.
5. **Transactions table (future Postgres):** cascade `delete on users id` removes per-row data; audit log retains `subHash` only.

## Change-control checklist

When adding a new field to a user record, KV bucket, or log line:

- [ ] Classify it in this document (PUBLIC/INTERNAL/CONFIDENTIAL/RESTRICTED).
- [ ] If CONFIDENTIAL or RESTRICTED → add it to `USER_FIELD_SCHEMA` in `lib/secure-kv.js` with the right `encrypt` flag.
- [ ] If RESTRICTED → confirm it's encrypted with `KESEFLE_DB_KEY` and given a unique `purpose` AAD.
- [ ] Add a row to the access matrix.
- [ ] Update retention period.
- [ ] Confirm `lib/log.js` redaction patterns will catch its name; add a new regex if not.
- [ ] Trace where it appears in `data-flow-audit.md` and verify no logging leak.
