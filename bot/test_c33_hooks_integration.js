#!/usr/bin/env node
// bot/test_c33_hooks_integration.js
//
// PR #306 — the live Claude C33 hooks integrated into the repo bot, checked
// end to end through the REAL processExpense branch order (bot/bot-replay.js:
// bare-business detector -> rich order -> עסק-prefix guard / numbered picker ->
// normal flow FX -> matchCategory with the special-business router first).
//
//   1. 90$ (and $90 / 90 דולר / 90 usd) is converted wherever it sits, for
//      music, ecom and the photo business; a bare 90 stays shekels.
//   2. "עסק מוזיקה" / "עסק ecom" works at the start, in the middle and at the end.
//   3. Regression for every business: personal, photo business (bare-business
//      buckets), rich order, numbered business, all music and ecom subcategories.
//   4. Fixtures vs repo: tests/fixtures/claude_c33/* (the live ZZ code) against
//      the repo code — routing, bare-business amounts AND column-F text, and the
//      overlap guard (the live ZZ wrapper must not wrap the repo function again).
//   5. The app-inbox importer is not shadowed (no importer names in the repo bot).
//   6. FIXED and DEPLOY carry identical hook code.
// Known gaps that exist identically in the live bot are reported as XFAIL.
// Offline: no sheet, network, Properties, trigger or deployment.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BOT = __dirname;
const FIXED = fs.readFileSync(path.join(BOT, 'ExpenseBot_FIXED.gs'), 'utf8');
const DEPLOY = fs.readFileSync(path.join(BOT, 'ExpenseBot_DEPLOY.gs'), 'utf8');
const FIX_DIR = path.join(BOT, '..', 'tests', 'fixtures', 'claude_c33');
const FX_MUSIC = fs.readFileSync(path.join(FIX_DIR, 'music_block_c28.js'), 'utf8');
const FX_ECOM = fs.readFileSync(path.join(FIX_DIR, 'ecom_block_c30v2.js'), 'utf8');
const FX_BBE = fs.readFileSync(path.join(FIX_DIR, 'zz_c33_bbe_fix.gs'), 'utf8');
const { replay } = require('./bot-replay.js');

const R = Number((FIXED.match(/var KFL_FX_DEFAULTS = \{[\s\S]*?USD\s*:\s*([0-9.]+)/) || [])[1]);
const GUARD_LINE = "if (__hStartsBiz && typeof _kflSpecialBusinessRoute_ === 'function' && _kflSpecialBusinessRoute_(__hT)) {";
const FLAG_LINE = '_classifyBareBusinessExpense_.__kflC33 = true;';
const BLOCK_START = '// SPECIAL BUSINESS ROUTING (C33, repo-integrated)';

let pass = 0, fail = 0, xfail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  [' + extra + ']' : '')); }
}
function known(label, stillBroken, extra) {
  if (stillBroken) { xfail++; console.log('  XFAIL ' + label + (extra ? '  [' + extra + ']' : '')); }
  else { pass++; console.log('  ok    (gap closed) ' + label); }
}
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.02;
const count = (hay, needle) => { let n = 0, i = -1; while ((i = hay.indexOf(needle, i + 1)) >= 0) n++; return n; };

// ---------- source extraction (same balanced-brace approach as the other bot tests) ----------
function extractFn(src, name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) throw new Error('missing function ' + name);
  let p = src.indexOf('(', s), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(s, j);
}
function extractDecl(src, marker, open, close) {
  const s = src.indexOf(marker);
  if (s < 0) throw new Error('missing declaration ' + marker);
  let i = src.indexOf(open, s), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === open) d++; else if (src[j] === close) { d--; if (!d) { j++; break; } } }
  if (src[j] === ';') j++;
  return src.slice(s, j).replace(/^const\s+/, 'var ');
}
function varLine(src, name) {
  const m = src.match(new RegExp('^var ' + name + ' = .*$', 'm'));
  if (!m) throw new Error('missing var ' + name);
  return m[0];
}
function specialBlock(src) {
  const s = src.indexOf(BLOCK_START);
  const e = s < 0 ? -1 : src.indexOf('function matchCategory(text)', s);
  if (s < 0 || e < 0) throw new Error('missing special-business block');
  return src.slice(s, e);
}
const fixtureWrapper = FX_BBE.slice(FX_BBE.indexOf('(function () {'), FX_BBE.indexOf('function KFL_CANON_SELFTEST8'));

