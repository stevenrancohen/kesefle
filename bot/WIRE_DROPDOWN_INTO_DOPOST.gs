// WIRE_DROPDOWN_INTO_DOPOST.gs
//
// HOW TO USE THIS FILE:
// This is NOT a drop-in replacement for doPost. Instead, you paste these two new
// functions into a new Apps Script file, then make ONE small edit to ExpenseBot.gs's
// doPost (described at the very bottom of this file).
//
// What this does:
// - Adds a SAFE pre-classifier check that runs v2 classifier first.
// - If v2 says "unsure" (low confidence OR needs_question OR amount-no-category),
//   it sends the user a WhatsApp interactive list (the dropdown).
// - The user picks a category, the bot writes the row, done.
// - If v2 is confident, falls through to the existing legacy SRC_ROUTER_handle
//   (so installments, recurring, and all existing logic still works).
//
// PREREQUISITES (already in the project after pasting KESEFLE_ALL_PATCHES.gs):
// - _SRC_classify_v2_(text)
// - KESEFLE_KEYWORDS
//
// PREREQUISITES (already in the project after pasting DROPDOWN_FOR_UNSURE.gs):
// - isUnsureClassification_(result)
// - askUserToClassify_(phone, text, amount, classifyResult)
// - handleUserClassificationReply_(phone, replyText, selectedId)
// - sendClassificationConfirmation_(phone, resolved)

// ============================================================
// PRE-CLASSIFY: runs before the legacy router. Returns true if it handled the message.
// ============================================================
function PRE_CLASSIFY_DROPDOWN_(from, text, msg) {
  // 1. Handle interactive replies (user picked something from a dropdown we sent earlier)
  try {
    if (msg && msg.type === 'interactive' && msg.interactive) {
      var inter = msg.interactive;
      var rid = (inter.list_reply && inter.list_reply.id) ||
                (inter.button_reply && inter.button_reply.id) || '';
      if (rid) {
        var r = handleUserClassificationReply_(from, '', rid);
        if (r && r.ok && r.action === 'resolved') {
          // Write the row via the existing SRC writer convention.
          // SRC_ROUTER_handle expects (from, text); we synthesize a text it can route.
          // Alternative: call a more direct writer if you have one.
          // For now we leverage existing flow by reconstructing a clean expense text:
          var rebuilt = (r.resolved.amount || '') + ' ' + (r.resolved.subcategory || r.resolved.category || '');
          SRC_ROUTER_handle(from, rebuilt.trim());
          try { sendClassificationConfirmation_(from, r.resolved); } catch (e) {}
        }
        return true; // handled
      }
    }
  } catch (e) { Logger.log('PRE_CLASSIFY interactive error: ' + e.message); }

  // 2. For text messages, run v2 classifier and check if unsure
  try {
    if (typeof _SRC_classify_v2_ !== 'function' || !text) return false;
    var v2 = _SRC_classify_v2_(text);
    if (!v2 || !v2.amount) return false; // no amount = let legacy router handle (might be a summary query)
    if (typeof isUnsureClassification_ !== 'function') return false;
    if (!isUnsureClassification_(v2)) return false; // confident — legacy handles
    // Unsure: send the dropdown
    try {
      askUserToClassify_(from, text, v2.amount, v2);
      return true; // handled (waiting for user reply)
    } catch (e) {
      Logger.log('PRE_CLASSIFY ask error: ' + e.message);
      return false; // fall through to legacy
    }
  } catch (e) { Logger.log('PRE_CLASSIFY classify error: ' + e.message); }

  return false;
}

// ============================================================
// REQUIRED EDIT in ExpenseBot.gs doPost (after pasting this file):
// ============================================================
//
// Find this block in ExpenseBot.gs around line 153-157:
//
//     if (__msg_ && __msg_.from && typeof SRC_ROUTER_handle === "function") {
//       var __from_ = __msg_.from;
//       var __text_ = (__msg_.text && __msg_.text.body) || "";
//       if (__text_) {
//         var __routed_ = SRC_ROUTER_handle(__from_, __text_);
//         if (__routed_ && __routed_.handled) { ... }
//       }
//     }
//
// Change it to add a pre-classify check BEFORE SRC_ROUTER_handle:
//
//     if (__msg_ && __msg_.from && typeof SRC_ROUTER_handle === "function") {
//       var __from_ = __msg_.from;
//       var __text_ = (__msg_.text && __msg_.text.body) || "";
//
//       // === DROPDOWN PRE-CLASSIFY (added line) ===
//       if (typeof PRE_CLASSIFY_DROPDOWN_ === "function" && PRE_CLASSIFY_DROPDOWN_(__from_, __text_, __msg_)) {
//         return ContentService.createTextOutput("ok");
//       }
//       // === END DROPDOWN PRE-CLASSIFY ===
//
//       if (__text_) {
//         var __routed_ = SRC_ROUTER_handle(__from_, __text_);
//         ...
//       }
//     }
//
// That's the only edit. The pre-classify is non-destructive: if v2 is unsure it
// asks the user via dropdown and returns. Otherwise everything continues as before.
//
// ============================================================
// QUICK TEST (no WhatsApp API needed):
// ============================================================
function TEST_PRE_CLASSIFY_NO_AMOUNT() {
  // Should return false (no amount, lets legacy router handle it — useful for summary queries)
  var r = PRE_CLASSIFY_DROPDOWN_('+972500000000', 'היום?', { type: 'text', text: { body: 'היום?' } });
  Logger.log('no-amount -> handled=' + r + ' (expected false)');
}

function TEST_PRE_CLASSIFY_CONFIDENT() {
  // Should return false (clear match, lets legacy router write the row)
  var r = PRE_CLASSIFY_DROPDOWN_('+972500000000', '245 סופר', { type: 'text', text: { body: '245 סופר' } });
  Logger.log('confident -> handled=' + r + ' (expected false — legacy handles confident matches)');
}

function TEST_PRE_CLASSIFY_AMBIGUOUS_NO_WA() {
  // Should TRY to send a dropdown (will fail if WA_TOKEN not set, but we'll see the attempt in logs).
  var r = PRE_CLASSIFY_DROPDOWN_('+972500000000', '300 פייסבוק', { type: 'text', text: { body: '300 פייסבוק' } });
  Logger.log('ambiguous -> handled=' + r + ' (expected true — would send dropdown if WA configured)');
}
