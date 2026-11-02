// ==== FIXTURE — NOT DEPLOYED, NOT PART OF THE BOT ====
// Verbatim copy of Claude's UNPUSHED working copy, copied read-only on 2026-11-02 from
// Steven's Mac (Claude session outputs / 'Expenses follow up/kesefle-app/bridge'). Source: zz_c33_bbe_fix.gs
// Lives only in the live Apps Script project (v129 NOT deployed). Used by
// bot/test_music_business_midmessage.js to regression-test the fix. Do not paste from here.


/* ===================== סבב 33: תיקון ניתוב בנתיב "הוצאה עסקית חשופה" (_classifyBareBusinessExpense_) =====================
 * באג (נמצא 02/11 מהערות התאים): הודעה עם "עסק" באמצע — "90 אפליקציה סונו - עסק מוזיקה", "45 דולר - עסק מוזיקה dostrokid",
 * "50 הוצאות שיווק עסק מוזיקה" — נתפסה ע"י _classifyBareBusinessExpense_ (ExpenseBot.gs ~9030) ונכתבה ל"עסק" (תמונות),
 * לפני ה-hooks של מוזיקה/ecom ולפני המרת מט"ח (גם "24 דולר - עסק vercel" נרשם 24 ₪).
 * התיקון — עטיפה בלי לגעת ב-ExpenseBot.gs: (1) סמני מוזיקה/ecom → null (ממשיכים לזרימה הרגילה: מילון, hooks, ML Audit, מט"ח),
 * (2) דולר/יורו → המרה בשער של הבוט (_kfl_fxLookup) + הערה בפירוט כמו processExpense. פעיל בוואטסאפ רק אחרי פרסום גרסה. בדיקה: KFL_CANON_SELFTEST8. */
(function () {
  if (typeof _classifyBareBusinessExpense_ !== 'function' || _classifyBareBusinessExpense_.__kflC33) return;
  var __origBBE = _classifyBareBusinessExpense_;
  var __wrappedBBE = function (text) {
    var s = String(text || '');
    try { if (_KFL_MUSIC_MARK_.test(s) || _KFL_MUSIC_BRANDS_.test(s) || _KFL_ECOM_MARK_.test(s) || _KFL_ECOM_BRANDS_.test(s)) return null; } catch (e) { /* בלי סמנים — ממשיכים */ }
    var r = __origBBE(text);
    if (!r) return r;
    try {
      var cm = s.match(/(\$|€|usd|eur|דולרים|דולר|יורו|אירו)/i);
      if (cm && r.amount > 0 && typeof _kfl_fxLookup === 'function') {
        var rate = Number(_kfl_fxLookup(cm[1]));
        if (rate > 0) {
          var sym = /€|eur|יורו|אירו/i.test(cm[1]) ? '€' : '$', orig = r.amount;
          r.amount = Math.round(orig * rate * 100) / 100;
          var d = String(r.cleanedDesc || '').replace(/(\$|€|\busd\b|\beur\b|דולרים|דולר|יורו|אירו)/gi, ' ').replace(/\s+-\s+/g, ' ').replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').replace(/\s+/g, ' ').trim();
          r.cleanedDesc = (d || r.subcategory) + ' — ' + orig + sym + ' (≈' + Math.round(r.amount) + ' ₪, שער ' + rate + ')';
          r.fx = { orig: orig, rate: rate, sym: sym };
        }
      }
    } catch (e2) { /* בלי המרה */ }
    return r;
  };
  __wrappedBBE.__kflC33 = true;
  _classifyBareBusinessExpense_ = __wrappedBBE;
})();

function KFL_CANON_SELFTEST8() {
  var out = [], ok = 0, total = 0;
  function chk(pass, line) { total++; if (pass) ok++; out.push((pass ? 'OK   | ' : 'FAIL | ') + line); }
  chk(!!(_classifyBareBusinessExpense_ && _classifyBareBusinessExpense_.__kflC33), 'wrapper active');
  [['90 אפליקציה סונו - עסק מוזיקה', null], ['45 דולר - עסק מוזיקה dostrokid', null], ['50 הוצאות שיווק עסק מוזיקה', null],
   ['עסק ecom 30 פייסבוק', null], ['24 דולר - עסק vercel', 'fx'], ['הוצאות עסק תמונות 62 gmail עסקי', 'same'], ['עסק 288 שיווק', 'same']].forEach(function (c) {
    var r = _classifyBareBusinessExpense_(c[0]);
    var pass = c[1] === null ? r === null : c[1] === 'fx' ? !!(r && r.fx && r.amount > r.fx.orig) : !!(r && !r.fx);
    chk(pass, 'BBE ' + c[0] + ' → ' + (r ? (r.amount + ' | ' + r.subcategory + ' | ' + r.cleanedDesc) : 'null'));
  });
  // המשך הזרימה הרגילה להודעות מוזיקה (מילון → matchCategory → _resolveIsIncome_ עם hook המוזיקה) — בלי AI
  [['90 אפליקציה סונו עסק מוזיקה', 'הפקה וכלים'], ['45 דולר עסק מוזיקה dostrokid', null], ['50 הוצאות שיווק עסק מוזיקה', 'שיווק מוזיקה']].forEach(function (c) {
    var m = null;
    try { m = (typeof _learnedLookup === 'function' ? _learnedLookup(c[0]) : null) || matchCategory(c[0]); } catch (e) { m = null; }
    m = m ? { category: m.category, subcategory: m.subcategory, isIncome: m.isIncome } : { category: '', subcategory: '' };
    var inc = _resolveIsIncome_(m, c[0], m.category, m.subcategory);
    var sub = _normalizeSubForDashboard_(m.subcategory, m.category);
    chk(m.category === 'עסק מוזיקה' && !inc && (!c[1] || sub === c[1]), 'flow ' + c[0] + ' → ' + m.category + ' / ' + sub + ' | income=' + inc);
  });
  var s = 'SELFTEST8 ' + ok + '/' + total + '\n' + out.join('\n'); Logger.log(s); return s;
}

