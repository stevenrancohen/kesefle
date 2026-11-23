#!/usr/bin/env node
'use strict';

// Regression guard for the admin monitor's authentication boundary.
// A previous implementation embedded a reusable password in public HTML,
// persisted it to localStorage, then sent it as a parallel ADMIN_TOKEN Bearer.
// The monitor must now use only the canonical verified-admin session path.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const monitor = fs.readFileSync(path.join(ROOT, 'admin/monitor.html'), 'utf8');
const stats = fs.readFileSync(path.join(ROOT, 'api/admin/stats.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, condition) {
  if (condition) {
    pass++;
    console.log('  ✅ ' + label);
  } else {
    fail++;
    console.error('  ❌ ' + label);
  }
}

console.log('\n=== admin monitor: no browser-stored shared secret ===');
check('public monitor contains no hardcoded legacy password',
  !monitor.includes('kesefle2026') && !/const\s+PASSWORD\s*=/.test(monitor));
check('monitor never reads or writes kefle_admin_token',
  !monitor.includes('kefle_admin_token'));
check('monitor does not construct a Bearer authorization header',
  !/Authorization\s*:\s*['"`]Bearer/.test(monitor)
    && !/headers\s*:\s*\{\s*Authorization/.test(monitor));
check('monitor sends the HttpOnly session cookie',
  /fetch\(['"]\/api\/admin\/stats['"][\s\S]{0,180}credentials:\s*['"]include['"]/.test(monitor));
check('unauthenticated monitor offers verified account sign-in and retry',
  /href="\/account\?force=signin"/.test(monitor)
    && /id="gate-retry"/.test(monitor)
    && /res\.status === 401 \|\| res\.status === 403/.test(monitor));

console.log('\n=== admin stats API: one canonical auth boundary ===');
check('stats endpoint is wrapped in requireAdmin and withRateLimit',
  /requireAdmin\(\s*withRateLimit\(/.test(stats));
check('legacy ADMIN_TOKEN path is completely removed',
  !/process\.env\.ADMIN_TOKEN|const\s+ADMIN_TOKEN|legacy_auth|constantTimeEqual|async function dispatch/.test(stats));
check('stats endpoint is GET-only',
  /req\.method !== ['"]GET['"]/.test(stats)
    && /method_not_allowed/.test(stats)
    && /setHeader\(['"]Allow['"], ['"]GET['"]\)/.test(stats));
check('authenticated stats are never shared-cacheable',
  /Cache-Control['"], ['"]no-store, max-age=0['"]/.test(stats)
    && !/s-maxage/.test(stats));

const statsUrl = pathToFileURL(path.join(ROOT, 'api/admin/stats.js')).href;
const runtimeProbe = `
  process.env.GOOGLE_CLIENT_ID = 'test-client';
  const { default: handler } = await import(${JSON.stringify(statsUrl)});
  const req = {
    method: 'GET', url: '/api/admin/stats',
    headers: { authorization: 'Bearer kesefle2026' },
  };
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
  await handler(req, res);
  console.log(JSON.stringify({ statusCode: res.statusCode, body: res.body }));
`;
const runtimeOut = execFileSync(process.execPath, [
  '--experimental-default-type=module', '--input-type=module', '-e', runtimeProbe,
], { encoding: 'utf8' }).trim().split('\n').at(-1);
const runtimeResult = JSON.parse(runtimeOut);
check('old embedded password is rejected at runtime',
  runtimeResult.statusCode === 401 && runtimeResult.body?.error === 'missing_auth');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
