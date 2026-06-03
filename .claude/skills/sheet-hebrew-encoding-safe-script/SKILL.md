---
name: sheet-hebrew-encoding-safe-script
description: Write Apps Script paste-ready code where every Hebrew tab name, SUMIFS criterion, and label is encoded as backslash-u escape sequences so clipboard / browser bidi / chat-paste does not corrupt the string before it reaches the editor.
---

# Hebrew-safe Apps Script for paste

When you author an Apps Script file in this repo and Steven pastes it into the Apps Script editor via Chrome MCP, the Chrome clipboard path (and the editor's own bidi rendering on Cmd+S) can mangle Hebrew literals. Characters reorder; RLM/LRM marks (U+200E / U+200F) get injected; what looked like a Hebrew tab name in your editor ends up as backwards-Hebrew at runtime. The dashboard then cannot find the tab; the SUMIFS returns 0; Steven sees zeros and tells me the bot is broken.

This is documented in MEMORY.md: "clipboard pbcopy then Chrome corrupts UTF-8 Hebrew" + "chat-paste of Hebrew corrupts with bidi marks". The fix is unconditional: every Hebrew string in a `.gs` file that will be PASTED (not committed via git push and opened via the Apps Script GitHub integration) must use JavaScript Unicode escape sequences of the form backslash-u-XXXX (single backslash, lowercase u, four hex digits). Apps Script parses the escape into the real Hebrew character at runtime; the source file stays pure ASCII and survives every paste path.

## When to use

- Authoring any `bot/*.gs` that Steven will paste via Chrome MCP into the Apps Script editor.
- Authoring a one-off diagnostic / fix script (for example `FIX_TOTALS_PERSONAL`, `DIAG_DATA`) that I will send to Steven as a code block in chat.
- Adding new entries to `_PSF_*` constants in `bot/personal_sheet_fix.gs` or `COMPANY_EXPENSE_ROWS` criteria.

## When NOT to use

- File goes to git and Apps Script syncs it via the GitHub-Apps-Script integration. The file's raw bytes are preserved on disk and the editor does not re-encode.
- File is committed and Steven runs `clasp push` from a terminal. Clasp transfers raw bytes.
- The Hebrew is in a `// comment` only (comments are not load-bearing). Even then, prefer ASCII comments. Chat-pasted Hebrew comments can re-flow and break diff readability.

## The escape table — top Hebrew identifiers in this repo

Paste the left-hand string LITERALLY into your `.gs` source. The right-hand comment is for visual reference in this markdown only. Apps Script and Node both decode each escape into the actual Hebrew character at parse time. Do NOT type any Hebrew into your code.

- `'\u05DE\u05D0\u05D6\u05DF\u0020\u05D7\u05D1\u05E8\u05D4'`  // company dashboard tab
- `'\u05DE\u05D0\u05D6\u05DF\u0020\u05D0\u05D9\u05E9\u05D9'`  // personal dashboard tab
- `'\u05EA\u05E0\u05D5\u05E2\u05D5\u05EA'`  // transactions tab
- `'\u05D4\u05D6\u05DE\u05E0\u05D5\u05EA'`  // orders tab
- `'\u05E7\u05D8\u05D2\u05D5\u05E8\u05D9\u05D4'`  // col D header
- `'\u05E1\u05D4\u05F4\u05DB'`  // total-row prefix (note U+05F4 gershayim)
- `'\u05E1\u05D9\u05DB\u05D5\u05DD\u0020\u05D4\u05D9\u05E1\u05D8\u05D5\u05E8\u05D9'`  // year snapshot tab
- `'\u05D7\u05D5\u05D3\u05E9'`  // col B header
- `'\u05E1\u05DB\u05D5\u05DD'`  // col C header
- `'\u05E2\u05E1\u05E7'`  // top-level business category
- `'\u05D7\u05D5\u05DE\u05E8\u05D9\u0020\u05D2\u05DC\u05DD'`  // SUMIFS criterion R8 (raw materials)
- `'\u05E9\u05D9\u05D5\u05D5\u05E7'`  // SUMIFS criterion R9 (marketing)
- `'\u05DE\u05E9\u05DC\u05D5\u05D7'`  // SUMIFS criterion R10 (shipping)
- `'\u05EA\u05E4\u05E2\u05D5\u05DC\u05D9\u05D5\u05EA'`  // SUMIFS criterion R11 (operational)
- `'\u05D0\u05E8\u05D9\u05D6\u05D4'`  // extra criterion R10 (packaging)
- `'\u05DE\u05D7\u05D6\u05D5\u05E8'`  // revenue subcategory (turnover)
- `'\u05E4\u05D9\u05E8\u05D5\u05D8'`  // col F header (detail)
- `'\u05EA\u05D0\u05E8\u05D9\u05DA'`  // col A header (date)

Two gotchas the table captures:
- The total-row prefix uses U+05F4 GERESHAYIM, not ASCII double-quote. Steven's sheets use the gershayim form. `_FT_TOTAL_PREFIX_` in `sheet-fix-totals-by-label` matches it.
- The inter-word separator is ASCII space (U+0020). Some chat clients insert a non-breaking space (U+00A0) when you copy from a rendered message; that breaks `getSheetByName`. Encode the space as `\u0020` if paranoid.

## The Node CLI to encode any Hebrew string

When you need a label that is not in the table, regenerate it locally. Do NOT type Hebrew into the `.gs` file. Run this in a regular bash shell — the Hebrew goes on the command line only, never gets committed:

```bash
node -e "const s=process.argv[1]; let out=''; for (const c of s) out += String.fromCharCode(92) + 'u' + c.codePointAt(0).toString(16).padStart(4,'0').toUpperCase(); console.log(out);" 'YOUR_HEBREW_HERE'
```

A 6-character Hebrew word will output 36 characters of pure ASCII. Paste THAT into your `.gs` source. Confirm at runtime via:

```js
function _SELF_TEST_HEBREW_() {
  // Replace the literal below with the escape sequence for your tab name.
  Logger.log('\u05DE\u05D0\u05D6\u05DF\u0020\u05D7\u05D1\u05E8\u05D4'); // should print: maazan chevra in Hebrew
}
```

## Decoding what is on disk (to verify a paste landed clean)

If you suspect a paste corrupted a file, dump the bytes of the suspect line:

```bash
grep -n 'getSheetByName' bot/personal_sheet_fix.gs | head -3 | hexdump -C | head -10
```

Look for `e2 80 8e` (U+200E LRM) or `e2 80 8f` (U+200F RLM). Those are bidi marks injected by the clipboard path. Strip them with:

```bash
LC_ALL=C sed -i '' 's/\xe2\x80\x8e//g; s/\xe2\x80\x8f//g' bot/personal_sheet_fix.gs
```

## Verification

- `node --check bot/personal_sheet_fix.gs` — parses (escape sequences are valid JS).
- Add `_SELF_TEST_HEBREW_()` to any new paste-target file; have Steven run it once after paste. The Apps Script log should print clean Hebrew.
- Repo guard: any `.gs` you send to Steven via chat should have ZERO raw Hebrew bytes. Check with python (Hebrew range is U+0590..U+05FF):
  ```bash
  python3 -c "import re,sys; d=open(sys.argv[1]).read(); m=re.findall(r'[' + chr(0x590) + '-' + chr(0x5FF) + ']', d); print('raw hebrew chars:', len(m))" bot/your_new_file.gs
  ```
  Should print `raw hebrew chars: 0`.

## Examples

- **2026-05-28** — wrote `FIX_TOTALS_PERSONAL` with the personal-tab constant as raw Hebrew. Sent it to Steven, Chrome MCP pasted into Apps Script editor; `getSheetByName(personalTab)` returned null because the pasted string had RLM marks. Replaced the literal with `'\u05DE\u05D0\u05D6\u05DF\u0020\u05D0\u05D9\u05E9\u05D9'` — clean run.
- **2026-05-25** — `bot/personal_sheet_fix.gs:42-47` declares all 4 main tab constants as raw Hebrew. Works because Steven pastes via `clasp push` from his terminal, not via Chrome MCP. Anywhere we send code as a chat block, switch to escapes.

## Common pitfalls

- Encoding the Hebrew, then opening the result in VS Code with bidi-mirror enabled. The display may LOOK wrong but the bytes are fine. Trust `node --check` and `_SELF_TEST_HEBREW_()`, not the editor's rendering.
- Writing the escape with double backslash (eight characters) instead of single backslash (six characters). The double-backslash form is an 8-character literal, not an escape — Apps Script does NOT decode it. ALWAYS single backslash.
- Encoding only the tab name but leaving the SUMIFS criterion as raw Hebrew. The criterion gets bidi-mangled, SUMIFS returns 0, dashboard shows zeros. Encode EVERY Hebrew literal in the file or none of them.
- Forgetting U+05F4 gershayim vs ASCII double-quote in the total prefix. The walker in `sheet-fix-totals-by-label` uses U+05F4. If a tenant sheet uses ASCII quote instead, the prefix check misses every total row.

## Related skills

- [[test-hebrew-text]] — runtime assertion in Node tests that strings do not contain bidi marks or wrong brand spelling.
- [[hebrew-copy-check]] — broader Hebrew product copy validation (RTL, brand, grammar).
- [[bot-deploy-paste]] — the paste mechanism this skill protects.
- [[sheet-fix-totals-by-label]] — uses these escapes in `_FT_PERSONAL_TAB_` and `_FT_TOTAL_PREFIX_`.
- [[sheet-bot-taxonomy-reconcile]] — `DIAG_DATA` must also use escapes for the tab name lookup.
