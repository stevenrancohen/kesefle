#!/usr/bin/env node
// bot/test_c40_tenant_fx_income.js
//
// C40 (2026-11-03) offline regression for T6 -- the TENANT (client) write path
// (_tenantWriteExpense_, the multi-tenant bridge to /api/sheet/append):
//   (1) FX: a foreign-currency amount ("90$", "12 euro", "90 dollar") must be
//       converted to ILS the way the owner path does it (parseForeignCurrencyHint),
//       not booked as the raw number with currency 'ILS';
//   (2) sign: the row must carry the real isIncome (_resolveIsIncome_, the resolver
//       every owner write uses), not a hard-coded false -- a salary was written to
//       the tenant's sheet as an expense.
// The FX rate is INJECTED through the existing FX_RATE_<code> Script Property
// override (USD 3.70, EUR 4.00). The live-rate fetcher is a spy that must never run,
// and every outbound call except the captured append is refused.
// Baseline: the pinned 265268d blobs (read from this repo's git objects) must still
// show both bugs -- skipped with a note when git or the objects are unavailable.
// Sandbox and function extraction are the ones of bot/test_c38_owner_dict_isolation.js.
// MOCK I/O ONLY: no sheet, network, Properties, trigger or deployment.
// Synthetic sender ID, not a phone number. KFL_OUT=<dir> also writes JSON proof files.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.KFL_OUT || '';
// C44: the "only X differs from <pin>" / "byte-identical to <pin>" checks prove this change's
// minimality at commit time and would fail on any later bot edit, so they run only with
// KFL_SCOPE_PIN=1. Behaviour, owner isolation, FIXED/DEPLOY parity, fail-closed and mutation
// checks always run (bot/test_c44_optional_scope_pins.js guards this split).
const SCOPE_PIN = process.env.KFL_SCOPE_PIN === '1';
const TENANT = '000000000002'; // synthetic, not a phone number
const RATE = { USD: 3.7, EUR: 4 }; // injected via FX_RATE_USD / FX_RATE_EUR
const BASE_PIN = { rev: '265268d', fixed: '791fd810192ee49987fadee5933963abe8691fee', deploy: '142803429ccff2aa6a03478cd74013abc466e834' };

let pass = 0, fail = 0;
const results = [];
function ok(id, cond, extra) {
  results.push({ id, pass: !!cond, detail: extra === undefined ? null : extra });
  if (cond) { pass++; console.log('  ok    ' + id); } else { fail++; console.log('  FAIL  ' + id + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); }
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const blobSha1 = (b) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + b.length + '\0'), b])).digest('hex');
function gitBlob(sha) {
  const buf = cp.execFileSync('git', ['--no-optional-locks', '-C', ROOT, 'cat-file', 'blob', sha], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  if (blobSha1(buf) !== sha) throw new Error('blob integrity ' + sha);
  return buf.toString('utf8');
}

// ---------- inputs ----------
const SRC = {
  FIXED: fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8'),
  DEPLOY: fs.readFileSync(path.join(__dirname, 'ExpenseBot_DEPLOY.gs'), 'utf8'),
};
let BASE = null;
try { BASE = { fixed: gitBlob(BASE_PIN.fixed), deploy: gitBlob(BASE_PIN.deploy) }; } catch (_) { BASE = null; }

// ---------- extraction (same as test_c38 / the C37 harness) ----------
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
  if (s < 0) return '';
  return src.slice(s, src.indexOf('function matchCategory(text)', s));
}

