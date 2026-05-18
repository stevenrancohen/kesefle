# Connecting kesefle.com to Vercel — step-by-step

**Status**: DNS for kesefle.com is currently at Hostinger with A `@ → 2.57.91.91` (parking IP). The Kesefle web app is at `kesefle.vercel.app`. Goal: when someone types `kesefle.com` in their browser, they get the Kesefle app — without breaking the Gmail MX records we just set up.

**Time**: ~10 minutes of clicks + 5 minutes to a few hours DNS propagation.

**Risk**: Low. The only thing that can break is the (currently empty) parking page. Email is on separate MX records that we DON'T touch.

---

## Pre-flight checklist

Before you start, confirm these are in your Hostinger DNS records (you should see them right now):

| Type | Name | Content | Why |
|---|---|---|---|
| MX | @ | smtp.google.com (priority 1) | Gmail delivery — **DO NOT TOUCH** |
| TXT | @ | google-site-verification=gm5FnFA98Yz_85NdfW_FHYV54p88V0Fait5GwwWS5VY | Workspace domain ownership — **DO NOT TOUCH** |
| CNAME | www | kesefle.com | Currently bounces www to root — will replace |
| A | @ | 2.57.91.91 | Currently points root to parking — will replace |

After this guide, you'll add 2 new records and delete 1 (the A record). MX and TXT records stay untouched.

---

## Step 1 — Add kesefle.com to Vercel

1. Open https://vercel.com/dashboard
2. Click your **kesefle** project
3. Top tabs: click **Settings**
4. Left sidebar: click **Domains**
5. Top of the page, there's an "Add" input. Type `kesefle.com` and click **Add**
6. Vercel will say "kesefle.com is already in use" OR show you DNS instructions

You'll see one of these scenarios:

### Scenario A — Vercel says "DNS Required"
Vercel will display the exact records to add. Typically:
- `A` record `@` → `76.76.21.21`
- `CNAME` record `www` → `cname.vercel-dns.com`

This is the common case. Continue to Step 2.

### Scenario B — Vercel says "Add the following:" with different IPs
Vercel sometimes uses different IPs based on region. **Copy the exact values Vercel tells you** — don't use the values I listed unless they match.

### Scenario C — Vercel auto-configures nameservers
Less common with Hostinger but possible. If Vercel says "Point nameservers to ns1.vercel-dns.com, ns2.vercel-dns.com" — DO NOT do that. It would break your MX records. Skip this option and click "Use A/CNAME records instead."

---

## Step 2 — Update DNS in Hostinger

1. Open https://hpanel.hostinger.com/domain/kesefle.com/dns
2. In the records table, find the existing **A record** for `@` pointing to `2.57.91.91`
3. Click **Edit** on that row
4. Change "Points to" from `2.57.91.91` to the IP Vercel gave you (`76.76.21.21` in the common case)
5. Change TTL to `3600` (faster propagation)
6. Click **Save**

7. Now find the existing **CNAME record** for `www` pointing to `kesefle.com`
8. Click **Edit**
9. Change "Target" from `kesefle.com` to `cname.vercel-dns.com`
10. Save

### What your records should look like after Step 2

| Type | Name | Content | TTL |
|---|---|---|---|
| MX | @ | smtp.google.com | 3600 |
| TXT | @ | google-site-verification=... | 3600 |
| A | @ | **76.76.21.21** (CHANGED) | 3600 |
| CNAME | www | **cname.vercel-dns.com** (CHANGED) | 3600 |

---

## Step 3 — Wait for DNS propagation + Vercel verification

1. Back in Vercel → Settings → Domains
2. Wait ~30 seconds, then refresh the page
3. The `kesefle.com` entry should change from "Pending" / "Invalid DNS" to "Valid" with a green checkmark
4. If it doesn't update within 5 minutes, click the **"Refresh"** button next to the domain
5. Once Valid, Vercel automatically issues a free Let's Encrypt SSL cert (takes 30-60s)

You can verify externally:
```
dig A kesefle.com +short
```
Should return `76.76.21.21` (or whatever Vercel told you).

---

## Step 4 — Test in browser

1. Open https://kesefle.com in a fresh browser tab (NOT incognito — incognito sometimes uses different DNS)
2. You should see the **Kesefle web app** (the homepage with the WhatsApp mockup)
3. The browser address bar should show `kesefle.com` and a 🔒 SSL padlock

