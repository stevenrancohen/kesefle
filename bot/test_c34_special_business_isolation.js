#!/usr/bin/env node
// bot/test_c34_special_business_isolation.js
//
// C34 (2026-11-03) tenant isolation for the owner-only special businesses.
//
// The C33 port runs _kflSpecialBusinessRoute_ inside matchCategory() and
// matchCategorySmart(), which are also used by the tenant writer
// (_tenantWriteExpense_), the group writer (_groupRecordExpense_), the family
// writer (_familyLogExpense_) and the receipt flow. Without a gate a tenant's
// "suno 30" or "shopify 29" would be sent to THEIR sheet as 'עסק מוזיקה' /
// 'הוצאות ecom', categories that exist only in the owner's sheet.
//
// This test runs the REAL writer functions (extracted from the source, executed
// in a vm sandbox) with stubbed I/O (UrlFetchApp / group API / family sheet are
// captured, never called), and checks:
//   1. tenant / group / family writes never carry the owner's special categories;
//   2. the owner keeps the routes (and so do cron / internal calls with no sender);
//   3. the suspension is re-entrant and restored when the classifier throws;
//   4. a mutation (wrapper replaced by a pass-through) brings the leak back, so
//      the assertions above really depend on the gate;
//   5. FIXED and DEPLOY carry byte-identical gate code.
// MOCK I/O ONLY: no sheet, network, Properties write, trigger or deployment.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILES = {
  FIXED: fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8'),
  DEPLOY: fs.readFileSync(path.join(__dirname, 'ExpenseBot_DEPLOY.gs'), 'utf8'),
};
const OWNER = '972500000001';   // synthetic test numbers, not real users
const TENANT = '972500000002';
const SPECIAL = ['עסק מוזיקה', 'הוצאות ecom'];

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  [' + extra + ']' : '')); }
}

// Paren-aware function extraction (parameter lists may hold braces).
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing function ' + name);
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}
function extractDecl(src, marker, open, close) {
  const s = src.indexOf(marker);
  if (s < 0) throw new Error('missing declaration ' + marker);
  let i = src.indexOf(open, s), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === open) d++; else if (src[j] === close) { d--; if (!d) { j++; break; } } }
  if (src[j] === ';') j++;
  return src.slice(s, j).replace(/^const\s+/, 'var ');
}
function specialBlock(src) {
  const s = src.indexOf('// SPECIAL BUSINESS ROUTING (C33, repo-integrated)');
  const e = s < 0 ? -1 : src.indexOf('function matchCategory(text)', s);
  if (s < 0 || e < 0) throw new Error('missing special-business block');
  return src.slice(s, e);
}

function load(src) {
  const cap = { fetch: [], group: [], family: [] };
  const ctx = {
    console,
    Logger: { log() {} },
    Utilities: { formatDate: () => '2026-11', computeDigest: () => [] },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'KESEFLE_BOT_SECRET' ? 'test-only-not-a-secret' : null), setProperty() {}, deleteProperty() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    UrlFetchApp: { fetch: (url, opts) => { cap.fetch.push(JSON.parse(opts.payload)); return { getResponseCode: () => 200, getContentText: () => '{"rowIndex":7}' }; } },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => ({ appendRow: (row) => cap.family.push(row), getLastRow: () => 2, getRange: () => ({ setNote() {} }) }) }) },
    KESEFLE_API_BASE: 'https://kesefle.test',
    _ownerCheck: (p) => String(p || '').replace(/\D/g, '') === OWNER,
  };
  ctx._isOwnerPhone_ = (p) => ctx._ownerCheck(p);
  ctx._groupAPI_ = (op, params) => (op === 'getactive' ? { ok: true, active: 'G1' } : (cap.group.push(params), { ok: true, memberCount: 2 }));
  ctx.kvGet = (k) => (String(k).indexOf('family:of:') === 0 ? 'F1' : (k === 'family:F1' ? { sheetId: 'S-test' } : null));
  vm.createContext(ctx);
  const code = [
    (src.match(/var _ORDER_MATERIALS_ = \[[^\]]+\];/) || ['var _ORDER_MATERIALS_ = [];'])[0],
    extractDecl(src, 'const CATEGORY_MAP = [', '[', ']'),
    extractDecl(src, 'var BUSINESS_CATEGORY_MAP = {', '{', '}'),
    extractDecl(src, 'const DEFAULT_CATEGORY =', '{', '}'),
    extractDecl(src, 'var _BIZ_DASH_SUBS = {', '{', '}'),
    extractDecl(src, 'var KFL_BIZ_OP_SET = {', '{', '}'),
    ...['_kflIsWordChar_', '_kflKwHit_', '_kflBizOpHit_', '_matchCategory_orig', '_matchCategory_long',
      '_coerceCategoryBySubcategory', '_normalizeBizSub_'].map((n) => extractFn(src, n)),
    specialBlock(src),
    ...['matchCategory', 'matchCategorySmart', '_parseIsraeliNumber_', 'parseAmountAndDescription', 'sanitizeForSheet',
      '_tenantWriteExpense_', '_groupRecordExpense_', '_familyLogExpense_'].map((n) => extractFn(src, n)),
  ].join('\n\n');
  vm.runInContext(code, ctx);
  return { ctx, cap };
}

