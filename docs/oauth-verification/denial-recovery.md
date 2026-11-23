# If Google Rejects — Recovery Playbook

Verification rejection is uncommon but happens. Don't panic. Here's the playbook.

## Common rejection reasons + fixes

### "Brand verification failed — we couldn't confirm you own kesefle.com"

**Fix:**
- Add the verification HTML file to the site (Google sends a URL like `googlexxxxx.html`)
- Or add Google's DNS TXT record to the `kesefle.com` DNS zone, then retry ownership verification
- Confirm the OAuth consent screen lists `kesefle.com` under Authorized domains

### "Scope justification is insufficient"

**Fix:**
- Resubmit with the more detailed scope-justifications.md
- Specifically emphasize that the app creates a fresh Sheet and uses only
  `drive.file`; it does not request `drive.readonly` or enumerate the user's Drive
- Provide code references to `api/sheet/provision.js` and `lib/sheet-writer.js`

### "Demo video doesn't show the OAuth consent screen clearly"

**Fix:**
- Re-record the video with the consent screen on display for 10+ seconds
- Zoom into the consent screen (1.5x browser zoom is fine)
- Use a screen-annotation tool to draw circles around the scope list

### "We can't find your privacy policy at the URL provided"

**Fix:**
- Double-check the URL works in incognito (https://kesefle.com/privacy)
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

## Architecture fallback (only if the current minimal flow is rejected)

The product already uses the minimal `drive.file` architecture and creates the
Sheet directly in the user's account. Do not re-add `drive.readonly`, a broad
`spreadsheets` grant, or a service-account ownership-transfer flow just to work
around a review question. First respond with the code evidence above.

### Last resort: use OAuth only for SSO, store data on our servers
- Drop Drive integration entirely
- Users log in with Google but data lives in our Postgres
- Pros: No sensitive scopes, verification trivial
- Cons: Users no longer own their data — defeats Kesefle's whole pitch

Don't use this path unless the product strategy deliberately changes.

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
