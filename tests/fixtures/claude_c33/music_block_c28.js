// ==== FIXTURE — NOT DEPLOYED, NOT PART OF THE BOT ====
// Verbatim copy of Claude's UNPUSHED working copy, copied read-only on 2026-11-02 from
// Steven's Mac (Claude session outputs / 'Expenses follow up/kesefle-app/bridge'). Source: music_block_c28.js
// Lives only in the live Apps Script project (v129 NOT deployed). Used by
// bot/test_music_business_midmessage.js to regression-test the fix. Do not paste from here.


// ===== סבב 28 (02/10/2026): ריבוי עסקים — "עסק מוזיקה" (BALIMORE) לצד "עסק" (תמונות) והוצאות אישיות =====
// (1) _kflMusicRoute_: כל הודעה עם סימן מוזיקה (עסק מוזיקה / מוזיקה / balimore / distrokid / suno / splice / landr …) מנותבת לקטגוריה "עסק מוזיקה"
//     עם תת-קטגוריה לפי מילות מפתח (הפצה ומנויים / הפקה וכלים / שיווק מוזיקה / הופעות ונסיעות / ציוד מוזיקה / כללי (מוזיקה) / הכנסות מוזיקה).
// (2) SRC_ROUTER_handle (ONE_PASTE_FIX_ALL.gs) נדרס: נשארות רק תשובות לשאלה ממתינה והזמנות; כל השאר → processExpense (מילון, המרת מט"ח, AI, ML Audit, סטטוס).
//     זה הנתב שרשם "distrokid 90 דולר" כ-90 ₪ באפליקציות, ושאיבד את "הכנסה 1545" ב-22/09 ("לא בטוח לאן לנתב").
// ביטול: למחוק את הבלוק הזה + את שתי השורות המסומנות "סבב 28" ב-_resolveIsIncome_ וב-_normalizeSubForDashboard_.
var _KFL_MUSIC_CAT_ = 'עסק מוזיקה';
var _KFL_MUSIC_SUBS_ = ['הפצה ומנויים','הפקה וכלים','שיווק מוזיקה','הופעות ונסיעות','ציוד מוזיקה','כללי (מוזיקה)','הכנסות מוזיקה'];
var _KFL_MUSIC_MARK_ = /(^|[\s,:\-])(עסק\s*מוזיקה|מוזיקה|מוסיקה|music|balimore|בלימור|richard\s*dall|ריצ'?רד\s*דאל)(?=$|[\s,:\-.!?)])/i;
var _KFL_MUSIC_BRANDS_ = /(^|[\s,:\-(])(distrokid|דיסטרוקיד|distro\s*kid|landr|לנדר|splice|ספלייס|suno|סונו|udio|submithub|groover|tunecore|cd\s*baby|ableton|אייבלטון|beatport|bandcamp|soundcloud|סאונדקלאוד|mastering|מאסטרינג|spotify\s*for\s*artists|apple\s*music\s*for\s*artists)(?=$|[\s,:\-.!?)])/i;
var _KFL_MUSIC_KW_ = [
  [/distrokid|דיסטרוקיד|distro\s*kid|landr|לנדר|tunecore|cd\s*baby|ditto|amuse|הפצה|spotify\s*for\s*artists|apple\s*music\s*for\s*artists|אגודת|acum|אקו"ם|אקום/i, 'הפצה ומנויים'],
  [/suno|סונו|udio|splice|ספלייס|ableton|אייבלטון|fl\s*studio|logic\s*pro|plugin|פלאגין|sample|סמפל|mastering|מאסטרינג|mixing|מיקס|vocal|ווקאל|הפקה|beat|ביט|stem|elevenlabs|אולפן|studio/i, 'הפקה וכלים'],
  [/קידום|promo|submithub|groover|playlist|פלייליסט|(^|\s)ads?(\s|$)|פרסום|שיווק|ממומן|אינסטגרם|instagram|tiktok|טיקטוק|youtube|יוטיוב|higgsfield|runway|קליפ|clip|video|וידאו|cover|עטיפ|canva|קנבה|midjourney|לוגו|logo|אתר|website|orshot|metricool/i, 'שיווק מוזיקה'],
  [/הופע|gig|show|live|נסיע|טיס|מלון|hotel|flight|festival|פסטיבל|מועדון|club/i, 'הופעות ונסיעות'],
  [/אוזני|headphone|מיקרופון|(^|\s)mic(\s|$)|microphone|כרטיס\s*קול|interface|controller|קונטרולר|מוניטור|monitor|midi|ציוד|equipment|רמקול|speaker/i, 'ציוד מוזיקה']
];
function _kflMusicRoute_(rawText, matched, coreIsInc){
  if(!matched || typeof matched!=='object') return null;
  var s=String(rawText||'');
  var isMusic=_KFL_MUSIC_MARK_.test(s) || _KFL_MUSIC_BRANDS_.test(s) || String(matched.category||'')===_KFL_MUSIC_CAT_;
  if(!isMusic) return null;
  var body=s.replace(/עסק\s*מוזיקה|מוזיקה|מוסיקה|music/gi,' ');
  var inc = coreIsInc===true || /(^|\s)(הכנסה|הכנסות|תמלוגים|royalt\w*|payout|נכנס|נכנסו|קיבלתי|שילמו\s*לי)(\s|$)/i.test(s);
  if(inc && !/(^|\s)(הוצאה|הוצאות|שילמתי|קניתי|מנוי)(\s|$)/.test(s)){ matched.category=_KFL_MUSIC_CAT_; matched.subcategory='הכנסות מוזיקה'; matched.isIncome=true; return true; }
  var sub='כללי (מוזיקה)';
  for(var i=0;i<_KFL_MUSIC_KW_.length;i++){ if(_KFL_MUSIC_KW_[i][0].test(body)){ sub=_KFL_MUSIC_KW_[i][1]; break; } }
  matched.category=_KFL_MUSIC_CAT_; matched.subcategory=sub; matched.isIncome=false; return false;
}
function SRC_ROUTER_handle(from, text){
  // סבב 28: דריסה של הנתב מ-ONE_PASTE_FIX_ALL.gs. נשארים: (א) תשובה לשאלה ממתינה ישנה, (ב) הזמנות. אין יותר רשימת explicit ואין "לא בטוח לאן לנתב".
  if(!text) return null;
  try{
    var pending=(typeof _SRC_readPending_==='function') ? _SRC_readPending_(from) : null;
    if(pending && pending.options){
      var picked=null; var trimmed=String(text).trim(); var n=trimmed.match(/^([1-4])\s*$/);
      if(n){ var idx=parseInt(n[1],10)-1; if(idx>=0 && idx<pending.options.length) picked=pending.options[idx]; }
      if(!picked){ var lc=trimmed.toLowerCase(); for(var i=0;i<pending.options.length;i++){ var opt=pending.options[i]; if(lc===String(opt.label).toLowerCase()||lc===String(opt.subcategory).toLowerCase()){ picked=opt; break; } } }
      if(picked){ _SRC_clearPending_(from); try{ if(pending.isBiz) _SRC_appendBizRow_(pending.amount, picked.category, picked.subcategory, '', pending.originalText); else _SRC_appendPersonalRow_(pending.amount, picked.category, picked.subcategory, pending.originalText); return { handled:true, reply:'✓ נרשם — '+picked.category+' / '+picked.subcategory+' — ₪'+pending.amount }; }catch(e){ return { handled:true, reply:'⚠️ שגיאה: '+e.message }; } }
      else { try{ _SRC_clearPending_(from); }catch(_c){} }
    }
  }catch(_p){}
  try{
    if(typeof _SRC_isOrder_==='function' && _SRC_isOrder_(text)){
      var parsed=_SRC_parseOrder_(text);
      if(!parsed.customer||!parsed.size||parsed.amount==null){ return { handled:true, reply:'🤔 לא הצלחתי לקרוא את ההזמנה. נסה:\n\nעסק - הזמנה\nשם לקוח: ...\nגודל: ...\nמחיר: ... שח' }; }
      var rowIdx=_SRC_appendOrder_(parsed); var sym=parsed.currency==='USD'?'$':parsed.currency==='EUR'?'€':'₪';
      return { handled:true, reply:'📝 הזמנה נרשמה — '+parsed.customer+', '+sym+parsed.amount+(parsed.size?' ('+parsed.size+')':'')+'\nשורה '+rowIdx+' ב־"הזמנות".' };
    }
  }catch(e2){ return { handled:true, reply:'⚠️ שגיאה בכתיבת ההזמנה: '+e2.message }; }
  return null;
}
function KFL_CANON_SELFTEST6(){
  var t=[
    ['עסק מוזיקה distrokid 90 דולר - מנוי שנתי','עסק מוזיקה','הפצה ומנויים',false],
    ['suno 30$','עסק מוזיקה','הפקה וכלים',false],
    ['מוזיקה קידום בטיקטוק 200','עסק מוזיקה','שיווק מוזיקה',false],
    ['עסק מוזיקה הכנסה 500 תמלוגים','עסק מוזיקה','הכנסות מוזיקה',true],
    ['balimore הופעה 300 נסיעה','עסק מוזיקה','הופעות ונסיעות',false],
    ['מוזיקה 100','עסק מוזיקה','כללי (מוזיקה)',false],
    ['עסק מוזיקה אוזניות 450','עסק מוזיקה','ציוד מוזיקה',false],
    ['אוכל בחוץ 72','אוכל','אוכל בחוץ',false],
    ['ספוטיפי 20','הוצאות קבועות','אפליקציות',false],
    ['דלק 300','תחבורה','דלק',false]
  ];
  var out=t.map(function(p){ var l=null; try{ l=_learnedLookup(p[0]); }catch(e){} var pick=l?{category:l.category,subcategory:l.subcategory}:{category:'שונות ואחרים',subcategory:'שונות'}; var r=_resolveIsIncome_(pick,p[0],pick.category,pick.subcategory); var dash=_normalizeSubForDashboard_(pick.subcategory,pick.category); var ok=(pick.category===p[1]&&dash===p[2]&&r===p[3]); return (ok?'OK':'FAIL')+' '+p[0]+' → '+pick.category+'/'+dash+' inc='+r; });
  var rt='n/a'; try{ rt=String(SRC_ROUTER_handle('000','עסק מוזיקה distrokid 90 דולר')); }catch(e){ rt='ERR '+e; }
  out.push('ROUTER('+rt+') '+(rt==='null'?'OK':'FAIL'));
  Logger.log(out.join(' | ')); return out.join(' | ');
}
