# If Google Rejects — Recovery Playbook

Verification rejection is uncommon but happens. Don't panic. Here's the playbook.

## Common rejection reasons + fixes

### "Brand verification failed — we couldn't confirm you own kesefle.vercel.app"

**Fix:**
- Add the verification HTML file to the site (Google sends a URL like `googlexxxxx.html`)
- OR add a DNS TXT record to vercel.app (you'll need to ask Vercel support since they own the domain)
- **Easier path:** buy your own domain (e.g., `kesefle.com` for $12/year), point it at Vercel, then verify domain ownership via DNS TXT record (instant)

### "Restricted scope justification is insufficient"

**Fix:**
- Resubmit with the more detailed scope-justifications.md
- Specifically emphasize: "We only call drive.readonly on a single hardcoded template file ID. We never list or enumerate the user's Drive."
- Provide a code snippet pointing them to api/sheet/provision.js

### "Demo video doesn't show the OAuth consent screen clearly"

**Fix:**
- Re-record the video with the consent screen on display for 10+ seconds
- Zoom into the consent screen (1.5x browser zoom is fine)
- Use a screen-annotation tool to draw circles around the scope list

### "We can't find your privacy policy at the URL provided"

**Fix:**
- Double-check the URL works in incognito (https://kesefle.vercel.app/privacy)
- Make sure no auth wall in front of it
- Re-submit with the URL after confirming

### "Your app collects more data than your privacy policy describes"

**Fix:**
- Audit /privacy and add anything missing
- The privacy-summary.md in this folder has the complete list — make sure /privacy matches

### "Your app's logo doesn't match"

**Fix:**
- Upload a fresh 120x120 PNG to the OAuth consent screen
- Make sure it's the same logo shown on your homepage

## What NOT to do if rejected

- ❌ Don't immediately re-submit — read Google's email carefully first
- ❌ Don't argue with Google — they're not your customer
- ❌ Don't apply for sensitive scopes you don't actually need just to "be safe"
- ❌ Don't delete and recreate the OAuth client — that resets the whole process

## Escalation if stuck

After 2 unsuccessful resubmissions:
1. Email `support-google-cloud@google.com` with case number
2. Post on `cloud-platform-discuss` Stack Exchange
3. Last resort: tweet @GoogleCloud with case number

## Alternative paths (if verification keeps failing)

### Option A: Use only `drive.file` scope (drop `drive.readonly`)
- Pros: Easier verification, less data collection
- Cons: Must use a service account to copy the template (more complex backend), users see a different Sheet ownership

### Option B: Service Account architecture
- Kesefle owns a service account that has access to the template
- Service account creates the Sheet on the user's behalf
- Service account transfers ownership of the Sheet to the user
- No need for user's `drive.readonly` scope
- Pros: Verification much easier (only `drive.file` and `spreadsheets` needed)
- Cons: ~4 hours of backend work to refactor

### Option C: Use OAuth only for SSO, store data on our servers
- Drop Drive integration entirely
- Users log in with Google but data lives in our Postgres
- Pros: No sensitive scopes, verification trivial
- Cons: Users no longer own their data — defeats Kesefle's whole pitch

Don't go down Option C unless absolutely forced. Option B is the realistic fallback if verification keeps stalling.

## Tracking verification progress

Google sends emails from `oauth-noreply@google.com`. Whitelist this address so you don't miss them.

Status URL: https://console.cloud.google.com/apis/credentials/consent?project=191938738571 → "Verification Status" section.

Average timeline:
- Submission to first review: 3-7 business days
- First review to approval (no questions): 1-2 weeks
- First review to follow-up question: 7 days
- Follow-up to approval: another 3-7 days
- Total: 2-4 weeks typically

If you don't hear anything in 14 days, send a polite follow-up to the case email.
