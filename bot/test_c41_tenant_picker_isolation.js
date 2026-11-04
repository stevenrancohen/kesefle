#!/usr/bin/env node
// bot/test_c41_tenant_picker_isolation.js
//
// C41 (2026-11-03) offline regression for the TENANT category-pick flows that run
// after a picker:
//   * _handleRelabelTap_          -- the change-category list under every tenant
//                                    confirmation ("relabel|<cat>" / "relabel|<cat>|<sub>");
//   * _handlePendingTenantPick_   -- a tap on the ask-before-default list ("pending|<cat>");
//   * _handlePendingCategoryText_ -- a typed answer to that list (number, name, create).
// Invariants:
//   (1) a tenant's pick is never written into the OWNER's learned dictionary
//       ('מילון לימוד' in SHEET_ID) or the Auto Synonyms tab -- the shared, hashed
//       cross-user store (/api/learn) keeps receiving it exactly as before;
//   (2) a pick that writes a new row takes its sign from _resolveIsIncome_ (the
//       resolver every owner write uses), not from the picked category alone;
//   (3) the owner's behaviour is unchanged, T6 (C40) is untouched.
// Baseline: the pinned 9fa09b9 blobs must still show the gap -- skipped with a note
// when git or the objects are unavailable.
// MOCK I/O ONLY: no sheet, network, Properties, trigger or deployment. Synthetic IDs.
// KFL_OUT=<dir> also writes JSON proof files.
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
const OWNER = '000000000001', TENANT = '000000000002'; // synthetic, not phone numbers
const DICT_TAB = 'מילון לימוד', SYN_TAB = 'Auto Synonyms';
const BASE_PIN = { rev: '9fa09b9', fixed: '591a9e72cad693fc938f612882704e65248c936a', deploy: 'cab2a8d9f6b62cddd5584a86bbf81266f84591ec' };

let pass = 0, fail = 0;
const results = [];
function ok(id, cond, extra) {
  results.push({ id, pass: !!cond, detail: extra === undefined ? null : extra });
  if (cond) { pass++; console.log('  ok    ' + id); } else { fail++; console.log('  FAIL  ' + id + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); }
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const blobSha1 = (b) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + b.length + '\0'), b])).digest('hex');
const git = (args) => cp.execFileSync('git', ['--no-optional-locks', '-C', ROOT].concat(args), { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
function gitBlob(sha) { const buf = git(['cat-file', 'blob', sha]); if (blobSha1(buf) !== sha) throw new Error('blob integrity ' + sha); return buf.toString('utf8'); }

// ---------- inputs ----------
const SRC = {
  FIXED: fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8'),
  DEPLOY: fs.readFileSync(path.join(__dirname, 'ExpenseBot_DEPLOY.gs'), 'utf8'),
};
let BASE = null;
try { BASE = { fixed: gitBlob(BASE_PIN.fixed), deploy: gitBlob(BASE_PIN.deploy) }; } catch (_) { BASE = null; }

// ---------- extraction (same as test_c38 / test_c40) ----------
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
const hasFn = (src, name) => src.indexOf('function ' + name + '(') >= 0;
const safe = (fn) => { try { return fn(); } catch (_) { return false; } };

// ---------- sandbox: captured owner-sheet writes, API calls and learning calls ----------
function load(src) {
  const cap = { ownerWrites: [], api: [], learnCalls: [], sent: 0, refused: 0 };
  const props = { KESEFLE_BOT_SECRET: 'synthetic-test-value' };
  const store = {};
  const sheetStub = (name) => ({
    getDataRange: () => ({ getValues: () => [['keyword', 'category', 'subcategory', 'source', 'updated_at']] }),
    appendRow: (row) => cap.ownerWrites.push({ tab: name, op: 'appendRow', row: row.slice(0, 4) }),
    getRange: (r, c) => ({ setValue: (v) => cap.ownerWrites.push({ tab: name, op: 'setValue', r, c, v }) }),
    getLastRow: () => 1,
  });
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, Logger: { log() {} },
    Utilities: {
      formatDate: () => '2026-11', DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null), put: (k, v) => { store[k] = v; }, remove: (k) => { delete store[k]; } }) },
    UrlFetchApp: { fetch: (url, opts) => {
      const u = String(url), m = /\/api\/(sheet\/append|sheet\/relabel-row|learn|sheet\/add-category-row)(\?|$)/.exec(u);
      if (!m) { cap.refused++; throw new Error('offline test: outbound call refused'); }
      cap.api.push({ ep: m[1], payload: JSON.parse(opts.payload) });
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true,"rowIndex":9}' };
    } },
    SpreadsheetApp: { openById: () => ({ getSheetByName: (n) => sheetStub(n), insertSheet: (n) => sheetStub(n) }) },
    SHEET_ID: 'synthetic-owner-sheet', KESEFLE_API_BASE: 'https://offline.invalid',
    sendWhatsAppInteractiveList: () => { cap.sent++; }, sendWhatsAppMessage: () => { cap.sent++; },
  };
  ctx._isOwnerPhone_ = (p) => String(p || '').replace(/\D/g, '') === OWNER;
  for (const n of ['_mtdTail_', '_sheetNudgeLine_', '_celebrateIfFirstExpense_', '_buildFullCategoriesTextBlock_']) ctx[n] = () => '';
  ctx._kflTrace_ = () => {};
  vm.createContext(ctx);
  const fns = ['sanitizeForSheet', '_globalLearnNorm_', '_sha256Hex_', '_globalLearnPublish_', '_learnedSave', '_kflIsNonOwnerSender_',
    '_isIncomeCategory_', '_resolveIsIncome_', '_parseIsraeliNumber_', '_kfl_recentCats_', '_kfl_pushRecentCat_',
    '_handleRelabelTap_', '_handlePendingTenantPick_', '_handlePendingCategoryText_'].concat(hasFn(src, '_kflLearnFromPick_') ? ['_kflLearnFromPick_'] : []);
  const code = [
    (src.match(/var _LEARNED_TAB_NAME = [^\n]+/) || [''])[0], 'var _learnedCache = null;', 'var _learnedCacheLoadedAt = 0;',
    extractDecl(src, 'var _CATEGORY_PICKER_GROUPS_ = [', '[', ']'), (src.match(/var _CATEGORY_PICKER_PAGE_SIZE_ = \d+;/) || [''])[0],
    ...fns.map((n) => extractFn(src, n)),
    'var __lsReal = _learnedSave; _learnedSave = function (t, r, s) { __learnSpy(t, r, s); return __lsReal(t, r, s); };',
  ].join('\n\n');
  ctx.__learnSpy = (t, r, s) => cap.learnCalls.push({ text: t, category: r && r.category, subcategory: r && r.subcategory, source: s });
  vm.runInContext(code, ctx);
  return { ctx, cap, store, props };
}
function run(env, fn) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { return fn(env.ctx); } catch (e) {
      const m = e && /^(\S+) is not defined$/.exec(e.message || '');
      if (!m) throw e;
      vm.runInContext('function ' + m[1] + '() { return null; }', env.ctx);
    }
  }
  throw new Error('too many missing helpers');
}

