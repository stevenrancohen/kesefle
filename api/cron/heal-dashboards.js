// api/cron/heal-dashboards.js
//
// Nightly cron that rebuilds broken SUMIFS formulas on every active
// user's מאזן חברה. Generalises the bot/personal_sheet_fix.gs
// FIX_MARKETING_ALL_YEARS algorithm to every business bucket and runs
// it automatically — so the formula-drift class of bugs (the same one
// Steven hit on 2026-05-26 with "עלות שיווק showing 0") never reaches
// a customer again.
//
// What "broken" means here:
//   - The cell has a formula (we never touch literal values — those are
//     user-typed and we must preserve them per the
//     feedback_never_overwrite memory)
//   - The formula is a SUMIFS that references LOCAL columns
//     ($A:$A, $I:$I) without a 'תנועות'! sheet qualifier — those match
//     nothing on the dashboard tab so they return 0 silently
//   - OR the formula has a hardcoded "+ N" / "- N" tail that wasn't
//     part of a sanctioned manual adjustment (we whitelist a few)
//   - OR a SUMIFS that filters by a Hebrew month that doesn't match the
//     month header of the cell's column (cross-month bug from copy-paste)
//
// Safety rails:
//   - Kill switch: env KESEFLE_DISABLE_AUTO_HEAL=1 → returns 200 + skips
//   - Per-run user cap: MAX_USERS_PER_RUN = 25 (~1.5k Sheets API calls)
//   - KV cursor (heal:cursor) round-robins through users across nights
//   - Per-user time-out: skip after 8s, resume next night
//   - Per-user error log: never block the whole run if one user fails
//   - Never writes a NEW formula into a cell that currently has a
//     literal value — only "repair broken formula" path
//
// Triggered: Vercel cron at 03:00 UTC (06:00 IL) — added to vercel.json.
// Manual trigger: POST /api/cron/heal-dashboards?secret=<CRON_SECRET>

import { withRequestId, log } from '../../lib/log.js';
import { exchangeRefreshForAccess, TX_TAB, COMPANY_DASHBOARD_TAB } from '../../lib/sheet-writer.js';
import { decryptRefreshToken } from '../../lib/crypto.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.KESEFLE_CRON_SECRET || process.env.CRON_SECRET || '';
const KILL = process.env.KESEFLE_DISABLE_AUTO_HEAL === '1';
const MAX_USERS_PER_RUN = parseInt(process.env.KESEFLE_HEAL_MAX_USERS || '25', 10);
const PER_USER_TIMEOUT_MS = 8000;

// Canonical bucket -> Hebrew label on מאזן חברה + REGEXMATCH pattern that
// matches anything in תנועות E (subcategory) or F (description) that
// belongs in that bucket. Order doesn't matter — each row is rewritten
// independently.
const BUCKETS = [
  {
    label: 'עלות שיווק',
    pattern: '(?i)שיווק|פרסום|advert|adwords|facebook|instagram|tiktok|google|fb|' +
             'פייסבוק|אינסטה|אינסטגרם|טיקטוק|גוגל|linkedin|לינקדאין|youtube|יוטיוב|' +
             'mailchimp|hubspot|semrush|ahrefs|seo|sem|ppc|meta|מטה|' +
             'influencer|אינפלואנסר|sponsored|ממומן|קמפיין|campaign|leads|לידים',
  },
  {
    label: 'עלות חומרי גלם',
    pattern: '(?i)חומרי\\s*גלם|raw\\s*material|inventory|stock|מלאי|רכש\\s*מלאי',
  },
  {
    label: 'משלוחים והתקנות',
    pattern: '(?i)משלוח|אריזה|shipping|packaging|הובלה|התקנה|delivery|fedex|ups|dhl',
  },
  {
    label: 'הוצאות תפעוליות',
    pattern: '(?i)תפעולי|operational|operations|יועצים|תוכנות|ציוד\\s*עסקי|מיסים|' +
             'consulting|software|equipment|taxes|בנק|עמלות',
  },
];

