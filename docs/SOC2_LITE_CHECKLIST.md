# SOC 2-Lite Self-Assessment

**Last reviewed:** 2026-05-24
**Owner:** Steven Ran Cohen (srcslcollection@gmail.com)
**Scope:** Kesefle Hebrew WhatsApp expense-tracking SaaS — Vercel serverless + Upstash KV + per-tenant Google Sheets

This document is a **self-assessment** modeled on the SOC 2 Common Criteria (CC1-CC9) and is intended for use as a trust signal in B2B sales conversations. It is **NOT a third-party attested SOC 2 Type II report**. For an attested report, engage a CPA firm specializing in SOC 2 audits (~$15-25k, 6-12 months).

Each control is rated **✅ Met / ⚠️ Partial / ❌ Gap** with evidence (file path or runbook section).

---

## CC1 — Control Environment

| # | Control | Status | Evidence |
|---|---|---|---|
| 1.1 | Single accountable owner identified | ✅ | Steven (full pre-approval authority, single-person org) |
| 1.2 | Acceptable Use Policy + Code of Conduct documented | ⚠️ | `terms.html` covers customer AUP. Internal CoC not formalized — single-employee gap. |
| 1.3 | Background checks on personnel | n/a | No employees beyond owner |
| 1.4 | Annual security training | ⚠️ | Owner self-trains via security-scan + pr-review skills; not documented |

## CC2 — Communication & Information

| # | Control | Status | Evidence |
|---|---|---|---|
| 2.1 | Privacy policy publicly available | ✅ | `privacy.html` (updated 2026-05-24, accurate sign-in provider list) |
| 2.2 | Terms of service publicly available | ✅ | `terms.html` (14-day refund clause, Israeli consumer rights) |
| 2.3 | Security incident contact published | ✅ | `.well-known/security.txt` + `info@kesefle.com` |
| 2.4 | Customers notified of material changes | ⚠️ | No formal change-comm process. Plan: email all users for ToS/Privacy diffs. |
| 2.5 | Customers can request data export | ✅ | `/api/account/export` (api/account.js:165) returns full record + sheet info |
| 2.6 | Customers can request data deletion | ✅ | `/api/account/delete` (api/account.js:72) + bot "מחק חשבון" command |

## CC3 — Risk Assessment

| # | Control | Status | Evidence |
|---|---|---|---|
| 3.1 | Risk register maintained | ⚠️ | `docs/DEPLOY_1000_USERS_PLAN.md` covers 10 dimensions but not formal risk-rating |
| 3.2 | Threat model documented | ⚠️ | `docs/security.md` covers tenant isolation; full STRIDE-style threat model TBD |
| 3.3 | Annual risk review scheduled | ⚠️ | Informal — quarterly via `security-scan` skill |
| 3.4 | Dependencies audited for known CVEs | ✅ | Pure-Node ESM, zero npm dependencies. CSP locks 3rd-party scripts |
| 3.5 | Vendor risk reviewed before onboarding | ✅ | Documented in DEPLOY_1000_USERS_PLAN.md: Vercel, Upstash, Resend, Google, Meta, Anthropic, OpenAI, Google AI |

## CC4 — Monitoring Activities

| # | Control | Status | Evidence |
|---|---|---|---|
| 4.1 | Application logs centrally collected | ✅ | `lib/log.js` structured logs → Vercel runtime logs |
| 4.2 | KV usage monitored with capacity alerts | ✅ | `api/cron/kv-monitor.js` hourly, alerts at 80% via `lib/alert.js` |
| 4.3 | Tenant isolation monitored | ✅ | `api/sheet/append.js` multi-writer anomaly detector + `sendAlert` |
| 4.4 | Uptime monitoring | ⚠️ | `/api/health/detailed` exists; external pinger (UptimeRobot) not wired |
| 4.5 | Security alerts routed to owner | ✅ | `lib/alert.js` → Slack + email via Resend with 1h dedup |
| 4.6 | Bot version drift detected | ✅ | `api/admin/bot-version.js` + heartbeat cron + admin UI banner |
| 4.7 | Conversion funnel tracked | ✅ | `/api/admin/funnel-summary` with biggest-leak callout |
| 4.8 | Bot heartbeat (proves bot is alive) | ✅ | `cronBotHeartbeat` hourly to `/api/log/bot-heartbeat` |

## CC5 — Control Activities

| # | Control | Status | Evidence |
|---|---|---|---|
| 5.1 | All endpoints rate-limited | ✅ | `lib/ratelimit.js` `withRateLimit` wrapper, applied to every public endpoint |
| 5.2 | Admin endpoints require admin auth | ✅ | `lib/auth.js` `requireAdmin` with `ADMIN_EMAILS` allowlist |
| 5.3 | User endpoints require user auth | ✅ | `lib/auth.js` `requireAuth` with session cookie OR Bearer |
| 5.4 | Sensitive operations require explicit confirmation | ✅ | GDPR delete requires "מחק חשבון" confirmation in bot |
| 5.5 | Code changes peer-reviewed | ⚠️ | Solo founder — relies on `pr-review` skill (AI-assisted, not human) |
| 5.6 | Pre-deploy QA suite required | ✅ | `tests/full_qa.js` 100/100 must pass before push; documented in `.claude/skills/deploy-checklist` |
| 5.7 | Secrets isolated from code | ✅ | All secrets in Vercel env, none in repo (verified by `security-scan` skill) |

