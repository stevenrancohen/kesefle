# Kesefle — Audit TASKS

Status: ☐ todo · ◐ in-progress · ☑ done · ⛔ blocked (needs Steven)

## ⛔ Blocked (need Steven — work around, don't wait)
- ⛔ Bot paste — Apps Script manual paste of `bot/ExpenseBot_DEPLOY.gs` (build 2026-06-19-newbiz). Carries: bizvocab, 14 misroute fixes, NL create-business command.
- ⛔ Set Vercel `CRON_SECRET` (crons appear inert) + `KESEFLE_PROJECTION_TEMPLATE` + create Meta `projection_nudge` template (retention nudge).

## Critical
_(none confirmed)_

## High — FIXED this iteration
- ☑ #1 refund sign-flip (החזר משכנתא) · ☑ #2 payroll possessive · ☑ #3 picker empty subcategory · ☑ #4 CSV invisible rows  (commits 2bbc427, d251426)

## Medium — FIXED
- ☑ #5 NL-create amount-name · ☑ #6 getExpenses is_income · ☑ #7 projection-nudge tab · ☑ #8 formula-injection guard · ☑ #9/#10 dark hover (account/dashboard) · ☑ #15 picker isIncome (commits 2bbc427, d251426, 4c74243)

## Low — FIXED
- ☑ #20 stale biz flag · ☑ #21 0% arrow · ☑ #22 logout cache leak · ☑ #23 render race · ☑ #26/#27/#28 contrast/holo-text (commits 611cd8e, 4c74243)

## Still TODO (lower priority, next iterations)
- ☐ #11 echo-loop gap (picker confirmation) — bot, bundles into paste
- ☐ #12 dot-grouped thousands (1.000.000→1) — bot, bundles into paste
- ☐ #16 manifest WhatsApp shortcuts missing number
- ☐ #17 RSS feed stale (24 posts missing)
- ☐ #24 stats.js missing per-phone rate limit
- ☐ #33 /מעמ marks income row VAT-deductible
- ☐ #38 changelog.rss unreachable · ☐ #39 hreflang he vs he-IL
- ☐ #25 optionalAuth cookie gap (latent/low)
- ☐ docs accuracy #18/#19/#34/#35/#36/#37 (README/docs.html stale)
- ⚠ NOT-autofixable (need design): #13 group/mine scan, #14 getExpenses pagination, #29 count-phrase phantom, #30/#31 perf, #32 delete-last back-dated, #40 test.html

## Verification (live, complements the code audit)
- ◐ Live UI/responsive check of the running site (mobile + desktop): app shell, index, pricing, dashboard, account — honest states, no overflow, no broken links/buttons. (Data screens need auth = Steven; unauth states verifiable.)

## Done this session (regression-watch only)
- ☑ App: 4 screens + onboarding + iOS install + pull-to-refresh + invite + offline sw v14
- ☑ Retention: WhatsApp template send + projection-nudge cron (inert) + runbook
- ☑ Bot: NL create-business command (+ 14 misroute fixes, bizvocab) — bundled in pending paste
- ☑ api/group: 8 false-ok KV writes now return 502
