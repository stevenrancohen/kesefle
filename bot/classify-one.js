#!/usr/bin/env node
// bot/classify-one.js — classify ONE message exactly like the live bot does:
// primary CATEGORY_MAP (via bot-replay) THEN the keyword-index fallback. Prints
// one line: category | subcategory | income | amount | fxRate. Used by the QA
// fleet agents (and humans) so every tester judges routing the same way.
//   node bot/classify-one.js "85 סופר רמי לוי"
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const REPLAY = path.join(__dirname, 'bot-replay.js');
let KW = { index: {}, buckets: [] };
try { KW = JSON.parse(fs.readFileSync(path.join(__dirname, 'keywords', 'INDEX.json'), 'utf8')); } catch (_e) {}
function norm(s) { return String(s || '').toLowerCase().split(/[^0-9a-z֐-׿]+/).filter(Boolean).join(' '); }
function fallback(desc) {
  const t = norm(desc); if (!t) return null;
  const w = t.split(' '), c = [t];
  for (let n = Math.min(3, w.length); n >= 1; n--) for (let i = 0; i + n <= w.length; i++) c.push(w.slice(i, i + n).join(' '));
  for (const x of c) { const b = KW.index[x]; if (b !== undefined && KW.buckets[b]) return { category: KW.buckets[b][0], subcategory: KW.buckets[b][1], isIncome: KW.buckets[b][2] === 1 }; }
  return null;
}
const msg = process.argv.slice(2).join(' ');
if (!msg) { console.log('usage: node bot/classify-one.js "<message>"'); process.exit(2); }
let j = {};
try { j = JSON.parse(execFileSync('node', [REPLAY, '--json', msg], { encoding: 'utf8' })); } catch (e) { console.log('REPLAY_ERROR | ' + (e && e.message)); process.exit(1); }
const d = j.decisions || {}, mc = d.matchCategory || {}, am = d.amountMatch || {}, fx = d.fx || {};
let cat = mc.category || null, sub = mc.subcategory || null;
let income = mc.isIncome === true || am.isIncome === true || /^\s*\+/.test(msg);
// Mirror _resolveIsIncome_ rawText rules so this tool reports PROD sign behavior
if (/(?:משכורת|שכר)\s+ל(?:עובד|עובדת|עובדים|עובדות)|שילמתי\s+משכורת/.test(msg)) income = false;
else if (/(?:זיכוי|החזר)\s+מ[א-ת]|החזר\s+על\s+(?:קנייה|רכישה|המוצר|הזמנה|כרטיס)|(?:קיבלתי|קבלתי)\s+(?:זיכוי|החזר)|זוכיתי|שיל(?:ם|מה|מו)\s+לי(?=\s|$)|העביר(?:ה|ו)?\s+לי(?=\s|$)|החזיר(?:ה|ו)?\s+לי(?=\s|$)|הכנס(?:ה|ות)\s+מ[א-ת]|^הכנס(?:ה|ות)\b/.test(msg)) income = true;
if (!cat || cat.indexOf('שונות') >= 0) {
  const fb = fallback(msg.replace(/[+\-]?\d[\d.,]*/g, ' '));
  if (fb) { cat = fb.category; sub = fb.subcategory; if (fb.isIncome) income = true; }
}
const amount = am.amount !== undefined ? am.amount : (fx.ilsAmount !== undefined ? fx.ilsAmount : undefined);
console.log((cat || 'שונות ואחרים') + ' | ' + (sub || '') + ' | income=' + income + ' | amount=' + amount + ' | fxRate=' + (fx.fxRate || ''));
