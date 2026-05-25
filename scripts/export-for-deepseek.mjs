#!/usr/bin/env node
// scripts/export-for-deepseek.mjs
//
// Bundle the entire Kesefle repo into a single .txt file that Steven can
// upload to DeepSeek (or any other LLM) for an external code-review pass.
// Steven 2026-05-25: "אני רוצה לייצא את כל הקבצים שיש פה על מנת לשלוח את
// זה ל deepseek אחר על מנת שהוא ישפר את המערכת על ידי הוראות אחרות".
//
// Output: kesefle_export_<YYYY-MM-DD>.txt at the repo root.
// Includes: api/*.js, lib/*.js, bot/*.gs (FIXED+DEPLOY skipped to dedupe),
//   *.html (root + tools/), tests/*.js, scripts/*, .md docs at root,
//   package.json, vercel.json, .env.example, sw.js, manifest.webmanifest.
// Excludes: node_modules/, .git/, .vercel/, .fastembed_cache/,
//   *.db, *.sqlite, *.lock, *.png, *.jpg, *.svg, *.ico, *.woff*, *.pdf.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// What to include
const INCLUDE_DIRS = ['api', 'lib', 'bot', 'tests', 'scripts', 'tools', 'help', 'admin'];
const INCLUDE_ROOT_FILES_REGEX = /\.(html|md|json|js|mjs|webmanifest)$/i;
const INCLUDE_HEADER_FILES = ['vercel.json', 'package.json', '.env.example', 'sw.js', 'manifest.webmanifest', '.gitignore'];

// What to skip even if matched above
const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', '.fastembed_cache', '.next', 'dist', 'build']);
const SKIP_FILE_PATTERNS = [
  /\.(db|sqlite|lock|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|otf|pdf|zip|tar|gz|mp4|mov)$/i,
  /package-lock\.json$/i,
  /\.DS_Store$/,
  /^\.context-brain\.db$/,
];
// Apps Script bot has BOTH ExpenseBot_FIXED.gs (source of truth) and
// ExpenseBot_DEPLOY.gs (reassembled with the doPost header). They are 99%
// identical — exporting both wastes ~250KB and confuses the reviewer.
// We export FIXED.gs only.
const SKIP_EXACT = new Set(['bot/ExpenseBot_DEPLOY.gs']);

// Cap per chunk file at ~350KB so each chunk fits in DeepSeek's 128K-token
// window with headroom for system prompt. Bigger source files (notably
// bot/ExpenseBot_FIXED.gs at 13K lines / 600KB) get split into 01_bot_p1,
// 01_bot_p2, ... so each piece fits. Tuned for Hebrew/UTF-8 which uses
// 2 bytes per non-ASCII char -> 1 char ~= 0.5 token.
const CHUNK_TARGET_BYTES = 350 * 1024;
// Split a single file into parts that each fit comfortably under the
// chunk cap. ~2000 lines averages 200KB in our codebase (Hebrew comments
// + code), well under the 350KB chunk target.
const MAX_LINES_PER_CHUNK = 1400;

function shouldSkipFile(absPath) {
  const rel = path.relative(REPO_ROOT, absPath);
  if (SKIP_EXACT.has(rel)) return true;
  for (const pat of SKIP_FILE_PATTERNS) if (pat.test(absPath)) return true;
  return false;
}

function collectFiles() {
  const collected = [];

  // Root files matching the header allowlist or the markdown/json regex.
  for (const entry of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const abs = path.join(REPO_ROOT, entry.name);
    if (shouldSkipFile(abs)) continue;
    if (INCLUDE_HEADER_FILES.includes(entry.name) || INCLUDE_ROOT_FILES_REGEX.test(entry.name)) {
      collected.push(abs);
    }
  }

  // Walk included directories.
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(abs);
      } else if (e.isFile()) {
        if (shouldSkipFile(abs)) continue;
        collected.push(abs);
      }
    }
  }
  for (const d of INCLUDE_DIRS) {
    const abs = path.join(REPO_ROOT, d);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) walk(abs);
  }

  // De-dupe and sort for stable output.
  return [...new Set(collected)].sort();
}

function fileSizeBytes(p) {
  try { return fs.statSync(p).size; }
  catch { return 0; }
}

function loadFileContent(absPath) {
  const buf = fs.readFileSync(absPath);
  // Quick binary sniff: a NUL byte in the first 8KB = probably binary.
  const slice = buf.slice(0, 8192);
  for (let i = 0; i < slice.length; i++) if (slice[i] === 0) return null;
  return buf.toString('utf8');
}

