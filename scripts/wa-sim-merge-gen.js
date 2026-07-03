#!/usr/bin/env node
// scripts/wa-sim-merge-gen.js
//
// Merge + validate fleet-generated corpus lines into a clean JSONL corpus.
// Reads the workflow result file (JSON with result[].txt holding raw JSONL),
// validates every line hard, and writes the clean corpus. Validation:
//   - line parses as JSON with a non-empty msg
//   - expect.category (when present) is EXACTLY one of the bot's categories
//   - expect.amount (when present) is a finite positive number that ALSO appears
//     as a literal digit-run in the message (kills hallucinated amounts)
//   - dedup by normalized msg (across the fleet AND vs the existing corpus)
//   - msg has no bidi control chars, no newlines, sane length (2..200 chars)
//
// Usage: node scripts/wa-sim-merge-gen.js <workflow-result.json> <out.jsonl> [existing.jsonl]
'use strict';
const fs = require('node:fs');

const VALID_CATEGORIES = new Set(['הכנסות', 'הוצאות קבועות', 'חיות מחמד', 'חינוך וילדים', 'עסק', 'תחבורה', 'בידור', 'בריאות', 'טיפוח', 'קניות', 'אוכל', 'חינוך', 'מתנות', 'שונות ואחרים', 'פיננסים / השקעות', 'ממשלה ומיסים', 'תחזוקת בית', 'בנקאות', 'נסיעות', 'כושר ומנויים']);
const BIDI = /[‎‏‪-‮⁦-⁩]/;

const [resultFile, outFile, existingFile] = process.argv.slice(2);
if (!resultFile || !outFile) { console.error('usage: node scripts/wa-sim-merge-gen.js <workflow-result.json> <out.jsonl> [existing.jsonl]'); process.exit(2); }

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
const seen = new Set();
if (existingFile && fs.existsSync(existingFile)) {
  for (const line of fs.readFileSync(existingFile, 'utf8').split('\n')) {
    try { const o = JSON.parse(line); if (o && o.msg) seen.add(norm(o.msg)); } catch {}
  }
}

const raw = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
const agents = raw.result || raw; // workflow output file has {result: [...]}
const stats = { agents: 0, lines: 0, ok: 0, badJson: 0, badCat: 0, badAmt: 0, dup: 0, badMsg: 0 };
const out = [];

for (const a of agents) {
  if (!a || !a.txt) continue;
  stats.agents++;
  for (let line of String(a.txt).split('\n')) {
    line = line.trim().replace(/^```(?:json[l]?)?|```$/g, '').trim();
    if (!line || line[0] !== '{') continue;
    stats.lines++;
    let o; try { o = JSON.parse(line); } catch { stats.badJson++; continue; }
    if (!o || typeof o.msg !== 'string') { stats.badJson++; continue; }
    const msg = o.msg.replace(/\s+/g, ' ').trim();
    if (msg.length < 2 || msg.length > 200 || BIDI.test(msg) || /\n/.test(o.msg)) { stats.badMsg++; continue; }
    const exp = o.expect || {};
    if (exp.category != null && !VALID_CATEGORIES.has(String(exp.category).trim())) { stats.badCat++; continue; }
    if (exp.amount != null) {
      const n = Number(exp.amount);
      if (!isFinite(n) || n <= 0) { stats.badAmt++; continue; }
      // the literal amount must appear in the message (integer part is enough)
      const intPart = String(Math.trunc(n));
      if (msg.indexOf(intPart) < 0 && msg.indexOf(String(n)) < 0) { stats.badAmt++; continue; }
    }
    const key = norm(msg);
    if (seen.has(key)) { stats.dup++; continue; }
    seen.add(key);
    const clean = { msg, persona: String(o.persona || a.key || ''), expect: {} };
    if (exp.category != null) clean.expect.category = String(exp.category).trim();
    if (exp.amount != null) clean.expect.amount = Number(exp.amount);
    if (exp.isIncome != null) clean.expect.isIncome = !!exp.isIncome;
    out.push(JSON.stringify(clean));
    stats.ok++;
  }
}

fs.writeFileSync(outFile, out.join('\n') + '\n');
console.log(JSON.stringify({ ...stats, written: out.length, outFile }, null, 2));
