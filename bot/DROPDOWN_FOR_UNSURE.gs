// DROPDOWN_FOR_UNSURE.gs - WhatsApp interactive-list classification dropdown
// Purpose: when _SRC_classify_v2_ is UNSURE about a message, this module asks
// the user to pick a category via WhatsApp's interactive list UI, stores the
// pending state in UserProperties, and resolves it on the user's reply.
//
// Public API (call from existing ExpenseBot.gs router):
//   askUserToClassify_(phoneNumber, originalText, amount, classifyResult)
//   handleUserClassificationReply_(phoneNumber, replyText, replyListId)
//   getPendingClassification_(phoneNumber)
//   clearPendingClassification_(phoneNumber)
//   isUnsureClassification_(classifyResult)
//
// Integration: see DROPDOWN_README.md.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// WhatsApp Cloud API credentials. These must already exist as Script Properties
// in the bot project (set via Project Settings -> Script Properties).
//   WA_TOKEN          - Bearer token for Graph API
//   WA_PHONE_ID       - Sender phone-number ID
//   WA_GRAPH_VERSION  - optional, defaults to v18.0
function _DD_getWaConfig_() {
  var sp = PropertiesService.getScriptProperties();
  return {
    token: sp.getProperty('WA_TOKEN') || '',
    phoneId: sp.getProperty('WA_PHONE_ID') || '',
    version: sp.getProperty('WA_GRAPH_VERSION') || 'v18.0'
  };
}

// Pending state lifetime. Anything older is treated as expired.
var DD_PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

// Property key prefix for pending state in UserProperties.
var DD_PENDING_KEY_PREFIX = 'pending_classify_';

// ID prefixes for interactive-list row ids. Reply payloads start with these,
// so we can distinguish a category pick from a routing pick.
var DD_ROW_PREFIX_CATEGORY = 'cat::';
var DD_ROW_PREFIX_ROUTE = 'route::';
var DD_ROW_ID_CANCEL = 'cancel::pending';

// Display copy. All Hebrew strings live here so the rest of the file is ASCII.
var DD_COPY = {
  header: 'לא בטוח איך לסווג',
  bodyTemplate: 'קיבלתי "{text}" על סך {amount} ש"ח אבל אני לא בטוח לאיזו קטגוריה זה שייך. בחר מהרשימה:',
  bodyTemplateNoAmount: 'קיבלתי "{text}" אבל אני לא בטוח לאיזו קטגוריה זה שייך. בחר מהרשימה:',
  footer: 'הבחירה תתבטל אוטומטית אחרי שעה',
  button: 'בחר קטגוריה',
  sectionPersonal: 'הוצאות אישיות',
  sectionBusiness: 'הוצאות עסק',
  sectionIncome: 'הכנסות',
  sectionOther: 'אחר',
  rowOther: 'שונות',
  rowOtherDesc: 'לא מתאים לשום קטגוריה אחרת',
  rowCancel: 'בטל',
  rowCancelDesc: 'אל תשמור את ההוצאה הזאת',
  rowRoutePersonal: 'אישי',
  rowRouteBusiness: 'עסקי',
  routeBodyTemplate: 'ההוצאה "{text}" על {amount} ש"ח — האם זה אישי או עסקי?',
  okSaved: 'נשמר: {amount} ש"ח, {subcat}',
  okSavedNoAmount: 'נשמר: {subcat}',
  errExpired: 'הבקשה הקודמת פגה. שלח שוב את ההוצאה.',
  errNoPending: 'אין בקשה ממתינה. שלח הוצאה חדשה (לדוגמה: "45 קפה").',
  errUnknownRow: 'בחירה לא מוכרת. נסה שוב.',
  conflictTemplate: 'יש לי בקשה ממתינה לסווג: "{prevText}" על {prevAmount} ש"ח. אני שומר אותה כ"שונות" וטוחן את ההוצאה החדשה.'
};

