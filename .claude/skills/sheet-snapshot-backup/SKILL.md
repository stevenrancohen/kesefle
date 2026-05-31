---
name: sheet-snapshot-backup
description: Make a frozen CSV backup of every tab in a sheet before any risky operation. Output under snapshots/{YYYY-MM-DD}/{sheet-id}/{tab}.csv. The user-mandated backup-first rule.
---

# Snapshot every tab to CSV

Steven's standing rule (MEMORY: `feedback_backup_propose_apply.md`): backup before any sheet write, propose the change before applying it. This skill makes the backup half automatic — every tab is exported to a timestamped folder.

## Steps

1. Confirm the snapshots directory exists:
   ```
   mkdir -p /Users/stevenrancohen/Documents/Claude/Projects/kesefle/snapshots/$(date +%F)
   ```
2. Get the list of tabs in the target sheet. Apps Script side is easiest. The export function:
   ```js
   function SNAPSHOT_ALL_TABS() {
     var SHEET_ID = 'PUT_SHEET_ID_HERE';
     var ss = SpreadsheetApp.openById(SHEET_ID);
     var dateStr = Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd');
     var folder = DriveApp.createFolder('kesefle-snapshot-' + SHEET_ID + '-' + dateStr);
     ss.getSheets().forEach(function(sh) {
       var url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID +
                 '/export?format=csv&gid=' + sh.getSheetId();
       var blob = UrlFetchApp.fetch(url, {
         headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
       }).getBlob();
       blob.setName(sh.getName() + '.csv');
       folder.createFile(blob);
     });
     Logger.log('Snapshot folder: ' + folder.getUrl());
   }
   ```
3. Run it. Note the Drive folder URL it logged.
4. Mirror to local repo (so it's tracked alongside the change that needed the backup):
   ```
   # Steven downloads the zip from the Drive folder, then:
   mkdir -p snapshots/$(date +%F)/<sheet-id>/
   unzip ~/Downloads/kesefle-snapshot-*.zip -d snapshots/$(date +%F)/<sheet-id>/
   ```
5. Verify file count matches tab count:
   ```
   ls snapshots/$(date +%F)/<sheet-id>/*.csv | wc -l
   ```
6. Note the snapshot location in your next commit message (`commit-message-style` requires it for any sheet-touching change).

## Verification
- `snapshots/{date}/{sheet-id}/` exists and contains one CSV per tab.
- A spot-check of one CSV shows expected headers in column A.
- File sizes are non-zero (zero-byte files = empty tab, fine; but ALL zero = broken export).

## Common pitfalls
- Exporting only the visible sheet — the script must iterate `getSheets()`, not just `getActiveSheet()`.
- Snapshotting AFTER a destructive operation instead of before → useless. The rule is BEFORE.
- Forgetting to commit the snapshot folder — `.gitignore` may exclude it; double-check before opening a PR that needs the backup as evidence.

## Examples
- "Before running Migration_Phase_2 APPLY, snapshot the NEW sheet" → run this.
- "Before bulk-deleting orphan rows" → run this, then `sheet-orphan-row-cleanup`.
