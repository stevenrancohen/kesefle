---
name: deploy-checklist
description: Steps to run before and after any deploy of Kesefle (website auto-deploys via Vercel on push; the bot is a manual Apps Script paste). Use to avoid shipping a broken build.
---

# Deploy checklist

## After EVERY batch (the one command — run this first)
```
npm run gauntlet        # === bash scripts/gauntlet.sh
```
This is the comprehensive regression gauntlet. Exit 0 = the batch broke
nothing; non-zero = it prints a per-group pass/fail summary pinpointing what
regressed. It orchestrates the FULL offline safety net (no secrets/network):
1. `node tests/full_qa.js` (the consolidated QA gate).
2. Every test suite — all `tests/test_*.js` + `tests/golden_set.js` +
   `tests/recurring_detect.js` + every `bot/test_*.js` (auto-discovered).
3. `node --check` on every committed `*.js` + both bot `*.gs` files.
4. Every inline `<script>` in every `*.html` parses as JS, and every
   `application/ld+json` block is valid JSON (structured-data / SEO guard).
5. `sitemap.xml` well-formed + every `<loc>` an `https://kesefle.com` URL.
6. Secret scan (no Meta/OpenAI/Anthropic/Google token shapes committed).

CI runs the exact same `npm run gauntlet` on every push/PR (`.github/workflows/ci.yml`),
so a green local run matches a green CI run. Do NOT re-run the individual
checks below by hand — the gauntlet already covers them; this is the single
gate after every batch.

## Website (Vercel — auto-deploys on push to main)
1. `npm run gauntlet` → exit 0 (covers full_qa, all `node --check`, all inline
   HTML scripts + JSON-LD, sitemap, secret scan — see above).
2. No secret in the diff (the gauntlet's group 6 scans committed files; also
   eyeball the diff per the pr-review skill).
3. Commit + push. Vercel builds automatically. Verify the live URL after ~1 min.

## Bot (Apps Script — MANUAL paste)
1. Edit `bot/ExpenseBot_FIXED.gs` only.
2. Reassemble:
   ```
   head -95 bot/ExpenseBot_DEPLOY.gs > /tmp/x.js && tail -n +21 bot/ExpenseBot_FIXED.gs >> /tmp/x.js && node --check /tmp/x.js && cp /tmp/x.js bot/ExpenseBot_DEPLOY.gs
   ```
3. Confirm no duplicate defs: `grep -c "function doPost" bot/ExpenseBot_DEPLOY.gs` → `1`.
4. `npm run gauntlet` → exit 0 (re-checks the reassembled `*.gs` + all bot tests).
5. Commit + push.
6. Tell Steven exactly: **"Steven: re-paste ExpenseBot_DEPLOY.gs → Deploy → New Version"** — batch bot changes; don't ask per-change.

## Env vars to keep set (Vercel)
KV_REST_API_URL, KV_REST_API_TOKEN, KESEFLE_BOT_SECRET, KESEFLE_TEMPLATE_SHEET_ID, GOOGLE_CLIENT_ID/SECRET, ADMIN_EMAILS. Bot Script Properties: KESEFLE_API_BASE, KESEFLE_BOT_SECRET, ANTHROPIC_API_KEY, GEMINI_API_KEY, SHEET_OWNER_PHONE.

## Document
Every commit message: note any new env var or manual step.
