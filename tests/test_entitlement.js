// Premium billing gate — behavioral tests for lib/subscription.js. This is the
// single source of truth for "is this user premium" (the bot + website read it
// to unlock AI/OCR). The 2026-06-17 audit flagged it as having ZERO behavioral
// tests — a regression here either locks out a paying customer or gives premium
// away free. Tests pass an explicit `now` so they're deterministic.
//
// Run: node tests/test_entitlement.js
'use strict';

(async () => {
  const { isPaidActive, computeEntitlement } = await import('../lib/subscription.js');

  const NOW = 1750000000000;
  const DAY = 86400000;
  const iso = (ms) => new Date(ms).toISOString();
  const past = iso(NOW - DAY);
  const future = iso(NOW + DAY);

  let pass = 0, fail = 0;
  function eq(label, got, want) {
    const ok = got === want;
    console.log((ok ? '  ✅ ' : '  ❌ ') + label + ' → ' + JSON.stringify(got) + (ok ? '' : '  (want ' + JSON.stringify(want) + ')'));
    ok ? pass++ : fail++;
  }

  console.log('── isPaidActive ──');
  eq('pro, accessUntil future → paid', isPaidActive({ plan: 'pro', accessUntil: future }, NOW), true);
  eq('pro, accessUntil PAST → not paid', isPaidActive({ plan: 'pro', accessUntil: past }, NOW), false);
  eq('free, accessUntil future → not paid (wrong plan)', isPaidActive({ plan: 'free', accessUntil: future }, NOW), false);
  eq('pro, past_due, no accessUntil → paid (grace via status)', isPaidActive({ plan: 'pro', subscriptionStatus: 'past_due' }, NOW), true);
  eq('pro, canceled, no accessUntil → not paid', isPaidActive({ plan: 'pro', subscriptionStatus: 'canceled' }, NOW), false);
  eq('family, accessUntil future → paid', isPaidActive({ plan: 'family', accessUntil: future }, NOW), true);
  eq('null user → not paid', isPaidActive(null, NOW), false);

  console.log('\n── computeEntitlement.premium ──');
  eq('paid pro → premium', computeEntitlement({ plan: 'pro', accessUntil: future }, NOW).premium, true);
  eq('expired pro, no trial → NOT premium', computeEntitlement({ plan: 'pro', accessUntil: past }, NOW).premium, false);
  eq('free + referral_credit future → premium', computeEntitlement({ plan: 'free', referral_credit: future }, NOW).premium, true);
  eq('free + referral_credit past → NOT premium', computeEntitlement({ plan: 'free', referral_credit: past }, NOW).premium, false);
  eq('free + trial future → premium', computeEntitlement({ plan: 'free', trialEndsAt: future }, NOW).premium, true);
  eq('free + trial expired → NOT premium', computeEntitlement({ plan: 'free', trialEndsAt: past }, NOW).premium, false);
  eq('expired pro + expired trial → NOT premium', computeEntitlement({ plan: 'pro', accessUntil: past, trialEndsAt: past }, NOW).premium, false);
  eq('referral status label when referral active', computeEntitlement({ plan: 'free', referral_credit: future }, NOW).status, 'referral');

  console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' ENTITLEMENT CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
  process.exit(fail === 0 ? 0 : 1);
})();
