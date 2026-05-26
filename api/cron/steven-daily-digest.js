// /api/cron/steven-daily-digest
//
// תקציר יומי בעברית של מה שנעשה בפרויקט -- נשלח לטלפון של סטיבן
// (972547760643) כל בוקר ב-9:00 שעון ישראל (06:00 UTC).
//
// המקור: API של GitHub. אנחנו שולפים את הקומיטים מ-main מאז ה-cron
// האחרון, מקבצים אותם לפי נושא, ומפרמטים בעברית.
//
// אם השלוחה הזו רצה ידנית (לא ע"י Vercel cron), חייבים להעביר
// ?admin=<KESEFLE_BOT_SECRET> כדי שלא נשלח שלא בטעות.

import { withRequestId, log } from '../../lib/log.js';
import { constantTimeEqual } from '../../lib/crypto.js';

const STEVEN_PHONE     = '972547760643';
const GITHUB_REPO      = 'stevenrancohen/kesefle';
const HOURS_LOOKBACK   = 24;
const PROJECT_START    = '2026-05-15T00:00:00Z'; // תחילת הפרויקט (נשתמש בזה כברירת מחדל לשליחה ראשונה)

// ── עזר: ניסוח עברי לקטגוריות קומיטים ──────────────────────────────
const BUCKETS = [
  { rx: /^fix:|תיקון|fix\b/i,                 label: '🐛 תיקוני באגים' },
  { rx: /^feat:|הוסף|הוספ|חדש|feature/i,        label: '✨ פיצ׳רים חדשים' },
  { rx: /rebrand|color|font|design|UI|UX|light/i, label: '🎨 עיצוב + טיפוגרפיה' },
  { rx: /security|isolation|tenant|auth/i,    label: '🔐 אבטחה' },
  { rx: /test|spec|qa\b/i,                    label: '✅ בדיקות' },
  { rx: /doc|readme|markdown/i,               label: '📄 תיעוד' },
  { rx: /bot|whatsapp|wa\b/i,                 label: '🤖 בוט וואטסאפ' },
  { rx: /dashboard|sheet|profile|account/i,   label: '📊 דשבורד וגיליונות' },
  { rx: /.*/,                                  label: '🛠️ שונות' }, // catch-all
];

function bucketFor(subject) {
  for (var i = 0; i < BUCKETS.length; i++) {
    if (BUCKETS[i].rx.test(subject)) return BUCKETS[i].label;
  }
  return BUCKETS[BUCKETS.length - 1].label;
}

// ── עזר: שליפת קומיטים מ-GitHub ────────────────────────────────────
async function fetchCommits(sinceISO) {
  var url = 'https://api.github.com/repos/' + GITHUB_REPO + '/commits?per_page=100&since=' + encodeURIComponent(sinceISO);
  var headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'kesefle-cron' };
  // GitHub allows 60 unauthenticated requests/h per IP -- enough for 1 daily call.
  // אם יש GITHUB_TOKEN נשתמש בו לצורך מגבלות גבוהות יותר.
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = 'Bearer ' + process.env.GITHUB_TOKEN;
  var resp = await fetch(url, { headers: headers });
  if (!resp.ok) {
    var txt = await resp.text().catch(function () { return ''; });
    throw new Error('github_commits_failed status=' + resp.status + ' body=' + txt.slice(0, 200));
  }
  var arr = await resp.json();
  if (!Array.isArray(arr)) throw new Error('github_commits_unexpected_shape');
  return arr.map(function (c) {
    var subject = String(c.commit && c.commit.message ? c.commit.message.split('\n')[0] : '').trim();
    return { sha: c.sha.slice(0, 7), subject: subject, when: c.commit && c.commit.author && c.commit.author.date };
  });
}

