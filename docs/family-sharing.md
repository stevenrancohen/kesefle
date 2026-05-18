# Family Sharing — Conceptual Design

Status: **PROPOSED** — backend not wired yet
Owners: Steven (product), Claude (drafted 2026-05-18)
Audience: anyone implementing the multi-tenant household layer.
Tier: paid "משפחה" plan (₪39/month, up to 4 users).

This doc is the source of truth for what the Kesefle family product *is*. The
shipped artifacts (`/family.html`, the bot `הזמן/משפחה/פרישה` commands, the
pricing card update) are stubs that match the model below. The KV/state layer
is **not built yet** — this doc explains what it has to do.

---

## 1. Goals & non-goals

### Goals
- **One household, one source of truth.** Two parents looking at expenses see
  the same numbers within seconds of either of them logging.
- **Low cognitive load.** A spouse should be able to start logging in <60s with
  no setup, just by joining via an invite link sent from WhatsApp.
- **Respect existing privacy posture.** No bank credentials, no central DB of
  raw transactions — data still lives in the household admin's Google Drive.
- **Don't break solo users.** Everything below is opt-in. Free/Pro plans stay
  exactly as they are today.

### Non-goals (v1)
- **Cross-household features** (multiple households per user, shared groups
  between extended family). One person = one household.
- **Per-member separate Sheets.** Aggregating across 4 separate Sheets via
  IMPORTRANGE is fragile and slow. Decision: one shared Sheet (see §3).
- **Real-time multi-currency reconciliation across members.** ILS only in v1.
- **Built-in chat between members.** They already have WhatsApp.

---

## 2. Data model

### 2.1 Entities

```
Household
  id               string (uuid, KV key prefix: "hh:<id>")
  name             string (e.g. "כהן", "משפחת לוי")
  tier             "family"
  createdAt        ISO 8601
  spreadsheetId    string — Google Sheet ID owned by adminUserId
  adminUserId      string — Google sub of the paying user
  memberIds        string[]  — Google subs of all members, including admin
  approvalThreshold number | null — if non-null, expenses >= this require admin OK
  privacyMode      "open" | "shared-totals-only"

HouseholdMember
  userId         string — Google sub
  householdId    string
  phoneE164      string — for inverse phone -> household routing
  displayName    string — short Hebrew first name shown in the תנועות sheet
  role           "admin" | "spouse" | "member" | "child"
  joinedAt       ISO 8601
  permissions    {
    canLog:        boolean,   // default true
    canSeeAll:     boolean,   // false = own-row read only
    canEditOthers: boolean,   // default false; admin/spouse can be true
    requireApprovalAboveILS: number | null  // overrides household threshold
  }

Invite
  code           string (6-char base32 — same KV pattern as account linking)
  householdId    string
  invitedBy      userId
  invitedPhone   string | null  — populated when admin types "הזמן 052-XXX"
  intendedRole   "spouse" | "member" | "child"
  expiresAt      ISO 8601 (10 minutes)
  consumed       boolean
```

### 2.2 KV layout

We piggyback on the same KV store used for WhatsApp account linking
(`phone:<E164>` -> `userSub`). Adds:

```
hh:<householdId>              -> Household JSON
hhmember:<userId>             -> { householdId, role } (one-to-one)
hhinvite:<code>               -> Invite JSON, TTL 600s
phone:<E164>                  -> userSub                       (unchanged)
```

Routing flow for an incoming WhatsApp message from phone `+9725...`:

1. `phone:<E164>` -> `userId` (existing).
2. `hhmember:<userId>` -> `{ householdId, role }`.
3. `hh:<householdId>` -> `{ spreadsheetId, ... }`.
4. Bot writes to the household sheet, marking column **"מי רשם"** with the
   member's `displayName`.

Members **without** a household record still write to their own sheet via the
legacy single-tenant path. The household lookup is additive, not destructive.

---

## 3. Sheet structure: ONE shared Sheet (recommended)

