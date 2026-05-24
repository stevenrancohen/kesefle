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
const PROVISION = fs.readFileSync(path.join(ROOT, 'api/sheet/provision.js'), 'utf8');
const ACCOUNT_HTML = fs.readFileSync(path.join(ROOT, 'account.html'), 'utf8');

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
for (const f of ['bot/test_isolation.js', 'bot/test_parser.js', 'bot/test_classify.js', 'tests/golden_set.js', 'tests/recurring_detect.js', 'tests/test_bank_parsers.js']) {
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

// ── 3. buildExpenseRow — correct 8-column row (matches user's template) ────
// Layout: A=תאריך, B=חודש(YYYY-MM), C=סכום, D=קטגוריה, E=תת-קטגוריה,
// F=פירוט, G=מקור, H=סטטוס(boolean: true=expense, false=income)
console.log('\n══ 3. buildExpenseRow ══');
(0, eval)(extractFn(SW, 'buildExpenseRow'));
(0, eval)(extractFn(SW, 'sanitizeCell'));
const rExp = buildExpenseRow({ amount: 245, isIncome: false, category: 'אוכל', subcategory: 'סופר', rawText: '245 סופר', date: '2026-05-23T10:00:00Z' });
ok('row has 9 columns (8 original + col I "vatDeductible")', rExp.length === 9);
ok('month in col B is YYYY-MM', /^\d{4}-\d{2}$/.test(rExp[1]));
ok('amount in col C', rExp[2] === 245);
ok('category in col D', rExp[3] === 'אוכל');
ok('subcategory in col E', rExp[4] === 'סופר');
ok('source = whatsapp in col G', rExp[6] === 'whatsapp');
ok('expense flag in col H (true=expense)', rExp[7] === true);
const rInc = buildExpenseRow({ amount: 8500, isIncome: true, category: 'הכנסה', subcategory: 'משכורת', rawText: '8500 משכורת' });
ok('income flag in col H (false=income)', rInc[7] === false);
ok('formula in rawText sanitized', String(buildExpenseRow({ amount: 1, rawText: '=HACK()' })[5]).startsWith("'"));

// ── 3b. constantTimeEqual (regression guard for the off-by-one bug found 2026-05-23) ──
console.log('\n══ 3b. constantTimeEqual ══');
(0, eval)(extractFn(LINK, 'constantTimeEqual'));
ok('cte: empty strings equal', constantTimeEqual('', '') === true);
ok('cte: identical strings equal', constantTimeEqual('abc', 'abc') === true);
ok('cte: position-0 mismatch detected (off-by-one regression)', constantTimeEqual('Xbc', 'abc') === false);
ok('cte: position-N mismatch detected', constantTimeEqual('abX', 'abc') === false);
ok('cte: length mismatch (longer a) detected', constantTimeEqual('abcd', 'abc') === false);
ok('cte: length mismatch (longer b) detected', constantTimeEqual('abc', 'abcd') === false);
ok('cte: 33-byte hex secrets equal', constantTimeEqual('a'.repeat(33), 'a'.repeat(33)) === true);
ok('cte: 33-byte hex secrets differ at 0', constantTimeEqual('X' + 'a'.repeat(32), 'a'.repeat(33)) === false);

// ── 3c. Admin auth: default ADMIN_EMAILS + session-cookie path ──────────────
console.log('\n══ 3c. Admin auth defaults + session-cookie path ══');
const AUTH = fs.readFileSync(path.join(ROOT, 'lib/auth.js'), 'utf8');
ok('default admin includes stevenrancohen@gmail.com', /DEFAULT_ADMIN_EMAILS\s*=\s*'[^']*stevenrancohen@gmail\.com/.test(AUTH));
ok('default admin includes info@kesefle.com', /DEFAULT_ADMIN_EMAILS\s*=\s*'[^']*info@kesefle\.com/.test(AUTH));
ok('ADMIN_EMAILS env var still overrides default', /process\.env\.ADMIN_EMAILS\s*\|\|\s*DEFAULT_ADMIN_EMAILS/.test(AUTH));
ok('admin email comparison is case-insensitive', /toLowerCase\(\)/.test(AUTH) && /admins\.includes\(userEmail\)/.test(AUTH));
ok('requireAuth accepts session cookie (kefle_session via getUserId)', /getUserId\(req\)/.test(AUTH) && /from '\.\.\/api\/_lib\/session\.js'/.test(AUTH));
ok('requireAuth falls back from Bearer to cookie on bearer failure', /bearer_failed/.test(AUTH));

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

