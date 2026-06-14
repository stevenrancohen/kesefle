# Open Banking Israel — Regulation, Standard, Providers, Rails & Open-Source (Research)

**Date:** 2026-06-14 · **Status:** Research only — no live connections, no credentials, no secrets. · **NOT legal advice.**
**Produced by:** a 6-agent research fleet (regulation / standard / providers / open-source / payment-rails) + an **independent fact-check pass** that corrected over-claims (see §6).
**Relationship to prior docs:** this **refreshes and supersedes the provider/regulation research** in [`FINANCIAL_PROVIDER_MAP.md`](FINANCIAL_PROVIDER_MAP.md) (2026-06-11) with current, cited, fact-checked facts. The architecture, security model, and reconciliation design already live in [`FINANCIAL_INTEGRATION_ARCHITECTURE.md`](FINANCIAL_INTEGRATION_ARCHITECTURE.md), [`FINANCIAL_INTEGRATION_SECURITY_MODEL.md`](FINANCIAL_INTEGRATION_SECURITY_MODEL.md), [`TRANSACTION_RECONCILIATION_MODEL.md`](TRANSACTION_RECONCILIATION_MODEL.md) — not repeated here.

> Every claim tagged **MUST CONFIRM PROFESSIONALLY** has to be cleared by an Israeli fintech lawyer before any live data flows. Exact NIS capital/insurance figures and per-bank go-live dates were **not** verifiable from public sources and are flagged **UNVERIFIED** rather than guessed.

---

## 1. Executive summary

**Is Open Banking in Israel possible for Kesefle?** Yes — Israel has a live, regulated, consent-based regime — **but not by connecting directly to banks first, and never by collecting bank credentials (that is explicitly banned).** Israel runs a **two-track system**: the **Bank of Israel** sets the technical API standard banks/card-issuers must expose (Berlin Group / NextGenPSD2, via Directive 368, Implementation Guidelines v1.7); the **Israel Securities Authority (ISA)** licenses the third-party companies that *consume* that data ("נותן שירות מידע פיננסי" / Financial Information Service Provider), under the **Financial Information Service Law, 5782-2021** (in force June 2022).

**Direct vs licensed-partner vs aggregator — the three lawful paths:**

| Path | What | Verdict |
|---|---|---|
| **A. Own ISA license** | Kesefle becomes a licensed FISP, registers with BoI, calls bank APIs directly | months + capital/insurance/cyber-audit; defer |
| **B. Licensed partner / aggregator** | Consume data under a provider that already holds the ISA license (e.g. **Finanda**) | **fastest legal path — but the "ride their license" assumption is legally undetermined; MUST CONFIRM** |
| **C. Import-first (no license)** | Parse the user's own exported statement / merchant-owned API keys / manual bot entry | **lawful today, ships now, zero license risk** |

**What is legally/technically risky:** (1) assuming Kesefle can operate under a partner's ISA license without its own — load-bearing and unconfirmed; (2) Salt Edge's Israeli coverage is **unproven** (its IL page shows 0 banks); (3) storing Israeli financial data in **US-hosted Google Sheets** may breach FIS-Law/Amendment-13 cross-border rules; (4) `israeli-bank-scrapers` (the only IL-wide import library) works by **credential collection**, which the FIS Law prohibits for a licensed-style service.

**Recommended MVP (agrees with your assumption):** **C → B → A.** Build **import-first** (universal schema → CSV/Excel/statement import → reconciliation/dedup → admin review → bot Q&A over imported data) — none of it needs a regulator. *Then* a licensed-partner **sandbox** (Finanda) once legal clears the partner-license question. Direct/own-license only if the economics justify it.

**Top 5 next actions:** see §8.

---

## 2. Regulation & Licensing

Israel runs a **two-track open-banking regime**: the Bank of Israel sets the technical API standard that banks/issuers must expose; the Israel Securities Authority (ISA) licenses and supervises the third-party companies (like Kesefle) that consume that data. **NOT legal advice.**

### Governing law & regulators
- **Standard layer (Bank of Israel).** In 2020 the BoI published Israel's open-banking standard, based on **NextGenPSD2 / Berlin Group**, obligating the *data sources* to build APIs. The bank-side obligation sits in **Proper Conduct of Banking Business Directive 368** ("בנקאות פתוחה"). ([BoI – Open Banking](https://www.boi.org.il/roles/supervisionregulation/bank-sup/open-banking/)) **MUST CONFIRM** 368 is the current controlling directive.
- **Licensing layer (the Law).** The **Financial Information Service Law, 5782-2021 (חוק שירות מידע פיננסי)** governs who may aggregate/use customers' financial data. Passed 4 Nov 2021, in force **14 June 2022**. ([Nevo full text](https://www.nevo.co.il/law_html/law00/204508.htm); [ISA PDF](https://www.new.isa.gov.il/images/Fittings/isa/asset_library_pic/al_lobby/al_lobby-628ce07f9490d/financialinformation2021.pdf))

