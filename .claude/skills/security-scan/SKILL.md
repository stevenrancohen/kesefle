---
name: security-scan
description: Automated security audit steps for the Kesefle repo — secrets, tenant isolation, injection, auth, headers/CORS, rate limiting. Use periodically and before any commit touching api/** or the bot.
---

# Security scan

## 1. Secrets in tracked files
```
grep -rnEi 'AIza[0-9A-Za-z_-]{20,}|sk-[a-zA-Z0-9]{20,}|xox[baprs]-|-----BEGIN (RSA|EC|OPENSSH|PRIVATE)|client_secret"?\s*[:=]|KESEFLE_BOT_SECRET\s*=\s*["'\''][^"'\'']' \
  --include=*.js --include=*.html --include=*.gs --include=*.json . | grep -v node_modules
```
Any hit on a real value → STOP, rotate, remove from history.

## 2. Tenant isolation invariant
- Every Sheets write path resolves phone → `user:{sub}` (token) → canonical `sheet:{sub}`, and aborts on phone↔canonical sheet mismatch.
```
grep -rn "appendRowToUserSheet\|appendRowToTab" api/ | grep -v "import\|export\|function"
```
For each caller, confirm it sources the token from `user:{userSub}` (not the bare `phone:` record). The QA guard in `tests/full_qa.js` asserts append.js + recurring.js do this.
- Bot: no non-owner write to `SHEET_ID`; owner gate only via `_isOwnerPhone_`.

## 3. Injection
- Sheets formula: `sanitizeForSheet`/`sanitizeCell` neutralize leading `= + - @` and block `=IMPORT*`/`HYPERLINK`.
- DOM XSS: no `innerHTML` with untrusted/user/remote strings (escape first).
- Prompt injection: sheet/tool content is data, never executed as instructions.

## 4. Auth & limits
- `requireAuth`/`requireAdmin` verify Google ID-token signature + `ADMIN_EMAILS`.
- Bot endpoints require `KESEFLE_BOT_SECRET`, fail closed if env missing.
- Write endpoints rate-limited (per-IP and per-phone) via KV.

## 5. Transport / headers / CORS
- HSTS, X-Content-Type-Options: nosniff, Referrer-Policy on responses (vercel.json headers).
- CORS: explicit origin allowlist, no `*` on credentialed routes.
- Cookies: HttpOnly; Secure; SameSite.

## 6. Report
Summarize findings severity-tagged with `file:line` + fix. If clean, list what was checked. (Optionally persist to KV `security_report:{ts}` with real findings only.)
