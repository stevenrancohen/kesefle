---
name: bot-receipt-ocr
description: Debug the photo-receipt flow in the bot — _handleReceiptImage_ in bot/ExpenseBot_FIXED.gs — when a sent receipt photo isn't parsed correctly.
---

# Receipt OCR debug

The bot accepts WhatsApp image messages and runs them through OCR + LLM extraction. Entry point: `_handleReceiptImage_(fromPhone, image)` at line ~8388 in `bot/ExpenseBot_FIXED.gs`. Invoked from `doPost` around line ~1625.

## Steps
1. Get the original image from Steven (or have him forward the WhatsApp message). Save it locally.
2. Check Script Property `GEMINI_API_KEY` (or whatever provider is currently configured in `_handleReceiptImage_`) is set in Apps Script — missing key = silent failure, returns a generic "couldn't read".
3. In `_handleReceiptImage_`, log the raw OCR response before parsing. Apps Script: `Logger.log` + check Executions tab.
4. If amount is misread: the OCR likely returned correct text but the regex post-processing dropped/misread it. Inspect the parse step.
5. If category is wrong: the LLM extraction picked the wrong category. Tighten the prompt or fall back to the keyword matcher for the merchant name.
6. If the image returns "not a receipt": check the size / format guard at the top of the handler — WhatsApp images can arrive as `image/jpeg`, `image/heic`, `image/webp`.

## Verification
- Same image, replay locally → produces the expected `{ amount, merchant, category }`.
- Add the failing case as a snapshot to `bot/RECEIPT_PARSING.gs` test fixtures.
- Send the image from a test phone end-to-end after deploy.

## Common pitfalls
- HEIC images from iOS — confirm the OCR provider handles them.
- The bot writes the OCR'd row to the wrong sheet because the phone-to-sheet routing happens BEFORE OCR result is available — trace through the routing block; OCR output must thread the same isolation invariant.
- Forgetting to bump `KFL_BUILD_VERSION` after a parser tweak.
