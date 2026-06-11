# Financial Integration Security Model — Kesefle

**Status:** DESIGN ONLY. No live integrations are authorized by this document.
**Owner:** Security/Privacy/Compliance. **Date:** 2026-06-11. **Applies to:** any feature that imports, reads, or writes user financial data (bank, card, crypto, exchange, CSV/file upload).
**Ground truth stack:** Vercel serverless (`api/*`), Upstash KV (no SQL), per-user Google Sheets ledger (`lib/sheet-writer.js`, תנועות A:H + I), WhatsApp bot (Apps Script), `api/sheet/csv-import.js`, `lib/bank-parsers.js`, `lib/crypto.js`, `lib/secure-kv.js`, `lib/user-activity.js`, Claude/Gemini categorization fallback.

---

## 1. Threat model (summary)

- **Assets:** OAuth/refresh tokens, financial transaction rows, account identifiers, user identity (phone/email/sub), audit history.
- **Adversaries:** external attacker (token theft, KV dump), malicious/compromised provider, curious admin, prompt-injection via transaction descriptions, our own bugs (mass-import corruption, cross-tenant writes).
- **Existing invariants to preserve:** tenant isolation (phone→sheet resolution chain), col-H sign semantics, no-PII-in-logs discipline, fail-soft external calls (invoice.js pattern).

| # | Scenario | Primary controls |
|---|----------|------------------|
| T1 | KV dump / Upstash compromise | C3 (envelopes useless without env keys), C10 (only last4 stored), C16 (raw TTL) |
| T2 | Stolen provider token | C4 rotation, C6 read-only blast radius, C7 revoke, §6.A |
| T3 | Cross-tenant read/write bug | AAD-bound envelopes (C3), existing tenant-isolation guard, C14 audit trail |
| T4 | LLM provider leak / prompt injection | C12 minimization + delimiter rule, C10 masking upstream |
| T5 | Insider / curious admin | C13 minimization, C14 audited admin reads |
| T6 | Mass-import corruption | batchId (C8), §6.C rollback, integrity-guard pipeline |
| T7 | Regulatory exposure (unlicensed aggregation) | C17 / §3 licensing boundary |
| T8 | Crypto key theft | §4 — nothing to steal: no keys ever held |

---

## 2. The 17 controls

### C1 — No raw bank credentials, ever
- Kesefle never asks for, transmits, stores, or proxies bank usernames/passwords/OTP codes. No screen-scraping with stored credentials. This is a hard architectural prohibition, not a config flag.
- The bot must actively refuse and warn if a user sends a password-looking string ("לעולם אל תשלחו סיסמת בנק בוואטסאפ"), and that message body must not be persisted.

