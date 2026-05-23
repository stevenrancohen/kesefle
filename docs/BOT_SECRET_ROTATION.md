# KESEFLE_BOT_SECRET rotation runbook

The bot secret is the only thing that authenticates the Apps Script bot to
the Vercel API (POST `/api/whatsapp/link?action=confirm`, GET
`/api/whatsapp/link?phone=` for plan/sheetId, and others). If it leaks,
anyone who has it can:

- Confirm arbitrary phone -> userSub mappings (cross-tenant takeover)
- Read any user's plan, sheetId, trial state by phone number

So rotate it on a schedule, and immediately on any suspicion of leakage.

## When to rotate

- Every 90 days (calendar reminder).
- Immediately after any of: lost laptop, repo accidentally made public,
  Apps Script editor shared with a third party, suspected compromise.
- After any contractor with bot access leaves.

## How to rotate (5 minutes, zero downtime)

The bot accepts EITHER the old or the new secret during the rollover
window because we set both on the server at once. Steps:

1. **Generate a new secret** (locally, never paste into chat / email):
   ```sh
   openssl rand -hex 32
   # or:
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. **Vercel: add the NEW secret as a SECOND env var** (do not remove the
   old one yet):
   - Settings -> Environment Variables -> Add
   - Name: `KESEFLE_BOT_SECRET_NEXT`
   - Value: `<the hex from step 1>`
   - Environments: Production, Preview, Development
   - Redeploy (or push a no-op commit). Vercel rolls all serverless
     functions to the new env vars within ~60s.

3. **Apps Script (bot side): update the secret**
   - Open the Kesefle bot Apps Script project.
   - File -> Project properties -> Script properties.
   - Edit `KESEFLE_BOT_SECRET` and paste the NEW value.
   - Save. Take effect on the next webhook invocation (no redeploy).

4. **Verify the bot still works**:
   - From a registered phone, send `בדיקה` to the bot.
   - You should get the version reply within a couple of seconds.
   - Send a real expense like `42 קפה` and confirm it lands in your
     sheet.

5. **Vercel: remove the OLD secret, promote NEW**:
   - Once you've confirmed (step 4) the bot is talking to Vercel with
     the new secret, rename the env vars:
     - Rename `KESEFLE_BOT_SECRET_NEXT` -> `KESEFLE_BOT_SECRET`
     - Delete the old `KESEFLE_BOT_SECRET` (the one that was active
       before this rotation).
   - Redeploy. Done.

## Code that reads the secret

If you ever need to support the dual-secret window in code (so the
server accepts either OLD or NEW during the rollover), the pattern is:

```js
const expected = process.env.KESEFLE_BOT_SECRET;
const expectedNext = process.env.KESEFLE_BOT_SECRET_NEXT;
const presented = req.headers['x-kesefle-bot-secret'] || '';
const ok =
  (expected     && constantTimeEqual(presented, expected)) ||
  (expectedNext && constantTimeEqual(presented, expectedNext));
```

The current production code (`api/whatsapp/link.js`) checks only the
single env var, which is fine for the short rotation window outlined
above (bot picks up the new value immediately). If you need a longer
overlap, add the `_NEXT` fallback as above and remove it after rotation.

## What NOT to do

- DO NOT commit the secret to git, ever.
- DO NOT email/Slack/iMessage the secret. Use a password manager.
- DO NOT reuse it for other services (Stripe, Anthropic, etc.).
- DO NOT skip the verification step. A bad rotation breaks every
  WhatsApp message until fixed.

## If the bot stops responding mid-rotation

1. Re-check that the Apps Script `KESEFLE_BOT_SECRET` matches the
   Vercel env var byte-for-byte (no trailing whitespace).
2. Re-deploy Vercel (Settings -> Deployments -> Redeploy latest) to
   refresh env vars on cold-start instances.
3. As a last resort, set both old + new in Apps Script (overwrite the
   property with `OLD_SECRET,NEW_SECRET` and update bot to try both).

## Audit log

The bot's `_kvLookupPhone_` sends `x-kesefle-bot-secret` header on every
call. Server logs `link.confirm.secret_not_configured` if the env var
is missing -- watch for this in Vercel logs as an early-warning that
the rotation broke something.
