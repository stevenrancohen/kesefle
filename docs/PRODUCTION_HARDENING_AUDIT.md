# Production Hardening Audit — Baseline (2026-05-25)

Snapshot taken on branch `production-hardening-v1` at commit `024da7f` (main).
No code changed during the audit — this is the read-only baseline that subsequent fixes will be measured against.

## 1. Test results (all green)

| Suite                              | Result               |
| ---------------------------------- | -------------------- |
| `tests/full_qa.js`                 | ✅ 111/111 checks    |
| `tests/golden_set.js`              | ✅ 94.8% (147/155), threshold 93% |
| `tests/test_bank_parsers.js`       | ✅ 67/67 checks      |
| `tests/recurring_detect.js`        | ✅ 17/17 checks      |
| `bot/test_parser.js`               | ✅ 23/23 checks      |
| `bot/test_classify.js`             | ✅ 68/68 checks      |
| `bot/test_isolation.js`            | ✅ 18/18 checks      |
| `bot/test_botloop.js` (new)        | ✅ 24/24 checks      |

Golden-set misses are documented (not regressions): מעמ classified as עסק/מיסים instead of ממשלה ומיסים; children's schooling routed to חינוך וילדים/חינוך וטיפול instead of plain חינוך; one false-positive on צעצוע לילד. All sit above the 93% gate.

## 2. Endpoint surface

Counted 70 files under `api/`. Each is one Vercel serverless function.

### Public, unauthenticated (intentional)
- `api/health.js` — uptime probe
- `api/whatsapp/webhook.js` — Meta calls this; gated by HMAC signature verification
- `api/log/*` — beacon endpoints for funnel-event/user-report/bot-heartbeat; rate-limited by IP
- `api/config.js` — public bot phone number lookup
- `api/abuse-log.js` — bot writes here with `KESEFLE_BOT_SECRET`

### Authenticated user routes
Every route under `api/sheet/*`, `api/account.js`, `api/auth/*` requires either:
- A signed Google ID token (verified server-side), OR
- The bot secret + a normalized phone that resolves to a `user:{sub}` mapping

### Admin routes (`ADMIN_EMAILS` allowlist)
All 15 files under `api/admin/*` go through `requireAdmin`, which:
1. Verifies the Google ID token signature
2. Checks `payload.email` against `process.env.ADMIN_EMAILS` (comma-separated)
3. 401s otherwise

### Cron routes (`api/cron/*`)
6 files. Triggered by Vercel cron (configured in `vercel.json`). Vercel signs cron invocations with `x-vercel-cron`; routes verify before running.

## 3. Secrets inventory

Required environment variables (Vercel):

| Var                              | Purpose                              |
| -------------------------------- | ------------------------------------ |
| `KV_REST_API_URL`                | Upstash KV endpoint                  |
| `KV_REST_API_TOKEN`              | Upstash KV bearer token              |
| `KESEFLE_BOT_SECRET`             | Shared secret for bot ↔ API calls    |
| `KESEFLE_TEMPLATE_SHEET_ID`      | Master sheet to clone for new tenants |
| `GOOGLE_CLIENT_ID`/`_SECRET`     | OAuth credentials                    |
| `ADMIN_EMAILS`                   | Comma-separated admin allowlist      |
| `META_APP_SECRET`                | Webhook HMAC verification            |

Apps Script Script Properties:

| Property                  | Purpose                              |
| ------------------------- | ------------------------------------ |
| `KESEFLE_API_BASE`        | https://kesefle.com                  |
| `KESEFLE_BOT_SECRET`      | Same shared secret as Vercel         |
| `ANTHROPIC_API_KEY`       | Claude API for the LLM tier          |
| `GEMINI_API_KEY`          | Gemini for fast classification       |
| `SHEET_OWNER_PHONE`       | Steven's owner phone                 |
| `WHATSAPP_TOKEN`          | Meta permanent token                 |
| `WHATSAPP_PHONE_NUMBER_ID`| Meta phone-number id                 |
| `KFL_DISABLE_BOT_WRITES`  | (NEW) kill switch — set to `true` to halt processing |
| `KFL_MAINTENANCE_MODE`    | (NEW) alias of the above             |

