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
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

async function sendReply(toPhone, text) {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!phoneId || !token) {
    console.warn('cannot send reply — META env vars missing');
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
    console.error('reply send failed', e);
  }
}

export default async function handler(req, res) {
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

  // 2. Verify HMAC signature (security)
  const appSecret = process.env.META_APP_SECRET;
  if (appSecret) {
    const rawBody = JSON.stringify(req.body);
    const sig = req.headers['x-hub-signature-256'];
    if (!verifyMetaSignature(rawBody, sig, appSecret)) {
      return res.status(401).json({ ok: false, error: 'invalid signature' });
    }
  }

  // 3. Parse the message
  const body = req.body;
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];

  if (!message || message.type !== 'text') {
    return res.status(200).json({ ok: true, ignored: 'not a text message' });
  }

  const fromPhone = message.from;
  const messageId = message.id;
  const text = message.text?.body || '';

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
    await sendReply(fromPhone,
      'שלום! 👋\nלא מצאתי חשבון מקושר למספר הזה.\nכדי להתחיל, היכנס ל-https://kesefle.app וחבר את הוואטסאפ שלך.');
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
    console.error('sheet write failed', writeResult);
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

// Stub writer — Phase 2 will call Google Sheets API with userRecord.refreshToken.
async function writeToUserSheet(userRecord, parsed, rawText, messageId) {
  console.log('WOULD_WRITE', JSON.stringify({
    spreadsheetId: userRecord.spreadsheetId,
    amount: parsed.amount,
    category: parsed.category,
    rawText,
    messageId,
  }));
  return { ok: true, stubbed: true };
}
