---
name: kesefle-llm-cost-guard
description: Cap LLM calls/cost per user per day with a counter and degrade to the keyword classifier when a sender is over budget, so a runaway or abusive user can't burn the AI-provider bill in bot/ExpenseBot_FIXED.gs.
---

# Cap LLM spend per user per day

The bot's AI fallback in `bot/ExpenseBot_FIXED.gs` is resolved at one choke point and
already degrades cleanly. A cost guard is a per-user daily counter that, once over
budget, makes the classifier behave AS IF no key were configured - keyword-only, no
LLM HTTP call - so an abusive or looping sender can't run up the provider bill.

Anchors (search by symbol, line numbers drift):
- `_aiProviderResolve_()` (~line 10771) - the choke point; returning `null` already
  routes to the deterministic 18k-keyword pipeline (`_fallbackCategorySet`).
- Classifier call site (~line 10948) - where the LLM is gated in.
- `_normalizeAiClassifyResult_` (~line 10884) - enforces the hard 0.6 ask-floor.
- Rate limiter (~line 1042) and `_userSheetUrl_` (~line 1340) - the existing
  `CacheService.getScriptCache()` + phone-cleaning patterns to mirror.
- `cronSynonymExpansion` (~line 18367) - already tallies a per-run `llmCalls` to copy.

## Steps
1. Add `_aiBudgetKey_(fromPhone)` returning
   `'aibudget:' + digits + ':' + Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd')`
   so the counter rolls at local midnight and is namespaced per sender (clean the
   phone with `String(x).replace(/[^0-9]/g,'')`, same as `_userSheetUrl_`).
2. Add `_aiBudgetOver_(fromPhone)`:
   - read the day's count from `CacheService.getScriptCache().get(key)` (volatile,
     same primitive as the message rate limiter);
   - compare to a cap from `_aiReadKey_('KFL_AI_DAILY_CALL_CAP')` with a sane default
     (e.g. 40);
   - fail OPEN - on any cache error return `false` so an outage never blocks a user.
3. Owner exemption: early-return `false` when `clean === _ownerPhoneDigits_()` so
   Steven's own number stays uncapped during testing.
4. Add `_aiBudgetBump_(fromPhone)`: increment and `put(key, n, 86400)` AFTER a real
   LLM call returns non-null. Count CALLS, not tokens - Apps Script can't see token
   counts pre-call; approximate shekels as calls x a configured per-call estimate if
   you must report a number.
5. Gate the LLM at the classifier choke point:
   `if (_aiBudgetOver_(fromPhone)) { /* skip _aiChatComplete_ */ }` and fall straight
   into the existing keyword path. Treat over-budget EXACTLY like
   `_aiProviderResolve_()` returning `null`.
6. PRESERVE the safety invariant: keyword-only degradation must still send
   low-confidence / `שונות` results to ASK the user (the 0.6 floor in
   `_normalizeAiClassifyResult_`), never silently write a financial row.
7. For a durable owner-facing daily total on the admin dashboard, additionally bump a
   `DocumentProperties` counter keyed by DAY only (`aispend:yyyyMMdd`) and prune old
   keys - never one property per user (see pitfalls).

## Verification
- `node bot/test_classify.js && node bot/test_ai_contract.js` - keyword path and the
  13-field contract still hold when the LLM is skipped (the offline harness already
  runs keyword-only, so over-budget behavior == current offline behavior).
- `npm run gauntlet` - full regression; group 6 secret scan confirms no key VALUE
  leaked into the new counter code.
- `node bot/bot-replay.js "850 שיווק"` - predicts a target with the LLM skipped,
  proving the over-budget path produces a valid keyword classification, not a drop.
- Manually: set `KFL_AI_DAILY_CALL_CAP=0` on a test deploy and confirm every message
  routes via keywords with no provider HTTP call in the execution log.

## Common pitfalls
- Failing CLOSED on a cache miss/error - if `_aiBudgetOver_` treats unknown as
  over-budget, one CacheService blip silently downgrades EVERY user and tanks
  accuracy. Always fail open.
- Counting before the call succeeds - bump only after `_aiChatComplete_` returns
  non-null, or provider 429s inflate the counter and lock the user out on errors they
  did not cause.
- Dropping the message when over budget - it MUST still classify via keywords (or ASK
  below 0.6), never return no reply.
- A per-user `DocumentProperties` key - that hits the ~50-property cap fast and
  corrupts unrelated bot config; key durable counters by DAY, not by user.
- Editing `ExpenseBot_FIXED.gs` and stopping - the bot ships by MANUAL paste of
  `bot/ExpenseBot_DEPLOY.gs`. Reassemble via `bot-deploy-paste`, bump
  `KFL_BUILD_VERSION`; agents never push the deploy.
