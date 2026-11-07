#!/usr/bin/env node
// bot/test_c38_owner_dict_isolation.js
//
// C38 (2026-11-03) offline regression: the OWNER's learned dictionary ('מילון לימוד')
// and Auto Synonyms tab must never classify — or be written by — a non-owner sender.
//
// Adapted from the C37 owner-isolation probe harness
// (work/kesefle-owner-isolation-probe-20261103/harness.js): same function extraction,
// node:vm sandbox, captured I/O, 41-message corpus and leak counting. Differences:
//   * evaluates the working-tree bot/ExpenseBot_FIXED.gs and bot/ExpenseBot_DEPLOY.gs;
//   * baselines 74666a8 / d57d48c5 are read from this repo's git objects by pinned SHA-1
//     (skipped with a note when git or the objects are unavailable);
//   * no live model; extra checks: owner keeps its dictionary, no-sender keeps it,
//     the write-backs are skipped for non-owners, owner-check errors fail closed,
//     a mutation (gate removed) brings the leaks back, source contract, FX / isIncome
//     (open P1 when written; fixed by T6 in C40 -- section 5 now asserts the fix);
//   * the masking scan covers only the files this change adds.
// MOCK I/O ONLY: no sheet, network, Properties, trigger or deployment. Synthetic IDs.
// Set KFL_OUT=<dir> to also write JSON/TXT proof files there.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIXDIR = path.join(ROOT, 'tests', 'fixtures', 'owner_isolation');
const OUT = process.env.KFL_OUT || '';
const SPECIAL = ['עסק מוזיקה', 'הוצאות ecom'];
const ID = { owner: '000000000001', tenant: '000000000002', member: '000000000003' }; // synthetic, not phone numbers
const BASELINE_PIN = {
  '74666a8': { fixed: '1f2d13e74a65d35242abe7b7937d100fa85b88d8', deploy: '7128a36c33c672ce1d31992a799bd894725cd977' },
  'd57d48c5': { fixed: '2fce0e3202d52ced727934e530990b0e37b23142', deploy: 'd62ab4ee914b1dc909459397c54bfcf90b831dbb' },
};

let pass = 0, fail = 0;
const results = [];
function ok(id, cond, extra) {
  results.push({ id, pass: !!cond, detail: extra === undefined ? null : extra });
  if (cond) { pass++; console.log('  ok    ' + id); } else { fail++; console.log('  FAIL  ' + id + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); }
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const blobSha1 = (b) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + b.length + '\0'), b])).digest('hex');

