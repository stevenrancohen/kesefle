// Cinematic motion layer (kfx) guard. Pure static checks, no network.
//
// Locks in:
//   - every public page carries the generated kfx block, exactly once, and
//     scripts/kfx/rollout.js --check would report it up to date
//   - app / admin / account pages never get it
//   - the libraries are self-hosted and versioned (no CDN in the block)
//   - the boot snippet hands motion over only when reduced motion is off and
//     keeps the explicit light choice from the theme toggle
//   - legacy inline motion steps aside instead of running twice
//   - the homepage carries the story, before/after and 3D sections with a
//     readable final state, and the new Hebrew copy has no dashes
//
// Run: node tests/test_kfx_motion.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const rollout = require(path.join(ROOT, 'scripts', 'kfx', 'rollout.js'));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  x ' + name + (extra ? '  ' + extra : ''));
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 1. files
const FILES = [
  'css/kfx-motion.css', 'css/lenis.css', 'js/kfx-motion.js', 'js/kfx-home.js', 'js/kfx-phone3d.mjs',
  'js/vendor/gsap.min.js', 'js/vendor/ScrollTrigger.min.js', 'js/vendor/SplitText.min.js', 'js/vendor/lenis.min.js',
  'js/vendor/LICENSES.md', 'scripts/kfx/phone3d.src.mjs', 'scripts/kfx/build-phone3d.sh'
];
FILES.forEach((f) => ok('file exists: ' + f, fs.existsSync(path.join(ROOT, f))));
['js/kfx-motion.js', 'js/kfx-home.js'].forEach((f) => {
  let parsed = true;
  try { new vm.Script(read(f), { filename: f }); } catch (e) { parsed = false; }
  ok('parses as a classic script: ' + f, parsed);
});
ok('3D bundle is an ES module exporting mount', /export\s*\{[^}]*\bmount\b/.test(read('js/kfx-phone3d.mjs')));
ok('three.js license kept in the bundle', /Three\.js Authors/.test(read('js/kfx-phone3d.mjs')));
ok('GSAP license banner kept', /gsap\.com\/standard-license/.test(read('js/vendor/gsap.min.js')));

