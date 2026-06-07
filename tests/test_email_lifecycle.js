#!/usr/bin/env node
// tests/test_email_lifecycle.js
//
// VERIFY-FIRST quality + correctness gate for the lifecycle EMAIL path:
//   lib/email.js, api/cron/lifecycle.js, lib/email-unsub.js, and the email
//   templates the cron actually sends (templates/email/*.html).
//
// These assert the REAL invariants we can prove offline (no network, no
// secrets), so a future edit that quietly breaks a lifecycle email is caught:
//
//   A. Brand spelling  -- every sent template carries כספ'לה (MEDIAL pe +
//      geresh) and NEVER the wrong כסף'לה (FINAL pe). The brand carries an
//      apostrophe, which terminates a single-quoted JS literal, so we build
//      the needle from char codes -- never inline it.
//   B. Unsubscribe link -- every MARKETING/lifecycle template inlines
//      {{unsubscribeUrl}} (legal requirement) and the cron feeds it in
//      baseVars. Transactional billing/account mail (payment-failed,
//      payment-receipt, account-deleted) is correctly exempt.
//   C. No bidi control chars -- U+200E/200F/202A-202E/2066-2069 in the sent
//      templates or in the email modules (they corrupt RTL rendering).
//   D. No broken interpolation -- rendering each sent template with the EXACT
//      vars the cron builds leaves zero {{...}} tokens and zero "undefined".
//   E. Real URLs -- every href in a rendered template is https:// or mailto:
//      (no http://, localhost, example., or an unresolved {{var}} in a link).
//   F. Fail-soft -- with RESEND_API_KEY unset, sendEmail / sendTemplate
//      no-op ({ ok:false, skipped:true }) instead of throwing or 500-ing.
//   G. wa.me test-number containment -- the hardcoded Meta TEST number is a
//      Steven-only production decision; we don't change it, but we PIN where
//      it may appear so a NEW hardcode elsewhere (or one creeping into the
//      cron JS) trips this gate.
//
// Run: node tests/test_email_lifecycle.js   (auto-discovered by the gauntlet)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TPL = path.join(ROOT, 'templates', 'email');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function readTpl(name) { return fs.readFileSync(path.join(TPL, name), 'utf8'); }

// Brand needles built from code points so this file never contains a raw
// Hebrew apostrophe (which would break the single-quoted source).
// כ ס פ ' ל ה  -- medial pe U+05E4 + apostrophe U+0027 (CORRECT)
const BRAND_OK = String.fromCharCode(0x05db, 0x05e1, 0x05e4, 0x27, 0x05dc, 0x05d4);
// כ ס ף ' ל ה  -- final pe U+05E3 + apostrophe (WRONG, must never appear)
const BRAND_WRONG = String.fromCharCode(0x05db, 0x05e1, 0x05e3, 0x27, 0x05dc, 0x05d4);
// Bidi control chars: LRM/RLM (200E/200F), the embedding/override block
// (202A-202E), and the isolates (2066-2069). Built from a \\u-escaped STRING so
// THIS source stays ASCII-clean (it would be hypocritical to embed the very
// chars we ban). The backslashes below are literal source characters.
const BIDI_RE = new RegExp('[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]');

// The templates the lifecycle cron actually sends, with the EXACT vars it
// builds for each (mirrors api/cron/lifecycle.js). Hebrew literal values are
// built from char codes for the same apostrophe-safety reason where needed.
const FOOD = String.fromCharCode(0x05de, 0x05d6, 0x05d5, 0x05df); // מזון
const NAME = String.fromCharCode(0x05d3, 0x05e0, 0x05d4);         // דנה
const baseVars = {
  firstName: NAME,
  userEmail: 'd***@example-user.test',
  unsubscribeUrl: 'https://kesefle.com/unsubscribe?sub=abc123&t=sig456',
};
// weekly-digest now needs the RICH var names; replicate the cron's
// summary-only defaults so the assertion matches production output.
const digestVars = (() => {
  const total = 842, count = 11;
  const v = {
    ...baseVars,
    weekRange: '11-17',
    totalSpend: String(total), transactionCount: String(count), categoryCount: '1',
    topCategory: FOOD, deltaPercent: '0', deltaArrow: '-', deltaColor: '#5a7479',
    spikeCategoryName: FOOD, spikeAmount: String(total), spikeMultiplier: '1',
    spikeAverage: String(total), spikeCount: '0',
  };
  for (let i = 1; i <= 5; i++) {
    v['cat' + i + 'Name'] = i === 1 ? FOOD : '-';
    v['cat' + i + 'Amount'] = i === 1 ? String(total) : '0';
    v['cat' + i + 'Pct'] = i === 1 ? '100' : '0';
    v['cat' + i + 'Count'] = i === 1 ? String(count) : '0';
    v['exp' + i + 'Date'] = '-'; v['exp' + i + 'Desc'] = '-'; v['exp' + i + 'Amount'] = '0';
  }
  return v;
})();
const SENT = {
  'day_1_first_transaction.html': baseVars,
  'day_3_pro_tips.html': baseVars,
  'day_7_weekly_summary.html': { ...baseVars, week_total: 842, top_category: FOOD, transactions: 11 },
  'day_14_upgrade_to_pro.html': baseVars,
  'day_30_pro_completed.html': { ...baseVars, month_total: 3200, transactions: 44, categories_count: 6, referral_code: 'abc12345' },
  'inactivity_7_days.html': baseVars,
  'weekly-digest.html': digestVars,
  'winback_30_days.html': { ...baseVars, winbackToken: 'tok123' },
  // Transactional dunning -- now fed reason + gracePeriodEnd by the cron.
  'payment-failed.html': { ...baseVars, planName: 'Pro', amount: '19', reason: 'x', gracePeriodEnd: '24/5' },
};
// Marketing templates legally REQUIRE the unsubscribe link; transactional ones
// are exempt (billing / account-status messages).
const TRANSACTIONAL = new Set(['payment-failed.html', 'payment-receipt.html', 'account-deleted.html']);

