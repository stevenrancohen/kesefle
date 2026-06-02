---
name: kesefle-bot-decision-trace
description: Use the bot's KFL-TRACE instrumentation (existing in bot/ExpenseBot_FIXED.gs) to capture the full decision path for a specific message in production logs, then interpret the trace to explain why the bot chose its target.
---

# kesefle-bot-decision-trace

When invoked: turn on KFL-TRACE for a window, ask Steven to re-send the failing message, then read the captured trace.

## Prerequisites
- KFL-TRACE wiring confirmed in `bot/ExpenseBot_FIXED.gs` (verified by `bot/test_trace_instrumentation.js`)
- Script Property `KFL_TRACE_ENABLED` controls capture
- Trace lines persisted to KV `trace:{phone}:{ts}` with 24h TTL

## Steps
1. **Identify the message** Steven says misbehaved (e.g. "350 וטרינר" went to שונות instead of חיות מחמד)
2. **Enable trace for the owner phone only**:
   - Set Script Property `KFL_TRACE_PHONE_FILTER=972547760643`
   - Set `KFL_TRACE_ENABLED=true`
   - This avoids capturing other tenants' messages (privacy)
3. **Ask Steven to re-send** the exact message via WhatsApp
4. **Read the trace** from KV: `kv get trace:972547760643:<latest>` (returns list of decision points with timestamps)
5. **Interpret**:
   - Each trace line has `step | function | inputs | output`
   - Find the step where prediction diverged from expectation
   - Common divergence points: `_matchCategory_long`, `_resolvePendingClarification_`, `_writeBusinessNExpense_` guard A/B/C, `_isCategoryName_`
6. **Disable trace** after capture: `KFL_TRACE_ENABLED=false`

## Output
- Markdown report `trace-analysis-{message-hash}.md` with:
  - The trace lines (PII masked)
  - The branching point that caused divergence
  - The specific source line:column to fix
  - Predicted fix + regression test

## Hard NO
- Do NOT leave KFL_TRACE_ENABLED=true after capture (PII risk)
- Do NOT capture other tenants' phones — always filter to a specific phone
- Do NOT include real phone numbers in the markdown report (mask)
- Do NOT log raw message text if it contains real names — substitute `<NAME>`
