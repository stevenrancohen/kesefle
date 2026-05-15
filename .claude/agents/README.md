# Kesef'le Agent Departments

Custom Claude Code subagents that match the org structure of this product.

## Departments (heavy lifters)

| Agent | When to invoke |
|---|---|
| `rnd-researcher` | "Should we use X?" / "Compare libraries Y/Z" / "Find a template for …" / "Build an eval dataset" |
| `marketing-strategist` | Brand, naming, Hebrew copy, positioning, persona work, content strategy |
| `frontend-builder` | Components, layouts, animations, Tailwind work, Next.js scaffolding, RTL polish |
| `qa-tester` | Code review, bug hunts, accessibility audits, Hebrew edge cases, security smells |
| `integration-engineer` | Google OAuth/Drive/Sheets, WhatsApp Cloud API, Paddle/Tranzila billing, webhooks |

## Mini-agents (drop-in, single-task)

| Agent | When to invoke |
|---|---|
| `hebrew-copy-editor` | Polish a block of Hebrew copy (≤200 words) |
| `regex-reviewer` | Audit a parsing regex for Hebrew/edge-case correctness |
| `api-stub-builder` | Build a small Vercel serverless function from a spec |

## How to invoke

In Claude Code's main thread:

```
Agent({
  subagent_type: 'rnd-researcher',
  description: 'Pick WhatsApp gateway',
  prompt: 'Should we use Meta Cloud API or Twilio …'
})
```

Subagents are local to this project (`.claude/agents/`); they're loaded automatically when Claude Code starts a session in this directory.

## Org chart

```
                  ┌─── rnd-researcher ───┐
                  │                       │
   FOUNDER ───────┼─── marketing-strat ───┤        hebrew-copy-editor
   (Steven)       │                       │   ┌───  regex-reviewer
                  ├─── frontend-builder ──┼───┤    api-stub-builder
                  │                       │   └───
                  ├─── qa-tester ─────────┤
                  │                       │
                  └─── integration-eng ───┘
                       (heavy lifters)         (mini-agents)
```
