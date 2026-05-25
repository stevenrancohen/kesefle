---
name: bot-version-bump
description: When and how to bump KFL_BUILD_VERSION in the Apps Script bot so the daily heartbeat + admin dashboard reflect the deployed code.
---

# Bot version bump

`KFL_BUILD_VERSION` is the bot's self-reported build string. The daily heartbeat (`/api/admin/bot-version`) reads it; admin UI shows drift between this constant and Vercel's expectation. Bump on every paste-deploy.

## When to bump
- Any change to `bot/ExpenseBot_FIXED.gs` that ships to users.
- New keyword pack, new handler, parser fix, kill-switch tweak, OCR change.
- Skip ONLY for ASCII comment-only edits that won't trigger a paste.

## Steps
1. Open `bot/ExpenseBot_FIXED.gs`, find the `KFL_BUILD_VERSION` constant near the top (around line 57).
2. Update to format: `YYYY-MM-DD-<short-slug>` (e.g. `2026-05-26-receipt-ocr-fix`). Date = today's deploy date.
3. Reassemble `ExpenseBot_DEPLOY.gs` (see `bot-deploy-paste` skill).
4. Commit with message that includes the slug.
5. After Steven pastes, check admin dashboard `bot-version` widget within 24h.

## Verification
- `grep "KFL_BUILD_VERSION" bot/ExpenseBot_FIXED.gs bot/ExpenseBot_DEPLOY.gs` → both equal.
- After deploy + heartbeat fires, `GET /api/admin/bot-version` returns the new string.

## Common pitfalls
- Bumped in FIXED but forgot to reassemble DEPLOY → heartbeat still old.
- Used a date in the future / yesterday → makes "stale bot" alerts noisy.
- Spaces / Hebrew in the slug → keep it ASCII-kebab.
