---
name: kesefle-simple-tool-run-instructions
description: How to explain running a gated Apps Script tool to Steven (non-technical) in the simplest way — the reusable "3 moves" pattern (DRY_RUN → add CONFIRM property → APPLY) plus the 50-property-cap workaround. Use whenever Steven asks "explain step by step simple" for any sheet/bot tool run.
---

# Explaining a gated tool run to Steven (the "3 moves")

Steven is non-technical and fatigued by multi-step Apps Script runs. Teach the pattern ONCE, then just list function names — don't repeat the mechanics per tool.

## The 3 moves (every gated tool is identical)
1. Top function dropdown → pick the `…_DRY_RUN` → **▶ Run** → **View ▸ Logs**, read it (writes nothing).
2. If it looks right → **⚙️ Project Settings → Script Properties → Add** → name = the exact `CONFIRM_…` the log names, value = `YES I UNDERSTAND` → **Save**.
3. Run that tool's `…_APPLY`.
- Tools with no gate (e.g. `FIX_ORDERS_HEADERS`) are just **Run** once.
- `…_ROLLBACK` undoes any apply.

## The recurring blocker: "can't add a property" (50-item cap)
Tell him to delete one spent `CONFIRM_…` row (they're consumed at APPLY time — deleting after is safe) OR free slots via the KV migration ([[kesefle-script-property-50-limit-cleanup]], [[kesefle-bot-kv-creds-setup]]). NEVER tell him to delete `welcomed:`/`surveyed:`/`fxcel:` per-user keys or any secret/config.

## Rules
- Lead with the ONE most important tool ("if you only do one thing…").
- Give the EXACT function names + the EXACT `CONFIRM_…` property names + the number he'll see after.
- Offer to drive the DRY_RUN via the browser ("open the project, reply 'go'") so he only does approval clicks — but never run a financial APPLY for him ([[kesefle-financial-data-integrity-guard]], [[feedback_step_by_step_instructions]]).
- For pasting a big file, load his clipboard ([[kesefle-appsscript-paste-via-pbcopy]]); tools belong in their own project ([[feedback_tools_separate_appsscript_project]]).
