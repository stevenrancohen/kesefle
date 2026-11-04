#!/usr/bin/env node
// bot/test_c44_optional_scope_pins.js
//
// C44 (2026-11-04) guard for the KFL_SCOPE_PIN split in bot/test_c40_tenant_fx_income.js,
// bot/test_c41_tenant_picker_isolation.js and bot/test_c42_tenant_relabel_income.js.
// It proves, against the pinned base 44ef88e:
//   (1) the three files differ from the base only by the gate: no check removed or edited;
//   (2) default run = every base check except the named scope pins (behaviour, owner isolation,
//       FIXED/DEPLOY parity, fail-closed and mutation included);
//   (3) KFL_SCOPE_PIN=1 = every base check, each scope pin exactly once;
//   (4) a real regression still fails the default run, with no scope pin involved;
//   (5) an unrelated bot edit passes the default run and fails only the scope pins;
//   (6) failures propagate through tests/full_qa.js (forced exit, regression, scope pin);
//   (7) no product file differs from the base.
// Forced failures and source edits are injected through NODE_OPTIONS (--import of a data: URL
// that patches fs.readFileSync in the target process): no repo file is modified. The only file
// written is a trace file in a fresh os.tmpdir() folder, which is left in place.
// This file is deliberately NOT registered in full_qa (it runs full_qa, about 3 minutes), and
// check (7) is tied to this change: it is expected to fail after a later product commit.
// MOCK-FREE, OFFLINE: no sheet, network, Properties, trigger or deployment.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const QA = path.join(ROOT, 'tests', 'full_qa.js');
const BASE = '44ef88e195c6cba0c3f94f0ee706dd006d092eac';
const FIXED = 'bot/ExpenseBot_FIXED.gs', DEPLOY = 'bot/ExpenseBot_DEPLOY.gs', RELABEL = 'api/sheet/relabel-row.js';
const BOTH = [FIXED, DEPLOY];
const ALLOWED = ['bot/test_c40_tenant_fx_income.js', 'bot/test_c41_tenant_picker_isolation.js', 'bot/test_c42_tenant_relabel_income.js', 'bot/test_c44_optional_scope_pins.js', 'docs/C44_OPTIONAL_SCOPE_PINS.md'];

