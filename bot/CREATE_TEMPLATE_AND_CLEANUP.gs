// CREATE_TEMPLATE_AND_CLEANUP.gs
//
// Two tasks in one file:
//   TASK A — Create a clean public template (no private data) for new Kesefle users.
//   TASK B — Clean up your private sheet by merging backup/draft tabs into one hidden "dontdelete" tab.
//
// SAFE TO RUN: every function shows a dry-run preview and creates backups before destructive changes.
// Run them in this order:
//   1. DRY_RUN_INVENTORY_TABS()              — see all tabs + what each will do (read-only)
//   2. CREATE_PUBLIC_TEMPLATE_DRY_RUN()       — preview the template creation (read-only)
//   3. CREATE_PUBLIC_TEMPLATE()                — actually create it
//   4. MERGE_BACKUPS_INTO_DONTDELETE_DRY_RUN()— preview the cleanup (read-only)
//   5. MERGE_BACKUPS_INTO_DONTDELETE()         — actually do the cleanup

var SOURCE_SHEET_ID_CT = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';

// Tabs to STRIP/REMOVE from the public template (also the same list for merge-into-dontdelete on private sheet)
var BACKUP_DRAFT_TABS = [
  '_BAK_dashFix_20260516_024638',
  '_MASTER_LOG_v2_',
  '_BAK_tnuot_20260516_052813',
  'מאזן חברה טיוטה',
  '_BACKUP_dashboard_2026-05-15_152535',
  '_BAK_oldlook_0515_154854',
  'טמפלט',
];

// Tabs that the bot + code rely on — MUST exist in the public template
var REQUIRED_TABS = [
  'תנועות',
  'מאזן חברה',
  'מאזן אישי',
  'מאזן חברה 2023',
  'מאזן חברה 2024',
  'מאזן חברה 2025',
  '_AUDIT_',
];

// ============================================================
// DRY_RUN_INVENTORY_TABS — list all tabs in the source sheet
// ============================================================
function DRY_RUN_INVENTORY_TABS() {
  var ss = SpreadsheetApp.openById(SOURCE_SHEET_ID_CT);
  var sheets = ss.getSheets();
  var lines = ['===== INVENTORY: tabs in private sheet =====', ''];
  sheets.forEach(function(sh, idx) {
    var name = sh.getName();
    var rows = sh.getLastRow();
    var cols = sh.getLastColumn();
    var status;
    if (REQUIRED_TABS.indexOf(name) >= 0) status = 'KEEP (required by code)';
    else if (BACKUP_DRAFT_TABS.indexOf(name) >= 0) status = 'MERGE to dontdelete';
    else status = 'OTHER (review)';
    lines.push((idx + 1) + '. ' + name + '  (' + rows + 'r x ' + cols + 'c)  ->  ' + status);
  });
  lines.push('');
  lines.push('Total tabs: ' + sheets.length);
  Logger.log(lines.join('\n'));
  try { SpreadsheetApp.getUi().alert(lines.join('\n')); } catch (e) {}
}

// ============================================================
// CREATE_PUBLIC_TEMPLATE_DRY_RUN — preview what will be created
// ============================================================
function CREATE_PUBLIC_TEMPLATE_DRY_RUN() {
  var ss = SpreadsheetApp.openById(SOURCE_SHEET_ID_CT);
  var sheets = ss.getSheets();
  var lines = ['===== DRY RUN: CREATE_PUBLIC_TEMPLATE =====', ''];
  lines.push('Will create new spreadsheet named: "Kesefle - Public Template"');
  lines.push('');
  lines.push('Tabs that will be COPIED + cleared of private data:');
  REQUIRED_TABS.forEach(function(name) {
    var sh = ss.getSheetByName(name);
    if (sh) lines.push('  ✓ ' + name + '  (' + sh.getLastRow() + 'r) — structure kept, data cleared');
    else lines.push('  ⚠ ' + name + ' NOT FOUND in source — skipped');
  });
  lines.push('');
  lines.push('Tabs that will NOT be copied to template:');
  BACKUP_DRAFT_TABS.forEach(function(name) {
    var sh = ss.getSheetByName(name);
    if (sh) lines.push('  ✗ ' + name + ' — removed from template');
  });
  sheets.forEach(function(sh) {
    var name = sh.getName();
    if (REQUIRED_TABS.indexOf(name) < 0 && BACKUP_DRAFT_TABS.indexOf(name) < 0) {
      lines.push('  ? ' + name + ' — OTHER tab, will be copied as-is (consider adding to BACKUP_DRAFT_TABS)');
    }
  });
  lines.push('');
  lines.push('After creation: template will be set to "Anyone with link can VIEW"');
  Logger.log(lines.join('\n'));
  try { SpreadsheetApp.getUi().alert(lines.join('\n')); } catch (e) {}
}

