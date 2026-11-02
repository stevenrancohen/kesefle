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

import { DEFAULT_PUBLIC_BOT_NUMBER, DEFAULT_APP_LINE_NUMBER, DEFAULT_OWNER_PHONE } from '../config/kesefle-numbers.js';
export { DEFAULT_PUBLIC_BOT_NUMBER, DEFAULT_APP_LINE_NUMBER, DEFAULT_OWNER_PHONE };

export const DEFAULT_GRAPH_VERSION = 'v21.0';
// SECRETS POLICY: access token, verify token and app secret have NO code
// fallback. If unset, callers must fail closed (see requireWaSendConfig /
// waConfigStatus). Non-secret IDs/numbers fall back to config/kesefle-numbers.js.

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

// ---- fail-closed helpers ------------------------------------------------

export class WaConfigError extends Error {
  constructor(missing) {
    super('whatsapp_not_configured: missing ' + missing.join(', '));
    this.name = 'WaConfigError';
    this.code = 'whatsapp_not_configured';
    this.missing = missing;
  }
}

// Names only, never values. Safe for logs and /api/health.
export function waConfigStatus(env = process.env) {
  const cfg = getWaConfig(env);
  const missing = [];
  if (!cfg.accessToken) missing.push('WA_ACCESS_TOKEN');
  if (!cfg.phoneNumberId) missing.push('WA_PHONE_NUMBER_ID');
  if (!cfg.verifyToken) missing.push('WA_VERIFY_TOKEN');
  if (!String(env.META_APP_SECRET || '').trim()) missing.push('META_APP_SECRET');
  if (!cfg.wabaId) missing.push('WA_WABA_ID');
  const sendReady = !!(cfg.accessToken && cfg.phoneNumberId);
  return { ok: missing.length === 0, send_ready: sendReady, verify_ready: !!cfg.verifyToken, missing };
}

// Throws WaConfigError (before any network call) when send creds are absent.
export function requireWaSendConfig(env = process.env, phoneNumberIdOverride) {
  const cfg = getWaConfig(env);
  const missing = [];
  if (!cfg.accessToken) missing.push('WA_ACCESS_TOKEN');
  if (!(phoneNumberIdOverride || cfg.phoneNumberId)) missing.push('WA_PHONE_NUMBER_ID');
  if (missing.length) throw new WaConfigError(missing);
  return { token: cfg.accessToken, url: messagesUrl(env, phoneNumberIdOverride) };
}

export function getAppLineDigits(env = process.env) {
  return digitsOnly(pick(env, ['WA_APP_LINE_E164'])) || DEFAULT_APP_LINE_NUMBER;
}

// `names` lets each caller keep its historical env-var precedence.
export function getOwnerPhone(env = process.env, names = ['KESEFLE_OWNER_PHONE']) {
  return digitsOnly(pick(env, names)) || DEFAULT_OWNER_PHONE;
}

// /wa redirect target. ?line=app -> app line; ?text= passed through (max 1000).
export function resolveWaRedirect(query = {}, env = process.env) {
  const line = String(query.line || '').toLowerCase();
  const digits = line === 'app' ? getAppLineDigits(env) : getWaConfig(env).phoneDigits;
  let text = query.text == null ? '' : String(Array.isArray(query.text) ? query.text[0] : query.text);
  if (text.length > 1000) text = text.slice(0, 1000);
  return waMeLink(digits, text);
}
