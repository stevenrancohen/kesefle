#!/usr/bin/env node
'use strict';

// Contract guard for the public health endpoints. The runtime files are ESM
// under Vercel while this repository's test harness is CommonJS, so the pure
// helper is loaded through a data URL and endpoint wiring is checked statically.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const HELPER_PATH = path.join(ROOT, 'lib/health-capabilities.js');
const BASIC_PATH = path.join(ROOT, 'api/health.js');
const DETAILED_PATH = path.join(ROOT, 'api/health/detailed.js');
const DIAGNOSTICS_PATH = path.join(ROOT, 'admin/diagnostics.html');

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) {
    passed++;
    console.log('  ✅ ' + label);
  } else {
    failed++;
    console.error('  ❌ ' + label);
  }
}

function invokeHandler(modulePath, { sheetsStatus = 200 } = {}) {
  const moduleUrl = pathToFileURL(modulePath).href;
  const script = `
    process.env.KV_REST_API_URL = 'https://kv.example';
    process.env.KV_REST_API_TOKEN = 'token';
    process.env.GOOGLE_CLIENT_ID = 'client';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    process.env.KESEFLE_TEMPLATE_SHEET_ID = 'sheet';
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes('kv.example')) return new Response('{}', { status: 200 });
      if (value.includes('/oauth2/v3/certs')) {
        return new Response(JSON.stringify({ keys: [{ kid: 'test' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (value.includes('sheets.googleapis.com')) {
        return new Response('{}', {
          status: ${sheetsStatus}, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('unexpected fetch ' + value);
    };
    const { default: handler } = await import(${JSON.stringify(moduleUrl)});
    const req = { method: 'GET', headers: {}, url: '/api/health' };
    const res = {
      headers: {}, statusCode: 200, body: null,
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return body; },
    };
    await handler(req, res);
    console.log(JSON.stringify({ statusCode: res.statusCode, body: res.body }));
  `;
  const output = execFileSync(process.execPath, [
    '--experimental-default-type=module', '--input-type=module', '-e', script,
  ], { encoding: 'utf8' }).trim();
  return JSON.parse(output.split('\n').at(-1));
}

