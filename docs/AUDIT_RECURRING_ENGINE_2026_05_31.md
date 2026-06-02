# Recurring expense engine audit — 2026-05-31

Scope: lifecycle map + failure modes of Kesefle's recurring expense engine
(personal templates + installments). Audit-only, no source changes.

Files audited:
- `api/recurring.js` (REST CRUD + cron handler, 449 lines)
- `api/cron/recurring.js` (Vercel-cron self-fetch wrapper)
- `bot/ExpenseBot_FIXED.gs` (Hebrew command surface + installments parser
  `_detectInstallments_` + bot-side `cronRecurringExpenses` trigger)
- `api/account.js` `_keysForUser_` (GDPR delete coverage)
- `tests/recurring_detect.js` (only covers PROACTIVE detector, not parser/cron)
- `vercel.json` (cron schedule)

## Summary

| Risk                                   | Status | Notes                                                                     |
| -------------------------------------- | :----: | ------------------------------------------------------------------------- |
| Idempotency (per template,date)        |   OK   | `recurring_logged:{phone}:{id}:{date}` TTL 45d                            |
| Race safety (concurrent invocations)   |  WARN  | TOCTOU between `kvExists` and `kvSetTTL` in `logOccurrence`              |
| Time-zone correctness                  |   OK   | `todayIsrael()` uses `Asia/Jerusalem`, month-end clamp present            |
| Installments parser robustness         |  FAIL  | 6 / 12 phrasings tested — Hebrew `\b` bug breaks Pattern B                |
| Pending-state hijack                   |   OK   | `confirmDue` only writes after pending exists; namespaced from install    |
| GDPR delete                            |  WARN  | `recurring:` + `recurring_pending:` covered, dedup keys NOT purged        |
| **Bugs found: 8** (3 high, 3 medium, 2 low)                                                                                |

---

## Lifecycle map

```
create → daily-fire → (autoLog=true ? auto-write : reminder) → confirm → write → end
   |                       |                                       |          |
   v                       v                                       v          v
addTemplate              cronRun                                confirmDue  kvSetTTL
(bot:_recurringAdd_     (Vercel + AppsScript                   ("אשר")    recurring_logged
 _setupInstallments)     dual triggers, see [F1])                          (45d TTL)
```

End: no explicit "end" — templates live forever; pause/resume via toggle.
There is no `endDate` field even for installments (see F7).

---

## Findings

### F1 — HIGH — Dual cron triggers (Vercel + Apps Script) doubling load

`api/cron/recurring.js` runs daily at `5 6 * * *` UTC (vercel.json),
`cronRecurringExpenses()` in `bot/ExpenseBot_FIXED.gs:5485` runs daily at
08:00 Israel time via Apps Script trigger. Both POST `action=cron` to the
same endpoint. The idempotency key prevents double-WRITE in practice, but:
- Two scans of every user run every day
- Two WhatsApp notifications per successful log are NOT idempotent
  (the WhatsApp send at `api/recurring.js:376` is unguarded — if the
  Apps Script cron writes the row, then the Vercel cron also tries
  (kvExists short-circuits the write but DOES NOT short-circuit the
  send) — actually it does short-circuit, since `kvExists → skipped`
  returns before `sendWhatsApp`. OK on writes; just wasted compute)
- TOCTOU race becomes likely (see F2)

**Recommendation**: keep ONE cron. The Vercel cron is the canonical
path; remove `cronRecurringExpenses()` from the bot's daily trigger
install, or change the trigger to a manual recovery-only function.

### F2 — HIGH — TOCTOU race in `logOccurrence` (api/recurring.js:200-222)

```js
const idemKey = `recurring_logged:${phone}:${tpl.id}:${dateStr}`;
if (await kvExists(idemKey)) return { skipped: true };
// ... resolveTenantWriteRecord, buildExpenseRow, appendRowToUserSheet (slow ~500ms)
await kvSetTTL(idemKey, '1', LOGGED_TTL_SEC);
```

Two concurrent invocations both pass `kvExists` (key not yet set) →
both call `appendRowToUserSheet` → user sheet gets the SAME row twice.
Probability rises with F1 (two daily crons).

**Recommendation**: use SETNX (set-if-not-exists, EX TTL) as a lock
BEFORE the Sheets write. Upstash REST supports `SET key value NX EX N`.
If SETNX fails, treat as `skipped`. This is the same fix pattern used
elsewhere in the codebase (e.g. `_groupAPI_('markrecurringfired')` uses
server-side persistence to avoid client-side TOCTOU per the comment at
`ExpenseBot_FIXED.gs:3480`).

