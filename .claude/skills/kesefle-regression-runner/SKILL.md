---
name: kesefle-regression-runner
description: Run the full Kesefle test gauntlet — tests/full_qa.js + every bot/test_*.js + tests/*.js + golden_set.js — and emit a single PASS/FAIL summary with diff-since-last-run.
---

# kesefle-regression-runner

When invoked: run every test command Kesefle has, capture pass/fail, compare to last run.

## Test commands (in order)
```
node tests/full_qa.js                       # 118 checks expected
node bot/test_classify.js                   # 118 expected
node tests/golden_set.js                    # 95%+ accuracy
node tests/test_bank_parsers.js
node tests/test_csv_import.js
node tests/test_ratelimit_arg_order.js
node tests/test_whatsapp_link_get_ratelimit.js
node tests/test_professions.js
node tests/test_sheet_ownership_guard_5_endpoints.js
node tests/test_bot_q4_profession.js
node tests/test_winback_token_exact_match.js
node tests/recurring_detect.js
node bot/test_pending_state_hijack.js
node bot/test_trace_instrumentation.js
node bot/test_phase_a_v2_uncertainty.js
node bot/test_business_order_parser.js
node bot/test_bot_robustness.js
node bot/test_category_picker.js
node bot/test_botloop.js
node bot/test_broken_formula.js
node bot/test_destructive_delete_confirm.js
node bot/test_expanded_category_picker.js
node bot/test_goal_commands.js
node bot/test_isolation.js
node bot/test_bot_no_active_lies.js
node bot/test_parser.js
node bot/test_dashboard_repair.js
node bot/test_marketing_formula.js
node bot/test_picker_always_shown.js
node bot/test_migration.js
node bot/test_migration_phase_5.js
node bot/test_migration_phase_7.js
node bot/test_multibiz_naming.js
node bot/test_objective_commands.js
```

## Outputs
- `regression-{YYYY-MM-DD-HHMM}.md` with per-suite result + summary
- Exit 0 only if ALL suites pass
- Compare to previous `regression-*.md` and highlight: newly-failing, newly-passing, still-failing

## Hard NO
- Don't skip failing suites
- Don't pretend a test passed
- Don't modify the test files during runs (only run them)
