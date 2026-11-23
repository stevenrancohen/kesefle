#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const files = [
  'docs/oauth-verification/README.md',
  'docs/oauth-verification/scope-justifications.md',
  'docs/oauth-verification/demo-video-storyboard.md',
  'docs/oauth-verification/denial-recovery.md',
];
const combined = files.map(read).join('\n');

for (const file of files) {
  assert.doesNotMatch(read(file), /kesefle\.vercel\.app|add `vercel\.app`|DNS TXT record to vercel\.app/i,
    file + ' must use the owned production domain');
}

assert.doesNotMatch(combined, /files\.copy|master template Sheet|1YRPf_X9cCVLxT1xWYQ9xwArsOyarMnw2P_FaBUIYwAE/,
  'runbooks do not describe the removed template-copy architecture');
assert.doesNotMatch(combined, /^## `https:\/\/www\.googleapis\.com\/auth\/(?:drive\.readonly|spreadsheets)`/m,
  'runbooks do not provide obsolete justifications for broader scopes');
assert.doesNotMatch(combined, /https:\/\/www\.googleapis\.com\/auth\/(?:drive\.readonly|spreadsheets)/,
  'runbooks do not tell operators to request broader scopes');

const readme = read(files[0]);
assert.match(readme, /standard identity scopes \(`openid`, `email`, `profile`\)[\s\S]*?https:\/\/www\.googleapis\.com\/auth\/drive\.file/,
  'submission checklist names the exact minimal scope set');
assert.match(readme, /does \*\*not\*\* request `drive\.readonly` or the broad\s+`spreadsheets` scope/,
  'submission checklist explicitly blocks permission regression');
assert.match(readme, /Authorized domains:\*\* add `kesefle\.com`/,
  'brand verification uses the owned domain');

const justifications = read(files[1]);
assert.match(justifications, /create a fresh spreadsheet[\s\S]*?`spreadsheets\.create`/,
  'scope justification matches fresh-sheet provisioning');
assert.match(justifications, /mobile-first expense-tracking app with an optional WhatsApp channel/,
  'scope justification describes the app-first product truthfully');

const storyboard = read(files[2]);
assert.match(storyboard, /Kesefle OAuth Demo — kesefle\.com/);
assert.match(storyboard, /Only the current minimal scopes/);
assert.match(storyboard, /quick-entry form/);
assert.match(storyboard, /optional input channel, not required to use the app/);

const recovery = read(files[3]);
assert.match(recovery, /DNS TXT record to the `kesefle\.com` DNS zone/);
assert.doesNotMatch(recovery, /ask Vercel support|buy your own domain/i,
  'recovery guide does not instruct Steven to verify someone else\'s domain');
assert.match(recovery, /already uses the minimal `drive\.file` architecture/);

console.log('OAuth verification runbook truth assertions passed.');