| Function | Regulator |
|---|---|
| **Licenses the data-aggregating providers** (נותני שירות מידע פיננסי) | **Israel Securities Authority (ISA / רשות ניירות ערך)** |
| **Sets the bank-side API standard** + supervises the banks building APIs | **Bank of Israel** (Banking Supervision) |
| Approves already-regulated entities (insurers, pension) to also provide | their sector regulator, with ISA |

ISA: *"עיסוק במתן שירות מידע פיננסי מחייב קבלת רישיון מרשות ניירות ערך."* First licenses granted **28 Sept 2022**. ([Gornitzky](https://www.gornitzky.com/the-open-banking-reform/))

### License: "נותן שירות מידע פיננסי" (FISP) — documented conditions
Israeli company; operational control in Israel; cybersecurity + privacy expertise; business plan + risk-management policy + financial-viability docs; **insurance / minimum capital (הון עצמי) / collateral** as required; no insolvency. **Exact NIS capital/insurance figures: UNVERIFIED** (live in the ISA license directive schedules) — **MUST CONFIRM**.

### Can Kesefle connect directly, or license/partner?
- **Path A — own ISA license** (direct bank APIs; highest control/cost; months).
- **Path B — partner with a licensed provider** (TPP-as-a-service; **recommended start**; identify a partner + confirm its license is current).
- **Path C — manual/user-forwarded data** (lawful default today). **Collecting bank usernames/passwords is PROHIBITED.**

### Who must expose APIs + rollout
Data sources obligated: **banks, credit-card companies/acquirers (חברות כרטיסי אשראי, סולקים)**, deposit/credit licensees, provident/pension managers, insurers, non-bank credit providers, portfolio managers, exchange members. Phases: (1) balances + transactions; (2) **card** transaction data + payment initiation; (3) deposits/loans/securities. **Corporate/business account** data mandatory **April 2024**; non-bank loan data extended through Nov 2024. ([Herzog – Amendment No.3, 2025](https://herzoglaw.co.il/he/news-and-insights/))

### Data baskets available
1. Bank/checking — balances, transactions, fees. 2. **Credit cards — in scope.** 3. Debit cards. 4. Securities. 5. Savings/deposits. **Business accounts: IN SCOPE (since 4/2024).**

### Limitations / prohibited
- **Screen-scraping / credential collection is BANNED** — no storing usernames/passwords to pull data, no service without a license. This forbids the "ask the user for their bank login" pattern.
- **Consent-based, purpose-limited, time-limited.** Max consent duration: **UNVERIFIED** (regulator-set) — MUST CONFIRM.
- Amendment No.3 (draft 3 Feb 2025) extends, time-boxed, a narrow credential-access allowance for *corporate* accounts — do **not** rely on it.

### Must confirm professionally
Exact capital/insurance/collateral + basic-vs-expanded license tier; whether Kesefle's bot+sheet design needs its **own** license or can run **entirely under a partner's**; max consent duration + retention/deletion under FIS Law + Privacy Amendment 13; whether **US-hosted Google Sheets** is permitted for this data; that **Directive 368** is current + the live per-bank API schedule; final status of Amendment No.3; partner due-diligence (license current + compliant consent/liability).

---

## 3. Technical Standard

**Israel's standard IS the Berlin Group NextGenPSD2 XS2A Framework, adopted almost verbatim.** The BoI republished the Berlin Group *Implementation Guidelines v1.3.11 (24 Sep 2021)* as **Appendix A'1 to Directive 368**, as "Open Banking IL Implementation Guidelines v1.7," with Israel-specific deltas inserted inline as **"BOI remarks."** API surface/JSON/endpoints/consent/flows are identical to EU NextGenPSD2; only a few fields + the trust/certificate layer are localized. ([BoI Implementation Guidelines v1.7 PDF](https://boi.org.il/media/s2pjyjfi/boi-implementation-guidelines-v17_16_11_2023.pdf))

### AIS API surface (all `/v1/...`, confirmed in v1.7)
`GET /accounts`, `/accounts/{id}`, `/accounts/{id}/balances`, `/accounts/{id}/transactions` (date range, booked/pending, **delta-reports**, pagination), `/accounts/{id}/transactions/{txId}`, `/card-accounts` (+ `/{id}`, `/balances`, `/transactions`), consents `GET /consents/{id}` + `/status`. Banks keyed by **IBAN**; card processors keyed by **maskedPAN** (PANs forbidden). **Loans, deposits/savings, securities are NOT in this AIS surface** — staged for a later phase; whether a separate IL API standard exists for them is **UNVERIFIED**.

### Consent
TPP `POST /consents` (services, accounts, recurring/one-off, `validUntil`, `frequencyPerDay`) → PSU authorises via **SCA**. Models: **Detailed / Bank-Offered / Global** (card processors must offer Bank-Offered). Max duration set by regulator (`validUntil=9999-12-31` → "max approved date"); **exact day-cap UNVERIFIED** (EU default 90/180; IL = "as approved"). New recurring consent auto-expires the prior one. Revocation → `revokedByPsu`; `DELETE` supported.

### Auth & security (the big IL deltas)
- **TLS 1.3 mandatory** (overrides Berlin Group's 1.2 floor).
- **Certificates via a national "Gov CA"** (the eIDAS-QTSP equivalent): TPP needs a **QWAC** (mTLS client auth) + **QSEALC** (message signing), both **issued by Gov CA**. **Message signing mandatory on every request** (stricter than EU). **Gov CA's legal name / onboarding: UNVERIFIED** — hard dependency, MUST CONFIRM.
- **SCA** per EBA-RTS; approaches: **Redirect / Decoupled / OAuth2**; Embedded data-flows **not supported**.
- **OAuth2** is the token/SCA model (Consent-ID + access token + refresh). FAPI-aligned posture; formal FAPI certification per-ASPSP **UNVERIFIED**.
- `frequencyPerDay`: BoI sets it to **100 with "no legal significance"** — real limits are per-ASPSP/operational.

### Developer experience
**Decentralized, per-bank — no central gateway.** Confirmed portals: **Leumi (FinTeka** sandbox), **Hapoalim (poalimdev.co.il)**, **Mercantile/Discount** (regulatory API catalog), **Bank Jerusalem** (apiportal). Production needs **both** an ISA TPP license **and** Gov CA QWAC+QSEALC certs, then per-ASPSP conformance testing. **Aggregator shortcut: Finanda / bizi** market licensed-aggregator access to all ASPSPs.

### UNVERIFIED list
Max consent days; Gov CA identity/onboarding; whether a separate IL standard exists for loans/deposits/securities; per-ASPSP rate limits/freshness + which banks have open sandboxes; formal FAPI certification; which regulator gates Kesefle's exact use case.

---

## 4. Providers & Aggregators

**Most global aggregators (Plaid, Tink, TrueLayer, Yapily, GoCardless/Nordigen, Finicity, MX, Brankas) are PSD2/UK/US-scoped and do NOT cover Israel** — Israel is outside PSD2 and runs its own standard, so EU connectivity does not carry over. ([openbankingtracker – Israel](https://www.openbankingtracker.com/country/israel))

| Provider | Israel | IL banks | Business | Sandbox | ISA/compliance | RECOMMENDATION |
|---|---|---|---|---|---|---|
| **Finanda** (local) | **Yes** | "10+ banks & 4 card cos" (specific list UNVERIFIED) | Yes | ask | **Holds ISA FISP license**; first/oldest IL aggregator | **YES — start here** |
| **Salt Edge** (global) | claims IL | **UNPROVEN — IL page shows 0 banks; only IL client used EUROPEAN accounts** | toggles | Yes | UK-OB + ISO27001; **IL ISA status UNVERIFIED** | **NEEDS-REVIEW (verify live + ISA)** |
| **Green Invoice** | Yes | imports bank+card txns | Yes | — | first-four ISA licensee | **NEEDS-REVIEW (partner, not infra)** |
| **Direct bank APIs** (e.g. Bank Jerusalem) | Yes | per-bank | Yes | per-bank | **you still need an ISA license to consume** | **NO (use an aggregator)** |
| Plaid / Tink / TrueLayer / Yapily / Nordigen / Finicity / MX / Brankas | **No** | none | — | — | not IL | **NO** |

**ISA FISP licensees (the pool to partner with):** first four (28 Sep 2022) = **RiseUp, Finanda, FamilyBiz, Green Invoice**; second cohort (12 Feb 2023) = **Amir Cash Flow, Meteor Plus (storenext), Fizback, Finance Follow-Up Services**. RiseUp is a consumer-app *competitor*, not a vendor. Authoritative current list: isa.gov.il.

**Shortlist:** (1) **Finanda** — the one unambiguously Israeli, ISA-licensed, live-on-the-big-banks aggregator with a documented API; solves connectivity + legal in one vendor. (2) **Salt Edge** — strongest global option *if* IL coverage proves out (do a live connect-test first; its scraping channel is prohibited for IL). (3) **Green Invoice** partnership for the business/revenue side. **Skip** all other global aggregators.

**Week-1 de-risk:** email Finanda re "regulated-entity-as-a-service"; book 30-min fintech-counsel call; request Salt Edge IL coverage matrix + a real Hapoalim/Leumi connect-test; get Finanda's consent screens to confirm they fit a WhatsApp-mediated UX.

---

## 5. Payment & Invoice Rails (Phase-4 business revenue import)

**Cleanest path is the accounting/invoicing layer, not the card gateways.** Start with **Green Invoice/Morning** — public REST API, JWT auth, document search/list + webhooks, dominant SMB base, normalized income feed (amount, VAT type, client, payment).

| Provider | Type | Pull API for txns/invoices | Auth | Webhooks | IL |
|---|---|---|---|---|---|
| **Green Invoice / Morning** | invoicing | **Yes** (create + search/list) — cleanest income feed | JWT (1h) | Yes | native, dominant |
| **iCount** | invoicing | **Yes** (API v3; free basic; 30 req/min) | API key | UNVERIFIED | native |
| **Rivhit** | invoicing | **Yes** (Document.List/Details) | token | UNVERIFIED | native |
| **Priority** | ERP | **Yes** (full OData REST) | OData | UNVERIFIED | dominant ERP |
| **Cardcom** (+Grow-by-Cardcom) | gateway | **Yes** (`Transactions/ListTransactions` v11) | terminal+API | **Yes** | native |
| **PayPlus / Tranzila / Meshulam(Grow) / Pelecard** | gateways | charge-side documented; **read/list UNVERIFIED** | varies | mixed | native |
| **Stripe** | gateway | full API | key | Yes | **NOT for IL-domiciled merchants** (needs US entity) |
| **PayPal** | wallet | Transaction Search (31-day window) | OAuth2 | Yes | available but enterprise features restricted for IL-only — **confirm +972** |

**Order:** Green Invoice → iCount → Cardcom `ListTransactions`. Skip thin/unverified gateway read-APIs until a user needs them. **Note:** merchant-owned API keys the business owner enters themselves is **not aggregation** and likely avoids the FISP license — but **MUST CONFIRM**. "Grow" = two unrelated brands (Cardcom vs Meshulam).

---

## 6. Fact-Check & Corrections (independent pass)

| Claim | Verdict | Note |
|---|---|---|
| Two-track: BoI standard, ISA licenses providers | **CONFIRMED** | primary + law-firm sources |
| Governing law = Financial Information Service Law 5782-2021 | **CONFIRMED** | in force June 2022 |
| ISA (not BoI) licenses providers | **CONFIRMED** | openbankingtracker's "BOI licensing" wording is imprecise/CORRECTED |
| BoI adopted NextGenPSD2 via Directive 368, IG v1.7 | **CONFIRMED** | 368 number = confirm live version |
| Credential scraping BANNED | **CONFIRMED** | must use regulated API + consent |
| Banks AND card companies must expose APIs | **CONFIRMED** | |
| First ISA licenses 28 Sep 2022 (RiseUp/Finanda/FamilyBiz/Green Invoice) | **CONFIRMED** | Feb-2023 = second cohort |
| **Finanda** ISA-licensed w/ Open Banking API | **CONFIRMED** | specific bank list = UNVERIFIED (logos only) |
| Finanda offers data to 3rd parties **under its license** | **UNVERIFIED** | sales claim — MUST CONFIRM with Finanda + counsel |
| **Salt Edge** has live IL regulated coverage | **CORRECTED / UNVERIFIED** | IL page shows **0 banks**; its IL client connected **European** accounts; no ISA license found |
| Global aggregators (Plaid/Tink/…) cover Israel | **CONFIRMED they do NOT** | |
| Business/corporate accounts mandatory ~Apr 2024 | **CONFIRMED** | ">₪5M turnover" detail UNVERIFIED |
| Min capital/insurance NIS figures | **UNVERIFIED** | in ISA directive schedules |
| US-hosted Google Sheets permitted for IL fin-data | **UNVERIFIED — HIGH RISK** | cross-border + Amendment 13 |

### Highest-risk assumptions (MUST CONFIRM PROFESSIONALLY)
1. **"Kesefle can ride a partner's ISA license."** Load-bearing for Path B and the whole ship-fast plan; legally undetermined from public sources. If wrong → Kesefle needs its own license (months + capital). Confirm with a lawyer **and** in writing from the partner.
2. **Salt Edge has NO confirmed live IL coverage or ISA license.** Don't architect a fallback on it until a real connect-test succeeds; its scraping channel is prohibited for IL credential collection.
3. **US-hosted Google Sheets** for Israeli financial data may violate FIS-Law/Amendment-13 — this would make the current sheet-per-user architecture the problem, not a future concern. Confirm before any regulated data flows in.
4. **Finanda's bank list + "license-as-a-service"** are sales claims — confirm directly.
5. **Directive 368 live version + per-card-issuer (Isracard/Max/CAL) go-live** — UNVERIFIED for every aggregator.

---

## 7. Open-Source Prior Art

> **Legal caveat:** `israeli-bank-scrapers` and its ecosystem use **credential-based browser automation** (user hands over bank login + OTP), **not** licensed Open Banking. Shipping credential collection commercially raises bank-ToS, Privacy Amendment 13, and licensing questions. **An Israeli fintech lawyer must confirm legality before this ships to paying users.** MIT-licensed ≠ legal to operate commercially.

### Israel-specific (highest priority)
| Repo | License | What | For Kesefle |
|---|---|---|---|
| **eshaham/israeli-bank-scrapers** | **MIT** (1,004★, active 2026-06) | Puppeteer scrapers for all major IL banks + card issuers (Hapoalim, Leumi, Discount, Mizrahi, Otsar, Union, Beinleumi, Massad, Yahav, OneZero + Visa Cal, Max, Isracard, Amex); normalized txn schema | **#1 import engine — wrap, don't fork; legal sign-off first** |
| **daniel-hauser/moneyman** | MIT | Scheduled scrape→dedup→storage (incl. Google Sheets) | **Blueprint** for the scheduler/dedup/Sheets sink — rebuild multi-tenant |
| shlomiuziel/asher-mcp | MIT | MCP exposing scrapers to an LLM | idea for LLM-over-transactions (WhatsApp NLU) |
| tomerh2001/israeli-banks-actual-budget-importer | Apache-2.0 | scraper→Actual schema mapping | schema-mapping reference |
| GuyLewin/israel-finance-telegram-bot | **GPL-3.0, archived** | IL bank/card Telegram notifications | **idea-only, do not copy** |

### Reusable (permissive) + references
| Repo | License | Use |
|---|---|---|
| **actualbudget/actual** | **MIT** (27k★) | **#1 code-reuse target** — rules engine, payee normalization, import dedup |
| **beancount/smart_importer** | **MIT** | ML categorization — adapt to Hebrew merchant strings |
| **plaid/pattern** | **MIT** | **Best server-side token-storage + webhook-sync blueprint** (adopt architecture, not vendor) |
| nordigen/nordigen-node·python | MIT | clean *licensed* open-banking client template (no IL coverage) |
| firefly-iii, Ghostfolio, rotki, beancount, OBP-API, adorsys/xs2a | **AGPL/GPL** | **idea-only, do not copy** |

> No credible permissive standalone **merchant-normalization** or **reconciliation** library exists — extract those from `actualbudget/actual` (MIT) or build in-house.

### Bottom line
1. Import engine: `israeli-bank-scrapers` (MIT, IL-wide) — **pending legal sign-off** on credential collection. 2. Blueprints: `moneyman` + `plaid/pattern` (MIT). 3. Reusable code: `actualbudget/actual` + `smart_importer` (MIT). 4. Idea-only (copyleft): Firefly III, Ghostfolio, rotki, beancount, OBP-API, IL Telegram bot. 5. Licensed-future templates: Nordigen/Salt Edge clients — **confirm IL coverage first**.

---

## 8. Next 5 actions
1. **Legal scoping call** (Israeli fintech counsel): can Kesefle operate under a partner's ISA license, or need its own? + the US-Sheets / Amendment-13 question. *(Founder/legal — blocks Path B.)*
2. **Email Finanda**: "regulated-entity-as-a-service" availability, named bank list, card-issuer coverage (Isracard/Max/CAL), consent screens, sandbox access. *(Founder.)*
3. **Build Phase-1 import-first** on the existing schema + reconciliation engine — CSV/Excel/statement import + dedup + admin review + bot Q&A. *(Engineering — no regulator needed; see [`FINANCIAL_INTEGRATION_ARCHITECTURE.md`](FINANCIAL_INTEGRATION_ARCHITECTURE.md).)*
4. **Green Invoice API sandbox POC** for business-revenue import (merchant-owned key = likely no license; confirm). *(Engineering.)*
5. **Decide the data-residency question** before any live API: if US-Sheets is non-compliant, plan an encrypted IL/KV store for regulated transaction data. *(Architecture + legal.)*
