---
name: kesefle-multi-llm-fallback
description: Use when adding, reordering, or extending the bot's tiered LLM provider fallback (Claude/Gemini/OpenAI/xAI/OpenRouter) - env-keyed, fail-soft to the keyword pipeline, referenced by KEY NAME only, never secret value.
---

# Extend the tiered LLM provider fallback

The bot already has a provider-agnostic LLM ladder in `bot/ExpenseBot_FIXED.gs`: `_AI_PROVIDER_PRIORITY_` (the ordered list, ~line 10589), `_aiReadKey_(name)` (~10599), `_aiProviderResolve_()` (~10615), and `_aiChatComplete_(provider, key, systemPrompt, userMsg)` (~10632). Keys live ONLY in Apps Script Script Properties (the GAS analogue of env vars); the resolver picks the first configured provider and the dispatch degrades to `null` on any failure so the bot keeps running on its deterministic keyword/cache pipeline. There is also a separate Gemini concierge path (`_geminiGenerate_` ~5382, `_botConcierge_` ~5462) keyed on `GEMINI_API_KEY` / `GEMINI_MODEL`, and `ANTHROPIC_API_KEY` powers receipt OCR (`_handleReceiptImage_` ~11297). Extend the EXISTING ladder; do not invent a parallel system.

## Steps
1. Read the current ladder before changing it:
   `grep -n "_AI_PROVIDER_PRIORITY_\|_aiReadKey_\|_aiProviderResolve_\|_aiChatComplete_" bot/ExpenseBot_FIXED.gs`
   - Today the order is `OPENAI -> GEMINI -> XAI -> ANTHROPIC -> OPENROUTER`.
   - To prefer Claude first, reorder the entries in the `_AI_PROVIDER_PRIORITY_` array - do NOT hardcode a provider anywhere else.
2. To ADD a provider:
   - Append `{ provider: '<name>', key: '<NAME>_API_KEY' }` to `_AI_PROVIDER_PRIORITY_`.
   - Add a matching branch in `_aiChatComplete_`.
   - Reuse the OpenAI-compatible branch (shared by `openai`/`xai`/`openrouter`) when the new API speaks the chat-completions schema; only `gemini` and `anthropic` need bespoke request/response shapes.
3. Read keys ONLY via `_aiReadKey_(name)` - Script Property first, `process.env[name]` fallback for the Node test harness, never throws.
   - Model overrides use the same helper: `_aiReadKey_('<NAME>_MODEL')` with a safe default literal.
   - Examples already in the file: xAI defaults to `grok-3-mini`; Gemini walks `gemini-2.0-flash` -> `gemini-1.5-flash` -> `gemini-2.5-flash` -> `gemini-flash-latest`.
   - Never read a key with an inline `PropertiesService...getProperty` in a new branch.
4. Keep every branch fail-soft so a provider outage never throws or blocks a WhatsApp reply:
   - `muteHttpExceptions: true` on the `UrlFetchApp.fetch`.
   - Check `getResponseCode() !== 200` and bail.
   - `Logger.log` the provider + status only - NEVER the key, NEVER the auth header.
   - `return null`; the caller treats `null` as "LLM unavailable" and uses its own fallback.
5. Hold the output contract and anti-leak guards.
   - The shared dispatch returns plain text; the caller parses JSON out of it.
   - Preserve the `_botConcierge_` guards: strip ```json fences, whitelist `action` to `summary|help|examples|orders|chat`, and emit the Hebrew `SAFE_FALLBACK` on parse-fail.
   - This stops a new model that wraps or hallucinates output from leaking raw blobs to users.
6. Surface readiness without leaking secrets.
   - The `בדיקה` self-check (~line 8853) reports key PRESENCE (`קיים`/`חסר`) and a live-call OK/fail via `_KFL_GEMINI_LAST_ERR`.
   - If you add a tier, extend that probe to show presence only - a boolean, never the value.
   - Add the new key NAME to the allow-set near line 16873 (`'ANTHROPIC_API_KEY': 1, 'GEMINI_API_KEY': 1, ...`).
7. Reassemble + ship per `bot-deploy-paste`, then bump `KFL_BUILD_VERSION` (`bot-version-bump`).
   - Tell Steven WHICH Script Property NAME to add (Apps Script -> Project Settings -> Script Properties); the value is his to paste, you never see or echo it.

## Verification
- `node tests/full_qa.js` includes the AI-provider contract test (the `process.env` key path); it must stay green with zero keys set (proves graceful skip) AND with a dummy `process.env.<NAME>_API_KEY` set (proves the new branch resolves). `node bot/test_classify.js && node tests/golden_set.js` confirm the deterministic pipeline is untouched.
- After paste, Steven sends `בדיקה` from 972547760643: the reply shows the key as `קיים` and the live connection as `עובד`, or the `_KFL_GEMINI_LAST_ERR`-style reason on failure - without exposing the key.
- `grep -nE "sk-|AIza|key *= *['\"][A-Za-z0-9]" bot/ExpenseBot_FIXED.gs` returns nothing - no literal key ever committed.

## Common pitfalls
- Hardcoding a key, model, or endpoint auth in a new `_aiChatComplete_` branch instead of `_aiReadKey_('<NAME>_API_KEY')` / `_aiReadKey_('<NAME>_MODEL')` - breaks the env-keyed invariant and the offline test.
- A branch that throws (missing `muteHttpExceptions`, unchecked `JSON.parse`) - one provider outage then 500s the webhook and drops the user's expense. Always degrade to `null`.
- Logging or echoing the secret VALUE (in `Logger.log`, an error reply, a commit, or a message to Steven). Reference key NAMES only; the `בדיקה` probe reports presence, not contents.
- Reordering by editing call sites instead of the single `_AI_PROVIDER_PRIORITY_` array - leaves the concierge and receipt-OCR paths disagreeing on which provider is primary.
- Forgetting this ships by manual paste - an edit that isn't reassembled into `bot/ExpenseBot_DEPLOY.gs` and re-pasted by Steven does nothing in production.
