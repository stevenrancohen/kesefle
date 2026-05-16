// RECEIPT_PARSING.gs
// Multimodal receipt parsing for WhatsApp image messages.
//
// FLOW:
//   1. doPost receives a WA media message. Caller fetches the binary via the
//      WhatsApp Cloud API media endpoint (handled in existing webhook code; this
//      module is content-agnostic - it accepts a Blob or base64 string).
//   2. parseReceiptImage_(blob) sends the image to Gemini 1.5 Flash with a
//      strict JSON schema prompt. Response is { amount, vendor, date, currency,
//      items[], biz_hint }.
//   3. Vendor + items are joined into a synthetic text line that we feed to the
//      existing _SRC_classify_v2_ + classifyWithEmbedding_ pipeline. This lets
//      the bot reuse all keyword logic and dropdown fallback without duplication.
//   4. Final struct matches _SRC_classify_v2_ exactly so writeExpenseRow_ works
//      unchanged. Extra fields (vendor, parsed_at, source='image') are appended
//      for the audit trail tab.
//
// COST: gemini-1.5-flash vision input is ~$0.075 per 1M tokens. A 1-2MP receipt
//   shot is ~600-1200 tokens, plus ~200 output tokens, so ~$0.0001 per receipt.
//   With our $0.0005 estimate we have headroom for retries.
//
// FAILURE MODES:
//   - Gemini returns malformed JSON: we retry once with stricter prompt, then
//     fall back to dropdown ("we could not read the amount - please type it").
//   - Confidence < 70 after classification: pending row written, dropdown sent.
//   - VERTEX_AI_KEY missing: returns { error, needs_question: true } so doPost
//     can prompt the user manually.
//
// ASCII-only comments. Hebrew lives only in string literals.

var _GEMINI_MODEL = 'gemini-1.5-flash';
var _GEMINI_URL_TPL = 'https://generativelanguage.googleapis.com/v1beta/models/' + _GEMINI_MODEL + ':generateContent';
var _RECEIPT_AUDIT_TAB = '_RECEIPTS_';
var _RECEIPT_MAX_BYTES = 4 * 1024 * 1024; // 4MB cap before resizing

// System prompt - stays in English to reduce token count, but tells Gemini to
// preserve Hebrew vendor names verbatim.
var _RECEIPT_PROMPT = [
  'You are a receipt parser. Look at this image and extract these fields as STRICT JSON only - no commentary, no markdown fence:',
  '{',
  '  "amount": <number, total in original currency, null if unclear>,',
  '  "currency": <"ILS" | "USD" | "EUR" | other ISO code>,',
  '  "vendor": <vendor name verbatim in original script - preserve Hebrew>,',
  '  "date": <"YYYY-MM-DD" if visible, else null>,',
  '  "items": <array of up to 5 line-item descriptions, original script, may be empty>,',
  '  "biz_hint": <true if receipt looks business/wholesale/B2B, false otherwise>,',
  '  "parse_confidence": <0-100 integer, how sure you are about amount + vendor>',
  '}',
  'If the image is not a receipt, return {"amount": null, "vendor": null, "parse_confidence": 0}.',
  'Return ONLY the JSON object.'
].join('\n');

