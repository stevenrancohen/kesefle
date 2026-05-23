# Launch-day runbook — what to do when X breaks at 3am

Keep this file open in a browser tab during the launch. Each scenario has a
1-minute response. Don't improvise — improvising during a launch costs you
ad money in real time.

---

## Quick-reference dashboards

- **Live signups + bot health**: https://kesefle.com/admin/launch-monitor (auto-refreshes every 30s)
- **Pending payments + questionnaires**: https://kesefle.com/admin
- **Vercel logs**: https://vercel.com/stevenrancohen/kesefle/logs
- **Upstash usage**: https://console.upstash.com → your DB → Usage
- **Meta WhatsApp Manager**: https://business.facebook.com/wa/manage → Phone numbers

---

## Symptom → Action lookup

### Symptom: launch-monitor shows "🔴 Critical — over 95% of KV free tier"

**Why**: Upstash free tier is 10k commands/day. You're about to hit hard rejection.

**1-min response**:
1. Go to **console.upstash.com → your DB → Settings → Upgrade**.
2. Pick **Pay-as-you-go** ($0.20 per 100k commands after the free 500k/month).
3. Confirm with the card on file.
4. **Done in 90 seconds**. KV serves immediately, no redeploy needed.

If you really can't upgrade right now: there's nothing else to do. Writes will start failing → bot will stop responding to new users. You'll lose the launch.

---

### Symptom: launch-monitor shows "⚠ Bot version drift"

**Why**: You shipped a new bot version to the repo but didn't paste it into Apps Script. Live bot is running an older build with bugs we already fixed.

