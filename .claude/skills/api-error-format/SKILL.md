---
name: api-error-format
description: Standardize error response shape across api/* endpoints so the frontend, bot, and admin tooling can consume errors uniformly.
---

# Error response format

Every Kesefle API endpoint returns one of two shapes. Drift here turns into ad-hoc handling in 12 places on the frontend and bot. Keep it tight.

## Shape
```json
{ "ok": true, "...": "...payload..." }
{ "ok": false, "error": "snake_case_code", "message": "human-readable Hebrew or English" }
```

## Rules
1. HTTP status reflects the class: 200 ok, 400 client error, 401 unauth, 403 forbidden, 404 not found, 409 conflict, 429 rate limited, 500 server error.
2. `error` is a STABLE snake_case code — never change once shipped (frontend may switch on it). Add new codes; never repurpose.
3. `message` is human-readable. Hebrew for user-facing endpoints, English for admin/bot-bridge.
4. Never leak stack traces, env values, or full KV records in `message`.
5. For rate-limit responses, include `retryAfterSec` (number) in the body and set `Retry-After` header.
6. For validation errors, include `field` when applicable: `{ ok:false, error:'invalid_input', field:'amount', message:'...' }`.

## Existing codes (do not repurpose)
- `no_user_for_phone`, `refresh_token_decrypt_failed`, `no_sheet`, `unauthorized`, `forbidden`, `rate_limited`, `cron_only`, `bad_request`, `not_found`, `internal_error`.

## Verification
- `grep -rnE "res.json\(\{ ?ok: ?false" api/` — every error response uses the shape.
- Frontend / bot handlers can switch on `error` reliably (greppable).
- A new error code is added to `lib/error-alert.js` if it's an alertable failure.

## Common pitfalls
- Returning `{ error: 'something' }` without `ok: false` → frontend assumes success.
- Returning Hebrew error code values (the `error` field) → unparseable; keep that field ASCII snake_case.
- HTTP 200 with `ok: false` → some old code does this; new endpoints must use the correct status.