// סבב 33: תיקוני אוקטובר לפי תוכן (לא לפי מספר שורה). שער אוקטובר של הבוט: 3.069 (distrokid 02/10). ביטול: KFL_OCT_FIXES_ROLLBACK_C33
var _KFL_OCT_FX_C33_ = 3.069;
var _KFL_OCT_FIX_C33_ = [
  { f: 'הוצאות שיווק מוזיקה', c: 50, d: 'עסק', e: 'עלות שיווק', to: { d: 'עסק מוזיקה', e: 'שיווק מוזיקה' } },
  { f: 'אפליקציה סונו - מוזיקה', c: 90, d: 'עסק', e: 'הוצאות תפעוליות', to: { d: 'עסק מוזיקה', e: 'הפקה וכלים' } },
  { f: 'דולר - מוזיקה dostrokid', c: 45, d: 'עסק', e: 'הוצאות תפעוליות', to: { d: 'עסק מוזיקה', e: 'הפצה ומנויים', usd: 45, f: 'distrokid' } },
  { f: 'דולר - vercel', c: 24, d: 'עסק', e: 'הוצאות תפעוליות', to: { usd: 24, f: 'vercel' } },
  { f: 'הוצאות שיווק', c: 104, d: 'עסק', e: 'שיווק', to: { e: 'עלות שיווק' } }
];
function _kflOctAfter_(fx) {
  var C = fx.to.usd ? Math.round(fx.to.usd * _KFL_OCT_FX_C33_ * 100) / 100 : fx.c;
  var F = fx.to.usd ? (fx.to.f + ' — ' + fx.to.usd + '$ (≈' + Math.round(C) + ' ₪, שער ' + _KFL_OCT_FX_C33_ + ')') : fx.f;
  return [C, fx.to.d || fx.d, fx.to.e || fx.e, F];
}
function _kflOctApply_(toAfter) {
  var sh = SpreadsheetApp.openById(_kfl29SheetId_()).getSheetByName('תנועות'), n = sh.getLastRow();
  var vals = sh.getRange(1, 1, n, 8).getValues(), log = [];
  _KFL_OCT_FIX_C33_.forEach(function (fx) {
    var from = toAfter ? [fx.c, fx.d, fx.e, fx.f] : _kflOctAfter_(fx), to = toAfter ? _kflOctAfter_(fx) : [fx.c, fx.d, fx.e, fx.f], hits = [];
    for (var i = 1; i < n; i++) {
      var r = vals[i];
      if (Math.abs(Number(r[2]) - from[0]) < 0.01 && String(r[3]) === from[1] && String(r[4]) === from[2] && String(r[5]).trim() === from[3]) hits.push(i);
    }
    if (hits.length !== 1) { log.push('SKIP (' + hits.length + ' matches) ' + from.join(' | ')); return; }
    sh.getRange(hits[0] + 1, 3, 1, 4).setValues([to]);
    log.push('row ' + (hits[0] + 1) + ': ' + from.join(' | ') + '  →  ' + to.join(' | '));
  });
  SpreadsheetApp.flush();
  var s = (toAfter ? 'OCT FIXES C33:\n' : 'OCT FIXES ROLLBACK C33:\n') + log.join('\n'); Logger.log(s); return s;
}
function KFL_OCT_FIXES_C33() { return _kflOctApply_(true); }
function KFL_OCT_FIXES_ROLLBACK_C33() { return _kflOctApply_(false); }

// סבב 33: מילון — שגיאת הקלדה שסטיבן משתמש בה (append-only, מקור claude-c33). ביטול: KFL_DICT_ROLLBACK_C33
var _KFL_DICT_C33_ = [['dostrokid', 'עסק מוזיקה', 'הפצה ומנויים'], ['דיסטרו קיד', 'עסק מוזיקה', 'הפצה ומנויים']];
function KFL_DICT_ADD_C33() {
  var sh = SpreadsheetApp.openById(_kfl29SheetId_()).getSheetByName('מילון לימוד'), have = {}, add = [];
  sh.getRange(1, 1, sh.getLastRow(), 1).getValues().forEach(function (r) { have[String(r[0]).trim().toLowerCase()] = 1; });
  _KFL_DICT_C33_.forEach(function (e) { if (!have[e[0].toLowerCase()]) add.push([e[0], e[1], e[2], 'claude-c33', '2026-11-02']); });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 5).setValues(add);
  var s = 'DICT C33: added ' + add.length + ' (' + add.map(function (a) { return a[0]; }).join(', ') + ')'; Logger.log(s); return s;
}
function KFL_DICT_ROLLBACK_C33() {
  var sh = SpreadsheetApp.openById(_kfl29SheetId_()).getSheetByName('מילון לימוד'), v = sh.getRange(1, 1, sh.getLastRow(), 5).getValues(), n = 0;
  for (var i = v.length - 1; i >= 1; i--) if (v[i][3] === 'claude-c33') { sh.deleteRow(i + 1); n++; }
  var s = 'DICT C33 rollback: removed ' + n; Logger.log(s); return s;
}
