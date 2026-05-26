# Kesefle Global QA Standard — Mandatory before completing any task

Set by Steven 2026-05-26. **Permanent project rule.**

This applies to every task, every PR, every fix, every design change, every bot change, every Google Sheets change, every admin change, every automation, and every documentation update in the Kesefle project.

Do not mark any task as done unless it passed the required QA checklist below.

## Main principle

"Done" means tested, verified, documented, and safe.
- "Code written" is not done.
- "Looks good" is not done.
- "Local test passed" is not enough if the feature affects users, bot, sheets, billing, admin, or production data.

---

## 1. Mandatory completion rule

Before finishing any task, the agent must always provide a final QA section with:

1. What was changed
2. Why it was changed
3. Files changed
4. Risk level
5. Tests run
6. Manual QA performed
7. Production impact
8. User-data impact
9. Bot impact
10. Google Sheets impact
11. Admin impact
12. Payment impact
13. Mobile impact
14. RTL/Hebrew impact
15. Security/privacy impact
16. Rollback plan
17. Remaining issues
18. Whether the task is truly done or only partially done

If a test wasn't run, the agent must say clearly:
> "Not tested: [reason]"

Do not hide missing tests.

---

## 2. Definition of Done — statuses

A task can only be marked "Done" when all relevant checks pass.

| Status | Meaning |
|---|---|
| **DONE** | tested and verified |
| **PARTIAL** | implemented but not fully tested |
| **NEEDS REVIEW** | PR open, waiting for review |
| **BLOCKED** | cannot continue because of external issue |
| **RISKY** | works locally but may affect production / user data |
| **DO NOT MERGE** | failed test or unresolved risk |

**Never mark a task as DONE only because code was pushed.**

---

## 3. Required QA table — every task

At the end of every task, include this table:

| Area | Check | Result | Evidence | Risk | Next action |
|---|---|---|---|---|---|
| Code | Syntax / build passes | Pass / Fail / Not tested | command + output | Low / Med / High | fix / retest |
| Tests | Automated tests pass | Pass / Fail / Not tested | command + output | Low / Med / High | fix / retest |
| UI | Visual check done | Pass / Fail / Not relevant | pages / screens | Low / Med / High | fix / retest |
| Mobile | Mobile layout checked | Pass / Fail / Not relevant | viewport + pages | Low / Med / High | fix / retest |
| RTL | Hebrew RTL checked | Pass / Fail / Not relevant | pages / screens | Low / Med / High | fix / retest |
| Bot | Bot flow checked | Pass / Fail / Not relevant | messages tested | Low / Med / High | fix / retest |
| Sheets | Google Sheets checked | Pass / Fail / Not relevant | sheet + formula tested | Low / Med / High | fix / retest |
| Admin | Admin checked | Pass / Fail / Not relevant | admin page + action | Low / Med / High | fix / retest |
| Payments | Billing checked | Pass / Fail / Not relevant | sandbox + logs | Low / Med / High | fix / retest |
| Security | Secrets / privacy checked | Pass / Fail | findings | Low / Med / High | fix / retest |

---

## 4. Minimum automated tests for every code change

```bash
node tests/full_qa.js
```

Plus, for the changed file types:

- **`*.js` (API or lib)** — `node --check <file>` for every changed file
- **`*.html`** — inline-script parse: ```bash
  node -e "const fs=require('fs');const h=fs.readFileSync('FILE.html','utf8');[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m,i)=>{try{new Function(m[1])}catch(e){console.log('block',i,e.message);process.exit(1)}});console.log('ok')"
  ```
- **`bot/ExpenseBot_FIXED.gs`** — copy to /tmp/x.js then `node --check /tmp/x.js`. ALSO run the relevant `bot/test_*.js` directly.
- **`bot/ExpenseBot_DEPLOY.gs`** — must be regenerated via the deploy-checklist reassemble command after every FIXED.gs change.

If a test was not run, log the reason explicitly in the QA section.

---

## 5. Manual QA gates — when each applies

- **Bot change** → must include a "test plan: send these messages and confirm" with at least 3 expected behaviors.
- **Sheet write path change** → must include "verified the row lands in the correct tab, with the correct columns, and the dashboard total updates".
- **Auth / billing change** → must include "verified rate limit / requireAdmin / requireAuth still gates the endpoint, returns 401 / 403 when unauthenticated".
- **Public-page visual change** → must include "verified on at least: index, pricing, account, dashboard, admin" + screenshot or specific class-name evidence.
- **Hebrew-text change** → must include "verified text reads correctly RTL and no bidi-control character leaked into the source".
- **Cron change** → must include "verified the cron is wired in vercel.json crons block and the handler returns 200 on a manual GET".

---

## 6. Anti-patterns — auto-fail the QA section

The QA section is automatically incomplete / invalid if any of these appear:

- "Looks good" / "should work" without a test command
- "Tests pass" without naming the test command + result count
- "Verified" without a file path + line number or screenshot
- "No regressions" without naming the regression-guard test
- A QA table where every row says "Not tested"
- Skipping a row because it "wasn't relevant" without justifying why
- Marking DONE when the change requires a manual paste (Apps Script) and that paste hasn't been confirmed

---

## 7. Sign-off footer — every task ends with

```
Status: DONE | PARTIAL | NEEDS REVIEW | BLOCKED | RISKY | DO NOT MERGE
Verified by: [test commands run + their results]
Manual QA: [what was clicked / messaged + observed]
Outstanding: [anything still risky or untested]
```

This is the LAST line of every completed task report.
