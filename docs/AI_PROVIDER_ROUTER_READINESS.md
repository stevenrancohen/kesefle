# AI Provider Router — Readiness Assessment

Date: 2026-05-28
Author: Agent 7 (autonomous audit block)
Status: Readiness doc only — no router implemented here

This document inventories every external LLM call in Kesefle, characterizes the data sent to each provider, and proposes a single `lib/ai-router.js` abstraction layer that would let the bot fail over between providers, enforce a minimization rule centrally, and stay under cost budget. Implementation is deferred — Steven approves the proposal first.

---

## 1. Current AI surface (inventory)

| Provider | File:line | Env var | Model | Invocation pattern | Fallback |
|----------|-----------|---------|-------|--------------------|----------|
| **Anthropic** | `bot/ExpenseBot_FIXED.gs:8928` | `ANTHROPIC_API_KEY` (Apps Script `PropertiesService`) — masked: `sk-ant-***MASKED***` | `claude-haiku-4-5-20251001` | Expense-text categorizer (used when keyword classifier returns low confidence). 140-token reply. | None — returns `null`, bot falls back to "I didn't understand". |
| **Anthropic** | `bot/ExpenseBot_FIXED.gs:9381` | same | `claude-haiku-4-5-20251001` | Receipt OCR via vision (image base64 + extraction prompt). 300 tokens. | None — replies "try again later". |
| **Anthropic** | `bot/ExpenseBot_FIXED.gs:10193` | same | `claude-haiku-4-5-20251001` | Per-user keyword learning when user corrects category. 200 tokens. | None — returns `[]`. |
| **Anthropic** | `bot/ExpenseBot_FIXED.gs:15281` | same | `claude-haiku-4-5-20251001` | Hebrew synonym expansion (cron-driven, off-path). 200 tokens. | None — returns `[]`. |
| **Anthropic** | `api/health/detailed.js:60` | n/a | n/a | HEAD probe to `api.anthropic.com/v1/messages` for liveness, no API call. | Probe failure ≠ outage. |
| **OpenAI Whisper** | `bot/ExpenseBot_FIXED.gs:9615` | `OPENAI_API_KEY` (Apps Script `PropertiesService`) — masked: `sk-***MASKED***` | `whisper-1` | Voice-note transcription (Hebrew speech → text) when user sends an audio WhatsApp message. | None — replies "תרשום בכתב". |
| **Gemini text-gen** | `bot/ExpenseBot_FIXED.gs:4590` | `GEMINI_API_KEY` (Apps Script `PropertiesService`) — masked: `AIza***MASKED***` | tries `gemini-2.0-flash`, then `gemini-1.5-flash`, `gemini-2.5-flash`, `gemini-flash-latest` in order. | Money-coach / concierge replies for free-form questions ("how am I doing this month?"). 1000-char input, 400-token output. | Cycles 4 model names on non-200; on full failure returns `null`, bot uses "didn't understand". |
| **Gemini OCR** | `bot/RECEIPT_PARSING.gs:32` | same `GEMINI_API_KEY` | `gemini-1.5-flash` (configurable) | Alternative receipt OCR path (older code; Anthropic is the active path). | None. |
| **Gemini embedding** | `bot/EMBEDDING_FALLBACK.gs:27` | same | `text-embedding-004` | Embedding fallback when local-keyword categorizer is uncertain. | None. |
| **(none)** | — | — | — | No OpenRouter, no Grok / xAI, no DeepSeek, no Mistral. | — |

All API keys are stored in Apps Script `PropertiesService` (bot-side) or `process.env` (Vercel-side). None appear hardcoded in tracked source — verified by the secret scan in `docs/SECURITY_PRIVACY_AUDIT_KESEFLE.md`.

---

## 2. What data leaves the perimeter today

