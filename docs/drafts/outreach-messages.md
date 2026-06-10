# Outreach messages — ready to send (Hebrew, WhatsApp)

Five copy-paste messages for Steven's personal outreach. Ground rules:

- Send from Steven's **personal** WhatsApp, not the bot number — these must feel 1:1.
- Replace `[שם]` / `[חבר משותף]` before sending. Masculine-default Hebrew; switch to feminine forms (נרשמת/מוכנה/נסי) when relevant.
- One message per person. If no reply, max ONE gentle nudge after ~5 days, then stop.
- Zero sales pressure: never mention pricing/upgrade in these messages.
- Funnel context lives in the admin funnel (`/api/admin/funnel-summary`): signup → sheet created → phone linked (`קוד NNNNNN`) → first expense sent.

---

## 1. Signup who stalled before linking the phone

> היי [שם], זה סטיבן מכספ'לה 🙂
> ראיתי שנרשמת באתר אבל החיבור לוואטסאפ לא הושלם — יכול להיות שזה בכלל באשמתנו, היה לנו באג בדיוק בשלב הזה ותיקנו אותו.
> נשאר רק צעד אחד: שולחים לבוט הודעה אחת עם קוד החיבור, ומשם הכול עובד לבד.
> יש לך חצי דקה עכשיו שנסיים את החיבור ביחד?

**Usage note:** Send 24–72h after signup when the funnel shows a sheet was created but `phone_link_done` never fired; if they say yes, walk them through kesefle.com/account → "חיבור וואטסאפ" → send the code live.

---

## 2. User who linked but never logged an expense

> היי [שם], סטיבן מכספ'לה 🙂
> ראיתי שהוואטסאפ שלך כבר מחובר — הכול מוכן בצד שלנו, חסרה רק ההוצאה הראשונה.
> אין מה ללמוד: כותבים לבוט משהו כמו "45 קפה" וזה נרשם לבד בגיליון שלך.
> בא לך לנסות עכשיו עם ההוצאה האחרונה שהייתה לך היום?

**Usage note:** Send 1–3 days after `phone_link_done` with no `first_message_sent`; if they try it, reply to their answer personally so the first experience has a human behind it.

---

## 3. Cold message to a freelancer (friend-of-friend)

> היי [שם], מקווה שבסדר שאני כותב — קיבלתי את המספר שלך מ[חבר משותף].
> אני בעל עסק קטן בעצמי, ובניתי כלי בשם כספ'לה: שולחים הוצאה בוואטסאפ ("45 דלק") והיא נרשמת לבד בגיליון מסודר עם דשבורד.
> אני מחפש עכשיו עצמאים שינסו אותו כמה ימים ויגידו לי בכנות מה עובד ומה לא — בחינם ובלי שום התחייבות.
> מתאים לך שאשלח לך לינק ותנסה כמה ימים?

**Usage note:** Send ONLY after the mutual friend confirmed it's OK to share the number (say who gave it in the first line); follow up on their feedback within a day.

---

## 4. Post for an Israeli freelancers Facebook group

> שאלה כנה לעצמאים כאן: איך אתם עוקבים אחרי ההוצאות שלכם? 🙂
> אני בעל עסק קטן, ונמאס לי לארגן קבלות באקסל בסוף החודש — אז בניתי את כספ'לה: שולחים לבוט בוואטסאפ "45 דלק" וזה נרשם לבד בגיליון בדרייב שלכם, עם דשבורד ודוח מסודר.
> אני לא מוכר כלום כרגע — זה בחינם, ואני מחפש כמה עצמאים שינסו שבוע ויגידו לי בכנות מה עובד ומה מעצבן. אשאיר לינק בתגובה הראשונה.
> מי מוכן לנסות שבוע ולהגיד לי את האמת?

**Usage note:** Post only in groups whose rules allow self-promo/feedback posts (check pinned rules first), put the kesefle.com link in the first comment, answer every reply same-day, and don't repost to the same group within a month.

---

## 5. Re-engaging someone who tried once and stopped

> היי [שם], סטיבן מכספ'לה 🙂
> ראיתי שניסית את הבוט ואז עצרת — זה לגמרי בסדר, ובשבילי זה דווקא הפידבק הכי שווה שיש.
> מאז תיקנו לא מעט דברים, והייתי שמח להבין מה לא עבד לך כדי לתקן גם את זה.
> מה הדבר האחד שהיה גורם לך להמשיך להשתמש?

**Usage note:** Send ~7 days after their last bot activity; whatever they answer, thank them and log it as a real user-research finding — don't pitch features back at them.
