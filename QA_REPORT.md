# QA + Security Audit Report
**Date**: 2026-05-17 ~17:00 IST
**Audited by**: Claude (autonomous run)

## ✅ Security: PASS

### Auth enforcement (tested with curl)
| Endpoint | Without auth | Result |
|---|---|---|
| `GET /api/admin?action=metrics` | Expected 401 | ✅ 401 `missing_auth` |
| `POST /api/account?action=info` | Expected 401 | ✅ 401 `missing_auth` |
| `GET /api/referral?action=my-code` | Expected 401 | ✅ 401 `missing_auth` |
| `POST /api/sheet/provision` (no token) | Expected 400 | ✅ 400 `missing accessToken` |
| `POST /api/sheet/provision` (fake token) | Expected 401 | ✅ 401 `invalid_access_token` |
| `POST /api/auth/google` (no credential) | Expected 400 | ✅ 400 `missing credential` |
| `POST /api/events` (no email) | Expected 400 | ✅ 400 `invalid_email` |

### Code scan
- ❌ No hardcoded secrets in `api/` or `bot/` (all use `process.env` / Script Properties)
- ❌ No SQL/script injection via URL params (server only logs request ID)
- ❌ No leaked tokens (`sk_live`, `sk_test`, `whsec_`, `AKIA`, etc.)
- ✅ Webhook signature verification: `verifyMetaSignature()` + `verifyStripeSignature()` both implemented with proper HMAC + 5min tolerance
- ✅ Admin protected by `requireAdmin()` (checks email in `ADMIN_EMAILS` env var)
- ✅ Sheet provision verifies access token server-side via Google `tokeninfo` (C4 security fix)
- ✅ All `innerHTML` usage in `help.html` and `status.html` uses `escapeHtml()` for user input

## 🚨 Issues Found

### 🔴 1. Drive copy may still fail (NOT just env var missing)
**Health endpoint says**: `template_sheet_id: true` — so `KESEFLE_TEMPLATE_SHEET_ID` IS already set in Vercel.

But user reported "drive copy failed". Reason is likely:
- The template Sheet is the OLD personal one (with personal data, possibly not properly shared)
- OR the template is shared as "Anyone with link" but the user's `drive.file` OAuth scope is restrictive

**Action**: Upload the new clean template (`מאזן - תבנית נקייה.xlsx`) to Drive, share it correctly, and update the env var.

### 🟠 2. Missing Meta/Stripe env vars (Vercel)
Health endpoint reports:
- `meta_verify_token: false`
- `meta_app_secret: false`
- `meta_phone_number_id: false`
- `meta_access_token: false`
- `stripe_secret_key: false`
- `stripe_webhook_secret: false`

The bot currently writes via the Apps Script webhook (which is fine for beta). But the Vercel `/api/whatsapp/webhook` won't function until Meta vars are set.
Stripe vars only needed when activating paid plans.

### 🟠 3. Region still `iad1`, not `fra1`
Health says `region: iad1`. For Israeli users, switching to `fra1` (Frankfurt) cuts latency ~4x.
Note: `reqId` prefix says `fra1::` — that's the edge router, not the function region.

### 🟡 4. Health endpoint unrate-limited
5 rapid requests all returned 200. Not critical (no secrets exposed) but could be used for DoS attempts. Low priority.

### 🟡 5. `200+ keywords` claim in FAQ might be inflated
`index.html:772` says "עוקב אחרי 200+ מילים". Verify against actual `CATEGORY_MAP` in bot — currently ~80-100 keywords. Either reduce the claim to "100+" or expand the map.

## ✅ Front-end QA (live site)

Tested at `https://kesefle.vercel.app/` after clearing SW + cache:

| Check | Result |
|---|---|
| Page loads cleanly | ✅ HTTP 200, title set |
| H1 has authentic copy | ✅ "רישום הוצאות לא צריך אפליקציה" |
| Dark mode forced | ✅ `<html class="dark">` at parse time |
| 6 OAuth buttons present (3 hero + 3 signup) | ✅ |
| 8 signup CTAs throughout page | ✅ |
| 1 demo modal trigger | ✅ |
| 0 broken images | ✅ |
| 0 fake numbers in DOM | ✅ (no 479,000 / no 368 / no "73 מקום") |
| Aurora gradient + tilt-3D + shimmer animations | ✅ visible |

## 📋 Recommended Order (post-launch fixes)

1. **Highest impact**: Re-upload the clean template + update `KESEFLE_TEMPLATE_SHEET_ID` → fixes onboarding for ALL new users
2. **High**: Set `WHATSAPP_TOKEN` in Apps Script Properties → enables bot ✅ confirmation
3. **Medium**: Verify the 100+ keyword claim is accurate
4. **Low**: Region change to `fra1` (latency optimization)
5. **Low**: Add rate limiting to `/api/health`
