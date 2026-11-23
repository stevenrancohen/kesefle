// Static contract for the mobile-first bank import flow.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'import-bank.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { passed++; console.log('  ✅ ' + label); }
  else { failed++; console.log('  ❌ ' + label); }
}

console.log('\n== Bank import mobile UI contract ==');
check('page is RTL and mobile viewport aware', /<html[^>]+dir="rtl"/.test(html) && /viewport-fit=cover/.test(html));
check('all four supported Israeli banks are visible', ['hapoalim','leumi','discount','mizrahi'].every((bank) => html.includes('value="' + bank + '"')));
check('file picker limits CSV/TXT and UI enforces 2MB', /accept="\.csv,\.txt,text\/csv,text\/plain"/.test(html) && /2 \* 1024 \* 1024/.test(html));
check('raw file bytes are preserved as Base64 for server-side bank decoding', /new Uint8Array\(arrayBuffer\)/.test(html) && /window\.btoa/.test(html) && /csvBase64:state\.csvBase64/.test(html) && !/\.text\(\)/.test(html));
check('preview and commit are distinct and exact-file bound', /dryRun:true/.test(html) && /dryRun:false/.test(html) && /previewToken:state\.preview\.previewToken/.test(html) && /importButton\.disabled = !\(data\.ready > 0\)/.test(html));
check('second confirmation is the branded import CTA, without a blocking browser dialog', !/window\.confirm/.test(html) && /ייבוא ' \+ String\(data\.ready/.test(html));
check('cookie auth uses same-origin credentials', /credentials:'include'/.test(html));
check('browser does not store or send a Bearer token', !/localStorage|sessionStorage|Authorization|Bearer/.test(html));
check('server/user content is rendered with textContent/createElement', /createElement\('div'\)/.test(html) && /textContent = row\.description/.test(html));
check('no dynamic innerHTML sink exists', !/\.innerHTML\s*=/.test(html));
check('offline state blocks upload honestly', /navigator\.onLine/.test(html) && /הקובץ נשאר בדפדפן ולא נשלח/.test(html));
check('ambiguous commit blocks retry and routes to transaction review', /import_status_unknown/.test(html) && /בדיקת התנועות באפליקציה/.test(html));
check('post-write persistence warnings tell the user not to retry', /data\.dedupWarning \|\| data\.commitStateWarning/.test(html) && /אין להעלות שוב/.test(html));
check('privacy copy says HTTPS processing, not device-only', /בהצפנת HTTPS/.test(html) && /אינו נשמר כקובץ/.test(html));
check('touch targets are at least 44px', /min-height:44px/.test(html));
check('account screen links to bank import', /rowLink\('\/import-bank'/.test(app));
check('empty-state onboarding offers bank import', /\/import-bank\?from=app-onboarding/.test(app));
check('success returns to transaction list', /href="\/app#\/tx"/.test(html));

console.log('\n' + (failed ? '❌ ' + failed + ' FAILED, ' + passed + ' passed' : '✅ ALL ' + passed + ' CHECKS PASSED'));
process.exit(failed ? 1 : 0);

