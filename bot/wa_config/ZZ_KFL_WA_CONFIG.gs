/**
 * ZZ_KFL_WA_CONFIG.gs — WhatsApp number/config via Script Properties
 * ===================================================================
 * Paste as a NEW file in Apps Script project 'importjason', AFTER all other
 * files (name starts with ZZ_ so it sorts last, like ZZ_KFL_CANON_PATCH.gs).
 * Function declarations here override same-named functions in ExpenseBot.gs.
 *
 * SECRETS (token, verify token) have NO fallback: the strict getters throw a
 * clear KFL_WA_CONFIG_MISSING error and sends return {ok:false} before any
 * UrlFetchApp call. Non-secret IDs/numbers fall back to today's values (safe:
 * a wrong public ID cannot leak data, and keeps current behaviour).
 *
 * Script Properties read (all optional):
 *   WHATSAPP_PHONE_NUMBER_ID  (alias WA_PHONE_NUMBER_ID)  fallback 1086749664527399 (test number)
 *   WHATSAPP_TOKEN            (alias WA_ACCESS_TOKEN)     REQUIRED, no fallback
 *   WHATSAPP_BUSINESS_ACCOUNT_ID (alias WA_WABA_ID)       fallback '' (WABA check off)
 *   WA_VERIFY_TOKEN                                       REQUIRED, no fallback
 *   WA_GRAPH_VERSION                                      fallback 'v21.0'
 *   BOT_PHONE_E164                                        fallback '+972547760643'
 *
 * NOTE: VERIFY_TOKEN / BOT_PHONE_E164 / WHATSAPP_PHONE_NUMBER_ID are `const`s
 * in ExpenseBot.gs and cannot be redeclared from another file. To make THEM
 * property-driven, replace these 3 lines in ExpenseBot.gs (search for them):
 *
 *   const VERIFY_TOKEN = '<legacy literal>';
 *     -> const VERIFY_TOKEN = _kflWaVerifyTokenOrEmpty_();
 *        (NOT the throwing getter: a top-level throw would break every
 *        request. Empty => doGet must refuse the handshake; see repo
 *        bot/ExpenseBot_DEPLOY.gs doGet for the fail-closed check.)
 *   const WHATSAPP_PHONE_NUMBER_ID = PropertiesService...|| '1086749664527399';
 *     -> const WHATSAPP_PHONE_NUMBER_ID = _kflWaPhoneNumberId_();
 *   const BOT_PHONE_E164 = '+972547760643';
 *     -> const BOT_PHONE_E164 = _kflWaPhoneE164_();
 *
 * (Function declarations are hoisted across files, so calling these from a
 * top-level const in ExpenseBot.gs works.) The _waSendConfig_ override below
 * already makes OUTBOUND sends + graph version property-driven without that edit.
 *
 * Run kflWaConfigReport() from the editor to print the resolved config
 * (token is masked). It makes NO network calls.
 */

var KFL_WA_DEFAULTS_ = {
  PHONE_NUMBER_ID: '1086749664527399',
  GRAPH_VERSION: 'v21.0',
  PHONE_E164: '+972547760643'
};

