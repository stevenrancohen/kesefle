# Email Authentication for kesefle.com — SPF, DKIM, DMARC

**Goal**: emails sent FROM `*@kesefle.com` land in recipients' inboxes (not spam).

**Why this matters**: without SPF/DKIM/DMARC, Gmail/Outlook/etc. treat `kesefle.com` as unverified — outgoing emails to non-Kesefle users may go to spam, especially for cold emails and onboarding.

**Time**: 5-10 minutes. Mostly adding 3 TXT records to Hostinger DNS.

---

## What each record does

| Record | Purpose | Required? |
|---|---|---|
| **SPF** | "These servers are allowed to send mail for kesefle.com" | YES — first priority |
| **DKIM** | Cryptographic signature on each email proves it came from you (not a spoofer) | YES — second priority |
| **DMARC** | "If SPF or DKIM fail, do X" — your policy for unauthenticated mail | RECOMMENDED — start with `p=none` (just monitor), tighten later |

---

## 1. SPF Record

A simple TXT record telling the world "Google's mail servers send mail for me."

### Add to Hostinger DNS

| Field | Value |
|---|---|
| Type | **TXT** |
| Name | **@** |
| TXT value | **`v=spf1 include:_spf.google.com ~all`** |
| TTL | 3600 |

**That's it.** Click Add Record in Hostinger.

### What it means
- `v=spf1` — version 1
- `include:_spf.google.com` — Google's mail servers are authorized to send for kesefle.com
- `~all` — soft-fail anything else (better deliverability while you test; can harden to `-all` later for strict rejection)

### Verify after adding
Wait 5-10 min for propagation, then:
```bash
dig TXT kesefle.com +short
```
Should return both your Google verification TXT and the SPF record.

---

## 2. DKIM Record (Google generates this for you)

DKIM requires a Google-generated key. Steps:

1. Go to https://admin.google.com/u/4/ac/apps/gmail/authenticateemail
2. Click your domain: **kesefle.com**
3. Click **"Generate New Record"**
4. Use these settings:
   - Prefix selector: **google** (default — fine)
   - Key length: **2048** (recommended)
5. Click **"GENERATE"**
6. Google displays a TXT record. **Copy two values**:
   - Name (looks like): `google._domainkey`
   - Value (long string starting with): `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC...`

### Add to Hostinger DNS

| Field | Value |
|---|---|
| Type | **TXT** |
| Name | **google._domainkey** (NOT `@`) |
| TXT value | **Paste the long `v=DKIM1; k=rsa; p=...` string from Google** |
| TTL | 3600 |

Click Add Record.

### Tell Google you added it

7. Back in https://admin.google.com/u/4/ac/apps/gmail/authenticateemail
8. Click **"START AUTHENTICATION"**
9. Google checks DNS. May take up to 48 hours but usually 5-30 min.

### Verify
```bash
dig TXT google._domainkey.kesefle.com +short
```
Should return the long DKIM key.

---

## 3. DMARC Record

The policy record. Start permissive ("just monitor") and tighten later.

### Add to Hostinger DNS

| Field | Value |
|---|---|
| Type | **TXT** |
| Name | **_dmarc** |
| TXT value | **`v=DMARC1; p=none; rua=mailto:dmarc-reports@kesefle.com; ruf=mailto:dmarc-reports@kesefle.com; fo=1`** |
| TTL | 3600 |

### What it means
- `v=DMARC1` — version 1
- `p=none` — policy is "do nothing, just monitor" — safest while you build out other infra
- `rua=mailto:...` — send aggregate reports to this email (you can create `dmarc-reports@kesefle.com` as an alias in Workspace, or use info@kesefle.com)
- `ruf=...` — forensic reports (more detailed)
- `fo=1` — generate failure report if any check fails

### Later, after 2-4 weeks of monitoring with `p=none`
Once you confirm no legitimate mail is failing checks, tighten:
- `p=quarantine` — failing mail goes to spam folder
- Eventually `p=reject` — failing mail is rejected outright

DON'T jump straight to `p=reject` — you'll bounce legit mail and not know about it.

### Verify
```bash
dig TXT _dmarc.kesefle.com +short
```
Should return the DMARC record.

---

## After all 3 records are live

Your Hostinger DNS records list should look like this:

| Type | Name | Content |
|---|---|---|
| MX | @ | smtp.google.com (priority 1) |
| TXT | @ | google-site-verification=... |
| TXT | @ | v=spf1 include:_spf.google.com ~all ← **SPF (NEW)** |
| TXT | google._domainkey | v=DKIM1; k=rsa; p=... ← **DKIM (NEW)** |
| TXT | _dmarc | v=DMARC1; p=none; rua=mailto:... ← **DMARC (NEW)** |
| A | @ | 76.76.21.21 (after Vercel switchover) |
| CNAME | www | cname.vercel-dns.com |

**Note**: you can have MULTIPLE TXT records on `@` — they don't conflict. SPF and Google verification both at `@`. That's fine.

---

## Test outgoing email

After all 3 records propagate:

1. From info@kesefle.com Gmail, send a test email to:
   - `check-auth@verifier.port25.com` — replies with a detailed pass/fail report
   - OR your personal Gmail
2. Open the test email
3. In Gmail, click the 3 dots → "Show original"
4. Look for these lines near the top:
   ```
   SPF:       PASS
   DKIM:      PASS
   DMARC:     PASS
   ```
5. If all PASS, your email auth is solid.

If any FAIL:
- SPF FAIL → check the SPF TXT record value (one tiny typo breaks it)
- DKIM FAIL → DKIM key probably not propagated yet, wait longer
- DMARC FAIL → DMARC record format error, double-check the value

---

## Why bother?

Without these records:
- ~30-50% of cold outgoing emails land in spam
- Google's own Workspace will warn you that authentication is missing
- Your domain reputation grows slowly and can be hijacked by spoofers
- High bounce rates → Gmail starts throttling you

With these records:
- ~95%+ inbox delivery for legitimate mail
- Spoofers (people sending mail pretending to be from kesefle.com) get caught and reported
- Healthy domain reputation builds over time
- Can confidently use `*@kesefle.com` for everything

For a finance product where trust matters, this is non-negotiable.

---

## When to upgrade DMARC policy

Timeline suggestion:

| Week | DMARC policy | Why |
|---|---|---|
| 1-2 | `p=none` | Monitor only — see what's actually being sent |
| 3-4 | `p=quarantine; pct=10` | Quarantine 10% of failing mail (test) |
| 5-6 | `p=quarantine; pct=50` | Increase to 50% |
| 7-8 | `p=quarantine` | Full quarantine |
| 9+ | `p=reject` | Full rejection of failing mail (most aggressive) |

This gradual ramp prevents you from accidentally breaking legitimate mail flow that you forgot about.

---

## Bonus: BIMI (logo in inbox)

After SPF/DKIM/DMARC are solid AND DMARC is at `p=quarantine` or `p=reject` for ~30+ days, you can add **BIMI** (Brand Indicators for Message Identification). This makes your logo appear next to emails in Gmail/Yahoo/etc.

Requires:
- A `.svg` logo in BIMI format
- A VMC certificate ($1000+/yr from DigiCert or Entrust) for full Gmail support
- OR a free `.svg` only (limited support — Yahoo, AOL)

Not urgent. Worth it eventually for brand recognition. Document and revisit in 6 months.
