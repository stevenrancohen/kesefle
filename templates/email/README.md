# Kesefle Email Templates

Production-ready HTML email templates for the Kesefle Hebrew WhatsApp expense bot.
All templates are RTL Hebrew-first, dark-mode aware, and tested against the major
mail clients (Gmail web/iOS/Android, Apple Mail, Outlook 2016/2019/365, Yahoo, ProtonMail).

## Files

| File                  | Purpose                                       | Approx. lines |
|-----------------------|-----------------------------------------------|---------------|
| welcome.html          | Onboarding after OAuth signup                 | 320           |
| weekly-digest.html    | Weekly spending summary (Sun 08:00)           | 390           |
| payment-receipt.html  | Stripe checkout.session.completed receipt     | 260           |
| payment-failed.html   | Stripe invoice.payment_failed dunning         | 220           |
| account-deleted.html  | GDPR / Amendment 13 deletion confirmation     | 175           |
| monthly-insights.html | Optional monthly digest with AI insights      | 380           |
| _partials/header.html | Shared logo header                            | 30            |
| _partials/footer.html | Shared footer (legal, unsub, social)          | 90            |

Total: ~1865 lines.

## Template variables

### welcome.html
- `firstName` - user's first name from OAuth profile
- `userEmail` - subscriber email (also in footer)
- `unsubscribeUrl` - RFC 8058 one-click unsubscribe link

