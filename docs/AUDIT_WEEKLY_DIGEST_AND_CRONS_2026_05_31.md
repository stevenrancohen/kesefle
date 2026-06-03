# Weekly digest + cron health — 2026-05-31

## Summary
- WEEKLY_DIGEST.gs: OK (syntax valid, new sheet ID, no writes, PII-redacted)
- vercel.json crons: 9 entries (8 unique paths + 1 query-param variant), 0 orphans, 0 dead-paths
- PII compliance: mostly OK; 2 medium findings (raw `userSub` in JSON log payloads in lifecycle.js + budget-check.js; hardcoded STEVEN_PHONE in steven-daily-digest.js)
- Bugs found: 0 critical, 0 high, 2 medium (PII), 2 low (config hygiene)

## Findings

### WEEKLY_DIGEST.gs

**Syntax.** `node -e "new Function(require('fs').readFileSync(...))"` exits 0. Parses cleanly.

**Sheet ID.** Line 39 declares `WD_SHEET_ID = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A'` (NEW). The OLD ID `1UKrXDk...` appears only inside the inline comment on line 33 explaining the historical bug. Both call sites use the variable, not a literal:
- Line 127: `_sendWeeklyDigestToPhone_(phone, WD_SHEET_ID)`
- Line 428: `_WD_getRows_(WD_SHEET_ID)` (in `TEST_WEEKLY_DIGEST_RENDER`)
Verdict: clean.

**PII / Logger.log redaction.** All four phone-bearing log lines wrap the value with `_WD_phoneTail_(phone)` (defined lines 110-112, returns `'...' + last4`):
- Line 130 `'Digest ' + _WD_phoneTail_(phone) + ': ' + JSON.stringify(res)` — note: `res` includes `replyText` containing the Hebrew message body. That message contains aggregated totals but no PII (no phone, no email). OK.
- Line 133 (exception path) — redacted.
- Line 457 (`TEST_WEEKLY_DIGEST_RENDER`) — redacted.
The remaining `Logger.log` calls (lines 83, 97, 120, 269, 305) carry no phone/email/sheet-id data.

**Trigger setup.** `INSTALL_WEEKLY_DIGEST_TRIGGER` exists (line 74), uses `ScriptApp.newTrigger(WD_TRIGGER_HANDLER).timeBased().onWeekDay(SUNDAY).atHour(8).inTimezone('Asia/Jerusalem')`. Idempotent — calls `UNINSTALL_WEEKLY_DIGEST_TRIGGER` first. `RUN_WEEKLY_DIGEST_NOW()` provides a manual fire path. OK.

**Read-only invariant.** Grep for `setValue|setFormula|deleteRow|clearContents|appendRow|setValues|removeRow|deleteRange` returned no matches. The only sheet API surface used is `SpreadsheetApp.openById(...).getSheetByName(...).getRange(...).getValues()` (line 285-291). The `מאזן חברה` tab is never named — only `תנועות` (line 40 `WD_TX_SHEET`). Rows 12/14 are not touched. OK.

**Hebrew encoding.** `file` reports `Unicode text, UTF-8 text`. Hebrew strings (e.g. `'🌅 בוקר טוב!'`, `'🟢 הכנסה: '`, `'מאוזן'`) are proper UTF-8 literals, not `\uXXXX`-escaped. Apps Script editor handles UTF-8 source cleanly — this is fine for direct editor paste but acceptable since the file is checked into git as UTF-8.

**Logic.**
- Main run path: `_WEEKLY_DIGEST_HANDLER_` reads `SUBSCRIBERS` Script Property (JSON array of phones), iterates each, calls `_sendWeeklyDigestToPhone_(phone, WD_SHEET_ID)`. Single shared `WD_SHEET_ID` means every subscriber's digest sums Steven's `1rtiPQs1...` sheet. This is the documented owner-only behavior (comments lines 36-38); if any non-Steven phone is added to `SUBSCRIBERS`, they'd receive Steven's data — cross-tenant leak risk **if SUBSCRIBERS contains any phone other than Steven's**. (Medium — see Recommendations.)
- Digest computes last-7d income/expense totals, vs prev-7d delta, top category, and a 2× spike detector against the prior 4-week per-category weekly average. Reads only `תנועות`; never `מאזן חברה`; never any year tab.
- Opt-out: `optout:<phone>` Script Property short-circuits delivery (line 274-278).

