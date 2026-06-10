#!/usr/bin/env node
// Inject a standardized "related posts" block (id="kfl-related") into every blog post.
// Idempotent: a post that already contains id="kfl-related" is skipped.
// Injection point: immediately before the post's <footer ...> tag (every post has
// exactly one); falls back to </body> if no footer exists.
// Links use cleanUrls form: /blog/slug (no .html).
// Usage: node scripts/add-related-posts.mjs [--dry-run]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'blog');
const DRY_RUN = process.argv.includes('--dry-run');

const MAPPING = {"posts":[{"file":"airbnb-balebait-niyul-hochaot.html","title":"מארח Airbnb? איך לעקוב אחרי הכנסות והוצאות","related":["atzmaim-yesh-derekh-tova-yoter.html","lebanim-le-meofim-aharei-bituach-leumi.html","maam-leasamaim-derech-watsap.html"]},{"file":"alut-achzakat-rechev.html","title":"עלות אחזקת רכב — כמה באמת עולה לכם הרכב","related":["hotzaot-kvuot-horaot-keva.html","bituach-chaim-briut-alut.html","eich-lachsoch-kesef-kol-chodesh.html"]},{"file":"app-hochaot-chinam.html","title":"אפליקציה להוצאות חינם — האם זה באמת חינם?","related":["whatsapp-budget-tools-comparison.html","hashvaaa-vs-google-sheets.html","maakav-otomati-vs-excel.html"]},{"file":"atzmai-mul-sachir-mas.html","title":"עצמאי מול שכיר — מה עדיף מבחינת מס","related":["hachzer-mas-sachir.html","lebanim-le-meofim-aharei-bituach-leumi.html","hanhalat-cheshbonot-atzmai.html"]},{"file":"atzmaim-yesh-derekh-tova-yoter.html","title":"עצמאים: יש דרך טובה יותר לעקוב אחרי הוצאות עסקיות","related":["expense-tracking-freelancer.html","nihul-hochaot-le-atzmaim.html","maam-leasamaim-derech-watsap.html"]},{"file":"avoda-mehabait-mas-erech-mosaf.html","title":"עובד מהבית? הפרדת הוצאות לצורך מע\"מ","related":["maam-leasamaim-derech-watsap.html","atzmai-mul-sachir-mas.html","hanhalat-cheshbonot-atzmai.html"]},{"file":"bituach-chaim-briut-alut.html","title":"ביטוח חיים ובריאות — כמה זה עולה","related":["hotzaot-kvuot-horaot-keva.html","alut-achzakat-rechev.html","chisachon-pensiya.html"]},{"file":"budget-vs-cashflow.html","title":"תקציב לעומת תזרים מזומנים — מה ההבדל באמת ולמה זה משנה לעצמאי","related":["tazrim-mezumanim-esek-katan.html","nihul-taktziv-atzmaim.html","expense-tracking-freelancer.html"]},{"file":"chinuch-pinansi-yeladim.html","title":"חינוך פיננסי לילדים וחיסכון לילד — מדריך","related":["hoffaot-yeladim-cheshbon-mishutaf.html","taktziv-mishpachti-bwatsap.html","kupat-gemel-lehashkaa.html"]},{"file":"chisachon-alafim-bawatsap.html","title":"איך לחסוך אלפי שקלים בשנה עם מעקב הוצאות אוטומטי","related":["eich-lachsoch-kesef-kol-chodesh.html","maakav-otomati-vs-excel.html","taktziv-mishpachti-bwatsap.html"]},{"file":"chisachon-pensiya.html","title":"חיסכון לפנסיה — מדריך תכנון פנסיוני פשוט","related":["keren-hishtalmut.html","kupat-gemel-lehashkaa.html","hashkaot-lematchilim.html"]},{"file":"eich-lachsoch-kesef-kol-chodesh.html","title":"איך לחסוך כסף כל חודש — מדריך פרקטי","related":["chisachon-alafim-bawatsap.html","klal-50-30-20.html","keren-cherum.html"]},{"file":"expense-tracking-freelancer.html","title":"איך עצמאי בישראל יכול לעקוב אחרי הוצאות בלי לשגע את עצמו — מדריך 2026","related":["atzmaim-yesh-derekh-tova-yoter.html","nihul-hochaot-le-atzmaim.html","hanhalat-cheshbonot-atzmai.html"]},{"file":"hachzer-mas-sachir.html","title":"החזר מס לשכירים — מי זכאי ואיך מקבלים","related":["atzmai-mul-sachir-mas.html","keren-hishtalmut.html","maam-leasamaim-derech-watsap.html"]},{"file":"hanhalat-cheshbonot-atzmai.html","title":"הנהלת חשבונות לעצמאי — לבד או רו\"ח?","related":["expense-tracking-freelancer.html","maam-leasamaim-derech-watsap.html","lebanim-le-meofim-aharei-bituach-leumi.html"]},{"file":"hashkaot-lematchilim.html","title":"השקעות למתחילים — איך מתחילים להשקיע נכון","related":["kupat-gemel-lehashkaa.html","keren-hishtalmut.html","chisachon-pensiya.html"]},{"file":"hashvaaa-vs-google-sheets.html","title":"למה גיליון Google משלך עדיף על אפליקציה סגורה","related":["app-hochaot-chinam.html","maakav-otomati-vs-excel.html","whatsapp-budget-tools-comparison.html"]},{"file":"hoffaot-yeladim-cheshbon-mishutaf.html","title":"כמה באמת עולה לגדל ילד בישראל ב-2026","related":["chinuch-pinansi-yeladim.html","taktziv-mishpachti-bwatsap.html","maakav-hotzaot-zugot.html"]},{"file":"hotzaot-kvuot-horaot-keva.html","title":"הוצאות קבועות והוראות קבע — לשלוט","related":["bituach-chaim-briut-alut.html","alut-achzakat-rechev.html","eich-lachsoch-kesef-kol-chodesh.html"]},{"file":"keren-cherum.html","title":"קרן חירום — כמה צריך ואיך בונים","related":["eich-lachsoch-kesef-kol-chodesh.html","yetsia-mechovot.html","kupat-gemel-lehashkaa.html"]},{"file":"keren-hishtalmut.html","title":"קרן השתלמות — המדריך המלא להטבת המס","related":["kupat-gemel-lehashkaa.html","chisachon-pensiya.html","hachzer-mas-sachir.html"]},{"file":"klal-50-30-20.html","title":"כלל 50/30/20 לתקציב — מדריך פשוט","related":["shitat-hamaatafot.html","eich-lachsoch-kesef-kol-chodesh.html","taktziv-mishpachti-bwatsap.html"]},{"file":"kupat-gemel-lehashkaa.html","title":"קופת גמל להשקעה — מה זה ואיך עובד","related":["keren-hishtalmut.html","hashkaot-lematchilim.html","chisachon-pensiya.html"]},{"file":"lebanim-le-meofim-aharei-bituach-leumi.html","title":"פתחתי עוסק חדש: מדריך להתנהלות פיננסית","related":["atzmai-mul-sachir-mas.html","hanhalat-cheshbonot-atzmai.html","nihul-taktziv-atzmaim.html"]},{"file":"maakav-hochaot-be-ivrit.html","title":"מעקב הוצאות בעברית — למה זה משנה?","related":["maakav-otomati-vs-excel.html","app-hochaot-chinam.html","whatsapp-budget-tools-comparison.html"]},{"file":"maakav-hotzaot-zugot.html","title":"מעקב הוצאות לזוגות — בלי ריבים על כסף","related":["zugot-cheshbonot-mishutafim.html","taktziv-mishpachti-bwatsap.html","tipul-mishpacha-bawatsap.html"]},{"file":"maakav-otomati-vs-excel.html","title":"מעקב הוצאות אוטומטי — למה אקסל כבר לא מספיק","related":["hashvaaa-vs-google-sheets.html","chisachon-alafim-bawatsap.html","app-hochaot-chinam.html"]},{"file":"maam-leasamaim-derech-watsap.html","title":"החזר מע״מ לעצמאים — איך עוקבים אחרי הוצאות עסקיות בוואטסאפ","related":["avoda-mehabait-mas-erech-mosaf.html","atzmaim-yesh-derekh-tova-yoter.html","hanhalat-cheshbonot-atzmai.html"]},{"file":"michzur-mashkanta.html","title":"מחזור משכנתא — מתי משתלם וכמה חוסכים","related":["yetsia-mechovot.html","hotzaot-kvuot-horaot-keva.html","eich-lachsoch-kesef-kol-chodesh.html"]},{"file":"nihul-hochaot-le-atzmaim.html","title":"ניהול הוצאות לעצמאים: 7 כלים שעובדים ב-2026","related":["expense-tracking-freelancer.html","nihul-taktziv-atzmaim.html","atzmaim-yesh-derekh-tova-yoter.html"]},{"file":"nihul-taktziv-atzmaim.html","title":"ניהול תקציב לעצמאים — המדריך המלא לשנת 2026","related":["budget-vs-cashflow.html","nihul-hochaot-le-atzmaim.html","tazrim-mezumanim-esek-katan.html"]},{"file":"shitat-hamaatafot.html","title":"שיטת המעטפות לתקציב — איך זה עובד","related":["klal-50-30-20.html","eich-lachsoch-kesef-kol-chodesh.html","taktziv-mishpachti-bwatsap.html"]},{"file":"taktziv-mishpachti-bwatsap.html","title":"תקציב משפחתי בוואטסאפ — מדריך מלא ל-2026","related":["tipul-mishpacha-bawatsap.html","maakav-hotzaot-zugot.html","klal-50-30-20.html"]},{"file":"tazrim-mezumanim-esek-katan.html","title":"תזרים מזומנים לעסק קטן — מדריך מעשי","related":["budget-vs-cashflow.html","nihul-taktziv-atzmaim.html","lebanim-le-meofim-aharei-bituach-leumi.html"]},{"file":"tipul-mishpacha-bawatsap.html","title":"למה כדאי לך לנהל תקציב משפחתי בוואטסאפ","related":["taktziv-mishpachti-bwatsap.html","maakav-hotzaot-zugot.html","chisachon-alafim-bawatsap.html"]},{"file":"whatsapp-budget-tools-comparison.html","title":"כספ'לה מול האפליקציות הקיימות — מה ההבדל?","related":["app-hochaot-chinam.html","hashvaaa-vs-google-sheets.html","maakav-otomati-vs-excel.html"]},{"file":"whatsapp-business-tools.html","title":"5 כלים שמשנים את הדרך שבה עסקים ישראליים משתמשים בוואטסאפ ב-2026","related":["maam-leasamaim-derech-watsap.html","nihul-hochaot-le-atzmaim.html","atzmaim-yesh-derekh-tova-yoter.html"]},{"file":"yetsia-mechovot.html","title":"יציאה מחובות — תוכנית להחזר הלוואות","related":["keren-cherum.html","michzur-mashkanta.html","eich-lachsoch-kesef-kol-chodesh.html"]},{"file":"zugot-cheshbonot-mishutafim.html","title":"חשבון בנק משותף לזוגות: 4 דגמים","related":["maakav-hotzaot-zugot.html","taktziv-mishpachti-bwatsap.html","tipul-mishpacha-bawatsap.html"]}]};