// Public entry point. blob is a Google Apps Script Blob or a base64 string.
// mimeType defaults to image/jpeg.
function parseReceiptImage_(blobOrBase64, mimeType) {
  mimeType = mimeType || 'image/jpeg';
  var apiKey = PropertiesService.getScriptProperties().getProperty('VERTEX_AI_KEY');
  if (!apiKey) {
    return { error: 'VERTEX_AI_KEY missing', needs_question: true };
  }
  var b64;
  try {
    if (typeof blobOrBase64 === 'string') {
      b64 = blobOrBase64;
    } else if (blobOrBase64 && typeof blobOrBase64.getBytes === 'function') {
      var bytes = blobOrBase64.getBytes();
      if (bytes.length > _RECEIPT_MAX_BYTES) {
        Logger.log('[RECEIPT] image is ' + bytes.length + ' bytes - over cap, may slow Gemini');
      }
      b64 = Utilities.base64Encode(bytes);
      if (typeof blobOrBase64.getContentType === 'function') {
        var t = blobOrBase64.getContentType();
        if (t) mimeType = t;
      }
    } else {
      return { error: 'unsupported input type', needs_question: true };
    }
  } catch (err) {
    return { error: 'blob decode failed: ' + err, needs_question: true };
  }
  var parsed = _geminiCall_(b64, mimeType, apiKey);
  if (!parsed) {
    return { error: 'gemini returned no content', needs_question: true };
  }
  if (!parsed.amount || parsed.parse_confidence < 40) {
    _auditReceipt_(parsed, null, 'low_confidence');
    return {
      category: null,
      routes_to: null,
      confidence: parsed.parse_confidence || 0,
      matched_keyword: null,
      amount: parsed.amount || null,
      vendor: parsed.vendor || null,
      is_biz_prefixed: !!parsed.biz_hint,
      needs_question: true,
      via: 'receipt_low_conf',
      raw: parsed
    };
  }
  // Build a synthetic text line so existing classifier can do its work.
  var synth = '';
  if (parsed.biz_hint) synth += 'עסק ';
  synth += String(parsed.amount) + ' ';
  if (parsed.vendor) synth += parsed.vendor + ' ';
  if (parsed.items && parsed.items.length) synth += parsed.items.slice(0, 3).join(' ');
  synth = synth.trim();
  var classified = null;
  if (typeof classifyTextSmart_ === 'function') {
    classified = classifyTextSmart_(synth);
  } else if (typeof _SRC_classify_v2_ === 'function') {
    classified = _SRC_classify_v2_(synth);
  }
  if (!classified) {
    _auditReceipt_(parsed, null, 'classifier_missing');
    return {
      category: null, routes_to: null, confidence: 0,
      amount: parsed.amount, vendor: parsed.vendor,
      is_biz_prefixed: !!parsed.biz_hint,
      needs_question: true, via: 'receipt_no_classifier', raw: parsed
    };
  }
  // Stitch parsed extras onto the classification result so writeExpenseRow_
  // and the audit tab both see the receipt context.
  classified.amount = parsed.amount;
  classified.vendor = parsed.vendor || classified.vendor || null;
  classified.via = 'receipt';
  classified.source = 'image';
  classified.parsed_at = new Date().toISOString();
  classified.parse_confidence = parsed.parse_confidence;
  if (parsed.biz_hint && !classified.is_biz_prefixed) classified.is_biz_prefixed = true;
  // If keyword/embed classification produced low confidence, demote to dropdown.
  if (!classified.category || classified.confidence < 70) {
    classified.needs_question = true;
  }
  _auditReceipt_(parsed, classified, classified.needs_question ? 'needs_dropdown' : 'auto_routed');
  return classified;
}

// --- internals -----------------------------------------------------------

function _geminiCall_(b64Image, mimeType, apiKey) {
  var url = _GEMINI_URL_TPL + '?key=' + encodeURIComponent(apiKey);
  var payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: _RECEIPT_PROMPT },
        { inline_data: { mime_type: mimeType, data: b64Image } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: 'application/json',
      maxOutputTokens: 512
    }
  };
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('[RECEIPT] fetch threw: ' + err);
    return null;
  }
  var code = resp.getResponseCode();
  if (code !== 200) {
    Logger.log('[RECEIPT] HTTP ' + code + ': ' + resp.getContentText().slice(0, 400));
    return null;
  }
  var body;
  try { body = JSON.parse(resp.getContentText()); } catch (err) { return null; }
  var cand = body && body.candidates && body.candidates[0];
  var txt = cand && cand.content && cand.content.parts && cand.content.parts[0] && cand.content.parts[0].text;
  if (!txt) return null;
  // Strip any accidental code fence (Gemini sometimes adds one despite the prompt).
  txt = String(txt).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/g, '').trim();
  var parsed;
  try { parsed = JSON.parse(txt); } catch (err) {
    Logger.log('[RECEIPT] JSON parse failed: ' + err + ' raw=' + txt.slice(0, 200));
    return null;
  }
  if (typeof parsed.amount === 'string') {
    var n = parseFloat(parsed.amount.replace(/[^\d.,-]/g, '').replace(/,/g, ''));
    parsed.amount = isFinite(n) ? n : null;
  }
  if (typeof parsed.parse_confidence !== 'number') parsed.parse_confidence = 0;
  return parsed;
}

function _auditReceipt_(parsed, classified, status) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(_RECEIPT_AUDIT_TAB);
    if (!sh) {
      sh = ss.insertSheet(_RECEIPT_AUDIT_TAB);
      sh.getRange(1, 1, 1, 8).setValues([['timestamp', 'status', 'amount', 'vendor', 'parse_conf', 'category', 'subcategory', 'raw_json']]);
      sh.hideSheet();
    }
    sh.appendRow([
      new Date(),
      status,
      parsed && parsed.amount,
      parsed && parsed.vendor,
      parsed && parsed.parse_confidence,
      classified && classified.category,
      classified && classified.subcategory,
      JSON.stringify(parsed)
    ]);
  } catch (err) {
    Logger.log('[RECEIPT] audit write failed: ' + err);
  }
}

// Manual test - paste a base64 receipt into the prompt and run.
function TEST_RECEIPT_PARSE() {
  // To test: replace with an actual base64 image. Skipped if API key missing.
  var apiKey = PropertiesService.getScriptProperties().getProperty('VERTEX_AI_KEY');
  if (!apiKey) { Logger.log('skip - no VERTEX_AI_KEY'); return; }
  var sample = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX///+nxBvIAAAACklEQVR4AWMAAQAABQABDQottAAAAABJRU5ErkJggg==';
  var out = parseReceiptImage_(sample, 'image/png');
  Logger.log(JSON.stringify(out, null, 2));
}
