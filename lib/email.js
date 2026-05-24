// lib/email.js
//
// Centralized email sender. Uses Resend.com REST API
// (https://resend.com/docs/api-reference/emails/send-email).
//
// Why Resend: simple JSON API, no SDK needed, generous free tier (3k/mo),
// good deliverability, supports React/HTML, owner is already paying for
// Postmark-like reliability. Env: RESEND_API_KEY + EMAIL_FROM (default
// 'noreply@kesefle.com').
//
// CRITICAL: env-fail-soft. If RESEND_API_KEY is missing, every call returns
// { ok: false, skipped: true, reason: 'not_configured' } and logs a warning.
// NEVER throws -- payment, lifecycle, and signup flows must not break when
// email is misconfigured.

import { log } from './log.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates', 'email');

const TEMPLATE_CACHE = new Map();

function readTemplateOnce(name) {
  if (TEMPLATE_CACHE.has(name)) return TEMPLATE_CACHE.get(name);
  const filename = name.endsWith('.html') ? name : `${name}.html`;
  const filepath = path.join(TEMPLATES_DIR, filename);
  try {
    const html = fs.readFileSync(filepath, 'utf8');
    TEMPLATE_CACHE.set(name, html);
    return html;
  } catch (e) {
    log.warn('email.template_missing', { name, error: e.message });
    return null;
  }
}

// Minimal mustache-style renderer: replaces {{var}} with values from `vars`.
// Missing vars become empty strings (do NOT throw). Values are HTML-escaped
// by default; pass {{{var}}} for raw HTML (unescaped).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderTemplate(templateName, vars) {
  const tpl = readTemplateOnce(templateName);
  if (!tpl) return null;
  const v = vars || {};
  return tpl
    .replace(/\{\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}\}/g, (_, key) => String(v[key] == null ? '' : v[key]))
    .replace(/\{\{ *([a-zA-Z_][a-zA-Z0-9_]*) *\}\}/g, (_, key) => escapeHtml(v[key]));
}

// Extract a plain-text subject from the rendered HTML's <title> tag.
function extractSubject(html) {
  const m = html && html.match(/<title>([^<]*)<\/title>/i);
  return m ? m[1].trim() : '';
}

// Strip HTML tags to produce a basic plain-text fallback for email clients
// that prefer text/plain (gmail, outlook on mobile).
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Low-level send. Use sendTemplate() for the higher-level template flow.
export async function sendEmail({ to, subject, html, text, from, replyTo, tags }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn('email.skipped_not_configured', { to: redactEmail(to), subject });
    return { ok: false, skipped: true, reason: 'not_configured' };
  }
  const fromAddr = from || process.env.EMAIL_FROM || 'Kesefle <noreply@kesefle.com>';
  if (!to || !subject || !html) {
    return { ok: false, error: 'missing_required_fields' };
  }

  const body = {
    from: fromAddr,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text: text || htmlToText(html),
  };
  if (replyTo) body.reply_to = replyTo;
  if (Array.isArray(tags) && tags.length) body.tags = tags;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      log.error('email.send_failed', { to: redactEmail(to), status: r.status, error: j?.message || j?.name || 'unknown' });
      return { ok: false, status: r.status, error: j?.message || `resend_${r.status}` };
    }
    log.info('email.sent', { to: redactEmail(to), subject, id: j.id });
    return { ok: true, id: j.id };
  } catch (e) {
    log.error('email.send_threw', { to: redactEmail(to), error: e.message });
    return { ok: false, error: 'network_error', detail: e.message };
  }
}

// High-level: render a template by name and send it. Returns the same shape
// as sendEmail() plus `template` for traceability.
export async function sendTemplate({ to, template, vars, subject, replyTo, tags }) {
  const html = renderTemplate(template, vars);
  if (!html) return { ok: false, error: 'template_not_found', template };
  const subj = subject || extractSubject(html) || 'Kesefle';
  const result = await sendEmail({
    to, subject: subj, html, replyTo,
    tags: [...(tags || []), { name: 'template', value: template }],
  });
  return { ...result, template };
}

// Logging helper: redact email so we keep just the domain + first char (so
// support can match against signup logs without dumping full PII).
function redactEmail(addr) {
  const s = Array.isArray(addr) ? addr[0] : addr;
  if (!s || typeof s !== 'string' || !s.includes('@')) return 'invalid';
  const [local, domain] = s.split('@');
  return `${local.charAt(0)}***@${domain}`;
}

// Health helper for /api/admin endpoints.
export function emailHealth() {
  return {
    configured: !!process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM || 'Kesefle <noreply@kesefle.com>',
    templates_dir: TEMPLATES_DIR,
    templates_cached: TEMPLATE_CACHE.size,
  };
}