// Call fn(ctx); any other missing helper is stubbed as "returns null" and the
// call is retried (captures are reset per attempt).
function run(env, fn) {
  for (let attempt = 0; attempt < 60; attempt++) {
    env.cap.fetch.length = 0; env.cap.group.length = 0; env.cap.family.length = 0;
    try { return fn(env.ctx); } catch (e) {
      const m = e && /^(\S+) is not defined$/.exec(e.message || '');
      if (!m) throw e;
      vm.runInContext('function ' + m[1] + '() { return null; }', env.ctx);
    }
  }
  throw new Error('too many missing helpers');
}
const cat = (m) => (m && m.category) || null;

const MSGS = ['suno 30', 'distrokid 20', 'shopify 29', 'apple music מנוי 20', 'חוג מוזיקה לתינוקות 280', 'מנוי klaviyo 45'];

for (const [name, src] of Object.entries(FILES)) {
  console.log('\n== ' + name + ' ==');
  const env = load(src);
  const C = env.ctx;

  // 0. sanity: the owner (no sender) path still routes the special businesses.
  ok(name + ': owner/no-sender matchCategory still routes "suno 30" to עסק מוזיקה', cat(run(env, (c) => c.matchCategory('suno 30'))) === 'עסק מוזיקה');
  ok(name + ': owner/no-sender matchCategory still routes "shopify 29" to הוצאות ecom', cat(run(env, (c) => c.matchCategory('shopify 29'))) === 'הוצאות ecom');

  // 1. suspension primitive
  const susp = run(env, (c) => c._kflWithoutSpecialBusiness_(() => c.matchCategory('suno 30')));
  ok(name + ': inside _kflWithoutSpecialBusiness_ "suno 30" is not a special business', SPECIAL.indexOf(cat(susp)) < 0, JSON.stringify(susp));
  const nested = run(env, (c) => c._kflWithoutSpecialBusiness_(() => c._kflWithoutSpecialBusiness_(() => 1) + (c._kflSpecialBusinessRoute_('suno 30') ? 10 : 0)));
  ok(name + ': suspension is re-entrant (still suspended after a nested call)', nested === 1, String(nested));
  let threw = false;
  try { C._kflWithoutSpecialBusiness_(() => { throw new Error('boom'); }); } catch (e) { threw = e.message === 'boom'; }
  ok(name + ': classifier error propagates and the suspension is restored', threw && cat(run(env, (c) => c.matchCategory('suno 30'))) === 'עסק מוזיקה');

  // 2. matchCategorySmart sender gate
  ok(name + ': matchCategorySmart(owner) keeps the special route', cat(run(env, (c) => c.matchCategorySmart('suno 30', OWNER))) === 'עסק מוזיקה');
  ok(name + ': matchCategorySmart(no sender) keeps the special route', cat(run(env, (c) => c.matchCategorySmart('suno 30', ''))) === 'עסק מוזיקה');
  const ten = run(env, (c) => c.matchCategorySmart('suno 30', TENANT));
  ok(name + ': matchCategorySmart(tenant) never returns a special business', SPECIAL.indexOf(cat(ten)) < 0, JSON.stringify(ten));
  ok(name + ': owner routing is intact right after a tenant call', cat(run(env, (c) => c.matchCategorySmart('shopify 29', OWNER))) === 'הוצאות ecom');
  C._ownerCheck = () => { throw new Error('owner lookup failed'); };
  const closed = run(env, (c) => c.matchCategorySmart('suno 30', TENANT));
  ok(name + ': an owner-check error fails closed (no special route)', SPECIAL.indexOf(cat(closed)) < 0, JSON.stringify(closed));
  C._ownerCheck = (p) => String(p || '').replace(/\D/g, '') === OWNER;

  // 3. the three writers, end to end with captured I/O
  for (const msg of MSGS) {
    run(env, (c) => c._tenantWriteExpense_(TENANT, msg, { phone: TENANT }));
    const tp = env.cap.fetch[0];
    ok(name + ': tenant "' + msg + '" -> ' + (tp ? tp.category + ' (written)' : 'asked first (not written)'), !tp || SPECIAL.indexOf(tp.category) < 0, JSON.stringify(tp || null));
    run(env, (c) => c._groupRecordExpense_(TENANT, msg));
    const gp = env.cap.group[0];
    ok(name + ': group "' + msg + '" -> ' + (gp ? (gp.category || '(none)') : 'not written'), !!gp && SPECIAL.indexOf(gp.category) < 0, JSON.stringify(gp || null));
    const amount = Number((msg.match(/\d+/) || [0])[0]);
    run(env, (c) => c._familyLogExpense_(OWNER, 'סטיבן', amount, msg.replace(/\s*\d+\s*/, ' ').trim()));
    const fr = env.cap.family[0];
    ok(name + ': family (logged by the owner) "' + msg + '" -> ' + (fr ? fr[3] : 'not written'), !!fr && SPECIAL.indexOf(fr[3]) < 0, JSON.stringify(fr || null));
  }

  // 4. mutation: without the gate the leak is back (proves the checks above bite)
  const saved = C._kflWithoutSpecialBusiness_;
  vm.runInContext('_kflWithoutSpecialBusiness_ = function (fn) { return fn(); };', C);
  run(env, (c) => c._tenantWriteExpense_(TENANT, 'suno 30', { phone: TENANT }));
  const leak = env.cap.fetch[0];
  ok(name + ': mutation (gate removed) -> tenant "suno 30" is written as עסק מוזיקה again', !!leak && leak.category === 'עסק מוזיקה', JSON.stringify(leak || null));
  C._kflWithoutSpecialBusiness_ = saved;
}