### F3 — HIGH — Installments parser breaks on common Hebrew phrasings

`bot/ExpenseBot_FIXED.gs:6111` Pattern B uses `\b`:

```js
m = t.match(/(?:ב[\-\s]?)?(\d{1,3})\s*תשלומים?\b/);
```

JS `\b` is ASCII-only — Hebrew letters never produce a word boundary on
their right edge. The bot's OWN comment at `_parseRecurringCommand_`
(line 3981) acknowledges this: "JS `\b` word boundaries do NOT work
around Hebrew letters". The detector was apparently authored without
that knowledge.

Replicated `_detectInstallments_` and tested 12 realistic phrasings
(the canonical example from the task description included):

| Input                                | Expected     | Got    |
| ------------------------------------ | ------------ | ------ |
| `ספה 1000 שקל 5 תשלומים`             | 5 × 200      | **null** |
| `ב-12 תשלומים`                       | 12 × 1000    | **null** |
| `קניתי לפטופ ב-24 תשלומים`           | 24 × 200     | **null** |
| `ארנונה ב 6 תשלומים`                 | 6 × 200      | **null** |
| `רהיט 3000 ש"ח, 10 תשלומים`          | 10 × 300     | **null** |
| `12 תשלום של 500`                    | 12 × 500     | **null** |
| `10 תשלומים של 1000`                 | 10 × 1000    | OK     |
| `5 payments of 200`                  | 5 × 200      | OK     |
| `split into 6 payments of 500`       | 6 × 500      | OK     |

Pattern B passes 0 / 6 Hebrew cases. Pattern A passes only "N תשלומים של Y"
(no preceding `ב-`). **The headline example in the product copy
(`ספה 1000 שקל 5 תשלומים`) does not work.**

**Recommendation**: replace `\b` with `(?=\s|$|[^א-ת])` lookahead, AND
add `replace_all`-style flag so the match isn't sensitive to which
position it lands on. Add `tests/installments_parser.js` covering the
12 cases above.

### F4 — MEDIUM — Installments setup posts wrong `freq` shape (silent 400)

`bot/ExpenseBot_FIXED.gs:6167`:

```js
payload: JSON.stringify({
  action: 'add',
  ...
  freq: 'monthly',      // ← string
  ...
})
```

But `api/recurring.js:232-235` rejects with `invalid_freq` when
`typeof body.freq !== 'object'`:

```js
const freq = body.freq && typeof body.freq === 'object' ? body.freq : null;
if (!freq || !['monthly', 'months', 'weekly', 'days'].includes(freq.type)) {
  return res.status(400).json({ ok: false, error: 'invalid_freq' });
}
```

So every installments setup gets a 400 response. The bot then shows a
fake error: "לא הצלחתי לרשום את תשלומי הקבע…". (Discovered via static
trace; would be confirmed if F3 ever let users get this far.) Combined
with F3, the entire installments feature appears to be DOA on the API
boundary.

**Recommendation**: change to `freq: { type: 'monthly', day: parseInt(startISO.slice(8,10),10) }`
so the `freq.day` lines up with the user-picked first-charge day.

### F5 — MEDIUM — `freq.day` / `freq.n` / `freq.dow` field-level validation missing

`addTemplate` validates `freq.type` only. Then `matchesFreq` clamps
`Math.min(Number(f.day) || 1, daysInMonth(...))` — so `freq.day` can be
`-1`, `NaN`, `"<script>"`, `null` — all coerce safely. But these
unsanitized values are persisted to KV (`recurring:{phone}` list) and
re-rendered in `_recurringList_` ("כל undefined לחודש" or worse if
WhatsApp ever parses formatted text). Not a security bug, but a
data-quality and admin-debug hazard.

**Recommendation**: in `addTemplate` (and `updateTemplate`), coerce
`freq.day` to `1..31`, `freq.n` to `1..36`, `freq.dow` to `0..6`,
reject NaN. Same for the installments helper.

### F6 — MEDIUM — `kvScan('recurring:*')` capped at 500 keys

`api/recurring.js:76-92` `kvScan` loops 40 times with COUNT 100, but
caps the accumulated key list at 500 (`while ... && keys.length < max`).
Once Kesefle has >500 users with active recurring templates, the daily
cron silently stops scanning the rest. No log, no metric.

**Recommendation**: either raise the cap with an explicit metric +
admin alert when `keys.length === max` (suggesting overflow), or
process the cron in pages. Today's user count is low enough to be
unaffected, but it's a load-bearing limit with no alert.

