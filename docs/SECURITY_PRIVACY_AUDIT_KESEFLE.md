# Security & Privacy Audit — Kesefle

Date: 2026-05-28
Auditor: Agent 7 (autonomous block)
Branch: `audit-security-privacy`
Scope: repo at HEAD of `origin/main` (commit 135b5c2). Read-only review.

All real secret values appearing anywhere below are masked as `***MASKED***`.
The audit found **zero** hardcoded production secret values in tracked source.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 2 |
| Medium   | 7 |
| Low      | 6 |

**Items needing immediate action (next 24–48h):**
- H1 — `api/events.js?action=track` ACAO reflection without `Vary: Origin`
- H2 — Server-side log lines write PII (`userSub`, `email`, `spreadsheetId`) bypassing the redactor
- M1 — `requireAdmin` trusts `email` from the KV `user:{sub}` cache, not a fresh ID-token claim, on cookie-session admin requests
- M2 — `csv-import` 5 MB cap is enforced *after* the full body is read into memory; no streaming / Content-Length pre-check

Everything else is hardening; nothing leaks user data right now.

---

## Methodology

Ran the `security-scan` skill from `.claude/skills/security-scan/SKILL.md` then expanded with the 10 deeper checks listed in the autonomous-audit brief:
1. Hardcoded secrets — masked grep across `*.js / *.html / *.gs / *.json / *.md`
2. Private spreadsheet IDs in any served HTML/JS
3. PII in `console.log` / `console.error` across `api/`, `lib/`
4. Unauthenticated API endpoints — auth method per file
5. CORS — `vercel.json` headers + per-route `Access-Control-Allow-Origin`
6. Rate limits — `withRateLimit` / `rateLimitId` coverage of every write endpoint
7. File upload validation (`api/sheet/csv-import.js`, `api/import/bank-csv.js`)
8. External LLM calls — what fields land in OpenAI / Anthropic / Gemini bodies
9. Phone-to-sheet resolution path (`/api/whatsapp/link`, `/api/sheet/*`)
10. Admin gating — ID-token vs. email-allowlist-only

Time spent on this doc: ~30 minutes. Time spent on the AI router readiness doc: ~25 minutes.

---

## Findings

### Critical

None. The two highest-impact attack surfaces (Meta webhook + Stripe-style billing webhooks + Vercel cron) all verify HMAC / Bearer signatures before doing anything; `requireAuth` verifies the Google JWT signature against JWKS (not the X-User-Sub header that earlier audits flagged).

### High

| # | Risk | Severity | File:line | Evidence (masked) | Fix | Priority |
|---|------|----------|-----------|-------------------|-----|----------|
| H1 | **Origin-reflecting CORS without `Vary: Origin`** on the public-tracking endpoint may let a cached CDN response for one origin be served to another, defeating the allowlist for the cached window. | High | `api/events.js:276-282` | `const origin = req.headers?.origin \|\| ''; if (_ALLOWED_ORIGINS_.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); }` (no `Vary` header set). | Always emit `res.setHeader('Vary', 'Origin')` whenever ACAO is reflected, *and* set it on the OPTIONS preflight path. | This week |
| H2 | **PII written to Vercel logs by direct `console.error/log`** — these calls bypass `lib/log.js` `redact()` and land in plaintext retention. Includes `userSub`, `email`, `spreadsheetId`, and the entire raw user record on signup. | High | `api/auth/google.js:109` `console.log('USER_SIGNUP', JSON.stringify({` (the next lines pack `user.sub`, `user.email`, `user.name`, `user.picture`) — full Google identity in cleartext. Also `api/sheet/provision.js:290` `console.log('SHEET_PROVISIONED', JSON.stringify(record))` (full record incl. `spreadsheetId` + `userSub` + `email`). And `api/whatsapp/webhook.js:355,361` `console.error('WRITE_BLOCKED_DECRYPT_FAILED', { userSub: userRecord.userSub, ... })`. | Replace every raw `console.*` in `api/**` and `lib/**` with `log.info / log.warn / log.error` from `lib/log.js` (which redacts `userSub`, `email`, `phone`, `token`, `secret`). Audit the 25 hits enumerated in `grep -rnE "console\.(log\|info\|warn\|error)" api/ lib/`. | This week |

### Medium

