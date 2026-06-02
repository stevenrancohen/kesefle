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
import { constantTimeEqual } from '../../lib/crypto.js';
import { rateLimit } from '../../lib/ratelimit.js';
import { withRequestId, log } from '../../lib/log.js';
import { buildExpenseRow, appendRowToUserSheet } from '../../lib/sheet-writer.js';

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
  //
  // 2026-05-31 audit fix (docs/AUDIT_WHATSAPP_WEBHOOK_2026_05_31.md F1 CRITICAL):
  // The previous strict-equality comparison failed OPEN when the verify-token
  // env var was unset (undefined equals undefined, returns true), letting an
  // attacker hijack webhook registration during any misconfig window. Mirrors
  // the POST path's fail-closed 503 for unset META_APP_SECRET below. Also
  // swapped strict-equality for constantTimeEqual to remove the timing leak.
  if (req.method === 'GET') {
    const expectedToken = process.env.META_VERIFY_TOKEN;
    if (!expectedToken) {
      // Fail closed if the secret isn't configured — refuse to confirm any
      // ownership claim until an operator sets the env var.
      return res.status(503).json({ ok: false, error: 'verify_token_not_configured' });
    }
    const mode = req.query['hub.mode'];
    // Reject anything other than the documented subscribe handshake BEFORE the
    // token compare so probers can't fingerprint the endpoint by mode value.
    if (mode !== 'subscribe') {
      return res.status(403).json({ ok: false, error: 'mode_not_supported' });
    }
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = req.query['hub.challenge'];
    if (constantTimeEqual(token, expectedToken)) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ ok: false, error: 'verify_token_mismatch' });
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

  // 7. Write to the user's sheet via the SHARED canonical writer
  //    (lib/sheet-writer.js buildExpenseRow + appendRowToUserSheet) — the same
  //    path /api/sheet/append uses. `userRecord` here is the phone:{E164}
  //    pointer; writeToUserSheet resolves it into the canonical sheet:{userSub}
  //    + the encrypted token from user:{userSub}.
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

// Production writer: appends one transaction row to the user's תנועות tab via
// the SHARED canonical writer in lib/sheet-writer.js (buildExpenseRow +
// appendRowToUserSheet) — the exact same path /api/sheet/append uses.
//
// 2026-06-01: this function previously hand-rolled its OWN row + Sheets call
// with a column layout that NO dashboard could read:
//   OLD (wrong): A=ts B=amount C=currency D=type E=category F=subcat G=raw H=src I=msgId
//   canonical:   A=ts B=YYYY-MM C=amount D=category E=subcat F=raw G=src H=status I=VAT
// The dashboards SUMIFS on C:C (amount) keyed by B:B (month) / D:D (category) /
// E:E (subcategory), so every row the old code wrote was invisible to the
// "מאזן אישי" / "מאזן חברה" dashboards (amount landed in B, the month column;
// "expense"/"income" landed in D where the dashboard expects "עסק"/category).
// It was also TOKENLESS: it read the refresh token off the phone:{E164} pointer
// record, which never carries one (the encrypted envelope lives only in
// user:{userSub}) — so even with Meta vars set the write failed immediately.
// This path is dead today (the POST handler fails closed on unset
// META_APP_SECRET above), but routing it through the canonical writer removes
// the wrong-column landmine and makes it correct if Meta is ever pointed here.
//
// `userRecord` is the phone:{E164} pointer (userSub + a cached sheet id). We
// resolve the canonical write target exactly like /api/sheet/append: the sheet
// from sheet:{userSub}, the encrypted token from user:{userSub}. Tenant
// isolation is load-bearing — we resolve phone -> userSub -> sheet:{sub} and
// abort (never write) if the phone-cached sheet disagrees with the canonical
// one. Returns { ok, rowIndex } or { ok:false, error }.
async function writeToUserSheet(userRecord, parsed, rawText, messageId) {
  const userSub = userRecord?.userSub;
  if (!userSub) {
    log.error('wa.write_blocked_no_user_sub', {});
    return { ok: false, error: 'incomplete_user_record' };
  }

  // Resolve canonical sheet (sheet:{userSub}) + token holder (user:{userSub}).
  const sheetRec = await kvGet(`sheet:${userSub}`);
  const userRec = (await kvGet(`user:${userSub}`)) || {};
  const canonicalSheetId = sheetRec?.spreadsheetId || null;
  const phoneSheetId = userRecord?.spreadsheetId || null;

  // Isolation leak-guard (same intent as /api/sheet/append): if the phone
  // record cached a sheet that disagrees with the canonical one, abort BEFORE
  // writing rather than risk a cross-tenant write.
  if (canonicalSheetId && phoneSheetId && canonicalSheetId !== phoneSheetId) {
    log.error('wa.sheet_ownership_mismatch', {
      userSub, phoneRecordSheet: phoneSheetId, canonicalSheet: canonicalSheetId,
    });
    return { ok: false, error: 'sheet_ownership_mismatch' };
  }
  const spreadsheetId = canonicalSheetId || phoneSheetId || userRec.spreadsheetId || null;
  if (!spreadsheetId) {
    log.error('wa.no_sheet_provisioned', { userSub });
    return { ok: false, error: 'no_spreadsheet_id_in_user_record' };
  }
  // The ENCRYPTED refresh token lives only in user:{userSub} (the phone pointer
  // is tokenless). Fail closed with a relink hint if it's missing.
  if (!userRec.refreshTokenEnvelope && !userRec.refreshToken) {
    log.error('wa.write_blocked_no_refresh_token', { userSub, spreadsheetId });
    return { ok: false, error: 'no_refresh_token_relink_needed' };
  }

  // Build the canonical 9-col row. buildExpenseRow puts the month key in B, the
  // amount (numeric) in C, the top category in D, the subcategory in E, and
  // sanitizes every string cell against formula injection internally — so the
  // local sanitizeCell helper this function used to carry is gone.
  const row = buildExpenseRow({
    amount: typeof parsed.amount === 'number' ? parsed.amount : Number(parsed.amount) || 0,
    isIncome: !!parsed.is_income,
    category: parsed.category,
    subcategory: parsed.subcategory,
    rawText,
  });

  // Hand the canonical row + resolved credentials to the shared writer. It
  // owns the AES-256-GCM decrypt, the OAuth exchange (capturing any rotated
  // refresh token), the RAW-mode append to 'תנועות'!A:I, the 401-refresh
  // retry, and the missing-tab self-heal.
  const writerRecord = {
    userSub,
    spreadsheetId,
    refreshTokenEnvelope: userRec.refreshTokenEnvelope || null,
    refreshToken: userRec.refreshToken || null,
  };
  const result = await appendRowToUserSheet({ userRecord: writerRecord, row });
  if (!result.ok) {
    // Preserve the named log events the webhook signature test asserts on and
    // operators grep for. appendRowToUserSheet already redacts internally; we
    // only surface the stable error code here (no spreadsheetId / Hebrew tab
    // name in the message).
    if (/token_refresh/.test(result.error || '')) {
      log.error('wa.access_token_refresh_failed', { userSub, error: result.error });
    } else {
      log.error('wa.sheets_append_failed', { userSub, error: result.error });
    }
    return result;
  }
  return result;
}

// NOTE: all refresh-for-access exchanges + the Sheets append now go through
// lib/sheet-writer.js (which delegates token exchange to lib/oauth.js). That
// keeps a SINGLE source of truth for the תנועות column order and the rotated-
// refresh-token capture (audit H1) — the webhook no longer hand-rolls either.

export default withRequestId(handlerImpl);