// 2. every public page: one block, current, self-hosted
const pages = rollout.listPages();
ok('rollout finds the public pages', pages.length >= 90, 'found ' + pages.length);
const stale = [], dup = [], cdn = [];
pages.forEach((rel) => {
  const html = read(rel);
  const n = (html.match(/<!-- kfx:begin/g) || []).length;
  if (n !== 1) dup.push(rel + ' x' + n);
  if (rollout.apply(html, rollout.profileOf(rel)) !== html) stale.push(rel);
  const m = html.match(/<!-- kfx:begin[\s\S]*?<!-- kfx:end -->/);
  if (m && /https?:\/\//.test(m[0])) cdn.push(rel);
});
ok('each public page has exactly one kfx block', dup.length === 0, dup.slice(0, 5).join(', '));
ok('kfx blocks are up to date (run node scripts/kfx/rollout.js)', stale.length === 0, stale.slice(0, 5).join(', '));
ok('kfx block loads nothing from a CDN', cdn.length === 0, cdn.slice(0, 5).join(', '));
ok('homepage profile is home and loads kfx-home.js', /<meta name="kfx-profile" content="home">[\s\S]*\/js\/kfx-home\.js\?v=/.test(read('index.html')));
ok('blog posts use the article profile', /<meta name="kfx-profile" content="article">/.test(read('blog/budget-vs-cashflow.html')));
ok('only the homepage arms the preloader', !/classList\.add\('kfx-preload'\)/.test(read('pricing.html').match(/<!-- kfx:begin[\s\S]*?<!-- kfx:end -->/)[0]) && /classList\.add\('kfx-preload'\)/.test(read('index.html')));

// 3. private pages stay untouched
['account.html', 'app.html', 'dashboard.html', 'admin.html', 'expense.html', 'offline.html', 'test.html'].forEach((rel) => {
  if (!fs.existsSync(path.join(ROOT, rel))) return;
  ok('no kfx on ' + rel, !/kfx:begin|kfx-motion/.test(read(rel)));
});

// 4. boot snippet contract
const boot = rollout.block('home');
ok('boot: legacy flags only set when reduced motion is off', /if\(rm\)\{h\.classList\.add\('kfx-reduced'\)\}else\{w\.kflPremiumMotionInit=true;w\.kflParallaxInit=true;/.test(boot));
ok('boot: never forces a theme (white + blue stays, the page toggle decides)', !/classList\.add\('dark'\)/.test(boot) && !/kesefle_theme/.test(boot));
ok('boot: failsafe shows everything if the engine never starts', /kfx-fail/.test(boot) && /3500/.test(boot));
ok('boot: scripts are deferred and versioned', /<script defer src="\/js\/kfx-motion\.js\?v=/.test(boot));
const css = read('css/kfx-motion.css');
ok('css: reduced motion switches the decorative layers off', /@media \(prefers-reduced-motion: reduce\)/.test(css));
ok('css: failsafe reveals legacy and kfx hidden blocks', /html\.kfx-fail \.kfl-reveal/.test(css));
ok('css: the page can never get wider than the screen', /html\.kfx-js body \{ overflow-x: clip; \}/.test(css));

// 5. legacy inline motion steps aside
const unguarded = [];
pages.forEach((rel) => {
  const html = read(rel);
  if (/\(function premiumMotion\(\)\{\n(?!\s*if \(window\.kflPremiumMotionInit\) return;)/.test(html)) unguarded.push(rel + ' premiumMotion');
  if (/\(function parallaxBlobs\(\)\{\n(?!\s*if \(window\.kflParallaxInit\) return;)/.test(html)) unguarded.push(rel + ' parallaxBlobs');
  if (/[^(]document\.querySelectorAll\('\.kfl-magnetic[^']*'\)\.forEach/.test(html)) unguarded.push(rel + ' kfl-magnetic');
  if (/var targets = document\.querySelectorAll\('a\.magnetic-cta/.test(html)) unguarded.push(rel + ' magnetic-cta');
});
ok('legacy reveal / parallax / magnetic scripts are guarded', unguarded.length === 0, unguarded.slice(0, 5).join(', '));

// 6. homepage sections
const home = read('index.html');
['kfx-story', 'kfx-compare', 'kfx-3d'].forEach((id) => ok('homepage has #' + id, home.indexOf('id="' + id + '"') !== -1));
ok('story final state is in the markup (lit row, final balance)', /kfx-row-new is-lit/.test(home) && /data-kfx-spent>3,425 ₪</.test(home) && /data-kfx-left>1,575 ₪</.test(home));
ok('story stage is decorative for screen readers, steps stay readable', /class="kfx-story__stage" aria-hidden="true"/.test(home) && /<ol class="kfx-story__steps">/.test(home));
ok('before/after has a keyboard range with a label', /class="kfx-compare__range" type="range"[^>]*aria-label="/.test(home));
ok('3D viewer points at the versioned module and keeps a CSS fallback', /data-kfx-3d="\/js\/kfx-phone3d\.mjs\?v=/.test(home) && /kfx-3d__fallback/.test(home));
const sections = ['kfx-story', 'kfx-compare', 'kfx-3d'].map((id) => {
  const i = home.indexOf('id="' + id + '"');
  return home.slice(i, home.indexOf('</section>', i));
}).join('\n');
const text = sections.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ');
ok('new copy has no em or en dash', !/[–—]/.test(text));
ok('new copy has no spaced hyphen', !/\s-\s/.test(text));
ok('new copy has no dual gender slash forms', !/[א-ת]{2,}\/[יה](?![א-ת])/.test(text));
ok('new copy has no bidi control characters', !/[‎‏‪-‮⁦-⁩]/.test(sections));

console.log((fail ? '❌' : '✅') + ' kfx motion layer: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
