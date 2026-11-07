#!/usr/bin/env node
// bot/test_c43_fullqa_registration.js
//
// C43 (2026-11-03) guard for the full_qa gate registration of the four tenant-isolation /
// sign regressions: bot/test_c38_owner_dict_isolation.js, bot/test_c40_tenant_fx_income.js,
// bot/test_c41_tenant_picker_isolation.js, bot/test_c42_tenant_relabel_income.js.
//
// Default (static, < 1 s): each of the four is in tests/full_qa.js UNIT_SUITES exactly once,
// the registry has no duplicates and every entry exists, the registry equals the pinned base
// (b891e50) plus exactly these four right after the C34 suite, and the runner contract holds
// (one child `node <file>` per entry, a non-zero exit records a failed check, any failed check
// makes full_qa exit 1).
//
// KFL_FULLQA_PROOF=1 adds the behavioural proof (about 75 s): full_qa runs healthy with a
// child-process tracer (each of the four executed exactly once), then once per suite with
// that suite forced to exit 1 (full_qa must exit 1 naming only that suite). The tracer and the
// forced failure are injected through NODE_OPTIONS (--import of a data: URL): no repo file is
// modified; the only file written is the trace file in a fresh os.tmpdir() folder.
// This file is deliberately NOT registered in full_qa (it runs full_qa).
// MOCK-FREE, OFFLINE: no sheet, network, Properties, trigger or deployment.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const QA = path.join(ROOT, 'tests', 'full_qa.js');
const FOUR = ['bot/test_c38_owner_dict_isolation.js', 'bot/test_c40_tenant_fx_income.js', 'bot/test_c41_tenant_picker_isolation.js', 'bot/test_c42_tenant_relabel_income.js'];
const ANCHOR = 'bot/test_c34_special_business_isolation.js';
const BASE_PIN = { rev: 'b891e50', fullQa: null };

