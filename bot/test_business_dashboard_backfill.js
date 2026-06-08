#!/usr/bin/env node
// bot/test_business_dashboard_backfill.js (gauntlet auto-discovered)
// Locks the "שדרג עסקים" owner backfill (Steven 2026-06-08): upgrades existing
// bare business tabs to the full company dashboard. Structural + functional
// (stubs SpreadsheetApp; asserts it scans tabs, skips the main tab + dashboards,
// and calls _createBusinessDashboard_ only for un-dashboarded business tabs).
const fs = require('node:fs'), path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
function extract(name) {
  const i = SRC.indexOf('function ' + name + '(');
  let d = 0, st = false;
  for (let j = i; j < SRC.length; j++) { if (SRC[j] === '{') { st = true; d++; } else if (SRC[j] === '}') { d--; if (st && d === 0) return SRC.slice(i, j + 1); } }
  return '';
}
let pass = 0, fail = 0;
const ok = (l, c) => { if (c) pass++; else { fail++; console.log('  FAIL ' + l); } };

ok('owner command "שדרג עסקים" is wired + owner-gated',
  /trimmed === 'שדרג עסקים'[\s\S]{0,200}_isOwnerPhone_\(fromPhone\)[\s\S]{0,80}_backfillBusinessDashboards_\(fromPhone\)/.test(SRC));

// functional: run the backfill against a stub with one bare business tab + the main tab
const TX = 'תנועות';
let createdFor = [];
function mkSheet(name, header) {
  return { getName: () => name, getLastRow: () => 1, getLastColumn: () => 8,
    getRange: () => ({ getValues: () => [header] }) };
}
const bizHeader = ['תאריך', 'חודש', 'סכום', 'קטגוריה', 'תת-קטגוריה', 'תיאור', 'מקור', 'הוצאה?'];
const sheets = [
  mkSheet('תנועות', bizHeader),       // main -> skip
  mkSheet('מאזן חברה', ['x']),         // dashboard -> skip
  mkSheet('כספלה', bizHeader),         // bare business -> BACKFILL
  mkSheet('הזמנות', ['תאריך', 'a', 'b', 'c', 'd', 'e', 'f', 'g']), // not a tx tab -> skip
];
const ss = { getSheets: () => sheets };
global.SHEET_ID = 'X';
global.TRANSACTIONS_SHEET = TX;
global.SpreadsheetApp = { openById: () => ss };
global.Logger = { log() {} };
global._sanitizeTabName_ = (s) => s;
global._createBusinessDashboard_ = (ss, tab) => { createdFor.push(tab); return {}; };
eval(extract('_backfillBusinessDashboards_').replace('function _backfillBusinessDashboards_', 'global._backfillBusinessDashboards_ = function'));
const reply = global._backfillBusinessDashboards_('972500000000');
ok('backfills exactly the bare business tab (כספלה)', createdFor.length === 1 && createdFor[0] === 'כספלה');
ok('skips main tab + dashboards + orders', !createdFor.includes('תנועות') && !createdFor.includes('מאזן חברה') && !createdFor.includes('הזמנות'));
ok('reply confirms the upgrade', /נוצר דשבורד/.test(reply) && /כספלה/.test(reply));

console.log('test_business_dashboard_backfill: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
