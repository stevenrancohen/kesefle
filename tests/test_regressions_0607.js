#!/usr/bin/env node
/*
 * test_regressions_0607.js  (standalone; auto-discovered by `npm run gauntlet`)
 *
 * Locks in the classifier/FX fixes shipped in PR #274 so they can never silently
 * regress. Drives the REAL bot via bot-replay.js (same parse+classify path the
 * bot uses) and asserts category/subcategory + FX conversion.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const REPO = path.join(__dirname, '..');

// execFileSync (NOT a shell) so message text is passed literally -- a shell would
// expand "$70" to "0" and silently corrupt the test input.
function replay(msg) {
  let out = '';
  try { out = execFileSync('node', ['bot/bot-replay.js', '--json', msg], { cwd: REPO, encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; }
  try { return JSON.parse(out); } catch (e) { return null; }
}
function cat(j) { const m = j && j.decisions && j.decisions.matchCategory; return m ? (m.category + ' / ' + m.subcategory) : '(none)'; }
function converted(j) { const f = j && j.decisions && j.decisions.fx; return !!(f && f.autoConverted); }

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } }

// ---- FX: English currency WORDS convert in the PLURAL only (the noun-phrase bug) ----
const fxNoConvert = ['pound cake 30', '5 dollar menu', 'dollar store 50', 'euro disney 200', 'pound sign 12', 'dollar tree 25', 'pounds of flour 30', 'pounds protein 80', '100 pounds hotel'];
for (const m of fxNoConvert) ok('FX stays ILS: ' + m, !converted(replay(m)), 'wrongly converted');
const fxConvert = ['30 dollars netflix', '50 euros spotify', '5000 yen sushi', '$70 chatgpt', 'דולר אפליקציה chatgpt 70'];
for (const m of fxConvert) ok('FX converts: ' + m, converted(replay(m)), 'did not convert');

// ---- classifier precision fixes ----
const routes = [
  ['מונית 45', 'תחבורה / מונית'],            // taxi fare (was public transit)
  ['מונית 38', 'תחבורה / מונית'],
  ['זיכוי מעמ 500', 'עסק / מחזור'],           // VAT-credit -> business income (sign-flip)
  ['החזר מעמ 900', 'עסק / מחזור'],
  ['תרופות 30', 'בריאות / תרופות'],
  ['תרופה 30', 'בריאות / תרופות'],           // meds subcategory (was general health)
  ['נטפליקס 55', 'בידור / מנויים דיגיטליים'], // entertainment unchanged
  ['ספוטיפיי 20', 'בידור / מנויים דיגיטליים'],
  ['פנסיון 300', 'תחבורה / מלונות'],          // Hebrew guesthouse kept
  ['דולר אפליקציה chatgpt 70', 'הוצאות קבועות / אפליקציות'], // owner's real bug
];
for (const [m, want] of routes) ok('route ' + m + ' -> ' + want, cat(replay(m)) === want, 'got ' + cat(replay(m)));

// substring-match fix: these must NOT confidently mis-route (DEFAULT is fine; the
// wrong buckets are the regression we guard against)
const notWrong = [
  ['supermarket 50', 'קניות / ביגוד'],   // was clothing via "arket"
  ['restaurant 80', 'תחבורה / תיירות'],  // was a travel/visa bucket
  ['pension 1500', 'תחבורה / מלונות'],   // English pension removed from hotels
];
for (const [m, wrongBucket] of notWrong) ok('no misroute ' + m + ' (not ' + wrongBucket + ')', cat(replay(m)) !== wrongBucket, 'mis-routed to ' + cat(replay(m)));

console.log('test_regressions_0607: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