// ── עזר: בניית גוף ההודעה בעברית ────────────────────────────────────
function buildDigest(commits, isFirstRun) {
  if (!commits.length) {
    return '☕ בוקר טוב סטיבן!\n\nאתמול לא בוצעו קומיטים חדשים ב-main.\nכל המערכת ממשיכה לעבוד כרגיל.\n\n— כספ\'לה';
  }
  // קיבוץ לפי קטגוריה
  var byBucket = {};
  commits.forEach(function (c) {
    var b = bucketFor(c.subject);
    if (!byBucket[b]) byBucket[b] = [];
    byBucket[b].push(c);
  });

  var header = isFirstRun
    ? '🚀 *תקציר התקדמות הפרויקט עד היום*\n\nשלום סטיבן! זו ההודעה הראשונה. הנה כל מה שהתבצע מאז תחילת הפרויקט:'
    : '☕ *בוקר טוב סטיבן!*\n\nהנה מה שהתבצע אתמול בפרויקט:';

  var sections = [];
  Object.keys(byBucket).forEach(function (b) {
    var lines = byBucket[b].slice(0, 8).map(function (c) {
      // ניסוח הסובג׳קט כך שיהיה קריא בעברית גם אם הוא באנגלית
      var s = c.subject.replace(/^(feat|fix|chore|docs|refactor|test|style|perf|build):\s*/i, '');
      // קיצור ל-90 תווים כדי לא להציף את ההודעה
      if (s.length > 90) s = s.slice(0, 87) + '…';
      return '  • ' + s + ' _(' + c.sha + ')_';
    });
    var more = byBucket[b].length > 8 ? '\n  + עוד ' + (byBucket[b].length - 8) + ' שינויים בקטגוריה הזו' : '';
    sections.push('*' + b + '*\n' + lines.join('\n') + more);
  });

  var footer =
    '\n📊 *סיכום:*\n' +
    '  • ' + commits.length + ' קומיטים\n' +
    '  • ' + Object.keys(byBucket).length + ' קטגוריות\n\n' +
    '📁 הקוד המלא: https://github.com/' + GITHUB_REPO +
    '\n\n— כספ\'לה';

  return header + '\n\n' + sections.join('\n\n') + footer;
}

// ── עזר: שליחה לוואטסאפ ────────────────────────────────────────────
async function sendWhatsApp(text) {
  var token = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;
  var phoneId = process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    throw new Error('whatsapp_not_configured: missing META_ACCESS_TOKEN or META_PHONE_NUMBER_ID');
  }
  var url = 'https://graph.facebook.com/v21.0/' + phoneId + '/messages';
  var resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: STEVEN_PHONE,
      type: 'text',
      text: { body: text },
    }),
  });
  if (!resp.ok) {
    var txt = await resp.text().catch(function () { return ''; });
    throw new Error('whatsapp_send_failed status=' + resp.status + ' body=' + txt.slice(0, 300));
  }
  var j = await resp.json().catch(function () { return null; });
  return j && j.messages && j.messages[0] ? j.messages[0].id : null;
}

// ── עזר: זיהוי ריצת cron אמיתית ────────────────────────────────────
function isAuthorizedCronCall(req) {
  // ריצת cron של Vercel שולחת את הטוקן המסוים הזה
  var cronAuth = req.headers['authorization'];
  if (cronAuth && process.env.CRON_SECRET && constantTimeEqual(cronAuth, 'Bearer ' + process.env.CRON_SECRET)) {
    return true;
  }
  // ריצה ידנית עם בוט סיקרט בפרמטר
  var adminParam = (req.query && req.query.admin) || (req.url && (function () {
    try { return new URL(req.url, 'http://x').searchParams.get('admin'); } catch { return null; }
  })());
  if (adminParam && process.env.KESEFLE_BOT_SECRET && constantTimeEqual(adminParam, process.env.KESEFLE_BOT_SECRET)) {
    return true;
  }
  return false;
}

// ── המסלול הראשי ────────────────────────────────────────────────────
async function handlerImpl(req, res) {
  if (!isAuthorizedCronCall(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // ?firstRun=1 שולח את כל ההיסטוריה (מאז PROJECT_START); אחרת רק 24 שעות אחרונות.
  var isFirstRun = String((req.query && req.query.firstRun) || '').match(/^(1|true|yes)$/i);
  var sinceISO;
  if (isFirstRun) {
    sinceISO = PROJECT_START;
  } else {
    sinceISO = new Date(Date.now() - HOURS_LOOKBACK * 60 * 60 * 1000).toISOString();
  }

  let commits;
  try {
    commits = await fetchCommits(sinceISO);
  } catch (e) {
    log.error('steven_digest.fetch_failed', { reqId: req.reqId, error: e.message });
    return res.status(502).json({ ok: false, error: 'github_fetch_failed', detail: e.message });
  }

  var body = buildDigest(commits, isFirstRun);

  // אם הודעת הטקסט ארוכה מ-4096 תווים (הגבול של WhatsApp), נחתוך
  if (body.length > 4000) {
    body = body.slice(0, 3900) + '\n\n…(הקטע נחתך מסיבות אורך — ראה את ההיסטוריה המלאה ב-GitHub)';
  }

  let msgId;
  try {
    msgId = await sendWhatsApp(body);
  } catch (e) {
    log.error('steven_digest.send_failed', { reqId: req.reqId, error: e.message });
    return res.status(502).json({ ok: false, error: 'whatsapp_send_failed', detail: e.message });
  }

  log.info('steven_digest.sent', { reqId: req.reqId, msgId: msgId, commitCount: commits.length, isFirstRun: !!isFirstRun });
  return res.status(200).json({ ok: true, msgId: msgId, commitCount: commits.length, isFirstRun: !!isFirstRun });
}

export default withRequestId(handlerImpl);
