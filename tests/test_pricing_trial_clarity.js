#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pricing = fs.readFileSync(path.join(ROOT, 'pricing.html'), 'utf8');
const subscription = fs.readFileSync(path.join(ROOT, 'lib/subscription.js'), 'utf8');
const paypal = fs.readFileSync(path.join(ROOT, 'api/billing/paypal.js'), 'utf8');
let failed = 0;

function assert(condition, label) {
  if (condition) console.log('✅ ' + label);
  else { failed++; console.error('❌ ' + label); }
}

function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let p = src.indexOf('(', start), parens = 0, i = p;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) { i++; break; }
  }
  let body = src.indexOf('{', i), depth = 0, end = body;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}' && --depth === 0) { end++; break; }
  }
  return src.slice(start, end);
}

function tagWithId(id) {
  const match = pricing.match(new RegExp('<a\\b[^>]*\\bid="' + id + '"[^>]*>', 'i'));
  return match ? match[0] : '';
}

const trialFields = extractFn(subscription, 'newUserTrialFields');
const paypalPlan = extractFn(paypal, 'createPlan');
const trialHandlerMatch = pricing.match(/window\.kflPricingTrialCta\s*=\s*function\s*\([^)]*\)\s*\{[\s\S]*?\n\};/);
const trialHandler = trialHandlerMatch ? trialHandlerMatch[0] : '';
const proTrialCta = tagWithId('pro-trial-cta');
const finalTrialCta = tagWithId('pricing-final-trial-cta');
const paypalCta = tagWithId('pro-paypal-cta');

assert(/const TRIAL_DAYS = 14;/.test(subscription), 'canonical entitlement grants a 14-day trial');
assert(/trialPlan:\s*'pro'/.test(trialFields) && /plan:\s*'free'/.test(trialFields), 'new-account trial is Pro-only and keeps the stored plan free');
assert(/tenure_type:\s*'REGULAR'/.test(paypalPlan) && !/tenure_type:\s*'TRIAL'/.test(paypalPlan), 'PayPal plan starts regular billing and does not implement the free trial');

assert(/href="\/account\?plan=pro&amp;from=pricing-trial"/.test(proTrialCta), 'primary Pro CTA routes to the free-trial signup path');
assert(/kflPricingTrialCta\(event\)/.test(proTrialCta) && !/kflPricingCta\('pro'/.test(proTrialCta), 'primary Pro CTA cannot invoke paid checkout');
assert(/kflPricingTrialCta\(event\)/.test(finalTrialCta), 'final pricing CTA uses the same free-trial path');
assert(/kflPricingCta\('pro'/.test(paypalCta), 'paid PayPal upgrade remains available as a separate explicit action');

assert(/removeItem\('kfl_pending_subscribe'\)/.test(trialHandler), 'trial start clears abandoned paid-checkout intent');
assert(!/api\/billing\/paypal/.test(trialHandler), 'trial start never calls the billing endpoint');
assert(/בלי כרטיס אשראי ובלי חיוב אוטומטי/.test(pricing), 'pricing explains that the trial needs no card and does not auto-charge');
assert(/מסלול משפחה הוא מסלול בתשלום ואינו חלק מהניסיון/.test(pricing), 'FAQ states that Family is not part of the Pro trial');
assert(!/החיוב הראשון מתחיל רק ביום ה-/.test(pricing), 'unsupported automatic day-15 charge claim is removed');
assert(!/גישה מלאה לכל תכונות Pro או משפחה/.test(pricing), 'unsupported Family-trial claim is removed');

assert(/data-plan="pro" data-month="19" data-year="190"/.test(pricing), 'verified Pro prices are unchanged');
assert(/data-plan="family" data-month="39" data-year="390"/.test(pricing), 'verified Family prices are unchanged');

const jsonLdBlocks = [...pricing.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
let jsonLdValid = jsonLdBlocks.length > 0;
for (const match of jsonLdBlocks) {
  try { JSON.parse(match[1]); } catch (_error) { jsonLdValid = false; }
}
assert(jsonLdValid, 'pricing JSON-LD remains valid after the FAQ correction');

if (failed) process.exit(1);
console.log('All pricing trial clarity contracts passed.');
