---
name: kesefle-bot-conversation-audit
description: Replay a curated set of Hebrew bot messages through the actual bot logic (no live writes) and assert each produces the expected category/sub/dashboard-row/reply-text.
---

# kesefle-bot-conversation-audit

When invoked: run synthetic bot conversations against the real source (loaded via balanced-brace extraction, no mock framework).

## Test corpus (minimum)

Each test asserts: target sheet, target tab, target category, target subcategory, expected reply pattern.

| Input | Tab | Cat | Sub | Notes |
|---|---|---|---|---|
| `50 קפה` | תנועות | אוכל | קפה | personal |
| `245 סופר` | תנועות | אוכל | סופר | personal |
| `עסק 35 שיווק` | תנועות | עסק | עלות שיווק | canonical sub (PR #129) |
| `עסק הכנסה 10000` | תנועות | עסק | מחזור | revenue |
| `טסט רכב 1200` | תנועות | תחבורה | טסט/רישוי | should activate car block |
| `גן ילדים 1800` | תנועות | חינוך | גן ילדים | should activate kids block |
| `וטרינר 350` | תנועות | בריאות | חיות מחמד | should suggest activating pets profile |
| `תקציב אוכל 2000` | (budget) | אוכל | (KV write) | NOT a תנועות row |
| `עסקה יוסי הכנסה 10000 עובדים 2500 חומרים 1200` | הזמנות | עסק | (multi-field order) | net profit derived |
| `2000` | (clarify) | (n/a) | (n/a) | NOT parsed as "2" — guard PR #67 |
| `עסק 35 שיווק` after stale pending | תנועות | עסק | עלות שיווק | hijack guard fires |
| `50 קופה` (typo) | (clarify) | (n/a) | (n/a) | should ASK, not write |

## Pass criteria
- 100% expected target match
- 0 writes during the audit (the audit replays parsing only, never invokes the actual write)
- Pending-clarification fires when expected

## Outputs
- `bot-conversation-audit-{YYYY-MM-DD}.md` with per-test PASS/FAIL + diff if FAIL
- Exit code 0/1

## Hard NO
- No live bot writes
- No KV mutations
- No sheet calls
