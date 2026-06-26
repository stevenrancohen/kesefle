#!/usr/bin/env node
// scripts/gen-blog-feed.js
//
// Regenerate blog/feed.xml from the actual blog post pages so the RSS feed never
// drifts from what's published (audit #17: the hand-maintained feed was missing
// 24 of 39 posts with a frozen lastBuildDate). Re-run after adding any post:
//   node scripts/gen-blog-feed.js
//
// Each post contributes: canonical URL (link+guid), title (og:title, brand
// suffix stripped), meta description, and datePublished (from JSON-LD) -> pubDate.
// lastBuildDate = the newest post's date (honest freshness, deterministic output).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BLOG_DIR = path.join(ROOT, 'blog');
const OUT = path.join(BLOG_DIR, 'feed.xml');
const SITE = 'https://kesefle.com';

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function pick(html, re) { const m = html.match(re); return m ? m[1].trim() : null; }
function rfc822(dateStr) {
  // dateStr "YYYY-MM-DD" -> "Mon, 18 May 2026 09:00:00 +0300" (fixed IL morning
  // slot). Anchor at 09:00 +0300 = 06:00 UTC and read UTC fields so output is
  // independent of the machine's local timezone.
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 6, 0, 0));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${days[dt.getUTCDay()]}, ${pad(dt.getUTCDate())} ${mons[dt.getUTCMonth()]} ` +
    `${dt.getUTCFullYear()} 09:00:00 +0300`;
}

const files = fs.readdirSync(BLOG_DIR)
  .filter((f) => f.endsWith('.html') && f !== 'index.html');

const items = [];
for (const f of files) {
  const html = fs.readFileSync(path.join(BLOG_DIR, f), 'utf8');
  const canonical = pick(html, /<link\s+rel="canonical"\s+href="([^"]+)"/i)
    || `${SITE}/blog/${f.replace(/\.html$/, '')}`;
  let title = pick(html, /<meta\s+property="og:title"\s+content="([^"]+)"/i)
    || pick(html, /<title>([^<]+)<\/title>/i) || f;
  title = title.replace(/\s*[—|-]\s*כספ'?לה\s*$/u, '').trim();
  const description = pick(html, /<meta\s+name="description"\s+content="([^"]+)"/i) || '';
  const datePublished = pick(html, /"datePublished"\s*:\s*"([0-9]{4}-[0-9]{2}-[0-9]{2})"/i) || '2026-05-18';
  items.push({ canonical, title, description, datePublished });
}

// newest first; tie-break by title for stable output
items.sort((a, b) => (a.datePublished < b.datePublished ? 1 : a.datePublished > b.datePublished ? -1
  : a.title.localeCompare(b.title)));

const newest = items.length ? items[0].datePublished : '2026-05-18';
const build = rfc822(newest);

const head = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>כספ'לה — בלוג</title>
    <link>${SITE}/blog</link>
    <description>מדריכים פרקטיים בעברית על ניהול כסף, מעקב הוצאות, תקציב משפחתי, ותזרים מזומנים לעצמאים ועסקים קטנים בישראל.</description>
    <language>he</language>
    <copyright>© 2026 כספ'לה. כל הזכויות שמורות.</copyright>
    <lastBuildDate>${build}</lastBuildDate>
    <pubDate>${build}</pubDate>
    <ttl>1440</ttl>
    <generator>Kesefle (scripts/gen-blog-feed.js)</generator>
    <image>
      <url>${SITE}/icon-512.png</url>
      <title>כספ'לה — בלוג</title>
      <link>${SITE}/blog</link>
    </image>
    <atom:link href="${SITE}/blog/feed.xml" rel="self" type="application/rss+xml" />
`;

const body = items.map((it) => `
    <item>
      <title>${xmlEscape(it.title)}</title>
      <link>${xmlEscape(it.canonical)}</link>
      <guid isPermaLink="true">${xmlEscape(it.canonical)}</guid>
      <pubDate>${rfc822(it.datePublished)}</pubDate>
      <description>${xmlEscape(it.description)}</description>
    </item>`).join('');

const xml = head + body + `
  </channel>
</rss>
`;

fs.writeFileSync(OUT, xml);
console.log(`gen-blog-feed: wrote ${items.length} items to blog/feed.xml (lastBuildDate ${newest})`);