const titleByFile = new Map(MAPPING.posts.map((p) => [p.file, p.title]));

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildBlock(relatedFiles, containerWidth) {
  const items = relatedFiles
    .map((rf) => {
      const slug = rf.replace(/\.html$/, '');
      const title = titleByFile.get(rf);
      if (!title) throw new Error('related file not in mapping: ' + rf);
      return (
        '      <li><a href="/blog/' + slug + '" class="font-bold text-brand-600 hover:underline dark:text-brand-400">' +
        escapeHtml(title) +
        '</a></li>'
      );
    })
    .join('\n');
  return [
    '<section id="kfl-related" dir="rtl" class="pb-14 md:pb-20">',
    '  <div class="mx-auto ' + containerWidth + ' px-5">',
    '    <h2 class="text-2xl font-black dark:text-white">קראו גם</h2>',
    '    <ul class="mt-4 space-y-2 text-base">',
    items,
    '    </ul>',
    '  </div>',
    '</section>',
    '',
    '',
  ].join('\n');
}

let modified = 0;
const skipped = [];
const failed = [];

for (const post of MAPPING.posts) {
  const path = join(BLOG_DIR, post.file);
  try {
    if (!existsSync(path)) throw new Error('post file missing on disk');
    for (const rf of post.related) {
      if (!existsSync(join(BLOG_DIR, rf))) throw new Error('related target missing on disk: ' + rf);
    }
    const html = readFileSync(path, 'utf8');
    if (html.includes('id="kfl-related"')) {
      skipped.push(post.file);
      continue;
    }
    // Match the post's own article column width (two layout generations exist).
    const containerWidth = html.includes('max-w-2xl') ? 'max-w-2xl' : 'max-w-3xl';
    const block = buildBlock(post.related.slice(0, 3), containerWidth);

    const footerIdx = html.lastIndexOf('<footer');
    const bodyIdx = html.lastIndexOf('</body>');
    const insertAt = footerIdx !== -1 ? footerIdx : bodyIdx;
    if (insertAt === -1) throw new Error('no <footer> or </body> found');

    const out = html.slice(0, insertAt) + block + html.slice(insertAt);
    if (!DRY_RUN) writeFileSync(path, out, 'utf8');
    modified++;
    console.log((DRY_RUN ? '[dry-run] would inject: ' : 'injected: ') + post.file + ' (' + containerWidth + ')');
  } catch (e) {
    failed.push(post.file + ' -- ' + e.message);
    console.error('FAILED: ' + post.file + ' -- ' + e.message);
  }
}

console.log('\nSummary: modified=' + modified + ' skipped=' + skipped.length + ' failed=' + failed.length + ' of ' + MAPPING.posts.length);
if (skipped.length) console.log('Skipped (already have kfl-related): ' + skipped.join(', '));
if (failed.length) {
  console.log('Failed: ' + failed.join(' | '));
  process.exit(1);
}
