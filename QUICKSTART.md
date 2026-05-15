# QUICKSTART — Run Kesef'le locally + deploy

## Fix: `zsh: command not found: vercel`

The Vercel CLI is installed but its bin isn't in your `$PATH`. One-time fix:

```bash
echo 'export PATH="$PATH:/Users/stevenrancohen/.npm-global/bin"' >> ~/.zshrc
source ~/.zshrc
vercel --version
```

You should see something like `Vercel CLI 53.x.x`.

Now from the kesefle directory:

```bash
cd /Users/stevenrancohen/Documents/Claude/Projects/kesefle
vercel
```

## Even faster: deploy without `vercel` CLI

Since the repo is now on GitHub (https://github.com/stevenrancohen/kesefle), you can deploy via the web:

1. Go to https://vercel.com/new
2. Click **Import Git Repository**.
3. Find `kesefle` in your list → **Import**.
4. Framework Preset: **Other** (it'll auto-detect static + serverless).
5. Click **Deploy**.

Within ~30 seconds, you get a URL like `kesefle-stevenrancohen.vercel.app`. The repo will redeploy automatically on every push to `main`.

## After first deploy

Add OAuth Client IDs:
- Vercel dashboard → Project → **Settings** → **Environment Variables**.
- Add: `GOOGLE_CLIENT_ID`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `APPLE_CLIENT_ID`, `APPLE_REDIRECT_URI`.
- See `SETUP.md` for how to create each.

Add waitlist storage:
- Vercel dashboard → **Storage** → **Create** → **KV**.
- Env vars get auto-injected.

Redeploy → buttons work.

## Local preview without npm

```bash
cd /Users/stevenrancohen/Documents/Claude/Projects/kesefle
python3 -m http.server 8080
open http://localhost:8080
```

The page renders fully; the OAuth flows will say "client ID not configured" since env vars aren't local (intentionally — don't commit them). The waitlist form falls back to localStorage.

## When you leave Ono College network (or get npm unblocked)

```bash
cd /Users/stevenrancohen/Documents/Claude/Projects/kesefle
npx create-next-app@latest kesefle-next --typescript --tailwind --app --no-src-dir
# … then migrate components from index.html.
```

See `DEPLOY.md` for the full Phase 2 plan.
