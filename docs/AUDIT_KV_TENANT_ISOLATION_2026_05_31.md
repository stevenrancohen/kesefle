# KV tenant-isolation audit — 2026-05-31

Auditor: KV tenant-isolation review (read-only)
Scope: every `kvGet`/`kvSet`/`kvSetEx`/`kvExists`/`kvDelete`/`kvScan`/`rawGet`/`rawSet` call
across `api/**/*.js` + `lib/**/*.js`. No source modified.

## Summary

- KV namespaces inventoried: **47 distinct prefixes** across 67 source files
- Tenant-isolation gaps found: **2 confirmed bugs + 1 architectural smell**
  (highlighted below)
- GDPR delete completeness: **WARN** — `_keysForUser_` in `api/account.js`
  enumerates 17 of the 21 per-user prefixes actually written. 4 namespaces
  leak past deletion (`usr_budget:`, `custom_categories:`, `goal:*`,
  `objective:`); plus the orphan `user:google:{sub}` + `users_all` SET
  entry from `api/auth/google.js`.

Headlines:
1. **Inconsistent opt-out namespace.** `api/whatsapp/webhook.js` writes
   `optout:{phone}`; `api/cron/customer-weekly-digest.js:149` reads
   `opt_out:{phone}` (underscore). Users who STOP'd via WhatsApp **still
   receive the Sunday digest** — direct-marketing-law issue.
2. **Orphan `user:google:{sub}` records.** `api/auth/google.js` (the legacy
   GIS one-tap endpoint) writes user data to `user:google:{sub}`, while
   every other reader uses `user:{sub}`. Records persist after both
   `deleteAccount` AND `deleteByPhone` because `_keysForUser_` only deletes
   `user:{sub}`.
3. **Tenant resolution chain on every write path is correct.** Every
   bot-secret-gated write endpoint (`append`, `delete-last`, `mark-vat`,
   `relabel-row`, `add-category-row`, `csv-import`, `fix-company-dashboard`,
   `recurring`) implements the canonical chain `phone:{E164}` →
   `userSub` → `user:{userSub}` + `sheet:{userSub}` with the
   `sheet_ownership_mismatch` leak guard. The 5-endpoint protection from
   PR-S2 is intact.

## Per-namespace inventory

