// lib/wa-config.js
//
// Single source of truth for WhatsApp Cloud API configuration on the Vercel
// side. Everything number-specific comes from env vars so swapping to a new
// SIM / phone number is an env change + redeploy, not a code change.
//
// Preferred env vars (new):        Legacy fallbacks (still honoured):
//   WA_PHONE_E164                    KESEFLE_BOT_NUMBER, BOT_PHONE_E164
//   WA_PHONE_NUMBER_ID               META_PHONE_NUMBER_ID, WHATSAPP_PHONE_NUMBER_ID
//   WA_WABA_ID                       WHATSAPP_BUSINESS_ACCOUNT_ID, META_WABA_ID
//   WA_ACCESS_TOKEN                  META_ACCESS_TOKEN, WHATSAPP_TOKEN
//   WA_VERIFY_TOKEN                  META_VERIFY_TOKEN
//   WA_GRAPH_VERSION                 (default v21.0)
//
// Precedence: WA_* first, then legacy names -- so behaviour is unchanged
// until the WA_* vars are set. Pure functions; no network access here.

export const DEFAULT_GRAPH_VERSION = 'v21.0';
// Public bot number currently baked into the site (unchanged default).
export const DEFAULT_PUBLIC_BOT_NUMBER = '972547760643';

function pick(env, names) {
  for (const n of names) {
    const v = env[n];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

export function digitsOnly(v) {
  return String(v == null ? '' : v).replace(/\D+/g, '');
}

export function normalizeGraphVersion(v) {
  const s = String(v || '').trim();
  if (!s) return DEFAULT_GRAPH_VERSION;
  const m = s.match(/^v?(\d+)(?:\.(\d+))?$/);
  if (!m) return DEFAULT_GRAPH_VERSION;
  return 'v' + m[1] + '.' + (m[2] || '0');
}

export function getWaConfig(env = process.env) {
  const phoneDigits = digitsOnly(pick(env, ['WA_PHONE_E164', 'KESEFLE_BOT_NUMBER', 'BOT_PHONE_E164'])) || DEFAULT_PUBLIC_BOT_NUMBER;
  return {
    phoneE164: '+' + phoneDigits,
    phoneDigits,
    phoneIsDefault: phoneDigits === DEFAULT_PUBLIC_BOT_NUMBER,
    phoneNumberId: pick(env, ['WA_PHONE_NUMBER_ID', 'META_PHONE_NUMBER_ID', 'WHATSAPP_PHONE_NUMBER_ID']),
    wabaId: pick(env, ['WA_WABA_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'META_WABA_ID']),
    accessToken: pick(env, ['WA_ACCESS_TOKEN', 'META_ACCESS_TOKEN', 'WHATSAPP_TOKEN']),
    verifyToken: pick(env, ['WA_VERIFY_TOKEN', 'META_VERIFY_TOKEN']),
    graphVersion: normalizeGraphVersion(pick(env, ['WA_GRAPH_VERSION'])),
  };
}

export function graphBase(env = process.env) {
  return 'https://graph.facebook.com/' + getWaConfig(env).graphVersion;
}

// URL for POST /{phone-number-id}/messages. `phoneNumberIdOverride` lets a
// webhook reply from the SAME number the user messaged (metadata.phone_number_id).
export function messagesUrl(env = process.env, phoneNumberIdOverride) {
  const cfg = getWaConfig(env);
  const id = String(phoneNumberIdOverride || cfg.phoneNumberId || '');
  return graphBase(env) + '/' + encodeURIComponent(id) + '/messages';
}

export function formatDisplay(phoneDigits) {
  const d = digitsOnly(phoneDigits);
  const il = d.match(/^972(\d{2})(\d{3})(\d{4})$/);
  if (il) return `+972 ${il[1]}-${il[2]}-${il[3]}`;
  const us = d.match(/^1(\d{3})(\d{3})(\d{4})$/);
  if (us) return `+1 ${us[1]}-${us[2]}-${us[3]}`;
  return '+' + d;
}

export function waMeLink(phone, text) {
  const d = digitsOnly(phone);
  const base = 'https://wa.me/' + d;
  return text ? base + '?text=' + encodeURIComponent(String(text)) : base;
}

// Which configured number did an inbound webhook arrive on?
export function inboundPhoneNumberId(payload) {
  try {
    return String(payload?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id || '');
  } catch (_e) { return ''; }
}

// Accept only payloads addressed to our configured number (when configured).
// Returns { ok, phoneNumberId, reason }.
export function routeInbound(payload, env = process.env) {
  const cfg = getWaConfig(env);
  const inbound = inboundPhoneNumberId(payload);
  const waba = String(payload?.entry?.[0]?.id || '');
  if (cfg.wabaId && waba && waba !== cfg.wabaId) return { ok: false, phoneNumberId: inbound, reason: 'waba_mismatch' };
  if (!inbound) return { ok: false, phoneNumberId: '', reason: 'no_metadata' };
  if (cfg.phoneNumberId && inbound !== cfg.phoneNumberId) return { ok: false, phoneNumberId: inbound, reason: 'phone_number_id_mismatch' };
  return { ok: true, phoneNumberId: inbound, reason: 'ok' };
}

// Public (browser-safe) subset. NEVER include token / verify token here.
export function publicWaConfig(env = process.env) {
  const cfg = getWaConfig(env);
  return {
    BOT_NUMBER: cfg.phoneDigits,
    BOT_NUMBER_DISPLAY: formatDisplay(cfg.phoneDigits),
    BOT_WA_LINK: waMeLink(cfg.phoneDigits),
    bot_number_is_default: cfg.phoneIsDefault,
  };
}
