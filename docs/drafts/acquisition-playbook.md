# Kesefle — Acquisition Playbook: First 50 REAL Israeli Users

**Status:** draft · 2026-06-10
**Goal:** 50 real, active Israeli users (linked sheet + ≥3 expenses logged), not 50 signups.
**Principle:** at n=0 you are not selling a product, you are recruiting beta partners. The ask is
"try it and tell me what broke," never "buy this."

Everything here is grounded in the repo as it exists today:

- Live bot number: **+972 54-776-0643** → join link `https://wa.me/972547760643` (used on
  `start.html` and all 4 SEO landing pages).
- Onboarding: open the wa.me link → send **שלום** → bot replies in ~2 seconds with guided setup
  (`start.html`: "ארבע דקות, ואתם עם בוט הוצאות פעיל בוואטסאפ").
- Free tier exists ("חינם להתחלה" on every landing page); Pro ₪19/mo (₪190/yr), Family ₪39/mo
  (₪390/yr) per `pricing.html`.
- Referral loop already built: `/referral` — **חודש Pro חינם לשניכם**, no credit card.
- Activation plumbing just fixed: link-code bug (#294) + activation metric on admin (#295). The
  funnel is finally measurable — which is exactly why now is the time to push real users in.

---

## Pre-flight: fix BEFORE sending a single human to the site

| # | Item | Owner |
|---|------|-------|
| 0 | **`index.html` still links to the Meta TEST number** `wa.me/15556408123` in 3 places (lines ~74 JSON-LD, ~1614 CTA card, ~1666 footer). `dashboard.html` too. Anyone who clicks the homepage WhatsApp CTA hits a dead sandbox number. Every other page already uses `972547760643`. | [AI-CAN-PREP] PR, [STEVEN-MUST] merge |
| 1 | End-to-end self-test from a phone that has never registered: wa.me link → שלום → onboarding → log `42 קפה` → row lands in the new sheet → dashboard sums it. | [STEVEN-MUST] (5 min) |
| 2 | Confirm the WhatsApp **display name** shows כספלה/Kesefle, not a bare number (see `docs/WHATSAPP_DISPLAY_NAME.md`). Strangers don't message anonymous numbers. | [STEVEN-MUST] |
| 3 | Confirm Meta business verification / messaging-limit tier is sufficient (see `docs/META_BUSINESS_VERIFICATION.md`). 50 users is fine even at the lowest tier **as long as users initiate** (wa.me click = user-initiated session). The bot must never cold-message — policy + spam. | [STEVEN-MUST] verify, [AI-CAN-PREP] checklist |
| 4 | Watch the activation card daily (#295). If signups come in but don't link a sheet, STOP outreach and fix the funnel — don't burn warm contacts on a broken flow. | [AI-CAN-PREP] daily digest already exists |

---

## The five channels, ranked by speed-to-first-user

| # | Channel | First user in | Realistic yield toward 50 | Cost |
|---|---------|--------------|---------------------------|------|
| 1 | Personal network + friends-of-friends WhatsApp | **Today** | 10–20 | Free |
| 2 | Israeli freelancer/self-employed Facebook groups | 2–7 days | 10–20 | Free |
| 3 | Accountant / bookkeeper partnerships | 1–3 weeks to first, then batches | 10–15 | Free |
| 4 | Content/SEO (the long game) | Weeks–months | 0–5 within this push | Free |
| 5 | Community forums (Tapuz†/Reddit/hasolidit) | Days–weeks | 3–8 | Free |

†Honest note below — Tapuz forums are mostly dead; the live equivalents are named in §5.
Channels 4–5 are kept in the brief's order, but note forums will likely produce a user **before**
SEO does. SEO is ranked 4 because the asset work compounds; it is not a week-one user source.

---

## Channel 1 — Personal network + friends-of-friends WhatsApp

**Why first:** zero trust barrier, instant feedback loop, and WhatsApp is literally where the
product lives — the demo IS the channel. Your first 10 users should be people who will tell you
the truth when onboarding confuses them.

**First concrete action this week** [STEVEN-MUST]:
1. List 20 names in three rings: (a) friends/family who complain about money chaos, (b) friends
   who are עצמאים (any עוסק פטור/מורשה you know), (c) couples managing a household budget.
2. Send the personal script below — individually, NOT a broadcast list (broadcasts only reach
   people who saved your number, and they feel like spam).
3. Within 24h of each "כן", check the admin activation card — if they signed up but didn't link,
   call them and watch them onboard. Every stumble is a bug report.
4. After their first week, send the referral ask (script 1b) — the `/referral` page gives both
   sides a free Pro month, so the forward is a gift, not a favor.

**Hebrew script 1a — personal first-touch (individual DM):**

> היי [שם], אני צריך ממך טובה קטנה של 4 דקות 🙏
> בניתי בוט וואטסאפ שעוקב אחרי הוצאות — שולחים לו הודעה כמו "45 סופר" והוא רושם, מקטלג ובונה לבד דשבורד בגיליון גוגל שלך. בלי אפליקציה ובחינם.
> אני מחפש עכשיו 10 אנשים ראשונים שינסו ויגידו לי בכנות מה שבור ומה מעצבן.
> שולחים "שלום" למספר הזה וזה מתחיל:
> https://wa.me/972547760643
> אם משהו נתקע — תצעקו עליי, בשביל זה אתם פה 😄

**Hebrew script 1b — friends-of-friends forward (sent after a friend is active ~1 week):**

> אהלן! רואה שאתה משתמש בכספלה כבר שבוע — ענק 🙏
> יש לי בקשה אחת: אם זה עוזר לך, תעביר לחבר אחד או שניים שמתאים להם. יש דף הזמנה שנותן **לשניכם חודש Pro חינם**, בלי כרטיס אשראי:
> https://kesefle.com/referral
> ואם זה לא שווה העברה — תגיד לי למה, זה בדיוק הפידבק שאני צריך.

**Expected effort:** 2–3 hours total this week (Steven), spread over evenings. Highest
conversion of any channel — expect 30–50% of warm asks to at least try it.

**Tags:** [STEVEN-MUST] send every message from his personal WhatsApp (this channel does not work
delegated). [AI-CAN-PREP] the contact-list template, per-ring message variants, a daily "who
signed up / who linked / who stalled" digest from the admin endpoints, and follow-up nudges.

**Honest failure mode:** friends say yes to be polite and never message the bot. Counter: the ask
is framed as a 4-minute favor with a deadline ("אני מחפש עכשיו 10 ראשונים"), and you follow up
once — exactly once — after 48h.

---

## Channel 2 — Israeli freelancer / self-employed Facebook groups

**Why second:** the `nihul-hotzaot-esek-katan.html` page already targets exactly this audience
(עוסק פטור/מורשה, דוח רווח והפסד, סימון מע״מ). Israeli freelancer Facebook groups are large,
active, and full of weekly "איך אתם עוקבים אחרי הוצאות?" threads. But they ban drive-by promo —
the play is answer-first, promo only where allowed.

**Realistic group TYPES to search for on Facebook** (search terms; join 5–8, no more):
- General self-employed: groups named around **"עצמאים בישראל"**, **"עצמאיות ועצמאים — טיפים"**,
  **"פרילנסרים בישראל"**.
- Tax-status Q&A: **"עוסק פטור"** / **"עוסק מורשה — שאלות ותשובות"** style groups — these are
  goldmines because expense tracking is the #1 recurring question.
- Niche professional groups: צלמים, מאמנים אישיים, קוסמטיקאיות, מורים פרטיים, הנדימנים,
  מנהלי סושיאל — smaller but higher trust; one good thread converts better than a big group.
- Women-in-business communities: **"נשים עצמאיות"** / **"אמהות יזמיות"** style groups — very
  active on money-admin pain.
- Family-budget / frugality communities (for the `nihul-taktziv-mishpachti.html` audience):
  groups around **"ניהול תקציב משפחתי"**, **"חיסכון למשפחה"**, **"חסכוניות"**-style communities.
- Local business groups: **"עסקים קטנים ב[עיר]"** for Steven's own city — local trust bonus.

(No member counts quoted on purpose — verify activity yourself: look for multiple posts per day
and admins who enforce rules. A dead 50k group is worth less than a live 3k group.)

**First concrete action this week** [STEVEN-MUST]:
1. Join 5 groups across the types above with the personal profile (groups distrust pages).
2. Read each group's rules; note which has a designated promo day/thread (common pattern:
   "יום שלישי שיווקי" or a weekly pinned promo thread).
3. Days 1–4: answer 2–3 existing questions about expense tracking/מע״מ/Excel WITHOUT linking.
4. Day 5+: post script 2a in ONE group that allows it (or its promo thread). Iterate per group.

**Hebrew script 2a — value-first group post (only where rules allow):**

> שאלה לעצמאים כאן: איך אתם רושמים הוצאות בפועל? 🧾
> אצלי זה תמיד נגמר בערימת קבלות וטבלת אקסל שמתעדכנת פעם בחודשיים, אז בניתי לעצמי פתרון — בוט וואטסאפ בעברית: שולחים לו "350 חומרי גלם" או צילום קבלה, והוא רושם, מקטלג, מסמן מע״מ ובונה דוח רווח והפסד בגיליון גוגל פרטי שלכם.
> אני בשלב שמחפש משתמשים ראשונים שיגידו לי מה חסר — זה חינם להתחלה, בלי אפליקציה:
> https://wa.me/972547760643
> (אני הבונה, אשמח לכל ביקורת — גם קטלנית.)

**Hebrew script 2b — comment reply under someone else's "how do you track expenses" thread:**

> בניתי בדיוק בשביל זה בוט וואטסאפ (גילוי נאות: אני היוצר). רושמים "120 דלק" בצ'אט והוא מסדר הכל בגיליון גוגל עם סיכום חודשי ומע״מ. עדיין בשלב מוקדם ואני מחפש פידבק — אם בא לך לנסות: https://wa.me/972547760643

**Expected effort:** 30–45 min/day for 2 weeks (Steven; reading + answering). One post per group
per week max.

**Tags:** [AI-CAN-PREP] group shortlist with rules summary, 6 post variants per audience type
(freelancer/family/niche), comment-reply bank, and a thread-tracking sheet. [STEVEN-MUST] join,
post, and reply as himself — groups detect and ban outsourced promo, and Hebrew authenticity
matters.

**Honest failure mode:** posting promo on day one → deleted + banned + brand damage in a small
ecosystem. Also: FB groups produce signups with the lowest activation of any warm channel —
expect half who click to never send שלום. Watch the #295 activation card per cohort.

---

## Channel 3 — Accountant / bookkeeper partnerships

**Why third:** slower to first user, but each partner is a repeating distribution node. רואי
חשבון, יועצי מס and מנהלות חשבונות feel the pain Kesefle solves — clients showing up with shoebox
receipts. A bot that makes the client arrive with a clean, categorized Google Sheet (with מע״מ
flags and a P&L — exactly what `nihul-hotzaot-esek-katan.html` promises) saves THEM hours. The
pitch is "your clients arrive organized," not "buy my product."

**First concrete action this week** [STEVEN-MUST]:
1. Message **your own accountant** (you run multiple businesses — they already know the pain of
   your receipts) with script 3a. Ask for: (a) their honest take, (b) 2–3 clients who'd pilot it.
2. Ask 2 self-employed friends from Channel 1: "מי רואה החשבון שלך? אפשר אזכור?" — warm intro
   beats cold outreach 10:1.
3. That's it for week one. Do NOT cold-email accountant lists at n=0 — no proof, no case study,
   no deck. This channel scales in week 3+ once 2–3 of their pilot clients are demonstrably
   active.

**Hebrew script 3a — to your own accountant (WhatsApp):**

> היי [שם], שאלה מקצועית קצרה:
> בניתי בוט וואטסאפ שבו העצמאי רושם הוצאות והכנסות בצ'אט ("350 חומרים", צילום קבלה) והכל נרשם אוטומטית בגיליון גוגל מסודר — קטגוריות, סימון מע״מ, ודוח רווח והפסד.
> בתור מי שמקבל מהלקוחות שלו שקיות קבלות — היה עוזר לך שלקוחות יגיעו ככה?
> אשמח שתנסה 5 דקות, ואם זה נראה לך — שניים-שלושה לקוחות שלך יקבלו ממני ליווי אישי + Pro חינם לתקופת הפיילוט.
> https://wa.me/972547760643

**Hebrew script 3b — warm-intro follow-up to a referred bookkeeper:**

> שלום [שם], קיבלתי את המספר שלך מ[חבר/ה] — אני בונה כלי בשם כספלה: רישום הוצאות לעצמאים דרך וואטסאפ, שמייצר גיליון גוגל מסודר עם מע״מ ורווח והפסד.
> אני מחפש שניים-שלושה אנשי מקצוע שיגידו לי אם זה באמת חוסך להם עבודה מול לקוחות. אפשר 10 דקות בטלפון השבוע?

**Expected effort:** 1 hour this week (two messages + one call). Ongoing: 1–2 calls/week.

**Tags:** [AI-CAN-PREP] a one-page Hebrew PDF for accountants ("מה הלקוח שלך מקבל, מה אתה
מקבל"), a sample anonymized sheet/P&L export to show, pilot-tracking doc, and later a partner
landing page. [STEVEN-MUST] every conversation — this is a trust-profession; bots pitching to
accountants about a bot is a bad look.

**Honest failure mode:** accountants are conservative and Q2–Q3 is not their crunch; expect slow
"נחמד, נדבר" replies. Don't gate the 50-user goal on this channel — treat every partner-sourced
user as a bonus until one partner has ≥3 active clients.

---

## Channel 4 — Content / SEO (the long game)

**Why fourth:** nothing here produces a user this week, but it is the only channel that compounds
while you sleep, and most of the asset base ALREADY EXISTS in the repo:

- 4 live SEO landing pages, each with the correct wa.me CTA:
  - `/maakav-hotzaot-whatsapp` — "מעקב הוצאות בוואטסאפ — בלי אפליקציה" (core keyword)
  - `/aplikatzia-maakav-hotzaot` — "אפליקציה למעקב הוצאות — בוואטסאפ" (app-intent searchers)
  - `/nihul-hotzaot-esek-katan` — "ניהול הוצאות לעסק קטן ולעצמאים" (freelancer/business intent)
  - `/nihul-taktziv-mishpachti` — "אפליקציית ניהול תקציב משפחתי" (family budget intent)
- A real Hebrew blog (`/blog/` — 15+ posts, incl. freelancer-targeted ones like
  `atzmaim-yesh-derekh-tova-yoter.html`, `expense-tracking-freelancer.html`).
- `docs/SEO_STRATEGY.md` (the honest version) + `docs/SEO_KEYWORDS.md` keyword→page map.

**First concrete actions this week:**
1. [STEVEN-MUST] **Google Search Console**: add property `kesefle.com`, verify, submit
   `https://kesefle.com/sitemap.xml`, then Request Indexing for `/` + the 4 landing pages. This
   is the #1 unlock per `docs/SEO_STRATEGY.md` and takes ~15 minutes. Without it the landing
   pages are invisible regardless of quality. (+5 min: Bing Webmaster Tools, same sitemap.)
2. [AI-CAN-PREP] Build the missing `/freelancers` cluster page (Cluster 5 in
   `docs/SEO_KEYWORDS.md` — "מעקב הכנסות והוצאות לעצמאי" — flagged "NEW — high value", page does
   not exist yet) following the `add-html-page` skill conventions.
3. [AI-CAN-PREP] Cross-link: every relevant blog post should link to the matching landing page;
   landing pages get FAQ schema where missing (`seo-audit` skill).
4. [STEVEN-MUST] One real backlink: a personal LinkedIn/Facebook post about building Kesefle
   (this doubles as Channel-1 surface area). One genuine mention beats 50 directory spam links.

**Hebrew template 4a — Steven's personal LinkedIn/Facebook launch post:**

> אחרי חודשים של בנייה, כספלה באוויר 🚀
> בוט וואטסאפ בעברית שעוקב אחרי הוצאות: שולחים "45 סופר" — והוא רושם, מקטלג ובונה דשבורד בגיליון גוגל אישי שלכם. בלי אפליקציה, חינם להתחלה.
> אני מחפש את 50 המשתמשים הראשונים שיעזרו לי לשפר אותו. מתחילים בהודעת "שלום" אחת:
> https://wa.me/972547760643
> אשמח לשיתוף — ולביקורת אמיתית עוד יותר.

**Expected effort:** Steven 30 min (GSC + post). AI: ongoing — 1–2 reviewed posts/week max
(per `SEO_STRATEGY.md`: no scaled auto-content, no doorway city pages, no link spam — these get
the site demoted under the 2024 spam policies).

**Honest expectation:** weeks-to-months to rank for "מעקב הוצאות וואטסאפ"-class terms; within
this 50-user push, SEO's job is to make the site credible when channels 1–3 send people to check
you out (people DO google "כספלה" before linking their Google account — note from
`SEO_KEYWORDS.md`: searchers type **כספלה** without the geresh).

---

## Channel 5 — Community forums (Tapuz / Reddit / hasolidit)

**Why fifth:** small but high-intent audiences who already discuss budgeting weekly. Low volume,
nonzero, and threads keep converting for months (forum threads rank on Google — this channel
feeds Channel 4).

**Honest correction on Tapuz:** Tapuz shut down most of its forums (~2021). Don't budget real
time there. The live equivalents:
- **The hasolidit community forum** — Israel's most engaged personal-finance community
  (budget-tracking threads are a recurring genre). Strict anti-promo culture: answer-first,
  disclose, never hard-sell.
- **FXP economics/consumer forums** — younger crowd, active, promo-tolerant in the right
  subforum.
- **Reddit:** budgeting/finance threads in **r/israel** (e.g. recurring "best way to track
  expenses in Israel?" posts) and the Israeli personal-finance subreddit(s) — search Reddit for
  "Israel finance" and check which variant is currently active rather than trusting a name from
  memory. Mostly English-speaking olim — note the product is Hebrew-first; that's a real
  limitation to disclose (an English UI exists at `/en.html`, but the bot speaks Hebrew).

**First concrete action this week** [STEVEN-MUST]:
1. Create/dust-off accounts on hasolidit forum + Reddit (aged accounts matter on Reddit — start
   now even if posting later).
2. Find 3 existing threads about expense tracking / budget apps in Israel. Reply with script 5a
   (Hebrew) or 5b (English) — always with disclosure.
3. Do NOT open a "look at my product" thread until you have karma/history in that community.

**Hebrew script 5a — forum reply (disclosure-first):**

> גילוי נאות: אני הבונה של הכלי שאזכיר, אז קחו בעירבון מוגבל.
> אחרי שנים של אקסל שמת אחרי חודשיים, בניתי בוט וואטסאפ שרושם הוצאות מהצ'אט ("45 סופר") ישר לגיליון גוגל שנשאר בבעלותכם — כולל קטגוריות וסיכום חודשי. חינם להתחלה, ואני בשלב שפידבק שווה לי יותר מכסף: https://kesefle.com
> אם הגישה של "הדאטה בגיליון שלך ולא אצלי" חשובה לכם כמו לי — אשמח לשמוע מה הייתם משפרים.

**English script 5b — Reddit reply:**

> Full disclosure: I built this, so grain of salt. It's a Hebrew WhatsApp bot — you text it
> "45 groceries"-style messages (in Hebrew) and it logs + categorizes everything into a Google
> Sheet that stays in YOUR Google account. Free tier, no app to install. Hebrew-first for now,
> so best fit if you're comfortable texting in Hebrew: https://kesefle.com — honest feedback
> very welcome, it's early days.

**Expected effort:** 1–2 hours/week, ongoing. Expect single-digit users — but unusually
high-quality ones (finance-forum people stress-test products and write detailed feedback).

**Tags:** [AI-CAN-PREP] thread-finder list (live links to current relevant threads, refreshed
weekly), reply drafts per thread context, and a tracking row per thread. [STEVEN-MUST] post from
his own accounts with disclosure — undisclosed promo on hasolidit/Reddit gets flamed and the
thread then ranks on Google forever, working AGAINST you.

**Honest failure mode:** hasolidit's culture skews DIY-spreadsheet purists; expect "why not just
use a pivot table" pushback. That's fine — answer honestly ("זה בדיוק גיליון, רק שהוא מתמלא
לבד מוואטסאפ") and let the thread sit.

---

## What does NOT work at n=0 (don't spend money or hope here)

1. **Paid ads (Meta/Google) — the big one.** At n=0 you have: no conversion baseline, no
   proven activation funnel (activation was ~0% until the #294 link-code fix days ago — verify it
   is actually healthy on real strangers FIRST), no LTV number to size bids against, no seed
   audience for lookalikes, and finance-vertical CPCs in Israel are expensive. Ads at this stage
   buy traffic into an unproven funnel = burning ₪ to learn what 20 friends would tell you for
   free. Revisit at ~200 users when activation % and week-4 retention are known, so a ₪1,500
   test can actually be judged.
2. **Cold-messaging people on WhatsApp from the bot/business number.** Meta policy violation +
   spam-report risk to the WABA that the whole product runs on. All growth must be
   user-initiated (wa.me clicks) or person-to-person from Steven's personal phone.
3. **Press / Geektime / Product Hunt as a primary plan.** Worth one opportunistic email
   ([AI-CAN-PREP] the pitch), but coverage without a retention story converts to a one-day spike
   of tourists, not 50 real users. (`press.html` exists — fine to have, not a channel.)
4. **Mass directory submissions, bought followers, auto-posted social content, fake local
   listings.** All explicitly ruled out in `docs/SEO_STRATEGY.md` — demotion risk that outlives
   the n=0 phase.
5. **Influencer payments.** At n=0 you can't evaluate or afford them; a micro-influencer barter
   (free Family plan for an honest story) is the week-6+ version, not week-1.

---

## Measurement (don't over-build; n=50 is hand-countable)

- **Source attribution the manual way:** the bot's early funnel is small enough to just ASK —
  add "איך שמעת עלינו?" as a closing onboarding question, or Steven asks personally on day 2.
  [AI-CAN-PREP] the bot question + admin column.
- Watch per-cohort: signups → linked sheet (activation, card #295) → 3+ expenses in week 1 →
  still logging in week 3. A channel that produces signups with 0 activation is a NO at any
  volume.
- Weekly scoreboard in the admin digest: users by channel, activation %, this week's single
  biggest onboarding complaint. [AI-CAN-PREP]

## Week-one calendar (compressed)

- **Day 0:** merge test-number fix (pre-flight #0) + Steven's real-device end-to-end test.
- **Day 1:** Channel 1 — first 10 personal messages. GSC + sitemap submitted (Channel 4 #1).
- **Day 2:** Channel 1 — next 10. Join 5 Facebook groups (Channel 2). Message own accountant
  (Channel 3, script 3a).
- **Days 3–5:** answer-first in FB groups; LinkedIn/Facebook personal post (template 4a);
  follow-up call with accountant; forum accounts created + 3 replies (Channel 5).
- **Day 6–7:** first allowed FB-group post (script 2a); send referral ask (1b) to every active
  friend; review activation per cohort and fix the #1 stumble before week 2.

## The 50-user math (sanity check)

20 warm asks ×50% try-rate = ~10–12 (Ch.1) → their referrals via `/referral` ≈ +5–8 →
FB groups ≈ +10–20 over 2–3 weeks (Ch.2) → accountant pilots ≈ +5–10 by week 3–4 (Ch.3) →
forums + LinkedIn post + early SEO ≈ +5–10 (Ch.4–5). Midpoints land at ~50 in 3–4 weeks **iff**
activation holds; if it doesn't, the playbook's real output is the list of reasons why — which
is worth more than the 50.
