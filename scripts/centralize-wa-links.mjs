#!/usr/bin/env node
// scripts/centralize-wa-links.mjs
//
// One-shot (idempotent) migration: replaces hardcoded bot numbers in the
// static site / email templates with config-driven forms:
//   https://wa.me/<bot>[?text=..]      -> /wa[?text=..]           (site pages)
//                                       -> https://kesefle.com/wa (emails, PWA)
//   https://wa.me/<appline>[?..]       -> /wa?line=app[&..]
//   share text "wa.me/<bot>?text="     -> "kesefle.com/wa?text="
//   visible "+972 5X-XXX-XXXX" variants of the bot number    -> <span data-kfl-bot-display>WhatsApp</span>
//
// /wa is rewritten (vercel.json) to /api/config?go=wa, which 302s to the
// number in WA_PHONE_E164 (default: config/kesefle-numbers.js). So the number
// lives in ONE place. Run with --check to list remaining spots (exit 1 if any).
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PUBLIC_BOT_NUMBER as BOT, DEFAULT_APP_LINE_NUMBER as APP } from '../config/kesefle-numbers.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'docs', 'tests', 'bot', 'api', 'lib', 'config', 'scripts', '.vercel', '.github']);
const EXT = new Set(['.html', '.webmanifest', '.json', '.js', '.xml', '.txt']);
const ABS_PREFIXES = ['emails/', 'templates/'];
const ABS_FILES = new Set(['manifest.webmanifest', 'app.webmanifest']);

function local(d) { return d.length === 12 && d.startsWith('972') ? '0' + d.slice(3) : d; }
function variants(d) {
  const l = local(d); // 05XXXXXXXX
  const a = l.slice(1, 3), b = l.slice(3, 6), c = l.slice(6);
  return [`+972 ${a}-${b}-${c}`, `+972-${a}-${b}-${c}`, `${l.slice(0, 3)}-${b}-${c}`, `0${a}-${b}${c}`];
}

export function transform(src, rel) {
  const abs = ABS_FILES.has(rel) || ABS_PREFIXES.some((p) => rel.startsWith(p));
  const base = abs ? 'https://kesefle.com/wa' : '/wa';
  let s = src;
  s = s.split(`https://wa.me/${APP}?`).join(`${base}?line=app&`);
  s = s.split(`https://wa.me/${APP}`).join(`${base}?line=app`);
  s = s.split(`https://wa.me/${BOT}`).join(base);
  s = s.split(`https%3A%2F%2Fwa.me%2F${BOT}`).join('https%3A%2F%2Fkesefle.com%2Fwa');
  s = s.split(`wa.me%2F${BOT}`).join('kesefle.com%2Fwa');
  s = s.split(`wa.me/${BOT}`).join('kesefle.com/wa');
  if (rel.endsWith('.html')) {
    for (const v of variants(BOT)) s = s.split(v).join('<span data-kfl-bot-display>WhatsApp</span>');
  }
  return s;
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (EXT.has(path.extname(e.name)) || e.name.endsWith('.webmanifest')) out.push(path.join(dir, e.name));
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const check = process.argv.includes('--check');
  let changed = 0;
  for (const f of walk(ROOT, [])) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (rel === 'package.json' || rel === 'package-lock.json' || rel === 'vercel.json') continue;
    const src = fs.readFileSync(f, 'utf8');
    const out = transform(src, rel);
    if (out !== src) {
      changed++;
      if (check) console.log('needs centralising:', rel);
      else fs.writeFileSync(f, out);
    }
  }
  console.log((check ? 'files needing change: ' : 'files changed: ') + changed);
  if (check && changed) process.exit(1);
}