// For very large source files, split into N parts so each part fits in an
// LLM context window. Each part gets the original file path + a part tag
// (e.g. "bot/ExpenseBot_FIXED.gs (part 2/4, lines 4501-9000)").
function chunkLargeFile(absPath, relPath) {
  const txt = loadFileContent(absPath);
  if (txt === null) return [{ rel: relPath, part: null, content: null, isBinary: true }];
  const lines = txt.split('\n');
  if (lines.length <= MAX_LINES_PER_CHUNK) {
    return [{ rel: relPath, part: null, content: txt, isBinary: false }];
  }
  const parts = [];
  const total = Math.ceil(lines.length / MAX_LINES_PER_CHUNK);
  for (let i = 0; i < total; i++) {
    const startLine = i * MAX_LINES_PER_CHUNK;
    const endLine = Math.min(startLine + MAX_LINES_PER_CHUNK, lines.length);
    const part = lines.slice(startLine, endLine).join('\n');
    parts.push({
      rel: relPath,
      part: { num: i + 1, total, startLine: startLine + 1, endLine },
      content: part,
      isBinary: false,
    });
  }
  return parts;
}

function buildManifest(files) {
  const lines = [
    'KESEFLE CODEBASE EXPORT',
    'Date: ' + new Date().toISOString(),
    'Files: ' + files.length,
    '',
    'Project: Kesefle (כספ\'לה) -- Hebrew-first multi-tenant WhatsApp',
    'expense-tracking SaaS. Per-user Google Sheet (drive.file OAuth),',
    'Apps Script bot, Vercel ESM API, Upstash KV REST.',
    '',
    'Architecture:',
    '  - api/*.js       : Vercel serverless endpoints (ESM)',
    '  - lib/*.js       : shared utilities (auth, KV, categories, etc.)',
    '  - bot/*.gs       : Google Apps Script bot (manual paste deploy)',
    '    -- ExpenseBot_FIXED.gs is the source of truth (~9000 lines)',
    '    -- ExpenseBot_DEPLOY.gs is the reassembled deploy bundle (skipped)',
    '  - tests/*.js     : node-runnable QA suite',
    '  - *.html         : public pages served by Vercel',
    '',
    'Bot version: see KFL_BUILD_VERSION constant in bot/ExpenseBot_FIXED.gs',
    '',
    'FILE INDEX:',
  ];
  for (const f of files) {
    const rel = path.relative(REPO_ROOT, f);
    const kb = (fileSizeBytes(f) / 1024).toFixed(1);
    lines.push('  ' + rel.padEnd(60) + ' (' + kb + ' KB)');
  }
  lines.push('');
  lines.push('=' .repeat(80));
  return lines.join('\n');
}

// Returns an ARRAY of section strings — one per part. Lets the bucket
// packer drop big-file parts into separate chunks instead of welding them
// together as a single huge section.
function buildFileSections(absPath) {
  const rel = path.relative(REPO_ROOT, absPath);
  const pieces = chunkLargeFile(absPath, rel);
  if (pieces.length === 1 && pieces[0].isBinary) {
    return ['\n\n' + '='.repeat(80) + '\nFILE: ' + rel + '\n' + '='.repeat(80) + '\n[BINARY FILE -- skipped]\n'];
  }
  if (pieces.length === 1) {
    return ['\n\n' + '='.repeat(80) + '\nFILE: ' + rel + '\n' + '='.repeat(80) + '\n' + pieces[0].content];
  }
  return pieces.map(p => {
    const header = 'FILE: ' + rel + '  (part ' + p.part.num + '/' + p.part.total +
      ', lines ' + p.part.startLine + '-' + p.part.endLine + ')';
    return '\n\n' + '='.repeat(80) + '\n' + header + '\n' + '='.repeat(80) + '\n' + p.content;
  });
}

// Group files into upload chunks by area, so each chunk fits in an LLM
// context window (DeepSeek caps ~128K tokens ~= 500KB plain text).
function classifyArea(relPath) {
  if (relPath.startsWith('bot/'))     return '01_bot';
  if (relPath.startsWith('api/'))     return '02_api';
  if (relPath.startsWith('lib/'))     return '03_lib';
  if (relPath.startsWith('tests/'))   return '04_tests';
  if (relPath.startsWith('scripts/')) return '05_scripts';
  if (relPath.startsWith('admin/') || relPath.startsWith('help/') || relPath.startsWith('tools/') || relPath.endsWith('.html')) {
    return '06_web';
  }
  return '07_docs_and_config';
}

