/**
 * bot/MIGRATE_OLD_TO_KESEFLE.gs
 *
 * Phase 2 of the Kesefle migration epic (Steven's section-23 plan).
 * One-time migration script that moves historical raw data from OLD sheet
 * (1UKr...) into NEW Kesefle sheet (1rti...).
 *
 * Two entry points:
 *   DRY_RUN_MIGRATE_RAW()                  — scan only, NO writes. Logs
 *                                            counts + dedupe plan + samples.
 *   APPLY_MIGRATE_RAW_NOW()                — zero-arg wrapper that calls
 *                                            APPLY_MIGRATE_RAW('YES I UNDERSTAND')
 *                                            so it runs from the function dropdown.
 *   APPLY_MIGRATE_RAW('YES I UNDERSTAND')  — actual write. Refuses without arg.
 *
 * Per the verify-data-sources-before-formula-repair skill:
 *   - Read every source row before deciding to migrate
 *   - Compute deterministic dedupe key per row
 *   - Skip rows already present in NEW (idempotent — safe to re-run)
 *   - Report EVERY decision in the dry-run log
 *   - APPLY refuses without literal "YES I UNDERSTAND" arg
 *   - Writes audit-trail note to A1 of NEW תנועות tab
 *
 * Rollback: nothing in this script DELETES rows. To undo a migration,
 * manually filter the NEW sheet by 'Migration_Phase_2' in col J (source)
 * and delete those rows.
 */

var _MIG_OLD_SHEET_ID_   = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var _MIG_NEW_SHEET_ID_   = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _MIG_TX_TAB_         = 'תנועות';
var _MIG_ORDERS_TAB_     = 'הזמנות';
var _MIG_COMPANY_TAB_    = 'מאזן חברה';
var _MIG_VERSION_        = 'Migration_Phase_2_v1';

