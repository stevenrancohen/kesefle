# Kesefle — Audit TASKS

Status: ☐ todo · ◐ in-progress · ☑ done · ⛔ blocked (needs Steven)

## ⛔ Blocked (need Steven — work around, don't wait)
- ☑ Bot paste DONE 2026-06-25 — build 2026-06-25-signfix LIVE (carried ~10 days of fixes: רוביקון, income recognition, 24 over-flips, create-business, dot-thousands, audit batch)
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
- ☑ #11 echo-loop gap (picker confirmation) — FIXED 0d8dc69
- ☑ #12 dot-grouped thousands — FIXED 0d8dc69
- ☑ #16 manifest WhatsApp shortcuts — FIXED 12861d2
- ☐ #17 RSS feed stale (24 posts missing)
- ☐ #24 stats.js missing per-phone rate limit
- ☑ #33 VAT-on-income guard — FIXED 12861d2
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