| Provider | Endpoint | Payload contents (in order seen in code) | Sensitive? |
|----------|----------|------------------------------------------|------------|
| Anthropic `_aiCategorizeRich_` | `POST /v1/messages` | The user's free-typed expense description text, capped to 200 chars. Pre-existing user examples block + profile-hint block (anonymized, no name/phone). | **Description only** — no phone, no userSub, no amount, no date. |
| Anthropic `_handleReceiptImage_` | `POST /v1/messages` | Receipt image (base64, original resolution from WhatsApp). System prompt only — no user metadata. | **Image** — contains the visible content of a printed receipt (vendor, items, prices). |
| Anthropic `_aiKeywordLearning_` | `POST /v1/messages` | A correction example: "the user wrote X and corrected category to Y, give me 1-3 keywords". | **Description + corrected category** — no phone/userSub/amount. |
| Anthropic `_llmHebrewSynonyms_` | `POST /v1/messages` | A single Hebrew phrase from the synonym-cron list (cron job, not user-triggered). | **Vocabulary token** — non-personal. |
| OpenAI Whisper | `POST /v1/audio/transcriptions` | Raw audio bytes (Hebrew voice note). | **Voice** — the user's speech with whatever they spontaneously said. This is the most-sensitive surface. |
| Gemini concierge | `POST /v1beta/models/.../generateContent` | The user's free-text query (1000-char cap) + `_spendingContextLine_` (e.g. "החודש כ-3,200₪, בעיקר על מזון") for **non-owner** tenants. Owner is **skipped** (`_isOwnerPhone_` early return). | **Aggregated total + top category only** — no per-row transactions, no vendor names, no dates. |
| Gemini receipt OCR | `POST /v1beta/models/.../generateContent` | Receipt image bytes (alternative path; today Anthropic is primary). | Same as Anthropic receipt case. |
| Gemini embedding | `POST /v1beta/models/text-embedding-004:embedContent` | A single short Hebrew text fragment for vector search. | Non-personal. |

**Key observation**: today's payloads are already minimization-clean. The bot never sends:
- the user's E.164 phone number
- the user's Google sub or email
- the user's spreadsheet ID
- the user's name
- a full historical transaction list

The most-sensitive item is the **voice note audio**, which by nature is the user's raw speech. There is no alternative — Whisper needs the audio.

---

## 3. Why a router is worth building