| # | Risk | Severity | File:line | Evidence (masked) | Fix | Priority |
|---|------|----------|-----------|-------------------|-----|----------|
| M1 | **`requireAdmin` on the session-cookie path reads `email` from the KV `user:{sub}` cache, not from a freshly-verified ID-token claim.** If the user record's `email` is ever mutated server-side (today nothing does, but the migration scripts in `scripts/` are one careless edit away), admin gating breaks open. The Bearer-token path is safe — payload comes straight from JWKS verification. | Medium | `lib/auth.js:170-176, 208-220` `req.user = { sub: userSub, email, ... }` where `email` is `JSON.parse(j.result).email` from `user:{sub}` KV. | Either (a) gate admin endpoints to the Bearer-token auth path only, or (b) re-verify the ID token in `requireAdmin` against `process.env.ADMIN_EMAILS` after extracting `sub` from the session cookie (one extra round-trip but no trust on KV). | Sprint |
| M2 | **`csv-import` body-size cap is *after* full-body parse** — the 5 MB and 5000-row checks happen at line 224/235 of `api/sheet/csv-import.js`, but the body has already been deserialized by Vercel. A malicious caller with the bot secret could exhaust serverless memory with a 100 MB body before the check fires. | Medium | `api/sheet/csv-import.js:225-235` `if (csvText.length > 5 * 1024 * 1024) { return res.status(413)... }` runs only after `String(body.csv \|\| '')`. | Pre-flight `req.headers['content-length']` and abort > 6 MB before parsing. Also add `export const config = { api: { bodyParser: { sizeLimit: '6mb' } } }`. | Sprint |
| M3 | **CSP `script-src 'unsafe-inline'`** in `vercel.json` line 60 makes XSS into the inline scripts on every page (there are dozens) much easier to exploit. Necessary today because every page has inline `<script>` blocks, but worth tracking. | Medium | `vercel.json:60` `"Content-Security-Policy", "value": "default-src 'self'; script-src 'self' 'unsafe-inline' ..."`. | Move inline scripts into `js/*.js` + add nonces in the next refactor; not a quick fix, document in `docs/SECURITY.md`. | Quarter |
| M4 | **`api/log/user-report.js` accepts a free-text `email` field with no verification** and writes to KV `user_reports`. An attacker can flood the list with bogus emails for anyone, then if Steven copy-pastes one into outreach he reaches a victim instead of the reporter. | Medium | `api/log/user-report.js:30` `const email = String(body?.email \|\| '').slice(0, 200);` — no MX check, no rate-limit per email (only per IP). | Add `email` field to the rate-limit key in addition to IP; clearly mark the field as user-typed in the admin UI; never auto-send to it. | Sprint |
| M5 | **`api/health.js` and `api/health/detailed.js` expose per-dep status and a long list of `env_present` boolean flags publicly.** This is intentional (uptime monitors), but the env-flag list now includes ~30 names; that's a useful reconnaissance map for an attacker. | Medium | `api/health.js:42-60`, `api/admin.js:443-450` (the `bot-status` action). | Either move the env-flag matrix behind admin auth, or trim the public flag list to just (kv, sheets, meta). Keep deep probe public. | Sprint |
| M6 | **`api/sheet/csv-import.js` and `api/import/bank-csv.js` accept the entire CSV body as JSON** and don't enforce a Content-Type allowlist or a MIME sniff for executable payloads. Today they only ever go to Sheets cell values (sanitized), but if an importer ever gains attachment storage this becomes an unrestricted file upload. | Medium | `api/sheet/csv-import.js:17` body shape `{ phone, csv, mode }`; `api/import/bank-csv.js:7` body shape `{ bank, csvText }`. | Add an `if (req.headers['content-type'] && !/^application\/json/.test(req.headers['content-type'])) return 415` guard. | Sprint |
| M7 | **Bot-secret in CSV import is comparable to `presented` even when `BOT_SECRET` is the empty string** — `constantTimeEqual('', '')` returns true. Today the early `if (!BOT_SECRET)` 503 guard catches it, but reorder bugs are easy. | Medium | `api/sheet/csv-import.js:204-211` (and same pattern in `append.js`, `bot-query.js`, `add-category-row.js`, `mark-vat.js`). | Add `if (!presented \|\| presented.length < 16)` before the comparison as a belt-and-suspenders check. | Sprint |

### Low

