#!/usr/bin/env node
/*
 * build_index.js — merge all keyword packs into:
 *   - bot/keywords/INDEX.json           (full, for tests/reference)
 *   - bot/ExpenseBot_KEYWORDS.gs        (Apps Script data file: KFL_KW_BUCKETS + KFL_KW_INDEX)
 *
 * Pack shape: { category, subcategory, isIncome, keywords: [..] }
 * Index key = normalized keyword (lowercased Latin, tokenized, single-spaced) so the
 * bot's _kfl_bigIndexLookup ngram lookup matches exactly.
 *
 * Quality/size controls:
 *  - Hebrew PREFIX-VARIANT filter: drop "<prefix><base>" (e.g. "באיקאה") when the bare
 *    "<base>" ("איקאה", >=3 chars) is also a keyword in the SAME bucket. The bot lookup
 *    strips the same prefixes on a miss, so coverage is preserved while the mechanical
 *    padding that inflates the file is removed.
 *  - per-bucket CAP: keep at most CAP keywords per bucket (pack order = real-merchant-first),
 *    to bound the embedded file size for the manual Apps Script paste.
 *
 * Lookup is an ADDITIVE FALLBACK in the bot (fires only when the primary CATEGORY_MAP
 * scan is unsure), so cross-bucket collisions are low-risk; we keep the first winner and log.
 */
const fs = require('fs');
const path = require('path');

const PACKS_DIR = path.join(__dirname, 'packs');
const OUT_JSON = path.join(__dirname, 'INDEX.json');
const OUT_GS = path.join(__dirname, '..', 'ExpenseBot_KEYWORDS.gs');
const INCOME_STOP = new Set(['pension', 'pension fund', 'pension contribution', 'pensions', 'grant', 'grants', 'stipend', 'stipends', 'allowance', 'allowances', 'entitlement', 'entitlements', 'benefit', 'benefits', 'המוסד', 'רנטה', 'fund', 'contribution']);
// Per-bucket cap after prefix filtering. Raised 2500 -> 3200 (Steven 2026-06-07:
// "+30,000 words customers can write") which surfaces +30,287 already-vetted
// keywords from the existing packs (313k unique source kw; ~205k were trimmed).
// These are dedup'd, prefix-filtered, junk-filtered and INCOME_STOP-guarded by
// this same builder, so it is purely additive fallback coverage with no new
// misroute risk; the golden-set gauntlet is the regression guard. Override with
// KFL_CAP=<n> for experiments; the committed default is the verified value.
const CAP = parseInt(process.env.KFL_CAP, 10) || 3200;

// Hebrew clitic prefixes (longest first). Stripping one from a padded variant yields the base.
const PFX = ['וכשה', 'ומה', 'וכש', 'כשה', 'מהה', 'בהה', 'והה', 'שהה', 'לכש',
  'ומ', 'ול', 'וב', 'וה', 'וש', 'וכ', 'של', 'אצל', 'עם', 'כש', 'מה', 'בה', 'לה', 'כה', 'שה', 'מל', 'מש',
  'ב', 'ל', 'מ', 'ה', 'ו', 'ש', 'כ'];

function norm(s) {
  if (s == null) return '';
  const t = String(s).toLowerCase().trim();
  const words = t.split(/[^0-9a-z֐-׿]+/).filter(Boolean);
  return words.join(' ');
}
function isJunk(k) {
  if (!k) return true;
  if (k.length < 2) return true;
  if (/^[0-9]+$/.test(k)) return true;
  if (k.length > 60) return true;
  // The bot lookup only checks ngrams up to 4 words, so 5+-word keys are
  // unreachable dead weight (and their sub-phrases can collide); drop them.
  if (k.split(' ').length > 4) return true;
  // Mixed-script token (e.g. "בelectro" = Hebrew clitic glued to a Latin word)
  // is padding junk a user would never type; drop the whole keyword.
  const toks = k.split(' ');
  for (let i = 0; i < toks.length; i++) {
    if (/[֐-׿]/.test(toks[i]) && /[a-z]/.test(toks[i])) return true;
  }
  return false;
}