| Problem today | Router solves |
|---------------|---------------|
| Each call site re-implements headers, model name, retry, error handling. Drift between sites is already visible (4 different system-prompt formats for Claude). | Single `aiRouter.call({ task, input, ... })` keeps headers, model, retries, telemetry consistent. |
| If `claude-haiku-4-5-20251001` is deprecated, 5 separate file edits across `bot/ExpenseBot_FIXED.gs` (incl. the `DEPLOY` copy). | One constant in `lib/ai-router.js`. |
| No failover. If Anthropic 5xx-s during a launch spike, every categorizer call returns `null`. | Router falls Anthropic → Gemini → "needs_review" (don't write a wrong category). |
| No central cost ceiling. A buggy loop could call Anthropic 100k times before anyone notices. | Router enforces a daily token-budget per task type via KV counter; emits Slack alert at 80%. |
| Minimization invariant ("never send raw phone / sheetId / full history") is a code review convention, not a runtime guarantee. | Router refuses to send any payload containing fields named `phone`, `userSub`, `spreadsheetId`, `email` — fails closed. |
| "needs_review" fallback when no model is confident → today silently produces a wrong category and writes a wrong row. | Router returns `{ ok: false, reason: 'low_confidence' }` and the caller writes the row to a `לבדיקה` queue tab instead of the main `תנועות`. |

---

## 4. Proposed `lib/ai-router.js` design

```
// lib/ai-router.js  (proposed, NOT IMPLEMENTED)
//
// Single entry point for every external LLM call in Kesefle.
// Enforces minimization, failover, budget, telemetry.

import { log } from './log.js';
import { kvIncr, kvGet } from './kv.js';

const TASKS = {
  categorize_expense: {
    primary: 'anthropic:claude-haiku-4-5-20251001',
    fallback: 'gemini:gemini-2.0-flash',
    maxInputChars: 200,
    maxOutputTokens: 140,
    dailyBudgetTokens: 1_000_000,
    minimizationCheck: 'STRICT',  // forbids fields: phone, userSub, spreadsheetId, email, name
    confidenceFloor: 0.6,         // below → 'needs_review'
  },
  ocr_receipt: { primary: 'anthropic:claude-haiku-4-5-20251001', fallback: 'gemini:gemini-1.5-flash', maxOutputTokens: 300, ... },
  transcribe_voice: { primary: 'openai:whisper-1', fallback: null, ... },  // no fallback; voice is sensitive
  concierge_chat: { primary: 'gemini:gemini-2.0-flash', fallback: 'anthropic:claude-haiku-4-5-20251001', maxInputChars: 1000, ... },
  keyword_learning: { primary: 'anthropic:claude-haiku-4-5-20251001', fallback: null, ... },
  embed: { primary: 'gemini:text-embedding-004', fallback: null, ... },
};

export async function aiCall({ task, systemPrompt, userInput, image, contextLine }) {
  // 1. Minimization gate
  const dangerous = ['phone', 'userSub', 'sub:', 'spreadsheetId', 'email', '@gmail.com'];
  const joined = (systemPrompt || '') + (userInput || '') + (contextLine || '');
  for (const tok of dangerous) {
    if (joined.toLowerCase().includes(tok.toLowerCase())) {
      log.error('ai.minimization_violation', { task, token: tok });
      return { ok: false, reason: 'minimization_violation' };
    }
  }

  // 2. Budget check
  const spec = TASKS[task];
  if (!spec) throw new Error('unknown_task');
  const usedToday = await kvGet('ai_budget:' + task + ':' + ymd());
  if (Number(usedToday) > spec.dailyBudgetTokens) {
    log.warn('ai.budget_exhausted', { task, usedToday });
    return { ok: false, reason: 'budget_exhausted' };
  }

  // 3. Call primary, retry on 5xx, then fallback
  let resp = await callProvider(spec.primary, ...);
  if (!resp.ok && spec.fallback) {
    log.warn('ai.fallback_used', { task, from: spec.primary, to: spec.fallback });
    resp = await callProvider(spec.fallback, ...);
  }

  // 4. Confidence floor
  if (resp.ok && resp.confidence != null && resp.confidence < spec.confidenceFloor) {
    return { ok: false, reason: 'needs_review', proposed: resp };
  }

  // 5. Telemetry
  await kvIncr('ai_budget:' + task + ':' + ymd(), resp.tokensUsed || 0);
  return resp;
}
```

### Provider preference order (proposed)

| Task | Primary | Fallback | Rationale |
|------|---------|----------|-----------|
| `categorize_expense` | Anthropic Haiku | Gemini 2.0 Flash | Anthropic wins on Hebrew + structured JSON. Gemini for failover (free tier). |
| `ocr_receipt` | Anthropic vision | Gemini 1.5 Flash vision | Anthropic vision is more reliable on Hebrew receipts. |
| `transcribe_voice` | OpenAI Whisper | **none** | No comparable Hebrew-quality alternative. If down, ask user to type. |
| `concierge_chat` | Gemini 2.0 Flash | Anthropic Haiku | Gemini's free tier covers concierge volume; Anthropic for failover. |
| `keyword_learning` | Anthropic Haiku | **none** | Off-path; can wait for a retry. |
| `embed` | Gemini text-embedding-004 | **none** | Cheapest token rate. Off-path. |

### Failover rules (proposed)

1. **Primary 429 / 5xx / timeout > 8s** → try fallback once with same payload, same task.
2. **Primary returns 200 but with content-filter / safety block** → log `ai.safety_block` and fall back.
3. **Both providers fail** → return `{ ok: false, reason: 'needs_review' }`. Caller writes the row to a `לבדיקה` tab or prompts user.
4. **Daily budget exhausted** → return `{ ok: false, reason: 'budget_exhausted' }`. Bot replies in Hebrew: "המערכת שלנו עמוסה כרגע, נסה שוב בעוד שעה". Never make a wrong category up.

### Minimization invariant (proposed)

The router refuses to send a payload if `JSON.stringify(payload).toLowerCase()` contains any of:
- `phone`, `+972`, raw E.164 patterns
- `usersub`, `user_sub`, `sub:`
- `spreadsheetid`, the literal owner sheet ID `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`
- `email`, `@gmail.com`, `@kesefle.com`
- the user's `name` field as stored in `user:{sub}` (passed in by caller for the check)

This is a runtime guarantee, not a convention. A failed check returns `minimization_violation` and the call site has to scrub before retrying.

### Cost rules (proposed)

| Task | Daily token budget (per tenant) | Daily token budget (global) |
|------|--------------------------------|------------------------------|
| `categorize_expense` | 500 (~50 messages) | 1M |
| `ocr_receipt` | 50 (~5 receipts) | 200k |
| `transcribe_voice` | 30 minutes audio | 500 hours |
| `concierge_chat` | 5,000 (~10 questions) | 2M |
| `keyword_learning` | 100 (~10 corrections) | 100k |
| `embed` | 1,000 | 5M |

Per-tenant counter keyed by `userSub` to prevent one abusive tenant from blowing the global budget. KV INCR with daily TTL.

### "Needs review" fallback

When the router returns `{ ok: false, reason: 'needs_review' }`, the existing bot code paths should:
1. **`categorize_expense`** → write the row with `category='לבדיקה'`, `subcategory=''`, and a sheet note explaining why. Bot replies: "רשמתי, אבל לא הייתי בטוח/ה בקטגוריה — תקן/י כשנוח".
2. **`ocr_receipt`** → reply: "לא הצלחנו לקרוא את הקבלה. תוכל/י לשלוח שוב או לרשום ידנית?"
3. **`concierge_chat`** → reply: "השאלה לא לגמרי ברורה לי, אפשר/אפשרת לנסח אותה אחרת?"

No silent guesses. No wrong-category writes.

---

## 5. Privacy posture (current vs. after router)

| Aspect | Today | After router |
|--------|-------|--------------|
| Phone/userSub/email sent to LLM? | No (verified by code reading) | No (enforced at runtime) |
| Owner sheet ID sent? | No | No (router refuses) |
| Full transaction history sent? | No | No (only aggregated `_spendingContextLine_`) |
| Receipt image sent? | Yes (necessary) | Yes (still necessary; logged in audit log) |
| Voice note audio sent? | Yes (necessary) | Yes (still necessary; logged in audit log) |
| Daily cost ceiling enforced? | No (vulnerable to runaway loop) | Yes (per task + per tenant + global) |
| Failover when provider 5xx? | No (silent fail) | Yes (Anthropic → Gemini) |
| "I'm not sure" path? | Sometimes (returns `null`, bot replies "didn't understand") | Always (`needs_review` is a first-class outcome) |

---

## 6. What this doc does NOT include

- An implementation of `lib/ai-router.js`. That is a separate PR after Steven signs off on the design.
- Migration of the 9 existing call sites in `bot/ExpenseBot_FIXED.gs` to use the router. That's a separate PR per call site (categorize → OCR → concierge → keyword → embed → voice), staged so each ship is reversible.
- Changes to OpenRouter / Grok / xAI / DeepSeek — they're not in the codebase today, so this doc does not plan them in. If Steven wants to add one as a third fallback layer, add a row in the `TASKS` table.

---

## 7. Open questions for Steven

1. **OpenRouter vs. direct Anthropic+Gemini**: OpenRouter offers one API for many providers but adds a third-party hop (their TOS, their privacy policy). Direct stays simpler. Recommend direct.
2. **Per-tenant budget enforcement**: should the bot send a "you used your daily AI quota, premium gets unlimited" message to free-tier users when they hit the cap? Could be a soft upsell.
3. **`לבדיקה` tab vs. row note**: today the bot writes a category note when unsure. A dedicated `לבדיקה` tab is cleaner but requires `lib/sheet-writer.js` template change. Recommend starting with the row note; promote to tab if user research confirms confusion.
4. **Apps Script vs. Vercel for the router**: today every AI call lives in `bot/ExpenseBot_FIXED.gs`. Moving to a Vercel endpoint (`/api/ai/route`) would centralize the router and let the website also use it (e.g. for the in-product money coach). Recommend Vercel — single source of truth, easier audit, easier kill switch. Bot calls the Vercel endpoint instead of provider URLs.

---

## 8. Implementation order (when Steven approves)

1. PR 1: ship `lib/ai-router.js` skeleton + `api/ai/route.js` Vercel endpoint with the categorize task only. Behind a feature flag.
2. PR 2: migrate `_aiCategorizeRich_` in the bot to call `/api/ai/route?task=categorize_expense`. Compare output to direct-Anthropic in shadow mode.
3. PR 3: flip the flag; remove direct-Anthropic call site.
4. PR 4–7: same pattern for `ocr_receipt`, `concierge_chat`, `keyword_learning`, `embed`. Voice transcription stays direct (no fallback to add, and audio shouldn't go through Vercel — too large).

Estimated effort: 1 sprint for PRs 1–3, 1 sprint for the rest. No user-visible behavior change if implemented correctly; the bot does exactly what it does today, just behind the router.

---

End of readiness assessment. Awaiting decision before implementation.