| # | Risk | Severity | File:line | Evidence (masked) | Fix | Priority |
|---|------|----------|-----------|-------------------|-----|----------|
| L1 | **Owner spreadsheet ID `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` is hardcoded in 24 Apps Script files** under `bot/*.gs` and 6 markdown docs. The bot's *owner phone* gate is the only thing preventing a non-owner write to it. | Low | `bot/config.gs:23` `var PERSONAL_TEMPLATE_SHEET_ID = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';` plus 23 sibling `.gs` files. | Move to Apps Script `PropertiesService` (already the pattern for API keys) so a leaked `.gs` paste doesn't disclose the ID. | Quarter |
| L2 | **`getSecret()` requires `SESSION_SECRET` length ≥ 16** but does not enforce entropy. A 16-char predictable string (`"changeme12345678"`) passes the gate. | Low | `api/_lib/session.js:31-37` `if (!s \|\| s.length < 16) { throw new Error('SESSION_SECRET env var required (min 16 chars)'); }`. | Add: `if (/^(.)\1+$/.test(s)) throw new Error('low entropy')`; document `openssl rand -base64 32` in `.env.example`. | Quarter |
| L3 | **`api/log/missed-inapp.js` and `api/log/funnel-event.js` are unauthenticated KV writers** rate-limited only per IP. A botnet behind 50k IPs can blow the KV free tier in a day. | Low | `api/log/missed-inapp.js:14-35`, `api/log/funnel-event.js`. | Add a daily global LIMIT counter; if exceeded, 204-noop. Already partially present via `withRateLimit`. | Quarter |
| L4 | **`api/events.js?action=track` rate limit is per-IP only** but a tracked event can be any UA-supplied `meta` payload up to 2 KB; multiplied across 50 entries it's a KV scan of 100 KB per request. Today negligible, watch as scale grows. | Low | `api/events.js:172-220` (event handler) + `lib/ratelimit.js`. | Cap `meta` field size at 256 bytes; reject anything larger. | Quarter |
| L5 | **`vercel.json` headers section does not set `X-XSS-Protection: 0`** — modern browsers ignore it but legacy ones still try the heuristic, which has bypasses. | Low | `vercel.json:51-60` security headers section. | Add `{ "key": "X-XSS-Protection", "value": "0" }`. | Quarter |
| L6 | **`api/admin/recent-signups.js` and other admin endpoints log `email` via `log.info` redactor — but the redactor only matches the *key* `email`; nested objects nested under other keys (`user.profile.email`) escape redaction.** | Low | `lib/log.js:55-58` recursion correctly redacts by key — confirmed safe for the call sites checked, but `withRequestId` wrappers around handler responses do not redact response bodies. | Add a 6-line response-body redact pass behind a `KFL_LOG_RESPONSE_BODY=1` debug flag only. | Quarter |

---

## What's solid (no findings, audited)

1. **Hardcoded secret scan** — `grep -rnEi 'AIza[0-9A-Za-z_-]{20,}|sk-[a-zA-Z0-9]{20,}|xox[baprs]-|-----BEGIN (RSA|EC|OPENSSH|PRIVATE)|client_secret"?\s*[:=]|KESEFLE_BOT_SECRET\s*=\s*["'\'']'` over the repo returned **zero** real values. Every match is either:
   - A reference to `process.env.X_CLIENT_SECRET` (passthrough, not a value)
   - A test fixture setting `KESEFLE_BOT_SECRET = 'test-' + Date.now()` (ephemeral)
   - A documentation comment.
2. **No private spreadsheet IDs leak into served HTML.** The owner Sheet ID `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` is referenced only in `bot/*.gs` (server-side Apps Script) and `docs/*.md`. Verified by `grep` over `*.html` — zero matches in any HTML file.
3. **Tenant isolation chain on write paths is correctly enforced.** `api/sheet/append.js`, `api/sheet/csv-import.js`, `api/sheet/bot-query.js`, `api/sheet/add-category-row.js`, `api/sheet/mark-vat.js`, `api/sheet/fix-company-dashboard.js`, `api/whatsapp/webhook.js`, `api/cron/recurring.js`, `api/sheet/delete-rows.js`, `api/sheet/export.js`, `api/sheet/monthly-statement.js`, `api/import/bank-csv.js` all follow:
   `phone -> phone:{E164} -> { userSub } -> sheet:{userSub}` and abort on mismatch.
