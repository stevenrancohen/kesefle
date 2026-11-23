#!/usr/bin/env node
'use strict';

// Deterministic, local-only source for the public PWA screenshots. It serves
// synthetic fixture data and never reads a real Kesefle account or Google Sheet.
// Run: node scripts/pwa-screenshot-preview-server.js

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests/fixtures/pwa-screenshot-preview.json'),
  'utf8'
));
const PORT = Number(process.env.KESEFLE_PREVIEW_PORT || 4191);
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

if (FIXTURE.synthetic !== true || FIXTURE.notice !== 'נתוני הדגמה') {
  throw new Error('PWA screenshot fixture must be explicitly synthetic');
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/api/config') {
    return sendJson(res, { ok: true, BOT_NUMBER: '972547760643' });
  }
  if (url.pathname === '/api/me') {
    return sendJson(res, { ok: true, user: FIXTURE.user });
  }
  if (url.pathname === '/api/ui-preferences') {
    return sendJson(res, { ok: true, preferences: FIXTURE.preferences, onboarding: {} });
  }
  if (url.pathname === '/api/group/mine') {
    return sendJson(res, { ok: true, group: null });
  }
  if (url.pathname === '/api/sheet/summary') {
    return sendJson(res, { ok: true, ...FIXTURE.summary, recent: FIXTURE.expenses });
  }
  if (url.pathname === '/api/sheet/getExpenses') {
    return sendJson(res, { ok: true, rows: FIXTURE.expenses });
  }
  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, { ok: false, error: 'synthetic_preview_only' }, 404);
  }

  let pathname = url.pathname;
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/app') pathname = '/app.html';
  if (pathname === '/expense') pathname = '/expense.html';
  const file = path.resolve(ROOT, '.' + pathname);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Synthetic PWA preview: http://127.0.0.1:${PORT}/app`);
});