async function main() {
  const helperSource = fs.readFileSync(HELPER_PATH, 'utf8');
  const helperUrl = 'data:text/javascript;base64,' + Buffer.from(helperSource).toString('base64');
  const {
    buildPublicCapabilities,
    createProbeCache,
    getCapabilityConfiguration,
    publicConfigurationSummary,
    readinessFromCapabilities,
  } = await import(helperUrl);

  let probeCalls = 0;
  const cachedProbe = createProbeCache(1_000);
  const firstProbe = await cachedProbe(async () => ++probeCalls);
  const secondProbe = await cachedProbe(async () => ++probeCalls);
  check('public probe cache coalesces repeated provider fan-out',
    firstProbe.value === 1 && firstProbe.cached === false
      && secondProbe.value === 1 && secondProbe.cached === true && probeCalls === 1);

  const empty = getCapabilityConfiguration({});
  check('empty env keeps every public capability unconfigured',
    !empty.core && !empty.googleSheets && !empty.whatsapp && !empty.payments && !empty.email && !empty.push);

  const completeEnv = {
    KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'token',
    GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', KESEFLE_TEMPLATE_SHEET_ID: 'sheet',
    META_PHONE_NUMBER_ID: 'phone-id', META_ACCESS_TOKEN: 'token', META_VERIFY_TOKEN: 'verify',
    META_APP_SECRET: 'secret', WABA_APPROVED: '1',
    PAYPAL_ENV: 'live', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret',
    PAYPAL_PLAN_PRO: 'p1', PAYPAL_PLAN_FAMILY: 'p2',
    PAYPAL_PLAN_PRO_YEAR: 'p3', PAYPAL_PLAN_FAMILY_YEAR: 'p4', PAYPAL_WEBHOOK_ID: 'wh',
    RESEND_API_KEY: 'resend',
    VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT_EMAIL: 'ops@example.com',
  };
  const complete = getCapabilityConfiguration(completeEnv);
  check('complete production env enables core and optional capabilities',
    complete.core && complete.googleSheets && complete.whatsapp && complete.payments && complete.email && complete.push);

  check('WhatsApp credentials without WABA approval are not ready',
    getCapabilityConfiguration({ ...completeEnv, WABA_APPROVED: '0' }).whatsapp === false);
  check('PayPal sandbox is not a production-ready payment rail',
    getCapabilityConfiguration({ ...completeEnv, PAYPAL_ENV: 'sandbox' }).paypal === false);
  check('Coinbase key without webhook secret cannot claim payment readiness',
    getCapabilityConfiguration({ COINBASE_COMMERCE_API_KEY: 'key' }).coinbase === false);

  const noOptional = getCapabilityConfiguration({
    KV_REST_API_URL: 'u', KV_REST_API_TOKEN: 't',
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', KESEFLE_TEMPLATE_SHEET_ID: 'sheet',
  });
  const capabilities = buildPublicCapabilities(noOptional, {
    kv: { ok: true }, googleOauth: { ok: true }, sheets: { ok: true },
  });
  check('healthy core remains available while optional services are honestly unconfigured',
    capabilities.web_app.status === 'available'
      && capabilities.google_sheets.status === 'available'
      && capabilities.whatsapp.status === 'not_configured'
      && capabilities.payments.status === 'not_configured');
  check('healthy core plus absent optional capabilities reports limited readiness',
    readinessFromCapabilities(capabilities) === 'limited');

  const summary = publicConfigurationSummary(complete);
  check('legacy env_configured adapter exposes only coarse product groups',
    JSON.stringify(Object.keys(summary).sort())
      === JSON.stringify(['core', 'email', 'google_sheets', 'payments', 'push', 'whatsapp']));
  check('legacy adapter never exposes individual credential names',
    !/client_secret|access_token|app_secret|api_key|webhook_secret/i.test(JSON.stringify(summary)));

  const basic = fs.readFileSync(BASIC_PATH, 'utf8');
  const detailed = fs.readFileSync(DETAILED_PATH, 'utf8');
  const diagnostics = fs.readFileSync(DIAGNOSTICS_PATH, 'utf8');
  check('Google identity probe hits the same JWKS endpoint used by auth',
    basic.includes('https://www.googleapis.com/oauth2/v3/certs')
      && detailed.includes('https://www.googleapis.com/oauth2/v3/certs'));
  check('Sheets probe uses discovery GET and requires a real 200 JSON response',
    basic.includes("r.status === 200 && /json/i.test(contentType)")
      && detailed.includes("r.status === 200 && /json/i.test(contentType)")
      && !/sheets\.googleapis[\s\S]{0,180}method:\s*'HEAD'/.test(basic)
      && !/sheets\.googleapis[\s\S]{0,180}method:\s*'HEAD'/.test(detailed));
  check('all provider probes have a bounded timeout',
    basic.includes('AbortSignal.timeout(PROBE_TIMEOUT_MS)')
      && detailed.includes('AbortSignal.timeout(PROBE_TIMEOUT_MS)'));
  check('Meta is credential-probed only after full WhatsApp readiness',
    detailed.includes('config.whatsapp ? probeMeta()')
      && detailed.includes('Authorization: `Bearer ${token}`'));
  check('optional Meta is not part of detailed core health',
    detailed.includes('const critical = config.core && config.googleSheets ? [kv, googleOauth, sheets] : []'));
  check('public responses contain v2 capabilities plus a coarse compatibility adapter',
    basic.includes('schema_version: 2') && detailed.includes('schema_version: 2')
      && basic.includes('publicConfigurationSummary(config)')
      && detailed.includes('publicConfigurationSummary(config)'));
  check('public probes do not leak raw upstream exception text',
    !basic.includes('error: e.message') && !detailed.includes('error: e.message'));
  check('admin diagnostics consumes capability status instead of secret names',
    diagnostics.includes('j.capabilities || {}')
      && !diagnostics.includes('Object.entries(env).filter'));

  const basicHealthy = invokeHandler(BASIC_PATH);
  check('basic handler returns HTTP 200 for healthy core and limited optional readiness',
    basicHealthy.statusCode === 200
      && basicHealthy.body.ok === true
      && basicHealthy.body.status === 'ok'
      && basicHealthy.body.readiness === 'limited');
  check('basic handler response has no field-level secret-presence flags',
    !/client_secret|access_token|app_secret|api_key|webhook_secret/i.test(JSON.stringify(basicHealthy.body)));

  const basicSheetsDown = invokeHandler(BASIC_PATH, { sheetsStatus: 500 });
  check('basic handler fails closed with 503 when core Sheets reachability fails',
    basicSheetsDown.statusCode === 503
      && basicSheetsDown.body.ok === false
      && basicSheetsDown.body.capabilities.google_sheets.status === 'degraded');

  const detailedHealthy = invokeHandler(DETAILED_PATH);
  check('detailed handler keeps HTTP 200 and core overall ok when optional services are absent',
    detailedHealthy.statusCode === 200
      && detailedHealthy.body.overall === 'ok'
      && detailedHealthy.body.dependencies.meta.ok === 'skipped'
      && detailedHealthy.body.capabilities.whatsapp.status === 'not_configured');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
