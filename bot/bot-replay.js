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
  extractFn('matchCategory') || '',
  extractFn('_classifyBareBusinessExpense_') || '',
  // FX conversion chain (2026-06-04) so the replay exercises the SAME foreign-
  // currency path processExpense uses: parseForeignCurrencyHint -> convert ->
  // classify on the cleaned (currency-stripped) description. _kfl_fxRateLive_ is
  // a no-op offline (UrlFetchApp is undefined in this sandbox), so rates come
  // from the hardcoded KFL_FX_DEFAULTS -- deterministic + network-free.
  'var KFL_FX_DEFAULTS = ' + JSON.stringify({ USD: 3.65, EUR: 3.95, GBP: 4.65, CAD: 2.65, AUD: 2.40, JPY: 0.024, CHF: 4.10 }) + ';',
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
  'this.__bot = { parseBusinessOrder_, _parseBusinessNumberPrefix_, matchCategory, _classifyBareBusinessExpense_, parseForeignCurrencyHint, parseAmountAndDescription, CATEGORY_MAP };',
].join('\n\n');

vm.createContext(sandbox);
let loadError = null;
try {
  vm.runInContext(code, sandbox);
} catch (e) {
  loadError = e.message;
}

const bot = sandbox.__bot || {};

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

  // 0) Foreign-currency (FX) conversion -- runs FIRST, exactly like
  // processExpense (const fx = parseForeignCurrencyHint(text)). When it fires,
  // the AMOUNT becomes the converted ILS value and the DESCRIPTION used for
  // classification is fx.cleanedText (currency word + number stripped), so the
  // classifier sees just the merchant/keyword text. Offline the rate comes from
  // the hardcoded KFL_FX_DEFAULTS (no network in this sandbox).
  let classifyText = text;
  if (typeof bot.parseForeignCurrencyHint === 'function') {
    try {
      const fx = bot.parseForeignCurrencyHint(text);
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
        : text;
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
        out.predicted_target = {
          sheet: 'OWNER (single business → col D=עסק)',
          tab: 'תנועות',
          category: bbe.category,
          subcategory: bbe.subcategory,
          isIncome: !!bbe.isIncome,
          col_H_expected: bbe.isIncome ? 'FALSE (income)' : 'TRUE (expense)',
          dashboard_row: 'מאזן חברה (עסק) / ' + bbe.subcategory,
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
      if (classifyText !== text) out.decisions.classifyText = classifyText;
      const matched = bot.matchCategory(classifyText);
      out.decisions.matchCategory = matched || null;
      if (matched) {
        out.predicted_target = out.predicted_target || {
          sheet: 'OWNER (or per-tenant)',
          tab: 'תנועות',
        };
        out.predicted_target.category = matched.category;
        out.predicted_target.subcategory = matched.subcategory;
        out.predicted_target.isIncome = !!matched.isIncome;
        out.predicted_target.col_H_expected = matched.isIncome ? 'FALSE (income)' : 'TRUE (expense)';
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