### weekly-digest.html
- `firstName`, `userEmail`, `unsubscribeUrl`
- `weekRange` - e.g. "12-18 במאי"
- `totalSpend` - number, no thousands separator
- `transactionCount`, `categoryCount`
- `deltaPercent`, `deltaArrow` (`up`/`down`), `deltaColor` (#10b981 or #ef4444)
- `spikeCategoryName`, `spikeAmount`, `spikeMultiplier`, `spikeAverage`
- `cat1Name` .. `cat5Name`, `cat1Amount` .. `cat5Amount`, `cat1Pct` .. `cat5Pct`, `cat1Count` .. `cat5Count`
- `exp1Date` .. `exp5Date`, `exp1Desc` .. `exp5Desc`, `exp1Amount` .. `exp5Amount`

### payment-receipt.html
- `firstName`, `userEmail`, `customerName`
- `planName`, `amount`, `subtotal`, `vat`, `billingCycle`
- `invoiceNumber`, `paymentDate`, `nextBillingDate`
- `cardBrand`, `cardLast4`, `pdfUrl`

### payment-failed.html
- `firstName`, `userEmail`
- `planName`, `amount`, `reason`, `gracePeriodEnd`

### account-deleted.html
- `firstName`, `deletionDate`

### monthly-insights.html
- `firstName`, `userEmail`, `unsubscribeUrl`
- `monthName`, `year`, `prevYear`
- `netAmount`, `netSign` (`+`/`-`/``), `netColor`, `netLabel`, `netBgColor`
- `income`, `expenses`
- `insight1Title`, `insight1Body`, `insight2Title`, `insight2Body`, `insight3Title`, `insight3Body`
- `yoyLastYear`, `yoyDeltaPct`, `yoyDeltaArrow`, `yoyDeltaColor`
- `goal1Name`, `goal1Current`, `goal1Target`, `goal1Pct`, `goal1DaysLeft`
- `goal2Name`, `goal2Current`, `goal2Target`, `goal2Pct`, `goal2DaysLeft`

## Sending with Resend

```ts
import { Resend } from 'resend';
import fs from 'node:fs/promises';
import Handlebars from 'handlebars';

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendWelcome(user) {
  const tplSrc = await fs.readFile('templates/email/welcome.html', 'utf8');
  const html = Handlebars.compile(tplSrc)({
    firstName: user.firstName,
    userEmail: user.email,
    unsubscribeUrl: `https://kesefle.vercel.app/unsubscribe?token=${user.unsubToken}`,
  });
  await resend.emails.send({
    from: 'Kesefle <hello@kesefle.vercel.app>',
    to: user.email,
    subject: `${user.firstName}, שמחים שהצטרפת לכסף'לה!`,
    html,
    headers: {
      'List-Unsubscribe': `<https://kesefle.vercel.app/unsubscribe?token=${user.unsubToken}>, <mailto:unsubscribe@kesefle.vercel.app>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
}
```

## Sending with SendGrid

```ts
import sgMail from '@sendgrid/mail';
import Handlebars from 'handlebars';
import fs from 'node:fs/promises';

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function sendDigest(user, data) {
  const tpl = await fs.readFile('templates/email/weekly-digest.html', 'utf8');
  const html = Handlebars.compile(tpl)({ ...data, userEmail: user.email });
  await sgMail.send({
    to: user.email,
    from: { email: 'digest@kesefle.vercel.app', name: "Kesefle" },
    subject: `סיכום השבוע - ${data.weekRange}`,
    html,
    asm: { groupId: 12345 },                  // suppression group for digest opt-out
    trackingSettings: { clickTracking: { enable: true } },
  });
}
```

## Sending with Postmark

```ts
import { ServerClient } from 'postmark';
import Mustache from 'mustache';
import fs from 'node:fs/promises';

const client = new ServerClient(process.env.POSTMARK_TOKEN);

async function sendReceipt(user, payment) {
  const tpl = await fs.readFile('templates/email/payment-receipt.html', 'utf8');
  await client.sendEmail({
    From: 'billing@kesefle.vercel.app',
    To: user.email,
    Subject: `קבלה - תשלום על ${payment.planName}`,
    HtmlBody: Mustache.render(tpl, { ...payment, ...user }),
    MessageStream: 'transactional',
    TrackOpens: true,
  });
}
```

## Hebrew vs English variants

The current templates are Hebrew (`dir="rtl" lang="he"`). To build English variants:
1. Copy each `.html` file to `xxx.en.html`.
2. Change `dir="rtl" lang="he"` to `dir="ltr" lang="en"` on `<html>` and key containers.
3. Translate the literal Hebrew strings (everything between tags).
4. Reverse alignment hints: `align="right"` becomes `align="left"` and vice versa.
5. Replace `<span>&#8362;</span>` (NIS) with `$` if you also switch currency.

Recommended approach: keep all copy in a single locale dict (e.g. `locales/he.json` + `locales/en.json`) and let the templating engine pick the right strings, so you do not maintain two HTML files.

## Client gotchas

### Apple Mail dark-mode caveat
- Apple Mail aggressively color-inverts: a `#081114` background can become `#f7eeeb`. We use `meta name="color-scheme" content="dark light"` and `meta name="supported-color-schemes" content="dark light"` to opt in to native dark mode and prevent the inversion.
- The `@media (prefers-color-scheme: dark)` blocks restore palette in clients that strip our inline styles.

### Outlook 2007 / 2010 / 2013 / Windows Mail
- These clients use Word's HTML renderer (no CSS3, no flex, no background-image on most elements).
- We use TABLE layout exclusively and `bgcolor="..."` alongside `background-color:` for compatibility.
- Border-radius is ignored on Outlook desktop. Buttons fall back to square but still readable.
- The `<!--[if mso]>` conditional ensures correct font sizing.
- Avoid CSS `padding` on `<a>` - Outlook ignores it. Always wrap in `<td>` with `padding`.

### Office 365 web
- Strips `<style>` blocks at the top of `<head>`. That is why we ship inline styles too.
- `data-ogsc` selectors trigger dark mode in Office 365 web - included in CSS.

### Gmail iOS / Android
- Renders `@media` blocks but strips them for the Gmail web app in some cases.
- Cap width at 600px; below 480px collapse to 100%.

### ProtonMail
- Blocks remote images by default. We use no remote images for chart bars (only CSS `<td bgcolor>` rectangles), so the digest looks identical with images blocked.

## Render preview locally

```bash
# Preview a single template in Safari
cat templates/email/welcome.html | open -f -a Safari

# Or just open the file
open templates/email/weekly-digest.html

# Preview after variable substitution (requires npm install -g handlebars-cli)
npx handlebars templates/email/welcome.html \
  --data '{"firstName":"שטיבן","userEmail":"steven@example.com","unsubscribeUrl":"#"}' \
  > /tmp/preview.html && open /tmp/preview.html
```

## Linting tips

- Run through https://www.htmlemailcheck.com/ before deploying.
- For dark-mode QA: enable macOS Dark Mode, open `welcome.html` in Apple Mail (Mail > File > Import Mailboxes > paste as MIME).
- For Outlook: send a test to https://litmus.com or https://emailonacid.com.

## Compliance checklist

- Every marketing template ships with `{{unsubscribeUrl}}` and physical address (Tel Aviv, Israel).
- Transactional templates (receipt, payment-failed, account-deleted) explicitly omit unsubscribe per CAN-SPAM Section 5(a)(5) - they are operational.
- `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers must be added by the sending code (see Resend snippet).
- GDPR Article 13 / Israeli Amendment 13: `account-deleted.html` includes the legal basis for the retained audit log.
