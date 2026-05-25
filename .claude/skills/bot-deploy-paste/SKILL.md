---
name: bot-deploy-paste
description: Reassemble bot/ExpenseBot_DEPLOY.gs from bot/ExpenseBot_FIXED.gs and produce the exact paste-instruction message to send Steven for an Apps Script deploy.
---

# Bot deploy (manual paste)

The bot is Apps Script — there's no CI deploy. We commit the reassembled `ExpenseBot_DEPLOY.gs`, then Steven copy-pastes it into the Apps Script editor. Get this right or the production bot silently runs an old version.

## Steps
1. Confirm `bot/ExpenseBot_FIXED.gs` parses: `node --check bot/ExpenseBot_FIXED.gs` (Apps Script ≈ ES5, but Node check catches gross syntax errors).
2. Reassemble (header from DEPLOY, body from FIXED):
   ```
   head -95 bot/ExpenseBot_DEPLOY.gs > /tmp/x.js && tail -n +21 bot/ExpenseBot_FIXED.gs >> /tmp/x.js && node --check /tmp/x.js && cp /tmp/x.js bot/ExpenseBot_DEPLOY.gs
   ```
3. Verify no duplicate top-level defs: `grep -c "^function doPost" bot/ExpenseBot_DEPLOY.gs` → `1`.
4. Run `node bot/test_classify.js && node bot/test_parser.js && node bot/test_isolation.js && node tests/full_qa.js`.
5. Commit DEPLOY.gs + FIXED.gs together.
6. Send Steven this exact line (no embellishment): **"Steven: re-paste `bot/ExpenseBot_DEPLOY.gs` into Apps Script → Deploy → New Version. Build: <KFL_BUILD_VERSION>."**

## Verification
- After paste, send a test WhatsApp from Steven's phone; bot replies with the new version when prompted (`גרסה` command, line ~6419).
- `/api/admin/bot-version` reflects new build within 24h.

## Common pitfalls
- Pasted FIXED.gs instead of DEPLOY.gs → missing config block, bot fails on startup.
- Asked Steven multiple times in one session → batch: one paste per logical group of changes.
- Forgot the version bump → heartbeat won't show new build, you'll waste time debugging "did it deploy".
