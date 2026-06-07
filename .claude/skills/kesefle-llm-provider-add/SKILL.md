---
name: kesefle-llm-provider-add
description: Add an LLM provider to the bot classifier fallback (endpoint, auth header from a Script Property, response parse, graceful skip when the key is absent) without breaking the OpenAI/Gemini/xAI/Anthropic/OpenRouter chain.
---

# Add an LLM provider to the classifier fallback

The bot's AI fallback lives in `bot/ExpenseBot_FIXED.gs` and already has a provider
abstraction, so adding one is two edits and NO new call site. The deterministic
18k-keyword pipeline is the real brain; the LLM only refines low-confidence cases.

Anchors (search by symbol, line numbers drift as the file grows):
- `_AI_PROVIDER_PRIORITY_` (~line 10747) - ordered registry of `{provider, key}`.
- `_aiReadKey_(name)` (~line 10760) - reads a Script Property, falls back to
  `process.env` for the offline Node test, never throws.
- `_aiProviderResolve_()` (~line 10771) - returns `{provider, keyName, key}` for the
  FIRST configured key, or `null` when none is set.
- `_aiChatComplete_(provider, key, systemPrompt, userMsg)` (~line 10788) - the
  dispatch switch; returns the RAW reply text, or `null` on any failure.
- Call sites: classifier (~10948, ~11067) and the misc-router (~13064).

## Steps
1. Pick the Script Property name (e.g. `MISTRAL_API_KEY`) plus an optional
   `<PROVIDER>_MODEL` override key. These are NAMES only - the value is set later in
   the Apps Script editor, never written into the file.
2. Add ONE entry to `_AI_PROVIDER_PRIORITY_` in priority order:
   `{ provider: 'mistral', key: 'MISTRAL_API_KEY' }`. Position decides precedence;
   append unless it must beat an existing provider.
3. Add a branch to `_aiChatComplete_`:
   - OpenAI chat-completions shaped API: just set `url`/`model` in the existing
     OpenAI-compatible tail (xAI and OpenRouter already share it) and reuse the
     `'Authorization': 'Bearer ' + key` header.
   - Own schema: write a dedicated branch, like `anthropic` (`x-api-key` +
     `anthropic-version` headers) or `gemini` (`?key=` in the URL).
4. Read the model via `_aiReadKey_('MISTRAL_MODEL') || '<sane-default>'` so it is
   overridable from a Script Property - never hardcode the only model.
5. Make the fetch fail safe:
   - pass `muteHttpExceptions: true` on the `UrlFetchApp.fetch` call;
   - on `getResponseCode() !== 200`, `Logger.log(provider + code + body.slice(0,200))`
     and `return null`;
   - wrap the branch so the outer `try/catch` also returns `null`.
   A provider outage must degrade to keywords, never throw out of the classifier.
6. Parse the reply down to the assistant text string only
   (`choices[0].message.content`, or the provider's equivalent). Do NOT re-implement
   the contract here - `_normalizeAiClassifyResult_` (~line 10884) maps text into the
   canonical 13-field result and enforces the 0.6 ask-floor downstream.
7. Graceful skip is already wired: if the key is unset, `_aiProviderResolve_()`
   returns `null` and every call site skips the LLM. Just confirm your entry's key
   name matches exactly what you tell Steven to paste into Script Properties.

## Verification
- `node bot/test_ai_contract.js` - the contract normalizer still holds (the harness
  injects keys via `process.env`, which `_aiReadKey_` honors).
- `node bot/test_classify.js && node tests/golden_set.js` - keyword-path accuracy
  unchanged; the LLM never runs offline, so this proves no regression.
- `npm run gauntlet` - full gate; group 6 (secret scan) must stay green, confirming
  you committed the property NAME and no key VALUE.
- `node bot/bot-replay.js "850 שיווק"` - with no key configured it must still predict
  a target via keywords (LLM skipped), exercising the graceful-skip path.

## Common pitfalls
- A literal key in the registry or a comment - the registry holds property NAMES
  only; a pasted `sk-...` fails the gauntlet secret scan and leaks into git.
- Forgetting `muteHttpExceptions: true` (or letting a non-200 throw) - one provider
  429/500 then crashes `doPost` and drops the user's expense instead of falling back.
- Reordering `_AI_PROVIDER_PRIORITY_` so a new provider jumps ahead of one Steven
  relies on - only the FIRST configured key is used, so a reorder silently swaps the
  live brain.
- Editing `ExpenseBot_FIXED.gs` and stopping - the bot ships by MANUAL paste of
  `bot/ExpenseBot_DEPLOY.gs`. Reassemble via the `bot-deploy-paste` skill and bump
  `KFL_BUILD_VERSION`; agents never push the deploy themselves.
