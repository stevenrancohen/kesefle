// WhatsApp Business Cloud API webhook.
// Receives messages from Meta, finds the user by phone, parses, writes to their sheet.
//
// Env:
//   META_VERIFY_TOKEN  — arbitrary string Meta echoes back to confirm endpoint ownership
//   META_APP_SECRET    — for HMAC signature verification of incoming POSTs
//   META_PHONE_NUMBER_ID — the WhatsApp phone number ID (for sending replies)
//   META_ACCESS_TOKEN  — system user access token (for sending replies)
//   KV_REST_API_URL, KV_REST_API_TOKEN — for looking up user-by-phone
//
// IMPORTANT: This is the multi-tenant version. Each user's expenses go to THEIR sheet.

import crypto from 'node:crypto';
import { decryptRefreshToken } from '../../lib/crypto.js';
import { rateLimit } from '../../lib/ratelimit.js';
import { getGoogleClientId } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';

// CRITICAL: disable Vercel's default JSON body parser so we can capture the RAW request bytes
// for HMAC signature verification. Re-stringifying req.body with JSON.stringify will produce
// different bytes than Meta sent (key ordering, whitespace, escape sequences), failing verification.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = signatureHeader.slice('sha256='.length);
  const computed = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (expected.length !== computed.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(computed, 'hex'));
}

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  // Guard every step: a KV 5xx or non-JSON body must NOT throw an unhandled
  // rejection here (this is the Meta-facing path — a 500 makes Meta retry and
  // can disable the webhook). Degrade to null on any failure.
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j?.result ? JSON.parse(j.result) : null;
  } catch (_e) {
    return null;
  }
}

async function sendReply(toPhone, text) {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!phoneId || !token) {
    log.warn('wa.send_reply.env_missing', {});
    return;
  }
  try {
    await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'text',
        text: { body: text },
      }),
    });
  } catch (e) {
    log.error('wa.send_reply.failed', { error: e.message });
  }
}