Grep across the tracked tree did not surface any embedded secret values; everything reads from env / Script Properties.

## 4. Where user data lives

| Surface                  | What                          | Tenant scope |
| ------------------------ | ----------------------------- | ------------ |
| Upstash KV               | phone↔user mapping, sessions, learned rules, lightweight state | namespaced by phone or sub |
| Google Sheets (per user) | תנועות, מאזן חברה, מאזן אישי, הזמנות | one sheet per user, owned by the user |
| Vercel function logs     | request ids, error stacks      | retained per Vercel plan |
| WhatsApp Cloud API       | message ids only               | not persisted by us |

The product positioning is "you own your data" — the Sheet is the source of truth. KV is just routing + state.

## 5. Where WhatsApp messages enter

Two ingress paths:

1. **Meta webhook** → Vercel `api/whatsapp/webhook.js` → forwarded to the Apps Script bot endpoint. Verifies HMAC and de-dupes by message id.
2. **Apps Script `doPost`** → directly receives WhatsApp Cloud API events on the legacy endpoint Steven configured first. Same HMAC + dedup logic, plus the new bot-loop guards.

After today's changes the Apps Script path runs in this order:
1. `_verifyMetaWebhook_` HMAC check
2. Message-id idempotency (`seenmsg:` cache, 10 min)
3. Blacklist check
4. Spam pattern check
5. **NEW** Bot-loop guard (`_shouldMuteBotLoop_`)
6. **NEW** Per-phone reply cap (`_checkReplyCap_`, 20/60s)
7. **NEW** Global kill switch (`_killSwitchActive_`)
8. Owner-only command routers (each individually gated)
9. Tenant context router → `_routeExpenseByContext_`
10. Multi-business router (`עסק N ...`) → `_writeBusinessNExpense_`
11. Standard `processExpense`

## 6. Where sheet writes happen

Owner writes (Steven only — protected by `_isOwnerPhone_`):
- `bot/ExpenseBot_FIXED.gs` lines 1754, 2200, 5943, 6714, 8223, 12395

Tenant writes (every other phone):
- `api/sheet/append.js` → `lib/sheet-writer.js`#appendRowToUserSheet
- `api/sheet/recurring.js` (cron-triggered)
- `api/sheet/provision.js` (new sheet creation, OAuth-scoped)

All tenant paths derive the target sheet id from `user:{sub}` after looking up the phone → sub mapping. `bot/test_isolation.js` enforces that the owner-only router functions self-guard.

## 7. Where billing state lives

| Layer            | Storage                                  |
| ---------------- | ---------------------------------------- |
| Subscription     | KV `sub:{userSub}`                       |
| Payment events   | KV `pay:event:{ts}` (append-only log)    |
| Entitlements     | Derived from sub via `computeEntitlement` |
| Invoice records  | Green Invoice external API (record id stored in KV) |
| Failed payments  | `dunning:{userSub}:{stage}` keys         |

## 8. Gaps for follow-up (call-outs, not fixes today)

1. **No structured logging** beyond `console.log` in Vercel; correlation IDs exist (`reqId`) but aren't streamed to a SIEM. Ship `lib/log.js` already centralizes; would benefit from a sink.
2. **No per-tenant sheet write audit log.** Tenant isolation tests prove the *guards* exist, but there is no append-only log of every (userSub, sheetId, rowCount) write.
3. **No Postgres mirror.** Single source of truth = Google Sheets per user. A dual-write to a managed DB would unlock SQL reporting and disaster recovery; documented in `docs/DEPLOY_1000_USERS_PLAN.md`.
4. **OAuth scopes.** `drive.file` is the user-data scope today (good). No `drive.readonly` requested.
5. **No staging environment.** Pushes to `main` deploy directly to `kesefle.com` via Vercel. Recommend adding a `staging` branch + preview deployments for any PR.

These are tracked separately and intentionally NOT addressed in this PR.