// ── 5c. Dashboard cell-note mirroring (מאזן אישי / מאזן חברה) ────────────────
// Every owner expense path must mirror its detail into the dashboard cell as a
// NOTE — and the note writer must NEVER touch a cell value/formula (notes only)
// or it could corrupt the SUMIFS totals / user-typed numbers.
console.log('\n══ 5c. Dashboard cell-note mirroring ══');
const _setNoteFn = extractFn(BOT, 'setDashboardNoteForTransaction_');
ok('note writer uses setNote (not setValue — safe, never corrupts totals)',
   /\.setNote\(/.test(_setNoteFn) && !/\.setValue\(/.test(_setNoteFn) && !/setFormula\(/.test(_setNoteFn));
ok('note writer routes business→company / else→personal',
   /category === 'עסק'/.test(_setNoteFn) && /מאזן חברה/.test(_setNoteFn) && /מאזן אישי/.test(_setNoteFn));
ok('all 3 owner expense paths mirror to the dashboard note',
   (BOT.match(/_dashboardDetailNote_\(/g) || []).length >= 3);
ok('_dashboardDetailNote_ is best-effort (wrapped in try/catch at call sites)',
   /try\s*\{\s*_dashboardDetailNote_\(/.test(BOT));

// ── 5d. WhatsApp number routing (use the TEST number; reply from inbound) ────
// The bot has two Meta numbers; it MUST default to the test number's Phone
// Number ID and reply from whichever number the user actually messaged — else
// replies go out the dead Numero number and no one can reach the bot.
console.log('\n══ 5d. WhatsApp number routing ══');
ok('default Phone Number ID = test number 1086749664527399 (not the dead Numero id)',
   /getProperty\('WHATSAPP_PHONE_NUMBER_ID'\)\s*\|\|\s*'1086749664527399'/.test(BOT));
ok('doPost captures the inbound phone_number_id into _ACTIVE_PHONE_NUMBER_ID_',
   /_ACTIVE_PHONE_NUMBER_ID_\s*=\s*\(__meta_/.test(BOT) && /metadata/.test(BOT));
ok('every /messages send targets the inbound number (no bare hardcoded id)',
   !/WHATSAPP_PHONE_NUMBER_ID \+ '\/messages'/.test(BOT) &&
   (BOT.match(/_ACTIVE_PHONE_NUMBER_ID_ \|\| WHATSAPP_PHONE_NUMBER_ID|_pnid \+ '\/messages'/g) || []).length >= 3);
ok('BOT_PHONE_E164 display number matches the test number', /BOT_PHONE_E164 = '\+15556408123'/.test(BOT));

// ── 5e. Minimal OAuth scope (drive.file) — publishable without CASA audit ────
// Provisioning must CREATE a fresh sheet (app-created → drive.file) rather than
// COPY a template (which needed the restricted drive.readonly scope). Keeping
// the requested scopes minimal is what lets the Google app be published without
// a costly security assessment AND stops refresh tokens expiring every 7 days.
console.log('\n══ 5e. Minimal OAuth scope (drive.file) ══');
ok('provision.js requires only drive.file (no drive.readonly requirement)',
   /missing_drive_file_scope/.test(PROVISION) && !/missing_drive_readonly_scope/.test(PROVISION));
ok('provision.js creates a fresh sheet (no template drive-copy)',
   /createUserSheetWithToken/.test(PROVISION) && !/files\/\$\{encodeURIComponent\(templateId\)\}\/copy/.test(PROVISION));
ok('account.html sign-in requests drive.file ONLY (no readonly / full spreadsheets)',
   /auth\/drive\.file/.test(ACCOUNT_HTML) && !/auth\/drive\.readonly/.test(ACCOUNT_HTML) && !/auth\/spreadsheets/.test(ACCOUNT_HTML));
ok('sheet-writer exports buildTenantSheetSpec + createUserSheetWithToken',
   /export function buildTenantSheetSpec/.test(SW) && /export async function createUserSheetWithToken/.test(SW));
ok('fresh sheet uses the 8-col תנועות headers (lock-step with buildExpenseRow)',
   /TX_HEADERS/.test(SW) && /createUserSheetWithRefresh/.test(SW));
ok('template recreates the 4 tabs (transactions + orders + personal + company dashboards)',
   /PERSONAL_DASHBOARD_TAB/.test(SW) && /COMPANY_DASHBOARD_TAB/.test(SW) && /ORDERS_TAB/.test(SW));
ok('personal dashboard total ranges fixed (corrected from xlsx off-by-one)',
   /_personalSectionTotal\('סה״כ הוצאות קבועות', 16, 27\)/.test(SW)
   && /_personalSectionTotal\('סה״כ הוצאות זמניות', 31, 33\)/.test(SW)
   && /_personalSectionTotal\('סה״כ אוכל', 37, 38\)/.test(SW)
   && /_personalSectionTotal\('סה״כ תחבורה', 42, 49\)/.test(SW)
   && /_personalSectionTotal\('סה״כ שונות', 53, 57\)/.test(SW));
ok('appendRowToUserSheet writes to A:I (9 cols incl. VAT-deductible)',
   /'\$\{TX_TAB\}'!A:I/.test(SW));
ok('group.js no longer copies a template (uses create-fresh)',
   !/copyTemplateToUserDrive/.test(fs.readFileSync(path.join(ROOT, 'api/group.js'), 'utf8')));
// Sign-in must use the full-page REDIRECT OAuth flow (PKCE → google-exchange),
// not the popup/iframe GIS flow that renders a blank gsi page when 3rd-party
// cookies are blocked (incognito, Safari, in-app browsers).
ok('account.html sign-in uses full-page redirect OAuth (PKCE → google-exchange)',
   /accounts\.google\.com\/o\/oauth2\/v2\/auth/.test(ACCOUNT_HTML) &&
   /code_challenge_method/.test(ACCOUNT_HTML) &&
   /\/api\/auth\/google-exchange/.test(ACCOUNT_HTML) &&
   /kesefleHandleOAuthReturn/.test(ACCOUNT_HTML));

// ── 5f. Bank CSV importer (Hapoalim / Leumi statement upload) ──────────────
// "Upload your bank statement" is the killer-feature parity with RiseUp. The
// parser MUST export BANK_PARSERS with both banks, the import endpoint MUST
// require auth + a per-user rate limit, and the parser fixture MUST exist so
// future PRs that touch the parser get caught by the same node tests/...
// harness. Privacy: we also assert the handler does NOT log description /
// amount text from the user's statement (only counts).
console.log('\n══ 5f. Bank CSV importer ══');
const BANK_PARSERS_SRC = fs.readFileSync(path.join(ROOT, 'lib/bank-parsers.js'), 'utf8');
const IMPORT_API = fs.readFileSync(path.join(ROOT, 'api/import/bank-csv.js'), 'utf8');
ok('lib/bank-parsers.js exports BANK_PARSERS with hapoalim + leumi',
   /export const BANK_PARSERS\s*=\s*\{[\s\S]*hapoalim:\s*parseHapoalimCsv[\s\S]*leumi:\s*parseLeumiCsv[\s\S]*\}/.test(BANK_PARSERS_SRC));
ok('api/import/bank-csv.js requires auth (requireAuth wrap)',
   /requireAuth\(handlerImpl\)/.test(IMPORT_API) && /from '\.\.\/\.\.\/lib\/auth\.js'/.test(IMPORT_API));
ok('api/import/bank-csv.js has per-user rate limit (5/hour)',
   /rateLimitId\(userSub,\s*\{\s*key:\s*'import_bank_csv'[\s\S]*limit:\s*5[\s\S]*windowSec:\s*3600/.test(IMPORT_API));
ok('bank parser test fixture exists (tests/test_bank_parsers.js)',
   fs.existsSync(path.join(ROOT, 'tests/test_bank_parsers.js')));
ok('bank-csv handler does NOT log raw description / amount',
   !/log\.[a-z]+\(.*description/.test(IMPORT_API) &&
   !/log\.[a-z]+\(.*amount(?!Count)/.test(IMPORT_API));
ok('bank-csv handler dedupes via KV import:hashes:{userSub} set',
   /import:hashes:'\s*\+\s*userSub|setKey\s*=\s*'import:hashes:'/.test(IMPORT_API) &&
   /kvSmismember|sismember/.test(IMPORT_API));
// The functional end-to-end parser smoke is covered by tests/test_bank_parsers.js
// (added to the unit-suite runner in section 1 above).

// ── 5g. VAT invoice (חשבונית מס/קבלה via Green Invoice) ─────────────────────
// Israeli law REQUIRES a tax invoice per charge to a customer. The lib must
// export createInvoice, the admin endpoint must be gated, and the whole path
// must fail SOFT when env keys are missing (payment recording must not break
// because invoicing fell over). The profile schema also has to accept the
// optional taxId + companyName fields used on the invoice client block.
console.log('\n══ 5g. VAT invoice (חשבונית מס) ══');
const INVOICE_LIB = fs.readFileSync(path.join(ROOT, 'lib/invoice.js'), 'utf8');
const INVOICE_API = fs.readFileSync(path.join(ROOT, 'api/billing/invoice.js'), 'utf8');
const PROFILE_API = fs.readFileSync(path.join(ROOT, 'api/profile.js'), 'utf8');
ok('lib/invoice.js exports createInvoice',
   /export\s*\{[^}]*\bcreateInvoice\b[^}]*\}/.test(INVOICE_LIB));
ok('api/billing/invoice.js requires admin auth',
   /requireAdmin\(handlerImpl\)/.test(INVOICE_API) || /requireAdmin\(/.test(INVOICE_API));
ok('createInvoice env-fail-soft when GREEN_INVOICE_KEY missing (returns skipped, never throws)',
   /isConfigured\(\)/.test(INVOICE_LIB) &&
   /not_configured/.test(INVOICE_LIB) &&
   /skipped:\s*true/.test(INVOICE_LIB));
ok('profile schema accepts taxId + companyName',
   /fields\.taxId\s*!==\s*undefined/.test(PROFILE_API) &&
   /fields\.companyName\s*!==\s*undefined/.test(PROFILE_API) &&
   /profile\.taxId\s*=/.test(PROFILE_API) &&
   /profile\.companyName\s*=/.test(PROFILE_API));

// ── 5h. VAT deductible flag (col I 'ניכוי מע״מ' + year-end tax report) ──────
// עוסק מורשה customers mark expenses as VAT-deductible via the bot ("/מעמ")
// and pull a year-end summary via /api/sheet/tax-report. Load-bearing pieces:
// the תנועות tab MUST have col I in the header (otherwise SUMs miss it), the
// row writer MUST emit 9 cells when vatDeductible is set (otherwise the bot
// silently writes 8-col rows and the flag is lost), the append range MUST be
// A:I (otherwise Sheets truncates), and the tax-report endpoint MUST live
// behind requireAuth (otherwise PII leaks). Regression here would silently
// break year-end VAT claims for the entire customer base.
console.log('\n══ 5h. VAT deductible flag ══');
const TAX_REPORT_API = fs.readFileSync(path.join(ROOT, 'api/sheet/tax-report.js'), 'utf8');
ok("sheet-writer _buildTxTab header includes 'ניכוי מע״מ' column",
   /TX_HEADERS\s*=\s*\[[^\]]*['"]ניכוי מע[״"]?מ['"][^\]]*\]/.test(SW));
ok('buildExpenseRow emits 9 cells when vatDeductible=true',
   buildExpenseRow({ amount: 1, vatDeductible: true }).length === 9 &&
   buildExpenseRow({ amount: 1, vatDeductible: true })[8] === true);
ok("appendRowToUserSheet writes to 'תנועות'!A:I (not A:H)",
   /'\$\{TX_TAB\}'!A:I/.test(SW) &&
   !/'\$\{TX_TAB\}'!A:H/.test(SW));
ok('api/sheet/tax-report.js exists + uses requireAuth + has rate limit',
   /import\s*\{\s*requireAuth\s*\}/.test(TAX_REPORT_API) &&
   /requireAuth\(handlerImpl\)/.test(TAX_REPORT_API) &&
   /rateLimitId\(userSub,\s*\{\s*key:\s*'sheet_tax_report'/.test(TAX_REPORT_API));

// ── 5i. Budgets (per-category monthly caps + WhatsApp overspend alerts) ─────
// Users set a cap per category via /api/budgets (authed) or the bot's
// "תקציב X N" command (bot-secret). The daily cron checks MTD spending vs
// cap and fires a WhatsApp message via /api/whatsapp/send when the user
// crosses the threshold. These assertions guard the load-bearing pieces
// from regression: auth + rate limit on the CRUD endpoint, CRON_SECRET on
// the cron, the cron path in vercel.json, server-side category validation
// against the single source of truth in lib/categories.js, and the
// year-month + category dedup key (so users do not get re-alerted next day
// because the cron re-ran).
console.log('\n══ 5i. Budgets ══');
const BUDGETS_API = fs.readFileSync(path.join(ROOT, 'api/budgets.js'), 'utf8');
const BUDGET_CRON = fs.readFileSync(path.join(ROOT, 'api/cron/budget-check.js'), 'utf8');
const VERCEL_JSON = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
ok('api/budgets.js requires auth + has rate limit',
   /requireAuth\(/.test(BUDGETS_API) &&
   /rateLimitId\(\s*userSub,\s*\{\s*key:\s*'budgets'/.test(BUDGETS_API));
ok('api/cron/budget-check.js verifies CRON_SECRET',
   /process\.env\.CRON_SECRET/.test(BUDGET_CRON) &&
   /Bearer \$\{cronSecret\}/.test(BUDGET_CRON));
ok('vercel.json includes the new cron path',
   /"\/api\/cron\/budget-check"/.test(VERCEL_JSON));
ok('budgets validates categories against lib/categories.js EXPENSE_GROUPS',
   /from '\.\.\/lib\/categories\.js'/.test(BUDGETS_API) &&
   /EXPENSE_GROUPS/.test(BUDGETS_API) &&
   /invalid_category/.test(BUDGETS_API));
ok('budget-check dedup key uses YYYY-MM + category',
   /budget_alerted:\$\{userSub\}:\$\{ymNow\}:\$\{category\}/.test(BUDGET_CRON));

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
