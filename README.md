# כסף'לה (Kesef'le)

> הכסף שלך, על אוטומט.
> Hebrew WhatsApp-bot expense tracker with Google Sheets backend.

## Stack (Phase 1 — current)

Static HTML + Tailwind CDN + vanilla JS + Vercel serverless functions.
**Why static:** the development network (Ono College) blocks `registry.npmjs.org`, so npm-based scaffolds (Next.js) can't be installed here. The HTML is hand-crafted to match the polish of a Next.js + shadcn build and migrates trivially when the network constraint clears.

## Stack (Phase 2 — when network clears)

Next.js 15 + Tailwind + shadcn/ui + Clerk + Supabase + Meta Cloud API + Paddle (per R&D recommendation).

## Files

- `index.html` — Landing page (hero, how-it-works, features, trust, pricing, signup, FAQ, footer).
- `api/waitlist.js` — Vercel serverless function for waitlist email collection. Stores to Vercel KV if `KV_REST_API_URL` / `KV_REST_API_TOKEN` env vars are set, else logs.
- `vercel.json` — Security headers + caching config.

## Local preview

Open `index.html` directly in a browser, or:

```bash
npx serve .       # (when npm registry is reachable)
# or
python3 -m http.server 3000
```

## Deploy to Vercel

The Vercel CLI is already installed globally. From the project dir:

```bash
vercel               # first deploy → prompts for project name, scope
vercel --prod        # subsequent prod deploys
```

To enable waitlist persistence: in Vercel dashboard, add a KV (Upstash Redis) integration, then redeploy. Env vars `KV_REST_API_URL` and `KV_REST_API_TOKEN` will be auto-injected.

## Brand

- **Name:** כסף'לה (Kesef'le) — "little money" with affectionate suffix; warm, Israeli-native.
- **Tagline:** הכסף שלך, בוואטסאפ. בלי אפליקציות, בלי טפסים.
- **Persona:** נועה לוי, 29, freelance graphic designer.
- **Pricing:** Free (≤30 expenses/mo) → Pro ₪19/mo or ₪180/yr.

## Roadmap

| Phase | Status | Scope |
|---|---|---|
| 1 — Landing page | ✅ done | Hero + features + pricing + FAQ + waitlist |
| 2 — Auth + sheet provisioning | next | Google OAuth → Drive API copies template sheet to user's Drive |
| 3 — WhatsApp multi-tenant | next | Meta Cloud API webhook → maps phone → user → sheet |
| 4 — Dashboard | next | "Your account" page: sheet link, WhatsApp connection, status |
| 5 — Billing | next | Paddle (global ILS) checkout |

## Notes

- The existing single-tenant prototype lives at Google Sheet `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` with an Apps Script bot — that's the validation case, not the product. Productization rebuilds the template from scratch.
