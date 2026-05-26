// /api/profile
//
// Per-user personalization profile, captured by the bot's onboarding
// questionnaire ("שאלון התאמה אישית"). Drives: default/highlighted categories,
// the recurring-expense autoLog default, which sheet template to favour, and
// what the weekly digest emphasises.
//
// KV: profile:<phone> = { trackingType, hasRecurring, autoLogPref, taxId, companyName, profession, paymentDefault, updatedAt }
//   trackingType  : 'personal' | 'family' | 'group' | 'business'
//   hasRecurring  : boolean
//   autoLogPref   : 'auto' | 'remind'
//   profession    : profession id from lib/professions.js (e.g. 'general_contractor',
//                   'taxi_driver', 'cashier'). Optional; '' / null to clear.
//   taxId        : 9-digit Israeli ת.ז. / ח.פ. (string, digits-only). Optional.
//                  Used by lib/invoice.js when issuing a חשבונית מס to a
//                  business customer that wants the VAT receipt to carry
//                  their tax id for input-VAT deduction.
//   companyName  : free-text שם חברה לחשבונית. Optional. When set, the
//                  invoice client name uses this instead of the human name.
//
// POST (JSON, bot-secret via x-kesefle-bot-secret header or body.botSecret):
//   { action:'set', phone, fields:{ trackingType?, hasRecurring?, autoLogPref?, taxId?, companyName?, profession?, paymentDefault? } } → { ok, profile }
//   { action:'get', phone } → { ok, profile }

import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { constantTimeEqual } from '../lib/crypto.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}
async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}
function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  if (s.startsWith('0')) s = '972' + s.slice(1);
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

const TRACKING_TYPES = ['personal', 'family', 'group', 'business'];
const AUTOLOG_PREFS = ['auto', 'remind'];

async function handlerImpl(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const got = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  if (!constantTimeEqual(got, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const phone = normalizeE164(body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
  const action = String(body?.action || '').toLowerCase();

  if (action === 'get') {
    const profile = (await kvGet('profile:' + phone)) || {};
    return res.status(200).json({ ok: true, profile });
  }

  if (action === 'set') {
    const fields = (body && typeof body.fields === 'object' && body.fields) || {};
    const profile = (await kvGet('profile:' + phone)) || {};
    if (fields.trackingType != null) {
      const t = String(fields.trackingType).toLowerCase();
      if (!TRACKING_TYPES.includes(t)) return res.status(400).json({ ok: false, error: 'invalid_trackingType', allowed: TRACKING_TYPES });
      profile.trackingType = t;
    }
    if (fields.autoLogPref != null) {
      const a = String(fields.autoLogPref).toLowerCase();
      if (!AUTOLOG_PREFS.includes(a)) return res.status(400).json({ ok: false, error: 'invalid_autoLogPref', allowed: AUTOLOG_PREFS });
      profile.autoLogPref = a;
    }
    if (fields.hasRecurring != null) profile.hasRecurring = !!fields.hasRecurring;
    // Optional VAT-invoice fields (used by lib/invoice.js). We accept null /
    // '' to allow CLEARING the field (e.g. customer no longer wants their
    // company name on the invoice).
    if (fields.taxId !== undefined) {
      if (fields.taxId == null || fields.taxId === '') {
        delete profile.taxId;
      } else {
        const digits = String(fields.taxId).replace(/\D+/g, '');
        // Israeli ת.ז. is 9 digits; ח.פ. is 9 digits. Accept 7-12 to be
        // permissive (foreign vendors / older numbers / leading zeros).
        if (digits.length < 7 || digits.length > 12) {
          return res.status(400).json({ ok: false, error: 'invalid_taxId' });
        }
        profile.taxId = digits;
      }
    }
    if (fields.companyName !== undefined) {
      if (fields.companyName == null || fields.companyName === '') {
        delete profile.companyName;
      } else {
        profile.companyName = String(fields.companyName).slice(0, 120);
      }
    }
    // Profession. Steven 2026-05-26: onboarding Q4 asks the user what
    // they do for a living. The id matches one of the 119 entries in
    // lib/professions.js. Used by lib/profession-template.js to seed
    // profession-tailored categories + by the LLM classifier to weight
    // domain-specific keywords. We don't validate against the catalog
    // here because that would force this endpoint to import the
    // catalog (adding ~80 KB to cold-start). Bot side validates
    // before calling us. Accepts: known id string OR '' / null to clear.
    if (fields.profession !== undefined) {
      if (fields.profession == null || fields.profession === '') {
        delete profile.profession;
      } else {
        // Allow snake_case ASCII ids up to 64 chars; ignore anything weird.
        const pid = String(fields.profession).trim().toLowerCase();
        if (!/^[a-z0-9_]{1,64}$/.test(pid)) {
          return res.status(400).json({ ok: false, error: 'invalid_profession' });
        }
        profile.profession = pid;
      }
    }

    // Payment-method default. Steven 2026-05-25: bot detects "ביט/מזומן/
    // אשראי" in expense text; if none mentioned + paymentDefault set, it
    // stamps the row with the default. Accepts:
    //   'credit' | 'cash' | 'bit' | 'transfer' | '' (clear) | null (clear)
    if (fields.paymentDefault !== undefined) {
      if (fields.paymentDefault == null || fields.paymentDefault === '') {
        delete profile.paymentDefault;
      } else {
        const pm = String(fields.paymentDefault).toLowerCase().trim();
        const ALLOWED_PM = ['credit', 'cash', 'bit', 'transfer'];
        if (!ALLOWED_PM.includes(pm)) {
          return res.status(400).json({ ok: false, error: 'invalid_paymentDefault', allowed: ALLOWED_PM });
        }
        profile.paymentDefault = pm;
      }
    }
    profile.updatedAt = new Date().toISOString();
    await kvSet('profile:' + phone, profile);
    log.info('profile.set', { reqId: req.reqId, trackingType: profile.trackingType, autoLogPref: profile.autoLogPref, hasTaxId: !!profile.taxId, hasCompanyName: !!profile.companyName, profession: profile.profession || null });
    return res.status(200).json({ ok: true, profile });
  }

  return res.status(400).json({ ok: false, error: 'unknown_action', allowed: ['set', 'get'] });
}

export default withRequestId(
  withRateLimit({ key: 'profile', limit: 60, windowSec: 60 })(handlerImpl)
);
