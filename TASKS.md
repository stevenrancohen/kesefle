# Kesefle — Audit TASKS

Status: ☐ todo · ◐ in-progress · ☑ done · ⛔ blocked (needs Steven)

## ⛔ Blocked (need Steven — work around, don't wait)
- ⛔ Bot paste — Apps Script manual paste of `bot/ExpenseBot_DEPLOY.gs` (build 2026-06-19-newbiz). Carries: bizvocab, 14 misroute fixes, NL create-business command.
- ⛔ Set Vercel `CRON_SECRET` (crons appear inert) + `KESEFLE_PROJECTION_TEMPLATE` + create Meta `projection_nudge` template (retention nudge).

## Critical
_(filled from audit)_

## High
_(filled from audit)_

## Medium
_(filled from audit)_

## Low / polish
_(filled from audit)_

## Verification (live, complements the code audit)
- ◐ Live UI/responsive check of the running site (mobile + desktop): app shell, index, pricing, dashboard, account — honest states, no overflow, no broken links/buttons. (Data screens need auth = Steven; unauth states verifiable.)

## Done this session (regression-watch only)
- ☑ App: 4 screens + onboarding + iOS install + pull-to-refresh + invite + offline sw v14
- ☑ Retention: WhatsApp template send + projection-nudge cron (inert) + runbook
- ☑ Bot: NL create-business command (+ 14 misroute fixes, bizvocab) — bundled in pending paste
- ☑ api/group: 8 false-ok KV writes now return 502