function main() {
  console.log('Collecting files...');
  const files = collectFiles();
  console.log('Including ' + files.length + ' files.');

  // Bucket files by area.
  const buckets = {};
  for (const f of files) {
    const rel = path.relative(REPO_ROOT, f);
    const area = classifyArea(rel);
    if (!buckets[area]) buckets[area] = [];
    buckets[area].push(f);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const exportDir = path.join(REPO_ROOT, 'kesefle_export_' + stamp);
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

  // Per-area chunk files, sub-split when a bucket exceeds the byte cap.
  const chunkSummaries = [];
  for (const area of Object.keys(buckets).sort()) {
    const list = buckets[area];
    let partIdx = 1;
    let currentBytes = 0;
    let currentParts = [];

    function flush() {
      if (!currentParts.length) return;
      const suffix = '_p' + partIdx;
      const partFileName = area + suffix + '.txt';
      const header = [
        'KESEFLE EXPORT — AREA: ' + area + '   PART: ' + partIdx,
        'Date: ' + new Date().toISOString(),
        '',
        '='.repeat(80),
      ].join('\n');
      const body = currentParts.join('\n');
      fs.writeFileSync(path.join(exportDir, partFileName), header + body, 'utf8');
      const mb = (currentBytes / (1024 * 1024)).toFixed(2);
      chunkSummaries.push({ area, file: partFileName, sizeMb: mb });
      console.log('  ' + partFileName.padEnd(28) + ' ' + mb + ' MB');
      partIdx++;
      currentBytes = 0;
      currentParts = [];
    }

    for (const f of list) {
      const sections = buildFileSections(f); // array — one per file part
      for (const section of sections) {
        const sz = Buffer.byteLength(section, 'utf8');
        // Flush BEFORE adding if the new piece would overflow the chunk.
        if (currentBytes && currentBytes + sz > CHUNK_TARGET_BYTES) flush();
        currentParts.push(section);
        currentBytes += sz;
      }
    }
    flush();
  }

  // Top-level manifest with upload guidance.
  const manifestLines = [
    'KESEFLE CODEBASE EXPORT FOR EXTERNAL REVIEW',
    'Date: ' + new Date().toISOString(),
    'Total files: ' + files.length,
    '',
    'WHAT TO UPLOAD',
    '',
    'DeepSeek Chat caps at ~128K tokens (~500KB). Upload chunks one at a time',
    'in this order — each chunk is self-contained per area:',
    '',
  ];
  for (const s of chunkSummaries) {
    manifestLines.push('  ' + s.file.padEnd(30) + ' ' + s.sizeMb.padStart(6) + ' MB   (' + s.files + ' files)');
  }
  manifestLines.push('');
  manifestLines.push('SUGGESTED PROMPT for the external LLM:');
  manifestLines.push('');
  manifestLines.push('  "This is the Kesefle codebase, a Hebrew-first multi-tenant WhatsApp');
  manifestLines.push('  expense tracker. Audit for: security holes, dead code, mismatched');
  manifestLines.push('  contracts between bot and api, missing tests, perf issues, UX bugs.');
  manifestLines.push('  For each finding, give file:line + concrete fix."');
  manifestLines.push('');
  manifestLines.push('STACK');
  manifestLines.push('  - bot/         Apps Script (Hebrew bot, manual paste deploy)');
  manifestLines.push('  - api/         Vercel serverless ESM endpoints');
  manifestLines.push('  - lib/         shared utils (auth, KV, Pa\'amonim categories, etc.)');
  manifestLines.push('  - tests/       node-runnable QA');
  manifestLines.push('  - *.html       public pages (kesefle.com)');
  manifestLines.push('');
  manifestLines.push('KEY ENTRYPOINTS');
  manifestLines.push('  - bot/ExpenseBot_FIXED.gs   doPost = WhatsApp webhook (~9K lines)');
  manifestLines.push('  - api/sheet/append.js       writes a row to the user\'s Google Sheet');
  manifestLines.push('  - lib/auth.js               requireAuth/requireAdmin guards');
  manifestLines.push('  - lib/categories.js         Pa\'amonim 17-group taxonomy');
  manifestLines.push('');
  const manifestPath = path.join(exportDir, '00_README.txt');
  fs.writeFileSync(manifestPath, manifestLines.join('\n'), 'utf8');

  // Also produce a single combined file (for tools that accept large uploads).
  const combinedHeader = buildManifest(files);
  const combinedParts = [combinedHeader];
  for (const f of files) {
    for (const s of buildFileSections(f)) combinedParts.push(s);
  }
  const combinedPath = path.join(REPO_ROOT, 'kesefle_export_' + stamp + '_full.txt');
  fs.writeFileSync(combinedPath, combinedParts.join('\n'), 'utf8');
  const combinedSize = (fs.statSync(combinedPath).size / (1024 * 1024)).toFixed(2);

  console.log('');
  console.log('Chunks dir:    ' + exportDir);
  console.log('Combined file: ' + combinedPath + '  (' + combinedSize + ' MB)');
  console.log('');
  console.log('-> For DeepSeek (or any 128K-context LLM): upload each chunk in order.');
  console.log('-> For Claude/Gemini long-context: upload the _full.txt instead.');
}

main();
