#!/usr/bin/env node
// scripts/wa-sim-apply-kw.js
//
// Apply mined keyword additions to CATEGORY_MAP in bot/ExpenseBot_FIXED.gs.
// Input: the mining-workflow result file (JSON, result[] of {cat, additions}).
// Validation (hard, my side — agents are proposals only):
//   - keyword not already in the existing 21k keyword set (case-insensitive)
//   - not in the verb/stopword blacklist; length >= 3 Hebrew / 4 Latin
//   - subcategory exists for that category in the REAL map
//   - dedup across proposals
// Output: appends ONE new entry per (category, subcategory) before the closing
// of CATEGORY_MAP, tagged with a comment. Income entries get isIncome:true.
// DRY by default; --apply writes the file.
'use strict';
const fs = require('node:fs');

const BOT = 'bot/ExpenseBot_FIXED.gs';
const resultFile = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!resultFile) { console.error('usage: node scripts/wa-sim-apply-kw.js <mining-result.json> [--apply]'); process.exit(2); }

const src = fs.readFileSync(BOT, 'utf8');
function extractArray(decl) { const start = src.indexOf(decl); const open = src.indexOf('[', start); let d = 0; for (let i = open; i < src.length; i++) { if (src[i] === '[') d++; else if (src[i] === ']') { d--; if (d === 0) return { text: src.slice(open, i + 1), start: open, end: i + 1 }; } } return null; }
const mapBlock = extractArray('const CATEGORY_MAP =');
/* eslint-disable no-eval */
const MAP = eval(mapBlock.text);
/* eslint-enable no-eval */
const existing = new Set();
const validSubs = {}; // cat -> Set(subs)
for (const r of MAP) { if (!r || !r.category) continue; (r.keywords || []).forEach((k) => existing.add(String(k).toLowerCase().trim())); (validSubs[r.category] = validSubs[r.category] || new Set()).add(r.subcategory); }

const BLACKLIST = new Set(['קניתי', 'שילמתי', 'רכשתי', 'הזמנתי', 'עלה', 'יצא', 'קיבלתי', 'נכנס', 'נכנסה', 'העברתי', 'הוצאתי', 'תשלום', 'חשבון', 'קנייה', 'קניה', 'הזמנה', 'חנות', 'כסף', 'שקל', 'שקלים', 'היום', 'אתמול', 'הבוקר', 'בערב', 'עבור', 'בשביל', 'חדש', 'חדשה', 'ישן', 'גדול', 'קטן', 'הוצאה', 'הכנסה', 'העברה', 'מזומן', 'אשראי', 'ביט', 'פייבוקס', 'שירות', 'מנוי']);

const raw = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
const agents = raw.result || raw;
const stats = { proposed: 0, dupExisting: 0, blacklisted: 0, badSub: 0, tooShort: 0, dupProposal: 0, accepted: 0 };
const grouped = {}; // "cat||sub" -> Set(keywords)
const seenProposal = new Set();

for (const a of agents) {
  if (!a || !a.cat || !Array.isArray(a.additions)) continue;
  for (const add of a.additions) {
    stats.proposed++;
    const kw = String(add.keyword || '').replace(/\s+/g, ' ').trim();
    const sub = String(add.subcategory || '').trim();
    const kwLow = kw.toLowerCase();
    const isHeb = /[א-ת]/.test(kw);
    if ((isHeb && kw.length < 3) || (!isHeb && kw.length < 4)) { stats.tooShort++; continue; }
    if (BLACKLIST.has(kw) || BLACKLIST.has(kwLow)) { stats.blacklisted++; continue; }
    if (existing.has(kwLow)) { stats.dupExisting++; continue; }
    if (!validSubs[a.cat] || !validSubs[a.cat].has(sub)) { stats.badSub++; continue; }
    if (seenProposal.has(kwLow)) { stats.dupProposal++; continue; }
    seenProposal.add(kwLow);
    (grouped[a.cat + '||' + sub] = grouped[a.cat + '||' + sub] || new Set()).add(kw);
    stats.accepted++;
  }
}

const entries = [];
for (const [key, kws] of Object.entries(grouped)) {
  const [cat, sub] = key.split('||');
  const obj = { keywords: [...kws].sort(), category: cat, subcategory: sub };
  if (cat === 'הכנסות') obj.isIncome = true;
  entries.push('  ' + JSON.stringify(obj) + ',');
}

console.log(JSON.stringify({ ...stats, newEntries: entries.length }, null, 2));
if (!APPLY) { console.log('(dry run — pass --apply to write)'); process.exit(0); }

// insert before the CATEGORY_MAP closing "];" line — line-based scan from the
// declaration, string-safe (bracket counting breaks on keywords containing "]").
const declIdx = src.indexOf("const CATEGORY_MAP =");
const closeIdx = src.indexOf("\n];", declIdx);
if (closeIdx < 0) { console.error("CATEGORY_MAP closing ]; not found"); process.exit(1); }
const insertAt = closeIdx; // right after the last entry's "}", before its newline
// leading comma: the existing last entry has no trailing comma; the trailing
// comma on OUR last entry (before "];") is valid JS.
const block = ',\n  // === 10K-campaign mined vocabulary (2026-07-03) — everyday item words the map lacked; validated against the 21k existing keywords, per-category subs, and a verb/stopword blacklist. ===\n' + entries.join('\n').replace(/,$/, '');
const out = src.slice(0, insertAt) + block + src.slice(insertAt);
fs.writeFileSync(BOT, out);
console.log('APPLIED ' + entries.length + ' entries to ' + BOT);
