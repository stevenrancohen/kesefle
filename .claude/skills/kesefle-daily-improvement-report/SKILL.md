---
name: kesefle-daily-improvement-report
description: Generate a daily "what improved / what regressed" markdown summary — commits shipped, tests run, errors logged, customer reports, KV usage trend.
---

# kesefle-daily-improvement-report

When invoked: produce yesterday's-snapshot report.

## Sections
1. **Commits shipped** — count + brief titles (read git log --since="24 hours ago")
2. **Tests run** — total runs, pass %, regressions
3. **Errors logged** — top 5 unique errors from KV log (mask user data)
4. **Customer reports** — open / resolved counts
5. **KV usage** — read / write / set counts vs Upstash free tier limits
6. **Bot heartbeat** — last build version, hours since heartbeat
7. **Vercel deploys** — count, success rate
8. **What got better** — measurable improvement (test count up, error rate down, etc.)
9. **What got worse** — measurable regression
10. **Notable PRs merged**
11. **Tomorrow's top 3 priorities** (from open Monday tasks, ranked by severity)

## Outputs
- `docs/daily/{YYYY-MM-DD}.md` — committed to repo
- Optional: send summary to Steven via WhatsApp (uses bot's KESEFLE_BOT_SECRET-gated outbound)

## Pass criteria
- Report generated daily
- All sections present
- No PII leaks

## Hard NO
- Don't include real user data
- Don't make up metrics — only what's measurable
- Don't promise things not yet shipped