### C2 — OAuth / consent-based access only
- Live connections (when ever built) go exclusively through OAuth-style consented flows of a **licensed provider** (see §3). The user sees provider-hosted consent; Kesefle receives scoped tokens only.
- User-initiated file upload (CSV/XLSX of the user's own data via `api/sheet/csv-import.js` + `lib/bank-parsers.js`) remains the default, license-free path.

### C3 — Tokens encrypted at rest
- Reuse the existing envelope pattern from `lib/crypto.js` + `lib/secure-kv.js` (`wrapEncryptedField` / `unwrapEncryptedField`, `v1:<kid>:<iv>:<tag>:<ct>` AES-256-GCM with AAD bound to `userSub`). Provider tokens get the same envelope, a new field name (e.g. `fiTokenEnc`), and the same cross-tenant-decryption-fails property.
- Plaintext tokens never leave the serverless handler's memory; never written to logs, KV unencrypted, or the user's Sheet.

### C4 — Token rotation
- Refresh tokens rotated on every use where the provider supports it; old token invalidated.
- Encryption keys: KESEFLE_DB_KEY kid-based rotation already exists — re-wrap envelopes lazily on read, fully within 90 days of a key rotation.
- Provider client secrets rotated at least annually and on any suspicion (see runbook §6).

### C5 — Least privilege
- Each integration requests the minimum scope set: account list + transactions. Never balances-of-other-products, never identity documents, never payment initiation.
- Internal: the import pipeline gets a token handle, not the envelope key; admin endpoints get aggregates, not tokens.

### C6 — Read-only scopes by default
- Default and only launch scope: **read**. Payment-initiation (PIS) scopes are forbidden without a separate security review, separate legal review, and a separate licensed rail. Any scope upgrade is a new feature, not a toggle.

### C7 — User disconnect flow (revoke + purge)
- One bot command + one web button ("נתק חיבור"): (1) call provider revoke endpoint, (2) delete the token envelope from KV, (3) delete provider-side connection record, (4) append audit event `fi_disconnect`, (5) confirm to user in Hebrew. Steps are idempotent; revoke failure still purges locally and flags for retry.

### C8 — User delete of imported data (GDPR-style)
- Extends existing `gdpr-data-delete` flow: user can delete (a) a single import batch (every import gets a `batchId` stamped into a hidden note / source column), (b) all imported rows, or (c) everything (full account deletion).
- Deletion removes KV raw payloads + normalized cache; Sheet rows are deleted from the user's own Sheet (it is theirs — we offer the script, they own the file). Audit entry records counts only, not contents.

### C9 — User export
- Extends `gdpr-data-export`: machine-readable JSON + CSV of all KV records attributable to the user (decrypted where they are the subject, tokens **excluded** — tokens are revoked, never exported) plus a copy/link of their Sheet. Delivered via signed, expiring URL (HMAC pattern in `lib/crypto.js`); export action audited.

### C10 — Masked identifiers (last4 only)
- Account/card identifiers are truncated to last-4 at the ingestion boundary, before any persistence. Storage format: `****1234` + provider-issued opaque account id (random, not derivable). Full IBAN/account numbers are never stored, never shown, never sent to LLMs, never written to the Sheet. Example UI: "בנק ****1234".

### C11 — No secrets / PII in logs
- Existing log-PII rules apply verbatim: log identity as hashed/short ids (`logId(sub)` in secure-kv.js), amounts and counts allowed, descriptions/merchants/emails/account numbers forbidden. `lib/bank-parsers.js` already logs skip reasons without row contents — every new parser/importer must match that bar. CI check: grep gate for `console.log` containing `description|token|account` in `api/fi/*`.

### C12 — LLM data minimization
- Categorization prompts (Claude primary, Gemini fallback — today's pipeline) receive **merchant string + amount + date only**. Never: account ids (even last4), user name, phone, email, balance, token, sheet id.
- Batch prompts shuffled so no single prompt reconstructs a full statement. Provider calls use no-training/zero-retention API tiers. Prompt-injection defense: transaction descriptions are data, never instructions — wrap in delimiters, ignore any imperative content.

### C13 — Admin minimization
- Admin dashboard sees aggregates: connection count, import counts, error rates, last-sync age. Admin never sees transaction descriptions, merchant names, or identifiers beyond masked last4 in a support flow explicitly initiated by the user. `maskFields` (secure-kv.js) pattern extends to all FI records. Admin reads of any per-user FI record are themselves audited.

### C14 — Append-only audit log
- Every import, write, edit, delete, disconnect, export, and admin access appends to `audit:{sub}` in KV (the `auditLog()` export in secure-kv.js is the seed). Entries: `{ts, action, actor (user|bot|admin|system), batchId, rowCount, source}` — metadata only, no contents. Append-only by convention + code review gate (no delete/overwrite codepath for `audit:*` keys); retained ≥ 24 months; included in user export.

### C15 — Incident response runbook (see §6)
- Three rehearsed scenarios: leaked token, provider breach, mass-import error. Runbook lives here + `docs/compliance/incident-response-runbook.md`; kill-switch precedent: `KFL_DISABLE_BOT_WRITES`.

### C16 — Data retention
- **Raw provider payloads / uploaded files:** kept ≤ 90 days (KV TTL set at write time — enforcement by mechanism, not policy memo), then dropped automatically.
- **Normalized transaction rows:** kept in the user's own Sheet indefinitely (user-owned) and in KV caches only as long as functionally needed.
- **Audit log:** ≥ 24 months. **Revoked tokens:** deleted immediately. **Deleted accounts:** full KV purge ≤ 30 days, audit stub of the deletion retained.

### C17 — Israeli regulatory context (see §3)
- Privacy Protection Law incl. Amendment 13; financial data treated as **sensitive data** ("מידע רגיש") with the heightened obligations that implies; חוק שירותי מידע פיננסי, התשפ"ב-2021 licensing boundary respected.

---

## 3. Israeli regulatory posture

1. **חוק שירותי מידע פיננסי 2021 (Financial Information Services Law / Open Banking):** providing payment-account information services in Israel **requires a license** from the ISA. Kesefle will **never act as an unlicensed aggregator**. Architecture rule: any live bank connection is built **via a licensed Israeli provider** (Kesefle = client of the licensee), with the licensee holding the bank relationship and consent records. Until such a partnership exists, the only ingestion paths are user-initiated upload of the user's own files (CSV/XLSX/screenshot) and manual entry — these do not constitute a financial-information service.
2. **Privacy Protection Law + Amendment 13 (in force Aug 2025):** financial data is sensitive data → database registration/notification duties as applicable, appointed privacy officer when thresholds met, breach notification to the Privacy Protection Authority, documented security procedures (this document is part of that), data-minimization and purpose-limitation by design. Kesefle's existing Amendment-13 work (privacy policy, DSR flows) extends to FI data.
3. **Consent:** explicit, granular, Hebrew-language consent per connection, revocable at any time (C7), with plain-language description of exactly what is read.

## 4. Crypto custody

- **Never hold keys.** No private keys, no seed phrases, no custody, no signing. The bot refuses and never persists any seed-phrase-shaped message.
- Allowed: **watch-only public addresses** (user pastes an address; we read public chain data) and **read-only exchange API keys with withdrawals disabled** — verified at connect time by probing capability flags, rejected if trading/withdrawal permissions are present. Keys stored under the same C3 envelope; valuations via existing FX/price rates (`_kfl_fxRate` pattern); same masking (address shown as `0x12…ab34`).

## 5. AI usage rules for financial data

- **No silent overwrites:** AI may propose a category/edit; it never mutates an existing user-entered row without explicit confirmation (safeSetValue ethos).
- **Confidence required:** every AI categorization carries a confidence score; the score and model id are stored with the row's metadata, not shown as fact.
- **Low confidence → `needs_review`:** below threshold, the row is written with category "לבדיקה" / flagged `needs_review` and surfaced to the user — never guessed-and-buried.
- AI output is validated against the closed category taxonomy (`lib/categories.js`); free-text categories from the model are rejected.

## 6. Incident response runbook

**A. Leaked token (one user or our client secret):**
1. Revoke at provider; delete envelope(s) from KV; if client secret — rotate it and invalidate all sessions.
2. Flip integration kill-switch env (`KFL_DISABLE_FI_SYNC`, mirroring `KFL_DISABLE_BOT_WRITES`).
3. Audit-log the event; review `audit:{sub}` for access during exposure window.
4. Notify affected user(s) in Hebrew within 72h; notify PPA if Amendment-13 thresholds met. Post-mortem within 7 days.

**B. Provider breach:**
1. Kill-switch all syncs via that provider; rotate our credentials with them.
2. Inventory affected users from connection records; force-revoke + re-consent.
3. User + regulator notification per §3.2; record decision either way.

**C. Mass-import error (wrong rows written at scale):**
1. Stop imports (kill-switch). 2. Identify affected rows by `batchId` (C8) and Sheet version history (existing recovery procedure).
3. Dry-run the rollback (financial-data-integrity-guard pipeline: backup → dry-run → approve → apply → validate), then apply per-tenant.
4. Verify dashboards reconcile (SUMIFS vs row-level), audit-log the rollback, notify affected users.

## 7. KV schema for FI records (design)

All keys namespaced, all per-user, all compatible with the existing `user:{sub}` / `audit:{sub}` conventions in `lib/secure-kv.js`:

| Key | Value | Encryption | TTL |
|-----|-------|-----------|-----|
| `fi:conn:{sub}:{connId}` | provider id, masked account list (`****1234`), scopes, status, lastSyncTs | token field wrapped via `wrapEncryptedField` (AAD=sub) | none (deleted on disconnect) |
| `fi:raw:{sub}:{batchId}` | raw provider payload / uploaded file body | envelope-encrypted | **90 days, set at write** |
| `fi:batch:{sub}:{batchId}` | normalized row metadata: count, date range, source, sheet row span | plaintext metadata only (no descriptions) | 24 months |
| `audit:{sub}` | append-only event list (C14) | plaintext metadata only | ≥ 24 months |
| `fi:review:{sub}` | queue of `needs_review` row pointers | row refs only | until resolved |

Rules: no key ever stores an unmasked account identifier; no key stores a plaintext token; `fi:raw:*` is the **only** place full provider payloads exist and it self-destructs by TTL (C16 enforced by mechanism). Sheet remains the user-facing source of truth; KV is plumbing.

## 8. Consent & UX requirements (Hebrew-first)

1. Consent screen states, in plain Hebrew, exactly: which institution, which accounts (masked), read-only, revocable anytime, retention periods. No bundled consent.
2. The bot announces every import: "ייבאתי 42 תנועות מ-בנק ****1234. לביטול: שלחו 'בטל ייבוא'." — undo window maps to batch rollback (C8).
3. Disconnect ("נתק חיבור") and delete ("מחק נתונים") are discoverable in the bot menu and on /account — max two taps, no dark patterns.
4. `needs_review` rows are surfaced proactively ("3 תנועות מחכות לאישור קטגוריה"), never silently accumulated.
5. All identifiers shown anywhere (bot, web, Sheet, admin) use the C10 masked form. Examples in marketing/docs use fake identifiers only (`****0000`).

## 9. Verification & testing requirements

- **Per-control tests** live under `tests/` following the existing no-mock-framework pattern:
  - envelope cross-tenant decrypt must throw (C3); rotation re-wrap idempotence (C4);
  - scope probe rejects write/withdrawal-capable credentials (C6, §4);
  - disconnect E2E: revoke called, KV keys gone, audit row present (C7);
  - delete/export cover `fi:*` keys (C8/C9); masking function property-tested on Israeli account/IBAN formats (C10);
  - log grep gate over a full import run (C11); prompt-builder unit test asserts field allowlist (C12);
  - audit append-only: no code path deletes `audit:*` (C14, static check);
  - TTL presence asserted on every `fi:raw:*` write (C16).
- These join the existing gauntlet (`tests/full_qa.js` + golden set) and are merge-blocking for any `api/fi/*` change.

## 10. Data flow (normative)

```
user consent → licensed provider OAuth → token → C3 envelope in KV
provider/file → raw payload (KV, TTL 90d) → bank-parsers normalize →
mask to last4 → dedup → LLM categorize (merchant+amount only) →
confidence gate → Sheet write A:H(+I) with batchId + source → audit:{sub}
```
Every arrow that writes is audited (C14); every arrow that stores is encrypted or user-owned; every arrow into an LLM is minimized (C12).

---

## 11. Roles, change control, and review cadence

- **Decision owner:** Steven (product) approves any new provider, scope, or retention change; this document is updated in the same PR.
- **Security review:** any change under `api/fi/*`, `lib/secure-kv.js`, `lib/crypto.js`, or this document requires the `security-scan` + `pr-review` gates and a second look at C3/C11/C12 specifically.
- **No emergency bypass:** kill-switches turn features **off**; there is no env flag that turns a gate off. Skipping a gate requires editing this document in a reviewed PR — by design, slow.
- **Cadence:** quarterly re-run of the §9 test suite against staging; annual review of §3 regulatory posture (licensing landscape and Amendment-13 guidance move); retention TTLs spot-checked monthly by the existing admin health check.
- **Documentation links:** `docs/compliance/privacy-law-compliance.md`, `docs/compliance/incident-response-runbook.md`, `docs/security/data-classification.md`, `docs/TENANT_ISOLATION_MODEL.md` are subordinate references; on conflict, the stricter rule wins.

## 12. Gates before any live integration ships (all 10 must pass)

1. Licensed-provider agreement signed; legal sign-off that Kesefle is not an unlicensed aggregator under חוק שירותי מידע פיננסי.
2. Amendment-13 review done: consent text, privacy policy update, breach-notification path, DB registration status.
3. Tokens stored only via the C3 envelope; cross-tenant decrypt test fails as expected.
4. Scopes verified read-only at runtime, not just at registration; withdrawal-capable crypto keys rejected by test.
5. Disconnect flow (revoke + purge + audit) passes an automated end-to-end test.
6. GDPR-style delete + export cover FI data; batchId rollback tested on a copy sheet.
7. Log audit: zero descriptions/identifiers/tokens in logs under full import test (grep gate green).
8. LLM prompts inspected in staging: merchant+amount only; needs_review path exercised.
9. Kill-switch (`KFL_DISABLE_FI_SYNC`) flipped and verified to halt all syncs within one cycle.
10. Incident runbook tabletop walked through (all three scenarios) with Steven; audit log shows the drill.
