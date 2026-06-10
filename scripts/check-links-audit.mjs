#!/usr/bin/env node
// One-shot internal link audit for kesefle (cleanUrls=true). Read-only.
import fs from 'fs';
import path from 'path';

const ROOT = '/tmp/kesefle-fresh';
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const redirectSources = (vercel.redirects || []).map(r => r.source);

// Public page scopes
const scopes = ['.', 'blog', 'admin'];
const htmlFiles = [];
for (const dir of scopes) {
  const abs = path.join(ROOT, dir);
  for (const f of fs.readdirSync(abs)) {
    if (f.endsWith('.html')) htmlFiles.push(path.join(dir === '.' ? '' : dir, f));
  }
}
htmlFiles.sort();

// Extract href/src (also srcset URLs, form action, meta refresh url) — primary: href/src
const ATTR_RE = /\b(?:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi;

function isExternal(u) {
  return /^(https?:)?\/\//i.test(u) || /^(mailto:|tel:|sms:|whatsapp:|javascript:|data:|blob:|geo:|intent:)/i.test(u);
}

function matchesRedirect(p) {
  for (const src of redirectSources) {
    if (src === p) return src;
    // pattern like /tools/:tool*
    const m = src.match(/^(.*?)\/:([A-Za-z0-9_]+)\*$/);
    if (m && (p === m[1] || p.startsWith(m[1] + '/'))) return src;
  }
  return null;
}

const exists = p => fs.existsSync(path.join(ROOT, p)) && fs.statSync(path.join(ROOT, p)).isFile();
const existsDir = p => fs.existsSync(path.join(ROOT, p)) && fs.statSync(path.join(ROOT, p)).isDirectory();

// /api/foo -> api/foo.js | api/foo/index.js (Vercel functions)
function apiExists(p) {
  const rel = p.replace(/^\//, '');
  if (exists(rel + '.js') || exists(rel + '.ts')) return true;
  if (exists(path.join(rel, 'index.js'))) return true;
  // dynamic segment match: walk dirs allowing [param]
  const parts = rel.split('/');
  function walk(dir, i) {
    if (i === parts.length - 1) {
      const entries = fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)) : [];
      return entries.some(e => e === parts[i] + '.js' || (e.startsWith('[') && e.endsWith('].js')));
    }
    const entries = fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)) : [];
    for (const e of entries) {
      const full = path.join(dir, e);
      if (!existsDir(full)) continue;
      if (e === parts[i] || (e.startsWith('[') && e.endsWith(']'))) {
        if (walk(full, i + 1)) return true;
      }
    }
    return false;
  }
  return walk(parts[0], 1);
}