async function handlerImpl(req, res) {
  // 1. Verification handshake (GET) — Meta calls this when you set up the webhook.
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ ok: false, error: 'verify token mismatch' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  // IP-based pre-HMAC rate limit. Anyone on the internet can hit this URL,
  // and even a request that fails signature verification still spends KV
  // bandwidth on opt-out / idempotency lookups downstream. 120 req/min per
  // IP is well above what Meta will ever deliver from a single edge and
  // cuts off any unauthenticated flood at the front door.
  const rl = await rateLimit(req, { key: 'wa_inbound_ip', limit: 120, windowSec: 60 });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter || 60));
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded' });
  }

  // 2. Read raw body bytes (bodyParser disabled at top of file) for HMAC verification.
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'body read failed' });
  }

  // HMAC verification. Fails closed: if META_APP_SECRET is not configured,
  // we refuse every POST. Previously, a missing secret silently bypassed
  // signature verification entirely — that meant anyone could POST a
  // crafted webhook payload and trigger the bot's reply/idempotency code
  // paths against fake messages. Matches the Stripe webhook's behaviour.
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    log.error('wa.webhook.app_secret_missing', { reqId: req.reqId });
    return res.status(503).json({ ok: false, error: 'webhook_secret_not_configured' });
  }
  const sig = req.headers['x-hub-signature-256'];
  if (!verifyMetaSignature(rawBody, sig, appSecret)) {
    return res.status(401).json({ ok: false, error: 'invalid signature' });
  }

  // 3. Parse the message
  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); }
  catch (e) { return res.status(400).json({ ok: false, error: 'invalid json' }); }
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];

  if (!message || message.type !== 'text') {
    return res.status(200).json({ ok: true, ignored: 'not a text message' });
  }

  const fromPhone = message.from;
  const messageId = message.id;
  const text = message.text?.body || '';

  // STOP/unsubscribe handler — must respond per Meta policy + Israeli direct-marketing law.
  // Hebrew: עצור / הסר / ביטול. English: STOP, UNSUBSCRIBE, CANCEL.
  const STOP_PATTERN = /^\s*(stop|unsubscribe|cancel|עצור|הסר|ביטול|בטל)\s*$/i;
  if (STOP_PATTERN.test(text)) {
    // Mark user as opted out (best-effort — non-fatal if KV down).
    const kvUrl2 = process.env.KV_REST_API_URL;
    const kvToken2 = process.env.KV_REST_API_TOKEN;
    if (kvUrl2 && kvToken2) {
      try {
        await fetch(`${kvUrl2}/set/${encodeURIComponent('optout:' + fromPhone)}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${kvToken2}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ts: new Date().toISOString(), reason: 'user_stop' }),
        });
      } catch (e) { /* non-fatal */ }
    }
    await sendReply(fromPhone, 'הוסרת מהבוט. לא נשלח לך עוד הודעות. להחזרה כתוב START.');
    return res.status(200).json({ ok: true, action: 'stopped' });
  }

  // Re-subscribe via START
  if (/^\s*start\s*$/i.test(text)) {
    const kvUrl3 = process.env.KV_REST_API_URL;
    const kvToken3 = process.env.KV_REST_API_TOKEN;
    if (kvUrl3 && kvToken3) {
      try {
        await fetch(`${kvUrl3}/del/${encodeURIComponent('optout:' + fromPhone)}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${kvToken3}` },
        });
      } catch (e) { /* non-fatal */ }
    }
    await sendReply(fromPhone, 'ברוך השב 👋 הבוט פעיל שוב. שלח הוצאה לדוגמה: "45 קפה".');
    return res.status(200).json({ ok: true, action: 'started' });
  }

  // If user previously opted out, don't process (Meta policy).
  const kvUrlCheck = process.env.KV_REST_API_URL;
  const kvTokenCheck = process.env.KV_REST_API_TOKEN;
  if (kvUrlCheck && kvTokenCheck) {
    try {
      const optoutRes = await fetch(`${kvUrlCheck}/get/${encodeURIComponent('optout:' + fromPhone)}`, {
        headers: { 'Authorization': `Bearer ${kvTokenCheck}` },
      });
      const optoutJson = await optoutRes.json();
      if (optoutJson?.result) {
        return res.status(200).json({ ok: true, ignored: 'opted_out' });
      }
    } catch (e) { /* non-fatal */ }
  }

  // Track last inbound timestamp (24h-window compliance — only send free-form replies within 24h of user message).
  if (kvUrlCheck && kvTokenCheck) {
    try {
      await fetch(`${kvUrlCheck}/set/${encodeURIComponent('last_inbound:' + fromPhone)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvTokenCheck}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts: Date.now(), id: messageId }),
      });
    } catch (e) { /* non-fatal */ }
  }

  // 4. Idempotency — skip if we've seen this message ID before
  const seenKey = `seen:wa:${messageId}`;
  if (await kvGet(seenKey)) {
    return res.status(200).json({ ok: true, ignored: 'duplicate' });
  }
  // Mark seen
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    if (kvUrl && kvToken) {
      await fetch(`${kvUrl}/set/${encodeURIComponent(seenKey)}?EX=86400`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts: Date.now() }),
      });
    }
  } catch (e) { /* non-fatal */ }

  // 5. Look up the user by phone number
  const userRecord = await kvGet(`phone:${fromPhone}`);
  if (!userRecord) {
    // Demo mode: anonymous "trial" so unregistered users can see what the bot does
    // without committing to onboarding. Trigger words: "דמו" / "demo" / "נסה" / "try".
    const DEMO_PATTERN = /^\s*(דמו|demo|נסה|try|התחל|start demo)\s*$/i;
    if (DEMO_PATTERN.test(text)) {
      await sendReply(fromPhone,
        'מצוין! 🎉 בוא ננסה ביחד.\n\n' +
        'שלח לי משהו כמו: "245 סופר"\n' +
        'או: "60 וולט"\n' +
        'או: "8500 משכורת"\n\n' +
        'אני אנתח את ההודעה ואראה לך איך הייתי שומר אותה לגיליון שלך. בלי לחבר חשבון. ' +
        'אחרי שתראה, כדי לשמור אמיתי — עבור ל-https://kesefle.com/account.');
      return res.status(200).json({ ok: true, demo: true });
    }
    // Primary warm welcome (≤2s reply)
    await sendReply(fromPhone,
      'היי! 👋 אני כספלה — בוט ההוצאות שלך בוואטסאפ.\n' +
      'אני לא מזהה את המספר הזה עדיין, אז בוא נתחיל יחד.\n\n' +
      '1️⃣ פתח: https://kesefle.com/account\n' +
      '2️⃣ התחבר עם Google\n' +
      '3️⃣ קשר את המספר הזה — לוקח 30 שניות\n\n' +
      'אחרי שנקשרים, תוכל לשלוח לי דברים כמו:\n' +
      '• "45 קפה"\n' +
      '• "230 סופר רמי לוי"\n' +
      '• "1200 שכר דירה"\n\n' +
      'ואני אכניס הכל לגיליון שלך אוטומטית. 📊');

    // 30s follow-up: nudge them to try demo mode if they're still around but haven't acted.
    // Idempotent: only send once per phone, ever (kfl_demo_nudge:phone flag in KV).
    if (kvUrlCheck && kvTokenCheck) {
      try {
        const nudgeKey = `kfl_demo_nudge:${fromPhone}`;
        const already = await kvGet(nudgeKey);
        if (!already) {
          // Schedule follow-up. Vercel functions can't sleep, so we mark intent
          // and rely on a separate cron — but for fast win, fire-and-forget with
          // setTimeout works on Vercel pro/edge. Since we may be on hobby tier,
          // we set a flag and let a cron handle it. Mark sent first to dedupe.
          await fetch(`${kvUrlCheck}/set/${encodeURIComponent(nudgeKey)}?EX=86400`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${kvTokenCheck}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: fromPhone, scheduledAt: Date.now() + 30000, sent: false }),
          });
          // Best-effort inline timer — works for keep-alive deployments; cron picks up otherwise.
          setTimeout(async () => {
            try {
              // Double-check the user didn't register in the meantime.
              const stillUnregistered = !(await kvGet(`phone:${fromPhone}`));
              if (!stillUnregistered) return;
              await sendReply(fromPhone,
                '💡 רוצה לנסות עכשיו? שלח "דמו" ואני אראה לך איך זה עובד מבלי לחבר את החשבון שלך.');
              await fetch(`${kvUrlCheck}/set/${encodeURIComponent(nudgeKey)}?EX=86400`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${kvTokenCheck}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: fromPhone, sent: true, sentAt: Date.now() }),
              });
            } catch (e) { /* non-fatal */ }
          }, 30000);
        }
      } catch (e) { /* non-fatal */ }
    }
    return res.status(200).json({ ok: true, unregistered: true });
  }

  // 6. Parse the expense / order / income
  //    (For now: stub — will call the shared parser library in the next iteration.)
  const parsed = parseMessage(text);
  if (!parsed.ok) {
    await sendReply(fromPhone, parsed.errorMsg || '😕 לא הבנתי. נסה: "245 סופר" או "60 אובר".');
    return res.status(200).json({ ok: true, parseError: parsed.errorMsg });
  }

  // 7. Write to the user's sheet using the user's stored Google access token
  //    (Phase 2 wiring — depends on /api/auth/google.js storing the refresh token.)
  const writeResult = await writeToUserSheet(userRecord, parsed, text, messageId);

  // 8. Reply
  if (writeResult.ok) {
    await sendReply(fromPhone, `✅ נרשם: ₪${parsed.amount} · ${parsed.category}`);
  } else {
    await sendReply(fromPhone, '⚠️ הוצאתי את ההודעה אבל לא הצלחתי לכתוב לגיליון. בודק…');
    log.error('wa.sheet_write.failed', { reqId: req.reqId, phone: fromPhone, error: writeResult.error, detail: writeResult.detail });
  }

  return res.status(200).json({ ok: true });
}

