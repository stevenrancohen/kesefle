#!/usr/bin/env node
// bot/test_c42_tenant_relabel_income.js
//
// C42 (2026-11-03) offline regression for the TENANT "change category" flow
// (_sendChangeCategoryPicker_ list -> _handleRelabelTap_ -> /api/sheet/relabel-row).
// Gap (proved on the pinned base): a tap on an income row of the list (its income
// section: salary, bonus, rental income, allowances, dividends, tax refund) sent no
// sign, so col H kept the old value -- an expense row moved to salary stayed an
// expense -- and the API wrote col E with an EXPENSE row label even for an income
// row, so an income row moved there vanished from both dashboard totals.
// Fix: for a non-owner, a tap on one of those rows takes its sign from
// _resolveIsIncome_ (the pick says income; the original text keeps the payroll /
// money-out guards), and relabel-row passes that sign to the existing income guard
// of normalizeSubcategoryForDashboard (as buildExpenseRow does on append).
// No routing change: col D and the col-E rule are the existing ones; the list is
// byte-identical; other taps and the owner are unchanged; C38/C40/C41 untouched.
// The dashboard model: a row counts as income when col H = income and col E is a
// personal income row label, as expense when col H = expense and col E is not, and
// is lost otherwise (lib/sheet-writer.js "disappearing-income" note).
// MOCK I/O ONLY: no sheet, network, Properties, trigger or deployment. Synthetic IDs.
// KFL_OUT=<dir> also writes JSON proof files.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.KFL_OUT || '';
// C44: the "only X differs from <pin>" / "byte-identical to <pin>" checks prove this change's
// minimality at commit time and would fail on any later bot edit, so they run only with
// KFL_SCOPE_PIN=1. Behaviour, owner isolation, FIXED/DEPLOY parity, fail-closed and mutation
// checks always run (bot/test_c44_optional_scope_pins.js guards this split).
const SCOPE_PIN = process.env.KFL_SCOPE_PIN === '1';
const OWNER = '000000000001', TENANT = '000000000002'; // synthetic, not phone numbers
const DICT_TAB = 'מילון לימוד';
const INCOME_SECTION = '📈 הכנסות';
const BASE_PIN = { rev: 'a1ea88b', fixed: '6bb459280e5831f261bfb58d8d4275577c4bfb6c', deploy: '15fab4676559e6a27a2a87caf39a8c090194521f', relabel: '7c636502d94fe553a824b7bfe973dfab9647db56' };

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
const safe = (fn) => { try { return fn(); } catch (_) { return false; } };

// ---------- inputs ----------
const SRC = {
  FIXED: fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8'),
  DEPLOY: fs.readFileSync(path.join(__dirname, 'ExpenseBot_DEPLOY.gs'), 'utf8'),
  RELABEL: fs.readFileSync(path.join(ROOT, 'api', 'sheet', 'relabel-row.js'), 'utf8'),
};
let BASE = null;
try { BASE = { fixed: gitBlob(BASE_PIN.fixed), deploy: gitBlob(BASE_PIN.deploy), relabel: gitBlob(BASE_PIN.relabel) }; } catch (_) { BASE = null; }
const WRITER = fs.readFileSync(path.join(ROOT, 'lib', 'sheet-writer.js'), 'utf8');
const PERSONAL_INCOME_ROWS = Array.from((WRITER.match(/const PERSONAL_INCOME_ROWS = \[([\s\S]*?)\];/) || ['', ''])[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);

// ---------- extraction (same as test_c38 / c40 / c41) ----------
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing function ' + name);
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}

