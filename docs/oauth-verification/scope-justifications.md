# Scope Justifications — Copy-Paste Ready

When Google's OAuth consent screen asks you to justify each scope, paste these EXACTLY (Hebrew or English — Google accepts both, English is faster).

---

## `https://www.googleapis.com/auth/drive.file`

**One-line justification:**
> Used to create one Google Sheet in the user's Drive at signup, and read or write only that app-created Sheet when the user records a movement in Kesefle.

**Detailed (if asked):**
> Kesefle is a mobile-first expense-tracking app with an optional WhatsApp channel. When a user signs up:
> 1. We create a fresh spreadsheet in their Drive using `spreadsheets.create`
> 2. From that point on, every movement they submit is written to that specific Sheet via the Google Sheets API
> 
> We never enumerate, read, or write any other file in the user's Drive. The `drive.file` scope limits us to files the app created or the user explicitly opened with the app, which is the product's security boundary. We do not request `drive.readonly` or the broad `spreadsheets` scope.

---

## `openid`, `email`, `profile`

These are standard OpenID Connect scopes. Google doesn't usually ask for justification, but if they do:

**Justification:**
> Used to identify the signed-in user (via `sub`), display their name and email in our UI, and associate their private Sheet with the correct account. WhatsApp linking is optional and, when enabled, uses the same signed-in account.

---

## If Google asks "Why not use drive.appdata?"

Google sometimes suggests `drive.appdata` (a special folder hidden from the user) instead of `drive.file`. Our answer:

> Our value proposition is that users own their data. The Sheet is THEIR Sheet — visible in their Drive, editable, exportable, deletable. `drive.appdata` would put the Sheet in an opaque application folder the user can't access directly, which defeats the entire product. Our customers explicitly chose us because the data lives in their own Drive in a normal, visible Sheet.

---

## If Google asks about data retention

> We don't retain transaction contents in a central database. The user's Sheet lives in their own Google Drive. Our backend stores only the account metadata required to operate the service:
> - The user's Google `sub` (anonymous identifier)
> - The user's WhatsApp number (E.164)
> - The Sheet ID we created for them
> - A refresh token (encrypted at rest)
> 
> This metadata is stored in the service's encrypted/managed data stores. The user can remove access and delete their account by:
> 1. Revoking access at https://myaccount.google.com/permissions
> 2. Deleting their Sheet from their own Drive
> 3. Using Kesefle's account-deletion flow or asking support to remove the account record