// ---------------------------------------------------------------------------
// Catalog: which categories appear in the dropdown, mapped to KESEFLE_KEYWORDS
// keys. Order here = display order. We keep total rows under WhatsApp's
// 10-sections * 10-rows = 100-row limit (we use far less).
// ---------------------------------------------------------------------------
var DD_CATALOG = {
  personal: [
    { key: 'אוכל_לבית',         title: 'אוכל לבית',          desc: 'סופר, ירקות, מצרכים' },
    { key: 'אוכל_בחוץ',         title: 'אוכל בחוץ',          desc: 'מסעדה, קפה, וולט' },
    { key: 'מוניות',            title: 'מונית',              desc: 'גט, אובר, יאנגו' },
    { key: 'דלק',               title: 'דלק',                desc: 'תחנת דלק, תדלוק' },
    { key: 'חניה',              title: 'חניה',               desc: 'פנגו, חניון' },
    { key: 'תחבורה_ציבורית',    title: 'תחבורה ציבורית',     desc: 'אוטובוס, רכבת, רב-קו' },
    { key: 'בית',               title: 'בית',                desc: 'ארנונה, שכירות, חשמל' },
    { key: 'תקשורת',            title: 'תקשורת',             desc: 'סלולר, אינטרנט' },
    { key: 'אפליקציות',         title: 'אפליקציות',          desc: 'נטפליקס, ספוטיפיי' },
    { key: 'בריאות',            title: 'בריאות',             desc: 'רופא, תרופות, בית מרקחת' }
  ],
  // "shopping" bucket plus leisure
  lifestyle: [
    { key: 'ביגוד_ונעליים',     title: 'ביגוד ונעליים',      desc: 'בגדים, נעליים' },
    { key: 'טיפוח_ויופי',       title: 'טיפוח ויופי',        desc: 'מספרה, בושם, איפור' },
    { key: 'גאדגטים',           title: 'גאדג\'טים',          desc: 'אלקטרוניקה, מסכים' },
    { key: 'בידור',             title: 'בידור',              desc: 'קולנוע, הופעה' },
    { key: 'נסיעות',            title: 'נסיעות',             desc: 'טיסה, מלון' },
    { key: 'מתנות',             title: 'מתנות',              desc: 'מתנה, פרחים' },
    { key: 'ילדים',             title: 'ילדים',              desc: 'גן, חוגים, צעצועים' },
    { key: 'חיות',              title: 'חיות מחמד',          desc: 'וטרינר, אוכל לכלב' }
  ],
  business: [
    { key: 'עסק_שיווק',         title: 'שיווק',              desc: 'פרסום, פייסבוק, גוגל' },
    { key: 'עסק_AI_SaaS',       title: 'AI ותוכנה',          desc: 'ChatGPT, Canva, Figma' },
    { key: 'עסק_שילוח',         title: 'שילוח',              desc: 'דואר, DHL, שליחויות' },
    { key: 'עסק_אריזה',         title: 'אריזה',              desc: 'קרטון, מעטפות' },
    { key: 'עסק_מלאי',          title: 'מלאי',               desc: 'רכישת מלאי מספק' },
    { key: 'עסק_חומרי_גלם',     title: 'חומרי גלם',          desc: 'קנבס, מסגרות, דיו' },
    { key: 'עסק_יועצים',        title: 'יועצים',             desc: 'רו"ח, עו"ד' },
    { key: 'עסק_שכר_עובדים',    title: 'שכר עובדים',         desc: 'משכורות, פרילנסר' },
    { key: 'עסק_מס_וביטוח_לאומי', title: 'מס וביטוח לאומי',  desc: 'מע"מ, מס הכנסה' }
  ],
  income: [
    { key: 'הכנסה_משכורת',      title: 'משכורת',             desc: 'שכר חודשי' },
    { key: 'הכנסה_src',         title: 'הכנסה מהעסק SRC',    desc: 'תשלום מלקוח' },
    { key: 'הכנסה_טלפונים',     title: 'מכירת טלפון',        desc: 'מכרתי טלפון יד שניה' },
    { key: 'הכנסה_שונות',       title: 'הכנסה שונה',         desc: 'בונוס, החזר, ריבית' }
  ]
};

