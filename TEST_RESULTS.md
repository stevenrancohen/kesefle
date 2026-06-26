# Kesefle — Audit TEST_RESULTS

## Baseline (2026-06-19, HEAD c918294)
| Check | Result |
|---|---|
| `npm run gauntlet` | ✅ PASS — 3800 checks / 6 groups / 0 failures |
| Test suites (tests/* + bot/test_*) | ✅ 110 / 110 passed |
| JS syntax (`node --check` all *.js + *.gs) | ✅ 1616 / 1616 passed |
| HTML inline-script + JSON-LD | ✅ pass |
| Sitemap | ✅ pass |
| Secret scan | ✅ pass |
| `node bot/test_classify.js` | ✅ 177 checks |
| `node bot/test_parser.js` | ✅ 72 checks |
| `node bot/test_isolation.js` | ✅ 19 checks |

## Findings log (filled per iteration: before → fix → after)
_(none yet — audit workflow running)_

## Iteration 1 (2026-06-19) — financial-integrity batch (commits 2bbc427, d251426)
| # | Finding | Before | After |
|---|---|---|---|
| 1 | refund `החזר מ[א-ת]` sign-flip | `החזר משכנתא 4000` → income=true | → income=false (expense) ✓ |
| 2 | payroll possessive | `משכורת של העובד 6000` → הכנסות/income | → עסק/הוצאות תפעוליות, income=false ✓ |
| 15 | picker hardcoded isIncome:false | income category booked as expense | derives via _isIncomeCategory_ ✓ |
| 3 | picker empty subcategory | col E blank → dashboard-invisible | writes category → canonical row ✓ |
| 8 | sanitizeForSheet charAt(0) only | " =HYPERLINK" bypass | probes first non-space/bidi char ✓ |
| 5 | NL create amount-name | `פתח עסק 250 שיווק` → junk biz | rejected (amount-shaped) ✓ |
| 20 | NL create stale flag | armed flag hijacks next msg | cleared in handler ✓ |
| 4 | CSV col E blank/mismatch | imported rows invisible | real dashboard label ✓ |
| 6 | getExpenses is_income | legacy income shown as expense in Insights | + Hebrew-category fallback ✓ |
| 7 | projection-nudge year-tab-first | owner sheet read dashboard, not תנועות | reads תנועות first ✓ |

Tests added: test_refund_income +3, test_income_signfix +2, test_create_business +2, test_csv_import labels. Gauntlet GREEN throughout. Bot build → 2026-06-19-audit (bundles into pending paste).

## Bot-improvement sprint (2026-06-26) — autonomous tasks BOT-A..C
| Task | Result |
|---|---|
| BOT-A income detection round 3 | corpus 88.9% → 92.2% (Rules H-M: customer-paid, invoice-to-customer, money-came-in, earned, revenue nouns; קיבלנו; \b-bug; שביטלתי guard) — commit 7158731 |
| BOT-B keyword-collision audit | bot routing CLEAN — 22k-keyword sweep, only 3 borderline (all defensible), no genuine wrong routes after אומגה/קונסולה (125df89) |
| BOT-C amount edges | bare Hebrew thousands (אלף/אלפיים/אלף וחצי) were null=LOST → now parsed; corpus → 92.5% — commit 9a4f074 |
| Final | corpus **92.5%** (1101/1190), 0 disappeared-money, 8 bot suites green (437 checks), build 2026-06-26-hebnum |

OPEN next-tasks: BOT-D (fleet coverage round for unrecognized terms), multi-item NOISE-number over-extraction (model/version/qty numbers counted as amounts: "אקסל 365"→964, "קמפיין יד2 1200"→1202, "קניתי 200 כוסות 90"→290), FX+k ("1.5k דולר" lost the k).
