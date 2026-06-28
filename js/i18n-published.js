/* js/i18n-published.js — which {language, page-slug} pairs are actually published.
 * The language switcher (js/lang-switch.js) reads this to avoid linking to a page
 * that doesn't exist yet during the phased multilingual rollout. Hebrew (root) is
 * always treated as published and is intentionally omitted here. Slug '' = home.
 * Update this in the SAME commit that ships a localized page. */
window.KESEFLE_PUBLISHED = {
  en: [''],                 // legacy English homepage (en.html)
  ar: [],                   // Arabic — populated as the funnel ships
  ru: [],                   // Russian
  fr: [],                   // French
  it: [],                   // Italian
};
