#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const account = fs.readFileSync(path.join(__dirname, '..', 'account.html'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}

const msgSrc = extractFunction(account, '_kflFixedMsg');
const commandSrc = extractFunction(account, '_kflFixedCommandMsg');

check('generic recurring status renderer is text-only',
  /\.textContent\s*=/.test(msgSrc) && !/innerHTML/.test(msgSrc));
check('command fallback builds DOM nodes instead of an HTML string',
  /createElement\('button'\)/.test(commandSrc)
    && /createTextNode\(/.test(commandSrc)
    && /\.textContent\s*=/.test(commandSrc)
    && !/innerHTML|insertAdjacentHTML|outerHTML/.test(commandSrc));
check('command fallback has no inline event-handler injection surface',
  /addEventListener\('click'/.test(commandSrc)
    && !/onclick\s*=|setAttribute\(\s*['"]onclick/.test(commandSrc));
check('command value is assigned through dataset, not attribute markup',
  /\.dataset\.cmd\s*=\s*String\(botCmd/.test(commandSrc)
    && !/data-cmd=["']\s*\+/.test(commandSrc));
check('authenticated fallback uses the safe command renderer',
  /if \(auth\) \{\s*_kflFixedCommandMsg\(botCmd\);/.test(account));
check('recurring list descriptions render with textContent',
  /title\.textContent\s*=\s*desc/.test(account));

// Execute the generic renderer against a hostile description. A throwing
// innerHTML setter makes the test fail if a future refactor reintroduces HTML.
const hostile = '<img src=x onerror="globalThis.__kflPwned=1">';
let innerHtmlTouched = false;
const messageEl = {
  className: '',
  classList: { remove() {} },
  _text: '',
  set textContent(value) { this._text = value; },
  get textContent() { return this._text; },
  set innerHTML(_value) { innerHtmlTouched = true; throw new Error('unsafe innerHTML'); },
};
const previousDocument = global.document;
global.document = { getElementById: () => messageEl };
try {
  const renderMessage = eval(`(${msgSrc.replace('function _kflFixedMsg', 'function')})`);
  renderMessage(hostile, 'ok');
  check('hostile custom description remains literal text at runtime',
    messageEl.textContent === hostile && innerHtmlTouched === false);
} finally {
  if (previousDocument === undefined) delete global.document;
  else global.document = previousDocument;
}

console.log(`test_account_fixed_expense_xss: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