### 3.1 Why one Sheet (not aggregation)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **One shared Sheet** per household | Single source of truth; existing dashboard formulas just work; instant cross-member view; one place for backups | Permission management; admin owns the Drive file | **Chosen** |
| Per-member Sheets + aggregation | Each member fully owns their data; easier to leave | IMPORTRANGE is slow + flaky; dashboard breaks if one member is offline; reconciling categories across 4 sheets is its own product | Rejected |
| Per-member tabs in one Sheet | Half-and-half; no real benefit | Same dashboard rewrite work as option 1, less isolation | Rejected |

### 3.2 Schema changes to existing `תנועות` tab

Current columns (from `BOT_COMMANDS.gs` line 26):

```
A timestamp | B amount | C currency | D type | E category
F subcategory | G raw_text | H source | I message_id
```

Add **column J = "מי רשם"** (who logged it). Hebrew first name from
`HouseholdMember.displayName`, falls back to phone last-4 if unset.

This is the only schema change required. The dashboard's SUMIFS formulas are
unaffected because they don't reference column J.

### 3.3 Optional new tab: `בני בית`

Lightweight roster view for the admin:

```
A name | B phone | C role | D joined | E this-month total | F status
```

Column E is a SUMIFS over `תנועות[J]` matching `A`. No new bot logic needed —
existing SUMIFS engine handles it.

---

## 4. Permission model

Three roles map to three real personas:

### 4.1 Admin (the payer)
- Created automatically when someone subscribes to family tier.
- Owns the Sheet (Drive file).
- Can invite, kick, set thresholds, override approvals.
- Receives the WhatsApp confirmation for expense-approval flows.
- **Cannot leave** the household — must transfer admin first (v2) or cancel
  subscription (v1).

### 4.2 Spouse / co-admin
- Same as admin minus billing controls.
- Suggested default for a 2-person household.

### 4.3 Member / child
- Logs their own expenses; sees aggregate dashboard.
- `canSeeAll=false` hides other members' raw rows (totals still visible).
- Default approval threshold for `child` role: ₪200.