// ============================================================
// CREATE_PUBLIC_TEMPLATE — actually creates the template
// ============================================================
function CREATE_PUBLIC_TEMPLATE() {
  // 1. Make a Drive copy of the source
  var source = DriveApp.getFileById(SOURCE_SHEET_ID_CT);
  var copy = source.makeCopy("Kesefle - Public Template");
  var copyId = copy.getId();
  var newSs = SpreadsheetApp.openById(copyId);
  Logger.log('Copy created: ' + copyId);

  // 2. Delete ALL tabs that aren't in REQUIRED_TABS
  var sheets = newSs.getSheets().slice(); // copy because we'll modify
  sheets.forEach(function(sh) {
    var name = sh.getName();
    if (REQUIRED_TABS.indexOf(name) < 0) {
      try {
        newSs.deleteSheet(sh);
        Logger.log('Removed from template: ' + name);
      } catch (e) {
        Logger.log('Could not delete ' + name + ': ' + e.message);
      }
    }
  });

  // 3. Clear data from תנועות (keep header row 1)
  var tnuot = newSs.getSheetByName('תנועות');
  if (tnuot && tnuot.getLastRow() > 1) {
    var rows = tnuot.getLastRow() - 1;
    var cols = Math.max(tnuot.getLastColumn(), 9);
    tnuot.getRange(2, 1, rows, cols).clearContent();
    Logger.log('Cleared תנועות: ' + rows + ' data rows');
  }

  // 4. Clear hardcoded data in מאזן חברה year blocks
  var biz = newSs.getSheetByName('מאזן חברה');
  if (biz) {
    // 4 year blocks, 8 metric rows each, cols B-N (13 cols = sum + 12 months)
    var blocks = [
      { name: '2026', startRow: 6 },
      { name: '2025', startRow: 18 },
      { name: '2024', startRow: 30 },
      { name: '2023', startRow: 42 },
    ];
    blocks.forEach(function(b) {
      biz.getRange(b.startRow, 2, 8, 13).clearContent();
      Logger.log('Cleared מאזן חברה year ' + b.name);
    });
    // Multi-year comparison block r54-65, B-F
    try {
      biz.getRange(54, 2, 12, 5).clearContent();
      biz.getRange(15, 15, 65, 1).clearContent(); // col O sparklines if any
    } catch (e) { /* range may not exist */ }
  }

  // 5. Clear data from year tabs (preserve template structure cols A-L + M-N summary)
  ['מאזן חברה 2023', 'מאזן חברה 2024', 'מאזן חברה 2025'].forEach(function(name) {
    var yt = newSs.getSheetByName(name);
    if (!yt) return;
    var maxRow = yt.getMaxRows();
    // Clear order log rows 5..end
    if (maxRow > 4) {
      try { yt.getRange(5, 1, maxRow - 4, 12).clearContent(); } catch (e) {}
    }
    // Clear embedded month summary in cols M-N rows 13..31
    try { yt.getRange(13, 13, 19, 2).clearContent(); } catch (e) {}
    Logger.log('Cleared year tab: ' + name);
  });

  // 6. Clear מאזן אישי hardcoded numeric data (preserve formulas)
  var personal = newSs.getSheetByName('מאזן אישי');
  if (personal) {
    var maxR = Math.min(personal.getLastRow(), 200);
    var maxC = Math.min(personal.getLastColumn(), 20);
    if (maxR > 0 && maxC > 0) {
      var formulas = personal.getRange(1, 1, maxR, maxC).getFormulas();
      var values = personal.getRange(1, 1, maxR, maxC).getValues();
      for (var r = 0; r < maxR; r++) {
        for (var c = 0; c < maxC; c++) {
          var hasFormula = formulas[r][c] && formulas[r][c].length > 0;
          var val = values[r][c];
          if (!hasFormula && typeof val === 'number' && val !== 0) {
            personal.getRange(r + 1, c + 1).clearContent();
          }
        }
      }
    }
    Logger.log('Cleared מאזן אישי hardcoded data');
  }

  // 7. Set sharing to "Anyone with link can VIEW"
  try {
    DriveApp.getFileById(copyId).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    Logger.log('Sharing setup failed: ' + e.message);
  }

  // 8. Output the IDs
  var url = newSs.getUrl();
  var msg = [
    '===== PUBLIC TEMPLATE CREATED =====',
    '',
    'NEW SHEET ID (copy this into Vercel env var KESEFLE_TEMPLATE_SHEET_ID):',
    copyId,
    '',
    'URL:',
    url,
    '',
    'Next: update KESEFLE_TEMPLATE_SHEET_ID in Vercel + redeploy.',
  ].join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return copyId;
}