// The repo classifier pieces the bare-business detector and the router need.
function repoCode(src, opts) {
  opts = opts || {};
  return [
    (src.match(/var _ORDER_MATERIALS_ = \[[^\]]+\];/) || ['var _ORDER_MATERIALS_ = [];'])[0],
    extractDecl(src, 'const CATEGORY_MAP = [', '[', ']'),
    extractDecl(src, 'var BUSINESS_CATEGORY_MAP = {', '{', '}'),
    extractDecl(src, 'const DEFAULT_CATEGORY =', '{', '}'),
    extractDecl(src, 'var _BIZ_DASH_SUBS = {', '{', '}'),
    extractDecl(src, 'var KFL_BIZ_OP_SET = {', '{', '}'),
    ...['_kflIsWordChar_', '_kflKwHit_', '_kflBizOpHit_', '_matchCategory_orig', '_matchCategory_long',
      '_coerceCategoryBySubcategory', '_normalizeBizSub_', 'parseBusinessOrder_', '_parseBusinessNumberPrefix_'].map((n) => extractFn(src, n)),
    (src.match(/var KFL_FX_DEFAULTS = \{[\s\S]*?\};/) || [''])[0],
    ...['_kfl_fxRateLive_', '_kfl_fxRate', '_kfl_fxLookup', '_kfl_fxNote_', '_kfl_currencyDisplay_',
      '_kfl_nonAdjacentCurrency_', 'parseForeignCurrencyHint'].map((n) => extractFn(src, n)),
    specialBlock(src),
    extractFn(src, 'matchCategory'),
    extractFn(src, '_classifyBareBusinessExpense_'),
    opts.flag ? FLAG_LINE : '',
    opts.noFx ? 'parseForeignCurrencyHint = function () { return null; };' : '',
    opts.wrapWithFixture ? fixtureWrapper : '',
    'this.__x = { bbe: _classifyBareBusinessExpense_, route: _kflSpecialBusinessRoute_ };',
  ].join('\n\n');
}
function run(code) {
  const ctx = { console, Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) } };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.__x;
}
// The live routes, straight from the fixtures (music first, then ecom — the
// order of the hooks in the live _resolveIsIncome_ wrapper).
function fixtureRouter() {
  const code = [
    ['_KFL_MUSIC_CAT_', '_KFL_MUSIC_SUBS_', '_KFL_MUSIC_MARK_', '_KFL_MUSIC_BRANDS_'].map((v) => varLine(FX_MUSIC, v)).join('\n'),
    extractDecl(FX_MUSIC, 'var _KFL_MUSIC_KW_ = [', '[', ']'), extractFn(FX_MUSIC, '_kflMusicRoute_'),
    ['_KFL_ECOM_CAT_', '_KFL_ECOM_SUBS_', '_KFL_ECOM_MARK_', '_KFL_ECOM_BRANDS_'].map((v) => varLine(FX_ECOM, v)).join('\n'),
    extractDecl(FX_ECOM, 'var _KFL_ECOM_KW_ = [', '[', ']'), extractFn(FX_ECOM, '_kflEcomRoute_'),
    'this.__x = function (t) { var m = { category: "", subcategory: "", isIncome: false }; var r = _kflMusicRoute_(t, m, false); if (r === null) r = _kflEcomRoute_(t, m, false); return r === null ? null : m; };',
  ].join('\n\n');
  const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx); return ctx.__x;
}