// Resolve a cleaned absolute site path (starts with /) to: ok | redirect | MISSING
function resolveSitePath(p) {
  if (p === '/' || p === '') return { ok: true, how: 'index.html' };
  const r = matchesRedirect(p.replace(/\/$/, '') || p);
  if (r) return { ok: true, how: `vercel redirect (${r})` };
  let rel = decodeURIComponent(p.replace(/^\//, ''));
  rel = rel.replace(/\/$/, ''); // trailingSlash:false -> /foo/ serves /foo
  if (rel === '') return { ok: true, how: 'index.html' };
  if (rel.startsWith('api/')) {
    return apiExists('/' + rel) ? { ok: true, how: 'api fn' } : { ok: false };
  }
  if (exists(rel)) return { ok: true, how: 'exact file' };
  if (exists(rel + '.html')) return { ok: true, how: rel + '.html (cleanUrls)' };
  if (exists(path.join(rel, 'index.html'))) return { ok: true, how: 'dir index' };
  return { ok: false };
}

const rows = [];
const okCount = { n: 0 };
const seen = new Set();

for (const file of htmlFiles) {
  const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const fileDir = path.posix.dirname('/' + file.split(path.sep).join('/'));
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(content))) {
    const raw = (m[2] !== undefined ? m[2] : m[3]).trim();
    if (!raw || raw.startsWith('#') || isExternal(raw)) continue;
    if (/[{<]|^\$/.test(raw)) continue; // template placeholders
    if (/['"]\s*\+|\+\s*['"]/.test(raw)) continue; // JS string concatenation in inline scripts
    // strip query + fragment
    const clean = raw.split('#')[0].split('?')[0];
    if (!clean) continue;
    // resolve relative against file dir
    let sitePath;
    if (clean.startsWith('/')) sitePath = path.posix.normalize(clean);
    else sitePath = path.posix.normalize(path.posix.join(fileDir, clean));
    const res = resolveSitePath(sitePath);
    if (res.ok) { okCount.n++; continue; }
    const key = file + '|' + raw;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ file, raw, sitePath });
  }
}

console.log(`Scanned ${htmlFiles.length} html files (root + blog/ + admin/). OK links: ${okCount.n}. Broken: ${rows.length}`);
for (const r of rows) console.log(`BROKEN\t${r.file}\t${r.raw}\t(resolved: ${r.sitePath})`);

// ---- Supplementary pass: action=, poster=, srcset=, og/twitter image content=, meta refresh ----
console.log('\n--- supplementary attributes (action/poster/srcset/content-image) ---');
const SUPP_RES = [
  [/\baction\s*=\s*("([^"]*)"|'([^']*)')/gi, 'action'],
  [/\bposter\s*=\s*("([^"]*)"|'([^']*)')/gi, 'poster'],
  [/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, 'srcset'],
  [/\bcontent\s*=\s*("(\/[^"]*)"|'(\/[^']*)')/gi, 'content(path)'],
];
let suppBroken = 0;
for (const file of htmlFiles) {
  const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const fileDir = path.posix.dirname('/' + file.split(path.sep).join('/'));
  for (const [re, label] of SUPP_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content))) {
      const valRaw = (m[2] !== undefined ? m[2] : m[3]);
      if (valRaw === undefined) continue;
      const urls = label === 'srcset'
        ? valRaw.split(',').map(s => s.trim().split(/\s+/)[0])
        : [valRaw.trim()];
      for (const raw of urls) {
        if (!raw || raw.startsWith('#') || isExternal(raw)) continue;
        if (/[{<]|^\$/.test(raw) || /['"]\s*\+|\+\s*['"]/.test(raw)) continue;
        const clean = raw.split('#')[0].split('?')[0];
        if (!clean) continue;
        const sitePath = clean.startsWith('/') ? path.posix.normalize(clean) : path.posix.normalize(path.posix.join(fileDir, clean));
        const res = resolveSitePath(sitePath);
        if (!res.ok) { suppBroken++; console.log(`BROKEN\t${file}\t${label}=${raw}\t(resolved: ${sitePath})`); }
      }
    }
  }
}
if (!suppBroken) console.log('(none broken)');

// ---- Supplementary pass: inline-JS page-path string literals (location.href, fetch, window.open) ----
console.log('\n--- inline JS string-literal internal paths ---');
const JS_PATH_RE = /['"`](\/(?!\/)[A-Za-z0-9_\-./]*)['"`]/g;
const jsBroken = new Map();
for (const file of htmlFiles) {
  const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
  // only inside <script> blocks
  const scripts = [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(s => s[1]).join('\n');
  let m;
  JS_PATH_RE.lastIndex = 0;
  while ((m = JS_PATH_RE.exec(scripts))) {
    let p = m[1];
    if (p === '/') continue;
    const clean = p.split('#')[0].split('?')[0].replace(/\/$/, '');
    if (!clean) continue;
    // skip obvious non-URL strings: regex-ish, MIME-ish, single chars, paths with template markers
    if (!/^\/[a-z0-9]/i.test(clean)) continue;
    if (/\.(?:test|exec)\b/.test(clean)) continue;
    const res = resolveSitePath(clean);
    if (!res.ok) {
      const key = file + '|' + clean;
      if (!jsBroken.has(key)) jsBroken.set(key, { file, p: clean });
    }
  }
}
if (!jsBroken.size) console.log('(none broken)');
for (const { file, p } of jsBroken.values()) console.log(`JS-PATH?\t${file}\t${p}`);
