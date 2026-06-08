#!/usr/bin/env node
// bot/test_owner_create_category.js (auto-discovered by the gauntlet)
// Locks the owner create-category fix (Steven 2026-06-08): the tenant API
// /api/sheet/add-category-row deliberately never touches the owner sheet, so
// the OWNER got a false "not linked" reply. The bot now handles the owner
// directly via _addOwnerCategoryRows_ -- APPEND-ONLY to "מאזן אישי". Structural
// asserts over the source (a live sheet write can't run offline).
const fs = require('node:fs'), path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
let pass = 0, fail = 0;
function ok(label, cond) { if (cond) pass++; else { fail++; console.log('  FAIL ' + label); } }

ok('_addOwnerCategoryRows_ defined', /function _addOwnerCategoryRows_\(/.test(SRC));
ok('create-category routes owner -> _addOwnerCategoryRows_',
  /_isOwnerPhone_\(fromPhone\)[\s\S]{0,80}_addOwnerCategoryRows_\(pieces, emoji\)/.test(SRC));
const i = SRC.indexOf('function _addOwnerCategoryRows_');
const body = i >= 0 ? SRC.slice(i, i + 2000) : '';
ok('targets the מאזן אישי tab', /var TAB = 'מאזן אישי'/.test(body));
ok('append-only (uses appendRow)', /sheet\.appendRow\(/.test(body));
ok('append-only (no overwrite / delete / setValue)',
  !/setValue|setValues|setFormula|clearContent|deleteRow/.test(body));
ok('builds SUMPRODUCT REGEXMATCH formula over the tx tab',
  /SUMPRODUCT\(/.test(body) && /REGEXMATCH\(/.test(body));
ok('dup-checked against col A labels', /stripEmoji/.test(body) && /isDup/.test(body));
ok('reads existing labels via getLastRow', /getLastRow\(\)/.test(body));
ok('owner write goes to SHEET_ID (owner sheet)', /SpreadsheetApp\.openById\(SHEET_ID\)/.test(body));

console.log('test_owner_create_category: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
