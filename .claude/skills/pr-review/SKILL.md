---
name: pr-review
description: Pre-commit / pre-PR review checklist for the Kesefle repo. Use before committing or opening a PR to systematically catch bugs, regressions, isolation breaks, and secrets in the diff.
---

# Pre-commit / PR review

Run this before every commit that touches code.

## 1. See the diff
```
git --no-pager diff --cached --stat
git --no-pager diff --cached
```

## 2. Correctness & edge cases
- Does the change do what the message claims?
- Null/empty/oversized input; mixed Hebrew/English; RTL marks (U+200E/200F); 0 / negative amounts; missing KV keys; expired tokens.
- Any changed function signature — check ALL callers.

## 3. Tenant isolation (non-negotiable)
- New Sheets/KV write resolves phone → `user:{sub}` (token) → canonical `sheet:{sub}`.
- No non-owner write to the hardcoded `SHEET_ID`.
- Token only read from `user:{sub}`, never `phone:`.

## 4. Failure mode
- Network/throw/timeout fails SAFE (block + clear error), never fails open (silent wrong write).

## 5. Secrets
```
git --no-pager diff --cached | grep -nEi 'AIza|sk-[a-z0-9]|xox[baprs]-|-----BEGIN|client_secret|api[_-]?key\s*[:=]|bearer [a-z0-9]{20}' && echo "POSSIBLE SECRET — STOP" || echo "no obvious secret"
```

## 6. Tests must pass
```
node bot/test_classify.js && node bot/test_parser.js && node bot/test_isolation.js && node tests/full_qa.js
```
If a bot file changed: reassemble DEPLOY.gs first and `node --check` it.

## 7. Hygiene
- No commented-out code, no debug logs of PII, no backup files, no unused imports.

## Verdict
Only commit when: tests green, isolation intact, no secrets, edge cases handled. Otherwise fix first.