// ---------- bot sandbox ----------
function load(src) {
  const cap = { ownerWrites: [], api: [], lists: [], refused: 0 };
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
      const m = /\/api\/(sheet\/relabel-row|learn)(\?|$)/.exec(String(url));
      if (!m) { cap.refused++; throw new Error('offline test: outbound call refused'); }
      cap.api.push({ ep: m[1], payload: JSON.parse(opts.payload) });
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true,"rowIndex":9}' };
    } },
    SpreadsheetApp: { openById: () => ({ getSheetByName: (n) => sheetStub(n), insertSheet: (n) => sheetStub(n) }) },
    SHEET_ID: 'synthetic-owner-sheet', KESEFLE_API_BASE: 'https://offline.invalid',
    sendWhatsAppInteractiveList: (to, header, body, footer, button, sections) => { cap.lists.push(JSON.parse(JSON.stringify(sections))); },
  };
  ctx._isOwnerPhone_ = (p) => String(p || '').replace(/\D/g, '') === OWNER;
  vm.createContext(ctx);
  const fns = ['sanitizeForSheet', '_globalLearnNorm_', '_sha256Hex_', '_globalLearnPublish_', '_learnedSave', '_kflIsNonOwnerSender_', '_kflLearnFromPick_',
    '_isIncomeCategory_', '_resolveIsIncome_', '_kfl_recentCats_', '_kfl_pushRecentCat_', '_kfl_buildRecentSection_', '_kfl_buildPickerSections_',
    '_sendChangeCategoryPicker_', '_handleRelabelTap_'];
  const code = [(src.match(/var _LEARNED_TAB_NAME = [^\n]+/) || [''])[0], 'var _learnedCache = null;', 'var _learnedCacheLoadedAt = 0;']
    .concat(fns.map((n) => extractFn(src, n))).join('\n\n');
  vm.runInContext(code, ctx);
  return { ctx, cap, store };
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

// ---------- API model: relabel-row.js col E rule + col H ----------
const apiPassesSign = (relSrc) => /normalizeSubcategoryForDashboard\(newSubcategory \|\| newCategory, newCategory, body\.isIncome === true\)/.test(relSrc);
const NORMALIZE_CACHE = {};
function normalizeAll(tuples) { // [sub, cat, isIncome] -> label, computed by the real lib/sheet-writer.js (ESM) in a child node
  const todo = tuples.filter((t) => !Object.prototype.hasOwnProperty.call(NORMALIZE_CACHE, JSON.stringify(t)));
  if (todo.length) {
    const url = pathToFileURL(path.join(ROOT, 'lib', 'sheet-writer.js')).href;
    const code = 'const m = await import(' + JSON.stringify(url) + '); let s = ""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => { const t = JSON.parse(s); process.stdout.write(JSON.stringify(t.map((x) => m.normalizeSubcategoryForDashboard(x[0], x[1], x[2])))); });';
    const out = JSON.parse(cp.execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { input: JSON.stringify(todo), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }));
    todo.forEach((t, i) => { NORMALIZE_CACHE[JSON.stringify(t)] = out[i]; });
  }
  return tuples.map((t) => NORMALIZE_CACHE[JSON.stringify(t)]);
}
function sheetAfter(payload, origIncome, relSrc) {
  const cat = payload.newCategory, sub = payload.newSubcategory;
  const flag = apiPassesSign(relSrc) ? payload.isIncome === true : undefined;
  const E = normalizeAll([[sub || cat, cat, flag]])[0];
  const H = typeof payload.isIncome === 'boolean' ? payload.isIncome : origIncome; // true = income
  const incomeLabel = PERSONAL_INCOME_ROWS.indexOf(E) >= 0;
  const counted = (H && incomeLabel) ? 'income' : (!H && !incomeLabel) ? 'expense' : 'lost';
  return { colD: cat, colE: E, income: H, counted };
}