// ---------------------------------------------------------------------------
// Public: is this classifier result "unsure"?
// ---------------------------------------------------------------------------
function isUnsureClassification_(classifyResult) {
  if (!classifyResult) return true;
  if (classifyResult.needs_question === true) return true;
  if (classifyResult.category == null && classifyResult.amount != null) return true;
  var conf = (typeof classifyResult.confidence === 'number') ? classifyResult.confidence : 0;
  return conf < 70;
}

// ---------------------------------------------------------------------------
// Public: send the WhatsApp interactive-list to the user.
// Side effect: stores pending state in UserProperties keyed by phone number.
// Returns: { ok: true, type: 'category'|'route', pendingId: string } on success,
//          or { ok: false, error: string } on failure.
// ---------------------------------------------------------------------------
function askUserToClassify_(phoneNumber, originalText, amount, classifyResult) {
  if (!phoneNumber) return { ok: false, error: 'missing_phone' };
  var text = String(originalText || '').trim();
  var amt = (typeof amount === 'number' && isFinite(amount)) ? amount : null;
  var cr = classifyResult || {};

  // If user is already mid-flow, resolve the old one first to avoid stuck state.
  var existing = getPendingClassification_(phoneNumber);
  if (existing && !_DD_isExpired_(existing)) {
    _DD_autoResolveOldPending_(phoneNumber, existing);
    _DD_sendConflictNotice_(phoneNumber, existing);
  }

  // If classifier saw a matched keyword but ambiguous personal-vs-business
  // routing, send a 2-option route picker instead of the full category list.
  var routeOnly = (cr.matched_keyword && cr.routes_to == null);
  var pendingId = Utilities.getUuid();
  var pending = {
    id: pendingId,
    phone: String(phoneNumber),
    text: text,
    amount: amt,
    matched_keyword: cr.matched_keyword || null,
    is_biz_prefixed: !!cr.is_biz_prefixed,
    mode: routeOnly ? 'route' : 'category',
    created_ms: Date.now()
  };
  _DD_setPending_(phoneNumber, pending);

  var payload = routeOnly
    ? _DD_buildRoutePayload_(phoneNumber, pending)
    : _DD_buildCategoryListPayload_(phoneNumber, pending);

  var send = _DD_sendWhatsApp_(payload);
  if (!send.ok) {
    clearPendingClassification_(phoneNumber);
    return { ok: false, error: send.error || 'send_failed' };
  }
  return { ok: true, type: pending.mode, pendingId: pendingId };
}

// ---------------------------------------------------------------------------
// Public: process the user's reply (text or interactive list selection).
// replyListId is the row id returned by WhatsApp when the user taps a row.
// replyText is the fallback if the user typed free-text instead.
// Returns: { ok, action: 'resolved'|'cancelled'|'unknown'|'no_pending'|'expired',
//            resolved?: { category, subcategory, routes_to, sheet, is_income, amount } }
// ---------------------------------------------------------------------------
function handleUserClassificationReply_(phoneNumber, replyText, replyListId) {
  if (!phoneNumber) return { ok: false, action: 'no_pending' };
  var pending = getPendingClassification_(phoneNumber);
  if (!pending) return { ok: false, action: 'no_pending' };
  if (_DD_isExpired_(pending)) {
    clearPendingClassification_(phoneNumber);
    return { ok: false, action: 'expired' };
  }

  var rowId = String(replyListId || '').trim();
  var typed = String(replyText || '').trim();

  // Interactive-list selection
  if (rowId) {
    if (rowId === DD_ROW_ID_CANCEL) {
      clearPendingClassification_(phoneNumber);
      return { ok: true, action: 'cancelled' };
    }
    var resolved = _DD_resolveByRowId_(rowId, pending);
    if (!resolved) return { ok: false, action: 'unknown' };
    clearPendingClassification_(phoneNumber);
    return { ok: true, action: 'resolved', resolved: resolved };
  }

  // Free-text fallback: match by displayed title or category key.
  if (typed) {
    var resolvedText = _DD_resolveByText_(typed, pending);
    if (resolvedText) {
      clearPendingClassification_(phoneNumber);
      return { ok: true, action: 'resolved', resolved: resolvedText };
    }
  }
  return { ok: false, action: 'unknown' };
}

