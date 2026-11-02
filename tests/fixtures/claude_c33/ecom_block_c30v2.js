// ==== FIXTURE — NOT DEPLOYED, NOT PART OF THE BOT ====
// Verbatim copy of Claude's UNPUSHED working copy, copied read-only on 2026-11-02 from
// Steven's Mac (Claude session outputs / 'Expenses follow up/kesefle-app/bridge'). Source: ecom_block_c30v2.js
// Lives only in the live Apps Script project (v129 NOT deployed). Used by
// bot/test_music_business_midmessage.js to regression-test the fix. Do not paste from here.


// ===== סבב 30 (03/10/2026): עסק שלישי — "הוצאות ecom" (איקומרס) =====
// מקביל ל"עסק מוזיקה": קטגוריה "הוצאות ecom", 8 תת-קטגוריות, זיהוי לפי סמן/מותג, ניקוי קידומת "עסק" בנתב,
// לשונית "הוצאות ecom" במאזן, שורת "עסק ecom" במאזן אישי. גיבוי לפני: גיליון 1EUHFbKlzqxftNAehuM0MaylYYrrDqYyLy8rvCWoCy6c, בוט 1wFuTzkspfKrCdAmpPlfOwg80CqqQ2CxNyHBibZ8xTpZTMA6OcUG20Dky
var _KFL_ECOM_CAT_ = 'הוצאות ecom';
var _KFL_ECOM_SUBS_ = ['דומיין ואתר', 'פרסום ושיווק', 'מלאי ומוצרים', 'משלוחים ולוגיסטיקה', 'כלים ומנויים', 'עמלות ותשלומים', 'כללי (ecom)', 'הכנסות ecom'];
var _KFL_ECOM_MARK_ = /(^|[\s,:\-(])(ecom|e-?commerce|איקומרס|אי-?קומרס|אי קומרס|חנות\s*אונליין|עסק\s*ecom|הוצאות\s*ecom|דרופשיפינג|dropshipping|drop\s*shipping)(?=$|[\s,:\-.!?)])/i;
var _KFL_ECOM_BRANDS_ = /(^|[\s,:\-(])(all\s?u|allu|אול\s?יו|shopify|שופיפיי|klaviyo|woocommerce|printful|printify|dsers|zendrop|spocket|oberlo|namecheap|godaddy|גודדי|bigcommerce|gorgias|cj\s*dropshipping|autods)(?=$|[\s,:\-.!?)])/i;
var _KFL_ECOM_KW_ = [
  [/עמל(ה|ת|ות)|\bfees?\b|paypal|פייפאל|stripe|payoneer|פיוניר|מע"מ|מעמ\b|\bvat\b|\btax/i, 'עמלות ותשלומים'],
  [/משלוח|shipping|delivery|\bdhl\b|fedex|\bups\b|מכס|customs|fulfil|לוגיסט|logistic|אריזה|packag|שליח|courier/i, 'משלוחים ולוגיסטיקה'],
  [/מלאי|inventory|מוצר|product|ספק|supplier|aliexpress|אליאקספרס|alibaba|עליבאבא|דוגמ|sample|zendrop|spocket|printful|printify|dropship|דרופשיפ|סחורה|יבוא|import|\bcj\b/i, 'מלאי ומוצרים'],
  [/פרסום|\bads?\b|מודע|קמפיין|campaign|\bmeta\b|מטא|פייסבוק|facebook|instagram|אינסטגרם|tiktok|טיקטוק|google|גוגל|influenc|משפיענ|קריאייטיב|creative|canva|קנבה|\bugc\b|שיווק|promo|קידום|pinterest|snapchat/i, 'פרסום ושיווק'],
  [/דומי+נ|דומי+ן|domain|hosting|אחסון|shopify|שופיפיי|\bwix\b|וויקס|wordpress|woocommerce|bigcommerce|theme|תבנית|namecheap|godaddy|גודדי|cloudflare|\bssl\b|אתר|website|\bsite\b|landing|דף נחיתה/i, 'דומיין ואתר'],
  [/klaviyo|mailchimp|gorgias|zendesk|dsers|oberlo|autods|zapier|notion|\bcrm\b|chatgpt|openai|\bapps?\b|אפליקצי|subscription|מנוי|\btool|כלי|saas|תוכנ/i, 'כלים ומנויים']
];
function _kflEcomRoute_(rawText, matched, coreIsInc) {
  if (!matched || typeof matched !== 'object') return null;
  var s = String(rawText || '');
  var isEcom = _KFL_ECOM_MARK_.test(s) || _KFL_ECOM_BRANDS_.test(s) || String(matched.category || '') === _KFL_ECOM_CAT_;
  if (!isEcom) return null;
  var body = s.replace(/עסק\s*ecom|הוצאות\s*ecom|e-?commerce|ecom|איקומרס|אי-?קומרס|אי קומרס/gi, ' ');
  var inc = coreIsInc === true || /(^|\s)(הכנסה|הכנסות|מכירה|מכירות|payout|נכנס|נכנסו|קיבלתי|שילמו\s*לי|revenue|sales)(\s|$)/i.test(s);
  if (inc && !/(^|\s)(הוצאה|הוצאות|שילמתי|קניתי|מנוי|עמלה)(\s|$)/.test(s)) {
    matched.category = _KFL_ECOM_CAT_; matched.subcategory = 'הכנסות ecom'; matched.isIncome = true; return true;
  }
  var sub = 'כללי (ecom)';
  for (var i = 0; i < _KFL_ECOM_KW_.length; i++) { if (_KFL_ECOM_KW_[i][0].test(body)) { sub = _KFL_ECOM_KW_[i][1]; break; } }
  matched.category = _KFL_ECOM_CAT_; matched.subcategory = sub; matched.isIncome = false; return false;
}
function _kflEcomClean_(text) {
  var s = String(text || '').trim(); if (!s) return null;
  if (/^\s*[1-4]\s*$/.test(s)) return null;
  if (!(_KFL_ECOM_MARK_.test(s) || _KFL_ECOM_BRANDS_.test(s))) return null;
  var clean = s.replace(/^(עסק|biz|business)\s*[:\-–—]?\s*/i, '');
  clean = clean.replace(/\s*[\-–—:]+\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/(ecom|e-?commerce|איקומרס|אי-?קומרס)/i.test(clean)) clean = 'ecom ' + clean;
  return clean;
}
function KFL_CANON_SELFTEST7() {
  var t = [
    ['הוצאות ecom דומיין 9 דולר', 'הוצאות ecom', 'דומיין ואתר', false],
    ['ecom shopify 29$', 'הוצאות ecom', 'דומיין ואתר', false],
    ['עסק ecom פרסום פייסבוק 300', 'הוצאות ecom', 'פרסום ושיווק', false],
    ['ecom מלאי מהספק 1200', 'הוצאות ecom', 'מלאי ומוצרים', false],
    ['ecom משלוח dhl 85', 'הוצאות ecom', 'משלוחים ולוגיסטיקה', false],
    ['ecom klaviyo 20 דולר', 'הוצאות ecom', 'כלים ומנויים', false],
    ['ecom עמלת paypal 12', 'הוצאות ecom', 'עמלות ותשלומים', false],
    ['ecom 150', 'הוצאות ecom', 'כללי (ecom)', false],
    ['ecom הכנסה 450 מכירות', 'הוצאות ecom', 'הכנסות ecom', true],
    ['shopify 29$', 'הוצאות ecom', 'דומיין ואתר', false],
    ['עסק מוזיקה distrokid 90 דולר', 'עסק מוזיקה', 'הפצה ומנויים', false],
    ['אליאקספרס 60', 'שונות ואחרים', 'שונות', false],
    ['אוכל בחוץ 72', 'אוכל', 'אוכל בחוץ', false],
    ['הוצאות ecom קניית דומין ל all u 30', 'הוצאות ecom', 'דומיין ואתר', false],
    ['all u פרסום טיקטוק 120', 'הוצאות ecom', 'פרסום ושיווק', false]
  ];
  var out = t.map(function (p) {
    var l = null; try { l = _learnedLookup(p[0]); } catch (e) {}
    var pick = l ? { category: l.category, subcategory: l.subcategory } : { category: 'שונות ואחרים', subcategory: 'שונות' };
    var r = _resolveIsIncome_(pick, p[0], pick.category, pick.subcategory);
    var dash = _normalizeSubForDashboard_(pick.subcategory, pick.category);
    var ok = (pick.category === p[1] && dash === p[2] && r === p[3]);
    return (ok ? 'OK' : 'FAIL') + ' ' + p[0] + ' → ' + pick.category + '/' + dash + ' inc=' + r;
  });
  var ct = [['עסק ecom - 300 פרסום פייסבוק', 'ecom 300 פרסום פייסבוק'], ['הוצאות ecom דומיין 9 דולר', 'הוצאות ecom דומיין 9 דולר'], ['shopify 29$', 'ecom shopify 29$'], ['עסק מוזיקה suno 30$', null], ['אוכל בחוץ 72', null], ['2', null]];
  ct.forEach(function (c) { var g = null; try { g = _kflEcomClean_(c[0]); } catch (e) { g = 'ERR ' + e; } out.push((g === c[1] ? 'OK' : 'FAIL') + ' eclean(' + c[0] + ') → ' + g); });
  Logger.log(out.join(' | ')); return out.join(' | ');
}
// --- מילון ---
var _KFL_DICT_C30_ = [
  ['ecom', 'הוצאות ecom', 'כללי (ecom)'], ['הוצאות ecom', 'הוצאות ecom', 'כללי (ecom)'], ['עסק ecom', 'הוצאות ecom', 'כללי (ecom)'],
  ['ecommerce', 'הוצאות ecom', 'כללי (ecom)'], ['e-commerce', 'הוצאות ecom', 'כללי (ecom)'], ['איקומרס', 'הוצאות ecom', 'כללי (ecom)'], ['אי קומרס', 'הוצאות ecom', 'כללי (ecom)'], ['אי-קומרס', 'הוצאות ecom', 'כללי (ecom)'],
  ['חנות אונליין', 'הוצאות ecom', 'כללי (ecom)'], ['dropshipping', 'הוצאות ecom', 'מלאי ומוצרים'], ['דרופשיפינג', 'הוצאות ecom', 'מלאי ומוצרים'],
  ['shopify', 'הוצאות ecom', 'דומיין ואתר'], ['שופיפיי', 'הוצאות ecom', 'דומיין ואתר'], ['woocommerce', 'הוצאות ecom', 'דומיין ואתר'], ['bigcommerce', 'הוצאות ecom', 'דומיין ואתר'],
  ['namecheap', 'הוצאות ecom', 'דומיין ואתר'], ['godaddy', 'הוצאות ecom', 'דומיין ואתר'], ['גודדי', 'הוצאות ecom', 'דומיין ואתר'], ['cloudflare', 'הוצאות ecom', 'דומיין ואתר'],
  ['klaviyo', 'הוצאות ecom', 'כלים ומנויים'], ['gorgias', 'הוצאות ecom', 'כלים ומנויים'], ['dsers', 'הוצאות ecom', 'כלים ומנויים'], ['autods', 'הוצאות ecom', 'כלים ומנויים'], ['oberlo', 'הוצאות ecom', 'כלים ומנויים'],
  ['printful', 'הוצאות ecom', 'מלאי ומוצרים'], ['printify', 'הוצאות ecom', 'מלאי ומוצרים'], ['zendrop', 'הוצאות ecom', 'מלאי ומוצרים'], ['spocket', 'הוצאות ecom', 'מלאי ומוצרים'], ['cj dropshipping', 'הוצאות ecom', 'מלאי ומוצרים'],
  ['הכנסות ecom', 'הוצאות ecom', 'הכנסות ecom'], ['מכירות ecom', 'הוצאות ecom', 'הכנסות ecom']
];
function KFL_DICT_ADD_C30() {
  var id = _kfl29SheetId_(); var sh = SpreadsheetApp.openById(id).getSheetByName('מילון לימוד');
  var data = sh.getDataRange().getValues(); var have = {};
  for (var i = 1; i < data.length; i++) { var k = String(data[i][0] || '').trim().toLowerCase(); if (k && !have[k]) have[k] = i + 1; }
  var today = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd'); var rows = [], added = [], skipped = [];
  _KFL_DICT_C30_.forEach(function (r) { var k = String(r[0]).trim().toLowerCase(); if (!k) return; if (have[k]) { skipped.push(r[0]); return; } rows.push([r[0], r[1], r[2], 'claude-c30', today]); added.push(r[0]); have[k] = true; });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
  var msg = 'C30 DICT: added=' + added.length + ' skipped=' + skipped.length + ' | skipped: ' + skipped.join(', ') + ' | total rows now: ' + sh.getLastRow(); Logger.log(msg); return msg;
}
function KFL_DICT_ROLLBACK_C30() {
  var sh = SpreadsheetApp.openById(_kfl29SheetId_()).getSheetByName('מילון לימוד'); var data = sh.getDataRange().getValues(); var del = 0;
  for (var i = data.length - 1; i >= 1; i--) if (String(data[i][3] || '') === 'claude-c30') { sh.deleteRow(i + 1); del++; }
  var msg = 'C30 DICT ROLLBACK: deleted=' + del; Logger.log(msg); return msg;
}
// --- לשונית במאזן (בונה גנרי לעסק) ---
function _kflBuildBizTab_(spec) {
  var ss = SpreadsheetApp.openById(_kfl29SheetId_()); var sh = ss.getSheetByName(spec.name);
  if (!sh) { var after = ss.getSheetByName(spec.after); var idx = after ? after.getIndex() : ss.getSheets().length; sh = ss.insertSheet(spec.name, idx); } else { sh.clear(); sh.clearFormats(); }
  sh.setRightToLeft(true);
  var months = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  var NF = '[$₪ ]#,##0;[RED]-[$₪ ]#,##0;"–"'; var T = "'תנועות'";
  sh.getRange('A1').setValue(spec.title); sh.getRange('A2').setValue(spec.subtitle);
  sh.getRange('A4').setValue('📅 שנת:'); sh.getRange('B4').setFormula("='מאזן אישי'!B2"); sh.getRange('C4').setValue('(השנה נלקחת ממאזן אישי)');
  sh.getRange(5, 1, 1, 14).setValues([['קטגוריה', 'סיכום שנתי'].concat(months)]);
  var first = 6;
  for (var i = 0; i < spec.rows.length; i++) {
    var r = first + i; sh.getRange(r, 1).setValue(spec.rows[i][0]); sh.getRange(r, 2).setFormula('=SUM(C' + r + ':N' + r + ')'); var fs = [];
    for (var m = 1; m <= 12; m++) {
      var mm = (m < 10 ? '0' : '') + m; var key = '$B$4&"-' + mm + '"';
      var base = 'SUMIFS(' + T + '!C:C,' + T + '!B:B,' + key + ',' + T + '!D:D,"' + spec.category + '"';
      if (spec.rows[i][1] === '__OTHER__') { var col = String.fromCharCode(64 + 2 + m); fs.push('=IFERROR(' + base + ')-SUM(' + col + first + ':' + col + (r - 1) + '),0)'); }
      else fs.push('=IFERROR(' + base + ',' + T + '!E:E,"' + spec.rows[i][1] + '"),0)');
    }
    sh.getRange(r, 3, 1, 12).setFormulas([fs]);
  }
  var last = first + spec.rows.length - 1, rTot = last + 1, rNet = last + 2, rPct = last + 3, rCov = last + 4, rNote = last + 5;
  sh.getRange(rTot, 1).setValue('📤 סה״כ הוצאות'); sh.getRange(rNet, 1).setValue('📈 רווח נקי (הכנסות − הוצאות)');
  sh.getRange(rPct, 1).setValue('📊 שולי רווח (רווח ÷ הכנסות; רצפה −100%)'); sh.getRange(rCov, 1).setValue('📊 כיסוי הוצאות (הכנסות ÷ הוצאות)');
  var ft = [], fn = [], fp = [], fc = [];
  for (var c = 2; c <= 14; c++) { var L = String.fromCharCode(64 + c); ft.push('=SUM(' + L + (first + 1) + ':' + L + last + ')'); fn.push('=' + L + first + '-' + L + rTot); fp.push('=IF(N(' + L + first + ')<=0,"–",MAX(' + L + rNet + '/' + L + first + ',-1))'); fc.push('=IF(N(' + L + rTot + ')<=0,"–",' + L + first + '/' + L + rTot + ')'); }
  sh.getRange(rTot, 2, 1, 13).setFormulas([ft]); sh.getRange(rNet, 2, 1, 13).setFormulas([fn]); sh.getRange(rPct, 2, 1, 13).setFormulas([fp]); sh.getRange(rCov, 2, 1, 13).setFormulas([fc]);
  sh.getRange(rNote, 1).setValue('הערה: שורת "אחר" תופסת תנועות של ' + spec.category + ' עם תת-קטגוריה שאינה ברשימה — אם היא לא 0, לתקן את תת-הקטגוריה בתנועות. שולי רווח מוצגים רק כשיש הכנסות, עם רצפה של −100%; "כיסוי הוצאות" = איזה חלק מההוצאות ההכנסות מכסות. שורת "' + spec.dashLabel + '" במאזן אישי = שורת הרווח הנקי כאן.');
  sh.getRange(1, 1, 1, 14).merge().setBackground(spec.color).setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(14).setHorizontalAlignment('center');
  sh.getRange(2, 1, 1, 14).merge().setBackground('#FAFAF7').setFontColor('#5F6B7A').setFontStyle('italic').setFontSize(10).setHorizontalAlignment('center');
  sh.getRange(4, 1, 1, 3).setBackground('#FFF59D').setFontWeight('bold');
  sh.getRange(5, 1, 1, 14).setBackground('#0B5D2A').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange(first, 1, 1, 14).setBackground('#DCF5DF').setFontWeight('bold');
  for (var k = first + 1; k <= last; k++) sh.getRange(k, 1, 1, 14).setBackground(k % 2 ? '#FAFAF7' : '#FFFFFF');
  sh.getRange(last, 1, 1, 14).setFontColor('#B71C1C');
  sh.getRange(rTot, 1, 1, 14).setBackground('#BBDEFB').setFontWeight('bold');
  sh.getRange(rNet, 1, 1, 14).setBackground('#DCF5DF').setFontWeight('bold').setFontColor('#0B5D2A').setFontSize(12);
  sh.getRange(rPct, 1, 2, 14).setBackground('#FFF59D').setFontWeight('bold');
  sh.getRange(first, 2, rNet - first + 1, 13).setNumberFormat(NF); sh.getRange(rPct, 2, 2, 13).setNumberFormat('0.00%');
  sh.getRange(5, 2, rCov - 4, 13).setHorizontalAlignment('center');
  sh.getRange(rNote, 1, 1, 14).merge().setFontColor('#5F6B7A').setFontSize(9).setWrap(true);
  sh.setColumnWidth(1, 300); sh.setColumnWidth(2, 110); for (var w = 3; w <= 14; w++) sh.setColumnWidth(w, 90);
  sh.setFrozenRows(5); try { sh.setTabColor(spec.color); } catch (e) {}
  return { sheet: sh, netRow: rNet, gid: sh.getSheetId() };
}
function KFL_ECOM_TAB_C30() {
  var r = _kflBuildBizTab_({
    name: 'הוצאות ecom', after: 'עסק מוזיקה', category: _KFL_ECOM_CAT_, dashLabel: 'עסק ecom', color: '#E65100',
    title: '🛒  הוצאות ecom — החנות המקוונת', subtitle: 'נתונים מחושבים אוטומטית מתוך לשונית תנועות (קטגוריה "הוצאות ecom"). לא להקליד מספרים כאן — כל שינוי דרך תנועות.',
    rows: [['💰 הכנסות ecom (מכירות)', 'הכנסות ecom'], ['🌐 דומיין ואתר (Shopify, דומיין, אחסון)', 'דומיין ואתר'], ['📣 פרסום ושיווק (Meta, TikTok, Google…)', 'פרסום ושיווק'], ['📦 מלאי ומוצרים (ספקים, דוגמאות)', 'מלאי ומוצרים'], ['🚚 משלוחים ולוגיסטיקה', 'משלוחים ולוגיסטיקה'], ['🧰 כלים ומנויים (Klaviyo, אפליקציות)', 'כלים ומנויים'], ['💳 עמלות ותשלומים (PayPal, Stripe, מע"מ)', 'עמלות ותשלומים'], ['📁 כללי (ecom)', 'כללי (ecom)'], ['❓ אחר — תת-קטגוריה לא מוכרת', '__OTHER__']]
  });
  var msg = 'C30 ECOM TAB: gid=' + r.gid + ' netRow=' + r.netRow; Logger.log(msg); return msg;
}
// --- חיבור למאזן אישי: שורה חדשה אחרי "עסק מוזיקה" ---
function KFL_ECOM_DASH_LINK_C30() {
  var ss = SpreadsheetApp.openById(_kfl29SheetId_()); var d = ss.getSheetByName('מאזן אישי');
  var tab = ss.getSheetByName('הוצאות ecom'); if (!tab) return 'ABORT: no ecom tab';
  var netRow = 0; for (var r = 10; r <= 25; r++) if (String(tab.getRange(r, 1).getValue()).indexOf('רווח נקי') >= 0) { netRow = r; break; }
  if (!netRow) return 'ABORT: net row not found in ecom tab';
  var musicRow = 0; for (var i = 5; i <= 12; i++) if (String(d.getRange(i, 1).getValue()).trim() === 'עסק מוזיקה') { musicRow = i; break; }
  if (!musicRow) return 'ABORT: no עסק מוזיקה row in dashboard';
  if (String(d.getRange(musicRow + 1, 1).getValue()).trim() === 'עסק ecom') return 'already linked';
  d.insertRowAfter(musicRow); var nr = musicRow + 1;
  d.getRange(nr, 1).setValue('עסק ecom'); d.getRange(nr, 2).setFormula('=SUM(C' + nr + ':N' + nr + ')');
  var fs = []; for (var m = 1; m <= 12; m++) { var L = String.fromCharCode(64 + 2 + m); fs.push("=IFERROR('הוצאות ecom'!" + L + netRow + ',0)'); }
  d.getRange(nr, 3, 1, 12).setFormulas([fs]);
  var spark = d.getRange(musicRow, 15).getFormula(); if (spark) d.getRange(nr, 15).setFormula(spark.replace(new RegExp('C' + musicRow + ':N' + musicRow, 'g'), 'C' + nr + ':N' + nr));
  d.getRange(nr, 1, 1, 15).setBackground('#DCF5DF').setFontColor('#1f2933').setFontWeight('normal'); d.getRange(nr, 2, 1, 13).setNumberFormat(d.getRange(musicRow, 3).getNumberFormat());
  var totRow = 0; for (var t = nr + 1; t <= nr + 4; t++) if (String(d.getRange(t, 1).getValue()).indexOf('סה״כ הכנסות') >= 0) { totRow = t; break; }
  var totFix = 0; if (totRow) { var f0 = d.getRange(totRow, 3).getFormula(); if (f0 && f0.indexOf(':C' + nr + ')') < 0) { for (var c = 3; c <= 14; c++) { var Lc = String.fromCharCode(64 + c); d.getRange(totRow, c).setFormula('=SUM(' + Lc + '2:' + Lc + nr + ')'); totFix++; } } }
  var ctrlRow = 0; for (var q = 70; q <= 90; q++) if (String(d.getRange(q, 1).getValue()).indexOf('הוצאות שלא נספרו') >= 0) { ctrlRow = q; break; }
  var fixed = 0;
  if (ctrlRow) for (var cc = 3; cc <= 14; cc++) { var f = d.getRange(ctrlRow, cc).getFormula(); if (!f || f.indexOf(_KFL_ECOM_CAT_) >= 0) continue; var mm = (f.match(/\$B\$2&"-(\d\d)"/) || [])[1]; if (!mm) continue; var term = "-SUMIFS('תנועות'!C:C,'תנועות'!B:B,$B$2&\"-" + mm + "\",'תנועות'!D:D,\"" + _KFL_ECOM_CAT_ + "\")"; var nf = f.replace(/("עסק מוזיקה"\))/, '$1' + term); if (nf !== f) { d.getRange(ctrlRow, cc).setFormula(nf); fixed++; } }
  SpreadsheetApp.flush();
  var msg = 'C30 DASH LINK: row ' + nr + ' עסק ecom | totRow=' + totRow + ' totFix=' + totFix + ' ctrlRow=' + ctrlRow + ' fixed=' + fixed + ' | ctrl B=' + (ctrlRow ? d.getRange(ctrlRow, 2).getValue() : '?'); Logger.log(msg); return msg;
}
// --- הוצאה ראשונה: דומיין 9$ (שער 03/10: 3.0653 → 28 ₪) ---
function KFL_ECOM_ENTRIES_C30() {
  var sh = SpreadsheetApp.openById(_kfl29SheetId_()).getSheetByName('תנועות'); var data = sh.getRange(1, 1, sh.getLastRow(), 8).getValues();
  var ym = Utilities.formatDate(new Date(), _kfl29Tz_(), 'yyyy-MM');
  var log = [_kfl29AppendIfMissing_(sh, data, ym, _KFL_ECOM_CAT_, 'דומיין ואתר', 28, 'דומיין לחנות ecom — 9$ (≈28 ₪, שער 3.065)', 'Claude סבב 30', false)];
  SpreadsheetApp.flush(); var msg = 'C30 ENTRIES: ' + log.join(' | ') + ' lastRow=' + sh.getLastRow(); Logger.log(msg); return msg;
}

