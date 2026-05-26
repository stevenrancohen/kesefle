// lib/objectives.js
//
// PR-G2-mini of Smart Budget Goals (see docs/SMART_BUDGET_GOALS_DESIGN.md v2).
// An "objective" is the LONG-HORIZON goal a user names in plain language
// ("save 5000 for a trip in June") — distinct from "goal" (the monthly cap
// shipped in PR #72). One per user.
//
// PR-G2-mini ships JUST the data layer + bot commands. The reminder cron
// and onboarding-question integration follow in PR-G2-cron / PR-G2-onboarding
// once Steven answers Q6-Q10 from the design doc.
//
// KV layout:
//   objective:{userSub}  -> single JSON record (overwritten on re-issue)

const KV_URL = () => process.env.KV_REST_API_URL;
const KV_TOK = () => process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const url = KV_URL(); const tok = KV_TOK();
  if (!url || !tok) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.result) return null;
  try { return JSON.parse(j.result); } catch { return j.result; }
}
async function kvSet(key, value) {
  const url = KV_URL(); const tok = KV_TOK();
  if (!url || !tok) return false;
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}
async function kvDel(key) {
  const url = KV_URL(); const tok = KV_TOK();
  if (!url || !tok) return false;
  const r = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}` },
  });
  return r.ok;
}

function _key(userSub) { return 'objective:' + userSub; }

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const HORIZON_DAYS = { month: 30, six_months: 180, year: 365 };

function _horizonEnd(horizon, startMs) {
  const days = HORIZON_DAYS[horizon] || 30;
  return (startMs || Date.now()) + days * MS_PER_DAY;
}

// ── command parser ─────────────────────────────────────────────────────────
//
// Recognized Hebrew commands:
//   "יעד שלי"                   -> {action:'show'}
//   "השגתי יעד"                 -> {action:'achieve'}
//   "השתק יעד"                  -> {action:'mute'}
//   "שנה יעד <description>"     -> {action:'rename', description}
//   "יעד חדש"                   -> {action:'new'}        (starts the 2-step flow)
//   "יעד חדש <horizon> <desc>"  -> {action:'set', horizon, description}
//                                  where horizon in {חודש, חצי שנה, שנה}
//   "די" / "stop" / "אל תזכיר"  -> {action:'mute'}       (natural-language mute)

const HORIZON_WORDS = {
  'חודש': 'month',
  'חודשי': 'month',
  'לחודש': 'month',
  'הקרוב': 'month',
  'חצי שנה': 'six_months',
  'חצי-שנה': 'six_months',
  'חציון': 'six_months',
  'שנה': 'year',
  'שנתי': 'year',
  'לשנה': 'year',
};

export function parseObjectiveCommand(text) {
  if (!text || typeof text !== 'string') return { action: 'none' };
  const t = text.trim();

  if (/^יעד\s+שלי$/.test(t)) return { action: 'show' };
  if (/^השגתי\s+יעד$/.test(t)) return { action: 'achieve' };
  if (/^השתק\s+יעד$/.test(t)) return { action: 'mute' };
  if (/^(?:די|stop|אל\s+תזכיר(?:י)?)$/i.test(t)) return { action: 'mute' };

  const rename = t.match(/^שנה\s+יעד\s+(.+)$/);
  if (rename) {
    const desc = rename[1].trim().slice(0, 200);
    if (desc) return { action: 'rename', description: desc };
  }

  // "יעד חדש" alone → start the 2-step flow
  if (/^יעד\s+חדש$/.test(t)) return { action: 'new' };

  // "יעד חדש <horizon> <description>" — one-shot form
  const setForm = t.match(/^יעד\s+חדש\s+(.+)$/);
  if (setForm) {
    const tail = setForm[1].trim();
    // pull a horizon keyword off the front
    let horizon = null;
    let rest = tail;
    for (const word of Object.keys(HORIZON_WORDS).sort((a, b) => b.length - a.length)) {
      if (tail.startsWith(word + ' ') || tail === word) {
        horizon = HORIZON_WORDS[word];
        rest = tail.slice(word.length).trim();
        break;
      }
    }
    if (horizon && rest) {
      return { action: 'set', horizon, description: rest.slice(0, 200) };
    }
  }

  return { action: 'none' };
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function getObjective(userSub) {
  if (!userSub) return null;
  return await kvGet(_key(userSub));
}

export async function setObjective(userSub, { horizon, description }) {
  if (!userSub) throw new Error('userSub required');
  if (!HORIZON_DAYS[horizon]) throw new Error('horizon must be month/six_months/year');
  if (!description || typeof description !== 'string') {
    throw new Error('description required');
  }
  const now = Date.now();
  const obj = {
    userSub,
    horizon,
    horizonChosenAt: now,
    horizonEndsAt: _horizonEnd(horizon, now),
    description: String(description).slice(0, 200),
    createdAt: now,
    lastReminderAt: null,
    reminderCount: 0,
    muted: false,
    achieved: false,
  };
  const ok = await kvSet(_key(userSub), obj);
  if (!ok) throw new Error('kv_write_failed');
  return obj;
}

export async function renameObjective(userSub, description) {
  const o = await getObjective(userSub);
  if (!o) return null;
  o.description = String(description).slice(0, 200);
  await kvSet(_key(userSub), o);
  return o;
}

export async function muteObjective(userSub) {
  const o = await getObjective(userSub);
  if (!o) return null;
  o.muted = true;
  await kvSet(_key(userSub), o);
  return o;
}

export async function achieveObjective(userSub) {
  const o = await getObjective(userSub);
  if (!o) return null;
  o.achieved = true;
  o.achievedAt = Date.now();
  await kvSet(_key(userSub), o);
  return o;
}

export async function deleteObjective(userSub) {
  return await kvDel(_key(userSub));
}

// ── formatters (Hebrew, for bot replies) ───────────────────────────────────

export function formatObjective(o) {
  if (!o) {
    return '🎯 אין לך יעד פעיל.\n\nלקבוע יעד:\n• "יעד חדש" — מתחיל שיחה איתי\n• "יעד חדש חודש לחסוך 1000 לטיול" — בשורה אחת';
  }
  const horizonHe = { month: 'לחודש', six_months: 'לחצי שנה', year: 'לשנה הקרובה' };
  const daysLeft = Math.max(0, Math.round((o.horizonEndsAt - Date.now()) / MS_PER_DAY));
  const status = o.achieved ? '✅ הושג!' : (o.muted ? '🔕 מושתק' : '🔥 פעיל');
  return [
    '🎯 *היעד שלך* ' + (horizonHe[o.horizon] || ''),
    '',
    '"' + o.description + '"',
    '',
    'סטטוס: ' + status,
    o.achieved ? '' : ('נשארו: ' + daysLeft + ' ימים'),
    '',
    o.achieved
      ? '💡 רוצה יעד חדש? שלח "יעד חדש"'
      : (o.muted
        ? '💡 כדי לקבל תזכורות שוב, שלח "יעד חדש" (יחדש)'
        : '💡 "השגתי יעד" / "השתק יעד" / "שנה יעד <תיאור>"'),
  ].filter(Boolean).join('\n');
}

export function formatObjectiveCreated(o) {
  const horizonHe = { month: 'לחודש הקרוב', six_months: 'ל-6 חודשים', year: 'לשנה הקרובה' };
  return [
    '✅ יעד חדש נקבע ' + horizonHe[o.horizon] + ':',
    '',
    '"' + o.description + '"',
    '',
    '💡 אזכיר אותך מספר פעמים בשבוע כדי שלא תשכח (התראות יידלקו ב-PR הבא).',
    '   "יעד שלי" כדי לראות את הסטטוס בכל זמן.',
  ].join('\n');
}

export function formatHorizonPrompt() {
  return [
    '🎯 שאלה אחרונה — מה היעד הפיננסי שלך?',
    'נדלוק עליו ביחד.',
    '',
    '1️⃣ לחודש הקרוב   — קצר, ממוקד (חיסכון, לחתוך הוצאה, להגדיל הכנסה)',
    '2️⃣ ל-6 חודשים   — בינוני (סגירת חוב, קרן חירום, הקמת עסק)',
    '3️⃣ לשנה הקרובה  — גדול (משכנתא, השקעה, מטרת חיים)',
    '4️⃣ אין לי יעד   — נדבר בהמשך',
    '',
    'ענה במספר 1/2/3/4 (או "יעד חדש חודש לחסוך 1000" בשורה אחת).',
  ].join('\n');
}