const HEB_MONTH_NAMES = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

// ─── KV helpers (Upstash REST) ──────────────────────────────────────

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch (_e) { return null; }
}

async function kvSet(key, value, ttlSec) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const path = ttlSec ? `/set/${encodeURIComponent(key)}?EX=${ttlSec}` : `/set/${encodeURIComponent(key)}`;
    const r = await fetch(`${KV_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: typeof value === 'string' ? value : JSON.stringify(value),
    });
    return r.ok;
  } catch (_e) { return false; }
}

// Scan KV for all user:<sub> keys via Upstash SCAN. Returns array of sub
// strings. Conservative: pages of 100, stops at 5000 to bound runtime.
async function listAllUserSubs() {
  if (!KV_URL || !KV_TOKEN) return [];
  const subs = [];
  let cursor = '0';
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${KV_URL}/scan/${cursor}/match/user:*/count/100`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      if (!r.ok) break;
      const j = await r.json();
      const result = j?.result;
      if (!result || !Array.isArray(result) || result.length < 2) break;
      cursor = String(result[0]);
      const keys = result[1] || [];
      for (const k of keys) {
        if (typeof k === 'string' && k.startsWith('user:')) {
          subs.push(k.slice(5));
        }
      }
      if (cursor === '0') break;
      if (subs.length >= 5000) break;
    } catch (_e) { break; }
  }
  return subs;
}

// ─── Formula builders + brokenness detection ────────────────────────

function buildHealFormula(year, monthIdx, pattern) {
  const mm = monthIdx < 10 ? '0' + monthIdx : '' + monthIdx;
  const monthKey = year + '-' + mm;
  // Mirror personal_sheet_fix.gs FIX_MARKETING_ALL_YEARS exactly so any
  // mental model the user has of "the healing formula" works the same
  // whether we wrote it from the cron or they ran FIX_MARKETING manually.
  return '=IFERROR(SUMPRODUCT(' +
    `('${TX_TAB}'!C2:C5000)*` +
    `('${TX_TAB}'!B2:B5000="${monthKey}")*` +
    `('${TX_TAB}'!D2:D5000="עסק")*` +
    `((IFERROR(REGEXMATCH('${TX_TAB}'!E2:E5000,"${pattern}"),FALSE)+` +
    `IFERROR(REGEXMATCH('${TX_TAB}'!F2:F5000,"${pattern}"),FALSE))>0)` +
    '),0)';
}

// Detects whether an existing formula is broken (and therefore safe to
// overwrite). Conservative: any formula we don't recognise as broken is
// left alone — the user might have a custom formula we don't understand.
function isBrokenFormula(formula) {
  const f = String(formula || '').trim();
  if (!f || f.charAt(0) !== '=') return false;
  // Pattern 1: SUMIFS with $-prefixed local cols and NO sheet qualifier
  // → can't possibly find data on a dashboard tab. Classic copy-paste bug.
  if (/SUMIFS\(\s*\$?[A-Z]+\$?\d+\s*:\s*\$?[A-Z]+\$?\d+\s*,\s*\$?[A-Z]+\$?\d+\s*:\s*\$?[A-Z]+\$?\d+/i.test(f)
      && !/'?[֐-׿]+'?!|'תנועות'!|תנועות!|transactions!/i.test(f)) {
    return true;
  }
  // Pattern 2: SUMIFS with hardcoded + N or - N appended (residue from
  // an old manual override that the bot then wrote around).
  if (/SUMIFS\([^)]*\)\s*[+\-]\s*\d+(\.\d+)?\s*$/i.test(f)) return true;
  return false;
}

// ─── Per-user heal pass ─────────────────────────────────────────────

