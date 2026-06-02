#!/usr/bin/env node
// Regression test for PR-S5 (Backend QA audit Bug #1).
// Guards against the easy-to-make mistake of calling
//   withRateLimit(handler, opts)
// when the real signature is
//   withRateLimit(opts)(handler)
// The wrong shape makes the rate limit a SILENT no-op (function returned by
// withRateLimit is just passed, never invoked). The audit caught this in
// api/admin/reprovision-user-sheet.js:271; this test prevents reintroduction.
//
// What we look for in every api/**.js file:
//   1. Every withRateLimit() call must have an OBJECT literal as its first
//      arg (i.e. starts with `{`). Anything else (a handler reference) is
//      the wrong shape.
//   2. Inside the object, the option names must be the canonical
//      key/limit/windowSec — not the old route/max/windowMs that the
//      audit found on reprovision-user-sheet.js.

const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
      walk(full, out);
    } else if (name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\ntests/test_ratelimit_arg_order.js\n');

const ROOT = path.join(__dirname, '..', 'api');
const FILES = walk(ROOT);

console.log('Scanned ' + FILES.length + ' api/**.js files.\n');

let totalCalls = 0;
let badShape = [];
let badOptionName = [];

for (const f of FILES) {
  const src = fs.readFileSync(f, 'utf8');
  // Strip line comments + block comments so we don't false-positive on
  // documentation that mentions the bad shape.
  const code = src
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Find every `withRateLimit(` and look at what follows.
  const re = /withRateLimit\s*\(\s*([^)]{0,200})/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    totalCalls++;
    const firstArg = m[1].trim();
    // Heuristic: first arg must START with `{` (object literal).
    if (!firstArg.startsWith('{')) {
      badShape.push(f.replace(path.join(__dirname, '..') + '/', '') +
        ' -> withRateLimit(' + firstArg.slice(0, 60) + '...)');
      continue;
    }
    // Also flag the old-name fields if they appear inside the object.
    const objBody = firstArg.slice(0, 300);
    if (/\b(route|windowMs|max)\s*:/.test(objBody)) {
      badOptionName.push(f.replace(path.join(__dirname, '..') + '/', '') +
        ' -> option names should be key/windowSec/limit (got route/windowMs/max)');
    }
  }
}

console.log('withRateLimit calls found:', totalCalls);

console.log('\nArg-shape check:');
assert(badShape.length === 0,
  'every withRateLimit() first arg is an object literal { ... }');
if (badShape.length) {
  badShape.forEach(line => console.log('    -> ' + line));
}

console.log('\nOption-name check:');
assert(badOptionName.length === 0,
  'every withRateLimit() options object uses key/windowSec/limit (not route/windowMs/max)');
if (badOptionName.length) {
  badOptionName.forEach(line => console.log('    -> ' + line));
}

// Spot-check the file the audit flagged.
console.log('\nSpot-check of audit-flagged file:');
const target = fs.readFileSync(
  path.join(__dirname, '..', 'api', 'admin', 'reprovision-user-sheet.js'),
  'utf8'
);
assert(/withRateLimit\(\{\s*key:\s*['"]admin_reprovision_user_sheet['"]/.test(target),
  'reprovision-user-sheet uses curry form withRateLimit({ key: ... })');
assert(/windowSec:\s*60/.test(target),
  'reprovision-user-sheet uses windowSec (not windowMs)');
assert(!/withRateLimit\s*\(\s*requireAdmin\s*\(/.test(target),
  'reprovision-user-sheet does NOT pass handler as first arg');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