// ---------------------------------------------------------------------------
// Pending state helpers
// ---------------------------------------------------------------------------
function _DD_pendingKey_(phoneNumber) {
  return DD_PENDING_KEY_PREFIX + String(phoneNumber);
}

function _DD_setPending_(phoneNumber, pending) {
  var up = PropertiesService.getUserProperties();
  up.setProperty(_DD_pendingKey_(phoneNumber), JSON.stringify(pending));
}

function getPendingClassification_(phoneNumber) {
  var up = PropertiesService.getUserProperties();
  var raw = up.getProperty(_DD_pendingKey_(phoneNumber));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    up.deleteProperty(_DD_pendingKey_(phoneNumber));
    return null;
  }
}

function clearPendingClassification_(phoneNumber) {
  var up = PropertiesService.getUserProperties();
  up.deleteProperty(_DD_pendingKey_(phoneNumber));
}

function _DD_isExpired_(pending) {
  if (!pending || !pending.created_ms) return true;
  return (Date.now() - Number(pending.created_ms)) > DD_PENDING_TTL_MS;
}

// When a new expense arrives while one is pending, auto-resolve the old one
// as a generic "shonot" row so the user does not lose data.
function _DD_autoResolveOldPending_(phoneNumber, pending) {
  try {
    var resolved = {
      category: 'שונות ואחרים',
      subcategory: 'שונות',
      routes_to: 'personal',
      sheet: 'תנועות',
      is_income: false,
      amount: pending.amount,
      original_text: pending.text,
      auto_resolved: true
    };
    // Hand off to the existing writer. Defined in ExpenseBot.gs.
    if (typeof writeExpenseRow_ === 'function') {
      writeExpenseRow_(resolved);
    }
  } catch (e) {
    // Swallow - we still clear the pending row below.
  }
  clearPendingClassification_(phoneNumber);
}

function _DD_sendConflictNotice_(phoneNumber, pending) {
  var amt = (pending.amount != null) ? String(pending.amount) : '?';
  var msg = DD_COPY.conflictTemplate
    .replace('{prevText}', pending.text || '')
    .replace('{prevAmount}', amt);
  _DD_sendWhatsApp_(_DD_buildTextPayload_(phoneNumber, msg));
}

// ---------------------------------------------------------------------------
// Row-id resolution
// ---------------------------------------------------------------------------
function _DD_resolveByRowId_(rowId, pending) {
  if (rowId.indexOf(DD_ROW_PREFIX_CATEGORY) === 0) {
    var key = rowId.substring(DD_ROW_PREFIX_CATEGORY.length);
    return _DD_resolveByCategoryKey_(key, pending);
  }
  if (rowId.indexOf(DD_ROW_PREFIX_ROUTE) === 0) {
    var route = rowId.substring(DD_ROW_PREFIX_ROUTE.length);
    return _DD_resolveByRoute_(route, pending);
  }
  return null;
}

function _DD_resolveByCategoryKey_(key, pending) {
  if (key === '_שונות') {
    return {
      category: 'שונות ואחרים',
      subcategory: 'שונות',
      routes_to: 'personal',
      sheet: 'תנועות',
      is_income: false,
      amount: pending.amount,
      original_text: pending.text,
      picked_key: key
    };
  }
  if (typeof KESEFLE_KEYWORDS === 'undefined') return null;
  var def = KESEFLE_KEYWORDS[key];
  if (!def) return null;
  return {
    category: def.category,
    subcategory: def.subcategory,
    routes_to: def.routes_to,
    sheet: def.sheet,
    is_income: !!def.is_income,
    amount: pending.amount,
    original_text: pending.text,
    picked_key: key
  };
}

