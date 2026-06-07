---
name: kesefle-fx-rate-source-audit
description: Audit the Kesefle bot FX-rate chain (FX_RATE_<code> Script Property -> hardcoded KFL_FX_DEFAULTS) and prove a missing rate fails safe; use before touching currency conversion or claiming a live-rate tier exists.
---

# Audit the FX-rate source chain

The bot converts "50$ amazon" with no ILS amount into a shekel row. The conversion lives in `bot/ExpenseBot_FIXED.gs` (`_kfl_fxRate`, `_kfl_fxLookup`, `parseForeignCurrencyHint`, table `KFL_FX_DEFAULTS`). Reality check first: the chain is TWO tiers, not three. There is `FX_RATE_<code>` Script Property override, then the hardcoded `KFL_FX_DEFAULTS` constant. There is NO Frankfurter call, no `UrlFetchApp` rate fetch, and no 6h CacheService rate layer anywhere in the repo. If a task or PR claims a "live rate cached 6h" source, that tier does not exist yet — audit what is real and flag the gap; do not document fiction.

## Steps
1. Locate the chain in `bot/ExpenseBot_FIXED.gs`: `grep -n "_kfl_fxRate\|KFL_FX_DEFAULTS\|_kfl_fxLookup\|parseForeignCurrencyHint" bot/ExpenseBot_FIXED.gs` (currently around 9684-9780).
2. Read `_kfl_fxRate(code)` and confirm the exact order: (a) read `PropertiesService...getProperty('FX_RATE_' + CODE)`, parse, accept only `!isNaN && n > 0`; (b) else fall back to `KFL_FX_DEFAULTS[CODE]`; (c) else return `null`. The `null` is the fail-safe — `parseForeignCurrencyHint` bails (`if (!rate) return null`) so an unknown currency is NEVER written at a wrong rate.
3. Prove no live-fetch tier is hiding: `grep -rni "frankfurter\|exchangerate\|fixer.io\|openexchange\|UrlFetchApp.*rate" bot/ lib/ api/ | grep -v "\.bak\.\|node_modules"` must return nothing. If it returns a hit, that is a new untested source — stop and review it.
4. Confirm the absent third tier is not silently half-wired: there must be no CacheService key for FX and no 6h TTL constant near the FX block. `grep -n "CacheService\|21600\|6 \* 60 \* 60" bot/ExpenseBot_FIXED.gs` lines near `KFL_FX_DEFAULTS` should be empty.
5. Cross-check the write contract: `node tests/test_currency_hardcoded_ils_contract.js` — it pins `currency:'ILS'` at the 3 write sites. The bot stamps the row ILS regardless of input symbol; the converted number, not the symbol, is what lands.
6. Verify the deploy twin: the same FX block must be present byte-for-byte in `bot/ExpenseBot_DEPLOY.gs` (reassembled per the `bot-deploy-paste` skill). `grep -c "KFL_FX_DEFAULTS" bot/ExpenseBot_DEPLOY.gs` should be >= 1. Deploy is a MANUAL Apps Script paste — a fix here ships only after Steven re-pastes.

## Verification
- `node bot/bot-replay.js --json "50$ amazon"` returns a `predicted_target` with the row converted via the default USD rate (3.65 -> ~182.5 ILS) and `col_H_expected` TRUE (expense). Re-run with `"50 שח amazon"` and confirm Path A (user-supplied ILS) bypasses conversion (`autoConverted:false`).
- Fail-safe proof: replay an unsupported code (e.g. `"50 sek ikea"`) and confirm it does NOT auto-convert (rate `null` -> falls through to normal parse/ask), so a missing rate never invents a number.
- Override proof (manual, Apps Script): set `FX_RATE_USD=4.00` in Script Properties; the bot's diagnostics line in `installKesefleBot()` should report `USD ... 4.00`. No redeploy needed — `_kfl_fxRate` reads fresh each call.
- `node tests/test_currency_hardcoded_ils_contract.js` PASS keeps the ILS write contract intact (it is a contract pin: if you intentionally add real multi-currency, you update this test on purpose).

## Common pitfalls
- Believing the "live Frankfurter cached 6h" tier exists. It does not. Auditing or asserting it will pass a fake check; the only real source is the Script Property override over the hardcoded table.
- Bumping `KFL_FX_DEFAULTS` and forgetting `bot/ExpenseBot_DEPLOY.gs` + the manual paste — the live bot keeps the old rate until Steven re-pastes. Bump `KFL_BUILD_VERSION` too (see `bot-version-bump`).
- Treating a `null` rate as a bug. Returning `null` (then not writing) is the safe path; the danger is a wrong number written silently, not a skipped conversion.
- Echoing a Script Property VALUE into logs/PRs/commits. Reference `FX_RATE_USD` by NAME only; never print the secret value (and never touch the owner phone 972547760643 or the OLD sheet 1UKrXDk... while in Apps Script Properties).
