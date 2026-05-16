// EMBEDDING_FALLBACK.gs
// Semantic similarity fallback for low-confidence keyword matches in _SRC_classify_v2_.
//
// FLOW:
//   1. Offline (one-time): BUILD_EMBED_CACHE_ pulls every category description + 3-5
//      representative keyword phrases from KESEFLE_KEYWORDS, batches them to Vertex AI
//      text-embedding-004, and stores the resulting vectors (768-dim float32) as a
//      base64 array in PropertiesService (script property _EMBED_CACHE_V1) and a
//      hidden tab named _EMBED_CACHE_ for inspection.
//   2. Runtime: when _SRC_classify_v2_ returns confidence < 70 (or null category),
//      classifyWithEmbedding_(text) embeds the incoming text once, computes cosine
//      similarity against every cached vector, returns the best category if
//      sim >= 0.78 (tunable). Otherwise falls through to the dropdown.
//
// COST: text-embedding-004 is ~$0.000025 per 1K tokens. A typical Hebrew expense
//   message is 6-12 tokens, so each fallback call costs ~$0.00003. Far below the
//   $0.0001 target. Cache hit rate for category vectors is 100 percent after build.
//
// SECURITY: Vertex AI key lives in Script Properties as VERTEX_AI_KEY. Never commit.
//   If absent, this module returns null and lets the dropdown handle the case.
//
// All non-string-literal text is ASCII to avoid bidi-mark corruption when pasted
// into the Apps Script editor. Hebrew lives only inside string literals.

var _EMBED_CACHE_PROP_KEY = '_EMBED_CACHE_V1';
var _EMBED_CACHE_TAB_NAME = '_EMBED_CACHE_';
var _EMBED_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent';
var _EMBED_SIM_THRESHOLD = 0.78;
var _EMBED_MAX_PER_CAT = 5;

