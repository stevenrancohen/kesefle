# ✅ Kesefle — Deployment & Verification Checklist

> Last updated by the security-hardening pass. Work top‑to‑bottom. The 🔴 items
> are required for **multi‑tenant isolation** (each user → their own sheet). The
> code is already pushed to GitHub → Vercel auto‑deploys the **website + API**.
> The **WhatsApp bot** is separate: you must paste it into Apps Script yourself.

---

## 0. ⚠️ THE BOT'S PUBLIC WHATSAPP NUMBER (before public launch)

**As of 2026-05-22, everything is aligned on the Meta test number
`+1 555 640 8123` (`15556408123`):** all site "message the bot" links AND the
bot's own `BOT_PHONE_E164` point here. (We removed the earlier mismatch where
the site advertised `+1 774 544 8053` / `17745448053` — that Numero number was
never activated on WhatsApp, so those links were dead: "isn't on WhatsApp".)

- **Test phase (now):** the test number only delivers to numbers you allow‑list
  in Meta → WhatsApp → API Setup → "To". Add each tester's number + verify the
  code. Great for demos with you + a handful of testers; NOT open to the public.
- **Before opening to the public:** a Meta test number cannot serve real users.
  Provision a real WhatsApp Business number (a mobile SIM or Meta‑purchased
  number — VoIP/Numero numbers like 774‑544‑8053 are usually rejected by Meta),
  verify the business in Meta Business Manager, take the app out of test mode,
  then swap `wa.me/15556408123` → the live number across the site (index,
  welcome, about, dashboard, start, family, group, pricing, help, trust,
  roadmap, blog, changelog, account, automations, privacy, seo, team, tools,
  test.html) **and** `BOT_PHONE_E164` in the bot. Tell me the number and I'll
  do the swap in one pass.
- Note: `contact.html` / `terms.html` correctly use your **support** line
  `972547760643` (054‑776‑0643) — separate from the bot number; leave it.

---

## 1. 🔴 Deploy the bot (Apps Script)

1. Open the Apps Script project (script.google.com → your "Kesefle / Expenses Bot").
2. **File hygiene — this matters for security.** Your project should contain ONLY:
   - the main bot file (paste `bot/ExpenseBot_DEPLOY.gs` into it),
   - `BOT_COMMANDS.gs` (only if you use owner commands like `מחק אחרון` / stats),
   - `CLEANUP_LEAKED_ROWS.gs` (optional, for the one‑time cleanup in §5).
   - **Do NOT paste** `ExpenseBot_FIXED.gs` (it's the build *source* and has its
     own `doPost` — two `doPost`s collide), nor any `FIX_*` / `CREATE_*` /
     `CLEANUP_DUPLICATES_*` / `KESEFLE_KEYWORDS_*` dev script unless you know you need it.
3. Copy the **entire** contents of `bot/ExpenseBot_DEPLOY.gs` → paste over the main
   file → **Save (Cmd+S)**.
4. **Deploy → Manage deployments → (edit ✏️) → Version: New version → Deploy.**
   (Without a new version, Meta keeps calling the old code.)

## 2. 🔴 Script Properties (Apps Script → Project Settings ⚙️ → Script Properties)

| Property | Value | Why |
|---|---|---|
| 🔴 `SHEET_OWNER_PHONE` | `972547760643` | **The isolation anchor.** Only this phone writes to your sheet; everyone else routes to their own. **Confirm this is YOUR WhatsApp number.** |
| 🔴 `KESEFLE_BOT_SECRET` | long random string | Must be **identical** to the Vercel env var of the same name — it authorizes the bot→Vercel tenant‑write bridge. |
| `KESEFLE_CRON_SECRET` | long random string | Must match Vercel. Gates the recurring/reminders cron endpoints. |
| `WHATSAPP_TOKEN` | Meta access token | Sending messages. |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta phone number id | Sending messages. |
| `KESEFLE_API_BASE` | `https://kesefle.com` | Where the bridge posts (default is fine). |
| `ANTHROPIC_API_KEY` *(optional)* | `sk-ant-…` | Smarter categorization / receipt OCR. |

Then run `installKesefleBot()` once — it verifies properties and installs the cron triggers, printing a ✅/⚠️ report.

## 3. Vercel environment variables (Project → Settings → Environment Variables)

🔴 **Required for the core multi‑tenant flow:**
- `KESEFLE_BOT_SECRET` (match Apps Script), `KESEFLE_CRON_SECRET` (match Apps Script)
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` (Upstash KV)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (OAuth + sheet writes)
- `KESEFLE_DB_KEY`, `KESEFLE_DB_KEY_ACTIVE_KID` (encrypts users' refresh tokens — without these, sheet writes can't be authorized)
- `SESSION_SECRET`, `PUBLIC_SITE_URL`

**WhatsApp‑on‑Vercel path (only if Meta points at Vercel instead of Apps Script):**
- `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`

**Payments (optional, enable what you use):**
- PayPal: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`, `PAYPAL_PLAN_PRO`, `PAYPAL_PLAN_FAMILY`, `PAYPAL_WEBHOOK_ID` — **⚠️ rotate the PayPal secret that was pasted in chat earlier; treat it as compromised.**
- Crypto: `COINBASE_COMMERCE_API_KEY`, `COINBASE_WEBHOOK_SECRET`
- Manual Bit/bank: `BIT_PAYEE_PHONE`, `BANK_TRANSFER_DETAILS`
- Admin: `ADMIN_EMAILS`, `ADMIN_TOKEN`
- *(Stripe vars exist in code but Stripe was abandoned — leave unset.)*

## 4. 🔴 Google OAuth — let your testers sign in

While the OAuth app is in **Testing**, only approved emails can log in (this is why
test users got `access_denied: 403`).

1. console.cloud.google.com → your project → **APIs & Services → OAuth consent screen**.
2. **Test users → + ADD USERS** → add each tester's **Google email** (e.g. `MaorBalak@gmail.com`). Up to 100.
3. They retry login at kesefle.com/account. (Publishing to Production needs Google
   verification for the Sheets/Drive scopes — do that later when opening to everyone.)

## 5. One‑time: clean leaked rows from your sheet (optional but recommended)

Rows from test users written **before** the isolation fix are still in your `תנועות`
tab. Using `bot/CLEANUP_LEAKED_ROWS.gs` (paste it as a file in Apps Script):
1. `kflBackupTransactionsSheet()` — safety backup.
2. `kflListRowsForReview('2026-05-15','2026-05-21')` — builds a "🔎 בדיקת_דליפה" tab; eyeball it, note the foreign row numbers.
3. `kflDeleteRowsByIndices('7,12,13')` — auto‑backs‑up, then deletes only those rows.

## 6. ✅ Verify isolation end‑to‑end

- From a **test number** (not yours, not yet linked): send `50 קפה`. Expected → an
  onboarding message ("sign up at kesefle.com/account"). **Nothing should appear in YOUR sheet.**
- Link that test number (account.html flow), send again → it lands in **that user's own** sheet.
- From **your** number: send `50 קפה` → lands in **your** sheet as before.
- (Developers: `node bot/test_isolation.js` runs 18 automated isolation checks.)

---

### Quick reference — what's already done for you (pushed to GitHub)
- Multi‑tenant leak fixed across **all** inbound paths (text, buttons, receipts, voice) + owner‑only command routers + a defense‑in‑depth guard. Verified by 4 independent audits + a regression test.
- Website auto‑updates itself now (no more stale cached pages) — just refresh once.
- See `SECURITY.md` for the full isolation model.
