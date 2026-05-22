/**
 * tests/full_qa.js — consolidated QA runner for Kesefle.
 *
 *   node tests/full_qa.js            # offline suite (no secrets needed)
 *   node tests/full_qa.js --live     # also pings the live API (set KESEFLE_BASE)
 *
 * Offline it runs the real business logic behind the user flows: the two unit
 * suites (isolation, parser), the formula-injection sanitizer, the expense-row
 * builder, and phone normalization, plus static security assertions. The truly
 * end-to-end flows (signup/OAuth, family, group, payments, GDPR delete) need a
 * live environment + secrets — they're listed at the end as a manual checklist.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BOT = fs.readFileSync(path.join(ROOT, 'bot/ExpenseBot_DEPLOY.gs'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'lib/sheet-writer.js'), 'utf8');
const APPEND = fs.readFileSync(path.join(ROOT, 'api/sheet/append.js'), 'utf8');
const RECURRING = fs.readFileSync(path.join(ROOT, 'api/recurring.js'), 'utf8');
const ACCOUNT = fs.readFileSync(path.join(ROOT, 'api/account.js'), 'utf8');
const LINK = fs.readFileSync(path.join(ROOT, 'api/whatsapp/link.js'), 'utf8');
const ADMIN_STATS = fs.readFileSync(path.join(ROOT, 'api/admin/stats.js'), 'utf8');
const LEARN = fs.readFileSync(path.join(ROOT, 'api/learn.js'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; fails.push(label); console.log('  ❌ ' + label); }
}
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  // Skip past the parameter list (which may contain destructuring braces) by
  // matching parens, THEN find the body's opening brace.
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), depth = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (!depth) { j++; break; } } }
  return src.slice(start, j);
}

// ── 1. Existing unit suites ─────────────────────────────────────────────────
console.log('\n══ 1. Unit suites (isolation + parser) ══');
for (const f of ['bot/test_isolation.js', 'bot/test_parser.js', 'bot/test_classify.js']) {
  try { execFileSync('node', [path.join(ROOT, f)], { stdio: 'pipe' }); ok(f + ' passed', true); }
  catch (e) { ok(f + ' passed', false); }
}

// ── 2. Formula-injection sanitizer (sheet write safety) ─────────────────────
console.log('\n══ 2. sanitizeCell — formula-injection guard ══');
(0, eval)(extractFn(SW, 'sanitizeCell'));
ok('"=SUM(A1)" neutralized', sanitizeCell('=SUM(A1)').startsWith("'"));
ok('"+1" neutralized', sanitizeCell('+1').startsWith("'"));
ok('"-1" neutralized', sanitizeCell('-1').startsWith("'"));
ok('"@x" neutralized', sanitizeCell('@x').startsWith("'"));
ok('normal text untouched', sanitizeCell('סופר רמי לוי') === 'סופר רמי לוי');
ok('number passthrough', sanitizeCell(245) === 245);
ok('null → empty', sanitizeCell(null) === '');

// ── 3. buildExpenseRow — correct 9-column row ───────────────────────────────
console.log('\n══ 3. buildExpenseRow ══');
(0, eval)(extractFn(SW, 'buildExpenseRow'));
const rExp = buildExpenseRow({ amount: 245, currency: 'ILS', isIncome: false, category: 'אוכל', subcategory: 'סופר', rawText: '245 סופר' });
ok('row has 9 columns', rExp.length === 9);
ok('amount in col B', rExp[1] === 245);
ok('expense flag in col D', rExp[3] === 'expense');
ok('category in col E', rExp[4] === 'אוכל');
ok('source = whatsapp', rExp[7] === 'whatsapp');
const rInc = buildExpenseRow({ amount: 8500, isIncome: true, category: 'הכנסה', rawText: '8500 משכורת' });
ok('income flag in col D', rInc[3] === 'income');
ok('formula in rawText sanitized', String(buildExpenseRow({ amount: 1, rawText: '=HACK()' })[6]).startsWith("'"));

// ── 4. Phone normalization (E.164) ──────────────────────────────────────────
console.log('\n══ 4. normalizeE164 ══');
(0, eval)(extractFn(APPEND, 'normalizeE164'));
ok('"0547760643" → 972547760643', normalizeE164('0547760643') === '972547760643');
ok('"+972 54-776-0643" → 972547760643', normalizeE164('+972 54-776-0643') === '972547760643');
ok('"972526003090" unchanged', normalizeE164('972526003090') === '972526003090');
ok('garbage → null', normalizeE164('abc') === null);

// ── 5. Static security assertions (the isolation guarantees) ────────────────
console.log('\n══ 5. Static security assertions ══');
ok('OWNER_PHONE = 972547760643', /const OWNER_PHONE = '972547760643'/.test(BOT));
ok('owner-gates on 6 command routers', (BOT.match(/_isOwnerPhone_\(__from_\)\)/g) || []).length >= 6);
ok('receipt path owner-gated', /_assertOwnerLegacyWrite_\(fromPhone, 'receipt'\)/.test(BOT));
ok('append.js hard ownership assertion', /sheet_ownership_mismatch/.test(APPEND));
ok('append.js write_log', /write_log:/.test(APPEND));
ok('append.js multi-writer anomaly', /sheet_multi_writer_anomaly/.test(APPEND));
ok('dangerous unset-owner fallback gone', !/if \(!ownerPhone\) return \{ isOwner: true \}/.test(BOT));

// Token-resolution guard (the "couldn't connect" bug): the bridge endpoints
// MUST fetch the refresh token from user:{userSub} — the phone:{E164} record is
// only a pointer and carries no token. If a refactor reverts to writing with
// the bare phone record, every tenant write fails silently.
ok('append.js resolves token from user:{userSub}', /user:\$\{phoneRec\.userSub\}/.test(APPEND) && /refreshTokenEnvelope/.test(APPEND));
ok('recurring.js resolves token from user:{userSub}', /resolveTenantWriteRecord/.test(RECURRING) && /user:'\s*\+\s*phoneRec\.userSub/.test(RECURRING) && /refreshTokenEnvelope/.test(RECURRING));

// GDPR + secret-hygiene guards (2026-05-21 audit) — keep these from regressing.
ok('account.js delete purges token:{sub}', /'token:'\s*\+\s*userSub/.test(ACCOUNT));
ok('account.js delete revokes encrypted-envelope grant', /refreshTokenEnvelope[\s\S]{0,80}decryptRefreshToken/.test(ACCOUNT));
ok('link.js does NOT log the link code', !/code_issued'[^)]*\bcode\b/.test(LINK));
ok('admin/stats.js uses constant-time token compare (no !==)', /ctEq\(/.test(ADMIN_STATS) && !/token !== ADMIN_TOKEN/.test(ADMIN_STATS));

// ── 5b. Cross-user self-learning (privacy-safe global knowledge base) ───────
// These guard the "learn from every correction, get smarter for everyone"
// pipeline so a refactor can't silently sever it or start leaking raw text.
console.log('\n══ 5b. Cross-user global learning ══');
const _mcs = extractFn(BOT, 'matchCategorySmart');
const _iDict = _mcs.indexOf('matchCategory(text)');
const _iGlobal = _mcs.indexOf('_globalLearnLookup_(');
const _iLLM = _mcs.indexOf('_aiCategorize(');
ok('global tier sits AFTER dictionary, BEFORE LLM (latency-safe order)',
   _iDict > -1 && _iGlobal > _iDict && _iLLM > _iGlobal);
// The hot in-memory lookup must NOT itself make the HTTP call (would add a hop
// to every message). The global call lives only in matchCategorySmart.
ok('_learnedLookup stays local (no global HTTP in the hot path)',
   !/_globalLearnLookup_\(/.test(extractFn(BOT, '_learnedLookup')));
// Bot must talk to the VALIDATED endpoint, never write raw KV global_learn keys.
const _glPub = extractFn(BOT, '_globalLearnPublish_');
const _glLook = extractFn(BOT, '_globalLearnLookup_');
ok('publish routes through /api/learn (POST + bot secret)',
   /\/api\/learn'/.test(_glPub) && /x-kesefle-bot-secret/.test(_glPub) && /method:\s*'post'/.test(_glPub));
ok('lookup routes through /api/learn (GET + bot secret)',
   /\/api\/learn\?h=/.test(_glLook) && /x-kesefle-bot-secret/.test(_glLook) && /method:\s*'get'/.test(_glLook));
ok('bot never writes raw global_learn: keys to KV directly',
   !/kvSet\(\s*'global_learn:/.test(BOT) && !/kvSet\(\s*"global_learn:/.test(BOT));
// Publish + lookup MUST share one normalizer or hashes drift and never match.
ok('publish + lookup share _globalLearnNorm_',
   (BOT.match(/_globalLearnNorm_\(/g) || []).length >= 2 && /function _globalLearnNorm_\(/.test(BOT));
// Only user-confirmed sources propagate; AI fallback + global re-imports do not.
const _ls = extractFn(BOT, '_learnedSave');
ok('only user-confirmed corrections publish (not ai/global)',
   /_shouldPublishGlobal\s*=\s*\(source === 'user'/.test(_ls) &&
   !/source === 'ai'/.test(_ls.replace(/Skip AI[\s\S]*?loop\./, '')) &&
   !/source === 'global'/.test(_ls));
// Server side: junk/typo categories must NOT pollute the shared store.
ok('/api/learn validates category against VALID_CATS', /VALID_CATS\.has\(category\)/.test(LEARN) && /invalid_category/.test(LEARN));
ok('/api/learn is bot-secret gated', /KESEFLE_BOT_SECRET/.test(LEARN) && /x-kesefle-bot-secret/.test(LEARN));
ok('/api/learn stores only hashes (raw text never sent)', /global_learn:/.test(LEARN) && /HASH_RE/.test(LEARN));

// ── 6. Optional: live API health ────────────────────────────────────────────
if (process.argv.includes('--live')) {
  console.log('\n══ 6. Live API health (KESEFLE_BASE) ══');
  const base = process.env.KESEFLE_BASE || 'https://kesefle.com';
  (async () => {
    for (const p of ['/', '/api/health', '/account', '/pricing']) {
      try {
        const r = await fetch(base + p, { method: 'GET' });
        ok('GET ' + p + ' → ' + r.status, r.status > 0 && r.status < 500);
      } catch (e) { ok('GET ' + p, false); }
    }
    finish();
  })();
} else {
  finish();
}

function finish() {
  console.log('\n══ MANUAL end-to-end flows (need a live env + a real phone) ══');
  [
    'Signup: kesefle.com/account → Google sign-in → sheet provisions → link phone (code) → send "50 קפה" → row appears in OWN sheet',
    'Family: "כספלה צור משפחה" → join from 2nd phone → "משפחה 80 אוכל" → tagged to member → "כספלה יתרות" balances',
    'Group: "כספלה צור <name>" → join code → split expense → balances → settle',
    'Recurring: set a קבוע template → wait for daily cron (or run cronRecurringExpenses) → occurrence in own sheet, idempotent',
    'Receipt OCR: send a receipt photo → parsed amount/vendor → row in own sheet',
    'Voice: send a voice note "מאתיים שקל סופר" → transcribed → row in own sheet',
    'Category correction: ambiguous expense → pick category → "תקן ל: X" relabels last row',
    'Premium: /pricing → PayPal/crypto upgrade → entitlement flips to pro (computeEntitlement)',
    'GDPR delete: "מחק חשבון" → confirm → phone/token/sheet mapping removed from KV',
  ].forEach((s, i) => console.log('  ☐ ' + (i + 1) + '. ' + s));

  console.log('\n' + (fail === 0
    ? '✅ OFFLINE QA: ALL ' + pass + ' CHECKS PASSED'
    : '❌ OFFLINE QA: ' + fail + ' FAILED (' + fails.join('; ') + '), ' + pass + ' passed'));
  process.exit(fail === 0 ? 0 : 1);
}
