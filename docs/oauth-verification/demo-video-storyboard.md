# Demo Video Storyboard

90-second screen recording of the OAuth flow. Upload as **Unlisted** YouTube video.

## Setup before recording

- Use **Chrome incognito** so no cached sessions
- Set browser zoom to 110% (helps reviewers see clearly)
- Close every other tab so the recording is focused
- Recording resolution: 1080p minimum (1920x1080)
- Pick a TEST Google account that ISN'T `srcslcollection@gmail.com` (you want to show the OAuth screen "from scratch")

## Storyboard

### Frame 1 — Title (5 sec)
- Open a black browser tab
- Add a text overlay (any tool): "Kesefle OAuth Demo — kesefle.vercel.app"
- Sub-text: "Showing scope usage for verification"
- Hold for 5 seconds

### Frame 2 — Landing page (5 sec)
- Navigate to `https://kesefle.com/`
- Scroll slowly to show:
  - The hero (WhatsApp bot explanation)
  - The Trust section ("Why give a WhatsApp bot access to your money?")
- Don't click anything yet

### Frame 3 — Click "Start free" (3 sec)
- Click the green "התחל חינם" button in the nav (top right)
- The page scrolls to the signup section
- The signup section shows 3 buttons: Google, Facebook, Apple

### Frame 4 — Click Google (2 sec)
- Click "התחבר עם Google" (the white button with Google logo)
- The Google OAuth popup opens

### Frame 5 — Sign in (5 sec)
- Pick the test Google account
- If Google asks "Continue", click Continue

### Frame 6 — Consent screen (15 sec — CRITICAL)
- This is the screen Google reviewers care about most
- **PAUSE** here for 5 seconds with NO clicks — let them read everything
- The screen should show:
  - "Kesefle wants access to your Google Account"
  - 4 scopes listed:
    - See your name, email, profile picture
    - See, edit, create, and delete only the specific Google Drive files you use with this app (drive.file)
    - **View files in your Google Drive** (drive.readonly) ← Google specifically watches this
    - See, edit, create, and delete your spreadsheets in Google Drive
- Hover over each scope slowly — show that you understand what each one does
- **Then** click "Allow"

### Frame 7 — Account page loads (5 sec)
- Browser redirects to `https://kesefle.com/account`
- Page shows the 3-step onboarding:
  - ✅ Step 1: Google connected
  - ⏳ Step 2: Create your sheet
  - ⏳ Step 3: Link WhatsApp

### Frame 8 — Create the Sheet (10 sec — CRITICAL)
- Click "Create your sheet" (Step 2)
- Page shows loading state: "Copying template..." then "Creating spreadsheet..." then "Done"
- A new browser tab can open showing the user's NEW Sheet in their Drive

### Frame 9 — Show the Sheet (10 sec)
- Switch to the new Sheet tab
- Scroll through the 4 tabs (תנועות, הזמנות, מאזן אישי, מאזן חברה)
- This is the visual proof: a Sheet was created in the user's Drive, no other files touched

### Frame 10 — Back to account, link WhatsApp (10 sec)
- Switch back to /account tab
- Click on Step 3 ("Link WhatsApp number")
- Enter a phone number (use a real one you control)
- Click "Generate code"
- Show the 6-digit code displayed

### Frame 11 — Optional: show the WhatsApp message (15 sec)
- If you have time, switch to WhatsApp (web or screen mirror)
- Show sending "קוד 123456" to the Kesefle bot number
- Show the bot reply: "✅ הקישור הושלם!"

### Frame 12 — Privacy + Terms (5 sec)
- Back to browser
- Navigate to `https://kesefle.com/privacy` quickly
- Scroll to show the Drive data section
- Navigate to `https://kesefle.com/terms`
- Scroll to show the data handling section

### Frame 13 — Outro (3 sec)
- Show the homepage one more time
- Text overlay: "Kesefle — kesefle.vercel.app — Hebrew WhatsApp expense bot"

## Total: ~90 seconds

## Recording tips

- **Don't rush.** Reviewers watch at 1x speed and need to read.
- **No audio commentary needed.** Optional captions overlay if you want.
- **Show real interaction.** Don't fake clicks — actually navigate.
- **Don't censor anything.** Sensitive info? Use a test Gmail account, not your main.

## After recording

1. Upload to YouTube as **Unlisted** (NOT private, NOT public)
2. Copy the URL — it'll look like `https://youtu.be/abc123xyz`
3. Paste this URL into the OAuth verification submission form
4. Save the URL — Google may ask for it again in follow-up emails

## If you can't record

Hire someone on Fiverr ($25-50) — search "OAuth verification video" or "screencast demo". Send them this storyboard.

Alternative: I can use Chrome MCP to drive your browser and we record together one click at a time. Ask me to "start the video session" and I'll guide you.
