#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

(async () => {
  const endpointSource = fs.readFileSync(path.join(ROOT, 'lib/push-endpoint.js'), 'utf8');
  const { isTrustedPushEndpoint } = await import(
    'data:text/javascript;base64,' + Buffer.from(endpointSource).toString('base64')
  );

  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/device-token',
    'https://updates.push.services.mozilla.com/wpush/v2/device-token',
    'https://push.services.mozilla.com/wpush/v2/device-token',
    'https://web.push.apple.com/Q-device-token',
    'https://db5p.notify.windows.com/w/?token=device-token',
    'https://fcm.googleapis.com:443/fcm/send/device-token',
  ]) {
    assert.strictEqual(isTrustedPushEndpoint(endpoint), true, endpoint + ' is trusted');
  }

  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/device-token',
    'https://fcm.googleapis.com:444/fcm/send/device-token',
    'https://user@fcm.googleapis.com/fcm/send/device-token',
    'https://user:pass@web.push.apple.com/Q-device-token',
    'https://fcm.googleapis.com.evil.example/fcm/send/device-token',
    'https://web.push.apple.com.evil.example/Q-device-token',
    'https://push.apple.com/Q-device-token',
    'https://notify.windows.com/w/device-token',
    'https://sinwns1011421.wns.windows.com/channel/device-token',
    'https://127.0.0.1/push',
    'https://10.0.0.1/push',
    'https://[::1]/push',
    'https://example.com/push',
    'javascript:alert(1)',
    '//fcm.googleapis.com/fcm/send/device-token',
    '',
  ]) {
    assert.strictEqual(isTrustedPushEndpoint(endpoint), false, endpoint + ' is rejected');
  }

  const subscribeSource = fs.readFileSync(path.join(ROOT, 'api/push/subscribe.js'), 'utf8');
  const senderSource = fs.readFileSync(path.join(ROOT, 'lib/push.js'), 'utf8');
  assert.match(subscribeSource, /isTrustedPushEndpoint\(s\)/,
    'subscription writes use the shared endpoint trust policy');
  assert.match(subscribeSource, /storedEndpoint = rec\?\.subscription\?\.endpoint[\s\S]*isTrustedPushEndpoint\(storedEndpoint\)/,
    'subscription status does not bless a legacy untrusted record');
  assert.match(senderSource, /if \(!isTrustedPushEndpoint\(subscription\.endpoint\)\)/,
    'the outbound sender revalidates legacy stored endpoints');
  assert.match(senderSource, /push_untrusted_endpoint/,
    'an untrusted legacy endpoint is removed before any delivery attempt');
  assert.match(senderSource, /redirect:\s*['"]error['"]/,
    'push delivery never follows a redirect outside the allowlist');

  // Execute the real sender with isolated KV/network fixtures. Inline its two
  // local dependencies so the test can import the ESM source from a data URL
  // without changing the repository-wide package module mode.
  process.env.KV_REST_API_URL = 'https://kv.test';
  process.env.KV_REST_API_TOKEN = 'kv-token';
  process.env.VAPID_SUBJECT_EMAIL = 'security@kesefle.com';

  const vapidPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const vapidPrivateJwk = vapidPair.privateKey.export({ format: 'jwk' });
  const vapidPublicJwk = vapidPair.publicKey.export({ format: 'jwk' });
  process.env.VAPID_PRIVATE_KEY = vapidPrivateJwk.d;
  process.env.VAPID_PUBLIC_KEY = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(vapidPublicJwk.x, 'base64url'),
    Buffer.from(vapidPublicJwk.y, 'base64url'),
  ]).toString('base64url');

  const inlinedEndpointSource = endpointSource.replace(/\bexport\s+/g, '');
  const executableSenderSource = senderSource
    .replace("import { log } from './log.js';", "const log = { info() {}, warn() {} };")
    .replace("import { isTrustedPushEndpoint } from './push-endpoint.js';", inlinedEndpointSource);
  const { sendPush } = await import(
    'data:text/javascript;base64,' + Buffer.from(executableSenderSource).toString('base64')
  );

  const userPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const userPublicJwk = userPair.publicKey.export({ format: 'jwk' });
  const validKeys = {
    p256dh: Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(userPublicJwk.x, 'base64url'),
      Buffer.from(userPublicJwk.y, 'base64url'),
    ]).toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };

  async function runSenderFixture(endpoint, deleteOk = true) {
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).startsWith('https://kv.test/get/')) {
        return new Response(JSON.stringify({
          result: JSON.stringify({ subscription: { endpoint, keys: validKeys } }),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).startsWith('https://kv.test/del/')) {
        return new Response('', { status: deleteOk ? 200 : 500 });
      }
      return new Response('', { status: 201 });
    };
    const result = await sendPush('user-1', { title: 'בדיקה', body: 'עדכון' });
    return { result, calls };
  }

  const rejected = await runSenderFixture('https://127.0.0.1/internal', true);
  assert.deepStrictEqual(rejected.result, {
    ok: false, removed: true, cleanup_failed: false, reason: 'untrusted_endpoint',
  });
  assert.strictEqual(rejected.calls.filter((call) => !call.url.startsWith('https://kv.test/')).length, 0,
    'an untrusted stored endpoint never receives an outbound request');

  const cleanupFailure = await runSenderFixture('https://example.com/collector', false);
  assert.deepStrictEqual(cleanupFailure.result, {
    ok: false, removed: false, cleanup_failed: true, reason: 'untrusted_endpoint',
  });
  assert.strictEqual(cleanupFailure.calls.filter((call) => !call.url.startsWith('https://kv.test/')).length, 0,
    'a failed KV cleanup still cannot turn into an outbound request');

  const trusted = await runSenderFixture('https://fcm.googleapis.com/fcm/send/device-token');
  assert.strictEqual(trusted.result.ok, true, 'a trusted FCM subscription still sends');
  const delivery = trusted.calls.find((call) => call.url.startsWith('https://fcm.googleapis.com/'));
  assert.ok(delivery, 'the trusted fixture reaches the official push service');
  assert.strictEqual(delivery.options.redirect, 'error',
    'the real outbound request refuses redirects');

  console.log('Push endpoint trust boundary: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