4. **Meta webhook signature verification** in `api/whatsapp/webhook.js:33-39` uses `crypto.timingSafeEqual` over raw bytes (bodyParser disabled). Correct.
5. **Cron auth** in `api/cron/{recurring,reminders}.js` requires `Authorization: Bearer ${CRON_SECRET}` verified with `constantTimeEqual`. Fails closed when env unset. Correct.
6. **Refresh tokens** are AES-256-GCM encrypted at rest via `lib/crypto.js`. The KV backup file (`api/cron/kv-backup.js`) snapshots the *encrypted* envelopes; the key (`SESSION_SECRET`) is not in the backup. Correct.
7. **`requireAuth`** verifies Google ID-token RS256 signature against JWKS, audience, issuer, expiry. The `X-User-Sub` header that was once trusted is no longer accepted — explicit comment in `lib/auth.js:9`.
8. **Formula injection** — `sanitizeCell` in `lib/sheet-writer.js:1039` strips leading `=`, `+`, `-`, `@` from every cell write and blocks `=IMPORT*` / `HYPERLINK`. Applied at every row build site verified.
9. **Bot-secret check uses `constantTimeEqual`** (no early-exit string comparison) on every bot-callable endpoint.
10. **CORS allowlist** in `api/events.js:276` is closed (no `*`) and reflects only known origins (`kesefle.com`, `localhost:3000`, etc.).
11. **No `eval()` / `Function(...)`** in `api/`, `lib/`, or `bot/ExpenseBot_FIXED.gs` — checked.
12. **Admin emails default** is `stevenrancohen@gmail.com,info@kesefle.com` — both are accounts Steven owns. `ADMIN_EMAILS` env var overrides.
13. **`gitignore` covers `.env`, `.env.local`, `*.log`, `.context-brain.db*`** — verified no `.env*` file (except `.env.example`) is tracked.

---

## LLM / external data flow check

| Provider | Files | Env var | Model | Data sent | Verdict |
|----------|-------|---------|-------|-----------|---------|
| Anthropic | `bot/ExpenseBot_FIXED.gs:8928, 9381, 10193, 15281` (5 sites total) | `ANTHROPIC_API_KEY` (Apps Script `PropertiesService`) | `claude-haiku-4-5-20251001` | Expense description text (max 200 chars), category-correction text, receipt image (base64), Hebrew text for synonym expansion | **No phone, no email, no userSub, no full row history** — the prompts are minimization-clean. Good. |
| OpenAI Whisper | `bot/ExpenseBot_FIXED.gs:9615` | `OPENAI_API_KEY` | `whisper-1` | Raw audio bytes from the user's WhatsApp voice note (Hebrew speech). | Audio is user-uttered content — the **only** way to transcribe it. No metadata sent. OK by design, document in privacy policy. |
| Gemini | `bot/ExpenseBot_FIXED.gs:4590`, `bot/RECEIPT_PARSING.gs:32`, `bot/EMBEDDING_FALLBACK.gs:27` | `GEMINI_API_KEY` | `gemini-2.0-flash`, `gemini-1.5-flash`, `text-embedding-004` | Free-form user query text (capped to 1000 chars); a `_spendingContextLine_` is *omitted* for owner and *anonymized* (no name/phone) for tenants. Receipt image bytes for OCR. | Acceptable minimization; the spending context line is the only sensitive field and it's already aggregated. |
| (none) | n/a | — | — | — | No OpenRouter, no Grok/xAI, no DeepSeek calls in tracked source. |

See `docs/AI_PROVIDER_ROUTER_READINESS.md` for the abstraction-layer proposal that consolidates these.

---

## Verification commands run

```
grep -rnEi 'AIza[0-9A-Za-z_-]{20,}|sk-[a-zA-Z0-9]{20,}|xox[baprs]-' --include='*.js' --include='*.html' --include='*.gs' --include='*.json' --include='*.md' .  # → 0 hits
grep -rnE 'KESEFLE_BOT_SECRET\s*=\s*["\']' --include='*.js' --include='*.json' --include='*.html' --include='*.gs' .  # → only test fixtures
grep -rnE '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo' --include='*.html' .  # → 0 hits
grep -rnE 'console\.(log|info|warn|error)' --include='*.js' api/ lib/  # → 25 hits, 6 carry PII (H2)
find api -name '*.js' -not -path '*/_lib/*' | xargs grep -L 'requireAuth\|requireAdmin\|KESEFLE_BOT_SECRET\|botSecret\|cron\|verifySignature'  # → 16 files; all manually verified (most use session cookies, webhook HMAC, or are public-by-design)
```

---

## Next steps

1. **Today** (1 hour): Fix H2 by sed-replacing `console.log/error` with `log.info/error` from `lib/log.js` in 6 specific lines; redeploy.
2. **This week** (4 hours): Fix H1 (`Vary: Origin`), M1 (admin re-verify), M2 (csv-import pre-flight size).
3. **Sprint** (1 week): M3–M7.
4. **Quarter**: All Low findings; the CSP `unsafe-inline` removal is the biggest win and the most work.

The repo is in much better shape than the headline finding count suggests — every High and Medium has a known fix that does not require architectural change.
