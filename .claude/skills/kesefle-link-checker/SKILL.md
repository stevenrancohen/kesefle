---
name: kesefle-link-checker
description: Verify every "open sheet" link in the codebase points to the correct tenant sheet via the tenant resolution chain — no hardcoded owner-sheet IDs leaking to other users, no /api/sheet/* endpoint resolving the wrong sheet.
---

# kesefle-link-checker

When invoked: scan the codebase for sheet links + verify resolution path.

## Scope
- HTML pages: `public/**/*.html`
- Frontend JS: `public/**/*.js`
- API endpoints: `api/sheet/*.js`, `api/admin/*.js`
- Bot: `bot/ExpenseBot_FIXED.gs`
- Emails: `templates/email/**`

## Checks
1. Grep for hardcoded 44-char Drive IDs — every one must be approved (template ID, fallback owner, or test fixture). Mask + list.
2. Every "open sheet" anchor must build URL from `user:{sub}.sheetId` resolved server-side, never from client-side state alone.
3. `/api/sheet/append`, `/api/sheet/recurring`, `/api/sheet/recent-rows`, `/api/sheet/delete-last` — all must call `_resolveTenant_` (or equivalent) and verify phone ↔ canonical sheet match before write.
4. Bot `/גיליון` command — must return the OWNER's sheet only, not any other user's
5. Admin dashboard sheet links — must check `requireAdmin` and use the admin-context sheet ID

## Outputs
- Markdown report `link-check-{YYYY-MM-DD}.md`
- Table: File | Line | Type (anchor / API / bot) | Resolution path | Tenant-safe (Y/N) | Risk

## Pass criteria
- 0 hardcoded user-sheet IDs (template is OK, fallback is OK if owner-gated)
- All Sheets write APIs use tenant resolution
- Bot owner-only commands gated by `_isOwnerPhone_`

## Hard NO
- No writes
- No live link clicks (this is static analysis)
