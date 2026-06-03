---
name: kesefle-admin-health-check
description: Run the admin-side health probes — bot version freshness, KV usage %, multi-writer alerts, config drift, funnel-summary, recent signups list.
---

# kesefle-admin-health-check

When invoked: read-only health checks against admin endpoints.

## Probes
1. `/api/admin/bot-version` → bot version stamp + last heartbeat timestamp (must be < 25h old)
2. `/api/admin/config-drift` → list of env vars present in code but missing in Vercel
3. `/api/admin/recent-signups` → last 10 signups, time-since-first-bot-message
4. `/api/admin/user-reports` → open "Report a problem" tickets
5. KV-watchdog stats — read count %, write count %, set count %
6. Funnel-summary — drop-off at each step
7. Launch-monitor — any P0 alert active

## Auth
- All probes require `requireAdmin` (Google ID-token + ADMIN_EMAILS check)

## Pass criteria
- Bot heartbeat < 25h old
- Config drift = 0
- KV usage < 80%
- No P0 alerts active
- No open critical user reports

## Outputs
- `admin-health-{YYYY-MM-DD-HHMM}.md` with per-probe result
- Optional Slack/Discord webhook on failure (if `ALERT_WEBHOOK_URL` env set)

## Hard NO
- No writes to KV or sheet
- No modification of any admin config
- No exposure of user PII in the report (mask phones/emails)
