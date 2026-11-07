// /api/ui-preferences
//
// Cross-device UI preferences for the mobile app. These values only control
// presentation (persona + active money space); they never mutate the ledger or
// the sheet template. When no explicit preference exists, we infer the persona
// from the phone onboarding profile so existing users get a useful first view.

import { requireAuth } from '../lib/auth.js';
import { withRequestId } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const PERSONAS = ['single', 'employee', 'couple', 'family', 'freelancer', 'business', 'mixed'];
const SPACES = ['personal', 'household', 'business'];

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch (_) {
    return null;
  }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    return r.ok;
  } catch (_) {
    return false;
  }
}

function inferPersona(profileType, trackingType) {
  const p = String(profileType || '').toLowerCase();
  if (PERSONAS.includes(p)) return p;
  if (p === 'basic_personal' || p === 'advanced_imported' || p === 'divorced') return 'single';
  if (p === 'contractor') return 'freelancer';
  const t = String(trackingType || '').toLowerCase();
  if (t === 'family' || t === 'group') return 'family';
  if (t === 'business') return 'business';
  return 'single';
}

function defaultSpace(persona) {
  if (persona === 'couple' || persona === 'family') return 'household';
  if (persona === 'freelancer' || persona === 'business') return 'business';
  return 'personal';
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const userSub = req.user.sub;
  const saved = (await kvGet(`ui:${userSub}`)) || {};

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = {}; }
    }
    const next = { ...saved };
    if (body?.persona != null) {
      const persona = String(body.persona).toLowerCase();
      if (!PERSONAS.includes(persona)) {
        return res.status(400).json({ ok: false, error: 'invalid_persona', allowed: PERSONAS });
      }
      next.persona = persona;
    }
    if (body?.activeSpace != null) {
      const activeSpace = String(body.activeSpace).toLowerCase();
      if (!SPACES.includes(activeSpace)) {
        return res.status(400).json({ ok: false, error: 'invalid_active_space', allowed: SPACES });
      }
      next.activeSpace = activeSpace;
    }
    next.updatedAt = new Date().toISOString();
    const stored = await kvSet(`ui:${userSub}`, next);
    if (!stored) return res.status(503).json({ ok: false, error: 'preferences_unavailable' });
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ ok: true, preferences: next });
  }

  const user = await kvGet(`user:${userSub}`);
  const rawPhone = user?.linkedPhone || user?.phone || '';
  const phone = String(rawPhone).replace(/\D+/g, '');
  const onboarding = phone ? ((await kvGet(`profile:${phone}`)) || {}) : {};
  const persona = PERSONAS.includes(saved.persona)
    ? saved.persona
    : inferPersona(onboarding.profileType, onboarding.trackingType);
  const activeSpace = SPACES.includes(saved.activeSpace) ? saved.activeSpace : defaultSpace(persona);

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({
    ok: true,
    preferences: { persona, activeSpace },
    onboarding: {
      profileType: onboarding.profileType || null,
      trackingType: onboarding.trackingType || null,
      companyName: onboarding.companyName || null,
    },
  });
}

export default withRequestId(
  withRateLimit({ key: 'ui_preferences', limit: 60, windowSec: 60 })(requireAuth(handlerImpl))
);
