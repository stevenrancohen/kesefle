// scripts/i18n/locales.mjs
//
// Canonical locale registry for the Kesefle multilingual site. The site sells to
// the ISRAELI market; the non-Hebrew locales exist to reach Israel's own
// linguistic communities (Arabic ~21%, Russian ~15% immigrant community, French
// Francophone aliyah, Italian smaller) — NOT a worldwide expansion. All locales
// stay Israel-anchored (og:locale region IL where it makes sense; content is the
// same Israel-specific WhatsApp expense bot).
//
// `dir` drives <html dir>. `autonym` is the language's own name (used in the
// language switcher — always show a language in its own script). `hreflang` is
// finalized by the strategy spec; defaults here are language-only + he-IL/en-IL
// for the two Israel-pinned originals.
'use strict';

export const LOCALES = {
  he: { code: 'he', dir: 'rtl', autonym: 'עברית',    ogLocale: 'he_IL', hreflang: 'he-IL', isDefault: true,  font: 'Heebo' },
  en: { code: 'en', dir: 'ltr', autonym: 'English',  ogLocale: 'en_US', hreflang: 'en',    isDefault: false, font: 'Inter' },
  ar: { code: 'ar', dir: 'rtl', autonym: 'العربية',  ogLocale: 'ar_IL', hreflang: 'ar',    isDefault: false, font: 'Noto Kufi Arabic' },
  ru: { code: 'ru', dir: 'ltr', autonym: 'Русский',  ogLocale: 'ru_RU', hreflang: 'ru',    isDefault: false, font: 'Inter' },
  fr: { code: 'fr', dir: 'ltr', autonym: 'Français', ogLocale: 'fr_FR', hreflang: 'fr',    isDefault: false, font: 'Inter' },
  it: { code: 'it', dir: 'ltr', autonym: 'Italiano', ogLocale: 'it_IT', hreflang: 'it',    isDefault: false, font: 'Inter' },
};

// Display order in the switcher: Hebrew + English first (primary markets for the
// site), then the community languages by Israeli population size.
export const SWITCHER_ORDER = ['he', 'en', 'ar', 'ru', 'fr', 'it'];

// The core marketing-funnel pages to localize (NOT the 39 blog posts — machine-
// translating those would be thin-content SEO harm). Source file -> route slug.
export const CORE_PAGES = [
  { src: 'index.html',                    slug: '',                        title: 'home' },
  { src: 'pricing.html',                  slug: 'pricing',                 title: 'pricing' },
  { src: 'about.html',                    slug: 'about',                   title: 'about' },
  { src: 'install.html',                  slug: 'install',                 title: 'install' },
  { src: 'contact.html',                  slug: 'contact',                 title: 'contact' },
  { src: 'help.html',                     slug: 'help',                    title: 'help' },
  { src: 'maakav-hotzaot-whatsapp.html',  slug: 'expense-tracking-whatsapp', title: 'landing-whatsapp' },
  { src: 'nihul-taktziv-mishpachti.html', slug: 'family-budget',           title: 'landing-family' },
  { src: 'nihul-hotzaot-esek-katan.html', slug: 'small-business-expenses', title: 'landing-business' },
];

export const NON_DEFAULT = SWITCHER_ORDER.filter((l) => l !== 'he');
