// ============================================================
// DIAGNOSE_NO_REPLY — one-shot helper to figure out WHY the bot
// isn't replying. Copy-paste this whole function into Apps Script,
// then run diagnoseNoReply() ONCE. Open the Execution log (הפעלות)
// and read the lines starting with "DIAG:".
//
// Interpretation:
//   - code=200            ✅ Token & phone-number-id work. Bot's outbound side is fine.
//                            The problem is the webhook (Meta isn't reaching doPost).
//   - code=401            ❌ TOKEN EXPIRED or revoked. Regenerate in Meta → WhatsApp → API Setup.
//   - code=400 + "(#100)" ❌ Phone format wrong, or recipient never opted-in.
//   - code=400 + "(#131030)" ❌ Recipient phone not in Allowed List (Test Mode only).
//   - code=404            ❌ WHATSAPP_PHONE_NUMBER_ID is wrong. Copy it from Meta → API Setup.
//   - throw / undefined   ❌ Script property missing entirely. Re-set WHATSAPP_TOKEN.
// ============================================================
function diagnoseNoReply() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('WHATSAPP_TOKEN') || '';
  var pnid  = props.getProperty('WHATSAPP_PHONE_NUMBER_ID')
           || (typeof WHATSAPP_PHONE_NUMBER_ID !== 'undefined' ? WHATSAPP_PHONE_NUMBER_ID : '');
  var waba  = props.getProperty('WHATSAPP_BUSINESS_ACCOUNT_ID') || '(unset)';
  var secret = props.getProperty('META_APP_SECRET') ? 'set' : 'unset';
  var strict = props.getProperty('STRICT_WEBHOOK_VERIFY') || 'unset';

  Logger.log('DIAG: WHATSAPP_TOKEN length=' + token.length);
  Logger.log('DIAG: WHATSAPP_PHONE_NUMBER_ID=' + pnid);
  Logger.log('DIAG: WHATSAPP_BUSINESS_ACCOUNT_ID=' + waba);
  Logger.log('DIAG: META_APP_SECRET=' + secret + '  STRICT_WEBHOOK_VERIFY=' + strict);

  if (!token || !pnid) {
    Logger.log('DIAG: ABORT — missing token or phone_number_id. Fix Script Properties first.');
    return;
  }

  // 1) Probe the phone-number metadata endpoint. Verifies token + phone-id together.
  try {
    var info = UrlFetchApp.fetch(
      'https://graph.facebook.com/v21.0/' + pnid + '?fields=display_phone_number,verified_name,quality_rating',
      { headers: { 'Authorization': 'Bearer ' + token }, muteHttpExceptions: true }
    );
    Logger.log('DIAG: phone-info code=' + info.getResponseCode());
    Logger.log('DIAG: phone-info body=' + info.getContentText());
  } catch (e) {
    Logger.log('DIAG: phone-info THREW ' + (e && e.stack || e));
  }

  // 2) Try to send a real text message to Steven's own phone using sendWhatsAppMessage.
  //    We pull the recipient from PropertiesService key DIAG_TO so you don't have to
  //    hard-code your phone number into this file. Set it once:
  //       Script Properties → DIAG_TO → e.g. 972526003090   (no +, no dashes)
  var to = props.getProperty('DIAG_TO');
  if (!to) {
    Logger.log('DIAG: skip outbound test — set Script Property DIAG_TO=<your phone like 972526003090> to enable it.');
    return;
  }

  try {
    var sendUrl = 'https://graph.facebook.com/v21.0/' + pnid + '/messages';
    var payload = {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: '🧪 DIAG ' + new Date().toISOString() + ' — אם הגיע, הבוט יכול לשלוח.' }
    };
    var resp = UrlFetchApp.fetch(sendUrl, {
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    Logger.log('DIAG: send code=' + resp.getResponseCode());
    Logger.log('DIAG: send body=' + resp.getContentText());
  } catch (e) {
    Logger.log('DIAG: send THREW ' + (e && e.stack || e));
  }
}
