---
name: kesefle-bot-self-heal-check
description: Verify the nightly self-healing dashboard cron (task #222) actually healed broken formulas overnight, by diffing yesterday's "broken formula count" against today's count.
---

# kesefle-bot-self-heal-check

When invoked: confirm the self-healing cron is actually doing its job, not silently failing.

## Background
- Task #222 shipped `/api/cron/self-heal-dashboards` (or equivalent) that runs nightly
- For each active tenant: scan their dashboard for broken formulas (`_isBrokenDashFormula_` style)
- If found: rebuild from `lib/sheet-writer.js` template
- Logs broken-count BEFORE and AFTER per tenant to KV `self_heal_log:{sub}:{date}`

## Steps
1. **Read yesterday's log**: `kv keys "self_heal_log:*:{yesterday-YYYY-MM-DD}"` — list all tenants healed
2. **For each tenant**:
   - `before_count` = broken formulas at run start
   - `after_count` = broken formulas at run end
   - `delta` = before - after (must be ≥ 0; negative means healing INTRODUCED broken formulas — emergency)
3. **Aggregate**:
   - Total tenants healed
   - Total formulas fixed
   - Tenants where healing didn't reduce count (cron tried but failed)
   - Tenants where healing INCREASED broken count (regression — flag for manual review)
4. **Today's freshness check**: Re-scan the same tenants TODAY, confirm `after_count` matches yesterday's `after_count` (no overnight drift)

## Pass criteria
- 0 tenants with negative delta (no healing-introduced damage)
- < 5% tenants with no improvement (failed heal — acceptable noise)
- Aggregate freshness check: today matches yesterday's after (no nightly drift)

## Outputs
- `self-heal-health-{YYYY-MM-DD}.md` with table per tenant + aggregate stats
- Slack/Discord alert if ANY negative-delta tenant (configurable via `ALERT_WEBHOOK_URL`)

## Hard NO
- Do NOT run the heal cron manually for testing during business hours (would race tenant writes)
- Do NOT mask the broken-formula count in the per-tenant report when reporting to Steven (he needs the real numbers)
- Do NOT include other tenants' formula contents in the report — only counts + masked sheetId
- Do NOT make this skill itself fix broken formulas — it's read-only verification