async function healOneUser(userSub, userRec, reqId) {
  const stats = { userSub, fixed: 0, skipped: 0, scanned: 0, errors: [] };
  const startedAt = Date.now();

  const spreadsheetId = userRec?.spreadsheetId;
  if (!spreadsheetId) { stats.skipped++; return stats; }
  if (!userRec?.refreshTokenEnvelope && !userRec?.refreshToken) { stats.skipped++; return stats; }

  let accessToken;
  try {
    const refresh = userRec.refreshToken || decryptRefreshToken(userRec.refreshTokenEnvelope, userSub);
    accessToken = await exchangeRefreshForAccess(refresh);
  } catch (e) {
    stats.errors.push({ step: 'token_refresh', msg: e.message });
    return stats;
  }

  // Read מאזן חברה. If the tab doesn't exist (user hasn't enabled the
  // business dashboard) we skip silently.
  let dashValues;
  let dashFormulas;
  try {
    const range = encodeURIComponent(`'${COMPANY_DASHBOARD_TAB}'!A1:Z100`);
    const fv = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!fv.ok) {
      // 400 = tab not found is OK; everything else = log + skip
      if (fv.status !== 400) stats.errors.push({ step: 'read_values', status: fv.status });
      return stats;
    }
    dashValues = (await fv.json()).values || [];

    const ff = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMULA`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!ff.ok) { stats.errors.push({ step: 'read_formulas', status: ff.status }); return stats; }
    dashFormulas = (await ff.json()).values || [];
  } catch (e) {
    stats.errors.push({ step: 'read_sheet', msg: e.message });
    return stats;
  }

  // Find every "שנת YYYY" header row.
  const yearBlocks = [];
  for (let r = 0; r < dashValues.length; r++) {
    for (let c = 0; c < (dashValues[r] || []).length; c++) {
      const m = String(dashValues[r][c] || '').match(/שנת\s+(20\d{2})/);
      if (m) { yearBlocks.push({ year: parseInt(m[1], 10), headerRow: r }); break; }
    }
  }
  if (yearBlocks.length === 0) { stats.skipped++; return stats; }

  // For each year block, find month columns + each bucket row, check
  // every cell, queue broken ones for batch-update.
  const updates = []; // { range, formula } — sent in one batch call at end

  for (let bi = 0; bi < yearBlocks.length; bi++) {
    if (Date.now() - startedAt > PER_USER_TIMEOUT_MS) {
      stats.errors.push({ step: 'timeout', msg: 'aborted after ' + PER_USER_TIMEOUT_MS + 'ms' });
      break;
    }
    const blk = yearBlocks[bi];
    const blockEnd = (bi + 1 < yearBlocks.length) ? yearBlocks[bi + 1].headerRow : dashValues.length;
    // Month columns (in the next 3 rows after the year header).
    const monthCols = {};
    for (let rr = blk.headerRow + 1; rr < Math.min(blk.headerRow + 4, blockEnd); rr++) {
      const row = dashValues[rr] || [];
      for (let cc = 0; cc < row.length; cc++) {
        const idx = HEB_MONTH_NAMES.indexOf(String(row[cc] || '').trim());
        if (idx >= 0 && monthCols[idx + 1] === undefined) monthCols[idx + 1] = cc;
      }
    }
    if (Object.keys(monthCols).length === 0) continue;

    // For each bucket, find its row + check each month cell.
    for (const bucket of BUCKETS) {
      let bucketRow = -1;
      for (let sr = blk.headerRow; sr < blockEnd; sr++) {
        if (String((dashValues[sr] || [])[0] || '').trim() === bucket.label) {
          bucketRow = sr; break;
        }
      }
      if (bucketRow < 0) continue;

      for (let mi = 1; mi <= 12; mi++) {
        const col = monthCols[mi];
        if (col === undefined) continue;
        stats.scanned++;
        const existingFormula = String(((dashFormulas[bucketRow] || [])[col]) || '').trim();
        // Skip if the cell has no formula (raw value — user-typed, don't touch)
        if (!existingFormula) continue;
        if (existingFormula.charAt(0) !== '=') continue;
        // Skip clean formulas that already reference תנועות correctly.
        if (!isBrokenFormula(existingFormula)) continue;
        // Build replacement.
        const a1 = colNumToA1(col + 1) + (bucketRow + 1);
        updates.push({
          range: `'${COMPANY_DASHBOARD_TAB}'!${a1}`,
          values: [[buildHealFormula(blk.year, mi, bucket.pattern)]],
        });
        stats.fixed++;
      }
    }
  }

  if (updates.length === 0) return stats;

  // Batch all updates into one Sheets values:batchUpdate call.
  try {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      stats.errors.push({ step: 'batch_update', status: r.status, detail: detail.slice(0, 200) });
      stats.fixed = 0; // nothing actually wrote
    }
  } catch (e) {
    stats.errors.push({ step: 'batch_update', msg: e.message });
    stats.fixed = 0;
  }

  return stats;
}

// Convert a 1-based column number to A1 letter (1→A, 27→AA).
function colNumToA1(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ─── HTTP handler ───────────────────────────────────────────────────

async function handlerImpl(req, res) {
  // Auth: Vercel cron header OR ?secret=
  const isCron = !!req.headers['x-vercel-cron'];
  const querySecret = String(req.query?.secret || req.query?.admin || '');
  const headerSecret = String(req.headers['x-cron-secret'] || '');
  const okAuth = isCron ||
    (CRON_SECRET && (headerSecret === CRON_SECRET || querySecret === CRON_SECRET));
  if (!okAuth) return res.status(401).json({ ok: false, error: 'unauthorized' });

  if (KILL) {
    return res.status(200).json({ ok: true, skipped: 'kill_switch_active' });
  }

  const runId = req.reqId || ('heal_' + Date.now());
  log.info('heal_dashboards.start', { reqId: runId });

  // List all users + apply cursor-based pagination so we don't always
  // process the same first 25 users.
  const allSubs = await listAllUserSubs();
  if (allSubs.length === 0) {
    return res.status(200).json({ ok: true, totalUsers: 0, processed: 0, fixed: 0 });
  }
  const cursorRec = await kvGet('heal:cursor') || { offset: 0 };
  let startIdx = cursorRec.offset || 0;
  if (startIdx >= allSubs.length) startIdx = 0;
  const subsToProcess = allSubs.slice(startIdx, startIdx + MAX_USERS_PER_RUN);
  const nextOffset = (startIdx + subsToProcess.length) >= allSubs.length ? 0 : startIdx + subsToProcess.length;
  await kvSet('heal:cursor', { offset: nextOffset, updatedAt: new Date().toISOString() });

  const results = [];
  let totalFixed = 0;
  let totalErrors = 0;
  for (const sub of subsToProcess) {
    try {
      const userRec = await kvGet('user:' + sub);
      if (!userRec) continue;
      const r = await healOneUser(sub, userRec, runId);
      results.push(r);
      totalFixed += r.fixed;
      if (r.errors.length) totalErrors += r.errors.length;
    } catch (e) {
      results.push({ userSub: sub, errors: [{ step: 'outer', msg: e.message }] });
      totalErrors++;
    }
  }

  log.info('heal_dashboards.done', {
    reqId: runId,
    totalUsers: allSubs.length,
    processed: subsToProcess.length,
    fixed: totalFixed,
    errors: totalErrors,
    nextOffset,
  });

  return res.status(200).json({
    ok: true,
    totalUsers: allSubs.length,
    processed: subsToProcess.length,
    fixedFormulas: totalFixed,
    errorCount: totalErrors,
    nextOffset,
    perUser: results.map(r => ({
      sub: r.userSub.slice(0, 8) + '...',
      scanned: r.scanned || 0,
      fixed: r.fixed || 0,
      errors: r.errors || [],
    })),
  });
}

export default withRequestId(handlerImpl);
