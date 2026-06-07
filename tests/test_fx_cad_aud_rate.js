#!/usr/bin/env node
// tests/test_fx_cad_aud_rate.js  (auto-discovered by the gauntlet)
//
// Behavioral guard for the Canadian/Australian dollar fix (Steven 2026-06-07).
// BUG: Hebrew "דולר קנדי" (CAD) and "דולר אוסטרלי" (AUD) converted at the USD
// rate (3.65) instead of CAD 2.65 / AUD 2.40 — the generic "דולר" token won
// over the specific multi-word name, in BOTH word orders. That overcharged the
// sheet by ~38-52% on every Canadian/Australian-dollar expense.
//
// We exercise the REAL engine through bot/bot-replay.js (--json) and assert the
// converted rate + ILS amount, and that the description is cleaned (no leftover
// "קנדי"/"אוסטרלי"). USD/other currencies are asserted unchanged (no regression).
//
// Offline (no UrlFetchApp) the engine uses the STATIC fallbacks, refreshed
// 2026-06-05 as the shekel strengthened: USD 2.91, CAD 2.10, AUD 2.07. In
// production the live daily rate (_kfl_fxRateLive_) is used instead. If the
// static floor is retuned, update these expectations.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPLAY = path.join(__dirname, '..', 'bot', 'bot-replay.js');
let pass = 0, fail = 0;
function ok(label, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL ' + label + (extra ? ('  [' + extra + ']') : '')); } }

function fxOf(msg) {
  let out;
  try { out = execFileSync('node', [REPLAY, '--json', msg], { encoding: 'utf8' }); }
  catch (e) { return { _err: (e && e.message) || 'replay failed' }; }
  let j; try { j = JSON.parse(out); } catch (e) { return { _err: 'bad json' }; }
  return (j && j.decisions && j.decisions.fx) || j.fx || {};
}

// approx compare (floating rates)
function near(a, b) { return typeof a === 'number' && Math.abs(a - b) < 0.001; }

// --- THE FIX: CAD in both word orders, amount-adjacent and non-adjacent ---
[
  { msg: '100 דולר קנדי uber', rate: 2.10, ils: 210 },
  { msg: 'דולר קנדי 100 uber', rate: 2.10, ils: 210 },
  { msg: '100 דולר אוסטרלי קפה', rate: 2.07, ils: 207 },
  { msg: 'דולר אוסטרלי 50 קפה', rate: 2.07, ils: 103.5 },
  { msg: '100 cad uber', rate: 2.10, ils: 210 },
  { msg: '100 aud sushi', rate: 2.07, ils: 207 },
].forEach(function (c) {
  const fx = fxOf(c.msg);
  ok('rate "' + c.msg + '" = ' + c.rate, near(fx.fxRate, c.rate), 'got ' + fx.fxRate + (fx._err || ''));
  ok('ils  "' + c.msg + '" = ' + c.ils, near(fx.ilsAmount, c.ils), 'got ' + fx.ilsAmount);
  ok('auto-converted "' + c.msg + '"', fx.autoConverted === true);
  // the modifier word must not leak into the cleaned description
  if (typeof fx.cleanedText === 'string') {
    ok('cleaned "' + c.msg + '" drops קנדי/אוסטרלי', !/קנדי|אוסטרלי/.test(fx.cleanedText), 'got "' + fx.cleanedText + '"');
  }
});

// --- REGRESSION: generic USD must STILL be USD (3.65), not CAD/AUD ---
[
  { msg: '100 דולר amazon', rate: 2.91 },
  { msg: '50 דולר', rate: 2.91 },
].forEach(function (c) {
  const fx = fxOf(c.msg);
  ok('USD "' + c.msg + '" = ' + c.rate, near(fx.fxRate, c.rate), 'got ' + fx.fxRate);
  ok('USD not CAD/AUD "' + c.msg + '"', fx.fxRate !== 2.10 && fx.fxRate !== 2.07, 'got ' + fx.fxRate);
});

console.log('test_fx_cad_aud_rate: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
