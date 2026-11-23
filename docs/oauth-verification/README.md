# Google OAuth Verification Package

Steven, this folder has everything you need to submit Kesefle for Google OAuth verification — the step that removes the "100 test users" limitation and lets anyone in the world sign in.

## Why we need this

Kesefle requests the standard identity scopes (`openid`, `email`, `profile`)
plus one narrowly scoped Drive permission:
- `https://www.googleapis.com/auth/drive.file` — to create and use only the Sheet Kesefle creates for that user

The current signup flow does **not** request `drive.readonly` or the broad
`spreadsheets` scope. It creates a fresh spreadsheet, so it never needs to copy
or inspect an existing Drive file.

Google may require review before the app is available to everyone:
1. **Brand verification** — proves you own `kesefle.com`
2. **App verification** — proves your app actually does what it claims, no spying
3. **Scope justification** — explains why `drive.file` is necessary and minimal

Without verification, anyone outside your "test users" list gets blocked with "Access denied — app has not completed verification".

## Time to complete

- **Your time:** 60-90 minutes total (mostly recording the demo video)
- **Google's review time:** 1-4 weeks (typically 2 weeks for sensitive scopes)
- **Cost:** Free (no fees)

## Step-by-step

### 1. Brand verification (10 min)

Go to: https://console.cloud.google.com/apis/credentials/consent?project=191938738571

1. Make sure you're in the **Kesefle project** (project ID: vaulted-sol-496410-r1, project number: 191938738571)
2. Open the **OAuth consent screen** tab
3. Click **"Edit App"**
4. Fill in everything:
   - **App name:** Kesefle
   - **User support email:** srcslcollection@gmail.com
   - **App logo:** Upload a 120x120px PNG of your logo (the ₪ symbol with brand-green background — see logo.png in this folder)
   - **Application home page:** `https://kesefle.com/`
   - **Privacy policy:** `https://kesefle.com/privacy`
   - **Terms of service:** `https://kesefle.com/terms`
   - **Authorized domains:** add `kesefle.com`
   - **Developer contact info:** srcslcollection@gmail.com
5. **Save and continue**

### 2. Scope justification (10 min)

Same flow, next page is "Scopes".

For each scope shown by the console, paste the matching justification from
`scope-justifications.md`. The current code should show only:

| Scope | Justification |
|---|---|
| `drive.file` | "We create one Sheet in the user's Drive when they sign up, and read/write only that app-created Sheet to record the movements they submit." |
| `openid + email + profile` | "Standard OAuth — to identify the user and show their name/email in the app." |

If `drive.readonly` or a standalone `spreadsheets` scope appears, stop and check
the deployed OAuth request before submitting; those permissions are not part of
the current product contract.

### 3. Record the demo video (45-60 min)

This is the critical part. Google reviewers watch this to verify your app does what it claims.

**Format:** YouTube **Unlisted** video (not public, not private — only accessible via direct URL).
**Length:** 60-180 seconds
**No audio commentary required** (text overlays are fine)
**Content:** see `demo-video-storyboard.md` in this folder

**Quick recording tools (Mac):**
- Built-in: `Cmd+Shift+5` → "Record Selected Portion" → record your browser
- Better: [Loom](https://loom.com) (free, instant share link)
- Best: [ScreenStudio](https://www.screen.studio/) ($30, but unparalleled polish)

### 4. Submit (5 min)

Same OAuth consent screen page → click **"Publish app"** at the top.

Google asks you to:
1. Paste your YouTube Unlisted video URL
2. Confirm you've read and accepted Google's [API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
3. Confirm the scope classification shown by the console; do not claim
   `drive.readonly` or a broad `spreadsheets` permission
4. Submit

You'll get a confirmation email from `oauth-noreply@google.com`. Then wait.

### 5. Handling Google's follow-up questions

Google often asks for clarification 5-10 days into review. Their email will be specific:

- **"Show us how the Sheet is created"** → reply with screenshots of
  `api/sheet/provision.js` and `lib/sheet-writer.js`, where the app creates a
  fresh spreadsheet using the user's `drive.file` grant
- **"Why don't you use `drive.appdata` instead?"** → reply: "Because users want the spreadsheet visible in their main Drive, not hidden in an app folder they can't access."
- **"Show your privacy practices"** → link them to `/privacy` on the live site

Reply within 3 days or the case auto-closes and you have to restart.

## Files in this package

- `README.md` — this file
- `scope-justifications.md` — copy-paste-ready scope explanations
- `demo-video-storyboard.md` — frame-by-frame plan for the video
- `privacy-summary.md` — talking points if Google asks about data practices
- `denial-recovery.md` — what to do if Google rejects (rare but happens)

## After verification — what changes

| Before | After |
|---|---|
| 100 test users cap | Unlimited users |
| Manual test-user list per email | Anyone can sign up |
| "App not verified" warning shown | "Kesefle wants access" — no warning |
| Limited to dev environments | Production-ready |

You'll also see an **"Verified app"** badge in the OAuth consent screen, which builds user trust.

## Workaround during the 2-week wait

Set the app to "**In production**" anyway (you can do this even before verification completes). Users will see "Google hasn't verified this app" but can click **Advanced → Continue to Kesefle** to sign in. It's not pretty but it works.

Alternative: keep adding email addresses to the test-users list as you accept beta users (max 100 emails).

---

Steven — when you're ready, follow steps 1-4 above. Reply to me with the YouTube video URL once recorded and I'll prep the submission text for you.
