#!/usr/bin/env node
// Canonical-domain regression guard. Historical migration/audit records and
// the explicit legacy-origin analytics allowlist are intentionally out of this
// active-file scan.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const activeCanonicalFiles = [
  '404.html',
  'CHANGELOG.md',
  'SETUP.md',
  'docs.html',
  'press.html',
  'admin/diagnostics.html',
  'scripts/verify-deploy.sh',
  'api/admin.js',
  'api/referral.js',
  'templates/email/day_1_first_transaction.html',
  'templates/email/inactivity_7_days.html',
  'templates/email/payment-failed.html',
  'templates/email/payment-receipt.html',
  'templates/email/welcome.html',
  'templates/email/README.md',
];

for (const file of activeCanonicalFiles) {
  assert.doesNotMatch(read(file), /kesefle\.vercel\.app/i, `${file} must not present the retired domain`);
}

assert.match(read('docs.html'), /https<\/span>:\/\/kesefle\.com/);
assert.match(read('press.html'), />kesefle\.com</);
assert.match(read('admin/diagnostics.html'), /DNS & SSL של kesefle\.com/);
assert.match(read('scripts/verify-deploy.sh'), /https:\/\/kesefle\.com/);
assert.match(read('api/admin.js'), /req\.headers\.host \|\| 'kesefle\.com'/);
assert.match(read('api/referral.js'), /req\.headers\.host \|\| 'kesefle\.com'/);
assert.doesNotMatch(read('CHANGELOG.md'), /\]\(https:\/\/kesefle\.com\/changelog\)/,
  'internal changelog must not claim a public route that redirects to the homepage');

const emailTemplates = [
  'templates/email/day_1_first_transaction.html',
  'templates/email/inactivity_7_days.html',
  'templates/email/payment-failed.html',
  'templates/email/payment-receipt.html',
  'templates/email/welcome.html',
];
for (const file of emailTemplates) {
  const html = read(file);
  assert.doesNotMatch(html, /mailto:[^"']+@kesefle\.vercel\.app/i, `${file} must not use an invalid Vercel mailbox`);
  assert.match(html, /mailto:info@kesefle\.com/i, `${file} must use the proven canonical support mailbox`);
}

const emailReadme = read('templates/email/README.md');
assert.match(emailReadme, /noreply@kesefle\.com/);
assert.match(emailReadme, /mailto:info@kesefle\.com/);

// Keep compatibility for analytics requests created on the old auto-domain;
// this is not a customer-facing canonical URL.
assert.match(read('api/events.js'), /https:\/\/kesefle\.vercel\.app/);

console.log('Canonical domain: PASS');
