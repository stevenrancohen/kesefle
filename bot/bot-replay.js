#!/usr/bin/env node
// bot/bot-replay.js
//
// Bot Replay CLI — feed a sample message to the parser + classifier and
// print the predicted target sheet, tab, category, subcategory, dashboard
// row, isIncome, and reply pattern WITHOUT making any live writes or LLM
// calls.
//
// Usage:
//   node bot/bot-replay.js "50 קפה"
//   node bot/bot-replay.js "עסק 35 שיווק"
//   node bot/bot-replay.js "עסקה יוסי הכנסה 10000 עובדים 2500 חומרים 1200"
//   node bot/bot-replay.js --json "245 סופר"
//
// Hard rule: this tool is READ-ONLY. It uses the same balanced-brace
// extraction pattern as bot/test_*.js to load the REAL source (no mocks)
// and runs the classify + parser logic locally. It NEVER opens a sheet,
// hits the bot endpoint, or invokes Apps Script.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, 'ExpenseBot_FIXED.gs');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

// ─── Balanced-brace function extraction (same pattern as bot/test_*.js) ───
function extractFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let i = SRC.indexOf('{', start), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return SRC.slice(start, j);
}

// ─── Balanced-bracket block extraction (for nested object/array literals like
// BUSINESS_CATEGORY_MAP and the CATEGORY_MAP array). Loads the REAL source by
// scanning from the declaration's opening bracket to its matching close, the
// same approach bot/test_*.js + tests/golden_set.js use. ───
function extractDecl(declStartMarker, open, close, rename) {
  const s = SRC.indexOf(declStartMarker);
  if (s < 0) throw new Error('declaration not found: ' + declStartMarker);
  let i = SRC.indexOf(open, s), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === open) depth++;
    else if (SRC[j] === close) { depth--; if (depth === 0) { j++; break; } }
  }
  // Include the trailing ";" if present so the statement is complete.
  if (SRC[j] === ';') j++;
  let block = SRC.slice(s, j);
  if (rename) block = block.replace(rename.from, rename.to);
  return block;
}

// ─── Extract CATEGORY_MAP (the const array of category objects) ───
function extractCategoryMap() {
  // const CATEGORY_MAP = [ ... ];  → rewrite const → var so it leaks into the vm.
  return extractDecl('const CATEGORY_MAP = [', '[', ']', { from: /^const\s+/, to: 'var ' });
}

// ─── C34 (2026-11-03) harness-fidelity helpers ───
// Optional declaration: '' when the marker is absent (older sources), so the
// replay keeps loading instead of throwing.
function extractOptionalDecl(marker, open, close, rename) {
  try { return extractDecl(marker, open, close, rename); } catch (e) { return ''; }
}
// The repo-integrated C33 special-business block (music / ecom routing) is a run
// of top-level vars + functions that sits immediately before matchCategory().
// Load it verbatim so every `typeof _kflSpecialBusinessRoute_ === 'function'`
// guard in matchCategory / the bare-business detector is TRUE here, exactly as
// in production. Returns '' when the block is absent.
function extractSpecialBusinessBlock() {
  const s = SRC.indexOf('// SPECIAL BUSINESS ROUTING (C33, repo-integrated)');
  if (s < 0) return '';
  const e = SRC.indexOf('function matchCategory(text)', s);
  return e > s ? SRC.slice(s, e) : '';
}
// processExpense's C34 עסק-prefix guard is inline code (not a function), so the
// replay detects it by its exact source line and models it below. If someone
// removes the guard, the replay goes back to predicting the numbered picker for
// "עסק מוזיקה …" / "עסק ecom …" and bot/test_c34_special_business_flow.js fails.
const C34_PREFIX_GUARD_SRC = "if (__hStartsBiz && typeof _kflSpecialBusinessRoute_ === 'function' && _kflSpecialBusinessRoute_(__hT)) {";
const HAS_C34_PREFIX_GUARD = SRC.indexOf(C34_PREFIX_GUARD_SRC) >= 0;

