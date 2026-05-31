---
name: bot-deploy-verify
description: Verify the live Apps Script bot's KFL_BUILD_VERSION matches the repo HEAD via /api/admin/bot-version, and log a freshness check so a stale paste-deploy is caught fast.
---

# Verify the bot is actually deployed

The bot ships by manual paste into Apps Script. It is trivial for Steven (or me) to forget the paste step, push code, and assume prod has the change. `api/admin/bot-version.js` exists exactly for this — it compares the live bot's heartbeat (`KFL_BUILD_VERSION` posted on every `link?phone=` GET via the `x-kesefle-bot-version` header, stashed in KV `bot_version_latest`) against the literal in `bot/ExpenseBot_FIXED.gs`.

## Steps

1. Read the repo's current version:
   ```
   grep -E "^const KFL_BUILD_VERSION" bot/ExpenseBot_FIXED.gs | head -1
   ```
2. Hit the admin endpoint (Steven must be signed in as admin in the browser — the endpoint is `requireAdmin`):
   ```
   open "https://kesefle.com/api/admin/bot-version"
   ```
   Or curl with an admin session cookie. JSON returns `{ ok, deployed, repo, drift, last_seen_at, stale_minutes }`.
3. If `drift: true` → the deploy is stale. Run the `bot-deploy-paste` skill to reassemble `ExpenseBot_DEPLOY.gs` and send Steven the paste-instruction.
4. If `stale_minutes > 60` → the bot hasn't heartbeated in an hour. Check `/api/admin/launch-monitor` for errors, then nudge Steven to send any message to the bot to wake it.
5. Persist a verification log so future agents see the result:
   ```
   node -e "console.log(JSON.stringify({ts:new Date().toISOString(), action:'bot_deploy_verify', repo:'$(grep -E "^const KFL_BUILD_VERSION" bot/ExpenseBot_FIXED.gs | sed -E "s/.*'([^']+)'.*/\1/")'}))"
   ```

## Verification
- `drift: false` in the JSON response.
- `last_seen_at` is within the last 30 min.
- `repo` field matches the literal in `bot/ExpenseBot_FIXED.gs:62`.

## Common pitfalls
- Comparing the deployed version against the `ExpenseBot_DEPLOY.gs` literal — the source of truth is `ExpenseBot_FIXED.gs`. `DEPLOY.gs` is regenerated.
- Forgetting that `last_seen_at` only updates when a tenant message hits `/api/whatsapp/link?phone=` — owner-only flows don't trigger it.
- Trusting `drift: false` when the bot has been silent for hours — combine with `stale_minutes` check.

## Examples
- "Did my last bot push actually deploy?" → run this skill, report `drift` + `stale_minutes`.
- "After Steven re-pastes the bot, confirm it's live" → run this 60s after he confirms, expect `drift: false`.