// One replay -> what processExpense would do with the message.
function flow(msg) {
  const r = replay(msg), d = r.decisions || {}, pt = r.predicted_target || {};
  let p = 'normal';
  if (d.parseBusinessOrder && d.parseBusinessOrder.matched) p = 'order';
  else if (d.businessN && d.businessN.matched) p = 'businessN';
  else if (d.bareBusiness && d.bareBusiness.matched) p = 'bare-business';
  else if (d.bizPicker && d.bizPicker.shown) p = 'PICKER';
  const amount = p === 'bare-business' ? d.bareBusiness.amount
    : p === 'PICKER' ? d.bizPicker.amount
    : (d.amountMatch && typeof d.amountMatch.amount === 'number' ? d.amountMatch.amount : null);
  return { path: p, guard: !!(d.bizPrefixGuard && d.bizPrefixGuard.applied), category: p === 'PICKER' ? null : (pt.category || null),
    subcategory: p === 'PICKER' ? null : (pt.subcategory || null), amount, isIncome: pt.isIncome === true, fx: !!(d.fx && d.fx.autoConverted),
    loadError: r.load_error || null };
}
const show = (f) => JSON.stringify(f);
function expectFlow(label, msg, want) {
  const f = flow(msg);
  const good = (!want.path || f.path === want.path) && (want.category === undefined || f.category === want.category) &&
    (!want.subcategory || f.subcategory === want.subcategory) && (want.amount === undefined || near(f.amount, want.amount)) &&
    (want.isIncome === undefined || f.isIncome === want.isIncome) && (want.fx === undefined || f.fx === want.fx) &&
    (want.guard === undefined || f.guard === want.guard);
  ok(label + ' "' + msg + '"', good, show(f));
  return f;
}

console.log('== 0. harness ==');
ok('offline USD rate read from KFL_FX_DEFAULTS', R > 0, String(R));
ok('replay loads the real source without errors', flow('50 קפה').loadError === null);
ok('replay sees the C33 router (suno 30$ -> עסק מוזיקה)', flow('suno 30$').category === 'עסק מוזיקה');

console.log('\n== 1. 90$ is converted wherever it sits ==');
const M90 = 90 * R;
for (const [msg, sub, guard] of [
  ['עסק מוזיקה distrokid 90$', 'הפצה ומנויים', true],
  ['distrokid 90$ עסק מוזיקה', 'הפצה ומנויים', false],
  ['שילמתי 90$ על distrokid עסק מוזיקה', 'הפצה ומנויים', false],
  ['90$ עסק מוזיקה distrokid', 'הפצה ומנויים', false],
  ['$90 עסק מוזיקה suno', 'הפקה וכלים', false],
  ['90 דולר עסק מוזיקה distrokid', 'הפצה ומנויים', false],
  ['90 usd עסק מוזיקה distrokid', 'הפצה ומנויים', false],
  ['מנוי שנתי 90$ - עסק מוזיקה distrokid', 'הפצה ומנויים', false],
  ['עסק מוזיקה - מנוי שנתי distrokid 90$', 'הפצה ומנויים', true],
  ['90$ suno', 'הפקה וכלים', false],
]) {
  expectFlow('music 90$ ' + (guard ? '[prefix]' : '[mid/suffix]'), msg, { path: 'normal', category: 'עסק מוזיקה', subcategory: sub, amount: M90, fx: true, guard, isIncome: false });
}
expectFlow('ecom 90$ [prefix]', 'עסק ecom shopify 90$', { path: 'normal', category: 'הוצאות ecom', subcategory: 'דומיין ואתר', amount: M90, fx: true, guard: true });
expectFlow('ecom 90$ [mid]', '90$ shopify לחנות ecom', { path: 'normal', category: 'הוצאות ecom', subcategory: 'דומיין ואתר', amount: M90, fx: true });
expectFlow('photo business 90$ [mid]', '90$ - עסק vercel', { path: 'normal', category: 'עסק', amount: M90, fx: true });
const v24 = flow('24 דולר - עסק vercel');
const bbe24 = replay('24 דולר - עסק vercel').decisions.bareBusiness || {};
ok('photo business "24 דולר - עסק vercel" -> bare business, converted once', v24.path === 'bare-business' && near(v24.amount, 24 * R), show(v24));
ok('photo business USD keeps the live column-F text "vercel — 24$ (≈70 ₪, שער R)"',
  bbe24.cleanedDesc === 'vercel — 24$ (≈' + Math.round(24 * R) + ' ₪, שער ' + R + ')', bbe24.cleanedDesc);