// ---------- sandbox: injected FX rate, captured append, everything else refused ----------
function load(src) {
  const cap = { append: [], asked: [], fxLive: 0, refused: 0, stubbed: [] };
  const props = { KESEFLE_BOT_SECRET: 'synthetic-test-value', FX_RATE_USD: String(RATE.USD), FX_RATE_EUR: String(RATE.EUR) };
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, Logger: { log() {} },
    Utilities: { formatDate: () => '2026-11', computeDigest: () => [] },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null), setProperty() {}, deleteProperty() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    UrlFetchApp: { fetch: (url, opts) => {
      if (/\/api\/sheet\/append(\?|$)/.test(String(url))) { cap.append.push(JSON.parse(opts.payload)); return { getResponseCode: () => 200, getContentText: () => '{"rowIndex":7}' }; }
      cap.refused++; throw new Error('offline test: outbound call refused');
    } },
    KESEFLE_API_BASE: 'https://offline.invalid',
  };
  ctx._isOwnerPhone_ = () => false;
  ctx._kfl_fxRateLive_ = () => { cap.fxLive++; return null; }; // spy: never reached while FX_RATE_<code> is set
  ctx._askBeforeDefaulting_ = (p, raw, amount, description) => { cap.asked.push({ amount, description }); return { reply: '' }; };
  for (const n of ['_sheetNudgeLine_', '_kudosTail_', '_celebrateIfFirstExpense_', '_tenantCategoryMtdLine_', '_sheetLinkLine_']) ctx[n] = () => '';
  vm.createContext(ctx);
  const code = [
    (src.match(/var _ORDER_MATERIALS_ = \[[^\]]+\];/) || ['var _ORDER_MATERIALS_ = [];'])[0],
    extractDecl(src, 'const CATEGORY_MAP = [', '[', ']'),
    extractDecl(src, 'var BUSINESS_CATEGORY_MAP = {', '{', '}'),
    extractDecl(src, 'const DEFAULT_CATEGORY =', '{', '}'),
    extractDecl(src, 'var _BIZ_DASH_SUBS = {', '{', '}'),
    extractDecl(src, 'var KFL_BIZ_OP_SET = {', '{', '}'),
    extractDecl(src, 'var KFL_FX_DEFAULTS = {', '{', '}'),
    ...['_kfl_fxRate', '_kfl_fxLookup', '_kfl_currencyDisplay_', '_kfl_fxNote_', '_kfl_nonAdjacentCurrency_', 'parseForeignCurrencyHint',
      '_kflIsWordChar_', '_kflKwHit_', '_kflBizOpHit_', '_matchCategory_orig', '_matchCategory_long', '_coerceCategoryBySubcategory', '_normalizeBizSub_'].map((n) => extractFn(src, n)),
    specialBlock(src),
    ...['matchCategory', '_parseIsraeliNumber_', 'parseAmountAndDescription', 'sanitizeForSheet', '_isIncomeCategory_', '_resolveIsIncome_',
      '_tenantWriteExpense_'].map((n) => extractFn(src, n)),
  ].join('\n\n');
  vm.runInContext(code, ctx);
  return { ctx, cap };
}
function run(env, fn) {
  for (let attempt = 0; attempt < 80; attempt++) {
    env.cap.append.length = 0; env.cap.asked.length = 0;
    try { return fn(env.ctx); } catch (e) {
      const m = e && /^(\S+) is not defined$/.exec(e.message || '');
      if (!m) throw e;
      env.cap.stubbed.push(m[1]);
      vm.runInContext('function ' + m[1] + '() { return null; }', env.ctx);
    }
  }
  throw new Error('too many missing helpers');
}
function tenant(env, msg) {
  const reply = run(env, (c) => c._tenantWriteExpense_(TENANT, msg, { phone: 'synthetic' }));
  const p = env.cap.append[0] ? Object.assign({}, env.cap.append[0]) : null;
  const a = env.cap.asked[0] ? Object.assign({}, env.cap.asked[0]) : null;
  return { written: !!p, payload: p, asked: a, reply: reply && reply.reply };
}