**Dependencies external to this file** (declared in header comment): `sendWhatsAppReply`, `_formatShekel`, `_dateRangeFilter`, `_groupByCategory`. Confirmed present in `bot/BOT_COMMANDS.gs` lines 431, 455, 509, 547. OK.

### Vercel crons

All 8 cron file paths in vercel.json resolve to files under `api/cron/`. No orphans, no dead paths.

| Path | Schedule | UTC → IL | File | Auth check |
|---|---|---|---|---|
| /api/cron/kv-backup | `0 3 * * *` | 03:00 → 06:00 | kv-backup.js | CRON_SECRET (constantTimeEqual) |
| /api/cron/reminders | `0 6 * * *` | 06:00 → 09:00 | reminders.js | CRON_SECRET → delegates to /api/reminders with KESEFLE_CRON_SECRET |
| /api/cron/recurring | `5 6 * * *` | 06:05 → 09:05 | recurring.js | CRON_SECRET → delegates to /api/recurring with KESEFLE_CRON_SECRET |
| /api/cron/lifecycle | `0 7 * * *` | 07:00 → 10:00 | lifecycle.js | CRON_SECRET |
| /api/cron/budget-check | `0 8 * * *` | 08:00 → 11:00 | budget-check.js | CRON_SECRET |
| /api/cron/kv-monitor | `0 * * * *` | hourly | kv-monitor.js | CRON_SECRET |
| /api/cron/steven-daily-digest | `0 6 * * *` | 06:00 → 09:00 | steven-daily-digest.js | CRON_SECRET OR `?admin=<KESEFLE_BOT_SECRET>` |
| /api/cron/steven-daily-digest?afternoon=1 | `0 14 * * *` | 14:00 → 17:00 | (same) | (same) |
| /api/cron/customer-weekly-digest | `0 7 * * 0` | Sun 07:00 → Sun 10:00 | customer-weekly-digest.js | CRON_SECRET OR `?admin=<KESEFLE_BOT_SECRET>` |

All schedules are valid 5-field cron. The 09:00 IL slot has 2 crons firing simultaneously (`reminders` + `steven-daily-digest`); `recurring` fires 5 minutes later. Not a problem (different code paths) but worth noting if Vercel concurrency limits ever bite.

Note: `steven-daily-digest` is listed twice in the `crons` array (once bare, once with `?afternoon=1`). Vercel treats them as distinct schedules — confirmed both work because the handler reads `req.query.afternoon`. OK.

### PII review

`grep -nE "Logger\.log.*\b(phone|email|sheetId|spreadsheetId|userSub)\b" bot/WEEKLY_DIGEST.gs api/cron/*.js`
returns only 4 hits in WEEKLY_DIGEST.gs, all wrapped in `_WD_phoneTail_`. Apps Script side is clean.

`grep -nE "log\.(info|warn|error|debug).*\b(phone|userSub|email|spreadsheetId)\b" api/cron/*.js` returns 8 hits, all in `userSub` shape:

**budget-check.js** (5 hits, all `userSub`):
- Lines 223, 231, 239, 244, 285 — `log.warn(..., { reqId, userSub, error })`

**lifecycle.js** (3 hits, all `userSub`):
- Lines 263, 312, 320 — `log.warn(..., { userSub, error })`

`userSub` is the Google OAuth `sub` claim — a stable opaque string that uniquely identifies a Google account. In isolation it doesn't reveal email or name, but it is stable across sessions and lets anyone with KV access correlate logs to a specific user record. Best practice: log a short hash (`userSub.slice(0,8)` or sha256 prefix) instead. **Medium severity**, not blocking.