// ---------- inputs ----------
const SRC = {
  HEAD: fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8'),
  HEAD_DEPLOY: fs.readFileSync(path.join(__dirname, 'ExpenseBot_DEPLOY.gs'), 'utf8'),
};
function gitBlob(sha) {
  const buf = cp.execFileSync('git', ['--no-optional-locks', '-C', ROOT, 'cat-file', 'blob', sha], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  if (blobSha1(buf) !== sha) throw new Error('blob integrity ' + sha);
  return buf.toString('utf8');
}
const baselines = {};
for (const [rev, p] of Object.entries(BASELINE_PIN)) {
  try { baselines[rev] = { fixed: gitBlob(p.fixed), deploy: gitBlob(p.deploy) }; } catch (_) { baselines[rev] = null; }
}
const corpus = JSON.parse(fs.readFileSync(path.join(FIXDIR, 'corpus.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(FIXDIR, 'expected.json'), 'utf8'));
const c28 = JSON.parse(fs.readFileSync(path.join(FIXDIR, 'owner_dict_c28.json'), 'utf8')).rows;
const ecomFixture = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'claude_c33', 'ecom_block_c30v2.js'), 'utf8');
function parseDict(text, name) {
  const i = text.indexOf(name + ' ='); if (i < 0) throw new Error('missing ' + name);
  const j = text.indexOf('];', i);
  return Array.from(text.slice(i, j).matchAll(/\[\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/g)).map((m) => [m[1], m[2], m[3]]);
}
const DICT = {};
for (const [kw, cat, sub] of c28.concat(parseDict(ecomFixture, '_KFL_DICT_C30_'))) DICT[kw.toLowerCase().trim()] = { category: cat, subcategory: sub };

// ---------- extraction (identical to the C37 harness) ----------
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

// ---------- sandbox (identical to the C37 harness, plus optional extra globals) ----------
function load(src, withDict, extra) {
  const cap = { append: [], group: [], family: [], saves: [], blocked: 0 };
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, Logger: { log() {} },
    Utilities: { formatDate: () => '2026-11', computeDigest: () => [] },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'KESEFLE_BOT_SECRET' ? 'synthetic-test-value' : null), setProperty() {}, deleteProperty() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    UrlFetchApp: { fetch: (url, opts) => {
      if (/\/api\/sheet\/append(\?|$)/.test(String(url))) { cap.append.push(JSON.parse(opts.payload)); return { getResponseCode: () => 200, getContentText: () => '{"rowIndex":7}' }; }
      cap.blocked++; throw new Error('offline test: outbound call refused');
    } },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => ({ appendRow: (row) => cap.family.push(row), getLastRow: () => 2, getRange: () => ({ setNote() {} }) }) }) },
    KESEFLE_API_BASE: 'https://offline.invalid',
  };
  ctx._isOwnerPhone_ = (p) => String(p || '').replace(/\D/g, '') === ID.owner;
  ctx._groupAPI_ = (op, params) => (op === 'getactive' ? { ok: true, active: 'G1' } : (cap.group.push(params), { ok: true, memberCount: 2 }));
  ctx.kvGet = (k) => (String(k).indexOf('family:of:') === 0 ? 'F1' : (k === 'family:F1' ? { sheetId: 'synthetic-family-sheet' } : null));
  ctx._learnedLookup = (text) => {
    if (!withDict) return null;
    const t = String(text || '').toLowerCase().trim(); if (!t) return null;
    if (DICT[t]) return Object.assign({}, DICT[t]);
    let best = null, len = 0; for (const kw in DICT) if (kw.length > len && t.indexOf(kw) >= 0) { best = kw; len = kw.length; }
    return best ? Object.assign({}, DICT[best]) : null;
  };
  Object.assign(ctx, typeof extra === 'function' ? extra(cap) : {});
  vm.createContext(ctx);
  const code = [
    (src.match(/var _ORDER_MATERIALS_ = \[[^\]]+\];/) || ['var _ORDER_MATERIALS_ = [];'])[0],
    extractDecl(src, 'const CATEGORY_MAP = [', '[', ']'),
    extractDecl(src, 'var BUSINESS_CATEGORY_MAP = {', '{', '}'),
    extractDecl(src, 'const DEFAULT_CATEGORY =', '{', '}'),
    extractDecl(src, 'var _BIZ_DASH_SUBS = {', '{', '}'),
    extractDecl(src, 'var KFL_BIZ_OP_SET = {', '{', '}'),
    extractDecl(src, 'var KFL_FX_DEFAULTS = {', '{', '}'),
    'function _kfl_fxRateLive_() { return null; } // offline: no live FX',
    ...['_kfl_fxRate', '_kfl_fxLookup', '_kfl_currencyDisplay_', '_kfl_fxNote_', 'parseForeignCurrencyHint',
      '_kflIsWordChar_', '_kflKwHit_', '_kflBizOpHit_', '_matchCategory_orig', '_matchCategory_long', '_coerceCategoryBySubcategory', '_normalizeBizSub_'].map((n) => extractFn(src, n)),
    specialBlock(src),
    ...['matchCategory', 'matchCategorySmart', '_parseIsraeliNumber_', 'parseAmountAndDescription', 'sanitizeForSheet',
      '_isIncomeCategory_', '_resolveIsIncome_', // C40: the tenant writer now resolves the sign
      '_tenantWriteExpense_', '_groupRecordExpense_', '_familyLogExpense_'].map((n) => extractFn(src, n)),
  ].join('\n\n');
  vm.runInContext(code, ctx);
  return { ctx, cap, stubbed: [] };
}
function run(env, fn) {
  for (let attempt = 0; attempt < 80; attempt++) {
    env.cap.append.length = 0; env.cap.group.length = 0; env.cap.family.length = 0;
    try { return fn(env.ctx); } catch (e) {
      const m = e && /^(\S+) is not defined$/.exec(e.message || '');
      if (!m) throw e;
      env.stubbed.push(m[1]);
      vm.runInContext('function ' + m[1] + '() { return null; }', env.ctx);
    }
  }
  throw new Error('too many missing helpers');
}
const amountOf = (msg) => Number((msg.match(/\d+(?:\.\d+)?/) || [0])[0]);
const groupBody = (msg) => amountOf(msg) + ' ' + msg.replace(/\s*\d+(?:\.\d+)?\$?\s*/, ' ').trim();
const descOf = (msg) => msg.replace(/\s*\d+(?:\.\d+)?\$?\s*/, ' ').trim();
const isSp = (x) => !!(x && SPECIAL.indexOf(x.category) >= 0);
const pick = (o, keys) => { if (!o) return null; const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };

function probe(src, envMutator) {
  const env = load(src, true), envNoDict = load(src, false);
  if (envMutator) { envMutator(env); envMutator(envNoDict); }
  const rows = [];
  for (const item of corpus.audit_c36.concat(corpus.extra)) {
    const msg = item.msg, r = { id: item.id, kind: item.group, msg };
    run(env, (c) => c._tenantWriteExpense_(ID.tenant, msg, { phone: 'synthetic' }));
    const tp = env.cap.append[0];
    r.tenant = tp ? Object.assign({ written: true }, pick(tp, ['category', 'subcategory', 'amount', 'isIncome', 'currency'])) : { written: false, askedFirst: true };
    run(env, (c) => c._groupRecordExpense_(ID.member, groupBody(msg)));
    r.group = env.cap.group[0] ? Object.assign({ written: true }, pick(env.cap.group[0], ['category', 'subcategory', 'amount'])) : { written: false };
    run(env, (c) => c._familyLogExpense_(ID.member, 'member', amountOf(msg), descOf(msg)));
    r.family = env.cap.family[0] ? { written: true, category: env.cap.family[0][3], amount: env.cap.family[0][2] } : { written: false };
    r.receipt = pick(run(env, (c) => c.matchCategorySmart(msg, ID.tenant)), ['category', 'subcategory', 'isIncome']);
    r.receiptNoDict = pick(run(envNoDict, (c) => c.matchCategorySmart(msg, ID.tenant)), ['category', 'subcategory']);
    r.owner = pick(run(env, (c) => c.matchCategorySmart(msg, ID.owner)), ['category', 'subcategory', 'isIncome']);
    rows.push(r);
  }
  const main = rows.filter((r) => corpus.audit_c36.some((c) => c.id === r.id));
  const ids = (k) => main.filter((r) => isSp(r[k])).map((r) => r.id);
  const counts = { tenant: ids('tenant').length, group: ids('group').length, family: ids('family').length, receipt: ids('receipt').length, receiptNoDict: ids('receiptNoDict').length };
  const ownerSpecial = corpus.audit_c36.filter((c) => c.owner === 'special').map((c) => c.id);
  const controlIds = corpus.audit_c36.filter((c) => c.control).map((c) => c.id);
  return {
    counts, rows,
    ownerKept: main.filter((r) => ownerSpecial.indexOf(r.id) >= 0 && isSp(r.owner)).length,
    ownerDictHits: main.filter((r) => corpus.audit_c36.some((c) => c.id === r.id && c.owner === 'dict') && isSp(r.owner)).length,
    controlsLeaking: main.filter((r) => controlIds.indexOf(r.id) >= 0 && ['tenant', 'group', 'family', 'receipt', 'receiptNoDict'].some((k) => isSp(r[k]))).length,
    stubbed: Array.from(new Set(env.stubbed.concat(envNoDict.stubbed))).sort(),
    refused: env.cap.blocked + envNoDict.cap.blocked,
  };
}
const sameCounts = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- 1. the fix (working tree) ----------
console.log('\n== 1. HEAD (working tree) — 41 messages, non-owner paths ==');
const head = probe(SRC.HEAD), headDeploy = probe(SRC.HEAD_DEPLOY);
for (const k of ['tenant', 'group', 'family', 'receipt', 'receiptNoDict']) ok('HEAD ' + k + ' leaks = ' + expected.HEAD[k], head.counts[k] === expected.HEAD[k], head.counts[k]);
ok('HEAD owner keeps the special route ' + expected.HEAD.ownerKept + '/30', head.ownerKept === expected.HEAD.ownerKept, head.ownerKept);
ok('HEAD control messages never leak', head.controlsLeaking === expected.HEAD.controlsLeaking, head.controlsLeaking);
ok('HEAD owner still uses its own dictionary (7/7 dictionary-only words)', head.ownerDictHits === 7, head.ownerDictHits);
ok('HEAD FIXED = DEPLOY (identical counts)', sameCounts(head.counts, headDeploy.counts) && head.ownerKept === headDeploy.ownerKept, { fixed: head.counts, deploy: headDeploy.counts });