// ============================================================
// MERGE_BACKUPS_INTO_DONTDELETE_DRY_RUN — preview cleanup
// ============================================================
function MERGE_BACKUPS_INTO_DONTDELETE_DRY_RUN() {
  var ss = SpreadsheetApp.openById(SOURCE_SHEET_ID_CT);
  var lines = ['===== DRY RUN: MERGE_BACKUPS_INTO_DONTDELETE =====', ''];
  var totalRows = 0;
  BACKUP_DRAFT_TABS.forEach(function(name) {
    var sh = ss.getSheetByName(name);
    if (sh) {
      var r = sh.getLastRow();
      var c = sh.getLastColumn();
      lines.push('  • ' + name + ' (' + r + 'r x ' + c + 'c) — will be merged + deleted');
      totalRows += r;
    } else {
      lines.push('  ? ' + name + ' — not found, skipped');
    }
  });
  lines.push('');
  lines.push('Total data rows to merge: ' + totalRows);
  lines.push('');
  lines.push('All data goes into a hidden tab "dontdelete".');
  lines.push('To see "dontdelete" later: View → Show hidden sheets.');
  Logger.log(lines.join('\n'));
  try { SpreadsheetApp.getUi().alert(lines.join('\n')); } catch (e) {}
}

// ============================================================
// MERGE_BACKUPS_INTO_DONTDELETE — does the merge + cleanup
// ============================================================
function MERGE_BACKUPS_INTO_DONTDELETE() {
  var ss = SpreadsheetApp.openById(SOURCE_SHEET_ID_CT);

  // Create or get "dontdelete"
  var dd = ss.getSheetByName('dontdelete');
  if (!dd) {
    dd = ss.insertSheet('dontdelete');
  }

  var merged = 0;
  var skipped = 0;
  BACKUP_DRAFT_TABS.forEach(function(name) {
    var src = ss.getSheetByName(name);
    if (!src) { skipped++; Logger.log('Skipping (not found): ' + name); return; }

    var lastRow = src.getLastRow();
    var lastCol = src.getLastColumn();
    var ddNextRow = Math.max(dd.getLastRow() + 2, 1);

    // Append a clear separator header
    dd.getRange(ddNextRow, 1)
      .setValue('========== ' + name + ' (archived ' + new Date().toISOString().slice(0, 10) + ') ==========')
      .setFontWeight('bold')
      .setBackground('#f3f4f6');

    // Copy data over (if any)
    if (lastRow > 0 && lastCol > 0) {
      try {
        var data = src.getRange(1, 1, lastRow, lastCol).getValues();
        dd.getRange(ddNextRow + 1, 1, data.length, data[0].length).setValues(data);
      } catch (e) {
        Logger.log('Could not copy data from ' + name + ': ' + e.message);
      }
    }

    // Delete the source tab
    try {
      ss.deleteSheet(src);
      merged++;
      Logger.log('Merged + deleted: ' + name);
    } catch (e) {
      Logger.log('Could not delete ' + name + ': ' + e.message);
    }
  });

  // Hide the dontdelete tab
  try { dd.hideSheet(); } catch (e) {}

  var msg = [
    '===== MERGE COMPLETE =====',
    '',
    'Merged: ' + merged + ' tabs',
    'Skipped: ' + skipped + ' tabs',
    '',
    'All data preserved in hidden "dontdelete" tab.',
    'To see it: View → Show hidden sheets.',
  ].join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
}

// ============================================================
// VERIFY_AFTER — sanity check after cleanup
// ============================================================
function VERIFY_AFTER() {
  var ss = SpreadsheetApp.openById(SOURCE_SHEET_ID_CT);
  var lines = ['===== VERIFY AFTER CLEANUP =====', ''];
  var sheets = ss.getSheets();
  lines.push('Total tabs now: ' + sheets.length);
  lines.push('');

  // Check required tabs still exist
  lines.push('Required tabs:');
  REQUIRED_TABS.forEach(function(name) {
    var sh = ss.getSheetByName(name);
    lines.push('  ' + (sh ? '✓' : '✗') + ' ' + name);
  });

  // Check backup tabs are gone
  lines.push('');
  lines.push('Backup tabs (should all be gone):');
  BACKUP_DRAFT_TABS.forEach(function(name) {
    var sh = ss.getSheetByName(name);
    lines.push('  ' + (sh ? '⚠ still here' : '✓ gone') + '  ' + name);
  });

  // List any other tabs
  lines.push('');
  lines.push('Other tabs:');
  sheets.forEach(function(sh) {
    var n = sh.getName();
    if (REQUIRED_TABS.indexOf(n) < 0 && n !== 'dontdelete') {
      lines.push('  • ' + n);
    }
  });

  Logger.log(lines.join('\n'));
  try { SpreadsheetApp.getUi().alert(lines.join('\n')); } catch (e) {}
}