## CC6 — Logical Access

| # | Control | Status | Evidence |
|---|---|---|---|
| 6.1 | All web traffic over TLS | ✅ | Vercel terminates TLS; HSTS header in `vercel.json` (max-age 2yr + preload) |
| 6.2 | HTTP-only secure cookies | ✅ | `kefle_session` cookie set HttpOnly + Secure + SameSite=Lax |
| 6.3 | OAuth flow uses PKCE | ✅ | `account.html` PKCE → `/api/auth/google-exchange` |
| 6.4 | Session secret rotated procedurally | ⚠️ | `SESSION_SECRET` rotation manual; runbook documented but never executed |
| 6.5 | Bot-to-server secret rotated procedurally | ✅ | `docs/BOT_SECRET_ROTATION.md` zero-downtime rotation procedure |
| 6.6 | Refresh tokens encrypted at rest | ✅ | AES-256-GCM envelope via `lib/crypto.js`, AAD bound to userSub |
| 6.7 | Bot-secret comparison constant-time | ✅ | `lib/auth.js` + `api/whatsapp/link.js` `constantTimeEqual` (regression-guarded in QA) |
| 6.8 | Atomic phone-claim prevents account takeover | ✅ | Upstash SET NX in `api/whatsapp/link.js` |
| 6.9 | Cross-tenant write isolation enforced | ✅ | Multi-step canonical-sheet check + multi-writer anomaly detector in `api/sheet/append.js` |
| 6.10 | Admin access requires explicit allowlist | ✅ | `ADMIN_EMAILS` env (defaults to stevenrancohen@gmail.com + info@kesefle.com) |

## CC7 — System Operations

| # | Control | Status | Evidence |
|---|---|---|---|
| 7.1 | Change management process | ✅ | Git + push to main → Vercel auto-deploy; bot manual paste per `docs/DEPLOY.md` |
| 7.2 | Deployment rollback supported | ✅ | Vercel one-click revert from prior deploy |
| 7.3 | Production secrets separated from dev | ⚠️ | Single Vercel project (prod); no dev env. Sandbox via `GREEN_INVOICE_ENV=test` |
| 7.4 | Backup procedure documented | ✅ | `api/cron/kv-backup.js` nightly to admin Drive, 7-day rolling |
| 7.5 | Backup restoration tested | ❌ | Not tested. Recommended: quarterly restoration drill |
| 7.6 | Incident response runbook | ✅ | `docs/LAUNCH_DAY_RUNBOOK.md` covers 10 failure modes with 1-min responses |
| 7.7 | Critical job idempotency | ✅ | Lifecycle cron uses `email_sent:{userSub}:{template}` guards; PayPal webhook uses `seen:{event.id}` |

## CC8 — Change Management

| # | Control | Status | Evidence |
|---|---|---|---|
| 8.1 | All changes tracked in git | ✅ | All deploys originate from git commits; no out-of-band changes |
| 8.2 | Commits require descriptive messages | ✅ | Convention enforced manually; "feat/fix/chore/docs" prefix |
| 8.3 | Security-relevant changes flagged | ✅ | `security-scan` skill flags secrets/tenant-isolation/injection issues before commit |
| 8.4 | Bot deploys require manual checklist | ✅ | `.claude/skills/deploy-checklist` enforces reassemble + node --check + grep doPost==1 |

## CC9 — Risk Mitigation

| # | Control | Status | Evidence |
|---|---|---|---|
| 9.1 | Vendor SLAs reviewed | ⚠️ | Vercel 99.99% pro, Upstash 99.9%, Google Workspace 99.9%, Meta WhatsApp 99.9% — not formally tracked |
| 9.2 | Vendor data-handling agreements signed | ⚠️ | Standard ToS accepted; no negotiated BAAs |
| 9.3 | Penetration test performed | ❌ | Not yet. Plan: engage Israeli pentester for 1-day review before 100 paid users |
| 9.4 | Public security disclosure channel | ✅ | `.well-known/security.txt` with `Contact: mailto:info@kesefle.com` |
| 9.5 | Customer-facing security FAQ | ✅ | `/trust` page covers encryption, scopes, data residency |

---

## Summary

| Status | Count |
|---|---|
| ✅ Met | 32 |
| ⚠️ Partial | 11 |
| ❌ Gap | 2 |
| n/a | 1 |

**Total: 46 controls evaluated**

### Top 3 gaps to close before 100 paying users
1. **Penetration test** (#9.3) — 1-day external review (~$2-5k Israeli pentester)
2. **Backup restoration drill** (#7.5) — Quarterly test of restoring a KV snapshot to a Vercel preview env
3. **Centralized risk register** (#3.1) — Convert this document into a living per-quarter review

### When to upgrade to formal SOC 2
- Once first 10 B2B (small business) customers ask for it
- Or once revenue justifies the $15-25k + 6-month attestation timeline
- Or when an enterprise prospect explicitly requires it

Until then, this self-assessment + the underlying controls give honest customers the assurance that we take security seriously. Don't claim "SOC 2 compliant" — that's a legal misrepresentation. Do claim "SOC 2-aligned self-assessment available on request."

---

## Document history
- 2026-05-24: Initial version (Steven + Claude pair-authored after Week 1-2 launch readiness work)