// ---------- 2. extra guards ----------
console.log('\n== 2. sender semantics, write-backs, fail-closed, mutation ==');
{
  const env = load(SRC.HEAD, true);
  ok('no sender (cron / internal) keeps the owner dictionary', isSp(run(env, (c) => c.matchCategorySmart('fl studio 50', ''))));
  ok('non-owner "fl studio 50" is not classified from the owner dictionary', !isSp(run(env, (c) => c.matchCategorySmart('fl studio 50', ID.member))));
  env.ctx._isOwnerPhone_ = () => { throw new Error('owner lookup failed'); };
  ok('owner-check error fails closed (no owner dictionary)', !isSp(run(env, (c) => c.matchCategorySmart('fl studio 50', ID.tenant))));
}
{
  const mk = (globalHit, ai) => load(SRC.HEAD, true, (cap) => ({
    _learnedSave: (t, r, s) => { cap.saves.push(s || 'ai'); },
    _globalLearnLookup_: () => (globalHit ? { category: 'בידור', subcategory: 'סטרימינג' } : null),
    _kfl_bigIndexLookup: () => null,
    _hasActivePremium_: () => true,
    _aiCategorizeRich: () => (ai ? { category: 'בידור', subcategory: 'סטרימינג', confidence_score: 0.9, contract: { should_ask_user: false, confidence_score: 0.9 } } : null),
  }));
  const g = mk(true, false);
  run(g, (c) => c.matchCategorySmart('zzqx probe 10', ID.tenant)); const gTen = g.cap.saves.length;
  run(g, (c) => c.matchCategorySmart('zzqx probe 10', ID.owner)); const gOwn = g.cap.saves.length - gTen;
  ok('global-learn hit: no write into the owner dictionary for a non-owner, owner still caches', gTen === 0 && gOwn === 1, { nonOwner: gTen, owner: gOwn });
  const a = mk(false, true);
  run(a, (c) => c.matchCategorySmart('zzqx probe 10', ID.member)); const aTen = a.cap.saves.length;
  run(a, (c) => c.matchCategorySmart('zzqx probe 10', ID.owner)); const aOwn = a.cap.saves.length - aTen;
  ok('AI result: no write into the owner dictionary for a non-owner, owner still caches', aTen === 0 && aOwn === 1, { nonOwner: aTen, owner: aOwn });
}
{
  const mut = probe(SRC.HEAD, (env) => vm.runInContext('_kflIsNonOwnerSender_ = function () { return false; };', env.ctx));
  ok('mutation: gate removed → family / receipt leaks come back (' + expected.mutationGateRemoved.family + ' / ' + expected.mutationGateRemoved.receipt + ')',
    mut.counts.family === expected.mutationGateRemoved.family && mut.counts.receipt === expected.mutationGateRemoved.receipt, mut.counts);
}