// ---------- scenarios ----------
const lastExp = (desc, cat) => JSON.stringify({ rowIndex: 9, category: cat || 'אחר', subcategory: '', amount: 100, description: desc, at: 1 });
const SC = [
  // tenant taps on income rows of the list
  { id: 'T1', who: TENANT, desc: 'סופר', orig: false, pick: 'משכורת', want: 'income' },
  { id: 'T2', who: TENANT, desc: 'zzqx probe', orig: false, pick: 'בונוס', want: 'income' },
  { id: 'T3', who: TENANT, desc: 'zzqx refund', orig: false, pick: 'החזר מס', want: 'income' },
  { id: 'T4', who: TENANT, desc: 'בונוס', orig: true, pick: 'משכורת', want: 'income' },          // income row moved to another income row
  { id: 'T5', who: TENANT, desc: 'zzqx rent', orig: false, pick: 'שכר דירה (הכנסה)', want: 'income' },
  { id: 'T6', who: TENANT, desc: 'zzqx allowance', orig: false, pick: 'קצבאות', want: 'income' },
  { id: 'T7', who: TENANT, desc: 'zzqx dividend', orig: false, pick: 'דיבידנדים', want: 'income' },
  // the original text keeps the guards: paying a salary stays an expense
  { id: 'G1', who: TENANT, desc: 'שילמתי משכורת', orig: false, pick: 'משכורת', want: 'expense' },
  { id: 'G2', who: TENANT, desc: 'משכורת לעובד', orig: false, pick: 'משכורת', want: 'expense' },
  // controls: other taps and the owner keep the old behaviour
  { id: 'C1', who: TENANT, desc: 'zzqx movie', orig: false, pick: 'בידור', control: true },
  { id: 'C2', who: TENANT, desc: 'zzqx ad', orig: false, pick: 'עסק|שיווק', control: true },
  { id: 'C3', who: TENANT, desc: 'zzqx biz income', orig: false, pick: 'הכנסה מעסק', control: true },
  { id: 'C4', who: OWNER, desc: 'סופר', orig: false, pick: 'משכורת', control: true },
  { id: 'C5', who: TENANT, desc: 'zzqx custom', orig: false, pick: '__custom__', control: true },
];
function play(src, relSrc, sc) {
  const env = load(src);
  env.store['lastTenantExp:' + sc.who] = lastExp(sc.desc);
  const reply = run(env, (c) => c._handleRelabelTap_(sc.who, sc.pick));
  const w = env.cap.api.find((a) => a.ep === 'sheet/relabel-row');
  return {
    reply: reply && reply.replyText, payload: w ? w.payload : null,
    sheet: w ? sheetAfter(w.payload, sc.orig, relSrc) : null,
    dictWrites: env.cap.ownerWrites.filter((x) => x.tab === DICT_TAB).length, ownerSheetWrites: env.cap.ownerWrites.length,
    publishes: env.cap.api.filter((a) => a.ep === 'learn').map((a) => a.payload), refused: env.cap.refused,
  };
}
function playAll(src, relSrc) { const o = {}; for (const sc of SC) o[sc.id] = play(src, relSrc, sc); return o; }
function list(src, who, recents) {
  const env = load(src);
  if (recents) run(env, (c) => c.PropertiesService.getScriptProperties().setProperty('KFL_RC_' + who, JSON.stringify(recents)));
  run(env, (c) => c._sendChangeCategoryPicker_(who, 'אוכל'));
  return env.cap.lists[0] || null;
}
// Every row the picker DEFINES (its SECTIONS literal), with the tap id _kfl_buildPickerSections_ gives it.
function definedRows(src) {
  const f = extractFn(src, '_sendChangeCategoryPicker_'), out = [];
  for (const m of f.matchAll(/title: '([^']+)',\s*rows: \[([\s\S]*?)\n\s*\],/g)) {
    for (const r of m[2].matchAll(/\{\s*name:\s*'([^']+)'([^}]*)\}/g)) {
      const cat = (r[2].match(/cat:\s*'([^']+)'/) || [])[1], sub = (r[2].match(/sub:\s*'([^']+)'/) || [])[1];
      if (r[1].indexOf('__') === 0) continue;
      out.push({ section: m[1], name: r[1], tap: cat ? cat + '|' + (sub || r[1]) : r[1] });
    }
  }
  return out;
}
const tapSign = (src, relSrc, tap) => { const p = play(src, relSrc, { who: TENANT, desc: 'zzqx', orig: false, pick: tap }).payload; return p ? p.isIncome : 'no-write'; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const HEAD = playAll(SRC.FIXED, SRC.RELABEL), HEAD_DEPLOY = playAll(SRC.DEPLOY, SRC.RELABEL);
const B = BASE ? playAll(BASE.fixed, BASE.relabel) : null;
const want = SC.filter((s) => s.want);

// ---------- 1. the gap on the pinned base ----------
console.log('\n== 1. base ' + BASE_PIN.rev + ' (pinned git objects): the gap is reproduced ==');
if (!B) {
  console.log('  note  ' + BASE_PIN.rev + ': objects unavailable here — baseline skipped');
} else {
  const T = SC.filter((s) => /^T/.test(s.id));
  ok('base: a tenant tap on an income row sends no sign (isIncome ' + JSON.stringify(Array.from(new Set(T.map((s) => B[s.id].payload.isIncome)))) + ') — col H keeps the old value',
    T.every((s) => B[s.id].payload.isIncome === null));
  const wrongSign = T.filter((s) => B[s.id].sheet.counted === 'expense').map((s) => s.id), lost = T.filter((s) => B[s.id].sheet.counted === 'lost').map((s) => s.id);
  ok('base: expense rows moved to an income row stay expenses (' + wrongSign.join(' ') + ') and an income row moved there is lost from both totals (' + lost.join(' ') + ')',
    wrongSign.length === 6 && lost.length === 1 && lost[0] === 'T4', { wrongSign, lost, colE: B.T1.sheet.colE });
  const rows = definedRows(BASE.fixed), inc = rows.filter((r) => r.section === INCOME_SECTION);
  ok('base: the list carries no income mark — its ' + inc.length + ' income-section rows tap exactly like the other untagged rows (no sign)',
    inc.length === 6 && rows.filter((r) => r.tap.indexOf('|') < 0).every((r) => tapSign(BASE.fixed, BASE.relabel, r.tap) === null));
  const plain = list(BASE.fixed, TENANT), withRecents = list(BASE.fixed, TENANT, ['משכורת', 'בונוס']);
  const ids = (L) => [].concat.apply([], (L || []).map((x) => x.rows.map((r) => r.id)));
  ok('base: the list as sent (10-row cap) shows the income rows only through the "recent" section — ' + ids(plain).length + ' rows without recents, none of them income',
    ids(plain).length === 10 && !ids(plain).some((id) => inc.some((r) => 'relabel|' + r.tap === id)) && ids(withRecents).indexOf('relabel|משכורת') >= 0);
}

// ---------- 2. the fix ----------
console.log('\n== 2. HEAD: a tenant tap on an income row is booked as income ==');
for (const s of want) {
  const r = HEAD[s.id];
  ok(s.id + ' "' + s.desc + '" → ' + s.pick + ': isIncome=' + (r.payload && r.payload.isIncome) + ', col E "' + (r.sheet && r.sheet.colE) + '", counted as ' + (r.sheet && r.sheet.counted),
    !!r.sheet && r.sheet.counted === s.want && r.payload.isIncome === (s.want === 'income'), r.sheet);
}
ok('every income tap agrees with the shared resolver (pick = income, original text)', SC.filter((s) => /^[TG]/.test(s.id)).every((s) => {
  const env = load(SRC.FIXED); return HEAD[s.id].payload.isIncome === !!run(env, (c) => c._resolveIsIncome_({ isIncome: true }, s.desc, s.pick, ''));
}));
ok('col D (category) is the tapped name, as before — no routing change', want.every((s) => HEAD[s.id].payload.newCategory === s.pick && HEAD[s.id].payload.newSubcategory === ''));
{
  const rows = definedRows(SRC.FIXED), incTaps = rows.filter((r) => r.section === INCOME_SECTION).map((r) => r.tap);
  const signs = rows.map((r) => ({ tap: r.tap, sign: tapSign(SRC.FIXED, SRC.RELABEL, r.tap), tagged: r.tap.indexOf('|') >= 0 }));
  const marked = signs.filter((x) => x.sign === true).map((x) => x.tap);
  ok('the rows booked as income are exactly the list\'s income section (' + incTaps.length + ' of ' + rows.length + ' rows); other untagged rows still send no sign, tagged rows still false',
    incTaps.length === 6 && same(marked.slice().sort(), incTaps.slice().sort()) &&
    signs.every((x) => x.sign === true || (x.tagged ? x.sign === false : x.sign === null)), { marked });
  const withRecents = list(SRC.FIXED, TENANT, ['משכורת']);
  const recentRow = (withRecents || []).some((x) => x.rows.some((r) => r.id === 'relabel|משכורת'));
  ok('the realistic path — "משכורת" offered from the recent section — is booked as income too', recentRow && tapSign(SRC.FIXED, SRC.RELABEL, 'משכורת') === true);
}

// ---------- 3. nothing else changes ----------
console.log('\n== 3. owner, other taps, list, learning: unchanged ==');
if (B) {
  for (const s of SC.filter((x) => x.control)) {
    ok(s.id + ' ' + (s.who === OWNER ? 'owner' : 'tenant') + ' tap "' + s.pick + '": payload, reply and learning identical to base', same(HEAD[s.id].payload, B[s.id].payload) && HEAD[s.id].reply === B[s.id].reply && same(HEAD[s.id].publishes, B[s.id].publishes) && HEAD[s.id].dictWrites === B[s.id].dictWrites);
  }
  ok('replies identical to base for every scenario', SC.every((s) => HEAD[s.id].reply === B[s.id].reply));
  ok('the change-category list is byte-identical to base (tenant and owner)', same(list(SRC.FIXED, TENANT), list(BASE.fixed, TENANT)) && same(list(SRC.FIXED, OWNER), list(BASE.fixed, OWNER)));
  ok('the shared hashed store (/api/learn) gets exactly the same publishes as base', SC.every((s) => same(HEAD[s.id].publishes, B[s.id].publishes)));
}
ok('C41 kept: no tenant tap writes the owner dictionary or any owner-sheet tab', SC.filter((s) => s.who === TENANT).every((s) => HEAD[s.id].dictWrites === 0 && HEAD[s.id].ownerSheetWrites === 0));
ok('FIXED = DEPLOY: identical results for all ' + SC.length + ' scenarios', SC.every((s) => same(HEAD[s.id], HEAD_DEPLOY[s.id])));
ok('no outbound call outside the captured endpoints', SC.every((s) => HEAD[s.id].refused === 0));

// ---------- 4. source contract ----------
console.log('\n== 4. source contract ==');
ok('_handleRelabelTap_ is byte-identical in FIXED and DEPLOY', extractFn(SRC.FIXED, '_handleRelabelTap_') === extractFn(SRC.DEPLOY, '_handleRelabelTap_'));
if (!SCOPE_PIN) console.log('  note  scope pins not run (set KFL_SCOPE_PIN=1)');
else if (!BASE) ok('KFL_SCOPE_PIN=1 needs the pinned ' + BASE_PIN.rev + ' objects', false);
if (SCOPE_PIN && BASE) {
  for (const [name, now, old] of [['FIXED', SRC.FIXED, BASE.fixed], ['DEPLOY', SRC.DEPLOY, BASE.deploy]]) {
    ok(name + ': only _handleRelabelTap_ differs from ' + BASE_PIN.rev, safe(() => old.replace(extractFn(old, '_handleRelabelTap_'), () => extractFn(now, '_handleRelabelTap_')) === now));
    const KEEP = ['matchCategorySmart', '_kflIsNonOwnerSender_', '_tenantWriteExpense_', '_kflLearnFromPick_', '_learnedSave', '_handlePendingTenantPick_', '_handlePendingCategoryText_', '_resolveIsIncome_', '_sendChangeCategoryPicker_', '_kfl_buildPickerSections_'];
    ok(name + ': C38 / C40 / C41 code and the list builder byte-identical to ' + BASE_PIN.rev + ' (' + KEEP.length + ' functions)', KEEP.every((n) => extractFn(now, n) === extractFn(old, n)));
  }
  ok('relabel-row.js: the only change passes the bot\'s sign into the existing col-E normalisation (plus a comment)', safe(() => {
    const a = BASE.relabel.split('\n'), b = SRC.RELABEL.split('\n');
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    let j = 0; while (j < a.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    const removed = a.slice(i, a.length - j), added = b.slice(i, b.length - j).filter((l) => !/^\s*\/\//.test(l)); // comments dropped
    const changed = removed.map((l, k) => (l === added[k] ? null : [l, added[k]])).filter(Boolean);
    return removed.length === added.length && changed.length === 1 &&
      /normalizeSubcategoryForDashboard\(newSubcategory \|\| newCategory, newCategory\)$/.test(changed[0][0].trim()) &&
      /normalizeSubcategoryForDashboard\(newSubcategory \|\| newCategory, newCategory, body\.isIncome === true\)$/.test(changed[0][1].trim()) &&
      apiPassesSign(SRC.RELABEL) && !apiPassesSign(BASE.relabel);
  }));
}
ok('the sign comes from _resolveIsIncome_ with the pick as income, for non-owners only', safe(() => { const f = extractFn(SRC.FIXED, '_handleRelabelTap_'); return f.indexOf('_resolveIsIncome_({ isIncome: true }, ') > 0 && f.indexOf('_kflIsNonOwnerSender_(fromPhone)') > 0; }));

// ---------- 5. mutation: both halves are needed ----------
console.log('\n== 5. mutation ==');
{
  const src = SRC.FIXED.replace('relIsIncome = !!_resolveIsIncome_({ isIncome: true }, ', 'relIsIncome = null && _resolveIsIncome_({ isIncome: true }, ');
  const r = play(src, SRC.RELABEL, SC[0]);
  ok('bot half removed → "' + SC[0].desc + '" moved to ' + SC[0].pick + ' is counted as ' + (r.sheet && r.sheet.counted) + ' again', !!r.sheet && r.sheet.counted === 'expense');
  if (BASE) {
    const s = play(SRC.FIXED, BASE.relabel, SC[0]);
    ok('API half removed → the income row lands on expense label "' + (s.sheet && s.sheet.colE) + '" and is counted as ' + (s.sheet && s.sheet.counted) + ' (lost from both totals)', !!s.sheet && s.sheet.counted === 'lost');
  }
}

// ---------- 6. masking (only the files this change adds) ----------
console.log('\n== 6. masking ==');
const docPath = path.join(ROOT, 'docs', 'whatsapp-new-number-checklist.md');
const docText = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
const sensitive = [];
{ const m = SRC.FIXED.match(/const OWNER_PHONE = '(\d{9,15})'/); if (m) sensitive.push(m[1]); }
{ const m = SRC.FIXED.match(/body\.token === '([^']{6,})'/); if (m) sensitive.push(m[1]); }
{ const m = docText.match(new RegExp(['macros', 's', '([A-Za-z0-9_-]{20,})', 'exec'].join('\\/'))); if (m) sensitive.push(m[1]); }
const generic = [new RegExp(['script', 'google', 'com'].join('\\.') + '\\/macros\\/s\\/[A-Za-z0-9_-]{20,}'), /(?:\+?972[\s-]?|\b0)5\d(?:[\s-]?\d){7}\b/];
const scanHits = (files) => files.map((f) => { const t = fs.readFileSync(f, 'utf8'); return sensitive.filter((v) => t.indexOf(v) >= 0).length + generic.filter((g) => g.test(t)).length; }).reduce((a, b) => a + b, 0);
const scanFiles = [__filename, path.join(ROOT, 'docs', 'C42_TENANT_RELABEL_INCOME.md')].filter((f) => fs.existsSync(f));
ok('no full phone / webhook URL / token in the files this change adds (' + scanFiles.length + ' files, ' + sensitive.length + ' values fingerprinted)', sensitive.length === 3 && scanHits(scanFiles) === 0);

// ---------- proof files (optional) ----------
if (OUT) {
  fs.mkdirSync(OUT, { recursive: true });
  const rows = SC.map((s) => ({ id: s.id, who: s.who === OWNER ? 'owner' : 'tenant', desc: s.desc, origIncome: s.orig, pick: s.pick, head: HEAD[s.id], base: B ? B[s.id] : null }));
  const summary = { test: 'bot/test_c42_tenant_relabel_income.js', at: new Date().toISOString(), node: process.version, personalIncomeRows: PERSONAL_INCOME_ROWS,
    inputs: { HEAD_FIXED: blobSha1(Buffer.from(SRC.FIXED, 'utf8')), HEAD_DEPLOY: blobSha1(Buffer.from(SRC.DEPLOY, 'utf8')), HEAD_RELABEL: blobSha1(Buffer.from(SRC.RELABEL, 'utf8')), base: BASE_PIN, baseAvailable: !!BASE },
    maskedValuesChecked: sensitive.map((v, i) => ({ value: ['owner phone constant', 'direct-input token', 'webhook deployment id'][i], length: v.length, sha256_8: sha256(Buffer.from(v)).slice(0, 8) })),
    result: { pass, fail } };
  fs.writeFileSync(path.join(OUT, 'c42_summary.json'), JSON.stringify(summary, null, 1) + '\n');
  fs.writeFileSync(path.join(OUT, 'c42_rows.json'), JSON.stringify(rows, null, 1) + '\n');
  const outFiles = ['c42_summary.json', 'c42_rows.json'].map((f) => path.join(OUT, f));
  ok('proof files are masked too (' + outFiles.length + ' files)', scanHits(outFiles) === 0);
  fs.writeFileSync(path.join(OUT, 'c42_checks.json'), JSON.stringify(results, null, 1) + '\n');
}

console.log(`\ntest_c42_tenant_relabel_income: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