// ---------- scenarios ----------
const lastExp = (desc) => JSON.stringify({ rowIndex: 9, category: 'אחר', subcategory: '', amount: 50, description: desc, at: 1 });
const pend = (rawText, amount, description) => JSON.stringify({ rawText, amount, description, at: 1 });
const SC = [
  // relabel (change-category list after a tenant write)
  { id: 'R1', who: TENANT, kind: 'relabel', seed: lastExp('zzqx relabel probe'), pick: 'בידור' },
  { id: 'R2', who: TENANT, kind: 'relabel', seed: lastExp('zzqx tagged probe'), pick: 'עסק|שיווק' },
  { id: 'R3', who: OWNER, kind: 'relabel', seed: lastExp('zzqx owner probe'), pick: 'בידור' },
  // ask-before-default list: tap
  { id: 'P1', who: TENANT, kind: 'tap', seed: pend('+2000 עבודה', 2000, 'עבודה'), pick: 'עסק', income: true },
  { id: 'P2', who: TENANT, kind: 'tap', seed: pend('קיבלתי 500 מתנה', 500, 'קיבלתי מתנה'), pick: 'אירועים, תרומות, צרכי דת', income: true },
  { id: 'P5', who: TENANT, kind: 'tap', seed: pend('zzqx 80', 80, 'zzqx'), pick: 'מזון ופארמה', income: false },
  // ask-before-default list: typed answer
  { id: 'P3', who: TENANT, kind: 'text', seed: pend('פדיון 900', 900, 'פדיון'), pick: '17', income: true },
  { id: 'P4', who: TENANT, kind: 'text', seed: pend('+300 החזר', 300, 'החזר'), pick: 'פיננסים', income: true },
  { id: 'P6', who: TENANT, kind: 'text', seed: pend('שילמתי 500 לקבלן', 500, 'שילמתי לקבלן'), pick: 'דיור', income: false },
  { id: 'P7', who: TENANT, kind: 'text', seed: pend('שילמתי 500 משכורת', 500, 'שילמתי משכורת'), pick: 'צור קטגוריה הכנסות', income: false },
];
function play(src, sc) {
  const env = load(src);
  const clean = sc.who;
  env.store[(sc.kind === 'relabel' ? 'lastTenantExp:' : 'pendingExpense:') + clean] = sc.seed;
  let reply;
  if (sc.kind === 'relabel') reply = run(env, (c) => c._handleRelabelTap_(sc.who, sc.pick));
  else if (sc.kind === 'tap') reply = run(env, (c) => c._handlePendingTenantPick_(sc.who, sc.pick));
  else reply = run(env, (c) => c._handlePendingCategoryText_(sc.who, sc.pick));
  const write = env.cap.api.find((a) => a.ep === 'sheet/append' || a.ep === 'sheet/relabel-row') || null;
  const learn = env.cap.api.filter((a) => a.ep === 'learn').map((a) => a.payload);
  return {
    reply: reply && reply.replyText, write,
    dictWrites: env.cap.ownerWrites.filter((w) => w.tab === DICT_TAB).length,
    synWrites: env.cap.ownerWrites.filter((w) => w.tab === SYN_TAB).length,
    ownerSheetWrites: env.cap.ownerWrites.length,
    learnCalls: env.cap.learnCalls.length, publishes: learn, refused: env.cap.refused,
  };
}
function playAll(src) { const o = {}; for (const sc of SC) o[sc.id] = play(src, sc); return o; }
const resolver = (src, rawText, category) => { const env = load(src); return !!run(env, (c) => c._resolveIsIncome_(null, rawText, category, '')); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const withoutIncome = (w) => { if (!w) return w; const r = JSON.parse(JSON.stringify(w)); delete r.payload.isIncome; return r; };

const HEAD = playAll(SRC.FIXED), HEAD_DEPLOY = playAll(SRC.DEPLOY);
const B = BASE ? playAll(BASE.fixed) : null;
const tenantSc = SC.filter((s) => s.who === TENANT);
const pickSc = SC.filter((s) => s.kind !== 'relabel');

// ---------- 1. the gap on the pinned base ----------
console.log('\n== 1. base ' + BASE_PIN.rev + ' (pinned git objects): the gap is reproduced ==');
if (!B) {
  console.log('  note  ' + BASE_PIN.rev + ': objects unavailable here — baseline skipped');
} else {
  ok('base: a tenant relabel writes the tenant text into the OWNER dictionary (R1 ' + B.R1.dictWrites + ', R2 ' + B.R2.dictWrites + ' rows)', B.R1.dictWrites >= 1 && B.R2.dictWrites >= 1);
  ok('base: the pending pick calls the owner-dictionary writer with the tenant text (' + pickSc.map((s) => s.id + '=' + B[s.id].learnCalls).join(' ') + ')', pickSc.every((s) => B[s.id].learnCalls === 1));
  const wrong = pickSc.filter((s) => B[s.id].write && B[s.id].write.payload.isIncome !== s.income);
  ok('base: the pending pick takes the sign from the category only — wrong for ' + wrong.map((s) => s.id).join(', '), wrong.length === 5 && wrong.every((s) => s.id !== 'P5' && s.id !== 'P6'));
}

// ---------- 2. the fix: no owner-dictionary write for a tenant ----------
console.log('\n== 2. HEAD: a tenant pick never writes the owner dictionary or Auto Synonyms ==');
for (const s of tenantSc) {
  const r = HEAD[s.id];
  ok(s.id + ' tenant ' + s.kind + ' "' + s.pick + '": owner dictionary ' + r.dictWrites + ', Auto Synonyms ' + r.synWrites + ', owner-sheet writes ' + r.ownerSheetWrites + ', owner-writer calls ' + r.learnCalls,
    r.dictWrites === 0 && r.synWrites === 0 && r.ownerSheetWrites === 0 && r.learnCalls === 0, r);
}
{
  const env = load(SRC.FIXED);
  env.ctx._isOwnerPhone_ = () => { throw new Error('owner lookup failed'); };
  env.store['lastTenantExp:' + TENANT] = SC[0].seed;
  run(env, (c) => c._handleRelabelTap_(TENANT, SC[0].pick));
  ok('an owner-check error fails closed: the relabel still never writes the owner dictionary', env.cap.ownerWrites.filter((w) => w.tab === DICT_TAB).length === 0, env.cap.ownerWrites);
}
if (B) {
  ok('the shared hashed store (/api/learn) still receives every tenant relabel exactly as before (R1, R2)', ['R1', 'R2'].every((id) => HEAD[id].publishes.length === 1 && same(HEAD[id].publishes, B[id].publishes)), { head: HEAD.R1.publishes, base: B.R1.publishes });
  ok('pending picks publish nothing, as before (subcategory empty)', pickSc.every((s) => HEAD[s.id].publishes.length === 0 && B[s.id].publishes.length === 0));
}

// ---------- 3. the fix: the sign of a picked row comes from the shared resolver ----------
console.log('\n== 3. HEAD: a picked row takes its sign from _resolveIsIncome_ ==');
for (const s of pickSc) {
  const r = HEAD[s.id], raw = JSON.parse(s.seed).rawText;
  ok(s.id + ' "' + raw + '" → picked "' + s.pick + '" → isIncome=' + (r.write ? r.write.payload.isIncome : 'n/a'), !!r.write && r.write.payload.isIncome === s.income, r.write);
}
ok('every picked row agrees with the shared resolver', pickSc.every((s) => { const p = HEAD[s.id].write.payload; return p.isIncome === resolver(SRC.FIXED, JSON.parse(s.seed).rawText, p.category); }));

// ---------- 4. owner unchanged, nothing else changes ----------
console.log('\n== 4. owner and everything else unchanged ==');
if (B) {
  ok('owner relabel (R3): same owner-dictionary write, same publish, same reply as base', same(HEAD.R3, B.R3) && HEAD.R3.dictWrites === 1, { head: HEAD.R3, base: B.R3 });
  ok('relabel writes (relabel-row payload incl. isIncome) and replies identical to base', ['R1', 'R2'].every((id) => same(HEAD[id].write, B[id].write) && HEAD[id].reply === B[id].reply));
  ok('pending writes identical to base except isIncome (amount, category, rawText, phone)', pickSc.every((s) => same(withoutIncome(HEAD[s.id].write), withoutIncome(B[s.id].write))));
  ok('pending replies identical to base', pickSc.every((s) => HEAD[s.id].reply === B[s.id].reply));
}
ok('FIXED = DEPLOY: identical results for all ' + SC.length + ' scenarios', SC.every((s) => same(HEAD[s.id], HEAD_DEPLOY[s.id])));
ok('no outbound call outside the captured endpoints', SC.every((s) => HEAD[s.id].refused === 0));

// ---------- 5. source contract ----------
console.log('\n== 5. source contract ==');
const CHANGED = ['_handleRelabelTap_', '_handlePendingTenantPick_', '_handlePendingCategoryText_'];
ok('changed functions and _kflLearnFromPick_ are byte-identical in FIXED and DEPLOY', safe(() => CHANGED.concat(['_kflLearnFromPick_']).every((n) => extractFn(SRC.FIXED, n) === extractFn(SRC.DEPLOY, n))));
if (!SCOPE_PIN) console.log('  note  scope pins not run (set KFL_SCOPE_PIN=1)');
else if (!BASE) ok('KFL_SCOPE_PIN=1 needs the pinned ' + BASE_PIN.rev + ' objects', false);
if (SCOPE_PIN && BASE) {
  for (const [name, now, old] of [['FIXED', SRC.FIXED, BASE.fixed], ['DEPLOY', SRC.DEPLOY, BASE.deploy]]) {
    // Rebuild HEAD from the base: swap in the three pick functions, then insert the new helper
    // (with its comment) right after _learnedSave. Anything else that differs fails this check.
    ok(name + ': only the three pick functions + the new _kflLearnFromPick_ (right after _learnedSave) differ from ' + BASE_PIN.rev, safe(() => {
      let rebuilt = old;
      for (const n of CHANGED) rebuilt = rebuilt.replace(extractFn(old, n), () => extractFn(now, n));
      const lsNow = extractFn(now, '_learnedSave'), helper = extractFn(now, '_kflLearnFromPick_');
      const inserted = now.slice(now.indexOf(lsNow) + lsNow.length, now.indexOf(helper) + helper.length);
      const lsOld = extractFn(old, '_learnedSave');
      rebuilt = rebuilt.replace(lsOld, () => lsOld + inserted);
      return rebuilt === now;
    }));
    ok(name + ': T6 untouched — _tenantWriteExpense_ byte-identical to ' + BASE_PIN.rev, extractFn(now, '_tenantWriteExpense_') === extractFn(old, '_tenantWriteExpense_'));
    ok(name + ': the owner writer _learnedSave itself is unchanged', extractFn(now, '_learnedSave') === extractFn(old, '_learnedSave'));
  }
}
ok('the three pick functions no longer call the owner writer directly and no longer take the sign from the category alone', safe(() =>
  CHANGED.every((n) => !/_learnedSave\(/.test(extractFn(SRC.FIXED, n)) && extractFn(SRC.FIXED, n).indexOf('_kflLearnFromPick_(fromPhone, ') > 0) &&
  ['_handlePendingTenantPick_', '_handlePendingCategoryText_'].every((n) => !/isIncome: _isIncomeCategory_\(/.test(extractFn(SRC.FIXED, n)) && extractFn(SRC.FIXED, n).indexOf('_resolveIsIncome_(null, pending.rawText, ') > 0)));
{
  const defs = (SRC.FIXED.match(/function _askBeforeDefaulting_\(/g) || []).length;
  const calls = (SRC.FIXED.match(/_askBeforeDefaulting_\(/g) || []).length - defs;
  const puts = (SRC.FIXED.match(/\.put\('pendingExpense:'/g) || []).length;
  ok('the pending list is tenant-only by construction: _askBeforeDefaulting_ has one caller (_tenantWriteExpense_) and is the only writer of pendingExpense',
    defs === 1 && calls === 1 && extractFn(SRC.FIXED, '_tenantWriteExpense_').indexOf('_askBeforeDefaulting_(fromPhone') > 0 &&
    puts === 1 && extractFn(SRC.FIXED, '_askBeforeDefaulting_').indexOf("cache.put('pendingExpense:'") > 0, { defs, calls, puts });
}

// ---------- 6. mutation: the checks bite ----------
console.log('\n== 6. mutation ==');
{
  const src = SRC.FIXED.replace('function _kflIsNonOwnerSender_(fromPhone) {', 'function _kflIsNonOwnerSender_(fromPhone) { return false;');
  const r = play(src, SC[0]);
  ok('owner gate disabled → the tenant relabel writes the owner dictionary again (' + r.dictWrites + ')', r.dictWrites >= 1);
  const src2 = SRC.FIXED.replace('function _resolveIsIncome_(matched, rawText, category, subcategory) {', 'function _resolveIsIncome_(matched, rawText, category, subcategory) { return _isIncomeCategory_(category, subcategory);');
  const s = play(src2, SC.find((x) => x.id === 'P1'));
  ok('resolver reduced to the category → "+2000 עבודה" picked as עסק is an expense again', !!s.write && s.write.payload.isIncome === false);
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
const scanFiles = [__filename, path.join(ROOT, 'docs', 'C41_TENANT_PICKER_ISOLATION.md')].filter((f) => fs.existsSync(f));
ok('no full phone / webhook URL / token in the files this change adds (' + scanFiles.length + ' files, ' + sensitive.length + ' values fingerprinted)', sensitive.length === 3 && scanHits(scanFiles) === 0);

// ---------- proof files (optional) ----------
if (OUT) {
  fs.mkdirSync(OUT, { recursive: true });
  const rows = SC.map((s) => ({ id: s.id, who: s.who === OWNER ? 'owner' : 'tenant', kind: s.kind, pick: s.pick, seed: JSON.parse(s.seed), head: HEAD[s.id], base: B ? B[s.id] : null }));
  const summary = { test: 'bot/test_c41_tenant_picker_isolation.js', at: new Date().toISOString(), node: process.version,
    inputs: { HEAD_FIXED: blobSha1(Buffer.from(SRC.FIXED, 'utf8')), HEAD_DEPLOY: blobSha1(Buffer.from(SRC.DEPLOY, 'utf8')), base: BASE_PIN, baseAvailable: !!BASE },
    maskedValuesChecked: sensitive.map((v, i) => ({ value: ['owner phone constant', 'direct-input token', 'webhook deployment id'][i], length: v.length, sha256_8: sha256(Buffer.from(v)).slice(0, 8) })),
    result: { pass, fail } };
  fs.writeFileSync(path.join(OUT, 'c41_summary.json'), JSON.stringify(summary, null, 1) + '\n');
  fs.writeFileSync(path.join(OUT, 'c41_rows.json'), JSON.stringify(rows, null, 1) + '\n');
  const outFiles = ['c41_summary.json', 'c41_rows.json'].map((f) => path.join(OUT, f));
  ok('proof files are masked too (' + outFiles.length + ' files)', scanHits(outFiles) === 0);
  fs.writeFileSync(path.join(OUT, 'c41_checks.json'), JSON.stringify(results, null, 1) + '\n');
}

console.log(`\ntest_c41_tenant_picker_isolation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
