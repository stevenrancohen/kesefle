# qa-agent-template

Standard prompt skeleton for spawning a focused QA audit agent in the background. Used to spawn frontend / backend / security / bot / sheets / payment audits in parallel during the 2026-05-27 audit sprint.

## When to use

When the user asks for a "full QA pass" or "CTO-level production audit". Spawn one agent per domain so reports can land in parallel rather than blocking the main thread for hours.

## Template

```
Run a <DOMAIN> QA audit on the Kesefle project at /Users/stevenrancohen/Documents/Claude/Projects/kesefle/.

Goal: a findings report under <N> words, NO code changes. Output to:
/Users/stevenrancohen/Documents/Claude/Projects/kesefle/docs/QA_<DOMAIN>_YYYY-MM-DD.md

## Scope

<Bullet list of what to check, taken from Steven's QA brief.>

## Files to read (sample, don't load everything)

<Specific file paths. NEVER tell the agent to read bot/ExpenseBot_FIXED.gs in full — it's 10,000 lines and will overflow.>

## What to check

<Numbered list, 5-10 items. Each item is one concrete grep or pattern check.>

## Output format

- 1-paragraph summary + <domain>-readiness 1-10 score
- Per-area table: Area | Risk | File:line
- "Critical" findings (definition: blocks user / breaks data / leaks PII)
- "High" findings
- "Medium" findings
- "Top N fixes to ship this week"

Cap to <N> words. Tag every finding with `file:line`. Skip findings you're not confident about.
```

## Critical instructions to include

1. **`run_in_background: true`** — never block the main thread on an audit.
2. **NO code changes** — audits are read-only. The agent is a research bot.
3. **Word cap** (600-1000 typical) — keeps the report CTO-readable.
4. **"Skip findings you're not confident about"** — better to under-report than to wake Steven up over a false alarm.
5. **Write to a deterministic path** under `docs/` so the user can find it.
6. **File-path hint** — point at the specific files; "audit the codebase" is too broad.

## After spawn

- Don't poll the agent — you'll be auto-notified when it finishes.
- When the report lands, read it once, then convert each actionable finding to a PR via `audit-finding-to-pr` skill.
- Reports themselves should ship as a docs-only PR (see PR #92 for the pattern).

## Anti-patterns

- Don't spawn agents that overlap on the same scope (e.g. two "frontend" agents) — they'll write to the same file and conflict.
- Don't ask the agent to "fix everything you find" — that's not what audits do. Audit = find. Triage + fix = separate workflow.
- Don't read the agent's `output_file` directly — it's the full transcript and will overflow your context. Wait for the completion notification's `<result>` summary.

## Examples

Three concurrent audits launched 2026-05-27 with this template:
- Frontend QA → `docs/QA_FRONTEND_2026-05-27.md` (690 words)
- Backend QA → `docs/QA_BACKEND_2026-05-27.md` (1032 words)
- Security audit → `docs/SECURITY_HARDENING_AUDIT_2026-05-27.md` (985 words)

Three more launched in the next block:
- Bot QA, Sheets QA, Payment QA
