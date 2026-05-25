---
name: api-auth-pattern
description: Decide between requireAuth, requireAdmin, optionalAuth, or bot-secret on a new API endpoint — and which env vars must be present for each.
---

# API auth decision tree

`lib/auth.js` exports the three Google-ID-token middlewares. `lib/middleware.js` re-exports + composes. Bot-bridge endpoints use `KESEFLE_BOT_SECRET` instead. Pick wrong → either a security hole or a broken UX.

## Matrix
| Endpoint kind | Wrapper | Identity source |
|---|---|---|
| User reads own data (`/api/me`, `/api/sheet/summary`) | `requireAuth` | `req.user.sub` from Google ID token |
| User writes own data | `requireAuth` | `req.user.sub` |
| Admin (`/api/admin/*`) | `requireAdmin` | `req.user.email` ∈ `ADMIN_EMAILS` |
| Public read (waitlist, sitemap helper) | none / `optionalAuth` | possibly anonymous |
| Bot bridge (`/api/sheet/append`) | `botSecret` check via header/body | phone → `phone:{digits}` → `user:{sub}` |
| Cron (`/api/cron/*`) | check `req.headers['x-vercel-cron']` OR no auth (Vercel-only path) | n/a |
| WhatsApp webhook (`/api/whatsapp/webhook`) | per-provider HMAC verify | phone from payload |

## Steps
1. Look at the data: whose? The answer dictates the wrapper.
2. If user-scoped, ALWAYS resolve `sheet:{sub}` from `user:{sub}` — never trust a `sheet_id` in the request body.
3. If bot-secret: env `KESEFLE_BOT_SECRET` must be set. Endpoint returns 501 if missing — fail closed.
4. If admin: env `ADMIN_EMAILS` (comma-separated) must include the caller's email.
5. Composition example: `compose(withRequestId, withRateLimit({...}), requireAuth, handler)`.

## Verification
- Hit the endpoint without a token → 401.
- Hit with a non-admin token on an admin route → 403.
- Hit the bot endpoint without `botSecret` → 401.
- Hit a cron without the Vercel cron header in prod → blocked.

## Common pitfalls
- Using `optionalAuth` then writing to user data → if `req.user` is null, the write either fails opaquely or leaks. Use `requireAuth`.
- Accepting both `botSecret` AND user auth on the same endpoint — pick one path.
- Forgetting to check `ADMIN_EMAILS` is populated in production env.
