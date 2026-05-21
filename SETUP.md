# SETUP — OAuth Client IDs

To make the social login buttons work in production, you need to create three OAuth apps and add their client IDs to Vercel as environment variables.

## 1. Google Sign-In

1. Go to **https://console.cloud.google.com** → create a new project (or reuse one).
2. Sidebar → **APIs & Services** → **OAuth consent screen**:
   - User type: **External**.
   - App name: `כספ'לה` (Kesef'le).
   - Support email + developer email: your email.
   - Authorized domains: `kesefle.vercel.app` (and your real domain when you have one).
   - Scopes: `email`, `profile`, `openid`.
3. Sidebar → **Credentials** → **Create Credentials** → **OAuth client ID**:
   - Type: **Web application**.
   - Authorized JavaScript origins:
     - `https://kesefle.com` (or your domain).
     - `http://localhost:3000` (for local testing).
   - Authorized redirect URIs (not strictly needed for GIS — leave blank if asked).
4. Copy the **Client ID** (`xxxxxx.apps.googleusercontent.com`).

**Add to Vercel:** Project → Settings → Environment Variables:
- `GOOGLE_CLIENT_ID` = (the client ID)

Then in `index.html`, the deploy script (or manual find-replace) substitutes `__GOOGLE_CLIENT_ID__` with the actual value. Or set up a build step (`vercel build`) that replaces it. For now, manually edit `index.html` after deploying.

---

## 2. Facebook Login (covers Instagram Business)

1. Go to **https://developers.facebook.com** → **My Apps** → **Create App**.
2. Use case: **Allow people to log in with their Facebook account**.
3. App name: `Kesefle`. Contact email: yours.
4. Once created, sidebar → **Use Cases** → **Authentication and account creation** → **Customize**:
   - Permissions: `email`, `public_profile`.
   - For Instagram Business access: add `instagram_basic` later.
5. Sidebar → **Settings** → **Basic**:
   - App Domains: `kesefle.vercel.app`.
   - Privacy Policy URL + Terms of Service URL: required for going live.
6. Sidebar → **Use Cases** → **Authentication** → **Settings**:
   - Valid OAuth Redirect URIs: not needed for JS SDK flow.
   - Allowed Domains for the JavaScript SDK: `kesefle.vercel.app`.
7. Copy the **App ID** (top of dashboard) and **App Secret** (Settings → Basic, reveal).

**Add to Vercel:**
- `FACEBOOK_APP_ID` = (the App ID — public, used in browser)
- `FACEBOOK_APP_SECRET` = (the secret — server-only)

While in **Development** mode, only admins/testers can log in. Submit for App Review to allow public users.

---

## 3. Apple Sign-In

Apple requires a paid Apple Developer Program account (~$99/yr). Skip this for v1 if budget is tight — Google + Facebook cover 95% of users.

If you proceed:

1. Sign in to **https://developer.apple.com/account** → **Certificates, IDs & Profiles**.
2. **Identifiers** → **+** → **App IDs** → **App** → continue:
   - Bundle ID: `com.kesefle.web` (reverse-domain).
   - Capabilities: enable **Sign In with Apple**.
3. **Identifiers** → **+** → **Services IDs** → continue:
   - Identifier: `com.kesefle.web.signin` (this is your `APPLE_CLIENT_ID`).
   - Enable **Sign In with Apple** → Configure:
     - Primary App ID: the one from step 2.
     - Domains: `kesefle.vercel.app`.
     - Return URLs: `https://kesefle.com/api/auth/apple/callback`.
4. **Keys** → **+** → enable **Sign In with Apple** → download the `.p8` key file. (You only get to download once — save it.)

**Add to Vercel:**
- `APPLE_CLIENT_ID` = (the Services ID, e.g. `com.kesefle.web.signin`)
- `APPLE_REDIRECT_URI` = `https://kesefle.com` (or your domain)

For server-side JWT generation (refresh tokens, etc.), you'll also need `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and the contents of the `.p8` file as `APPLE_PRIVATE_KEY`. That's only needed for refresh-token flows — the basic Sign In on the page works without it.

---

## 4. After setting env vars

1. In Vercel dashboard → Deployments → most recent → **Redeploy**.
2. Edit `index.html` and replace the placeholders:
   - `__GOOGLE_CLIENT_ID__` → actual value
   - `__FACEBOOK_APP_ID__` → actual value
   - `__APPLE_CLIENT_ID__` → actual value (or remove the Apple button if you skipped)
   - `__APPLE_REDIRECT_URI__` → `https://kesefle.com`
3. Commit + push (or `vercel --prod`).

A better long-term path: add a Vercel build hook that substitutes these from env vars during deploy. We'll do that in Phase 2 when migrating to Next.js (env vars are first-class there).

---

## 5. Testing locally

For local testing (`vercel dev` or `python3 -m http.server`):
- Add `http://localhost:3000` to all OAuth client allowed origins.
- Hand-edit `index.html` to put real values into `KESEFLE_CONFIG` temporarily.
- Don't commit those values — keep placeholders in the committed version.

---

## 6. Privacy + Terms pages

Both Google and Facebook require live URLs for these before allowing public sign-ups:
- `/privacy` → privacy policy.
- `/terms` → terms of service.

For Israeli compliance (`חוק הגנת הפרטיות`), get a templated policy from a lawyer or use a generic Israeli-compliant template. We'll add these as static pages in the next iteration.
