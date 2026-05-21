---
name: deploy-checklist
description: Steps to run before and after any deploy of Kesefle (website auto-deploys via Vercel on push; the bot is a manual Apps Script paste). Use to avoid shipping a broken build.
---

# Deploy checklist

## Website (Vercel — auto-deploys on push to main)
1. `node tests/full_qa.js` → all pass.
2. For each changed `api/*.js`: `node --check api/<file>.js`.
3. For each changed `*.html`: validate inline scripts parse:
   ```
   node -e "const fs=require('fs');const h=fs.readFileSync('PAGE.html','utf8');[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m,i)=>{try{new Function(m[1])}catch(e){console.log('block',i,e.message);process.exit(1)}});console.log('ok')"
   ```
4. No secret in the diff (see pr-review skill).
5. Commit + push. Vercel builds automatically. Verify the live URL after ~1 min.

## Bot (Apps Script — MANUAL paste)
1. Edit `bot/ExpenseBot_FIXED.gs` only.
2. Reassemble:
   ```
   head -95 bot/ExpenseBot_DEPLOY.gs > /tmp/x.js && tail -n +21 bot/ExpenseBot_FIXED.gs >> /tmp/x.js && node --check /tmp/x.js && cp /tmp/x.js bot/ExpenseBot_DEPLOY.gs
   ```
3. Confirm no duplicate defs: `grep -c "function doPost" bot/ExpenseBot_DEPLOY.gs` → `1`.
4. Run all bot tests + full_qa.
5. Commit + push.
6. Tell Steven exactly: **"Steven: re-paste ExpenseBot_DEPLOY.gs → Deploy → New Version"** — batch bot changes; don't ask per-change.

## Env vars to keep set (Vercel)
KV_REST_API_URL, KV_REST_API_TOKEN, KESEFLE_BOT_SECRET, KESEFLE_TEMPLATE_SHEET_ID, GOOGLE_CLIENT_ID/SECRET, ADMIN_EMAILS. Bot Script Properties: KESEFLE_API_BASE, KESEFLE_BOT_SECRET, ANTHROPIC_API_KEY, GEMINI_API_KEY, SHEET_OWNER_PHONE.

## Document
Every commit message: note any new env var or manual step.
