// tests/test_log_redact_spreadsheet_id.js
//
// 2026-05-29 resweep R2 + R5: lib/log.js redact() must scrub
// spreadsheetId / sheetId / sheet_id keys before they reach Vercel log
// retention. Without this, the WRITE_BLOCKED_NO_REFRESH_TOKEN log lines
// at api/whatsapp/webhook.js leaked per-user Drive file IDs into
// plaintext logs.
//
// This contract test asserts:
//   1. spreadsheetId / sheetId / sheet_id are all redacted
//   2. The earlier PII-key redaction (userSub, email, phone) still works
//   3. The redactor recurses through nested objects (the actual call site
//      in webhook.js passes { userSub, spreadsheetId } shallow, but other
//      sites pass { user: { sub, email } } nested)

import { redact } from '../lib/log.js';

let failed = 0;
function ok(name, cond) {
  if (cond) console.log('  PASS', name);
  else { console.log('  FAIL', name); failed++; }
}

console.log('=== log redact: spreadsheetId / sheetId family ===');

const r1 = redact({
  userSub: 'sub_xyz123',
  spreadsheetId: '1rti_abc_def_xyz',
  sheetId: '1abc',
  sheet_id: '1def',
  email: 'test@example.com',
  phone: '+972526003090',
});

ok('userSub is redacted', typeof r1.userSub === 'string' && r1.userSub.includes('REDACTED'));
ok('spreadsheetId is redacted', typeof r1.spreadsheetId === 'string' && r1.spreadsheetId.includes('REDACTED'));
ok('sheetId is redacted (short → ***)', r1.sheetId === '***');
ok('sheet_id is redacted (short → ***)', r1.sheet_id === '***');
ok('email is redacted', typeof r1.email === 'string' && r1.email.includes('REDACTED'));
ok('phone is redacted', typeof r1.phone === 'string' && r1.phone.includes('REDACTED'));

console.log('\n=== nested object redaction ===');
const r2 = redact({
  reqId: 'req_xyz',
  user: { sub: 'sub_inner', email: 'inner@example.com', spreadsheetId: '1nested_abc_def' },
  ok: true,
});
ok('top-level reqId NOT redacted', r2.reqId === 'req_xyz');
ok('top-level ok NOT redacted', r2.ok === true);
ok('nested user.email is redacted', typeof r2.user.email === 'string' && r2.user.email.includes('REDACTED'));
ok('nested user.spreadsheetId is redacted', typeof r2.user.spreadsheetId === 'string' && r2.user.spreadsheetId.includes('REDACTED'));

console.log('\n=== non-sensitive keys pass through ===');
const r3 = redact({
  status: 200,
  ms: 42,
  category: 'אוכל',
  amount: 50,
});
ok('status preserved', r3.status === 200);
ok('ms preserved', r3.ms === 42);
ok('category preserved (Hebrew)', r3.category === 'אוכל');
ok('amount preserved', r3.amount === 50);

if (failed > 0) {
  console.error('\n❌ ' + failed + ' assertion(s) failed');
  process.exit(1);
}
console.log('\nOK: all assertions passed');