// ---------- cases ----------
const FX = [
  { id: 'FX1', msg: 'distrokid 90$', raw: 90, code: 'USD' },
  { id: 'FX2', msg: 'shopify 29$', raw: 29, code: 'USD' },
  { id: 'FX3', msg: '90 דולר shopify', raw: 90, code: 'USD' },
  { id: 'FX4', msg: 'netflix 20$', raw: 20, code: 'USD' },
  { id: 'FX5', msg: '12 יורו spotify', raw: 12, code: 'EUR' },
  { id: 'FX6', msg: 'דולר אפליקציה chatgpt 70', raw: 70, code: 'USD' }, // currency word not next to the number
  { id: 'FX7', msg: 'תמלוגים 20$', raw: 20, code: 'USD', income: true }, // FX and income together
];
const ASKED_FX = { id: 'FX8', msg: 'suno 30$', raw: 30, code: 'USD' }; // uncertain -> picker; the stashed amount must be ILS
const GIVEN_ILS = { id: 'FX9', msg: '50$ amazon 180 שח', ils: 180 };   // the user gave the ILS amount -> no rate
const MULTI = { id: 'FX10', msg: 'סופר 100, netflix 20$' };           // multi-item: left exactly as before
const INCOME = [
  { id: 'IN1', msg: 'משכורת 8500', income: true },
  { id: 'IN2', msg: '+1500 בונוס', income: true },
  { id: 'IN3', msg: 'תמלוגים 300', income: true },
  { id: 'IN4', msg: 'החזר מס 1200', income: true },
  { id: 'IN5', msg: 'בונוס 1000', income: true },
  { id: 'EX1', msg: 'משכורת לעובד 6000', income: false }, // payroll paid to an employee = expense
  { id: 'EX2', msg: 'שילמתי 500 משכורת', income: false },  // money-out guard
];
const CONTROLS = ['סופר 120', 'דלק 300', 'spotify 20', 'ארנונה 500', 'אוכל בחוץ 64/90', '+2000 עבודה'];
const conv = (raw, code) => Math.round(raw * RATE[code] * 100) / 100;
const money = (n) => '₪' + Number(n).toLocaleString('he-IL');
const except = (o, k) => { if (!o) return o; const r = Object.assign({}, o); delete r[k]; return r; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ALL = FX.concat([ASKED_FX, GIVEN_ILS, MULTI], INCOME).map((c) => c.msg).concat(CONTROLS);
function probeAll(src) { const env = load(src); const out = {}; for (const m of ALL) out[m] = tenant(env, m); out.__cap = env.cap; return out; }

const HEAD = probeAll(SRC.FIXED), HEAD_DEPLOY = probeAll(SRC.DEPLOY);
const B = BASE ? probeAll(BASE.fixed) : null;

// ---------- 1. the bugs on the pinned base ----------
console.log('\n== 1. base ' + BASE_PIN.rev + ' (pinned git objects): both bugs reproduced ==');
if (!B) {
  console.log('  note  ' + BASE_PIN.rev + ': objects unavailable here — baseline skipped');
} else {
  ok('base: all ' + FX.length + ' FX writes are booked raw in ILS — ' + FX.map((c) => c.id + '=' + (B[c.msg].written ? money(B[c.msg].payload.amount) : 'asked')).join(' '),
    FX.every((c) => B[c.msg].written && B[c.msg].payload.amount === c.raw && B[c.msg].payload.currency === 'ILS'));
  ok('base: the asked-first FX message stashes the raw amount (' + ASKED_FX.msg + ' → ' + (B[ASKED_FX.msg].asked && B[ASKED_FX.msg].asked.amount) + ')',
    !B[ASKED_FX.msg].written && !!B[ASKED_FX.msg].asked && B[ASKED_FX.msg].asked.amount === ASKED_FX.raw);
  const inc = INCOME.filter((c) => c.income).concat(FX.filter((c) => c.income));
  ok('base: isIncome=false for all ' + inc.length + ' income texts (salary included)', inc.every((c) => B[c.msg].written && B[c.msg].payload.isIncome === false));
}

// ---------- 2. FX on the fix, injected rate ----------
console.log('\n== 2. HEAD: FX converted with the injected rate (USD ' + RATE.USD + ', EUR ' + RATE.EUR + ') ==');
for (const c of FX) {
  const r = HEAD[c.msg];
  ok(c.id + ' "' + c.msg + '" → ' + (r.written ? money(r.payload.amount) : 'not written') + ' (' + c.raw + ' × ' + RATE[c.code] + ')', r.written && r.payload.amount === conv(c.raw, c.code), r.payload);
}
{
  const r = HEAD[ASKED_FX.msg];
  ok(ASKED_FX.id + ' "' + ASKED_FX.msg + '" is asked first and stashes ' + (r.asked ? money(r.asked.amount) : '?') + ' (' + ASKED_FX.raw + ' × ' + RATE.USD + ')',
    !r.written && !!r.asked && r.asked.amount === conv(ASKED_FX.raw, ASKED_FX.code), r.asked);
  const g = HEAD[GIVEN_ILS.msg];
  ok(GIVEN_ILS.id + ' "' + GIVEN_ILS.msg + '" keeps the ILS amount the user gave (' + money(GIVEN_ILS.ils) + ', no rate)', g.written && g.payload.amount === GIVEN_ILS.ils, g.payload);
  ok(MULTI.id + ' multi-item "' + MULTI.msg + '" is written exactly as before (no rate on the wrong item)', !B || same(HEAD[MULTI.msg], B[MULTI.msg]), { head: HEAD[MULTI.msg].payload, base: B && B[MULTI.msg].payload });
}
ok('every FX write is sent as currency ILS with the original text kept in rawText',
  FX.every((c) => HEAD[c.msg].written && HEAD[c.msg].payload.currency === 'ILS' && HEAD[c.msg].payload.rawText === c.msg));
ok('the confirmation shows the converted ILS amount', FX.every((c) => String(HEAD[c.msg].reply || '').indexOf(money(conv(c.raw, c.code))) >= 0));
ok('injected rate only: live-rate fetcher never called, no outbound call refused', HEAD.__cap.fxLive === 0 && HEAD.__cap.refused === 0 && HEAD_DEPLOY.__cap.fxLive === 0 && HEAD_DEPLOY.__cap.refused === 0,
  { fxLive: HEAD.__cap.fxLive, refused: HEAD.__cap.refused });

// ---------- 3. isIncome on the fix ----------
console.log('\n== 3. HEAD: the tenant row carries the real sign ==');
for (const c of INCOME.concat(FX.filter((x) => x.income))) {
  const r = HEAD[c.msg];
  ok(c.id + ' "' + c.msg + '" → isIncome=' + (r.written ? r.payload.isIncome : 'n/a') + ' (' + (r.written ? r.payload.category : '') + ')', r.written && r.payload.isIncome === c.income, r.payload);
}
{
  const env = load(SRC.FIXED);
  const agree = ALL.filter((m) => HEAD[m].written).every((m) => {
    const mt = run(env, (c) => c._kflWithoutSpecialBusiness_(() => c.matchCategory(m)));
    return HEAD[m].payload.isIncome === !!run(env, (c) => c._resolveIsIncome_(mt, m, mt.category, mt.subcategory));
  });
  ok('isIncome equals the shared owner resolver (_resolveIsIncome_) for every written message', agree);
}

// ---------- 4. nothing else changes ----------
console.log('\n== 4. everything else is unchanged ==');
if (B) {
  ok('the ' + CONTROLS.length + ' ILS / non-income controls: payload, picker stash and reply identical to base', CONTROLS.every((m) => same(HEAD[m], B[m])));
  ok('FX writes differ from base only in the amount', FX.filter((c) => !c.income).every((c) => same(except(HEAD[c.msg].payload, 'amount'), except(B[c.msg].payload, 'amount'))));
  ok('income writes differ from base only in isIncome', INCOME.every((c) => same(except(HEAD[c.msg].payload, 'isIncome'), except(B[c.msg].payload, 'isIncome'))));
  ok('category / subcategory of every message identical to base (no new routing)', ALL.every((m) => same(HEAD[m].payload && [HEAD[m].payload.category, HEAD[m].payload.subcategory], B[m].payload && [B[m].payload.category, B[m].payload.subcategory])));
}
ok('FIXED = DEPLOY: identical tenant results for all ' + ALL.length + ' messages', ALL.every((m) => same(HEAD[m], HEAD_DEPLOY[m])));

// ---------- 5. source contract ----------
console.log('\n== 5. source contract ==');
const twF = extractFn(SRC.FIXED, '_tenantWriteExpense_'), twD = extractFn(SRC.DEPLOY, '_tenantWriteExpense_');
ok('_tenantWriteExpense_ is byte-identical in FIXED and DEPLOY', twF === twD);
// C41 later changed the tenant pick flow (three functions + _kflLearnFromPick_ right after
// _learnedSave); bot/test_c41_tenant_picker_isolation.js pins those. Everything else must still
// be byte-identical to the base.
const C41_PICK = ['_handleRelabelTap_', '_handlePendingTenantPick_', '_handlePendingCategoryText_'];
if (!SCOPE_PIN) console.log('  note  scope pins not run (set KFL_SCOPE_PIN=1)');
else if (!BASE) ok('KFL_SCOPE_PIN=1 needs the pinned ' + BASE_PIN.rev + ' objects', false);
if (SCOPE_PIN && BASE) {
  for (const [name, now, old] of [['FIXED', SRC.FIXED, BASE.fixed], ['DEPLOY', SRC.DEPLOY, BASE.deploy]]) {
    let swapped = old;
    for (const n of ['_tenantWriteExpense_'].concat(C41_PICK)) swapped = swapped.replace(extractFn(old, n), () => extractFn(now, n));
    let nowCore = now;
    if (now.indexOf('function _kflLearnFromPick_(') >= 0) {
      const ls = extractFn(now, '_learnedSave'), h = extractFn(now, '_kflLearnFromPick_');
      nowCore = now.slice(0, now.indexOf(ls) + ls.length) + now.slice(now.indexOf(h) + h.length);
    }
    ok(name + ': only _tenantWriteExpense_ differs from ' + BASE_PIN.rev + ' besides the C41 pick flow (owner, group, family, receipt, importer code untouched)', swapped === nowCore);
  }
}
ok('_tenantWriteExpense_ has no hard-coded isIncome:false and resolves the sign with _resolveIsIncome_', !/isIncome:\s*false/.test(twF) && twF.indexOf('_resolveIsIncome_(matched, rawText, matched.category, matched.subcategory)') > 0);
ok('_tenantWriteExpense_ converts with parseForeignCurrencyHint (single-item only) and still classifies inside the C34 gate',
  twF.indexOf('parseForeignCurrencyHint(rawText)') > 0 && twF.indexOf('parsed.items.length === 1') > 0 && twF.indexOf('_kflWithoutSpecialBusiness_(function () { return matchCategory(rawText); })') > 0);

// ---------- 6. mutation: the checks bite ----------
console.log('\n== 6. mutation ==');
{
  const env = load(SRC.FIXED);
  vm.runInContext('parseForeignCurrencyHint = function () { return null; };', env.ctx);
  const r = tenant(env, FX[0].msg);
  ok('conversion removed → "' + FX[0].msg + '" is booked raw again (' + (r.payload && money(r.payload.amount)) + ')', r.written && r.payload.amount === FX[0].raw);
  vm.runInContext('_resolveIsIncome_ = function () { return false; };', env.ctx);
  const s = tenant(env, INCOME[0].msg);
  ok('resolver forced to expense → "' + INCOME[0].msg + '" is booked as an expense again', s.written && s.payload.isIncome === false);
}

// ---------- 7. masking (only the files this change adds) ----------
console.log('\n== 7. masking ==');
const docPath = path.join(ROOT, 'docs', 'whatsapp-new-number-checklist.md');
const docText = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
const sensitive = [];
{ const m = SRC.FIXED.match(/const OWNER_PHONE = '(\d{9,15})'/); if (m) sensitive.push(m[1]); }
{ const m = SRC.FIXED.match(/body\.token === '([^']{6,})'/); if (m) sensitive.push(m[1]); }
{ const m = docText.match(new RegExp(['macros', 's', '([A-Za-z0-9_-]{20,})', 'exec'].join('\\/'))); if (m) sensitive.push(m[1]); }
const generic = [new RegExp(['script', 'google', 'com'].join('\\.') + '\\/macros\\/s\\/[A-Za-z0-9_-]{20,}'), /(?:\+?972[\s-]?|\b0)5\d(?:[\s-]?\d){7}\b/];
const scanHits = (files) => files.map((f) => { const t = fs.readFileSync(f, 'utf8'); return sensitive.filter((v) => t.indexOf(v) >= 0).length + generic.filter((g) => g.test(t)).length; }).reduce((a, b) => a + b, 0);
const scanFiles = [__filename, path.join(ROOT, 'docs', 'C40_TENANT_FX_INCOME.md')].filter((f) => fs.existsSync(f));
ok('no full phone / webhook URL / token in the files this change adds (' + scanFiles.length + ' files, ' + sensitive.length + ' values fingerprinted)', sensitive.length === 3 && scanHits(scanFiles) === 0);

// ---------- proof files (optional) ----------
if (OUT) {
  fs.mkdirSync(OUT, { recursive: true });
  const rows = ALL.map((m) => ({ msg: m, head: HEAD[m], base: B ? B[m] : null }));
  const summary = {
    test: 'bot/test_c40_tenant_fx_income.js', at: new Date().toISOString(), node: process.version, injectedRate: RATE,
    inputs: { HEAD_FIXED: blobSha1(Buffer.from(SRC.FIXED, 'utf8')), HEAD_DEPLOY: blobSha1(Buffer.from(SRC.DEPLOY, 'utf8')), base: BASE_PIN, baseAvailable: !!BASE },
    fxLiveCalls: HEAD.__cap.fxLive, outboundRefused: HEAD.__cap.refused, stubbedHelpers: Array.from(new Set(HEAD.__cap.stubbed)).sort(),
    maskedValuesChecked: sensitive.map((v, i) => ({ value: ['owner phone constant', 'direct-input token', 'webhook deployment id'][i], length: v.length, sha256_8: sha256(Buffer.from(v)).slice(0, 8) })),
    result: { pass, fail },
  };
  fs.writeFileSync(path.join(OUT, 'c40_summary.json'), JSON.stringify(summary, null, 1) + '\n');
  fs.writeFileSync(path.join(OUT, 'c40_rows.json'), JSON.stringify(rows, null, 1) + '\n');
  const outFiles = ['c40_summary.json', 'c40_rows.json'].map((f) => path.join(OUT, f));
  ok('proof files are masked too (' + outFiles.length + ' files)', scanHits(outFiles) === 0);
  fs.writeFileSync(path.join(OUT, 'c40_checks.json'), JSON.stringify(results, null, 1) + '\n');
}

console.log(`\ntest_c40_tenant_fx_income: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
