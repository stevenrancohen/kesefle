# Kesef'le Agent Departments

Custom Claude Code subagents + skills + hooks that match the org structure of this product. Invoke an agent from the main thread with `Agent({ subagent_type: '<name>', description, prompt })`. Agents are loaded automatically when Claude Code starts in this directory.

> Note on cadence: Claude Code subagents are **invoked on demand**, not run as always-on daemons. "Continuous"/"every N min" intent is documented in each agent body; for true recurring runs use the cron scheduler (1-hour minimum). The `self-improvement` agent keeps the queue full when invoked.

## Engineering & architecture
| Agent | When to invoke |
|---|---|
| `architect` | Design a feature / data model / API contract BEFORE coding. Produces specs, never code. (Opus) |
| `integration-engineer` | Google OAuth/Drive/Sheets, WhatsApp Cloud API, billing, webhooks. |
| `bot-engineer` | Any change to `bot/ExpenseBot_FIXED.gs` — Apps Script, WhatsApp, Hebrew NLP. Knows the DEPLOY assembly + test ritual. |
| `frontend-builder` | Components, layouts, animations, Tailwind, RTL polish. |
| `db-expert` | KV schema / Sheet columns / migrations / data-isolation review. Paranoid about data loss. |
| `api-stub-builder` | Build a small Vercel serverless function from a spec. |

## Quality, security & reliability
| Agent | When to invoke |
|---|---|
| `critic` | Pre-commit review of the staged diff. Verdict BLOCK / OK. |
| `security-auditor` | Audit endpoints, isolation, injection, auth, headers, GDPR. Read-only. |
| `qa-tester` | Code review, bug hunts, accessibility, Hebrew edge cases. |
| `debugger` | Root-cause a bug from code + logs; verify the fix. |
| `regex-reviewer` | Audit a parsing regex for Hebrew/edge-case correctness. |
| `performance-monitor` | Page weight, render-blocking, fonts, images, CWV. |

## Growth, content & business
| Agent | When to invoke |
|---|---|
| `seo-optimizer` | Keywords, on-page SEO, schema, sitemap, internal links (white-hat only). |
| `marketing-strategist` | Brand, positioning, persona, content strategy. |
| `hebrew-copy-editor` | Polish a block of Hebrew copy (≤200 words). |
| `business-analyst` | Real metrics from admin APIs — users, MRR, funnel, adoption. No fabrication. |
| `rnd-researcher` | "Should we use X?" / compare libraries / find templates. |

## Meta
| Agent | When to invoke |
|---|---|
| `self-improvement` | When the queue looks empty — surveys state, finds real gaps, proposes prioritized next actions. Anti-busywork. |

## Skills (`.claude/skills/`)
`pr-review` · `deploy-checklist` · `hebrew-copy-check` · `security-scan` · `seo-audit` — reusable checklists; invoke with the Skill tool.

## Hooks (`.claude/hooks/`)
- `block-secrets.sh` — wired as a PreToolUse hook in `settings.json`; blocks `git commit` if a staged file contains an API key / token / private key.
- `pre-commit-check.sh` — manual: secret scan + `node --check` staged JS + run all test suites.
- `format-on-write.sh` — advisory lint (trailing whitespace, stray bidi chars, missing newline). Never mutates.