function _DD_resolveByRoute_(route, pending) {
  // Route-only flow: we have a matched keyword but need to confirm
  // personal vs business. We just flip is_biz_prefixed and re-classify.
  if (typeof _SRC_classify_v2_ !== 'function') return null;
  var prefix = (route === 'business') ? 'עסק ' : '';
  var rerun = _SRC_classify_v2_(prefix + (pending.text || ''));
  if (!rerun || rerun.category == null) {
    return _DD_resolveByCategoryKey_('_שונות', pending);
  }
  return {
    category: rerun.category,
    subcategory: rerun.subcategory,
    routes_to: rerun.routes_to,
    sheet: rerun.sheet,
    is_income: !!rerun.is_income,
    amount: pending.amount || rerun.amount,
    original_text: pending.text,
    picked_route: route
  };
}

// Best-effort text match: exact title, then includes.
function _DD_resolveByText_(typed, pending) {
  var lower = typed.toLowerCase();
  if (lower === DD_COPY.rowCancel.toLowerCase() || lower === 'cancel') {
    return null; // caller treats null as unknown; cancel via row id only
  }
  var groups = ['personal', 'lifestyle', 'business', 'income'];
  for (var g = 0; g < groups.length; g++) {
    var rows = DD_CATALOG[groups[g]];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.title.toLowerCase() === lower || r.key.toLowerCase() === lower) {
        return _DD_resolveByCategoryKey_(r.key, pending);
      }
    }
  }
  // Generic includes-match against display titles.
  for (var g2 = 0; g2 < groups.length; g2++) {
    var rows2 = DD_CATALOG[groups[g2]];
    for (var i2 = 0; i2 < rows2.length; i2++) {
      if (rows2[i2].title.toLowerCase().indexOf(lower) >= 0) {
        return _DD_resolveByCategoryKey_(rows2[i2].key, pending);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payload builders (WhatsApp Cloud API)
// ---------------------------------------------------------------------------
function _DD_buildBodyText_(pending) {
  var amt = (pending.amount != null) ? String(pending.amount) : null;
  var tpl = amt ? DD_COPY.bodyTemplate : DD_COPY.bodyTemplateNoAmount;
  return tpl
    .replace('{text}', pending.text || '')
    .replace('{amount}', amt || '');
}

function _DD_buildCategoryListPayload_(phoneNumber, pending) {
  // WhatsApp interactive list: max 10 sections, max 10 rows each.
  // Row title <=24 chars, description <=72 chars, id <=200 chars.
  function toRows(groupRows) {
    var out = [];
    for (var i = 0; i < groupRows.length && i < 10; i++) {
      var r = groupRows[i];
      out.push({
        id: DD_ROW_PREFIX_CATEGORY + r.key,
        title: _DD_truncate_(r.title, 24),
        description: _DD_truncate_(r.desc, 72)
      });
    }
    return out;
  }
  var sections = [
    { title: DD_COPY.sectionPersonal,    rows: toRows(DD_CATALOG.personal) },
    { title: DD_COPY.sectionPersonal + ' / סגנון חיים', rows: toRows(DD_CATALOG.lifestyle) },
    { title: DD_COPY.sectionBusiness,    rows: toRows(DD_CATALOG.business) },
    { title: DD_COPY.sectionIncome,      rows: toRows(DD_CATALOG.income) },
    { title: DD_COPY.sectionOther,       rows: [
      {
        id: DD_ROW_PREFIX_CATEGORY + '_שונות',
        title: _DD_truncate_(DD_COPY.rowOther, 24),
        description: _DD_truncate_(DD_COPY.rowOtherDesc, 72)
      },
      {
        id: DD_ROW_ID_CANCEL,
        title: _DD_truncate_(DD_COPY.rowCancel, 24),
        description: _DD_truncate_(DD_COPY.rowCancelDesc, 72)
      }
    ] }
  ];
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(phoneNumber),
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: _DD_truncate_(DD_COPY.header, 60) },
      body: { text: _DD_truncate_(_DD_buildBodyText_(pending), 1024) },
      footer: { text: _DD_truncate_(DD_COPY.footer, 60) },
      action: {
        button: _DD_truncate_(DD_COPY.button, 20),
        sections: sections
      }
    }
  };
}

