---
name: kesefle-drive-export-large-file
description: Read the live Kesefle sheet when the Google Drive connector's download_file_content exceeds the tool-result token cap — it auto-saves the base64 to a file; decode it to xlsx and openpyxl it, all in one Bash so the giant base64 never enters context. Use for any live-sheet read via the Drive connector.
---

# Reading the live sheet when the Drive export is too big

`mcp__c89b69d5…__download_file_content` on the Kesefle sheet (export mime `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) returns ~185 KB of base64 — over the result cap, so the harness **saves it to a file** and returns the path. Don't try to read that file into context; decode it in one Bash:

```python
import json, base64
d = json.load(open(SAVED_TOOL_RESULT_PATH))   # {content, id, mimeType, title}
open('/tmp/live.xlsx','wb').write(base64.b64decode(d['content']))
import openpyxl
wb = openpyxl.load_workbook('/tmp/live.xlsx', data_only=True)   # cached values
# ... probe תנועות / עסק תמונות / מאזן אישי ...
```

## Notes
- `data_only=True` = cached cell values; `data_only=False` = formulas. Google-only funcs (SUMPRODUCT/REGEXMATCH) export as `__xludf.DUMMYFUNCTION` with a possibly-stale cached value — for truth, read the underlying `תנועות` DATA, not the cached dashboard cell ([[kesefle-reconcile-live-before-building]]).
- The connector is authed as stevenrancohen and reads the NEW sheet only, not the OLD ([[kesefle-drive-connector-access-limits]]).
- For a one-cell/one-column lookup, run the decode + a tiny query in a SUBAGENT so the base64 never touches the main context. Sheet id: `1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A`. See [[kesefle-live-sheet-read-via-drive]].
