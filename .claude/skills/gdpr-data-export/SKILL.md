---
name: gdpr-data-export
description: Handle a user's data export request (GDPR / Israeli privacy law) — collect all KV records + Sheets data attributable to them, package, deliver, log.
---

# GDPR data export

A user asks for "all my data". Privacy law obliges; the export must be complete (all KV records keyed to them + the contents of their Sheets) and delivered through an authenticated channel.

## Steps
1. Authenticate the requester. The request must come from the email on file (or a verified support channel where Steven vouches for identity). Don't trust an unauth'd email asking for someone's data.
2. Resolve identity: `sub` from email → `user:{sub}` record. Get `phone` and `sheet_id` from it.
3. Collect KV: a documented set of keys keyed by `sub` or `phone`. Inventory:
   - `user:{sub}`
   - `phone:{digits}` (matching this user)
   - `sheet:{sub}` (canonical sheet record)
   - `profile:{sub}`, `budgets:{sub}`, `recurring:{sub}`, `learn:{sub}`, `notifications:{sub}` (whatever per-user keys exist; grep `api/` for `:${sub}`)
4. Collect Sheets: export the user's Sheet via Drive API as XLSX (or CSV per tab) using the same refresh token the bot uses.
5. Strip secrets: REDACT the encrypted refresh token, the `bot_secret`, any KV-internal opaque hashes before bundling.
6. Package: a zip with `kv/<key>.json` files + `sheets/<tab>.csv` files + a top-level `README.txt` listing what's in there and what's NOT (e.g. server logs not included — retention < 30d).
7. Deliver: signed URL via the auth'd email. Expires in 24h. Log the request to KV `audit:gdpr:{sub}:{ts}` with `{ kind: 'export', actor: requesterEmail, ts }`.

## Verification
- The zip opens and contains the user's actual data.
- `grep -i "refresh_token\|bot_secret" -r /path/to/extracted/zip` → empty.
- Audit log entry exists.
- Delivery channel was authenticated.

## Common pitfalls
- Including the encrypted refresh token "because it's encrypted" → still PII-adjacent; redact.
- Forgetting per-user keys you don't remember exist → grep `${sub}` and `${phone}` in `api/`.
- Sending the zip via unauth'd email → wrong recipient hijack risk.
- No audit log → can't prove the export happened if later disputed.