function _DD_buildRoutePayload_(phoneNumber, pending) {
  var amt = (pending.amount != null) ? String(pending.amount) : '?';
  var body = DD_COPY.routeBodyTemplate
    .replace('{text}', pending.text || '')
    .replace('{amount}', amt);
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(phoneNumber),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: _DD_truncate_(body, 1024) },
      action: {
        buttons: [
          { type: 'reply', reply: { id: DD_ROW_PREFIX_ROUTE + 'personal', title: _DD_truncate_(DD_COPY.rowRoutePersonal, 20) } },
          { type: 'reply', reply: { id: DD_ROW_PREFIX_ROUTE + 'business', title: _DD_truncate_(DD_COPY.rowRouteBusiness, 20) } },
          { type: 'reply', reply: { id: DD_ROW_ID_CANCEL,                   title: _DD_truncate_(DD_COPY.rowCancel, 20) } }
        ]
      }
    }
  };
}

function _DD_buildTextPayload_(phoneNumber, text) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(phoneNumber),
    type: 'text',
    text: { body: String(text || '') }
  };
}

function _DD_truncate_(s, max) {
  s = String(s || '');
  if (s.length <= max) return s;
  return s.substring(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// WhatsApp transport
// ---------------------------------------------------------------------------
function _DD_sendWhatsApp_(payload) {
  var cfg = _DD_getWaConfig_();
  if (!cfg.token || !cfg.phoneId) {
    return { ok: false, error: 'missing_wa_credentials' };
  }
  var url = 'https://graph.facebook.com/' + cfg.version + '/' + cfg.phoneId + '/messages';
  var options = {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + cfg.token },
    payload: JSON.stringify(payload)
  };
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, options);
  } catch (e) {
    return { ok: false, error: 'fetch_threw:' + (e && e.message ? e.message : String(e)) };
  }
  var code = resp.getResponseCode();
  if (code >= 200 && code < 300) {
    return { ok: true, code: code };
  }
  return { ok: false, error: 'http_' + code, body: resp.getContentText() };
}

// ---------------------------------------------------------------------------
// Confirmation message back to user after we resolved their pick
// ---------------------------------------------------------------------------
function sendClassificationConfirmation_(phoneNumber, resolved) {
  var subcat = (resolved && resolved.subcategory) ? resolved.subcategory : (resolved && resolved.category) || '';
  var amt = (resolved && resolved.amount != null) ? String(resolved.amount) : null;
  var tpl = amt ? DD_COPY.okSaved : DD_COPY.okSavedNoAmount;
  var msg = tpl.replace('{amount}', amt || '').replace('{subcat}', subcat);
  _DD_sendWhatsApp_(_DD_buildTextPayload_(phoneNumber, msg));
}