console.log('\ntests/test_email_lifecycle.js\n');

// ── A. Brand spelling ──────────────────────────────────────────────────────
console.log('Brand spelling (medial pe, never final pe):');
for (const name of Object.keys(SENT)) {
  const html = readTpl(name);
  assert(html.includes(BRAND_OK), name + ' contains correct brand');
  assert(!html.includes(BRAND_WRONG), name + ' has NO wrong (final-pe) brand');
}
// The cron's own Hebrew strings (NPS / win-back WhatsApp) must use the brand too.
const cronSrc = read('api/cron/lifecycle.js');
assert(cronSrc.includes(BRAND_OK), 'api/cron/lifecycle.js Hebrew strings use correct brand');
assert(!cronSrc.includes(BRAND_WRONG), 'api/cron/lifecycle.js has NO wrong-brand spelling');

// ── B. Unsubscribe link present in every marketing template ────────────────
console.log('\nUnsubscribe link (legal -- marketing templates):');
for (const name of Object.keys(SENT)) {
  const html = readTpl(name);
  const hasUnsub = html.includes('{{unsubscribeUrl}}') || /href="\{\{ *unsubscribeUrl *\}\}"/.test(html);
  if (TRANSACTIONAL.has(name)) {
    assert(!hasUnsub, name + ' is transactional -> correctly omits unsubscribe');
  } else {
    assert(hasUnsub, name + ' (marketing) inlines {{unsubscribeUrl}}');
  }
}
// The cron must build unsubscribeUrl into the shared vars and route it through
// the SIGNED builder (lib/email-unsub.js), not a hand-built unsigned link.
assert(/unsubscribeUrl:\s*unsubscribeUrlFor\(/.test(cronSrc) || /unsubscribeUrl:\s*buildUnsubscribeUrl\(/.test(cronSrc),
  'cron baseVars sets unsubscribeUrl from the signed builder');
assert(/buildUnsubscribeUrl/.test(cronSrc), 'cron imports buildUnsubscribeUrl (lib/email-unsub.js)');
assert(!/['"`]https:\/\/kesefle\.com\/unsubscribe\?sub=/.test(cronSrc),
  'cron has NO leftover unsigned /unsubscribe?sub= literal');

// ── C. No bidi control chars ───────────────────────────────────────────────
console.log('\nNo bidi control chars (templates + email modules):');
for (const name of Object.keys(SENT)) {
  assert(!BIDI_RE.test(readTpl(name)), name + ' has no U+200E/200F/202x/206x');
}
assert(!BIDI_RE.test(read('lib/email.js')), 'lib/email.js has no bidi control chars');
assert(!BIDI_RE.test(cronSrc), 'api/cron/lifecycle.js has no bidi control chars');
assert(!BIDI_RE.test(read('lib/email-unsub.js')), 'lib/email-unsub.js has no bidi control chars');

// ── D + E. Render each sent template with the cron's vars; check for broken
//          interpolation and that every href is a real URL. The renderer lives
//          in lib/email.js (ESM) -- run it in a child ESM process and emit a
//          JSON report this CJS test can assert on.
console.log('\nRendered output (no broken vars, real https/mailto links):');
const renderScript = `
import { renderTemplate } from ${JSON.stringify(path.join(ROOT, 'lib', 'email.js'))};
const SENT = ${JSON.stringify(SENT)};
const out = {};
for (const [name, vars] of Object.entries(SENT)) {
  const html = renderTemplate(name, vars) || '';
  const leftover = (html.match(/\\{\\{[^}]+\\}\\}/g) || []);
  const undef = /undefined/.test(html);
  // Collect every href target and flag any that is not https:// or mailto:.
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
  const badHref = hrefs.filter(h =>
    !/^https:\\/\\//.test(h) && !/^mailto:/.test(h)
  );
  const tplVarHref = hrefs.filter(h => /\\{\\{/.test(h)); // unresolved {{var}} in a link
  out[name] = { leftover: leftover.length, undef, badHref, tplVarHref, hrefCount: hrefs.length };
}
process.stdout.write(JSON.stringify(out));
`;
let rendered = {};
try {
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', renderScript], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  rendered = JSON.parse(raw);
} catch (e) {
  console.error('  (render child failed: ' + e.message + ')');
}
for (const name of Object.keys(SENT)) {
  const r = rendered[name] || { leftover: -1, undef: true, badHref: ['<no-report>'], tplVarHref: ['<no-report>'], hrefCount: 0 };
  assert(r.leftover === 0, name + ' renders with 0 leftover {{...}} tokens');
  assert(r.undef === false, name + ' renders with no literal "undefined"');
  assert(r.hrefCount > 0, name + ' has at least one link');
  assert(Array.isArray(r.badHref) && r.badHref.length === 0,
    name + ' every href is https/mailto (no http/localhost/relative): ' + JSON.stringify((r.badHref || []).slice(0, 3)));
  assert(Array.isArray(r.tplVarHref) && r.tplVarHref.length === 0,
    name + ' no unresolved {{var}} inside a link: ' + JSON.stringify((r.tplVarHref || []).slice(0, 3)));
}

// ── F. Env-fail-soft: no RESEND_API_KEY -> no-op, never throws ─────────────
console.log('\nFail-soft when email env is unset (must no-op, not throw/500):');
const failSoftScript = `
import { sendEmail, sendTemplate, emailHealth } from ${JSON.stringify(path.join(ROOT, 'lib', 'email.js'))};
(async () => {
  const a = await sendEmail({ to: 'x@example.test', subject: 's', html: '<p>h</p>' });
  const b = await sendTemplate({ to: 'x@example.test', template: 'day_3_pro_tips', vars: {} });
  process.stdout.write(JSON.stringify({
    sendEmailSkipped: a && a.ok === false && a.skipped === true && a.reason === 'not_configured',
    sendTemplateSkipped: b && b.ok === false && b.skipped === true,
    healthNotConfigured: emailHealth().configured === false,
  }));
})().catch(e => process.stdout.write(JSON.stringify({ threw: e.message })));
`;
let soft = {};
try {
  // Strip RESEND_API_KEY + EMAIL_FROM so the not-configured branch is exercised.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'RESEND_API_KEY' && k !== 'EMAIL_FROM'));
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', failSoftScript], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  soft = JSON.parse(raw);
} catch (e) {
  console.error('  (fail-soft child failed: ' + e.message + ')');
}
assert(!soft.threw, 'email path did not throw with RESEND_API_KEY unset (' + (soft.threw || 'no throw') + ')');
assert(soft.sendEmailSkipped, 'sendEmail returns { ok:false, skipped:true, reason:not_configured }');
assert(soft.sendTemplateSkipped, 'sendTemplate skips (no-op) when key is unset');
assert(soft.healthNotConfigured, 'emailHealth reports configured:false when key is unset');

// ── G. wa.me Meta TEST-number containment ──────────────────────────────────
// We do NOT change the production number (Steven's call). We PIN where the
// hardcoded test number is allowed so any NEW hardcode (or one leaking into the
// cron JS) trips this gate.
console.log('\nwa.me Meta TEST-number containment:');
const TEST_NUM = '15556408123';
// The cron sends WhatsApp via /api/whatsapp/send + links to kesefle.com -- it
// must never hardcode a wa.me/<number> link.
assert(!new RegExp('wa\\.me/' + TEST_NUM).test(cronSrc),
  'api/cron/lifecycle.js does NOT hardcode a wa.me test number');
// Known templates that currently embed the test number (HTML; out of edit
// scope). If a template gains/loses one, update this set deliberately.
const KNOWN_WA_HARDCODE = new Set(['day_3_pro_tips.html', 'inactivity_7_days.html', 'welcome.html']);
const allTpls = fs.readdirSync(TPL).filter(f => f.endsWith('.html'));
for (const name of allTpls) {
  const has = new RegExp('wa\\.me/' + TEST_NUM).test(readTpl(name));
  if (has) {
    assert(KNOWN_WA_HARDCODE.has(name),
      name + ' wa.me hardcode is in the known set (new hardcode -> route via central config + flag for Steven)');
  }
}

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