### F7 — LOW — No installments end / completion logic

`_setupInstallmentsRecurring_` (bot:6147) calls `/api/recurring add` with
`installments: { total: inst.count, remaining: inst.count, productName }`,
but `addTemplate` (api/recurring.js:225) IGNORES the `installments` field
entirely — it's not in the persisted template shape. So the daily cron has
no idea this template is supposed to stop after N charges; it'll write
forever. The bot's local CacheService `installments:{phone}` (30d TTL)
decrements `remaining`, but the API never decrements anything and the
cron never reads it. After ~30 days the local cache evicts and the user
can't "see" the plan anymore — but the recurring template keeps firing.

**Recommendation**: persist `installments.{total, remaining}` on the
template; in `logOccurrence`, on success, decrement `remaining` and
auto-toggle `status='paused'` when it hits 0. Add a "תשלום אחרון!"
notification.

### F8 — LOW — GDPR delete leaves dedup + reminder keys

`api/account.js:53` `_keysForUser_` includes `recurring:{phone}` and
`recurring_pending:{phone}` but NOT:
- `recurring_logged:{phone}:*` (TTL 45d, idempotency keys)
- `recurring_reminded:{phone}:*` (TTL 45d)

If a user deletes their account and re-registers on the same phone within
45 days with a NEW Google sheet, OLD dedup keys block re-logging today's
expense. Low impact (auto-expires), but inconsistent with the audit
trail's claim of "complete deletion".

**Recommendation**: in `_keysForUser_`, additionally `kvScan` the two
patterns and append. Or push a TODO + reduce TTL to 7d (cron only looks
3 days back anyway).

---

## Other observations (not flagged as bugs)

- Cron uses `KESEFLE_CRON_SECRET` with `constantTimeEqual` — secrets
  posture is correct (distinct from bot secret, so a bot-secret leak
  cannot trigger mass writes). Good.
- `withRateLimit({ key: 'recurring', limit: 60, windowSec: 60 })` is
  applied BEFORE the cron-action branch. Cron call shares its outbound
  IP with all other Vercel→Vercel self-fetch crons. At current scale OK,
  but if the cron ever needs to make multiple sub-calls per minute,
  it'll self-throttle.
- `sheet_ownership_mismatch` is logged loudly inside the cron — good
  forensic posture (api/recurring.js:381-383).
- `_parseRecurringCommand_` for user-typed `קבוע ...` commands DOES handle
  Hebrew word-boundaries correctly (line 3981 comment) — only the
  installments detector has the regression.
- Confirmation flow (`confirmDue`) doesn't validate that `pending.dateStr`
  is still due (could be a stale pending from a paused template). Minor;
  the worst case is one extra row.

---

## Recommendations (numbered, safe PRs)

1. **PR-RECUR-1**: Fix `_detectInstallments_` Pattern B Hebrew word
   boundary — replace `\b` with `(?=\s|$|[^א-ת])`. Add 12-case test
   suite. Tests F3 directly. **HIGH**
2. **PR-RECUR-2**: Fix `_setupInstallmentsRecurring_` to send
   `freq: { type: 'monthly', day: parseInt(startISO.slice(8,10), 10) }`
   instead of `freq: 'monthly'`. Tests F4. **HIGH**
3. **PR-RECUR-3**: Persist `installments` on the template and stop the
   stream when `remaining` hits 0; emit "תשלום אחרון" notification.
   Add `endDate` as a more general construct. Fixes F7. **MEDIUM**
4. **PR-RECUR-4**: Replace `kvExists` + `kvSetTTL` in `logOccurrence`
   with a SETNX-EX lock-before-write. Fixes F2 race. **HIGH**
5. **PR-RECUR-5**: Remove `cronRecurringExpenses` Apps Script trigger
   (or convert to manual-only). Keep Vercel cron as the single source.
   Fixes F1. **HIGH**
6. **PR-RECUR-6**: Strict-coerce `freq.day` (1..31), `freq.n` (1..36),
   `freq.dow` (0..6) in `addTemplate` + `updateTemplate`. Fixes F5.
   **MEDIUM**
7. **PR-RECUR-7**: Add `recurring_logged:*` + `recurring_reminded:*`
   to GDPR purge in `_keysForUser_`. Fixes F8. **LOW**
8. **PR-RECUR-8**: Add `kvScan` overflow metric + admin alert when the
   500-key cap is hit. Fixes F6. **LOW**

Ship 1, 2, 4 first — they are tight unit-test-coverable fixes for
user-facing bugs.