// ─── Extract _ORDER_MATERIALS_ ───
const matMatch = SRC.match(/var _ORDER_MATERIALS_ = \[[^\]]+\];/);
if (!matMatch) throw new Error('_ORDER_MATERIALS_ not found');

// ─── Build a vm.Script with all dependencies, run in a sandbox ───
const sandbox = {
  // Apps Script globals stubbed so any incidental reference doesn't crash
  SpreadsheetApp: { openById: () => { throw new Error('NEVER CALL LIVE'); } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  Logger: { log: () => {} },
  Utilities: { computeDigest: () => [] },
  // NOTE: CacheService and UrlFetchApp are deliberately LEFT UNDEFINED. The FX
  // live-rate path (_kfl_fxRateLive_) guards on `typeof UrlFetchApp` and skips
  // the network when it is undefined, so the replay stays 100% offline and
  // deterministic: it falls back to the hardcoded KFL_FX_DEFAULTS rate. This
  // keeps bot-replay.js read-only and network-free per its hard rule.
  console,
};

// matchCategory depends on BUSINESS_CATEGORY_MAP + DEFAULT_CATEGORY + the
// _matchCategory_long / _matchCategory_orig / _kflKwHit_ / _kflIsWordChar_ /
// _coerceCategoryBySubcategory chain. Load them ALL from the real source (no
// mock) so node bot/bot-replay.js prints a real matchCategory result, and load
// the new _classifyBareBusinessExpense_ + _normalizeBizSub_ + _BIZ_DASH_SUBS so
// the replay can show the bare-business routing too.
const code = [
  matMatch[0],
  extractCategoryMap(),
  extractDecl('var BUSINESS_CATEGORY_MAP = {', '{', '}'),
  extractDecl('const DEFAULT_CATEGORY =', '{', '}', { from: /^const\s+/, to: 'var ' }),
  extractDecl('var _BIZ_DASH_SUBS = {', '{', '}'),
  extractFn('_kflIsWordChar_') || '',
  extractFn('_kflKwHit_') || '',
  extractFn('_matchCategory_orig') || '',
  extractFn('_matchCategory_long') || '',
  extractFn('_coerceCategoryBySubcategory') || '',
  extractFn('_normalizeBizSub_') || '',
  extractFn('parseBusinessOrder_') || '',
  extractFn('_parseBusinessNumberPrefix_') || '',
  // C34 (2026-11-03): matchCategory calls _kflBizOpHit_ UNGUARDED for bare
  // "עסק …" texts (it scans the 8k-entry KFL_BIZ_OP_SET brand list). Without
  // these two the replay threw a ReferenceError on such texts.
  extractOptionalDecl('var KFL_BIZ_OP_SET = {', '{', '}'),
  extractFn('_kflBizOpHit_') || '',
  // C34: the repo-integrated C33 music / ecom routing block (see helper above).
  extractSpecialBusinessBlock(),
  // C34: the bare-business write path canonicalizes col E with
  // _normalizeSubForDashboard_(sub, 'עסק'); load it (+ its row tables) so the
  // replay reports the subcategory that is actually written.
  extractOptionalDecl('var _KFL_PERSONAL_DASH_ROWS = [', '[', ']'),
  (SRC.match(/var _KFL_PERSONAL_INCOME_ROWS = [^;]+;/) || [''])[0],
  extractOptionalDecl('var _KFL_SUB_TO_DASHBOARD_ROW = {', '{', '}'),
  extractFn('_normalizeSubForDashboard_') || '',
  extractFn('matchCategory') || '',
  extractFn('_classifyBareBusinessExpense_') || '',
  // Sign resolver (2026-06-24 harness-fidelity fix): the real write path resolves
  // col-H via _resolveIsIncome_(matched, rawText, cat, sub), NOT just
  // matched.isIncome. Load it + its helper so the replay's sign column mirrors
  // production for NL "money received" phrasings ("שילמו לי", "קיבלתי X מ<Y>").
  extractFn('_isIncomeCategory_') || '',
  extractFn('_resolveIsIncome_') || '',
  // FX conversion chain (2026-06-04) so the replay exercises the SAME foreign-
  // currency path processExpense uses: parseForeignCurrencyHint -> convert ->
  // classify on the cleaned (currency-stripped) description. _kfl_fxRateLive_ is
  // a no-op offline (UrlFetchApp is undefined in this sandbox), so rates come
  // from KFL_FX_DEFAULTS. Pull the REAL defaults straight from the source so the
  // replay never drifts from the production static floor.
  (SRC.match(/var KFL_FX_DEFAULTS = \{[\s\S]*?\};/) || ['var KFL_FX_DEFAULTS = { USD: 2.91 };'])[0],
  extractFn('_kfl_fxRateLive_') || '',
  extractFn('_kfl_fxRate') || '',
  extractFn('_kfl_fxLookup') || '',
  extractFn('_kfl_fxNote_') || '',
  extractFn('_kfl_currencyDisplay_') || '',
  extractFn('_kfl_nonAdjacentCurrency_') || '',
  extractFn('parseForeignCurrencyHint') || '',
  // Amount parser chain (2026-06-07). Load the REAL parseAmountAndDescription +
  // its _parseIsraeliNumber_ helper from source so the replay's amount preview
  // matches EXACTLY what the bot writes (multi-amount "50+30 קפה", Israeli
  // 1,200 grouping, phone-number guard, ₪/שח stripping) instead of an inline
  // regex approximation. Both are pure string functions with no Apps Script
  // global dependency, so they run cleanly in this offline sandbox.
  extractFn('_parseIsraeliNumber_') || '',
  extractFn('parseAmountAndDescription') || '',
  // Export the things we want to use
  'this.__bot = { parseBusinessOrder_, _parseBusinessNumberPrefix_, matchCategory, _classifyBareBusinessExpense_, parseForeignCurrencyHint, parseAmountAndDescription, _resolveIsIncome_, _isIncomeCategory_, CATEGORY_MAP, BUSINESS_CATEGORY_MAP, _normalizeSubForDashboard_: (typeof _normalizeSubForDashboard_ === "function" ? _normalizeSubForDashboard_ : null), _kflSpecialBusinessRoute_: (typeof _kflSpecialBusinessRoute_ === "function" ? _kflSpecialBusinessRoute_ : null) };',
].join('\n\n');

vm.createContext(sandbox);
let loadError = null;
try {
  vm.runInContext(code, sandbox);
} catch (e) {
  loadError = e.message;
}

const bot = sandbox.__bot || {};

// ─── Legacy numbered business PICKER model (C34, 2026-11-03) ───
// Pure model of processExpense's `if (__hStartsBiz) { … }` branch (runs only
// when neither the bare-business detector nor the rich-order parser fired).
// Returns { shown, amount, reason }. `shown` = the bot replies with the numbered
// "🏢 עסק — ₪<raw amount>" menu and writes NOTHING until the user picks — the raw
// amount is used as-is (no FX), which is why a "$" message must never land here.
function predictBizPicker(t) {
  const am = t.replace(/,/g, '').match(/(?:^|[\s:\-])([0-9]+(?:\.[0-9]+)?)/);
  const a = am ? parseFloat(am[1]) : null;
  if (!(a && a > 0)) return { shown: false, amount: null, reason: 'no amount: falls through to the normal flow' };
  const rest = t.replace(/^(עסק|biz|business)(?=$|[\s:\-,0-9])/i, '').replace(String(a), '').replace(/[,\-:\s]+/g, ' ').trim();
  if (!(rest && rest.length >= 2)) return { shown: true, amount: a, reason: 'bare numbered picker (no description)' };
  let m = null;
  try { m = bot.matchCategory ? bot.matchCategory(t) : null; } catch (e) { m = null; }
  const isDefault = !!(m && m.subcategory === 'הוצאות תפעוליות');
  let found = false;
  const tl = t.toLowerCase();
  const map = bot.BUSINESS_CATEGORY_MAP || {};
  outer: for (const c in map) {
    for (const sub in map[c]) {
      const kws = map[c][sub] || [];
      for (let i = 0; i < kws.length; i++) {
        if (tl.indexOf(String(kws[i]).toLowerCase()) >= 0) { found = true; break outer; }
      }
    }
  }
  if (found && m && !isDefault) return { shown: false, amount: a, reason: 'business keyword + non-default match: falls through to the normal flow' };
  return { shown: true, amount: a, reason: 'numbered business picker (raw amount ' + a + ', no FX); nothing is written until the user picks' };
}

// ─── Replay one message ───
function replay(input) {
  const text = String(input || '').trim();
  const out = {
    input: text,
    timestamp: new Date().toISOString(),
    decisions: {},
    load_error: loadError,
  };

  if (!text) {
    out.decisions.fatal = 'empty input';
    return out;
  }

  // −1) עסק-prefix handling, mirroring processExpense (C34, 2026-11-03).
  // processExpense runs the bare-business detector and the rich-order parser on
  // the RAW text first. When neither fires and the message starts with
  // עסק / biz / business it then either
  //   (a) [C34 guard] strips the prefix of a music / ecom message and continues
  //       the normal flow (FX → amount → classify) on the STRIPPED text (the repo
  //       replacement for the live ZZ SRC_ROUTER_handle pre-clean), or
  //   (b) shows the legacy numbered business PICKER (raw amount, no FX, nothing
  //       written until the user picks), modelled by predictBizPicker().
  // flowText is what the normal flow sees; order / עסק-N / bare-business keep
  // using the raw `text`, like production.
  let flowText = text;
  if (/^(עסק|biz|business)(?=$|[\s:\-,0-9])/i.test(text)) {
    // "עסק <N> …" is owned by the doPost numbered-business router (owner-only),
    // which runs before processExpense; such messages never reach this branch.
    let preOrder = null, preBbe = null, preBizN = null;
    try { preBizN = bot._parseBusinessNumberPrefix_ ? bot._parseBusinessNumberPrefix_(text) : null; } catch (e) { preBizN = null; }
    try { preOrder = bot.parseBusinessOrder_ ? bot.parseBusinessOrder_(text) : null; } catch (e) { preOrder = null; }
    try { preBbe = bot._classifyBareBusinessExpense_ ? bot._classifyBareBusinessExpense_(text) : null; } catch (e) { preBbe = null; }
    if (!preBizN && !preOrder && !preBbe) {
      let special = null;
      try { special = bot._kflSpecialBusinessRoute_ ? bot._kflSpecialBusinessRoute_(text) : null; } catch (e) { special = null; }
      if (special && HAS_C34_PREFIX_GUARD) {
        flowText = text.replace(/^(עסק|biz|business)\s*[:\-–—]?\s*/i, '').trim() || text;
        out.decisions.bizPrefixGuard = { applied: true, strippedText: flowText, route: special.category + ' / ' + special.subcategory };
      } else {
        out.decisions.bizPicker = predictBizPicker(text);
      }
    }
  }

  // 0) Foreign-currency (FX) conversion -- runs FIRST, exactly like
  // processExpense (const fx = parseForeignCurrencyHint(text)). When it fires,
  // the AMOUNT becomes the converted ILS value and the DESCRIPTION used for
  // classification is fx.cleanedText (currency word + number stripped), so the
  // classifier sees just the merchant/keyword text. Offline the rate comes from
  // the hardcoded KFL_FX_DEFAULTS (no network in this sandbox).
  let classifyText = flowText;
  if (typeof bot.parseForeignCurrencyHint === 'function') {
    try {
      const fx = bot.parseForeignCurrencyHint(flowText);
      if (fx) {
        out.decisions.fx = {
          autoConverted: !!fx.autoConverted,
          foreignAmount: fx.foreignAmount != null ? fx.foreignAmount : null,
          foreignSymbol: fx.foreignSymbol || null,
          fxRate: fx.fxRate != null ? fx.fxRate : null,
          ilsAmount: fx.ilsAmount != null ? fx.ilsAmount : null,
          cleanedText: fx.cleanedText || '',
          note: fx.note || '',
          rate_source: 'KFL_FX_DEFAULTS (offline replay; live API used in prod)',
        };
        // Mirror processExpense: parseAmountAndDescription(fx.ilsAmount + ' ' + fx.cleanedText)
        if (fx.autoConverted && fx.cleanedText) classifyText = fx.cleanedText;
      } else {
        out.decisions.fx = null;
      }
    } catch (e) {
      out.decisions.fx = { error: e.message };
    }
  }

  // 1) Amount parse — use the REAL parseAmountAndDescription so the preview
  // matches what the bot actually writes (multi-amount, Israeli 1,200 grouping,
  // phone-number guard, ₪/שח stripping). Mirror processExpense's FX path: when
  // FX auto-converted, the bot parses `fx.ilsAmount + ' ' + fx.cleanedText`,
  // otherwise the raw text. items[] carries one {amount, description} per
  // detected amount; amountMatch reports the first plus the full list.
  if (typeof bot.parseAmountAndDescription === 'function') {
    try {
      const fxDec = out.decisions.fx;
      const amountText = (fxDec && fxDec.autoConverted && fxDec.cleanedText)
        ? (fxDec.ilsAmount + ' ' + fxDec.cleanedText)
        : flowText;
      const parsed = bot.parseAmountAndDescription(amountText);
      const items = (parsed && Array.isArray(parsed.items)) ? parsed.items : [];
      out.decisions.amountMatch = items.length ? {
        source: 'parseAmountAndDescription (real bot parser)',
        amount: items[0].amount,
        rest: items[0].description || '',
        items: items.map(function (it) { return { amount: it.amount, description: it.description }; }),
      } : null;
    } catch (e) {
      out.decisions.amountMatch = { error: e.message, source: 'parseAmountAndDescription (real bot parser)' };
    }
  } else {
    // Fallback only if the parser could not be extracted from source. This
    // inline regex is an APPROXIMATION (single amount, no multi-amount /
    // grouping / phone-guard) — use the bot for exact amounts.
    const amountMatch = text.match(/^([+-]?\d+(?:[.,]\d+)?)\s+(.+)$/) ||
                        text.match(/(\d+(?:[.,]\d+)?)\s*([֐-׿]+)/);
    out.decisions.amountMatch = amountMatch ? {
      source: 'inline regex (APPROXIMATE — parser not loaded; use the bot for exact amounts)',
      amount: parseFloat((amountMatch[1] || '').replace(',', '')),
      rest: amountMatch[2] || '',
      leadChar: amountMatch[1] ? amountMatch[1].charAt(0) : null,
    } : null;
  }

  // 2) Business order parse
  if (typeof bot.parseBusinessOrder_ === 'function') {
    try {
      const order = bot.parseBusinessOrder_(text);
      if (order) {
        out.decisions.parseBusinessOrder = {
          matched: true,
          salePrice: order.salePrice || null,
          productionCost: order.productionCost || null,
          shipping: order.shipping || null,
          customer: order.customer || null,
          material: order.material || null,
          profit: order.profit || null,
        };
        out.predicted_target = {
          sheet: 'OWNER (or per-tenant)',
          tab: 'הזמנות',
          dashboard_row: 'מאזן חברה revenue + per-sub expense',
        };
        return out;
      } else {
        out.decisions.parseBusinessOrder = { matched: false };
      }
    } catch (e) {
      out.decisions.parseBusinessOrder = { error: e.message };
    }
  } else {
    out.decisions.parseBusinessOrder = { _not_loaded: true };
  }

  // 3) עסק N prefix parse
  if (typeof bot._parseBusinessNumberPrefix_ === 'function') {
    try {
      const pref = bot._parseBusinessNumberPrefix_(text);
      if (pref) {
        out.decisions.businessN = {
          matched: true,
          n: pref.n,
          name: pref.name,
          rest: pref.rest,
        };
        out.predicted_target = out.predicted_target || {
          sheet: 'OWNER (or per-tenant)',
          tab: 'תנועות (routed via _writeBusinessNExpense_)',
          dashboard_row: 'מאזן חברה for biz ' + pref.n,
        };
      } else {
        out.decisions.businessN = { matched: false };
      }
    } catch (e) {
      out.decisions.businessN = { error: e.message };
    }
  } else {
    out.decisions.businessN = { _not_loaded: true };
  }

  // 3.5) Bare business expense detector (2026-06-01). Runs only when neither the
  // rich order nor עסק-N matched. Mirrors processExpense: forces category=עסק
  // with a canonical dashboard bucket and writes directly (no personal dropdown).
  const orderMatched = out.decisions.parseBusinessOrder && out.decisions.parseBusinessOrder.matched;
  const bizNMatched = out.decisions.businessN && out.decisions.businessN.matched;
  if (typeof bot._classifyBareBusinessExpense_ === 'function' && !orderMatched && !bizNMatched) {
    try {
      const bbe = bot._classifyBareBusinessExpense_(text);
      if (bbe) {
        out.decisions.bareBusiness = {
          matched: true,
          amount: bbe.amount,
          category: bbe.category,
          subcategory: bbe.subcategory,
          cleanedDesc: bbe.cleanedDesc,
        };
        // C34: col E is written as _normalizeSubForDashboard_(sub, 'עסק') (the
        // company-dashboard bucket), not the raw detector phrase.
        let bbeSub = bbe.subcategory;
        try { if (bot._normalizeSubForDashboard_) bbeSub = bot._normalizeSubForDashboard_(bbe.subcategory, 'עסק') || bbe.subcategory; } catch (e) { bbeSub = bbe.subcategory; }
        out.predicted_target = {
          sheet: 'OWNER (single business → col D=עסק)',
          tab: 'תנועות',
          category: bbe.category,
          subcategory: bbeSub,
          subcategory_raw: bbe.subcategory,
          isIncome: !!bbe.isIncome,
          col_H_expected: bbe.isIncome ? 'FALSE (income)' : 'TRUE (expense)',
          dashboard_row: 'מאזן חברה (עסק) / ' + bbeSub,
        };
      } else {
        out.decisions.bareBusiness = { matched: false };
      }
    } catch (e) {
      out.decisions.bareBusiness = { error: e.message };
    }
  }

  // 4) Categorize. When FX auto-converted, classify on the CLEANED description
  // (currency word + number stripped) exactly like processExpense does, so the
  // reported category matches what the bot will actually write.
  if (typeof bot.matchCategory === 'function') {
    try {
      // HARNESS FIDELITY (2026-06-24): the real write loop classifies on the
      // AMOUNT-STRIPPED per-item description (matchCategorySmart(item.description)),
      // NOT the raw text. With the amount inline, substring keywords like
      // "קיבלתי מלקוח" break and the matcher falls to DEFAULT -> false-positive
      // sign/category misroutes. Classify on items[0].description; fall back to
      // the FX-cleaned/raw text only when no amount was parsed.
      const _amItems = (out.decisions.amountMatch && Array.isArray(out.decisions.amountMatch.items)) ? out.decisions.amountMatch.items : [];
      const classifyInput = _amItems.length ? (_amItems[0].description || classifyText) : classifyText;
      if (classifyInput !== text) out.decisions.classifyText = classifyInput;
      const matched = bot.matchCategory(classifyInput);
      out.decisions.matchCategory = matched || null;
      // C34: when the bare-business detector fired, processExpense has already
      // written the row and returned; matchCategory is informational only.
      const bbeWrote = !!(out.decisions.bareBusiness && out.decisions.bareBusiness.matched);
      if (matched && !bbeWrote) {
        out.predicted_target = out.predicted_target || {
          sheet: 'OWNER (or per-tenant)',
          tab: 'תנועות',
        };
        out.predicted_target.category = matched.category;
        out.predicted_target.subcategory = matched.subcategory;
        // Resolve the SIGN exactly like the real write path: _resolveIsIncome_
        // applies NL "money received" overrides ("שילמו לי", "קיבלתי X מ<Y>",
        // refunds) even when the category matcher landed on a non-income bucket.
        // rawText = the original message (single-item production path). Additive:
        // the resolver itself is unchanged.
        const _sign = (typeof bot._resolveIsIncome_ === 'function')
          ? bot._resolveIsIncome_(matched, flowText, matched.category, matched.subcategory)
          : !!matched.isIncome;
        out.predicted_target.isIncome = !!_sign;
        out.predicted_target.col_H_expected = _sign ? 'FALSE (income)' : 'TRUE (expense)';
        out.predicted_target.dashboard_row = matched.category + ' / ' + matched.subcategory;
      }
    } catch (e) {
      out.decisions.matchCategory = { error: e.message };
    }
  } else {
    out.decisions.matchCategory = { _not_loaded: true };
  }

  // 5) Risk notes
  out.risk_notes = [];
  if (out.decisions.bizPicker && out.decisions.bizPicker.shown) {
    out.risk_notes.push('Numbered business PICKER would be shown (raw amount, no FX): nothing is written until the user picks');
    if (out.predicted_target) out.predicted_target.blocked_by_picker = true;
  }
  if (out.decisions.matchCategory && out.decisions.matchCategory.isIncome) {
    out.risk_notes.push('Income detected — verify col H = FALSE (B1 fix pending)');
  }
  // A bare "עסק [name] [amount] [token]" message is now caught by the
  // bare-business detector and routed to category=עסק. Only warn about a fall-
  // through to personal if that detector ALSO declined (e.g. no amount).
  if (/(^|\s)עסק(\s|$)/.test(text) &&
      out.decisions.parseBusinessOrder && !out.decisions.parseBusinessOrder.matched &&
      out.decisions.businessN && !out.decisions.businessN.matched &&
      !(out.decisions.bareBusiness && out.decisions.bareBusiness.matched)) {
    out.risk_notes.push('עסק prefix but no order/biz-N/bare-business match — may fall through to personal');
  }
  if (out.decisions.matchCategory && out.decisions.matchCategory.subcategory === 'שונות') {
    out.risk_notes.push('Default subcategory שונות — bot should ASK before writing (task #189)');
  }

  return out;
}

// ─── CLI ───
function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node bot/bot-replay.js [--json] "<message>"');
    console.log('Examples:');
    console.log('  node bot/bot-replay.js "50 קפה"');
    console.log('  node bot/bot-replay.js "עסק 35 שיווק"');
    console.log('  node bot/bot-replay.js --json "245 סופר"');
    process.exit(args.length ? 0 : 1);
  }

  const jsonMode = args.includes('--json');
  const input = args.filter(a => a !== '--json').join(' ');

  const result = replay(input);

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log('═════════════════════════════════════════════════════════════');
  console.log('  BOT REPLAY — ' + result.input);
  console.log('═════════════════════════════════════════════════════════════');
  console.log('');

  if (result.load_error) {
    console.log('⚠️  source load error: ' + result.load_error);
    console.log('');
  }

  if (result.predicted_target) {
    console.log('PREDICTED TARGET:');
    console.log('  sheet:        ' + (result.predicted_target.sheet || '?'));
    console.log('  tab:          ' + (result.predicted_target.tab || '?'));
    console.log('  category:     ' + (result.predicted_target.category || '?'));
    console.log('  subcategory:  ' + (result.predicted_target.subcategory || '?'));
    console.log('  isIncome:     ' + (result.predicted_target.isIncome === true ? 'TRUE' : result.predicted_target.isIncome === false ? 'FALSE' : '?'));
    console.log('  col H:        ' + (result.predicted_target.col_H_expected || '?'));
    console.log('');
  }

  console.log('DECISIONS:');
  for (const k of Object.keys(result.decisions)) {
    const v = result.decisions[k];
    if (typeof v === 'object' && v !== null) {
      console.log('  ' + k + ': ' + JSON.stringify(v).slice(0, 200));
    } else {
      console.log('  ' + k + ': ' + v);
    }
  }
  console.log('');

  if (result.risk_notes && result.risk_notes.length) {
    console.log('⚠️  RISK NOTES:');
    result.risk_notes.forEach(n => console.log('  - ' + n));
    console.log('');
  }

  console.log('NO LIVE WRITES PERFORMED.');
  console.log('');
}

if (require.main === module) main();
module.exports = { replay };
