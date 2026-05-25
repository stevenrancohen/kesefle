# Tenant Isolation Model

The single most important invariant in Kesefle:

> **No phone can ever cause a write to a sheet that does not belong to that phone's owner.**

If this guarantee breaks, one user can see (or corrupt) another user's financial data. That's the company-ending risk.

## Identity chain

```
WhatsApp phone (E.164) ──► KV lookup ──► user:{sub} record ──► sheet:{sub} (canonical sheet id)
        │                                       │                         │
        │                                       └── stores refresh token  └── created via OAuth drive.file
        │                                                                     ONLY visible to that user
        └── verified against SHEET_OWNER_PHONE for the legacy owner path
```

Two paths into a sheet write:

### Path A — Legacy owner (Steven only)
- Trigger: `_isOwnerPhone_(fromPhone) === true`
- Target: hardcoded `SHEET_ID` (Steven's main sheet)
- All non-owner senders fall through to Path B; the legacy path **never** writes to the owner's sheet on behalf of another phone.

### Path B — Tenants
- Trigger: any phone that isn't Steven's
- Resolution: `_resolveTenant_(fromPhone)` → KV `phone:{phone}` → `user:{sub}` → `sheet:{sub}`
- Target: that user's own provisioned sheet
- Refresh token attached to `user:{sub}`, used to mint a short-lived Sheets API token per write.

## Defense-in-depth checks (current)

1. `_isOwnerPhone_` is the single source of truth for owner detection. Empty phone returns `false`.
2. `_assertOwnerLegacyWrite_` is a runtime guard called immediately before any legacy `SHEET_ID` write. It returns `false` (caller aborts) when the inbound sender doesn't match the configured owner.
3. `_resolveTenant_` no longer treats an unset `SHEET_OWNER_PHONE` as "everyone is owner" — that was the original cross-tenant leak and is now fixed.
4. `api/sheet/append.js` and `api/sheet/recurring.js` re-derive the sheet id from `user:{sub}` on every request — they never trust a sheet id passed in the request body.
5. Token refresh: the refresh token used to mint a Sheets API access token is attached to `user:{sub}`; if the phone↔sub mapping doesn't include the matching sub the request 403s.
6. Per-tenant API quota tracker (`lib/sheets-quota.js`) counts writes per `userSub`, not per IP, so a misrouted write would show up in the wrong user's quota — visible in `/admin/sheets-quota`.

## What `bot/test_isolation.js` verifies

Eighteen checks that all owner-only command routers are gated on `_isOwnerPhone_`:

```
✅ router gated: _handleSubscriptionCommand_
✅ router gated: _handleBudgetCommand_
✅ router gated: _handleLearningCommand_
✅ router gated: _handleCategoryCorrection_
✅ router gated: handleBotCommand_
✅ router gated: SRC_ROUTER_handle
✅ voice note-tail gated
✅ BOT_COMMANDS handleBotCommand_ self-guards owner
... (+10 more)
```

The test reads `bot/ExpenseBot_FIXED.gs` as source and asserts that each owner-only handler is preceded by an `_isOwnerPhone_` check in the same `doPost` switch arm. It runs in CI on every push.

## Kill switches (NEW, 2026-05-25)

For incidents — set either Script Property to `true` and the bot stops processing inbound messages on the next webhook delivery (no restart needed):

| Property                  | Effect                                            |
| ------------------------- | ------------------------------------------------- |
| `KFL_DISABLE_BOT_WRITES`  | Bot replies once per user per hour with a maintenance notice; performs zero sheet writes |
| `KFL_MAINTENANCE_MODE`    | Alias for the above                              |

Flip via: Apps Script → Project Settings → Script Properties → Edit. Effective within seconds.

## Outstanding work (documented, not blocking today)

- **Append-only sheet-write audit log.** Currently only the guards are tested; there is no per-user log of every (sheetId, rowCount, timestamp) write. Recommend `KV write_log:{userSub}:{YYYYMM}` zset with a 90-day retention.
- **20-phone simulation test.** `bot/test_isolation.js` covers the routing guards; a complementary test that spins up 20 mocked senders and asserts every write lands in the correct sheet would close the remaining loop. Open as #207 (suggested).
- **Multi-tenant multi-business.** The new `עסק N` routing is owner-only. Extending it to tenants requires the provisioner to support N>1 sheets per `userSub`. Tracked in #200.
