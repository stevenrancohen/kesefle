---
name: bot-classify-trace
description: Temporarily wire extra KFL-TRACE log lines around matchCategorySmart and _llmHebrewSynonyms_ to debug a specific user's misclassification, then revert cleanly.
---

# Add temporary classify traces

When a user reports "X went to Y but should have been Z", the existing `_kflTrace_` (defined at `bot/ExpenseBot_FIXED.gs:243`) already covers the high-level routing branches (`tenant_write.entry`, `tenant_write.parsed_and_classified`, etc.) but NOT the inside of `matchCategorySmart` (line ~7850 callers, alias at ~8389) or `_llmHebrewSynonyms_` (line ~15135). This skill adds short-lived traces in those spots, then takes them out.

## Steps

1. Decide what you're debugging. Capture:
   - Exact original text
   - Phone last-4 digits
   - Expected category vs actual
2. Open `bot/ExpenseBot_FIXED.gs`. Find the call site causing the wrong answer. Add ONE of:
   ```js
   _kflTrace_('classify.match_smart_in', fromPhone, item.description, { len: item.description.length });
   const matched = matchCategorySmart(item.description);
   _kflTrace_('classify.match_smart_out', fromPhone, item.description, { matched: matched && matched.category });
   ```
3. If suspicion is LLM fallback, instrument `_llmHebrewSynonyms_` entry/exit:
   ```js
   _kflTrace_('classify.llm_syn_in', '', text, {});
   // ... existing body ...
   _kflTrace_('classify.llm_syn_out', '', text, { synCount: (out && out.length) || 0 });
   ```
4. Reassemble + deploy via `bot-deploy-paste`.
5. Ask Steven to retry the failing message. Pull logs from Apps Script Executions, grep `[KFL-TRACE]`. The phone-tail in the trace lets you pick the exact user safely.
6. **REVERT**: open the same file, remove every line you added. Bump `KFL_BUILD_VERSION` again. Re-deploy. Confirm `git diff bot/ExpenseBot_FIXED.gs` is empty after the revert.

## Verification
- Before deploy: `node bot/test_trace_instrumentation.js` still passes (you didn't break the existing branches).
- After revert: `grep -c "classify.match_smart_in\|classify.llm_syn_in" bot/ExpenseBot_FIXED.gs` returns 0.
- `node --check bot/ExpenseBot_FIXED.gs` parses cleanly both times.

## Common pitfalls
- Leaving the traces in — they don't break prod, but they leak the user's text into logs forever. Always revert.
- Logging the full text — `_kflTrace_` already truncates to 40 chars (PII-safe). Don't bypass it.
- Adding a trace then forgetting to redeploy — you'll think your trace is silent when it's just not running.

## Examples
- "User 050...4321 said 'בנזין 200' got marketing instead of vehicle" → add `classify.match_smart_in/out`, redeploy, ask Steven to repro, read trace, find the issue.
- "LLM fallback seems flaky for compound Hebrew nouns" → instrument `_llmHebrewSynonyms_`, get a week of logs, decide if it needs hardening.