const twoFiles = (fn) => ['FIXED', 'DEPLOY'].map(fn);
const SUITES = [
  {
    key: 'c40', file: 'bot/test_c40_tenant_fx_income.js', total: 38,
    pins: twoFiles((n) => n + ': only _tenantWriteExpense_ differs from 265268d besides the C41 pick flow (owner, group, family, receipt, importer code untouched)'),
    unrelatedFails: twoFiles((n) => n + ': only _tenantWriteExpense_ differs from 265268d besides the C41 pick flow (owner, group, family, receipt, importer code untouched)'),
    keep: ['FX1 ', 'IN1 ', 'EX1 ', '_tenantWriteExpense_ is byte-identical in FIXED and DEPLOY', 'FIXED = DEPLOY: identical tenant results', 'conversion removed →', 'resolver forced to expense →', '_tenantWriteExpense_ has no hard-coded isIncome:false', 'injected rate only:'],
    regressions: [
      { name: 'T6 sign hard-coded to expense', edits: [{ files: BOTH, from: '    isIncome: __tIsInc,', to: '    isIncome: false,' }], expect: 'IN1 ' },
      { name: 'T6 FX conversion removed', edits: [{ files: BOTH, from: "var __tfx = (parsed.items.length === 1 && typeof parseForeignCurrencyHint === 'function') ? parseForeignCurrencyHint(rawText) : null;", to: 'var __tfx = null;' }], expect: 'FX1 ' },
      { name: 'source drift in DEPLOY only', edits: [{ files: [DEPLOY], from: 'var __tIsInc = false;', to: 'var __tIsInc = false; // drift' }], expect: '_tenantWriteExpense_ is byte-identical in FIXED and DEPLOY' },
      { name: 'behaviour drift in DEPLOY only', edits: [{ files: [DEPLOY], from: '    isIncome: __tIsInc,', to: '    isIncome: false,' }], expect: 'FIXED = DEPLOY: identical tenant results' },
    ],
  },
  {
    key: 'c41', file: 'bot/test_c41_tenant_picker_isolation.js', total: 41,
    pins: [].concat(...twoFiles((n) => [
      n + ': only the three pick functions + the new _kflLearnFromPick_ (right after _learnedSave) differ from 9fa09b9',
      n + ': T6 untouched — _tenantWriteExpense_ byte-identical to 9fa09b9',
      n + ': the owner writer _learnedSave itself is unchanged',
    ])),
    unrelatedFails: twoFiles((n) => n + ': only the three pick functions + the new _kflLearnFromPick_ (right after _learnedSave) differ from 9fa09b9'),
    keep: ['R1 tenant', 'P1 "', 'an owner-check error fails closed', 'changed functions and _kflLearnFromPick_ are byte-identical in FIXED and DEPLOY', 'FIXED = DEPLOY: identical results', 'owner gate disabled →', 'resolver reduced to the category →', 'the three pick functions no longer call the owner writer directly', 'the pending list is tenant-only by construction', 'owner relabel (R3)'],
    regressions: [
      { name: 'owner gate disabled', edits: [{ files: BOTH, from: 'function _kflIsNonOwnerSender_(fromPhone) {', to: 'function _kflIsNonOwnerSender_(fromPhone) { return false;' }], expect: 'R1 tenant' },
      { name: 'owner-check error fails open', edits: [{ files: BOTH, from: "try { return !_isOwnerPhone_(fromPhone); } catch (_e) { return true; }\n}\n\nfunction _kflSpecialBusinessRoute_(", to: "try { return !_isOwnerPhone_(fromPhone); } catch (_e) { return false; }\n}\n\nfunction _kflSpecialBusinessRoute_(" }], expect: 'an owner-check error fails closed' },
      { name: 'source drift in DEPLOY only', edits: [{ files: [DEPLOY], from: 'var __relIncomeRows = {', to: '// drift\n  var __relIncomeRows = {' }], expect: 'changed functions and _kflLearnFromPick_ are byte-identical in FIXED and DEPLOY' },
      { name: 'behaviour drift in DEPLOY only', edits: [{ files: [DEPLOY], from: 'function _kflIsNonOwnerSender_(fromPhone) {', to: 'function _kflIsNonOwnerSender_(fromPhone) { return false;' }], expect: 'FIXED = DEPLOY: identical results' },
    ],
  },
  {
    key: 'c42', file: 'bot/test_c42_tenant_relabel_income.js', total: 38,
    pins: [].concat(...twoFiles((n) => [
      n + ': only _handleRelabelTap_ differs from a1ea88b',
      n + ': C38 / C40 / C41 code and the list builder byte-identical to a1ea88b (10 functions)',
    ]), ["relabel-row.js: the only change passes the bot's sign into the existing col-E normalisation (plus a comment)"]),
    unrelatedFails: twoFiles((n) => n + ': only _handleRelabelTap_ differs from a1ea88b'),
    keep: ['T1 "', 'G1 "', 'C4 owner tap', '_handleRelabelTap_ is byte-identical in FIXED and DEPLOY', 'FIXED = DEPLOY: identical results', 'bot half removed →', 'API half removed →', 'C41 kept:', 'the sign comes from _resolveIsIncome_', 'the change-category list is byte-identical to base'],
    regressions: [
      { name: 'bot half of the sign removed', edits: [{ files: BOTH, from: 'relIsIncome = !!_resolveIsIncome_({ isIncome: true }, ', to: 'relIsIncome = null && _resolveIsIncome_({ isIncome: true }, ' }], expect: 'T1 "' },
      { name: 'API half of the sign removed', edits: [{ files: [RELABEL], from: 'newCategory, body.isIncome === true)', to: 'newCategory)' }], expect: 'T1 "' },
      { name: 'source drift in DEPLOY only', edits: [{ files: [DEPLOY], from: 'var __relIncomeRows = {', to: '// drift\n  var __relIncomeRows = {' }], expect: '_handleRelabelTap_ is byte-identical in FIXED and DEPLOY' },
      { name: 'behaviour drift in DEPLOY only', edits: [{ files: [DEPLOY], from: 'relIsIncome = !!_resolveIsIncome_({ isIncome: true }, ', to: 'relIsIncome = null && _resolveIsIncome_({ isIncome: true }, ' }], expect: 'FIXED = DEPLOY: identical results' },
    ],
  },
];
const UNRELATED = [{ files: BOTH, from: 'function _kflIsNonOwnerSender_(fromPhone) {', to: 'function _kflC44UnrelatedProbe_() { return 1; }\n\nfunction _kflIsNonOwnerSender_(fromPhone) {' }];
const GATE_ADDED = [
  '// C44: the "only X differs from <pin>" / "byte-identical to <pin>" checks prove this change\'s',
  '// minimality at commit time and would fail on any later bot edit, so they run only with',
  '// KFL_SCOPE_PIN=1. Behaviour, owner isolation, FIXED/DEPLOY parity, fail-closed and mutation',
  '// checks always run (bot/test_c44_optional_scope_pins.js guards this split).',
  "const SCOPE_PIN = process.env.KFL_SCOPE_PIN === '1';",
  "if (!SCOPE_PIN) console.log('  note  scope pins not run (set KFL_SCOPE_PIN=1)');",
  "else if (!BASE) ok('KFL_SCOPE_PIN=1 needs the pinned ' + BASE_PIN.rev + ' objects', false);",
  'if (SCOPE_PIN && BASE) {',
];