// Stub parser — real one ports from the Apps Script bot in Phase 2.
function parseMessage(text) {
  const t = String(text || '').trim();
  const amountMatch = t.match(/(\d+(?:[.,]\d+)?)/);
  if (!amountMatch) return { ok: false, errorMsg: 'לא מצאתי סכום בהודעה.' };
  const amount = parseFloat(amountMatch[1].replace(',', '.'));
  const rest = t.replace(amountMatch[0], '').trim();
  return {
    ok: true,
    amount,
    rawDescription: rest,
    category: rest || 'אחר',
    currency: 'ILS',
  };
}

// Production writer: calls Sheets API with the user's refresh token to append a transaction row.
//
// Sheet schema expected (matches the template):
//   A: timestamp (ISO) | B: amount | C: currency | D: type (income|expense) | E: category | F: subcategory | G: raw text | H: source (whatsapp|web) | I: message_id (idempotency)
//
// Retries the access-token refresh once on 401. Returns { ok, rowIndex } on success or { ok:false, error } on failure.
async function writeToUserSheet(userRecord, parsed, rawText, messageId) {
  if (!userRecord?.spreadsheetId) {
    return { ok: false, error: 'no_spreadsheet_id_in_user_record' };
  }
  // SECURITY: Read refresh token from encrypted envelope (AES-256-GCM, AAD-bound to userSub).
  // Legacy fallback: also check the old plaintext field for users provisioned before the
  // encryption rollout. New writes never store plaintext.
  let refreshToken = null;
  if (userRecord?.refreshTokenEnvelope) {
    try {
      refreshToken = decryptRefreshToken(userRecord.refreshTokenEnvelope, userRecord.userSub);
    } catch (e) {
      // log.error redacts userSub (matches /usersub/i in lib/log.js SECRET_KEY_PATTERNS),
      // so Vercel log retention won't see the raw Google sub. This replaces the
      // earlier console.error which bypassed the redactor — flagged H2 in
      // docs/SECURITY_PRIVACY_AUDIT_KESEFLE.md (2026-05-28) and re-confirmed in
      // docs/SECURITY_QA_RESWEEP_2026_05_29.md.
      log.error('wa.write_blocked_decrypt_failed', { userSub: userRecord.userSub, error: e.message });
      return { ok: false, error: 'refresh_token_decrypt_failed' };
    }
  } else if (userRecord?.refreshToken) {
    refreshToken = userRecord.refreshToken; // legacy
  } else {
    log.error('wa.write_blocked_no_refresh_token', { userSub: userRecord.userSub, spreadsheetId: userRecord.spreadsheetId });
    return { ok: false, error: 'no_refresh_token_relink_needed' };
  }

  let accessToken;
  try {
    accessToken = await exchangeRefreshForAccess(refreshToken);
  } catch (e) {
    console.error('access_token_refresh_failed', e.message);
    return { ok: false, error: 'token_refresh_failed', detail: e.message };
  }

  // CRITICAL FIX (RT3-F6): Sanitize cells to prevent formula injection.
  // If a user sends "99 =IMPORTXML(...)" the raw text would be evaluated as a formula
  // by Google Sheets when valueInputOption=USER_ENTERED. Prefix dangerous leading chars
  // with a tab+apostrophe ("'") which Sheets treats as a literal text marker.
  function sanitizeCell(v) {
    if (v == null) return '';
    if (typeof v === 'number') return v;
    const s = String(v);
    if (s.length === 0) return '';
    // Strip zero-width + bidi override chars that can hide injected formulas
    const cleaned = s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
    // Prefix if first non-space char is a formula trigger
    const firstNonSpace = cleaned.trimStart()[0];
    if (firstNonSpace === '=' || firstNonSpace === '+' || firstNonSpace === '-' || firstNonSpace === '@' || firstNonSpace === '\t') {
      return "'" + cleaned;
    }
    return cleaned;
  }

  const isoNow = new Date().toISOString();
  const isIncome = !!parsed.is_income;
  const row = [
    isoNow,                                            // A: timestamp
    typeof parsed.amount === 'number' ? parsed.amount : 0,  // B: amount (numeric only)
    sanitizeCell(parsed.currency || 'ILS'),            // C: currency
    sanitizeCell(isIncome ? 'income' : 'expense'),     // D: type
    sanitizeCell(parsed.category || 'אחר'),            // E: category
    sanitizeCell(parsed.subcategory || ''),            // F: subcategory
    sanitizeCell(rawText),                             // G: raw text
    'whatsapp',                                         // H: source (fixed enum, safe)
    sanitizeCell(messageId),                           // I: message_id
  ];

  // Append to the תנועות tab (range 'תנועות'!A:I) with INSERT_ROWS mode.
  // CRITICAL: valueInputOption=RAW (not USER_ENTERED) — RAW treats values as literals,
  // blocking formula injection. We pre-sanitized above as defense-in-depth.
  const range = encodeURIComponent("'תנועות'!A:I");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${userRecord.spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
    });
  } catch (e) {
    return { ok: false, error: 'sheets_api_unreachable', detail: e.message };
  }

  if (resp.status === 401) {
    // Refresh and retry once (re-derive a fresh access token from the same refresh token)
    try {
      accessToken = await exchangeRefreshForAccess(refreshToken, true);
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [row] }),
      });
    } catch (e) {
      return { ok: false, error: 'token_refresh_retry_failed', detail: e.message };
    }
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error('sheets_append_failed', resp.status, errText.slice(0, 300));
    return { ok: false, error: 'sheets_append_status_' + resp.status, detail: errText.slice(0, 200) };
  }

  const j = await resp.json().catch(() => ({}));
  return { ok: true, rowIndex: j?.updates?.updatedRange || null };
}

// Exchanges a Google OAuth refresh token for a fresh access token.
// Returns the access token string. Throws on failure.
async function exchangeRefreshForAccess(refreshToken /*, forceRefresh */) {
  const clientId = getGoogleClientId();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error('GOOGLE_CLIENT_SECRET env var missing');
  }
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    throw new Error('refresh_failed: ' + (j.error_description || j.error || r.status));
  }
  return j.access_token;
}


export default withRequestId(handlerImpl);