function _kflWaProp_(names) {
  var p = PropertiesService.getScriptProperties();
  for (var i = 0; i < names.length; i++) {
    var v = p.getProperty(names[i]);
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}
function _kflWaPhoneNumberId_() { return _kflWaProp_(['WHATSAPP_PHONE_NUMBER_ID', 'WA_PHONE_NUMBER_ID']) || KFL_WA_DEFAULTS_.PHONE_NUMBER_ID; }
function _kflWaMissing_(name) {
  var err = new Error('KFL_WA_CONFIG_MISSING: Script Property ' + name + ' is not set (no code fallback for secrets)');
  err.name = 'KflWaConfigError';
  return err;
}
function _kflWaTokenOrEmpty_()       { return _kflWaProp_(['WHATSAPP_TOKEN', 'WA_ACCESS_TOKEN']); }
function _kflWaVerifyTokenOrEmpty_() { return _kflWaProp_(['WA_VERIFY_TOKEN']); }
// Strict getters: throw a clear error when the secret is missing.
function _kflWaToken_() {
  var t = _kflWaTokenOrEmpty_();
  if (!t || t.indexOf('PASTE_') === 0) throw _kflWaMissing_('WHATSAPP_TOKEN');
  return t;
}
function _kflWaWabaId_()        { return _kflWaProp_(['WHATSAPP_BUSINESS_ACCOUNT_ID', 'WA_WABA_ID']); }
function _kflWaVerifyToken_() {
  var v = _kflWaVerifyTokenOrEmpty_();
  if (!v) throw _kflWaMissing_('WA_VERIFY_TOKEN');
  return v;
}
function _kflWaGraphVersion_() {
  var v = _kflWaProp_(['WA_GRAPH_VERSION']);
  var m = String(v).match(/^v?(\d+)(?:\.(\d+))?$/);
  return m ? ('v' + m[1] + '.' + (m[2] || '0')) : KFL_WA_DEFAULTS_.GRAPH_VERSION;
}
function _kflWaPhoneE164_() {
  var d = String(_kflWaProp_(['BOT_PHONE_E164']) || KFL_WA_DEFAULTS_.PHONE_E164).replace(/\D+/g, '');
  return '+' + d;
}
function _kflWaMeLink_(text) {
  var d = _kflWaPhoneE164_().replace(/\D+/g, '');
  return 'https://wa.me/' + d + (text ? '?text=' + encodeURIComponent(text) : '');
}
function _kflWaMessagesUrl_(phoneNumberIdOverride) {
  return 'https://graph.facebook.com/' + _kflWaGraphVersion_() + '/' +
    (phoneNumberIdOverride || _kflWaPhoneNumberId_()) + '/messages';
}

// Override of ExpenseBot.gs _waSendConfig_ — identical logic, but the Meta
// branch reads token / phone id / graph version through the getters above.
function _waSendConfig_() {
  var props = PropertiesService.getScriptProperties();
  var provider = String(props.getProperty('WHATSAPP_PROVIDER') || 'meta').toLowerCase();

  if (provider === '360dialog') {
    var d360Key = props.getProperty('D360_API_KEY') || '';
    if (!d360Key || d360Key.indexOf('PASTE_') === 0) return { ok: false, provider: provider, reason: 'no_d360_key' };
    return { ok: true, provider: provider, url: 'https://waba-v2.360dialog.io/messages',
      headers: { 'D360-API-KEY': d360Key, 'Content-Type': 'application/json' } };
  }
  if (provider === 'twilio') {
    var twSid = props.getProperty('TWILIO_ACCOUNT_SID') || '';
    var twToken = props.getProperty('TWILIO_AUTH_TOKEN') || '';
    var twFrom = props.getProperty('TWILIO_FROM') || '';
    if (!twSid || !twToken || !twFrom || twSid.indexOf('PASTE_') === 0 || twToken.indexOf('PASTE_') === 0) {
      return { ok: false, provider: provider, reason: 'no_twilio_creds' };
    }
    return { ok: true, provider: 'twilio',
      url: 'https://api.twilio.com/2010-04-01/Accounts/' + twSid + '/Messages.json',
      headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(twSid + ':' + twToken),
                 'Content-Type': 'application/x-www-form-urlencoded' },
      from: twFrom };
  }
  var token = _kflWaTokenOrEmpty_();
  if (!token || token.indexOf('PASTE_') === 0) {
    Logger.log('_waSendConfig_: KFL_WA_CONFIG_MISSING WHATSAPP_TOKEN - send skipped, no network call');
    return { ok: false, provider: 'meta', reason: 'no_token' };
  }
  var active = (typeof _ACTIVE_PHONE_NUMBER_ID_ !== 'undefined') ? _ACTIVE_PHONE_NUMBER_ID_ : '';
  return { ok: true, provider: 'meta', url: _kflWaMessagesUrl_(active),
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } };
}

// Diagnostics only — prints resolved config, no network, no writes.
function kflWaConfigReport() {
  var t = _kflWaTokenOrEmpty_();
  var lines = [
    'phone_e164       = ' + _kflWaPhoneE164_(),
    'phone_number_id  = ' + _kflWaPhoneNumberId_(),
    'waba_id          = ' + (_kflWaWabaId_() || '(unset - WABA check off)'),
    'graph_version    = ' + _kflWaGraphVersion_(),
    'verify_token     = ' + (_kflWaVerifyTokenOrEmpty_() ? '(set, from property)' : 'MISSING - Meta handshake will be refused'),
    'access_token     = ' + (t ? ('set, ' + t.length + ' chars') : 'MISSING'),
    'messages_url     = ' + _kflWaMessagesUrl_(),
    'wa.me            = ' + _kflWaMeLink_()
  ];
  Logger.log(lines.join('\n'));
  return lines;
}