If you see the old parking page instead:
- Wait 10 more minutes for DNS propagation
- Try a different network (mobile data, friend's wifi)
- Run `dig A kesefle.com @8.8.8.8 +short` — if it returns `2.57.91.91` still, DNS hasn't propagated yet

---

## Step 5 — Set up auto-redirect www → root

By default, both `kesefle.com` and `www.kesefle.com` work. Most sites prefer one canonical version.

In Vercel → Settings → Domains:
1. Find `www.kesefle.com` in the list (if it shows up automatically) or add it manually
2. Click the `⋯` menu next to it
3. Select **"Redirect to kesefle.com"**

Now `https://www.kesefle.com` → 301 redirects to `https://kesefle.com`.

---

## Step 6 — Update internal references

The codebase currently links to `kesefle.vercel.app`. Several places need updating:

1. JSON-LD structured data in `index.html`
2. Open Graph URLs in meta tags
3. Sitemap (`sitemap.xml`)
4. RSS feed (`blog/feed.xml`)
5. Email templates in `/emails/`
6. CHANGELOG.md
7. Bot's outgoing reply text (if any mention the URL)

Quick way to find them all:
```bash
cd /Users/stevenrancohen/Documents/Claude/Projects/kesefle
grep -rn "kesefle.vercel.app" \
  --include="*.html" --include="*.js" --include="*.gs" \
  --include="*.md" --include="*.xml" \
  --exclude-dir=node_modules --exclude-dir=.git
```

Replace `https://kesefle.com` with `https://kesefle.com` everywhere except in deploy logs / changelog entries that reference the old URL historically.

After bulk find-and-replace, commit + push. Vercel auto-deploys.

---

## Step 7 — (Optional) Vercel custom redirects

If you want `kesefle.com/whatsapp` to redirect to the WhatsApp deep link `https://wa.me/17745448053?text=שלום!`, add to `vercel.json`:

```json
{
  "redirects": [
    { "source": "/whatsapp", "destination": "https://wa.me/17745448053?text=%D7%A9%D7%9C%D7%95%D7%9D%21", "permanent": false },
    { "source": "/bot", "destination": "https://wa.me/17745448053?text=%D7%A9%D7%9C%D7%95%D7%9D%21", "permanent": false }
  ]
}
```

This makes share-links like `kesefle.com/whatsapp` super clean to share verbally or on flyers.

---

## Troubleshooting

### kesefle.com shows "404 Not Found" on Vercel
The Vercel project is set to deploy a different folder. Settings → General → "Root Directory" should be empty or `/`. If it's something else, fix it.

### kesefle.com shows the old parking page after 24 hours
DNS didn't propagate. Possible causes:
- A record wasn't actually saved at Hostinger → re-check the Hostinger panel
- Multiple A records exist (some DNS providers allow duplicates) → delete any extras
- Your ISP's resolver caches longer than 24h → try 8.8.8.8 manually

### Email stopped working after the switchover
You accidentally deleted/edited the MX record. Re-add `MX @ priority 1 smtp.google.com TTL 3600`. Email should resume within minutes.

### SSL certificate not issued
Wait up to 60 minutes. Vercel uses Let's Encrypt which sometimes has queues. If still missing after an hour, in Vercel → Settings → Domains, click `⋯` → "Refresh Certificate".

### Vercel domain verification fails
Possible causes:
- A record points to wrong IP → re-check what Vercel told you
- Cloudflare proxy is on (not applicable for Hostinger, but worth knowing)
- AAAA record interfering → if a `AAAA` (IPv6) record exists for `@`, either remove it or update it to point at Vercel's IPv6 too (Vercel docs have the IPv6 address)

---

## What this unlocks

- **Public-facing domain**: business cards, email signatures, marketing all use `kesefle.com`
- **Brand consistency**: customers see "kesefle.com" not "vercel.app" 
- **SEO**: Google treats `kesefle.com` as canonical, less duplicate-content concerns
- **Trust**: real domain feels more legit than `*.vercel.app` to first-time visitors
- **Future flexibility**: if you ever move off Vercel, only DNS changes — nothing about the codebase moves

---

## What this does NOT change

- **Email** keeps working on info@kesefle.com (MX records untouched)
- **Workspace verification** keeps working (TXT record untouched)
- **The Vercel project itself** keeps deploying from GitHub like before
- **kesefle.vercel.app** still works (as a fallback URL — Vercel keeps the auto-domain alive)

---

## When to do this

**Do it after**:
- You've tested everything on kesefle.vercel.app
- You're ready to share kesefle.com as the "real" URL with first users
- You have 30 minutes to monitor DNS propagation

**Don't do it during**:
- A demo
- When you're tired (DNS bugs are subtle)
- Right before a high-traffic event (give DNS 24h to fully settle)

**The right moment**: a low-traffic time when you can babysit it for ~30 minutes and verify everything works.
