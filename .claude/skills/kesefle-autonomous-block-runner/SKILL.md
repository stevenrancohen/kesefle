---
name: kesefle-autonomous-block-runner
description: Run a long autonomous multi-wave Kesefle block - fan out producer agents (QA, keyword packs, skills) via Workflow, integrate each as a gauntlet-gated PR Steven merges, never push main, end with a tasks-for-Steven list.
---

# Run an autonomous multi-wave block

For a long unattended block, act as the orchestrator: spin up producer agents in isolated worktrees, gather their output as PRs, gauntlet-gate every one, and finish with a single screen of what Steven must do. Hard rule throughout: agents never push to main, no destructive sheet/bot action runs un-gated, and no secret VALUE is ever echoed.

## Steps
1. Set up isolation first: one git worktree + branch per wave ([[kesefle-worktree-parallel-setup]]) so parallel file-editing agents don't stomp each other.
2. Load the orchestration tools before calling them - the Workflow/agent and Vercel/Monday MCP tools are deferred ([[kesefle-deferred-tool-load]]); `ToolSearch` their schemas up front.
3. Fan out producer agents via the Workflow tool, one focused brief each. The standard Kesefle producers:
   - **QA / audit** - run `npm run gauntlet` + the audit skills, fix-then-ship safe issues. Pipeline: QA finds a real miss -> additive fix + golden anchor -> ship. ([[kesefle-classifier-misroute-hunt]], [[kesefle-regression-runner]])
   - **Keyword packs** - author `bot/keywords/packs/*.json` ([[kesefle-keyword-pack-author]]), then build the embedded index. Pipeline: pack -> `build_index` -> `bot/ExpenseBot_KEYWORDS.gs` (ASCII `\u`-escaped, additive fallback after CATEGORY_MAP) ([[kesefle-keyword-index-build]]).
   - **Skills** - author/refine `.claude/skills/*/SKILL.md` in house style.
4. Integrate each wave as a PR off its branch; union-resolve the recurring `tests/full_qa.js` / `bot/ExpenseBot_FIXED.gs` cascade into one integration PR per wave where needed ([[kesefle-pr-stack-bundle]]).
5. Gauntlet-gate EVERY PR: `npm run gauntlet` must exit 0 before it's handed over. A red PR is fixed ([[kesefle-gauntlet-triage]]), never softened.
6. For any bot change, reassemble `bot/ExpenseBot_DEPLOY.gs` and note in the PR that Steven must re-paste ([[bot-deploy-paste]]).
7. Update Monday at block end (mark done + add new tasks) so the board never goes stale ([[kesefle-monday-sync]]).
8. End with a single-screen **tasks-for-Steven** list: which PRs to merge (in order), which need a bot re-paste, which need a Vercel env value HE must set ([[kesefle-vercel-env-audit]] / [[kesefle-paypal-setup-guide]]), and anything blocked.

## Hard rules (do not break)
- Agents never push to main - every change reaches main only via a PR Steven merges.
- No `setValue/clearContents/deleteRow`-style sheet writes and no migration runs without the DRY_RUN -> approval gate ([[kesefle-financial-data-integrity-guard]]).
- Never use the retired legacy sheet id; keep the active tenant wiring. Never swap the public bot number `972547766361` with the owner number `972547760643` ([[kesefle-bot-number-config-check]]).
- Never echo a secret VALUE - env/Script-Property NAMES only.

## Verification
- Every produced PR: `npm run gauntlet` exits 0 (`GAUNTLET PASSED`).
- `git worktree list` shows each wave on its own `agent/wave-*` branch; none on main; no direct commits to main (`git log origin/main` unchanged by the agents).
- Bot-touching PRs include a regenerated `bot/ExpenseBot_DEPLOY.gs` + a re-paste note; `node bot/test_isolation.js` passes.
- The run ends with the tasks-for-Steven list, and Monday reflects the block.

## Common pitfalls
- Calling a Workflow/Vercel/Monday tool before loading its schema -> `InputValidationError` ([[kesefle-deferred-tool-load]]).
- Running producers in one shared checkout -> index stomping; always per-wave worktrees.
- Auto-merging to main "to save Steven a step" -> forbidden; hand over PRs only.
- Shipping a bot PR without DEPLOY.gs reassembly -> looks done, runs old code on paste.
- Ending without the tasks-for-Steven list -> Steven can't tell what's mergeable vs blocked; always close with it.