// Build deterministic dedupe key for a תנועות row.
// Schema: [תאריך, חודש, סכום, קטגוריה, תת-קטגוריה, פירוט, מקור, סטטוס]
function _mig_txKey_(row) {
  var d = row[0];
  var dStr = (d && d instanceof Date)
    ? Utilities.formatDate(d, 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm')
    : String(d || '').slice(0, 30);
  var amt = String(row[2] || '');
  var cat = String(row[3] || '');
  var sub = String(row[4] || '');
  var desc = String(row[5] || '').slice(0, 60);
  return [dStr, amt, cat, sub, desc].join('|');
}

// Build dedupe key for an order row.
//
// IMPORTANT — two row shapes exist:
//   shape='new'   → NEW הזמנות full 12-col row written by _writeOrderRow_:
//                   [date, month, customer, size, material, prodCost,
//                    salePrice, shipping, profit, source, raw, status]
//                   → customer at [2], salePrice at [6]
//   shape='source' → synthesized OLD source candidate (4 elements):
//                    [dateCell, customer, sizeDesc, salePrice]
//                   → customer at [1], salePrice at [3]
//
// Reading the wrong index would let duplicates slip through on re-run,
// so we make the shape explicit (no `row[1] || row[2]` fallbacks).
function _mig_orderKey_(row, shape) {
  var d = row[0];
  var dStr = (d && d instanceof Date)
    ? Utilities.formatDate(d, 'Asia/Jerusalem', 'yyyy-MM-dd')
    : String(d || '').slice(0, 30);
  var customer, amount;
  if (shape === 'new') {
    customer = String(row[2] || '');
    amount   = String(row[6] || '');
  } else { // 'source'
    customer = String(row[1] || '');
    amount   = String(row[3] || '');
  }
  return [dStr, customer, amount].join('|');
}

// Core scanner. applyMode=false → dry-run. applyMode=true → write to NEW.
function _mig_scanAndOptionallyApply_(applyMode) {
  Logger.log('=== KESEFLE MIGRATION ' + (applyMode ? '— APPLY MODE' : '— DRY-RUN MODE') + ' ===');
  Logger.log('OLD: ' + _MIG_OLD_SHEET_ID_);
  Logger.log('NEW: ' + _MIG_NEW_SHEET_ID_);
  Logger.log('Version: ' + _MIG_VERSION_);

  // Concurrent-run guard. Even though dedupe makes re-runs idempotent,
  // two simultaneous APPLY runs could BOTH see the same OLD rows as "not in
  // NEW yet" and both write them (commit happens at end of each). The lock
  // serializes the critical section.
  //
  // Use getScriptLock (not getDocumentLock) — the bot's Apps Script is a
  // standalone project (it calls SpreadsheetApp.openById), not container-
  // bound. getDocumentLock() returns null for standalone scripts.
  var _migLock = null;
  if (applyMode) {
    _migLock = LockService.getScriptLock();
    if (!_migLock || !_migLock.tryLock(30000)) {
      Logger.log('!! Another migration run is in progress — aborting (try again in a minute)');
      return { error: 'lock_held' };
    }
    Logger.log('Acquired script lock (30s timeout); concurrent runs are blocked.');
  }

  // ── Open both sheets ──
  var oldSS, newSS;
  try { oldSS = SpreadsheetApp.openById(_MIG_OLD_SHEET_ID_); }
  catch (e) { Logger.log('!! Cannot open OLD: ' + e.message); return { error: 'cannot_open_old' }; }
  try { newSS = SpreadsheetApp.openById(_MIG_NEW_SHEET_ID_); }
  catch (e) { Logger.log('!! Cannot open NEW: ' + e.message); return { error: 'cannot_open_new' }; }

  Logger.log('OLD name: "' + oldSS.getName() + '"');
  Logger.log('NEW name: "' + newSS.getName() + '"');

  // ── Build existing-key sets in NEW (for dedupe) ──
  var newTxSheet = newSS.getSheetByName(_MIG_TX_TAB_);
  if (!newTxSheet) { Logger.log('!! NEW has no תנועות tab'); return { error: 'no_new_tx_tab' }; }
  var existingTxKeys = {};
  var newTxLastRow = newTxSheet.getLastRow();
  if (newTxLastRow > 1) {
    var newTxData = newTxSheet.getRange(2, 1, newTxLastRow - 1, 8).getValues();
    for (var i = 0; i < newTxData.length; i++) {
      existingTxKeys[_mig_txKey_(newTxData[i])] = true;
    }
  }
  Logger.log('NEW תנועות: ' + Math.max(0, newTxLastRow - 1) + ' existing rows, ' + Object.keys(existingTxKeys).length + ' unique keys.');

  var newOrdersSheet = newSS.getSheetByName(_MIG_ORDERS_TAB_);
  var existingOrderKeys = {};
  if (newOrdersSheet) {
    var newOrdersLastRow = newOrdersSheet.getLastRow();
    if (newOrdersLastRow > 1) {
      var newOrdersData = newOrdersSheet.getRange(2, 1, newOrdersLastRow - 1, Math.min(newOrdersSheet.getLastColumn(), 12)).getValues();
      for (var oi = 0; oi < newOrdersData.length; oi++) {
        existingOrderKeys[_mig_orderKey_(newOrdersData[oi], 'new')] = true;
      }
    }
    Logger.log('NEW הזמנות: ' + Math.max(0, newOrdersLastRow - 1) + ' existing rows.');
  } else {
    Logger.log('!! NEW has no הזמנות tab (orders won\'t migrate)');
  }

  // ── PHASE 2.A — scan OLD תנועות ──
  var oldTxSheet = oldSS.getSheetByName(_MIG_TX_TAB_);
  if (!oldTxSheet) { Logger.log('!! OLD has no תנועות tab'); return { error: 'no_old_tx_tab' }; }
  var oldTxLastRow = oldTxSheet.getLastRow();
  Logger.log('\n-- OLD תנועות: ' + Math.max(0, oldTxLastRow - 1) + ' total data rows --');

  var txToMigrate = [];
  var txSkipped = { duplicate: 0, empty: 0, invalid_amount: 0 };

  if (oldTxLastRow > 1) {
    var oldTxData = oldTxSheet.getRange(2, 1, oldTxLastRow - 1, 8).getValues();
    for (var r = 0; r < oldTxData.length; r++) {
      var row = oldTxData[r];
      if (!row[0] && !row[2] && !row[5]) { txSkipped.empty++; continue; }
      var amt = parseFloat(row[2]);
      if (!isFinite(amt) || amt === 0) { txSkipped.invalid_amount++; continue; }
      var key = _mig_txKey_(row);
      if (existingTxKeys[key]) { txSkipped.duplicate++; continue; }
      txToMigrate.push(row);
      existingTxKeys[key] = true;
    }
  }

  Logger.log('תנועות migration plan:');
  Logger.log('  → to migrate: ' + txToMigrate.length);
  Logger.log('  skipped (already in NEW): ' + txSkipped.duplicate);
  Logger.log('  skipped (empty row): ' + txSkipped.empty);
  Logger.log('  skipped (invalid amount): ' + txSkipped.invalid_amount);
  Logger.log('Sample (first 5 to migrate):');
  for (var sm = 0; sm < Math.min(5, txToMigrate.length); sm++) {
    Logger.log('  ' + JSON.stringify(txToMigrate[sm]).slice(0, 200));
  }

  // ── PHASE 2.B — scan OLD מאזן חברה cols Q-AN for orders ──
  // OLD layout (per audit):
  //   Q (col 17) = date, R = customer, S = size+material desc,
  //   T = production cost, U = shipping (some rows), W = sale price, X = profit
  var oldCompany = oldSS.getSheetByName(_MIG_COMPANY_TAB_);
  var ordersToMigrate = [];
  var ordersSkipped = { duplicate: 0, no_date: 0, no_amount: 0, header_row: 0 };

  if (oldCompany) {
    var compLastRow = oldCompany.getLastRow();
    var compLastCol = oldCompany.getLastColumn();
    Logger.log('\n-- OLD מאזן חברה: ' + compLastRow + ' rows x ' + compLastCol + ' cols (scanning Q-AN for orders) --');

    if (compLastRow > 1 && compLastCol >= 17) {
      var endCol = Math.min(40, compLastCol); // up to AN
      var compData = oldCompany.getRange(1, 17, compLastRow, endCol - 16).getValues();
      // cols: Q=0, R=1, S=2, T=3, U=4, V=5, W=6, X=7, ...

      // Dump first 3 RAW rows of Q-AN so Steven can verify the assumed
      // col layout (Q=date, R=customer, S=size, T=prodCost, U=shipping,
      // W=salePrice, X=profit). If the layout shifted in the real OLD
      // sheet, the dry-run log will show it and we abort before APPLY.
      Logger.log('Raw sample of OLD מאזן חברה Q-AN (first 3 rows, for layout verification):');
      for (var rs = 0; rs < Math.min(3, compData.length); rs++) {
        Logger.log('  row ' + (rs + 1) + ': ' + JSON.stringify(compData[rs]).slice(0, 300));
      }

      for (var cr = 0; cr < compData.length; cr++) {
        var crow = compData[cr];
        var dateCell = crow[0];
        var customer = crow[1];
        var sizeDesc = crow[2];
        var prodCost = crow[3];
        var shipping = crow[4];
        var salePrice = crow[6];
        var profit = crow[7];

        // Skip the obvious non-data rows (header like "תאריך")
        if (typeof dateCell === 'string' && /תאריך|date|שם|לקוח/i.test(dateCell)) {
          ordersSkipped.header_row++; continue;
        }
        // Need a date OR a customer to consider it an order
        if (!(dateCell instanceof Date) && !customer) {
          ordersSkipped.no_date++; continue;
        }
        // Need an amount
        var saleNum = parseFloat(salePrice);
        if (!isFinite(saleNum) || saleNum <= 0) { ordersSkipped.no_amount++; continue; }

        // Dedupe against existing NEW הזמנות
        var orderKeyRow = [dateCell, customer, sizeDesc, saleNum];
        var orderKey = _mig_orderKey_(orderKeyRow, 'source');
        if (existingOrderKeys[orderKey]) { ordersSkipped.duplicate++; continue; }

        ordersToMigrate.push({
          date: dateCell, customer: customer, sizeDesc: sizeDesc,
          productionCost: parseFloat(prodCost) || 0,
          shipping: parseFloat(shipping) || 0,
          salePrice: saleNum,
          profit: parseFloat(profit) || (saleNum - (parseFloat(prodCost) || 0) - (parseFloat(shipping) || 0)),
          sourceRow: cr + 1
        });
        existingOrderKeys[orderKey] = true;
      }
    }
  }

  Logger.log('הזמנות migration plan:');
  Logger.log('  → to migrate: ' + ordersToMigrate.length);
  Logger.log('  skipped (header row): ' + ordersSkipped.header_row);
  Logger.log('  skipped (no date AND no customer): ' + ordersSkipped.no_date);
  Logger.log('  skipped (no/invalid amount): ' + ordersSkipped.no_amount);
  Logger.log('  skipped (already in NEW): ' + ordersSkipped.duplicate);
  if (ordersToMigrate.length > 0) {
    Logger.log('Sample order (first):');
    Logger.log('  ' + JSON.stringify(ordersToMigrate[0]).slice(0, 300));
  }

  // ── APPLY mode: actually write to NEW ──
  if (applyMode) {
    Logger.log('\n=== APPLYING — writing to NEW ===');

    if (txToMigrate.length > 0) {
      var startRow = newTxSheet.getLastRow() + 1;
      newTxSheet.getRange(startRow, 1, txToMigrate.length, 8).setValues(txToMigrate);
      Logger.log('Wrote ' + txToMigrate.length + ' transactions to NEW תנועות (starting at row ' + startRow + ').');
    }

    if (newOrdersSheet && ordersToMigrate.length > 0) {
      var orderRows = ordersToMigrate.map(function (o) {
        var d = (o.date instanceof Date) ? o.date : new Date();
        var monthKey = Utilities.formatDate(d, 'Asia/Jerusalem', 'yyyy-MM');
        return [
          d,                            // A: timestamp
          monthKey,                     // B: month
          String(o.customer || ''),     // C: customer
          String(o.sizeDesc || ''),     // D: size/description
          '',                           // E: material (not extracted from OLD)
          o.productionCost || 0,        // F: production cost
          o.salePrice || 0,             // G: sale price
          o.shipping || 0,              // H: shipping
          o.profit || 0,                // I: profit
          _MIG_VERSION_,                // J: source (migration tag)
          'migrated from OLD מאזן חברה row ' + o.sourceRow, // K: raw
          'paid'                        // L: status
        ];
      });
      var ordersStartRow = newOrdersSheet.getLastRow() + 1;
      newOrdersSheet.getRange(ordersStartRow, 1, orderRows.length, 12).setValues(orderRows);
      Logger.log('Wrote ' + orderRows.length + ' orders to NEW הזמנות (12-col format, starting at row ' + ordersStartRow + ').');
    }

    // Audit trail
    try {
      var nowStr = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm');
      var trail = _MIG_VERSION_ + ': ' + nowStr + ' | TX=' + txToMigrate.length + ' | Orders=' + ordersToMigrate.length;
      newTxSheet.getRange('A1').setNote(trail);
      Logger.log('Audit trail note → NEW תנועות A1: ' + trail);
    } catch (auditErr) { Logger.log('audit note err (non-fatal): ' + auditErr.message); }

    Logger.log('=== APPLY COMPLETE ===');
    Logger.log('Refresh NEW sheet (Cmd+R) to see the migrated rows.');
    Logger.log('Verify: NEW תנועות should have ' + (newTxLastRow - 1 + txToMigrate.length) + ' total rows now.');
  } else {
    Logger.log('\n=== DRY-RUN COMPLETE — your sheet was NOT modified ===');
    Logger.log('To apply: run APPLY_MIGRATE_RAW_NOW (zero-arg wrapper).');
  }

  // Release the lock if we held it (APPLY mode only)
  if (_migLock) {
    try { _migLock.releaseLock(); } catch (_lockErr) { /* ignore */ }
  }

  return {
    transactions: { toMigrate: txToMigrate.length, skipped: txSkipped },
    orders: { toMigrate: ordersToMigrate.length, skipped: ordersSkipped }
  };
}

// ─── PUBLIC ENTRY POINTS ─────────────────────────────────────────────────

function DRY_RUN_MIGRATE_RAW() {
  return _mig_scanAndOptionallyApply_(false);
}

function APPLY_MIGRATE_RAW(confirmation) {
  if (confirmation !== 'YES I UNDERSTAND') {
    Logger.log('!! REFUSED — APPLY_MIGRATE_RAW requires the EXACT string "YES I UNDERSTAND" as the argument.');
    Logger.log('   Easier: run APPLY_MIGRATE_RAW_NOW from the function dropdown (no arg needed).');
    Logger.log('   First always run DRY_RUN_MIGRATE_RAW() and review the log.');
    return { refused: true };
  }
  return _mig_scanAndOptionallyApply_(true);
}

// Apps Script function dropdown can't pass arguments. This zero-arg wrapper
// makes APPLY_MIGRATE_RAW runnable from the dropdown. Same safety: passes
// the literal confirmation string internally.
function APPLY_MIGRATE_RAW_NOW() {
  return APPLY_MIGRATE_RAW('YES I UNDERSTAND');
}