console.log('\n== source contract: FIXED and DEPLOY carry the same gate ==');
for (const fn of ['matchCategorySmart', '_tenantWriteExpense_', '_groupRecordExpense_', '_familyLogExpense_']) {
  ok(fn + ' is byte-identical in FIXED and DEPLOY', extractFn(FILES.FIXED, fn) === extractFn(FILES.DEPLOY, fn));
}
ok('special-business block (with the suspension helpers) is byte-identical', specialBlock(FILES.FIXED) === specialBlock(FILES.DEPLOY));
for (const [name, src] of Object.entries(FILES)) {
  const route = extractFn(src, '_kflSpecialBusinessRoute_');
  ok(name + ': _kflSpecialBusinessRoute_ returns null first thing while suspended', /^function _kflSpecialBusinessRoute_\(text\) \{\s*if \(__kflSpecialSuspended > 0\) return null;/.test(route));
  const mcs = extractFn(src, 'matchCategorySmart');
  ok(name + ': matchCategorySmart gates non-owner senders before any lookup', mcs.indexOf('_kflSpecialOffForSender_(fromPhone)') > 0 && mcs.indexOf('_kflSpecialOffForSender_(fromPhone)') < mcs.indexOf('_learnedLookup('));
  ok(name + ': tenant / group / family writers classify inside _kflWithoutSpecialBusiness_',
    extractFn(src, '_tenantWriteExpense_').indexOf('_kflWithoutSpecialBusiness_(function () { return matchCategory(rawText); })') > 0 &&
    extractFn(src, '_groupRecordExpense_').indexOf('_kflWithoutSpecialBusiness_(function () { return matchCategory(body); })') > 0 &&
    extractFn(src, '_familyLogExpense_').indexOf('_kflWithoutSpecialBusiness_(function () { return matchCategorySmart(description, fromPhone); })') > 0);
}

console.log(`\ntest_c34_special_business_isolation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