function main() {
  if (!fs.existsSync(PACKS_DIR)) { console.error('no packs dir: ' + PACKS_DIR); process.exit(1); }
  const files = fs.readdirSync(PACKS_DIR).filter(f => f.endsWith('.json')).sort();

  // Phase 1 — collect per-bucket ordered keyword lists (dedup within bucket).
  const buckets = [];
  const bucketKey = new Map();
  const bucketKws = [];
  const bucketSet = [];
  let rawCount = 0, junkCount = 0, dupSameBucket = 0, incomeStopped = 0;
  let okPacks = 0;

  for (const f of files) {
    let pack;
    try { pack = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, f), 'utf8')); }
    catch (e) { console.error('SKIP malformed pack ' + f + ': ' + e.message); continue; }
    const cat = pack.category, sub = pack.subcategory;
    if (!cat || !sub || !Array.isArray(pack.keywords)) { console.error('SKIP invalid shape ' + f); continue; }
    okPacks++;
    const inc = pack.isIncome ? 1 : 0;
    const bk = cat + '' + sub + '' + inc;
    let bidx = bucketKey.get(bk);
    if (bidx === undefined) { bidx = buckets.length; buckets.push([cat, sub, inc]); bucketKey.set(bk, bidx); bucketKws.push([]); bucketSet.push(new Set()); }
    for (const raw of pack.keywords) {
      rawCount++;
      const k = norm(raw);
      if (isJunk(k)) { junkCount++; continue; }
      if (inc === 1 && INCOME_STOP.has(k)) { incomeStopped++; continue; }
      if (bucketSet[bidx].has(k)) { dupSameBucket++; continue; }
      bucketSet[bidx].add(k); bucketKws[bidx].push(k);
    }
  }

  // Phase 2 — per bucket: drop prefix-variants whose base is in the same bucket, then CAP.
  let prefixDropped = 0, capDropped = 0;
  for (let b = 0; b < buckets.length; b++) {
    const set = bucketSet[b];
    const kept = [];
    for (const k of bucketKws[b]) {
      let drop = false;
      if (k.indexOf(' ') < 0 && /[֐-׿]/.test(k)) {
        for (const p of PFX) {
          if (k.length - p.length >= 3 && k.slice(0, p.length) === p && set.has(k.slice(p.length))) { drop = true; break; }
        }
      }
      if (drop) { prefixDropped++; continue; }
      if (kept.length >= CAP) { capDropped++; continue; }
      kept.push(k);
    }
    bucketKws[b] = kept;
  }

  // Phase 3 — global flat index with cross-bucket collision (first bucket wins).
  const index = Object.create(null);
  const collisions = [];
  for (let b = 0; b < buckets.length; b++) {
    for (const k of bucketKws[b]) {
      if (index[k] !== undefined) {
        if (index[k] !== b && collisions.length < 5000) collisions.push({ keyword: k, kept: buckets[index[k]].slice(0, 2), dropped: buckets[b].slice(0, 2) });
        continue;
      }
      index[k] = b;
    }
  }

  const keys = Object.keys(index);
  const total = keys.length;

  fs.writeFileSync(OUT_JSON, JSON.stringify({ version: 'kw-index-v2', totalKeywords: total, bucketCount: buckets.length, buckets, index }));
  const header = [
    '/* ExpenseBot_KEYWORDS.gs — AUTO-GENERATED keyword fallback index. Do not edit by hand. */',
    '/* Built by bot/keywords/build_index.js from bot/keywords/packs/*.json */',
    '/* Total keywords: ' + total + ' across ' + buckets.length + ' buckets. */',
    '/* Used ONLY as an additive fallback by _kfl_bigIndexLookup in ExpenseBot_FIXED.gs */',
    'var KFL_KW_BUCKETS = ' + JSON.stringify(buckets) + ';',
    'var KFL_KW_INDEX = ' + JSON.stringify(index) + ';',
    '',
  ].join('\n');
  fs.writeFileSync(OUT_GS, header);

  console.log('PACKS: ' + files.length + ' files, ' + okPacks + ' ok');
  console.log('RAW keywords seen: ' + rawCount);
  console.log('  junk dropped:           ' + junkCount);
  console.log('  dup (same bucket):      ' + dupSameBucket);
  console.log('  income-ambiguous dropped: ' + incomeStopped);
  console.log('  prefix-variant dropped: ' + prefixDropped);
  console.log('  cap dropped:            ' + capDropped);
  console.log('  cross-bucket collisions (first kept): ' + collisions.length);
  console.log('UNIQUE indexed keywords: ' + total);
  console.log('BUCKETS: ' + buckets.length + '  (CAP ' + CAP + '/bucket)');
  console.log('OUT: ' + OUT_GS + '  (' + (fs.statSync(OUT_GS).size / 1048576).toFixed(2) + ' MB)');
  const counts = {};
  for (const k of keys) counts[index[k]] = (counts[index[k]] || 0) + 1;
  const top = Object.keys(counts).map(b => [buckets[b][0] + ' / ' + buckets[b][1], counts[b]]).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('TOP buckets:'); top.forEach(t => console.log('  ' + t[1] + '  ' + t[0]));
  if (collisions.length) fs.writeFileSync(path.join(__dirname, 'COLLISIONS.json'), JSON.stringify(collisions.slice(0, 2000)));
}
main();