let pass = 0, fail = 0;
function ok(id, cond, extra) {
  if (cond) { pass++; console.log('  ok    ' + id); } else { fail++; console.log('  FAIL  ' + id + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => a.slice().sort();
const blobSha1 = (b) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + b.length + '\0'), b])).digest('hex');
const git = (args) => cp.execFileSync('git', ['--no-optional-locks', '-C', ROOT].concat(args), { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).toString('utf8');

// Runs in every child through NODE_OPTIONS. An edit whose text is not in the file exits 99, so a
// stale edit can never pass as "the regression was caught" (those runs must exit exactly 1).
const PRELOAD = 'import fs from "node:fs"; const a = process.argv[1] || ""; const e = process.env; ' +
  'if (e.KFL_C44_TRACE && a) fs.appendFileSync(e.KFL_C44_TRACE, a + "\\t" + (e.KFL_SCOPE_PIN || "") + "\\n"); ' +
  'if (e.KFL_C44_FORCE && a.endsWith(e.KFL_C44_FORCE)) process.exit(1); ' +
  'if (e.KFL_C44_PATCH) { const p = JSON.parse(e.KFL_C44_PATCH); if (!p.only || p.only.some((o) => a.endsWith(o))) { const real = fs.readFileSync; ' +
  'fs.readFileSync = function (f, ...r) { const v = real.call(this, f, ...r); let s = null; for (const x of p.edits) for (const t of x.files) if (String(f).endsWith(t)) { ' +
  's = s === null ? String(v) : s; if (s.indexOf(x.from) < 0) process.exit(99); s = s.replace(x.from, () => x.to); } ' +
  'return s === null ? v : (typeof v === "string" ? s : Buffer.from(s)); }; } }';
const NODE_OPTIONS = '--import=data:text/javascript,' + encodeURIComponent(PRELOAD);

// One clean environment per run: nothing inherited can switch the pins on or inject a failure.
function childEnv(extra) {
  const env = Object.assign({}, process.env, { NODE_OPTIONS, KFL_OUT: '' }, extra);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}
const SCOPE = { KFL_SCOPE_PIN: '1' }, NO_SCOPE = { KFL_SCOPE_PIN: undefined };
function parse(stdout) {
  const lines = String(stdout || '').split('\n');
  const passed = lines.filter((l) => l.startsWith('  ok    ')).map((l) => l.slice(8));
  const failed = lines.filter((l) => l.startsWith('  FAIL  ')).map((l) => l.slice(8).replace(/ {2}\[.*$/, ''));
  return { passed, failed, all: passed.concat(failed) };
}
function runSuite(file, extra) {
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, env: childEnv(extra), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return Object.assign({ status: r.status }, parse(r.stdout));
}
// The base version of a test, compiled from git under the real file name: nothing is written.
function runBaseVersion(file) {
  const abs = path.join(ROOT, file);
  const driver = 'const M = require("node:module"), p = require("node:path"); const f = process.argv[1]; const m = new M(f); m.filename = f; m.paths = M._nodeModulePaths(p.dirname(f)); m._compile(require("node:fs").readFileSync(0, "utf8"), f);';
  const r = cp.spawnSync(process.execPath, ['-e', driver, abs], { cwd: ROOT, env: childEnv(NO_SCOPE), input: git(['show', BASE + ':' + file]), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return Object.assign({ status: r.status }, parse(r.stdout));
}
function runQa(extra) {
  const r = cp.spawnSync(process.execPath, [QA], { cwd: ROOT, env: childEnv(extra), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, last: String(r.stdout || '').trim().split('\n').pop() };
}
const patch = (edits, only) => ({ KFL_C44_PATCH: JSON.stringify({ edits, only }) });
const startsAny = (id, prefix) => id.indexOf(prefix) === 0;

// ---------- 1. the diff is only the gate ----------
console.log('\n== 1. the three test files differ from ' + BASE.slice(0, 7) + ' only by the gate ==');
for (const s of SUITES) {
  const lines = git(['diff', '-U0', BASE, '--', s.file]).split('\n').filter((l) => /^[-+]/.test(l) && !/^(\+\+\+|---)/.test(l));
  const removed = lines.filter((l) => l[0] === '-').map((l) => l.slice(1)), added = lines.filter((l) => l[0] === '+').map((l) => l.slice(1));
  ok(s.key + ': one line removed (`if (BASE) {`), so no check was removed or edited', same(removed, ['if (BASE) {']), removed);
  ok(s.key + ': the added lines are exactly the ' + GATE_ADDED.length + ' gate lines', same(added, GATE_ADDED), added);
}

// ---------- 2-3. default and KFL_SCOPE_PIN=1 against the base version of each test ----------
console.log('\n== 2. default and KFL_SCOPE_PIN=1 against the base version of each test ==');
const HEALTHY = {};
for (const s of SUITES) {
  const base = runBaseVersion(s.file), def = runSuite(s.file, NO_SCOPE), pin = runSuite(s.file, SCOPE), off = runSuite(s.file, { KFL_SCOPE_PIN: '0' });
  HEALTHY[s.key] = def;
  ok(s.key + ': base version runs ' + s.total + ' checks, all green', base.status === 0 && base.passed.length === s.total && base.failed.length === 0, { status: base.status, n: base.passed.length });
  ok(s.key + ': all ' + s.pins.length + ' named pins exist in the base version, each once', s.pins.every((p) => base.all.filter((x) => x === p).length === 1), s.pins.filter((p) => base.all.indexOf(p) < 0));
  ok(s.key + ': default = base minus exactly the named pins (' + def.passed.length + ' checks, exit 0)', def.status === 0 && def.failed.length === 0 && same(sorted(def.all), sorted(base.all.filter((x) => s.pins.indexOf(x) < 0))) && def.all.length === s.total - s.pins.length, { status: def.status, n: def.all.length });
  ok(s.key + ': default runs none of the pins', !def.all.some((x) => s.pins.indexOf(x) >= 0));
  ok(s.key + ': default still runs the behaviour / isolation / parity / fail-closed / mutation checks (' + s.keep.length + ' named)', s.keep.every((k) => def.passed.some((x) => startsAny(x, k))), s.keep.filter((k) => !def.passed.some((x) => startsAny(x, k))));
  ok(s.key + ': KFL_SCOPE_PIN=1 = the whole base version (' + pin.passed.length + ' checks, exit 0)', pin.status === 0 && pin.failed.length === 0 && same(sorted(pin.all), sorted(base.all)), { status: pin.status, n: pin.all.length });
  ok(s.key + ': KFL_SCOPE_PIN=1 runs each of the ' + s.pins.length + ' pins exactly once', s.pins.every((p) => pin.passed.filter((x) => x === p).length === 1));
  ok(s.key + ': any other value (KFL_SCOPE_PIN=0) stays on the default set', off.status === 0 && same(sorted(off.all), sorted(def.all)));
  const noGitDef = runSuite(s.file, Object.assign({ PATH: path.join(os.tmpdir(), 'kfl-c44-no-such-dir') }, NO_SCOPE)), noGitPin = runSuite(s.file, Object.assign({ PATH: path.join(os.tmpdir(), 'kfl-c44-no-such-dir') }, SCOPE));
  ok(s.key + ': pinned objects unavailable: default exits 0, KFL_SCOPE_PIN=1 fails closed instead of skipping', noGitDef.status === 0 && noGitPin.status === 1 && noGitPin.failed.some((x) => /^KFL_SCOPE_PIN=1 needs the pinned /.test(x)), { def: noGitDef.status, pin: noGitPin.status, failed: noGitPin.failed });
}

// ---------- 4. real regressions, default run ----------
console.log('\n== 3. a real regression still fails the default run, no scope pin involved ==');
for (const s of SUITES) {
  for (const m of s.regressions) {
    const r = runSuite(s.file, Object.assign({}, NO_SCOPE, patch(m.edits)));
    ok(s.key + ': ' + m.name + ' → exit 1, ' + r.failed.length + ' checks fail', r.status === 1 && r.failed.some((x) => startsAny(x, m.expect)) && !r.all.some((x) => s.pins.indexOf(x) >= 0), { status: r.status, failed: r.failed.slice(0, 4) });
  }
}

// ---------- 5. an unrelated bot edit ----------
console.log('\n== 4. an unrelated bot edit passes the default run and fails only scope pins ==');
for (const s of SUITES) {
  const d = runSuite(s.file, Object.assign({}, NO_SCOPE, patch(UNRELATED))), p = runSuite(s.file, Object.assign({}, SCOPE, patch(UNRELATED)));
  ok(s.key + ': default exits 0 with the same ' + d.passed.length + ' checks', d.status === 0 && d.failed.length === 0 && same(sorted(d.passed), sorted(HEALTHY[s.key].passed)), { status: d.status, failed: d.failed });
  ok(s.key + ': KFL_SCOPE_PIN=1 exits 1 with exactly the "only X differs" pins failing (' + p.failed.length + ')', p.status === 1 && same(sorted(p.failed), sorted(s.unrelatedFails)), { status: p.status, failed: p.failed });
}

// ---------- 6. through tests/full_qa.js ----------
console.log('\n== 5. through tests/full_qa.js ==');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kfl-c44-'));
const traced = (name, extra) => {
  const trace = path.join(dir, name + '.txt');
  const r = runQa(Object.assign({ KFL_C44_TRACE: trace }, extra));
  const rows = (fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '').split('\n').filter(Boolean).map((l) => l.split('\t'));
  return Object.assign(r, { rows: rows.map((x) => [path.relative(ROOT, x[0]), x[1]]) });
};
const healthy = traced('default', NO_SCOPE), scoped = traced('scoped', SCOPE);
ok('healthy default: full_qa exits 0 — "' + healthy.last + '"', healthy.status === 0 && /ALL \d+ CHECKS PASSED/.test(healthy.last));
ok('KFL_SCOPE_PIN=1: full_qa exits 0 — "' + scoped.last + '"', scoped.status === 0 && scoped.last === healthy.last);
for (const s of SUITES) {
  ok(s.key + ': full_qa default runs it once, without pins', same(healthy.rows.filter((x) => x[0] === s.file).map((x) => x[1]), ['']), healthy.rows.filter((x) => x[0] === s.file));
  ok(s.key + ': full_qa with KFL_SCOPE_PIN=1 runs it once, with pins', same(scoped.rows.filter((x) => x[0] === s.file).map((x) => x[1]), ['1']), scoped.rows.filter((x) => x[0] === s.file));
}
const namesOnly = (last, s) => last.indexOf('1 FAILED (' + s.file + ' passed)') >= 0;
for (const s of SUITES) {
  const f = runQa(Object.assign({}, NO_SCOPE, { KFL_C44_FORCE: s.file }));
  ok('forced failure of ' + s.file + ' → full_qa exits 1 naming only it', f.status === 1 && namesOnly(f.last, s), f.last);
  const g = runQa(Object.assign({}, NO_SCOPE, patch(s.regressions[0].edits, [s.file])));
  ok('regression "' + s.regressions[0].name + '" seen by ' + s.key + ' → full_qa exits 1 naming only it', g.status === 1 && namesOnly(g.last, s), g.last);
}
{
  const only = SUITES.map((s) => s.file);
  const d = runQa(Object.assign({}, NO_SCOPE, patch(UNRELATED, only))), p = runQa(Object.assign({}, SCOPE, patch(UNRELATED, only)));
  ok('unrelated bot edit seen by the three: full_qa default exits 0', d.status === 0 && d.last === healthy.last, d.last);
  ok('the same edit with KFL_SCOPE_PIN=1: full_qa exits 1 naming the three', p.status === 1 && p.last.indexOf('3 FAILED') >= 0 && only.every((f) => p.last.indexOf(f + ' passed') >= 0), p.last);
}
console.log('  note  trace files left in ' + dir + ' (no repo file was modified)');

// ---------- 7. no product file differs ----------
console.log('\n== 6. no product file differs from ' + BASE.slice(0, 7) + ' ==');
{
  const changed = git(['diff', '--name-only', BASE]).split('\n').filter(Boolean), untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  const stray = changed.concat(untracked).filter((f) => ALLOWED.indexOf(f) < 0);
  ok('only the ' + ALLOWED.length + ' allowed files differ (' + changed.concat(untracked).length + ' found), nothing else', stray.length === 0, stray);
  for (const f of [FIXED, DEPLOY, RELABEL, 'lib/sheet-writer.js', 'tests/full_qa.js', 'package.json']) {
    ok(f + ': blob equals the base', git(['rev-parse', BASE + ':' + f]).trim() === blobSha1(fs.readFileSync(path.join(ROOT, f))));
  }
  const qa = fs.readFileSync(QA, 'utf8');
  ok('this guard is not registered in full_qa (it runs full_qa itself)', qa.indexOf('test_c44_optional_scope_pins') < 0);
}

// ---------- 8. masking (only the files this change adds) ----------
console.log('\n== 7. masking ==');
const bot = fs.readFileSync(path.join(ROOT, FIXED), 'utf8');
const docPath = path.join(ROOT, 'docs', 'whatsapp-new-number-checklist.md');
const docText = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
const sensitive = [];
{ const m = bot.match(/const OWNER_PHONE = '(\d{9,15})'/); if (m) sensitive.push(m[1]); }
{ const m = bot.match(/body\.token === '([^']{6,})'/); if (m) sensitive.push(m[1]); }
{ const m = docText.match(new RegExp(['macros', 's', '([A-Za-z0-9_-]{20,})', 'exec'].join('\\/'))); if (m) sensitive.push(m[1]); }
const generic = [new RegExp(['script', 'google', 'com'].join('\\.') + '\\/macros\\/s\\/[A-Za-z0-9_-]{20,}'), /(?:\+?972[\s-]?|\b0)5\d(?:[\s-]?\d){7}\b/];
const scanFiles = [__filename, path.join(ROOT, 'docs', 'C44_OPTIONAL_SCOPE_PINS.md')].filter((f) => fs.existsSync(f));
const hits = scanFiles.map((f) => { const t = fs.readFileSync(f, 'utf8'); return sensitive.filter((v) => t.indexOf(v) >= 0).length + generic.filter((g) => g.test(t)).length; }).reduce((a, b) => a + b, 0);
ok('no full phone / webhook URL / token in the files this change adds (' + scanFiles.length + ' files, ' + sensitive.length + ' values checked)', sensitive.length === 3 && hits === 0);

console.log(`\ntest_c44_optional_scope_pins: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