// ----- סבב 30ב (03/10/2026 12:45): תיקון כפילות הדומיין אחרי הבדיקה החיה -----
// שורה 935 (28 ₪, "Claude סבב 30") הייתה הזנה מוקדמת שלי; סטיבן שלח את אותו דומיין בבוט (30 ₪, שורה 936, "קניית דומין ל all u").
// מוחק את השורה שלי, ומתקן את תת-הקטגוריה של השורה שלו ל"דומיין ואתר" (הבוט לא הכיר את הכתיב "דומין").
function KFL_ECOM_DEDUPE_C30B() {
  var sh = SpreadsheetApp.openById(_kfl29SheetId_()).getSheetByName('תנועות');
  var n = sh.getLastRow(); var data = sh.getRange(1, 1, n, 8).getValues(); var log = [];
  var mine = -1, his = -1;
  for (var i = 1; i < data.length; i++) {
    var cat = String(data[i][3] || ''), desc = String(data[i][5] || ''), src = String(data[i][6] || '');
    if (cat === _KFL_ECOM_CAT_ && src === 'Claude סבב 30' && desc.indexOf('דומיין לחנות ecom') === 0) mine = i + 1;
    if (cat === _KFL_ECOM_CAT_ && src === 'WhatsApp' && /קניית דומין/.test(desc)) his = i + 1;
  }
  if (his > 0 && String(data[his - 1][4]) !== 'דומיין ואתר') { sh.getRange(his, 5).setValue('דומיין ואתר'); log.push('row ' + his + ': E כללי (ecom) -> דומיין ואתר'); } else log.push('his=' + his + ' (no change)');
  if (mine > 0) { sh.deleteRow(mine); log.push('row ' + mine + ' deleted (28 ₪ Claude סבב 30)'); } else log.push('mine not found');
  SpreadsheetApp.flush(); var msg = 'C30B DEDUPE: ' + log.join(' | ') + ' | lastRow=' + sh.getLastRow(); Logger.log(msg); return msg;
}
