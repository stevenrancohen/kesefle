---
name: kesefle-vercel-env-audit
description: Audit that every Vercel env var NAME the Kesefle deploy depends on (KV, bot secret, template sheet, Google OAuth, admin allowlist) is present in Production - checking presence only, never printing any value.
---

# Vercel env-var presence audit

Confirm the Kesefle production deploy has every environment variable it needs, by NAME, without ever reading or printing a value. A missing env var fails silently in serverless (the handler degrades or 500s), so this is a pre-deploy and post-incident check. The source of truth for which names are required is the code itself (`grep process.env`), not memory.

## Steps
1. Build the required-name list from code (do this, don't trust a stale doc):
   `grep -rhoE "process\.env\.[A-Z_0-9]+" lib/ api/ | sed -E 's/.*env\.//' | sort -u`.
2. The deploy-critical names this audit must confirm exist:
   - KV / Upstash: `KV_REST_API_URL`, `KV_REST_API_TOKEN` (read by `lib/secure-kv.js`).
   - Bot ingress auth: `KESEFLE_BOT_SECRET` (checked in `api/sheet/append.js`, `api/profile.js`, `api/learn.js`, etc - the shared secret the Apps Script bot sends).
   - Provisioning: `KESEFLE_TEMPLATE_SHEET_ID` (referenced by `api/health.js`).
   - Google OAuth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (used in `lib/oauth.js`, `api/auth/google-exchange.js`).
   - Admin gate: `ADMIN_EMAILS` (the comma-separated allowlist in `lib/auth.js` / `lib/alert.js`).
3. Check presence in Vercel WITHOUT values. Preferred: the Vercel MCP - load it first ([[kesefle-deferred-tool-load]]), then `list_projects` to find `kesefle` and inspect its env var KEYS. Or use the dashboard: project -> Settings -> Environment Variables and read the NAME column only.
4. For each required name, record present/absent and which scope (Production must have it; Preview/Development optional).
5. If a required name is MISSING, do not invent a value - report it as a blocker for Steven to set himself in Vercel (he pastes secret values; the assistant never does).
6. Report a simple table: name | present? | scope. Do NOT capture, decrypt, or echo any value.

## Verification
- Every name from step 2 shows `present` in the Production scope.
- Cross-check against `api/health.js`: in production, `GET /api/health` should not report a missing-config condition (it surfaces template-sheet/config wiring).
- `node tests/full_qa.js` static assertions still pass (`npm run gauntlet`) - they confirm the code reads the expected names; this audit confirms the platform supplies them.

## Optional vs required
- REQUIRED for a working deploy: the step-2 names (KV, `KESEFLE_BOT_SECRET`, `KESEFLE_TEMPLATE_SHEET_ID`, Google OAuth trio, `ADMIN_EMAILS`).
- FEATURE-GATED (absent = that feature degrades soft, not a hard fail): `PAYPAL_*` (billing - see [[kesefle-paypal-setup-guide]]), `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (web push), `GA4_MEASUREMENT_ID`/`META_PIXEL_ID`/`TIKTOK_PIXEL_ID` (analytics), `KESEFLE_BOT_NUMBER`/`WABA_APPROVED` (public number override). Report these as "missing -> feature off", not as a deploy blocker.

## Common pitfalls
- Treating `.env.example` as the required list - it is partial (it covers only the crypto/session/voice extras). The code grep in step 1 is authoritative.
- Reading the VALUE to "verify it's right" - never. Presence + scope only; a wrong value is debugged via `api/debug-prod` logs, not by printing secrets.
- Setting a var in Preview but not Production (or vice-versa) - confirm the scope, not just existence.
- Assuming the public Google ID and the secret are the same var - `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is browser-exposed; `GOOGLE_CLIENT_SECRET` is server-only. Both must exist.
- Confusing this with the bot's Apps Script Script Properties - those (e.g. `KFL_*`, WhatsApp token) live in Apps Script, not Vercel, and are out of scope here.
- Auditing the wrong Vercel scope/project - confirm you're on the `kesefle` project (not a preview fork) before reading the NAME column.
- Reporting a feature-gated name (e.g. a `PAYPAL_*` plan ID) as a hard blocker - it only disables that feature; flag it as such, not as a deploy-breaker.