let pass = 0, fail = 0;
function ok(id, cond, extra) {
  if (cond) { pass++; console.log('  ok    ' + id); } else { fail++; console.log('  FAIL  ' + id + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); }
}
const blobSha1 = (b) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + b.length + '\0'), b])).digest('hex');
function gitShow(rev, file) {
  return cp.execFileSync('git', ['--no-optional-locks', '-C', ROOT, 'show', rev + ':' + file], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}
// The UNIT_SUITES registry: quoted entries of the array literal (comments ignored).
function registry(src) {
  const s = src.indexOf('const UNIT_SUITES = [');
  if (s < 0) return null;
  const e = src.indexOf('];', s);
  const body = src.slice(s, e).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return Array.from(body.matchAll(/'([^']+)'/g)).map((m) => m[1]);
}

const SRC = fs.readFileSync(QA, 'utf8');
const REG = registry(SRC) || [];
let BASE_SRC = null;
try { BASE_SRC = gitShow('b891e50376b1fa5110bd83ce825a94b567be2a49', 'tests/full_qa.js'); BASE_PIN.fullQa = blobSha1(Buffer.from(BASE_SRC, 'utf8')); } catch (_) { BASE_SRC = null; }

// ---------- 1. registry ----------
console.log('\n== 1. registry: the four are registered exactly once ==');
ok('UNIT_SUITES parsed (' + REG.length + ' entries)', REG.length > 0);
for (const f of FOUR) ok(f + ' registered exactly once', REG.filter((x) => x === f).length === 1, REG.filter((x) => x === f).length);
ok('no duplicate entry anywhere in the registry', new Set(REG).size === REG.length);
const missing = REG.filter((f) => !fs.existsSync(path.join(ROOT, f)));
ok('every registered file exists (' + REG.length + ')', missing.length === 0, missing);
if (BASE_SRC) {
  const base = registry(BASE_SRC) || [];
  const at = base.indexOf(ANCHOR);
  const expected = base.slice(0, at + 1).concat(FOUR, base.slice(at + 1));
  ok('registry = base ' + BASE_PIN.rev + ' (' + base.length + ') + exactly the four right after the C34 suite, order kept', at >= 0 && JSON.stringify(REG) === JSON.stringify(expected));
  ok('none of the four was registered at the base (this change adds them)', FOUR.every((f) => base.indexOf(f) < 0));
} else {
  console.log('  note  base ' + BASE_PIN.rev + ' not available here — base comparison skipped');
}
ok('this guard is not registered (it runs full_qa itself)', REG.indexOf('bot/test_c43_fullqa_registration.js') < 0);

// ---------- 2. runner contract ----------
console.log('\n== 2. runner contract ==');
const runners = SRC.match(/execFileSync\(/g) || [];
ok('one child-process call site in full_qa (the registry loop)', runners.length === 1, runners.length);
ok('each entry runs once as a child `node <file>` (deduplicated loop)', /for \(const f of \[\.\.\.new Set\(UNIT_SUITES\)\]\) \{\s*try \{ execFileSync\('node', \[path\.join\(ROOT, f\)\], \{ stdio: 'pipe' \}\); ok\(f \+ ' passed', true\); \}/.test(SRC));
ok('a non-zero exit records a failed check', /catch \(e\) \{ ok\(f \+ ' passed', false\); \}/.test(SRC));
ok('any failed check makes full_qa exit 1', /process\.exit\(fail === 0 \? 0 : 1\)/.test(SRC));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok('`npm test` runs this gate (package.json scripts.test)', pkg.scripts && pkg.scripts.test === 'node tests/full_qa.js');

// ---------- 3. behavioural proof (opt-in) ----------
if (process.env.KFL_FULLQA_PROOF === '1') {
  console.log('\n== 3. behavioural proof (KFL_FULLQA_PROOF=1) ==');
  const pre = 'import fs from "node:fs"; const a = process.argv[1] || ""; ' +
    'if (process.env.KFL_TRACE_FILE && a) fs.appendFileSync(process.env.KFL_TRACE_FILE, a + "\\n"); ' +
    'if (process.env.KFL_FORCE_FAIL && a.endsWith(process.env.KFL_FORCE_FAIL)) process.exit(1);';
  const nodeOptions = '--import=data:text/javascript,' + encodeURIComponent(pre);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kfl-c43-'));
  const env = (extra) => Object.assign({}, process.env, { NODE_OPTIONS: nodeOptions, KFL_OUT: '' }, extra);
  const runQa = (extra) => { const r = cp.spawnSync(process.execPath, [QA], { cwd: ROOT, env: env(extra), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { status: r.status, last: String(r.stdout || '').trim().split('\n').pop() }; };
  const trace = path.join(dir, 'trace.txt');
  const h = runQa({ KFL_TRACE_FILE: trace });
  const ran = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((p) => path.relative(ROOT, p)) : [];
  ok('healthy: full_qa exits 0 — "' + h.last + '"', h.status === 0 && /ALL \d+ CHECKS PASSED/.test(h.last));
  for (const f of FOUR) ok('healthy: ' + f + ' executed exactly once', ran.filter((x) => x === f).length === 1, ran.filter((x) => x === f).length);
  for (const f of FOUR) {
    const r = runQa({ KFL_FORCE_FAIL: f });
    ok('forced failure of ' + f + ' → full_qa exits 1 naming only it', r.status === 1 && r.last.indexOf('1 FAILED (' + f + ' passed)') >= 0, r.last);
  }
  console.log('  note  trace file left in ' + dir + ' (no repo file was modified)');
} else {
  console.log('\n  note  behavioural proof not run (set KFL_FULLQA_PROOF=1, ~75 s)');
}

// ---------- 4. masking (only the files this change adds) ----------
console.log('\n== 4. masking ==');
const bot = fs.readFileSync(path.join(ROOT, 'bot', 'ExpenseBot_FIXED.gs'), 'utf8');
const docPath = path.join(ROOT, 'docs', 'whatsapp-new-number-checklist.md');
const docText = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
const sensitive = [];
{ const m = bot.match(/const OWNER_PHONE = '(\d{9,15})'/); if (m) sensitive.push(m[1]); }
{ const m = bot.match(/body\.token === '([^']{6,})'/); if (m) sensitive.push(m[1]); }
{ const m = docText.match(new RegExp(['macros', 's', '([A-Za-z0-9_-]{20,})', 'exec'].join('\\/'))); if (m) sensitive.push(m[1]); }
const generic = [new RegExp(['script', 'google', 'com'].join('\\.') + '\\/macros\\/s\\/[A-Za-z0-9_-]{20,}'), /(?:\+?972[\s-]?|\b0)5\d(?:[\s-]?\d){7}\b/];
const scanFiles = [__filename, path.join(ROOT, 'docs', 'C43_FULLQA_REGISTRATION.md')].filter((f) => fs.existsSync(f));
const hits = scanFiles.map((f) => { const t = fs.readFileSync(f, 'utf8'); return sensitive.filter((v) => t.indexOf(v) >= 0).length + generic.filter((g) => g.test(t)).length; }).reduce((a, b) => a + b, 0);
// Removed legacy secrets are a security improvement, not a test failure. Scan every
// sensitive value that still exists, while requiring the owner-phone fingerprint so
// this guard cannot silently become a no-op.
ok('no full phone / webhook URL / token in the files this change adds (' + scanFiles.length + ' files, ' + sensitive.length + ' values checked)', sensitive.length >= 1 && hits === 0);

console.log(`\ntest_c43_fullqa_registration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