expectFlow('bare 90 stays shekels', '90 סונו', { path: 'normal', category: 'עסק מוזיקה', subcategory: 'הפקה וכלים', amount: 90, fx: false });
expectFlow('bare 90 stays shekels [prefix]', 'עסק מוסיקה 90 סונו', { path: 'normal', category: 'עסק מוזיקה', amount: 90, fx: false, guard: true });

console.log('\n== 2. the phrase works at the start, in the middle and at the end ==');
for (const [msg, cat, sub, amt] of [
  ['עסק מוזיקה suno 30$', 'עסק מוזיקה', 'הפקה וכלים', 30 * R],
  ['90 אפליקציה סונו - עסק מוזיקה', 'עסק מוזיקה', 'הפקה וכלים', 90],
  ['45 דולר - עסק מוזיקה dostrokid', 'עסק מוזיקה', null, 45 * R],
  ['50 הוצאות שיווק עסק מוזיקה', 'עסק מוזיקה', 'שיווק מוזיקה', 50],
  ['שילמתי היום עסק מוזיקה distrokid 20$', 'עסק מוזיקה', 'הפצה ומנויים', 20 * R],
  ['קניתי מיקרופון לעסק מוזיקה 400', 'עסק מוזיקה', 'ציוד מוזיקה', 400],
  ['הוצאות ecom דומיין 9 דולר', 'הוצאות ecom', 'דומיין ואתר', 9 * R],
  ['klaviyo 45 עסק ecom', 'הוצאות ecom', 'כלים ומנויים', 45],
]) {
  const f = expectFlow('phrase', msg, { path: 'normal', category: cat, subcategory: sub || undefined, amount: amt });
  ok('  "' + msg + '" never reaches the photo-business detector or the picker', f.path === 'normal');
}

console.log('\n== 3. regression for every business ==');
for (const [msg, want] of [
  ['50 קפה', { path: 'normal', category: 'אוכל', subcategory: 'אוכל בחוץ', amount: 50, isIncome: false }],
  ['דלק סונול 200', { path: 'normal', category: 'תחבורה', subcategory: 'דלק', amount: 200 }],
  ['משכורת 12500', { path: 'normal', category: 'הכנסות', amount: 12500, isIncome: true }],
  ['עסק 288 שיווק', { path: 'bare-business', category: 'עסק', subcategory: 'עלות שיווק', amount: 288 }],
  ['בעסק 288 שיווק', { path: 'bare-business', category: 'עסק', subcategory: 'עלות שיווק', amount: 288 }],
  ['עסק תמונות 150 חומרי גלם', { path: 'bare-business', category: 'עסק', subcategory: 'עלות חומרי גלם', amount: 150 }],
  ['עסק 300 אריזה', { path: 'bare-business', category: 'עסק', subcategory: 'משלוחים והתקנות', amount: 300 }],
  ['עסק 750 יועץ', { path: 'bare-business', category: 'עסק', subcategory: 'יועצים', amount: 750 }],
  ['עסק 120 נטפליקס', { path: 'bare-business', category: 'עסק', subcategory: 'הוצאות תפעוליות', amount: 120 }],
  ['הוצאות עסק תמונות 62 gmail עסקי', { path: 'bare-business', category: 'עסק', subcategory: 'הוצאות תפעוליות', amount: 62 }],
  ['עסקה יוסי הכנסה 10000 עובדים 2500 חומרים 1200', { path: 'order' }],
  ['עסק 2 שיווק 300', { path: 'businessN' }],
  ['עסק מוזיקה - 218 שיווק יוטיוב', { category: 'עסק מוזיקה', subcategory: 'שיווק מוזיקה', amount: 218 }],
  ['עסק מוזיקה הופעה בתל אביב 300', { category: 'עסק מוזיקה', subcategory: 'הופעות ונסיעות', amount: 300 }],
  ['עסק מוזיקה 100', { category: 'עסק מוזיקה', subcategory: 'כללי (מוזיקה)', amount: 100 }],
  ['עסק מוזיקה הכנסה 500 תמלוגים', { category: 'עסק מוזיקה', subcategory: 'הכנסות מוזיקה', amount: 500, isIncome: true }],
  ['עסק ecom עמלת paypal 12', { category: 'הוצאות ecom', subcategory: 'עמלות ותשלומים', amount: 12 }],
  ['ecom משלוח dhl 80', { category: 'הוצאות ecom', subcategory: 'משלוחים ולוגיסטיקה', amount: 80 }],
  ['ecom ספק aliexpress 150', { category: 'הוצאות ecom', subcategory: 'מלאי ומוצרים', amount: 150 }],
  ['עסק ecom פרסום פייסבוק 300', { category: 'הוצאות ecom', subcategory: 'פרסום ושיווק', amount: 300 }],
  ['ecom 100', { category: 'הוצאות ecom', subcategory: 'כללי (ecom)', amount: 100 }],
  ['ecom הכנסה 450 מכירות', { category: 'הוצאות ecom', subcategory: 'הכנסות ecom', amount: 450, isIncome: true }],
]) expectFlow('regression', msg, want);