No `phoneE164`, `email`, `refreshToken`, or `spreadsheetId` values appear in log payloads. Encrypted refresh-token envelopes are decrypted to `accessToken`s for sheet reads and never logged.

**Digest content (the WhatsApp message body Steven receives) is owner-only.** WEEKLY_DIGEST.gs sums only `WD_SHEET_ID`, which is Steven's `1rtiPQs1...` sheet. It does NOT iterate other tenants' sheets. Confirmed.

**steven-daily-digest.js**: hardcoded `STEVEN_PHONE = '972547760643'` (line 15). Functional but should be a Script env var (e.g. `STEVEN_ADMIN_PHONE`) for portability and to keep the literal out of source. **Low severity**.

**customer-weekly-digest.js**: never logs the phone or message body (audit log records only `messageHash: messageRec.body.slice(0,40)`). Hash is the first 40 chars of the message — should be a real hash (e.g. sha256 prefix), not a content prefix, to avoid leaking message content into the audit log. **Low severity**.

### Hebrew encoding

WEEKLY_DIGEST.gs uses raw UTF-8 Hebrew literals throughout the renderer (`_WD_renderDigest_`, `_WD_hebrewMonth_`, `_WD_rangeLabel_`). File reports UTF-8 cleanly. No bidi marks, no RLM/LRM contamination. OK.

The same UTF-8 pattern is used in `api/cron/steven-daily-digest.js` and `api/cron/customer-weekly-digest.js`. The bucket regex in steven-daily-digest line 22-32 mixes Hebrew + English keywords — works because Apps Script reads source as UTF-8.

## Recommendations

Numbered list of safe PRs (no required ordering, each is independent):

1. **(Medium PII)** Hash `userSub` before logging in `api/cron/lifecycle.js` (lines 263, 312, 320) and `api/cron/budget-check.js` (lines 223, 231, 239, 244, 285). Add a `lib/log.js` helper like `subHash(userSub)` returning first 8 chars of sha256, and replace `userSub` with `sub: subHash(userSub)` in log payloads. ~12 line PR.

2. **(Low config)** Replace `STEVEN_PHONE = '972547760643'` constant in `api/cron/steven-daily-digest.js` with `process.env.STEVEN_ADMIN_PHONE` (with the literal as a documented fallback or remove entirely once env is set). Doc-update for Vercel env. ~5 line PR.

3. **(Low PII)** In `api/cron/customer-weekly-digest.js`, change `messageHash: messageRec.body.slice(0,40)` to a real sha256 prefix using `crypto.createHash('sha256').update(messageRec.body).digest('hex').slice(0,16)`. Audit log loses the content peek but gains a stable identifier without leaking message text. ~3 line PR.

4. **(Medium cross-tenant safety)** Add an assertion at the top of `_sendWeeklyDigestToPhone_` in `bot/WEEKLY_DIGEST.gs` that the resolved phone is Steven's, OR document explicitly that `SUBSCRIBERS` Script Property must contain only Steven's phone until per-tenant sheet resolution is built (the TODO on line 20 already flags this). Defensive constant: `var WD_OWNER_PHONES = ['972547760643']; if (WD_OWNER_PHONES.indexOf(phoneStr) === -1) return { sent: false, reason: 'not_owner_phone' };` Removes the cross-tenant leak class entirely until the multi-tenant TODO is done. ~6 line PR.

5. **(Optional polish)** Document the 09:00 IL cron triple-fire (`reminders`, `steven-daily-digest`, `recurring` 5 min later) in `docs/AUTOMATIONS_PLAN.md` so future Vercel cron additions know which minute slots are taken.

## Files touched in this audit

- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/WEEKLY_DIGEST.gs` (read-only review)
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/vercel.json` (read-only review)
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/api/cron/*.js` (read-only review of all 8 files)
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/BOT_COMMANDS.gs` (cross-ref for helper presence)