// ---------- 3. source contract ----------
console.log('\n== 3. source contract (FIXED and DEPLOY) ==');
for (const [name, src] of [['FIXED', SRC.HEAD], ['DEPLOY', SRC.HEAD_DEPLOY]]) {
  ok(name + ': _kflIsNonOwnerSender_ defined exactly once, inside the special block', src.split('function _kflIsNonOwnerSender_(').length === 2 && specialBlock(src).indexOf('function _kflIsNonOwnerSender_(') >= 0);
  const mcs = extractFn(src, 'matchCategorySmart');
  ok(name + ': step 1 / 1.5 read the owner sources only when allowed',
    mcs.indexOf('__kflOwnerDataOff ? null : _learnedLookup(text)') > 0 && mcs.indexOf('!__kflOwnerDataOff && typeof _autoSynonymLookup_') > 0);
  ok(name + ': both write-backs are guarded', (mcs.match(/if \(!__kflOwnerDataOff\)[^\n]*_learnedSave\(/g) || []).length === 2 && (mcs.match(/_learnedSave\(/g) || []).length === 2);
  ok(name + ': the C34 owner gate still runs before any lookup', mcs.indexOf('_kflSpecialOffForSender_(fromPhone)') > 0 && mcs.indexOf('_kflSpecialOffForSender_(fromPhone)') < mcs.indexOf('_learnedLookup('));
}
ok('matchCategorySmart and the special block are byte-identical in FIXED and DEPLOY',
  extractFn(SRC.HEAD, 'matchCategorySmart') === extractFn(SRC.HEAD_DEPLOY, 'matchCategorySmart') && specialBlock(SRC.HEAD) === specialBlock(SRC.HEAD_DEPLOY));

// ---------- 4. baselines (prove the probe still detects the leak on the old code) ----------
console.log('\n== 4. baselines from git objects (pinned) ==');
const base = {};
for (const rev of ['74666a8', 'd57d48c5']) {
  if (!baselines[rev]) { console.log('  note  ' + rev + ': objects unavailable here — baseline skipped'); continue; }
  base[rev] = probe(baselines[rev].fixed);
  const e = expected[rev];
  ok(rev + ' baseline reproduced (' + ['tenant', 'group', 'family', 'receipt', 'receiptNoDict'].map((k) => e[k]).join('/') + ', owner ' + e.ownerKept + ')',
    ['tenant', 'group', 'family', 'receipt', 'receiptNoDict'].every((k) => base[rev].counts[k] === e[k]) && base[rev].ownerKept === e.ownerKept && base[rev].controlsLeaking === e.controlsLeaking, base[rev].counts);
}

// ---------- 5. FX / isIncome: the P1 left open by C38 is fixed by T6 (C40) ----------
// The leak counts in sections 1-4 are unchanged by T6; these two checks now assert the fix.
// Rate: this sandbox's static table (the live fetch is stubbed off); the injected-rate
// regression is bot/test_c40_tenant_fx_income.js.
console.log('\n== 5. FX / isIncome — fixed by T6 (C40) ==');
const pickFx = (p) => corpus.audit_c36.concat(corpus.extra).filter((c) => c.fx).map((c) => { const r = p.rows.find((x) => x.id === c.id); return { id: c.id, raw: c.fx.raw, tenantAmount: r.tenant.written ? r.tenant.amount : null }; });
const pickInc = (p) => corpus.audit_c36.concat(corpus.extra).filter((c) => c.income).map((c) => { const r = p.rows.find((x) => x.id === c.id); return { id: c.id, msg: c.msg, tenantIsIncome: r.tenant.written ? r.tenant.isIncome : null }; });
const fxHead = pickFx(head), incHead = pickInc(head);
const envT6 = load(SRC.HEAD, true);
const usdRate = run(envT6, (c) => c._kfl_fxRate('USD'));
const sign = (msg) => { const m = run(envT6, (c) => c._kflWithoutSpecialBusiness_(() => c.matchCategory(msg))); return !!run(envT6, (c) => c._resolveIsIncome_(m, msg, m && m.category, m && m.subcategory)); };
ok('T6: tenant FX amounts are converted to ILS (static rate ' + usdRate + ') — ' + fxHead.map((f) => f.id + '=' + (f.tenantAmount === null ? 'asked' : '₪' + f.tenantAmount)).join(' '),
  fxHead.some((f) => f.tenantAmount !== null) && fxHead.every((f) => f.tenantAmount === null || f.tenantAmount === Math.round(f.raw * usdRate * 100) / 100));
ok('T6: tenant isIncome follows the shared resolver — ' + incHead.map((x) => x.id + '=' + (x.tenantIsIncome === null ? 'asked' : x.tenantIsIncome)).join(' '),
  incHead.some((x) => x.id === 'K1' && x.tenantIsIncome === true) && incHead.every((x) => x.tenantIsIncome === null || x.tenantIsIncome === sign(x.msg)));
if (base['d57d48c5']) {
  ok('d57d48c5 baseline still books FX raw and isIncome=false (the T6 bugs before the fix)',
    pickFx(base['d57d48c5']).every((f) => f.tenantAmount === null || f.tenantAmount === f.raw) && pickInc(base['d57d48c5']).every((x) => x.tenantIsIncome === null || x.tenantIsIncome === false));
}

// ---------- 6. masking (only the files this change adds) ----------
console.log('\n== 6. masking ==');
const fixedText = SRC.HEAD;
const docPath = path.join(ROOT, 'docs', 'whatsapp-new-number-checklist.md');
const docText = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
const sensitive = [];
const sensitiveLabels = [];
const addSensitive = (label, match) => { if (match) { sensitive.push(match[1]); sensitiveLabels.push(label); } };
addSensitive('owner phone constant', fixedText.match(/const OWNER_PHONE = '(\d{9,15})'/));
addSensitive('direct-input token', fixedText.match(/body\.token === '([^']{6,})'/));
addSensitive('webhook deployment id', docText.match(new RegExp(['macros', 's', '([A-Za-z0-9_-]{20,})', 'exec'].join('\\/'))));
const generic = [new RegExp(['script', 'google', 'com'].join('\\.') + '\\/macros\\/s\\/[A-Za-z0-9_-]{20,}'), /(?:\+?972[\s-]?|\b0)5\d(?:[\s-]?\d){7}\b/];
const scanFiles = [__filename, path.join(FIXDIR, 'corpus.json'), path.join(FIXDIR, 'expected.json'), path.join(FIXDIR, 'owner_dict_c28.json'), path.join(ROOT, 'docs', 'C38_OWNER_DICT_ISOLATION.md')].filter((f) => fs.existsSync(f));
const scanHits = (files) => files.map((f) => { const t = fs.readFileSync(f, 'utf8'); return sensitive.filter((v) => t.indexOf(v) >= 0).length + generic.filter((g) => g.test(t)).length; }).reduce((a, b) => a + b, 0);
ok('no full phone / webhook URL / token in the files this change adds (' + scanFiles.length + ' files, ' + sensitive.length + ' values fingerprinted)', sensitive.length >= 1 && scanHits(scanFiles) === 0);

// ---------- proof files (optional) ----------
if (OUT) {
  fs.mkdirSync(OUT, { recursive: true });
  const fpr = sensitive.map((v, i) => ({ value: sensitiveLabels[i], length: v.length, sha256_8: sha256(Buffer.from(v)).slice(0, 8) }));
  const summary = {
    test: 'bot/test_c38_owner_dict_isolation.js', at: new Date().toISOString(), node: process.version,
    inputs: { HEAD_FIXED: blobSha1(Buffer.from(SRC.HEAD, 'utf8')), HEAD_DEPLOY: blobSha1(Buffer.from(SRC.HEAD_DEPLOY, 'utf8')), baselines: BASELINE_PIN, ownerDictionaryRows: Object.keys(DICT).length, corpus: corpus.audit_c36.length + '+' + corpus.extra.length },
    counts: { HEAD: head.counts, HEAD_DEPLOY: headDeploy.counts, '74666a8': base['74666a8'] && base['74666a8'].counts, 'd57d48c5': base['d57d48c5'] && base['d57d48c5'].counts },
    owner: { keptSpecial: head.ownerKept, dictHits: head.ownerDictHits }, controlsLeaking: head.controlsLeaking,
    fxIncomeT6: { fx: fxHead, isIncome: incHead, usdRate }, stubbedHelpers: head.stubbed, outboundRefused: head.refused,
    maskedValuesChecked: fpr, result: { pass, fail },
  };
  fs.writeFileSync(path.join(OUT, 'c38_summary.json'), JSON.stringify(summary, null, 1) + '\n');
  fs.writeFileSync(path.join(OUT, 'c38_rows_HEAD.json'), JSON.stringify(head.rows, null, 1) + '\n');
  fs.writeFileSync(path.join(OUT, 'c38_checks.json'), JSON.stringify(results, null, 1) + '\n');
  const outFiles = ['c38_summary.json', 'c38_rows_HEAD.json', 'c38_checks.json'].map((f) => path.join(OUT, f));
  const outHits = scanHits(outFiles);
  ok('proof files are masked too (' + outFiles.length + ' files)', outHits === 0, outHits);
  fs.writeFileSync(path.join(OUT, 'c38_checks.json'), JSON.stringify(results, null, 1) + '\n');
}

console.log(`\ntest_c38_owner_dict_isolation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