console.log('\n== 4. fixtures (live ZZ code) vs repo code ==');
const CORPUS = [
  'עסק מוזיקה distrokid 90$', 'distrokid 90$ עסק מוזיקה', '90$ עסק מוזיקה distrokid', '$90 עסק מוזיקה suno', '90 דולר עסק מוזיקה distrokid',
  'עסק מוזיקה suno 30$', 'עסק מוזיקה - 218 שיווק יוטיוב', 'עסק מוסיקה 90 סונו', '90 אפליקציה סונו - עסק מוזיקה', '45 דולר - עסק מוזיקה dostrokid',
  '50 הוצאות שיווק עסק מוזיקה', 'קניתי מיקרופון לעסק מוזיקה 400', 'עסק מוזיקה הופעה בתל אביב 300', 'עסק מוזיקה הכנסה 500 תמלוגים', 'suno 30$', '90 סונו',
  'עסק ecom shopify 90$', 'עסק ecom פרסום פייסבוק 300', 'ecom shopify 29$', 'הוצאות ecom דומיין 9 דולר', 'ecom הכנסה 450 מכירות', 'klaviyo 45 עסק ecom',
  'עסק ecom עמלת paypal 12', 'ecom משלוח dhl 80', 'ecom ספק aliexpress 150', '24 דולר - עסק vercel', '90$ - עסק vercel', 'עסק 288 שיווק', 'בעסק 288 שיווק',
  'עסק תמונות 150 חומרי גלם', 'הוצאות עסק תמונות 62 gmail עסקי', 'עסק 300 אריזה', 'עסק 120 נטפליקס', 'עסק 2 שיווק 300',
  'עסקה יוסי הכנסה 10000 עובדים 2500 חומרים 1200', '50 קפה', 'דלק סונול 200', 'משכורת 12500', '30 € עסק מנוי אדובי',
];
const liveRoute = fixtureRouter();
const repoA = run(repoCode(FIXED, { flag: true }));
const key = (m) => (m ? m.category + ' / ' + m.subcategory + (m.isIncome ? ' (income)' : '') : '—');
let routeDiff = [];
for (const msg of CORPUS) if (key(liveRoute(msg)) !== key(repoA.route(msg))) routeDiff.push(msg + ': live ' + key(liveRoute(msg)) + ' | repo ' + key(repoA.route(msg)));
ok('routing: fixture music/ecom hooks == repo router on ' + CORPUS.length + ' messages', routeDiff.length === 0, routeDiff.slice(0, 3).join(' ; '));
// Live bare-business = fixture wrapper around the detector without its own FX.
const liveBBE = run(repoCode(FIXED, { noFx: true, wrapWithFixture: true }));
ok('fixture wrapper really wrapped the FX-less detector', liveBBE.bbe.__kflC33 === true);
const bkey = (b) => (b ? b.category + ' / ' + b.subcategory + ' / ' + b.amount + ' / ' + b.cleanedDesc : 'null');
let bbeDiff = [];
for (const msg of CORPUS) if (bkey(liveBBE.bbe(msg)) !== bkey(repoA.bbe(msg))) bbeDiff.push(msg + ': live ' + bkey(liveBBE.bbe(msg)) + ' | repo ' + bkey(repoA.bbe(msg)));
ok('bare-business: fixture (live) == repo — null-ness, bucket, amount and column-F text', bbeDiff.length === 0, bbeDiff.slice(0, 3).join(' ; '));
// Overlap: deploying the repo next to the live ZZ must not convert twice.
const both = run(repoCode(FIXED, { flag: true, wrapWithFixture: true }));
const b24 = both.bbe('24 דולר - עסק vercel');
ok('repo + live ZZ wrapper: the flagged repo detector is not wrapped again (24$ converted once)', near(b24 && b24.amount, 24 * R), b24 && b24.amount);
const mutant = run(repoCode(FIXED, { flag: false, wrapWithFixture: true })).bbe('24 דולר - עסק vercel');
ok('mutation: without the __kflC33 flag the live wrapper converts twice (the overlap this guards against)', !!mutant && mutant.amount > 24 * R * 2, mutant && mutant.amount);
for (const [name, src] of [['FIXED', FIXED], ['DEPLOY', DEPLOY]]) {
  ok(name + ': __kflC33 flag set exactly once, right after the detector', count(src, FLAG_LINE) === 1 &&
    src.indexOf(FLAG_LINE) > src.indexOf('function _classifyBareBusinessExpense_(') &&
    src.indexOf(FLAG_LINE) < src.indexOf('function _kflIsWordChar_('));
}