// Public entry point. Returns same struct as _SRC_classify_v2_ or null.
function classifyWithEmbedding_(text) {
  if (!text) return null;
  var cache = _embedLoadCache_();
  if (!cache || !cache.entries || !cache.entries.length) return null;
  var apiKey = PropertiesService.getScriptProperties().getProperty('VERTEX_AI_KEY');
  if (!apiKey) {
    Logger.log('[EMBED] VERTEX_AI_KEY missing - skipping semantic fallback');
    return null;
  }
  var clean = String(text).replace(/[\d,.]+\s*(?:שח|ש"ח|ש״ח|₪|nis|ils|שקל)?/gi, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  var vec;
  try {
    vec = _embedOne_(clean, apiKey);
  } catch (err) {
    Logger.log('[EMBED] embed call failed: ' + err);
    return null;
  }
  if (!vec) return null;
  var best = { sim: -1, entry: null };
  for (var i = 0; i < cache.entries.length; i++) {
    var e = cache.entries[i];
    var sim = _cosine_(vec, e.vec);
    if (sim > best.sim) { best.sim = sim; best.entry = e; }
  }
  if (!best.entry || best.sim < _EMBED_SIM_THRESHOLD) {
    Logger.log('[EMBED] best sim=' + best.sim.toFixed(3) + ' below threshold, falling through');
    return null;
  }
  var def = KESEFLE_KEYWORDS[best.entry.key];
  if (!def) return null;
  var amtMatch = String(text).match(/([\d,]+(?:\.\d+)?)\s*(?:שח|ש"ח|ש״ח|₪|nis|ils|שקל)?/i);
  var amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : null;
  // Confidence scaled from threshold (0) to 1.0 (100). e.g. sim 0.85 => conf 74.
  var conf = Math.min(95, Math.round(60 + (best.sim - _EMBED_SIM_THRESHOLD) * 160));
  return {
    category: def.category,
    subcategory: def.subcategory,
    routes_to: def.routes_to,
    sheet: def.sheet,
    is_income: !!def.is_income,
    confidence: conf,
    matched_keyword: '[embed:' + best.entry.key + ' sim=' + best.sim.toFixed(3) + ']',
    amount: amount,
    is_biz_prefixed: /^(עסק|biz|business|work)/i.test(String(text)),
    needs_question: false,
    via: 'embedding'
  };
}

// Wrapper that callers can use as a drop-in replacement for _SRC_classify_v2_.
// Tries keyword path first; if confidence < 70, tries embedding; else falls through.
function classifyTextSmart_(text) {
  if (typeof _SRC_classify_v2_ !== 'function') return null;
  var primary = _SRC_classify_v2_(text);
  if (primary && primary.confidence >= 70) return primary;
  var embed = classifyWithEmbedding_(text);
  if (embed && embed.confidence >= 70) return embed;
  return primary;
}

// One-time offline build. Run manually from the Apps Script editor.
function BUILD_EMBED_CACHE_() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('VERTEX_AI_KEY');
  if (!apiKey) throw new Error('Set VERTEX_AI_KEY in Script Properties first.');
  if (typeof KESEFLE_KEYWORDS === 'undefined') throw new Error('KESEFLE_KEYWORDS not loaded.');
  var entries = [];
  var keys = Object.keys(KESEFLE_KEYWORDS);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var def = KESEFLE_KEYWORDS[key];
    var phrases = [];
    // Always include the canonical subcategory as the strongest anchor.
    if (def.subcategory) phrases.push(def.subcategory);
    if (def.category && def.category !== def.subcategory) phrases.push(def.category);
    // Pull a handful of long keywords (length >= 4) as exemplars.
    var pool = (def.keywords || []).concat(def.brands || []);
    var picked = 0;
    for (var p = 0; p < pool.length && picked < _EMBED_MAX_PER_CAT; p++) {
      if (String(pool[p]).length >= 4) { phrases.push(pool[p]); picked++; }
    }
    // Build one composite anchor string per category (cheaper, captures gist).
    var anchor = phrases.join(' | ');
    Logger.log('[EMBED BUILD] ' + key + ' -> ' + anchor.slice(0, 120));
    var vec = _embedOne_(anchor, apiKey);
    if (vec) entries.push({ key: key, anchor: anchor, vec: vec });
    Utilities.sleep(120); // gentle throttle
  }
  _embedSaveCache_({ built_at: new Date().toISOString(), dim: entries[0] ? entries[0].vec.length : 0, entries: entries });
  Logger.log('[EMBED BUILD] saved ' + entries.length + ' category vectors');
}

// --- internals -----------------------------------------------------------

function _embedOne_(text, apiKey) {
  var url = _EMBED_API_URL + '?key=' + encodeURIComponent(apiKey);
  var payload = {
    model: 'models/text-embedding-004',
    content: { parts: [{ text: String(text) }] },
    taskType: 'SEMANTIC_SIMILARITY'
  };
  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code !== 200) {
    Logger.log('[EMBED] HTTP ' + code + ': ' + resp.getContentText().slice(0, 300));
    return null;
  }
  var body = JSON.parse(resp.getContentText());
  var values = body && body.embedding && body.embedding.values;
  if (!values || !values.length) return null;
  return values;
}

function _cosine_(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  var dot = 0, na = 0, nb = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function _embedSaveCache_(cache) {
  // Property service has a 9KB-per-key limit, so we shard the entries blob.
  var json = JSON.stringify(cache);
  var props = PropertiesService.getScriptProperties();
  // Wipe old shards
  var allKeys = props.getKeys();
  for (var i = 0; i < allKeys.length; i++) {
    if (allKeys[i].indexOf(_EMBED_CACHE_PROP_KEY) === 0) props.deleteProperty(allKeys[i]);
  }
  var SHARD = 8000;
  var shards = Math.ceil(json.length / SHARD);
  props.setProperty(_EMBED_CACHE_PROP_KEY + '_META', JSON.stringify({ shards: shards, built_at: cache.built_at, dim: cache.dim, count: cache.entries.length }));
  for (var s = 0; s < shards; s++) {
    props.setProperty(_EMBED_CACHE_PROP_KEY + '_' + s, json.slice(s * SHARD, (s + 1) * SHARD));
  }
  // Also dump a human-readable summary to the hidden tab.
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(_EMBED_CACHE_TAB_NAME);
    if (!sh) sh = ss.insertSheet(_EMBED_CACHE_TAB_NAME);
    sh.clearContents();
    sh.getRange(1, 1, 1, 4).setValues([['key', 'anchor', 'dim', 'vec_base64']]);
    var rows = [];
    for (var k = 0; k < cache.entries.length; k++) {
      var e = cache.entries[k];
      // Base64-encode the float array for compact storage.
      var bytes = [];
      for (var j = 0; j < e.vec.length; j++) bytes.push(e.vec[j]);
      rows.push([e.key, e.anchor, e.vec.length, Utilities.base64Encode(JSON.stringify(bytes))]);
    }
    if (rows.length) sh.getRange(2, 1, rows.length, 4).setValues(rows);
    sh.hideSheet();
  } catch (err) {
    Logger.log('[EMBED] tab write failed (non-fatal): ' + err);
  }
}

function _embedLoadCache_() {
  var props = PropertiesService.getScriptProperties();
  var metaRaw = props.getProperty(_EMBED_CACHE_PROP_KEY + '_META');
  if (!metaRaw) return null;
  var meta;
  try { meta = JSON.parse(metaRaw); } catch (e) { return null; }
  if (!meta || !meta.shards) return null;
  var json = '';
  for (var s = 0; s < meta.shards; s++) {
    var part = props.getProperty(_EMBED_CACHE_PROP_KEY + '_' + s);
    if (part == null) return null;
    json += part;
  }
  try { return JSON.parse(json); } catch (e) { return null; }
}

// Manual test - run from the Apps Script editor.
function TEST_EMBED_FALLBACK() {
  var samples = [
    'שילמתי 87 על קפה עם חברה',
    'תדלקתי 250 שח',
    'קניתי מסגרת לקנבס בסך 180',
    'דמי מנוי לאפליקציה 29.90'
  ];
  for (var i = 0; i < samples.length; i++) {
    var r = classifyTextSmart_(samples[i]);
    Logger.log(samples[i] + ' -> ' + (r ? (r.subcategory + ' [' + r.routes_to + '] conf=' + r.confidence + ' via=' + (r.via || 'keyword')) : 'null'));
  }
}
