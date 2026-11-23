#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const authSrc = fs.readFileSync(path.join(root, 'lib/auth.js'), 'utf8');
const sessionSrc = fs.readFileSync(path.join(root, 'api/_lib/session.js'), 'utf8');

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

const isTrustedSessionMutation = eval(
  `(${extractFunction(sessionSrc, 'isTrustedSessionMutation')
    .replace('function isTrustedSessionMutation', 'function')})`
);

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

function req(method, headers = {}) {
  return { method, headers };
}

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

check('safe GET does not require Origin', isTrustedSessionMutation(req('GET')) === true);
check('same-origin HTTPS mutation is accepted', isTrustedSessionMutation(req('POST', {
  origin: 'https://kesefle.com',
  host: 'kesefle.com',
  'sec-fetch-site': 'same-origin',
})) === true);
check('Vercel forwarded host is accepted', isTrustedSessionMutation(req('PATCH', {
  origin: 'https://kesefle-git-a1b2.vercel.app',
  host: 'internal.example',
  'x-forwarded-host': 'kesefle-git-a1b2.vercel.app',
  'sec-fetch-site': 'same-origin',
})) === true);
check('missing Origin is rejected for mutation', isTrustedSessionMutation(req('POST', {
  host: 'kesefle.com',
})) === false);
check('cross-origin host is rejected', isTrustedSessionMutation(req('DELETE', {
  origin: 'https://evil.example',
  host: 'kesefle.com',
})) === false);
check('same-site sibling subdomain is rejected', isTrustedSessionMutation(req('POST', {
  origin: 'https://promo.kesefle.com',
  host: 'kesefle.com',
  'sec-fetch-site': 'same-site',
})) === false);
check('production HTTP origin is rejected', isTrustedSessionMutation(req('POST', {
  origin: 'http://kesefle.com',
  host: 'kesefle.com',
})) === false);

process.env.NODE_ENV = 'test';
check('local HTTP development remains usable', isTrustedSessionMutation(req('POST', {
  origin: 'http://127.0.0.1:3000',
  host: '127.0.0.1:3000',
  'sec-fetch-site': 'same-origin',
})) === true);

if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = previousNodeEnv;

const guardIndex = authSrc.indexOf('if (!isTrustedSessionMutation(req))');
const sessionIndex = authSrc.indexOf('const userSub = getUserId(req);');
const userLookupIndex = authSrc.indexOf("encodeURIComponent('user:' + userSub)", sessionIndex);
check('requireAuth enforces CSRF guard on cookie path before user lookup/handler',
  sessionIndex >= 0 && guardIndex > sessionIndex && userLookupIndex > guardIndex);
check('cookie mutations return a stable 403 error',
  /status\(403\)\.json\(\{ ok: false, error: 'csrf_origin_rejected'/.test(authSrc));
check('direct getUserId consumers fail closed on untrusted mutations',
  /export function getUserId\(req\) \{\s*if \(!isTrustedSessionMutation\(req\)\) return null;/.test(sessionSrc));

check('new sessions use the browser-enforced __Host- prefix',
  /const COOKIE_NAME = '__Host-kefle_session'/.test(sessionSrc));
check('legacy cookie remains readable during migration',
  /cookies\[COOKIE_NAME\] \|\| cookies\[LEGACY_COOKIE_NAME\]/.test(sessionSrc));
check('logout clears both hardened and legacy cookies',
  /Max-Age=0/.test(sessionSrc)
    && /appendSetCookie\(res, `\$\{COOKIE_NAME\}=/.test(sessionSrc)
    && /appendSetCookie\(res, `\$\{LEGACY_COOKIE_NAME\}=/.test(sessionSrc));
check('__Host- cookie contract remains Secure, host-only and Path=/',
  /`\$\{COOKIE_NAME\}=\$\{jwt\}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=/.test(sessionSrc)
    && !/Domain=/.test(sessionSrc));

console.log(`test_session_csrf: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
