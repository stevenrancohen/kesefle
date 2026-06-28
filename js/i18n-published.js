/* js/i18n-published.js — which {language, page-slug} pairs are actually published.
 * The language switcher (js/lang-switch.js) reads this to avoid linking to a page
 * that doesn't exist yet during the phased multilingual rollout. Hebrew (root) is
 * always treated as published and is intentionally omitted here. Slug '' = home.
 * Update this in the SAME commit that ships a localized page. */
window.KESEFLE_PUBLISHED = {
  en: [''],                 // legacy English homepage (en.html)
  ar: ['', 'pricing', 'about', 'install', 'contact', 'help', 'maakav-hotzaot-whatsapp', 'nihul-taktziv-mishpachti', 'nihul-hotzaot-esek-katan'],
  ru: ['', 'pricing', 'about', 'install', 'contact', 'help', 'maakav-hotzaot-whatsapp', 'nihul-taktziv-mishpachti', 'nihul-hotzaot-esek-katan'],
  fr: ['', 'pricing', 'about', 'install', 'contact', 'help', 'maakav-hotzaot-whatsapp', 'nihul-taktziv-mishpachti', 'nihul-hotzaot-esek-katan'],
  it: ['', 'pricing', 'about', 'install', 'contact', 'help', 'maakav-hotzaot-whatsapp', 'nihul-taktziv-mishpachti', 'nihul-hotzaot-esek-katan'],
};
