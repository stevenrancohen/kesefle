# Partner Sharing — Design Doc

> Steven 2026-05-26: replaces the deleted /family + /group pages.
> "כל אחד כותב את ההוצאה שלו, במידה וכל צד מאשר לצד השני לראות את
> הוצאות הבית אז יש להם גיליון משותף או מידע משותף שהם מוכנים לתת"

## The user problem

Two people live together. They each:
- Have their own bot (own phone, own sheet)
- Log their own expenses privately
- Want to share **only the household-related expenses** with each other

The existing `/family` and `/group` flows force a binary choice: either everything is shared, or nothing. That's wrong for couples — most of life is personal (my coffee, my hobby) but some of it is shared (the rent, the electricity, the groceries for both of us).

## The principle

**Mutual consent + selective sharing.** Both people must opt-in. Neither sees the other's private expenses. Only categories both have flagged as "shared" become visible to the other side.

## Flow

### Step 1 — Invite

Alice (already a user) sends:
```
כספלה שתף בית עם 972501234567
```
Bot replies:
```
שלחתי הזמנה ל-052-123-4567. כשהוא יאשר, נחבר את שני החשבונות.
תוכלי לבחור אילו קטגוריות לשתף — שכירות, מצרכים, חשבונות?
```

### Step 2 — Accept

Bob (the partner) receives:
```
היי! Alice הזמינה אותך לחבר את חשבונות כספ'לה שלכם
ולשתף הוצאות בית משותפות.

אתה לא תראה את ההוצאות הפרטיות שלה, היא לא תראה את שלך.
רק קטגוריות שתסכימו עליהם יוצגו אצל שניכם.

האם לאשר? כן / לא
```

### Step 3 — Choose shared categories

After Bob says "כן", both get:
```
איזה קטגוריות לשתף? (סמן את כולן שרלוונטיות)
☐ שכירות
☐ חשבונות (חשמל, מים, גז, אינטרנט)
☐ מצרכים לבית
☐ ועד בית, ארנונה
☐ ניקיון, עוזרת בית
☐ ילדים (אם רלוונטי)
☐ מתנות משותפות
```

Each picks independently. The **intersection** is what gets shared (if Alice picks rent + groceries and Bob picks rent + cleaning, only rent is shared).

### Step 4 — Daily life

Alice sends "245 שופרסל" → goes to her personal sheet only.
Alice sends "1200 ארנונה" → goes to her personal sheet **AND** shows on Bob's "Shared Household" view (because both flagged ארנונה).
Bob can ask: `כספלה הוצאות הבית` → sees both their שכירות + ארנונה + groceries.
Bot calculates: who paid how much this month → settlement balance.

### Step 5 — Revoke anytime

Either side can send:
```
כספלה הפסק שיתוף
```
→ Sharing ends immediately. Each person's data stays with them.

## Privacy guarantees

1. **No shared sheet by default** — each person keeps their own Google Drive sheet
2. **Cross-sheet read is read-only and category-filtered** — Bob never sees Alice's raw rows, only the filtered "shared categories" rollup
3. **Either party can revoke instantly** — KV record deleted on `הפסק שיתוף`
4. **Audit log** — every shared-categories change is logged with a timestamp + who changed it
5. **No bot-to-bot writes** — Alice's bot never writes to Bob's sheet, and vice-versa

## KV schema

```
share:<aliceSub>:<bobSub> = {
  status: 'pending' | 'active' | 'revoked',
  invitedAt: <iso>,
  acceptedAt: <iso> | null,
  sharedCategories: ['שכירות', 'ארנונה', 'חשבונות'],
  initiatedBy: 'aliceSub',
  updatedAt: <iso>
}
share:<bobSub>:<aliceSub> = (mirror — written when accepted)

shareInvite:<phone> = { from: <aliceSub>, code: <6-char>, expiresAt: <iso> }
```

## New bot commands

| Command | What |
|---------|------|
| `כספלה שתף בית עם <phone>` | Send sharing invite |
| `כספלה אשר שיתוף` | Accept pending invite |
| `כספלה דחה שיתוף` | Decline pending invite |
| `כספלה הגדר שיתוף` | Pick which categories to share |
| `כספלה הוצאות הבית` | View shared rollup (yours + theirs, shared cats only) |
| `כספלה מי שילם` | Who paid how much this month, who owes who |
| `כספלה הפסק שיתוף` | Revoke and stop sharing |

## New API endpoints

```
POST /api/share/invite       { phone, partnerPhone, botSecret }  → invite created
POST /api/share/accept       { phone, code, botSecret }          → mutual link created
POST /api/share/configure    { phone, categories[], botSecret }  → set my shared cats
GET  /api/share/household    { phone, botSecret }                → combined rollup
POST /api/share/revoke       { phone, botSecret }                → sever link
```

## What's NOT in scope (v1)

- Real-time WhatsApp broadcast when partner logs a shared expense (v2)
- Auto-split rules (50/50, by income ratio) — v2; v1 just shows raw totals + diff
- Web UI for partner sharing — bot-only in v1
- Sub-categories within shared (e.g. "share rent but not utilities") — v1 is category-level granularity
- More than 2 people (roommates of 3+) — v1 is pairwise

## Implementation phases

**Phase A — invite/accept flow** (~3 hours)
- New `/api/share/*` endpoints
- Bot commands: שתף בית, אשר שיתוף, דחה שיתוף, הפסק שיתוף
- Tests for the consent flow

**Phase B — category selection** (~2 hours)
- WhatsApp interactive list for picking shared categories
- KV write + bot confirmation
- Tests for intersection logic

**Phase C — shared view** (~3 hours)
- `כספלה הוצאות הבית` command
- Read both sheets, filter by intersection of shared cats
- Format nice rollup with "who paid" attribution
- Settlement command "מי חייב למי?"

**Phase D — revoke + safety** (~1 hour)
- `הפסק שיתוף` command
- Audit log on every share state change
- Privacy validation tests (Bob never sees Alice's non-shared rows)

**Total: ~9 hours of focused work.** Smaller than the existing /group infra it replaces.