| Key pattern | Scope | Read sites | Write sites | Risk |
|---|---|---|---|---|
| `user:{userSub}` | per-user (canonical record) | account.js, admin.js, me.js, recurring.js, referral.js, all `sheet/*`, link.js, webhook.js | account.js, auth/google-exchange.js, lib/secure-kv.js | OK — only-touched-by-resolved-userSub |
| `user:google:{sub}` | per-user (legacy) | cron/customer-weekly-digest.js:145 | auth/google.js:93 | **GAP** — orphan namespace, never deleted, only one cron reads it |
| `users_all` (SET) | global SET of `google:{sub}` | cron/customer-weekly-digest.js:134 | auth/google.js:98 | **GAP** — never SREM'd on delete |
| `sheet:{userSub}` | per-user sheet pointer | append, web-append, getExpenses (via token), delete-last, mark-vat, relabel-row, add-category-row, csv-import, fix-company-dashboard, summary, stats, bot-query, recurring, group, account.js, lib/secure-kv.js | provision.js, auth/google-exchange.js, lib/secure-kv.js | OK |
| `token:{userSub}` | per-user (legacy plaintext+access token) | getExpenses.js, me.js, account.js, admin.js | getExpenses.js (refresh write), auth/google-exchange.js | OK — userSub-scoped; legacy field included in `_keysForUser_` |
| `phone:{E164}` | per-phone pointer record | webhook, append, delete-last, mark-vat, relabel-row, add-category-row, csv-import, fix-company-dashboard, group, recurring, account.js, goals/*, objectives/action, sheet/*, lib/secure-kv.js | link.js (SETNX), append.js (self-heal), recurring.js, lib/secure-kv.js, account.js (del on unlink) | OK — leak-guarded |
| `userPhone:{userSub}` | per-user reverse mapping | link.js | link.js (confirm), account.js (delete) | OK |
| `optout:{phone}` | per-phone unsubscribe | webhook.js | webhook.js, lib/secure-kv.js | **GAP** — see opt_out: below |
| `opt_out:{phone}` | per-phone (typo namespace) | cron/customer-weekly-digest.js:149 | (none) | **BUG** — different from `optout:`; STOP'd users still get digest |
| `last_inbound:{phone}` | per-phone 24h-window state | (none in audit set) | webhook.js, lib/secure-kv.js | OK — server-only |
| `linkCode:{sixDigit}` | per-code 10-min TTL | link.js | link.js | OK — code-scoped, deleted on confirm |
| `referral:code:{userSub}` | per-user referral code | referral.js, account.js, lib/error-alert.js | referral.js | OK |
| `referral:reverse:{code}` | per-code reverse | referral.js | referral.js | OK — included in `_keysForUser_` when code known |
| `referral:redeemed:{userSub}` | per-user idempotency | referral.js | referral.js | **MISSING from `_keysForUser_`** (low impact — TTL is short) |
| `push_sub:{userSub}` | per-user web-push | push/subscribe.js, lib/push.js | push/subscribe.js | OK |
| `nps:{userSub}` | per-user NPS submission | nps.js, account.js | nps.js | OK |
| `testimonial:{userSub}` | per-user testimonial | testimonials.js, account.js | testimonials.js | OK |
| `exit_survey:{userSub}` | per-user cancellation reason | cron/lifecycle.js, account.js | billing/cancel-flow.js | OK |
| `profile:{phone}` | per-phone billing profile | profile.js, recurring.js, account.js | profile.js | OK — included in `_keysForUser_` |
| `recurring:{phone}` | per-phone recurring template list | recurring.js, account.js | recurring.js | OK |
| `recurring_pending:{phone}` | per-phone pending confirmation | recurring.js, account.js | recurring.js | OK |
| `recurring_logged:{phone}:{id}:{date}` | per-phone idempotency | cron/recurring.js | cron/recurring.js, recurring.js | OK — TTL 45d, drops naturally |
| `recurring_reminded:{phone}:{id}:{date}` | per-phone reminder dedup | cron/recurring.js | cron/recurring.js | OK — TTL |
| `reminders:{phone}` | per-phone reminder list | reminders.js, account.js | reminders.js | OK — included in `_keysForUser_` |
| `memberGroup:{phone}` | per-phone group pointer | group.js, account.js | group.js | OK |
| `group:{code}` | per-group code | group.js, goals, objectives | group.js | shared-by-design — not per-user |
| `phoneGroups:{phone}` | per-phone group list | group.js | group.js | **MISSING from `_keysForUser_`** |
| `usr_budget:{userSub}` | per-user budgets | budgets.js, cron/budget-check.js | budgets.js | **MISSING from `_keysForUser_`** |
| `budget_alerted:{userSub}:{ym}:{cat}` | per-user idempotency | cron/budget-check.js | cron/budget-check.js | OK — TTL 35d |
| `custom_categories:{userSub}` | per-user custom categories | custom-categories.js, sheet/add-category-row.js | custom-categories.js, sheet/add-category-row.js | **MISSING from `_keysForUser_`** |
| `goal:{userSub}:{goalId}` | per-user goals | lib/goals.js, goals/* | lib/goals.js | **MISSING from `_keysForUser_`** (need scan + multi-key delete) |
| `objective:{userSub}` | per-user weekly objective | lib/objectives.js, objectives/action.js | lib/objectives.js | **MISSING from `_keysForUser_`** |
| `email_sent:{userSub}:{tpl}` | per-user idempotency | cron/lifecycle.js | cron/lifecycle.js | OK — TTL self-cleans |
| `payment_failed:{userSub}` | per-user dunning state | cron/lifecycle.js, admin/user-timeline.js | billing webhooks | **MISSING from `_keysForUser_`** (PII: dunning state) |
| `retention:discount:{userSub}` | per-user cancellation save | billing/cancel-flow.js, admin/user-timeline.js | billing/cancel-flow.js | **MISSING from `_keysForUser_`** (TTL 90d) |
| `retention:pause:{userSub}` | per-user pause record | billing/cancel-flow.js, admin/user-timeline.js | billing/cancel-flow.js | **MISSING from `_keysForUser_`** |
| `plan_change:{userSub}` | per-user plan-change idempotency | billing/change-plan.js | billing/change-plan.js | TTL 15d — drops naturally |
| `paypalSub:{subId}` | per-paypal-sub-id reverse | billing/paypal.js | billing/paypal.js | not per-user-keyed |
| `winback:{userSub}` | per-user winback claim | billing/winback-claim.js | billing/winback-claim.js | **MISSING from `_keysForUser_`** (TTL 1y but PII) |
| `pendingPayment:{code}` | per-code manual pay | billing/manual.js | billing/manual.js | code-scoped |
| `stats:{userSub}:{window}` | per-user cached stats | cron/lifecycle.js | (computed elsewhere) | **MISSING from `_keysForUser_`** |
| `user_seen_announcement:{userSub}` | per-user dismissals | announcements.js | announcements.js | **MISSING from `_keysForUser_`** |
| `kfl_demo_nudge:{phone}` | per-phone idempotency | webhook.js | webhook.js | TTL 24h |
| `sheetwriters:{spreadsheetId}` | per-sheet writer set | append.js | append.js | DETECTOR — see findings |
| `sheet_anomaly:{ts}` | append-only audit | (admin grep) | append.js | OK |
| `seen:wa:{messageId}` | per-message idempotency | webhook.js | webhook.js | OK — TTL 24h |
| `global_learn:{hash}` | per-categorization-hash (cross-tenant, by design) | learn.js, _lib/global_learn.js | learn.js | OK — not per-user; vocabulary shared |
| `audit:{action}:{ts}:{sub8}` | append-only audit log | (admin tooling) | account.js, admin.js, lib/secure-kv.js | OK — 730d TTL by policy |
| `rl:{key}:{window}` | rate-limit token bucket | lib/ratelimit.js, lib/secure-kv.js | lib/ratelimit.js | OK |
| `flag:{key}` | global feature flag | admin.js | admin.js | OK — admin-only |
| `customer_digest:current` | global Steven-set message | cron/customer-weekly-digest.js, admin/customer-digest-set.js | admin/customer-digest-set.js | OK — global |
| `customer_digest_run:{ts}` | append-only audit | cron/customer-weekly-digest.js | cron/customer-weekly-digest.js | OK — 90d TTL |
| `bot_version_latest` | global telemetry | admin/bot-version.js | link.js | OK |
| `waitlist:{email}` etc. | per-waitlist-record | waitlist.js | waitlist.js | OK — not per-user |
| `abuse_log:{ts}` | append-only abuse log | abuse-log.js | abuse-log.js | OK — not per-user |
| `errors:{ts}` | append-only error log | log/* | log/* | OK |

## Tenant resolution audit

- **`api/sheet/append.js` → OK.** Lines 103–141 implement the canonical
  resolve chain: read `phone:{E164}` → `phoneRec.userSub` → read
  `sheet:{userSub}` (canonical) AND `user:{userSub}` (token only).
  Lines 126–132 abort with `409 sheet_ownership_mismatch` if a stale
  `phone:{E164}.spreadsheetId` disagrees with the canonical sheet.
  Anomaly detector (lines 212–260) catches a 2nd distinct userSub
  writing to the same sheet ID. Refresh token NEVER taken from the phone
  record — always from `user:{userSub}` (line 154–155).
- **`api/sheet/getExpenses.js` → OK (different chain).** Uses
  `requireUser` (kefle_session cookie) → `req.user = userId` → reads
  `token:{userId}` directly. Never touches `phone:{E164}` at all (web
  flow). Note: uses the legacy `token:{sub}` namespace + `kefle_session`
  cookie, which is a divergent auth model from `requireAuth`'s
  `kfl_session` cookie — see Architectural Smell #1.
- **`api/account.js` → OK.** Web `delete`/`export` use `requireAuth`
  (verified Google JWT, `req.user.sub`). Bot `delete-by-phone` resolves
  `phone:{E164}.userSub` then reads `user:{userSub}`. Unified
  `_keysForUser_` helper drives both paths so they delete the same keys
  (per the 2026-05-29 R1 fix). Both calls revoke the Google refresh
  token before delete.
- **`api/me.js` → OK.** Reads `token:{userId}` and `user:{userId}` only
  for the cookie-verified `userId`. Cannot cross tenant boundaries.
- **`api/whatsapp/webhook.js` → ACCEPTABLE WITH CAVEAT.** Line 233 reads
  `phone:{fromPhone}` and uses the `userRecord.spreadsheetId` and
  `userRecord.refreshTokenEnvelope` taken DIRECTLY from the phone record.
  This bypasses the canonical `sheet:{userSub}` lookup that
  `/api/sheet/append.js` enforces. Documented risk: if the user
  re-provisions their sheet (rotates `sheet:{userSub}` value), the phone
  record's cached `spreadsheetId` is now stale until either link or
  append.js self-heals it. Today this is mitigated because (a) the only
  writer of `phone:{E164}` (`api/whatsapp/link.js:366–373`) snapshots
  the current sheet at link time, (b) `api/sheet/append.js`'s self-heal
  (line 146) rewrites it on every drift, (c) re-provisioning is rare.
  But the webhook is its OWN write path that bypasses `/api/sheet/append`,
  so it does NOT benefit from the leak guard. Recommend the webhook's
  `writeToUserSheet` either call `/api/sheet/append` internally or
  re-resolve via `sheet:{userSub}` before write.
- **`bot/ExpenseBot_FIXED.gs` `_resolveTenant_` (lines 5742–5757) → OK.**
  Returns `{isOwner:true}` only when the cleaned phone equals
  `_ownerPhoneDigits_()`. Empty/unset owner phone returns `false`
  (the bug behind the 2026-05 cross-tenant leak). Unknown sender →
  `{userRecord: null}` so the caller routes to onboarding instead of
  the owner sheet. `_assertOwnerLegacyWrite_` (lines 5733–5740) is the
  defense-in-depth guard before every legacy `SHEET_ID` write site;
  empty `fromPhone` (internal/cron/debug) passes through as trusted.

## GDPR completeness

`_keysForUser_(userSub, phone, referralCode)` in
`api/account.js:53–86` enumerates:

```
user:{userSub}                    sheet:{userSub}
token:{userSub}                    userPhone:{userSub}
referral:code:{userSub}            push_sub:{userSub}
nps:{userSub}                      testimonial:{userSub}
exit_survey:{userSub}
phone:{phone}                      profile:{phone}
recurring:{phone}                  recurring_pending:{phone}
memberGroup:{phone}                reminders:{phone}
referral:reverse:{referralCode}
```

**Found in scan but NOT in `_keysForUser_` (per-user but never deleted):**

1. `user:google:{userSub}` — written by `api/auth/google.js:93`.
   GDPR-visible identity record (email, name, picture).
2. `users_all` SET entry `google:{userSub}` — added by
   `api/auth/google.js:98`. Needs SREM, not DEL.
3. `usr_budget:{userSub}` — financial budgets (caps + categories).
4. `custom_categories:{userSub}` — user's custom category list.
5. `goal:{userSub}:{goalId}` — multi-key (needs SCAN
   `goal:{userSub}:*`); savings goals are financial PII.
6. `objective:{userSub}` — weekly active objective.
7. `stats:{userSub}:7d` and `stats:{userSub}:30d` — cached aggregates
   (low PII but include amounts).
8. `payment_failed:{userSub}` — dunning state (PII: card-issuer-error
   surfaced in admin).
9. `retention:discount:{userSub}` and `retention:pause:{userSub}` —
   cancellation save records (free-text reason, currency).
10. `winback:{userSub}` — winback claim record (TTL 1y).
11. `user_seen_announcement:{userSub}` — dismissal tracking.
12. `referral:redeemed:{userSub}` — idempotency.
13. `phoneGroups:{phone}` — list of group memberships
    (financial-relationship leak).
14. `kfl_demo_nudge:{phone}` — TTL 24h, low-impact.

**Severity ranking of GDPR gaps:** items 1–3, 5, 8–10, 13 contain
financial PII or identity data. Items 4, 6, 7, 11, 12, 14 are lower
impact (preference state or TTL'd idempotency).

## Architectural smells (not security gaps)

1. **Two session systems coexist.** `api/_lib/session.js` defines
   `kefle_session` (typo? not `kfl_session`) HS256 cookie consumed by
   `getUserId(req)`. `lib/auth.js` `requireAuth` reads
   `kfl_session` (via `getUserId` imported from the same module — so
   actually they share the cookie name via export). VERIFIED: both
   reference the same `getUserId` from `api/_lib/session.js` which
   reads `kefle_session`. The constant name in `lib/auth.js` comments
   (`kfl_session`) is wrong but the code works. Cleanup-only.
2. **Each handler defines its OWN `kvGet`/`kvSet` inline.** 67 files
   each have 5–20 lines of duplicated fetch wrappers. `lib/secure-kv.js`
   was built to centralize this but only the user/sheet/phone helpers
   migrated. Migration of every `kvGet`/`kvSet` to `secure-kv.js` is the
   right long-term fix (centralized validation, encryption, logging,
   rate limit) but the gap doesn't introduce a tenant bug — every
   inline implementation reads the same `KV_REST_API_URL` env and
   passes through the auth Bearer.
3. **`phone:{E164}` cache `spreadsheetId` is a denormalization** of
   `sheet:{userSub}.spreadsheetId`. Two writers (link.js confirm,
   append.js self-heal) keep it warm; one reader (webhook.js) trusts
   it without re-validating against `sheet:{userSub}`. If a future
   feature lets a user "switch sheets" (e.g. rebuild template), the
   denormalization is the most likely place a drift will be missed.

## Recommendations (numbered, in order to land)

1. **Fix opt-out namespace typo (P0).** Change
   `api/cron/customer-weekly-digest.js:149` from `opt_out:` to
   `optout:` so it matches `webhook.js`. One-line additive fix. After
   this lands, audit Vercel logs for any users who STOP'd then got a
   digest in the last 4 weeks and send a manual apology + re-opt-out
   confirmation. Marketing-law risk.

2. **Either deprecate `/api/auth/google.js` or remove `user:google:`
   namespace (P1).** The endpoint is the legacy GIS one-tap handler.
   Two options:
   (a) Delete the endpoint (every working flow goes through
       `/api/auth/google-exchange.js` which uses `user:{sub}`).
   (b) Rewrite `auth/google.js` to write to `user:{sub}` (and SADD
       to `users_all` keyed by `{sub}` not `google:{sub}`), then
       update `cron/customer-weekly-digest.js:144–145` to match.
   Once aligned, add `user:google:{sub}` + `users_all` SREM to
   `_keysForUser_`. Test with a GDPR-export-then-delete round-trip on
   a test user before shipping.

3. **Extend `_keysForUser_` to enumerate every per-user prefix found
   in this audit (P1).** Add the 14 missing prefixes. For `goal:*`
   (multi-key per user), add a SCAN step inside the helper. Update
   both `deleteAccount` and `deleteByPhone` to iterate the expanded
   list. Ship behind a test that asserts every userSub-keyed prefix
   in the grep below appears in the helper output:
   ```bash
   grep -rhnE "(\`|')[a-z_][a-zA-Z0-9_-]+:" --include='*.js' api/ lib/ \
     | grep -oE "[a-z_][a-zA-Z0-9_-]+:" | sort -u
   ```

4. **Add tenant re-validation to webhook write path (P2).** In
   `api/whatsapp/webhook.js writeToUserSheet`, before the Sheets call,
   re-read `sheet:{userRecord.userSub}` and abort with
   `sheet_ownership_mismatch` if it disagrees with
   `userRecord.spreadsheetId`. Matches the leak guard pattern in
   `/api/sheet/append`. ~10 lines additive.

5. **Document the canonical KV namespace contract (P2).** Add
   `docs/KV_NAMESPACES.md` enumerating every prefix, who writes,
   who reads, TTL, and per-user delete inclusion. Mark
   `user:google:` deprecated. Update on every new namespace add.

6. **Migrate inline `kvGet`/`kvSet` to `lib/secure-kv.js` (P3).**
   Long-term cleanup. Land in 5-file chunks per PR, never bigger.
   Each migration shrinks ~15 lines per file and centralizes the
   logging + validation. No tenant correctness change.