// ---------------------------------------------------------------------------
// Sample doPost integration. Copy the body of doPost_DROPDOWN_SAMPLE into
// your existing doPost(e). See DROPDOWN_README.md for the minimal snippet.
// ---------------------------------------------------------------------------
function doPost_DROPDOWN_SAMPLE(e) {
  // Webhook payload from WhatsApp Cloud API.
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput('bad_json');
  }

  var entry = (data.entry && data.entry[0]) || {};
  var change = (entry.changes && entry.changes[0]) || {};
  var value = change.value || {};
  var messages = value.messages || [];
  if (messages.length === 0) return ContentService.createTextOutput('no_messages');

  var msg = messages[0];
  var from = msg.from;
  var msgType = msg.type;

  // 1) Interactive reply path - check pending state first.
  if (msgType === 'interactive' && msg.interactive) {
    var inter = msg.interactive;
    var rowId = '';
    if (inter.type === 'list_reply' && inter.list_reply) rowId = inter.list_reply.id;
    else if (inter.type === 'button_reply' && inter.button_reply) rowId = inter.button_reply.id;
    var result = handleUserClassificationReply_(from, '', rowId);
    if (result.ok && result.action === 'resolved' && result.resolved) {
      if (typeof writeExpenseRow_ === 'function') writeExpenseRow_(result.resolved);
      sendClassificationConfirmation_(from, result.resolved);
    } else if (result.action === 'cancelled') {
      _DD_sendWhatsApp_(_DD_buildTextPayload_(from, 'בוטל. שלח הוצאה חדשה כשתרצה.'));
    } else if (result.action === 'expired') {
      _DD_sendWhatsApp_(_DD_buildTextPayload_(from, DD_COPY.errExpired));
    } else if (result.action === 'unknown') {
      _DD_sendWhatsApp_(_DD_buildTextPayload_(from, DD_COPY.errUnknownRow));
    }
    return ContentService.createTextOutput('ok');
  }

  // 2) Text path - either fulfill a pending pick by typed title or run classifier.
  if (msgType === 'text' && msg.text && msg.text.body) {
    var body = msg.text.body;

    // 2a) If pending exists, try to fulfill by typed text first.
    var pending = getPendingClassification_(from);
    if (pending && !_DD_isExpired_(pending)) {
      var tryReply = handleUserClassificationReply_(from, body, '');
      if (tryReply.ok && tryReply.action === 'resolved' && tryReply.resolved) {
        if (typeof writeExpenseRow_ === 'function') writeExpenseRow_(tryReply.resolved);
        sendClassificationConfirmation_(from, tryReply.resolved);
        return ContentService.createTextOutput('ok');
      }
      // else fall through - user probably sent a brand new expense
    }

    // 2b) Run the existing classifier.
    var classified = _SRC_classify_v2_(body);
    if (isUnsureClassification_(classified)) {
      askUserToClassify_(from, body, classified.amount, classified);
      return ContentService.createTextOutput('asked');
    }
    if (typeof writeExpenseRow_ === 'function') {
      writeExpenseRow_({
        category: classified.category,
        subcategory: classified.subcategory,
        routes_to: classified.routes_to,
        sheet: classified.sheet,
        is_income: classified.is_income,
        amount: classified.amount,
        original_text: body
      });
    }
    return ContentService.createTextOutput('ok');
  }

  return ContentService.createTextOutput('ignored');
}

// ---------------------------------------------------------------------------
// Manual test runners - select from the Apps Script function dropdown.
// ---------------------------------------------------------------------------
function TEST_DD_UNSURE_DETECTION() {
  var cases = [
    { name: 'low conf',     input: { confidence: 30, amount: 50, category: null } },
    { name: 'needs_q true', input: { confidence: 90, amount: 50, category: 'אוכל', needs_question: true } },
    { name: 'amount no cat',input: { confidence: 0,  amount: 99, category: null } },
    { name: 'high conf',    input: { confidence: 90, amount: 50, category: 'אוכל', subcategory: 'אוכל בחוץ', needs_question: false } }
  ];
  cases.forEach(function(c) {
    Logger.log(c.name + ' -> unsure=' + isUnsureClassification_(c.input));
  });
}

function TEST_DD_PENDING_ROUNDTRIP() {
  var phone = '972500000000';
  clearPendingClassification_(phone);
  _DD_setPending_(phone, { id: 'x', phone: phone, text: 'test', amount: 42, created_ms: Date.now(), mode: 'category' });
  var got = getPendingClassification_(phone);
  Logger.log('roundtrip: ' + (got && got.text === 'test' && got.amount === 42));
  clearPendingClassification_(phone);
  Logger.log('cleared: ' + (getPendingClassification_(phone) == null));
}

function TEST_DD_PAYLOAD_BUILD() {
  var pending = { phone: '972500000000', text: 'משהו לא ברור', amount: 87, mode: 'category', created_ms: Date.now() };
  var p = _DD_buildCategoryListPayload_(pending.phone, pending);
  Logger.log('sections=' + p.interactive.action.sections.length);
  Logger.log('first row id=' + p.interactive.action.sections[0].rows[0].id);
}