console.log('\n== 5. the app-inbox importer stays exactly as it is (live ZZ only) ==');
for (const [name, src] of [['FIXED', FIXED], ['DEPLOY', DEPLOY]]) {
  const names = ['KFL_APP_INBOX_', '_kflAppItem_', '_kflAppClean_', '_kflAppAllowed_', '_kflAppLogSheet_', '_kflAppDoneFolder_', '_KFL_APP_', '_kfl29SheetId_'];
  const hits = names.filter((n) => new RegExp('(function\\s+|var\\s+)' + n).test(src));
  ok(name + ': defines none of the importer names (cannot shadow the live importer)', hits.length === 0, hits.join(','));
}

console.log('\n== 6. FIXED and DEPLOY carry the same hook code ==');
for (const [name, src] of [['FIXED', FIXED], ['DEPLOY', DEPLOY]]) {
  ok(name + ': עסק-prefix guard present once, before the numbered picker', count(src, GUARD_LINE) === 1 &&
    src.indexOf(GUARD_LINE) < src.indexOf("if (__hStartsBiz) {\n    var __hAM = __hT.replace(/,/g, '').match("));
}
ok('special-business block identical', specialBlock(FIXED) === specialBlock(DEPLOY));
ok('bare-business detector identical', extractFn(FIXED, '_classifyBareBusinessExpense_') === extractFn(DEPLOY, '_classifyBareBusinessExpense_'));

console.log('\n== 7. known gaps (identical in the live bot today; XFAIL, not failures) ==');
const pk = flow('עסק 90$ vercel');
known('"עסק 90$ vercel" (photo business, $ glued, prefix form) shows the numbered picker with the raw 90 — no FX', pk.path === 'PICKER' && pk.amount === 90, show(pk));
const tw = extractFn(FIXED, '_tenantWriteExpense_');
known('tenant writer classifies with the owner-only special routes (fix ready: claude/c34-from-306, commit d57d48c5)', tw.indexOf('_kflWithoutSpecialBusiness_') < 0);

console.log(`\ntest_c33_hooks_integration: ${pass} passed, ${fail} failed, ${xfail} xfail`);
process.exit(fail ? 1 : 0);
