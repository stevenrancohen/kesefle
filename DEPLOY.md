# DEPLOY — כספ'לה

## Quickest path (Vercel — recommended)

The Vercel CLI is already installed globally. From this directory:

```bash
cd /Users/stevenrancohen/Documents/Claude/Projects/kesefle
vercel
```

First run prompts:
1. **Set up and deploy?** → Y
2. **Which scope?** → pick your account
3. **Link to existing project?** → N (first time)
4. **Project name?** → `kesefle` (or whatever)
5. **Directory?** → `./` (current)
6. **Override settings?** → N

Wait ~30s. You get a `https://kesefle-<hash>.vercel.app` URL. Visit it.

For production deploys later:

```bash
vercel --prod
```

When you buy a domain (e.g. `kesefle.app`, `kesefle.co.il`), add it via the Vercel dashboard → Project → Settings → Domains. SSL is automatic.

## Enable waitlist persistence (optional but recommended)

Without this, signup emails get console-logged on Vercel and lost on next deploy.

In Vercel dashboard → your project → **Storage** → **Create** → **KV** (Upstash Redis). Follow the prompts. Vercel auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` env vars.

Trigger a redeploy:

```bash
vercel --prod
```

To view collected emails:

```bash
# in Vercel dashboard → Storage → KV → Data Browser
# or via CLI later when you set up the redis client
```

## Domain (when ready)

Where to buy (Israeli market):
- **Israeli `.co.il`** — `domain.co.il` via DomainTheNet (cheapest, ILS billing).
- **Global `.com` / `.app` / `.io`** — Namecheap, Porkbun, Cloudflare Registrar (cheapest at-cost).
- **Israeli `.org.il` / `.net.il`** — same as `.co.il` registrar.

Suggested checks for `kesefle.*`:
- `kesefle.app` (Google's TLD — auto-HTTPS enforced, looks startup-modern)
- `kesefle.co.il` (Israeli credibility)
- `kesefle.io` (tech-modern)
- `kesefle.com` (universal)

After purchase, point DNS to Vercel:
- Add an `A` record `@ → 76.76.21.21` (Vercel's anycast IP), or
- `CNAME www → cname.vercel-dns.com`

Vercel will auto-issue SSL via Let's Encrypt within a minute.

## Test locally before deploy

```bash
# any of these work (whichever your network/setup permits):
python3 -m http.server 3000        # static only, no /api/
# or open index.html directly in the browser
```

Note: `/api/waitlist` only works on Vercel (or with `vercel dev` locally, which needs npm to be reachable).

## What needs npm to be reachable (Phase 2 work)

When the dev network unblocks `registry.npmjs.org` (off Ono College network, or whitelist it):

```bash
# Migrate to Next.js
npx create-next-app@latest kesefle-next --typescript --tailwind --app --no-src-dir --import-alias "@/*"

# Add Clerk for Google OAuth
npm i @clerk/nextjs

# Add Supabase for waitlist persistence + future user data
npm i @supabase/supabase-js

# Add shadcn/ui for polished components
npx shadcn@latest init
```

The static `index.html` and `/api/waitlist.js` we have right now ports trivially — the marketing copy, design tokens, and structure all carry over.
