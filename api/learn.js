// /api/learn
//
// Cross-user anonymous category knowledge base. When ANY user corrects a
// categorization, the bot records it here keyed by a SHA-256 hash of the
// NORMALIZED description (the raw text never leaves the bot — only the hash),
// so every other user who types the same description gets the right category
// instantly, without an LLM call. Privacy-safe + makes the whole userbase
// smarter together.
//
// Bot-only (KESEFLE_BOT_SECRET). The bot computes the hash with Apps Script's
// Utilities.computeDigest(SHA_256) over the same normalization it uses locally.
//
//   POST { hash, category, subcategory?, botSecret }  → record a correction (count++)
//   GET  ?h=<hash>  (x-kesefle-bot-secret header)      → { ok, found, category, subcategory, count }
//
// KV: global_learn:<hash> = { category, subcategory, count, updatedAt }

import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { constantTimeEqual } from '../lib/crypto.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Valid top-level categories (defense: never store a junk category globally).
const VALID_CATS = new Set([
  'הכנסות', 'אוכל', 'תחבורה', 'הוצאות קבועות', 'הוצאות זמניות', 'קניות',
  'בריאות', 'עסק', 'שירותים', 'בידור', 'חינוך', 'ילדים',
  'ממשלה ומיסים', 'פיננסים', 'אחר',
]);

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}
async function kvSet(key, val) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(val),
    });
    return r.ok;
  } catch { return false; }
}

const HASH_RE = /^[a-f0-9]{16,64}$/i;

async function handlerImpl(req, res) {
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });

  // ── GET: look up a learned category by hash ──────────────────────────────
  if (req.method === 'GET') {
    const got = req.headers['x-kesefle-bot-secret'] || req.query.botSecret;
    if (!constantTimeEqual(got, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const h = String(req.query.h || '').trim().toLowerCase();
    if (!HASH_RE.test(h)) return res.status(400).json({ ok: false, error: 'invalid_hash' });
    const rec = await kvGet('global_learn:' + h);
    if (!rec || !rec.category) return res.status(200).json({ ok: true, found: false });
    return res.status(200).json({ ok: true, found: true, category: rec.category, subcategory: rec.subcategory || '', count: rec.count || 1 });
  }

  // ── POST: record a correction ────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const got = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
    if (!constantTimeEqual(got, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const h = String(body?.hash || '').trim().toLowerCase();
    if (!HASH_RE.test(h)) return res.status(400).json({ ok: false, error: 'invalid_hash' });
    const category = String(body?.category || '').trim();
    const subcategory = String(body?.subcategory || '').trim().slice(0, 60);
    if (!VALID_CATS.has(category)) return res.status(400).json({ ok: false, error: 'invalid_category' });

    const prev = await kvGet('global_learn:' + h);
    const count = (prev && Number(prev.count)) ? prev.count + 1 : 1;
    // If two users disagree on the same hash, the latest correction wins but we
    // keep the count so a future consensus rule can be added.
    const ok = await kvSet('global_learn:' + h, { category, subcategory, count, updatedAt: new Date().toISOString() });
    if (!ok) return res.status(502).json({ ok: false, error: 'kv_write_failed' });
    log.info('learn.recorded', { reqId: req.reqId, count });
    return res.status(200).json({ ok: true, count });
  }

  return res.status(405).json({ ok: false, error: 'method_not_allowed', allowed: ['GET', 'POST'] });
}

export default withRequestId(
  withRateLimit({ key: 'learn', limit: 120, windowSec: 60 })(handlerImpl)
);
