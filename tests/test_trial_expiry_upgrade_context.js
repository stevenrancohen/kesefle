#!/usr/bin/env node
// Regression gate for the day-14 conversion path. It proves that Free/expired
// users reach plan comparison (not the PayPal return/status page), paid users
// are excluded, and only an allowlisted same-origin return survives refresh.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const failures = [];
function assert(condition, label) {
  if (condition) console.log('  PASS ' + label);
  else { failures.push(label); console.error('  FAIL ' + label); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

console.log('\ntests/test_trial_expiry_upgrade_context.js\n');

const lifecycle = read('api/cron/lifecycle.js');
const audienceStart = lifecycle.indexOf('export function shouldSendDay14Upgrade');
const audienceEnd = lifecycle.indexOf('\n}', audienceStart) + 2;
let shouldSendDay14Upgrade = null;
try {
  const audienceSource = lifecycle.slice(audienceStart, audienceEnd).replace(/^export\s+/, '');
  shouldSendDay14Upgrade = new Function(audienceSource + '; return shouldSendDay14Upgrade;')();
} catch (e) { failures.push('audience helper extracts'); }
const audience = shouldSendDay14Upgrade ? {
  free: shouldSendDay14Upgrade({ plan: 'free' }, 14),
  expiredTrial: shouldSendDay14Upgrade({ plan: 'free', trialEndedAt: '2026-10-31' }, 14),
  legacyFree: shouldSendDay14Upgrade({}, 14),
  pro: shouldSendDay14Upgrade({ plan: 'pro' }, 14),
  family: shouldSendDay14Upgrade({ plan: 'family' }, 14),
  wrongDay: shouldSendDay14Upgrade({ plan: 'free' }, 13),
} : {};
assert(audience.free === true && audience.expiredTrial === true && audience.legacyFree === true,
  'Free and expired-trial representations receive the day-14 comparison email');
assert(audience.pro === false && audience.family === false,
  'active Pro and Family users never receive the day-14 upgrade email');
assert(audience.wrongDay === false && /shouldSendDay14Upgrade\(u, days\)/.test(lifecycle),
  'audience predicate is day-14-only and wired into the real cron');

const email = read('templates/email/day_14_upgrade_to_pro.html');
assert(/https:\/\/kesefle\.com\/pricing\?source=trial_expired_email&amp;return_to=%2Faccount%23upgrade-card#tiers/.test(email),
  'email CTA reaches attributed plan comparison with a safe account return');
assert(!/href="https:\/\/kesefle\.com\/upgrade"/.test(email),
  'email no longer sends users to the PayPal return/status route');
assert(/אין חיוב בלחיצה/.test(email),
  'CTA explicitly says that comparing plans does not charge');
assert(/dir="rtl"/.test(email) && /name="viewport"/.test(email) &&
  /@media screen and \(max-width:600px\)/.test(email) && /\.btn \{ width:100% !important/.test(email),
  'email has RTL, mobile viewport and a full-width mobile CTA');
assert(/&#8362;19[\s\S]{0,120}\/ חודש/.test(email),
  'the existing monthly price is unchanged outside the no-charge CTA');

const pricing = read('pricing.html');
const upgrade = read('upgrade.html');
assert(/email-upgrade-context\.js/.test(pricing) && /capture\(\s*window\.location\.search/.test(pricing),
  'pricing captures email source and return context');
assert(/_kflEmailUpgrade\.source/.test(pricing) && /event:\s*'pricing_viewed'/.test(pricing),
  'pricing funnel attribution includes the email source');
assert(/<html lang="he" dir="rtl">/.test(pricing) && /viewport-fit=cover/.test(pricing) &&
  /<html lang="he" dir="rtl">/.test(upgrade) && /viewport-fit=cover/.test(upgrade),
  'pricing and PayPal return are mobile-viewport RTL pages');
assert(/id="upgrade-return-primary"/.test(upgrade) && /id="upgrade-return-cancel"/.test(upgrade),
  'PayPal success and cancel states expose a recoverable return action');
assert(/email-upgrade-context\.js/.test(upgrade) && /safeReturn/.test(upgrade),
  'PayPal return page restores only the shared safe return');

const context = require(path.join(ROOT, 'js/email-upgrade-context.js'));
function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}
const storage = memoryStorage();
const first = context.capture(
  '?source=trial_expired_email&return_to=%2Faccount%23upgrade-card',
  storage,
  'https://kesefle.com'
);
const refresh = context.capture('?paypal=success', storage, 'https://kesefle.com');
assert(first.source === 'trial_expired_email' && first.returnTo === '/account#upgrade-card',
  'valid source and same-origin account return are captured');
assert(refresh.source === first.source && refresh.returnTo === first.returnTo,
  'context survives refresh and the PayPal return query');
assert(context.safeReturnPath('/dashboard#/manage', 'https://kesefle.com') === '/dashboard#/manage' &&
  context.safeReturnPath('/app#/', 'https://kesefle.com') === '/app#/',
  'dashboard and app returns remain available');
assert(context.safeReturnPath('//evil.example/steal', 'https://kesefle.com') === '' &&
  context.safeReturnPath('https://evil.example/steal', 'https://kesefle.com') === '' &&
  context.safeReturnPath('/pricing', 'https://kesefle.com') === '' &&
  context.safeReturnPath('/%5cevil.example', 'https://kesefle.com') === '',
  'external, protocol-relative, encoded-slash and unapproved returns are rejected');

// No step in this path calls billing on page load: charging still requires the
// existing explicit Pro/Family CTA click and then PayPal approval.
const pricingBeforeClick = pricing.slice(0, pricing.indexOf('window.kflPricingCta ='));
assert(!/fetch\(\s*['"]\/api\/billing\/paypal\?action=subscribe/.test(pricingBeforeClick),
  'email landing and context capture never auto-start a subscription');

if (failures.length) {
  console.error('\nFAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('\nOK: all assertions passed');
