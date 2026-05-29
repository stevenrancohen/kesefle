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

// ─── Extract CATEGORY_MAP (the const array of category objects) ───
function extractCategoryMap() {
  const re = /const\s+CATEGORY_MAP\s*=\s*\[[\s\S]*?\n\];/;
  const m = SRC.match(re);
  if (!m) throw new Error('CATEGORY_MAP not found');
  // Rewrite const → var so it leaks into the vm context.
  return m[0].replace(/^const\s+/m, 'var ');
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
  console,
};

const code = [
  matMatch[0],
  extractCategoryMap(),
  extractFn('parseBusinessOrder_') || '',
  extractFn('_parseBusinessNumberPrefix_') || '',
  extractFn('matchCategory') || '',
  // Export the things we want to use
  'this.__bot = { parseBusinessOrder_, _parseBusinessNumberPrefix_, matchCategory, CATEGORY_MAP };',
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

  // 1) Amount parse
  const amountMatch = text.match(/^([+-]?\d+(?:[.,]\d+)?)\s+(.+)$/) ||
                      text.match(/(\d+(?:[.,]\d+)?)\s*([֐-׿]+)/);
  out.decisions.amountMatch = amountMatch ? {
    amount: parseFloat((amountMatch[1] || '').replace(',', '')),
    rest: amountMatch[2] || '',
    leadChar: amountMatch[1] ? amountMatch[1].charAt(0) : null,
  } : null;

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

  // 4) Categorize
  if (typeof bot.matchCategory === 'function') {
    try {
      const matched = bot.matchCategory(text);
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
  if (/^עסק/.test(text) &&
      out.decisions.parseBusinessOrder && !out.decisions.parseBusinessOrder.matched &&
      out.decisions.businessN && !out.decisions.businessN.matched) {
    out.risk_notes.push('עסק prefix but no order/biz-N match — will fall through to personal');
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
