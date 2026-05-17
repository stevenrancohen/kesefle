# Scope Justifications — Copy-Paste Ready

When Google's OAuth consent screen asks you to justify each scope, paste these EXACTLY (Hebrew or English — Google accepts both, English is faster).

---

## `https://www.googleapis.com/auth/drive.file`

**One-line justification:**
> Used to create a single Google Sheet in the user's Drive at signup, and append rows to that Sheet whenever the user sends an expense via WhatsApp.

**Detailed (if asked):**
> Kesefle is a WhatsApp expense-tracking bot. When a user signs up:
> 1. We copy a master template Sheet into their Drive using `files.copy` (one-time)
> 2. From that point on, every expense they message the bot is written as a new row to that specific Sheet via `spreadsheets.values.append`
> 
> We never read or write to ANY other file in the user's Drive. The `drive.file` scope limits us to files we created, which is exactly the security boundary we want.

---

## `https://www.googleapis.com/auth/drive.readonly`

**One-line justification:**
> Required only to read our public template Sheet at signup, so we can duplicate it into the user's Drive. We do not read any of the user's other files.

**Detailed (if asked):**
> We maintain a single master template Sheet (Kesefle's own Sheet, ID: 1YRPf_X9cCVLxT1xWYQ9xwArsOyarMnw2P_FaBUIYwAE) shared as "Anyone with the link can view".
> 
> At signup, our backend calls `files.copy` with the template's ID. Google requires that the *user's OAuth token* has `drive.readonly` scope to read the source file during the copy — even though the file is publicly shared. This is a known Google API requirement, not a privacy concern.
> 
> After the copy completes, we never call any `drive.readonly` endpoint again for that user. We do NOT enumerate, list, or read any of the user's other Drive files.
> 
> Source code reference: see `/api/sheet/provision.js` in our codebase.

---

## `https://www.googleapis.com/auth/spreadsheets`

**One-line justification:**
> Used to append expense rows to the user's own Sheet (the one we created with drive.file).

**Detailed:**
> Every WhatsApp message the user sends ("245 supermarket") becomes a new row in their Sheet. The `spreadsheets` scope is required to call `values.append` and `batchUpdate` to write those rows and keep the sheet sorted chronologically.

---

## `openid`, `email`, `profile`

These are standard OpenID Connect scopes. Google doesn't usually ask for justification, but if they do:

**Justification:**
> Used to identify the signed-in user (via `sub`), display their name and email in our UI, and associate their WhatsApp number with their Google account. We don't request `email_verified` or any other profile fields.

---

## If Google asks "Why not use drive.appdata?"

Google sometimes suggests `drive.appdata` (a special folder hidden from the user) instead of `drive.file`. Our answer:

> Our value proposition is that users own their data. The Sheet is THEIR Sheet — visible in their Drive, editable, exportable, deletable. `drive.appdata` would put the Sheet in an opaque application folder the user can't access directly, which defeats the entire product. Our customers explicitly chose us because the data lives in their own Drive in a normal, visible Sheet.

---

## If Google asks about data retention

> We don't retain any user data on our servers. The user's Sheet lives in their own Google Drive. Our backend stores only:
> - The user's Google `sub` (anonymous identifier)
> - The user's WhatsApp number (E.164)
> - The Sheet ID we created for them
> - A refresh token (encrypted at rest)
> 
> All four are stored in Vercel KV. The user can delete everything by:
> 1. Revoking access at https://myaccount.google.com/permissions
> 2. Deleting their Sheet from their own Drive
> 3. Asking us to remove their record (instant deletion, no review)
