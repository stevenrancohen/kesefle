---
name: kesefle-security-privacy-audit
description: Periodic security + privacy sweep — secrets, PII in logs, unauthenticated endpoints, open CORS, missing rate limits, LLM data leakage. Mask everything. Severity-tagged report.
---

# kesefle-security-privacy-audit

When invoked: run the deep scan from `.claude/skills/security-scan/SKILL.md` PLUS:

## Extended scope
1. **LLM call audit** — every fetch/axios call to OpenAI/Anthropic/Gemini/OpenRouter:
   - What's in the prompt?
   - Is it anonymized (no raw phone, no real name, no real SSN/ID, no full transaction text)?
   - Is there a `needs_review` fallback if model is uncertain?
2. **PII in logs** — grep `console.log` / `logger.info` for direct mention of `phone`, `email`, `userSub`, `userId`, full transaction text — must be masked or hashed
3. **Cross-tenant data exposure** — `/api/admin/*` endpoints — verify each one filters by admin scope, never returns other users' raw data
4. **Webhook signature verification** — Resend, PayPal, Anthropic — every webhook endpoint must verify the signature
5. **CSRF protection** — POST/DELETE endpoints check Origin/Referer header
6. **Cookie security** — HttpOnly + Secure + SameSite=Strict on every auth cookie
7. **Subresource integrity** — every external script tag must have `integrity` attribute (Tailwind CDN exception is documented)

## Output report structure
```
## Critical (P0)
- [item with masked evidence]
## High (P1)
## Medium (P2)
## Low (P3)
## Items verified safe
```

## Pass criteria
- 0 Critical findings
- 0 unauthenticated write endpoints
- 0 PII-in-logs (after fix)
- All LLM prompts anonymized

## Outputs
- `security-audit-{YYYY-MM-DD}.md` with masked evidence

## Hard NO
- NEVER include real secret values
- NEVER include real phone numbers / emails
- NEVER rotate keys (recommend rotation; Steven does the rotation)
