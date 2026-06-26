# Bot parser — multi-item NOISE-number over-extraction (BOT-F spec)

Status: **SPEC'd + DEFERRED** (load-bearing money code; needs golden-gate, not a
rushed patch). Investigated 2026-06-26 via `scripts/wa-sim.js`.

## The bug
`parseAmountAndDescription` sometimes books a model/version/quantity number as the
amount instead of the real price:

| Message | got | want | noise source |
|---|---|---|---|
| `קמפיין יד2 1200` | 2 | 1200 | `יד2` brand — the glued `2` |
| `אקסל 365 מנוי 599` | 365 | 599 | `Office/Excel 365` version |
| `office 365 מנוי 599` | 365 | 599 | `Microsoft 365` version |
| `קניתי 200 כוסות 90` | 200 | 90 | quantity before a counted noun |
| `קניתי 50 כסאות 3750` | 50 | 3750 | quantity (50 chairs) |
| `קמפיין יד2 1200` (corpus) | 1202 | 1200 | glued `2` summed as a 2nd item |

## Why a naive fix is WRONG (the key finding)
The noise numbers are **entangled with classification keywords**:
- `office 365`, `microsoft 365`, `מיקרוסופט 365`, `yad2`, `יד2` are all CATEGORY_MAP
  keywords (verified: 5+4+1 `365` product keywords, 6 `yad2`, 3 `יד2`).
- Stripping `365` / the glued `2` from the working text would also strip it from the
  **description** that feeds `matchCategory`, so `אקסל 365 מנוי` might stop routing to
  אפליקציות. (Classification currently still works — only the amount is wrong.)

So the fix must NOT edit the text. It must **mask the character spans of matched
product keywords from the number scan only**, leaving the description intact for
classification.

## Correct approach (gated)
1. After keyword matching identifies which CATEGORY_MAP keyword matched (and its
   span in the message), record that `[start,end)` span.
2. In the number scanner, **skip any numeric token whose digits fall inside a matched
   keyword span** (so the `365` in `office 365` and the `2` in `יד2` are never
   candidate amounts). This already-known span makes it deterministic — no new
   heuristic, no threshold.
3. Quantity-before-counted-noun (`200 כוסות 90`, `50 כסאות 3750`): SEPARATE, riskier.
   The existing guard only drops SMALL counts (2/3/8) because raising the threshold
   risks dropping a real amount (`200 שח קפה` is a real 200). Option: drop a leading
   count of ANY size **only when** immediately followed by a plural counted-unit noun
   AND a trailing price exists. Needs a curated counted-noun list + heavy golden tests.
   Keep separate from (1)/(2); ship only if it survives the full parser suite + corpus.

## Gate (do NOT ship without)
- `node bot/test_parser.js` (75) + `test_amount_extraction` + `test_classify` (177) all green.
- wa-sim corpus accuracy must not drop (currently 92.5%) and `disappeared-money` stays 0.
- Add explicit regression cases for every row in the table above AND for the
  must-not-regress controls: `200 שח קפה` (real 200), `קפה 5 עוגה 50` (two expenses),
  `office 365`→still אפליקציות, `יד2`→still עסק/שיווק.

## Why deferred now
A wrong amount is logged money. The fix touches the parser's number↔keyword
interaction — the single most failure-prone area. It is well-scoped above; it should
be implemented deliberately behind the gate, not opportunistically.