**1-min response**:
1. Open https://script.google.com → Kesefle / Expenses Bot project.
2. Open `bot/ExpenseBot_DEPLOY.gs` from the repo (https://github.com/stevenrancohen/kesefle/blob/main/bot/ExpenseBot_DEPLOY.gs).
3. Click "Raw" → Ctrl/Cmd+A → Ctrl/Cmd+C.
4. In Apps Script editor: Ctrl/Cmd+A → Ctrl/Cmd+V → Ctrl/Cmd+S to save.
5. Click **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**.
6. Send `בדיקה` to the bot from your phone to verify.

---

### Symptom: launch-monitor shows "⚠ Bot number drift"

**Why**: You set `KESEFLE_BOT_NUMBER` in Vercel env to a new WABA number, but the 45 hardcoded `wa.me/<number>` anchors in HTML still point at the old one.

**1-min response**:
1. From the repo: `scripts/swap-bot-number.sh <new_number_e164_no_plus>`
2. `git diff` → review (sanity check the find-replace).
3. `git add -A && git commit -m "chore: sync bot number to <new>" && git push`.
4. Vercel auto-deploys in ~60s. The drift card turns green on the next monitor poll.

---

### Symptom: signups crashed — `/api/sheet/provision` returning 502 for everyone

**Why** (4 possibilities, in order of likelihood):
1. Google Sheets API quota hit
2. KV write failures (see KV symptom above)
3. Google revoked your OAuth app
4. Our code regressed

**1-min response**:
1. Open **Vercel logs** → filter `/api/sheet/provision` → look at the error message in the last 60s.
2. If it says **"sheet_create_failed: Quota exceeded"** → wait 60s (per-100-seconds quota) or go to **console.cloud.google.com → APIs & Services → Sheets API → Quotas → request quota increase**.
3. If it says **"sheet_registration_failed"** → KV problem, see KV symptom.
4. If it says **"invalid_access_token" or "missing_drive_file_scope"** → Google revoked the app. Open OAuth consent screen and re-submit if needed.
5. If none of the above → roll back: `git revert HEAD && git push`. Investigate later when not on fire.

---

### Symptom: users say "Continue with Google" shows a blank screen

**Why**: In-app browser (WhatsApp, Instagram, etc.) — Google refuses OAuth there.

**This should NOT happen** — our in-app detection redirects them to the help card. If it IS happening:

1. Open https://kesefle.com/admin/launch-monitor → check the **"In-app browser detection misses (recent)"** card.
2. Copy the User-Agent string of the top miss.
3. Open `account.html` line ~875 (`function kesefleIsInAppBrowser()`).
4. Add the missing UA pattern to the regex (e.g. if you see `XYZWebView`, add `XYZWebView` to the second regex).
5. Commit + push. Vercel deploys in ~60s. Update the SW VERSION too to force cache refresh.

---

### Symptom: WhatsApp bot stopped responding

**Why** (in order):
1. **You're on the Meta test number `+1 555 640 8123` and you've hit the 5-allow-listed-recipients ceiling.**
2. Apps Script trigger broken
3. Bot crashed (caught exception, dropped message)
4. Meta token expired

**1-min response**:
1. Check Meta WhatsApp Manager → your number → **Account Quality** + **Messaging Limits**. If yellow/red → you hit the cap. Get a real WABA number per `docs/WABA_SETUP_STEP_BY_STEP.md` -- the Numero number, 360dialog, etc.
2. If still on the test number with <5 users: open Meta Business Settings → WhatsApp Accounts → Phone numbers → Manage → "Add recipient" to allow more numbers manually.
3. Apps Script: open the project → Executions (left sidebar) → look at the last 10 runs for "Error". Common errors:
   - "Unauthorized" → re-save the script, redeploy.
   - Quota exceeded → upgrade Google Workspace or wait until midnight Pacific time.
4. Use `/admin/launch-monitor → "Resend WhatsApp welcome"` to manually push the welcome to any stuck users.

---

### Symptom: a specific user complains they signed up but never got the bot welcome

**1-min response**:
1. Open https://kesefle.com/admin/launch-monitor → scroll to **"Resend WhatsApp welcome message"** card.
2. Paste their phone in E.164 format (e.g. `972547760643`, no `+`).
3. Click **Send welcome**. Should show "✓ Sent to +972547760643 (email@gmail.com)".
4. If it shows "✗ phone_not_linked" → they didn't complete the phone-link step. Email them and ask them to revisit `/account`.
5. If "✗ meta_429" → you hit the Meta test-number daily limit (250/day). See bot symptom above.

---

### Symptom: a paid ad clicked but conversion didn't fire in Facebook/Google Ads dashboard

**Why** (we don't have conversion pixels installed by default):

**1-min response**:
1. This is expected — we haven't wired Facebook Pixel or Google Analytics yet.
2. Use the **launch-monitor** data instead: see "New signups (1h)" to count conversions in the last hour.
3. Manually report back to your Ads Manager: "we got X conversions in the last hour from Y impressions".
4. After launch: install Facebook Pixel by adding the pixel script to `index.html` + `/account` and fire a `Lead` event on signup_complete.

---

### Symptom: site is down — Vercel returns 5xx

**1-min response**:
1. Open https://www.vercel-status.com — check if Vercel itself is down.
2. If yes → wait, post a banner on Twitter, refund ad spend later.
3. If no → check Vercel logs for the last commit. Roll back: `git log -5` → find the commit BEFORE the breakage → `git revert <SHA> && git push`. Done in 2 min.

---

### Symptom: bot answered with raw JSON (`{"action":"chat","reply":"..."}`)

**Why**: bot is running an old version where the Gemini concierge JSON wrapper leak isn't handled.

**1-min response**: Bot version drift → redeploy the bot per the drift symptom above.

---

## Numbers to keep in your phone

- **Vercel support**: support@vercel.com (response ~2-4h)
- **Upstash support**: support@upstash.com (response ~1-2h)
- **Meta Business support**: business.facebook.com/help (chat, ~30min response during US business hours)
- **Google Cloud support**: cloud.google.com/support (paid; free tier = community forums only)

---

## Anti-patterns (do NOT do these during launch)

- ❌ Don't deploy untested code. If you must fix something on the fly, test it locally first with `node tests/full_qa.js` minimum.
- ❌ Don't restart the Vercel project to "fix something". Restart doesn't do anything.
- ❌ Don't manually edit the KV store via console.upstash.com unless you're absolutely sure — you can break referential integrity.
- ❌ Don't reply to angry users with "we'll look into it". Either fix the bug fast or refund + recover.
- ❌ Don't switch the bot phone number mid-launch (existing users will lose the bot). If you must, communicate via email FIRST.

---

## After launch — first 24h post-launch checklist

1. Run `node scripts/preflight-test.mjs` once an hour for the first 6 hours. All 10 checks should stay green.
2. Snapshot `/admin/launch-monitor` numbers at +1h, +6h, +12h, +24h. Helps debug retention.
3. Open Vercel Logs → search for `WARN` and `ERROR` — every line is a user who hit something they shouldn't have.
4. Email every user who signed up but never linked WhatsApp (use `/api/admin/users` to list, manual sweep).
5. Post-mortem doc — by T+48h, write what worked / what broke / what to fix before the next wave.