### 4.4 Approval flow (v1.5, not v1)
When `requireApprovalAboveILS` is hit:
1. Member sends "180 לגו" (above threshold).
2. Bot replies to member: "⏳ ממתין לאישור מאמא/אבא."
3. Bot DMs admin: "אישור הוצאה: דני • 180₪ • לגו. אשר/דחה?"
4. Admin replies "כן" / "לא" → bot writes (or doesn't) and notifies member.

Backing this needs a pending-expense queue in KV (`pending:<householdId>:<id>`,
TTL 24h). **v1 ships this as a toggle in the UI with the actual queue stubbed**
— good enough to validate demand without building the FSM.

---

## 5. Multi-tenant routing — when 4 phones write at once

### 5.1 The problem
Each phone hits the same Apps Script webhook. Today, the bot resolves
`from -> userSub -> sheetId` and writes there. With households, multiple
`userSub`s share one `sheetId`. Two writes within ~200ms can race.

### 5.2 The solution (write side)

Use the existing `LockService` script lock (already in `_doPost_orig`), but
**key it on the household**, not the script:

```js
var lockKey = 'household:' + householdId;
var lock = LockService.getDocumentLock();  // already document-scoped to the sheet
lock.tryLock(5000);
```

Since the Sheet is the document, `getDocumentLock()` already serializes writes
within one Sheet. The script lock that's there today is **stricter than
needed** for multi-tenant; we can downgrade to document lock per-Sheet, which
also unblocks cross-household parallelism. Action item for Steven.

### 5.3 The solution (routing side)

Phone-to-household resolution is a two-hop lookup:

```js
function resolveHouseholdForPhone_(phoneE164) {
  var userId = KV.get('phone:' + phoneE164);
  if (!userId) return null;                      // solo path

  var m = KV.get('hhmember:' + userId);
  if (!m) return { sheetId: userOwnSheet(userId), member: null }; // pre-family user

  var hh = KV.get('hh:' + m.householdId);
  if (!hh) return null;                          // dangling pointer — log+drop

  return { sheetId: hh.spreadsheetId, member: m, household: hh };
}
```

Cache the resolved object for the lifetime of one Lambda/Apps-Script execution
to avoid 3 KV reads per message.

### 5.4 Edge cases

- **Member also has a personal pre-family Sheet.** Once joined to a household,
  all new writes go to the household Sheet. Their old Sheet stays untouched
  (one-time export tool — out of scope for v1).
- **Two households invite the same phone.** Second invite is rejected with
  "המספר הזה כבר חבר במשפחה אחרת".
- **Admin removes themselves from Sheet permissions.** Periodic health-check
  job pings the admin; if Sheet is unreachable, fall back to telling member
  "הגיליון לא זמין כרגע, ננסה שוב בעוד דקה".
- **Member leaves.** Mark `hhmember` row deleted, remove their `displayName`
  from any future "מי רשם" autocomplete. Their historical rows stay — that's
  the family's data, not just theirs.

---

## 6. Bot commands (shipped as stubs in `ExpenseBot_FIXED.gs`)

| Phrase (HE) | Phrase (EN) | Role gate | Effect |
|---|---|---|---|
| `הזמן 052-XXX` | `invite 052-XXX` | admin, spouse | Create invite code, send WhatsApp link to that number |
| `הזמן` (no number) | `invite` | admin, spouse | Reply with a generic invite link, share manually |
| `משפחה` | `family` | any member | List current members + roles + permissions |
| `פרישה` | `leave` | non-admin | Leave the household; admin gets notified |

Implementation lives in `_handleFamilyCommand_` near the end of
`ExpenseBot_FIXED.gs`. Currently returns `TODO` placeholders that explain
exactly what KV calls are needed — see the file for the contract.

---

## 7. UI: `/family.html`

Built. See `/family.html` in the repo root. Key sections:

1. **Hero** — value prop in Hebrew, big CTA.
2. **3-step explainer** — Connect WhatsApp → Invite → See full picture.
3. **Interactive widget** — local-only JS, lets the visitor type 2-4 names+
   phones and previews how their `תנועות` sheet would look.
4. **Pricing reminder** — links to `/pricing#family`.
5. **FAQ** — privacy, billing, leaving, ownership.
6. **CTA** — sends to `/account?plan=family`.

Constraints: no new CDN dependencies; under 600 lines; mobile-first.

---

## 8. Pricing card update

`/pricing.html` family bullets are extended with:
- עד 4 חברי משפחה
- תצוגה משותפת
- אישור הוצאות גדולות (toggle)
- חוקי הוצאה לכל בן בית

These are commitments the product owes the user, not vaporware — see §4 and §7.

---

## 9. Implementation milestones (Steven)

| Milestone | What ships | Blocking? |
|---|---|---|
| **M0 (done)** | Marketing page + bot stubs + pricing copy | No |
| M1 | KV schema: `hh:*`, `hhmember:*`, `hhinvite:*` | Yes, for any real flow |
| M2 | `/api/family/invite`, `/api/family/accept` Vercel routes | Yes |
| M3 | Bot stubs wired to real KV (replace TODOs) | Yes |
| M4 | Approval-flow FSM + `pending:*` queue | No (toggle works without) |
| M5 | Admin transfer + member kick | No |

M1-M3 is the minimum viable family. M4+M5 are polish.

---

## 10. Open questions for Steven

1. **Drive ownership transfer when admin downgrades.** If admin drops to free,
   the Sheet is still theirs in Drive — do we silently degrade other members
   to read-only, or block the downgrade?
2. **Multiple WhatsApp numbers per user.** A spouse with two phones: should
   they be 1 member or 2? Recommend 1 member, both phones map to same userSub.
3. **What's the "trial" for family?** Pricing copy says "חודש ראשון חינם" —
   does that match Pro's 14-day trial or is it actually 30 days for family?
   Page currently says "ניסיון 14 ימים" via the existing button copy.
4. **WhatsApp Business vs personal number.** Currently we onboard via the
   single bot number. For a 4-person household, do we want per-household
   sub-numbers? Probably no — premature optimization.
