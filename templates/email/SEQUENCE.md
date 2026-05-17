# Kesefle Email Sequence

Hebrew RTL lifecycle email sequence for Kesefle WhatsApp expense bot. Goal: convert free signups into engaged Pro subscribers (₪19/month) while keeping inactive users warm.

## Sequence overview

| # | Template | Trigger | Send delay | Channel | Goal |
|---|----------|---------|------------|---------|------|
| 0 | `welcome.html` | User completes signup (account created) | Immediate (within 60s) | Transactional | Activation: get first WhatsApp message |
| 1 | `day_1_first_transaction.html` | First inbound WhatsApp message from user | T+1 hour after first message | Behavioral | Habit formation: encourage day-2 entry |
| 2 | `day_3_pro_tips.html` | User has at least 1 transaction logged | T+3 days from signup | Time-based | Feature discovery: power commands |
| 3 | `day_7_weekly_summary.html` | End of week 1, user logged ≥3 transactions | T+7 days, sent Sunday 9am IL time | Personalized | Show value via real numbers |
| 4 | `day_14_upgrade_to_pro.html` | End of free trial / 14-day mark | T+14 days from signup | Conversion | Convert to Pro (₪19/month) |
| 5 | `day_30_pro_completed.html` | 30 days since signup (Pro or free) | T+30 days | Retention + Referral | Celebrate, drive referrals |
| 6 | `inactivity_7_days.html` | No WhatsApp activity for 7+ days | Triggered when inactivity detected | Re-engagement | Gentle revive, no pressure |

Total: 7 emails in the lifecycle (1 existing + 6 new).

## Recommended email service

**Top pick: Postmark** — best deliverability for transactional + behavioral. Hebrew/RTL renders correctly. Their template editor handles `{{merge_fields}}` natively via Mustache syntax. ~$15/mo for 10K emails.

**Alternative: SendGrid** — better suited if you need both marketing + transactional in one stack. Use their Dynamic Templates feature for the merge fields. Watch their RTL rendering — test in Outlook desktop before sending production.

**Budget option: Mailgun** — cheapest for high volume, but their template editor is weaker. Best if you compile templates in your app and pass full HTML via API.

For all three: use **list-unsubscribe header** (RFC 8058) so Gmail/Apple Mail one-click unsub works. The `{{unsubscribeUrl}}` link in the footer is the fallback.

## Merge field reference

| Field | Used in | Source | Fallback |
|---|---|---|---|
| `{{firstName}}` | All templates | User profile (Hebrew first name) | "שלום" |
| `{{userEmail}}` | Footer of all | Account email | (required) |
| `{{unsubscribeUrl}}` | Footer of all | One-time signed URL per user | `https://kesefle.vercel.app/unsubscribe?token=...` |
| `{{week_total}}` | `day_7_weekly_summary` | Sum of transactions in last 7 days | `0` |
| `{{top_category}}` | `day_7_weekly_summary` | Most-spent category in last 7 days | "מזון" |
| `{{transactions}}` | `day_7_weekly_summary`, `day_30_pro_completed` | Count of transactions in window | `0` |
| `{{month_total}}` | `day_30_pro_completed` | Sum of last 30 days | `0` |
| `{{categories_count}}` | `day_30_pro_completed` | Distinct categories used | `1` |
| `{{referral_code}}` | `day_30_pro_completed` | User's unique referral slug | (generated on signup) |

## A/B test ideas for subject lines

Run each test for at least 1,000 sends per variant. Measure open rate primary, click rate secondary.

### Day 1
- A (current): `🎉 הרישום הראשון שלך — איך זה הולך?`
- B: `{{firstName}}, ראיתי את ההוצאה הראשונה שלך`
- C: `60 שניות, ההוצאה כבר בטבלה. מה הלאה?`

### Day 3
- A (current): `הסוד של משתמשים מקצועיים — 3 פקודות שלא ידעת`
- B: `יש פקודה אחת שכולם מפספסים`
- C: `כתוב "/סיכום" — ותראה מה קורה`

### Day 7
- A (current): `השבוע הראשון שלך — ככה זה נראה`
- B: `{{firstName}}, הוצאת {{week_total}}₪ השבוע`
- C: `הסיכום השבועי הראשון שלך מוכן`

### Day 14
- A (current): `השבועיים הראשונים שלך — מה הלאה?`
- B: `{{firstName}}, חבל לעצור עכשיו`
- C: `המנוי שלך מסתיים מחר`

### Day 30
- A (current): `חודש שלם של מעקב חכם — וואו!`
- B: `30 ימים. {{transactions}} הוצאות. אפס שכחות.`
- C: `הזמן חבר וקבל חודש Pro חינם`

### Inactivity
- A (current): `מתגעגעים אלייך — הכל בסדר?`
- B: `{{firstName}}, איפה היית השבוע?`
- C: `שלום שקט בוואטסאפ. הכל טוב?`

## Implementation notes

- **Timing rules:** Don't send `day_7` if user hasn't logged any transactions — promote `day_3` first or fall back to inactivity flow.
- **Deduplication:** A user who hits inactivity flow should skip `day_30` until they re-engage.
- **Quiet hours:** Don't send between 22:00–08:00 IL time. All sequence emails should be queued for next morning if triggered overnight.
- **Pro users:** Skip `day_14_upgrade_to_pro` for users who already upgraded.
- **Frequency cap:** Max 2 lifecycle emails per 7-day window per user. Transactional (receipts, password resets) don't count.

## Testing checklist before launch

- [ ] Render test in Gmail (web + iOS + Android)
- [ ] Render test in Outlook 2019 desktop (worst-case RTL handling)
- [ ] Render test in Apple Mail (macOS + iOS)
- [ ] Dark mode rendering verified in Gmail iOS, Apple Mail
- [ ] All merge fields populate correctly with sample data
- [ ] Unsubscribe link works end-to-end
- [ ] Hebrew renders right-to-left, no reversed punctuation
- [ ] Mobile single-column layout collapses correctly under 600px
- [ ] CTA buttons are tappable (44×44px minimum tap target)
- [ ] List-Unsubscribe header set on all messages
