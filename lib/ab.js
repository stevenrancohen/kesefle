// lib/ab.js
//
// Deterministic A/B-test bucketing. Same `key` (userSub or anonymous IP-hash)
// always lands in the same variant for the same experiment -- no flicker on
// page reloads, no DB round-trip per page view.
//
// Experiments are stored in KV `ab:experiments` as a JSON object:
//   {
//     "hero_cta": {
//       "variants": [
//         { "name": "control", "weight": 50 },
//         { "name": "variant_a", "weight": 50 }
//       ],
//       "enabled": true,
//       "updated_at": "..."
//     }
//   }
//
// Conversion tracking is via the existing /api/log/funnel-event system --
// just include `meta.experiment: 'hero_cta:variant_a'` in the event.
//
// SERVER USE (Node) -- pick a bucket given a key + experiment cfg:
//   import { bucketize } from './lib/ab.js';
//   const variant = bucketize('hero_cta', userSub, experimentCfg);
//
// CLIENT USE (browser) -- include /js/ab-client.js then:
//   const variant = await window.kflAB('hero_cta');

import crypto from 'node:crypto';

// 32-bit hash of (experimentName + key). Stable, fast, no deps beyond
// node:crypto. Used to map a user to [0,100) which then maps to a variant
// per the weights array.
function hash32(s) {
  // SHA-256 first 8 hex = first 32 bits; integer mod 100 gives bucket %.
  const h = crypto.createHash('sha256').update(String(s)).digest('hex');
  return parseInt(h.slice(0, 8), 16);
}

// Map a hash to one variant per the weights. Weights sum to 100 (or any
// positive number; we normalize). Out-of-bound or empty config returns
// the literal string 'control' so missing setup never breaks code paths.
export function bucketize(experimentName, key, cfg) {
  if (!cfg || !cfg.enabled || !Array.isArray(cfg.variants) || !cfg.variants.length) {
    return 'control';
  }
  const totalWeight = cfg.variants.reduce((s, v) => s + (Number(v.weight) || 0), 0);
  if (totalWeight <= 0) return 'control';

  // Bucket on a [0, totalWeight) range derived from the user-experiment hash.
  const h = hash32(experimentName + ':' + (key || 'anon'));
  let bucket = h % totalWeight;
  for (const variant of cfg.variants) {
    const w = Number(variant.weight) || 0;
    if (bucket < w) return String(variant.name || 'control');
    bucket -= w;
  }
  return 'control';
}

// Pure validator -- used by /api/ab admin endpoint before persisting.
export function validateExperimentCfg(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'not_object' };
  if (!Array.isArray(cfg.variants) || cfg.variants.length < 2 || cfg.variants.length > 8) {
    return { ok: false, error: 'variants_count_2_to_8' };
  }
  const names = new Set();
  for (const v of cfg.variants) {
    if (!v || typeof v !== 'object') return { ok: false, error: 'variant_not_object' };
    if (!v.name || typeof v.name !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(v.name)) {
      return { ok: false, error: 'invalid_variant_name', detail: String(v.name) };
    }
    if (names.has(v.name)) return { ok: false, error: 'duplicate_variant_name', detail: v.name };
    names.add(v.name);
    const w = Number(v.weight);
    if (!isFinite(w) || w < 0 || w > 1000) return { ok: false, error: 'invalid_weight', detail: String(v.weight) };
  }
  if (typeof cfg.enabled !== 'boolean') return { ok: false, error: 'enabled_not_bool' };
  return { ok: true };
}

// Convenience: validate the whole experiments map.
export function validateAllExperiments(map) {
  if (!map || typeof map !== 'object') return { ok: false, error: 'not_object' };
  for (const [name, cfg] of Object.entries(map)) {
    if (!/^[a-z0-9_-]{1,40}$/.test(name)) {
      return { ok: false, error: 'invalid_experiment_name', detail: name };
    }
    const v = validateExperimentCfg(cfg);
    if (!v.ok) return { ok: false, error: v.error, experiment: name, detail: v.detail };
  }
  return { ok: true };
}
