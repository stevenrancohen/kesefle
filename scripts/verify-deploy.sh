#!/usr/bin/env bash
# verify-deploy.sh — Kesefle health check
# Runs in ~10 seconds. Reports the live deploy state.
#
# Usage:
#   ./scripts/verify-deploy.sh
#   ./scripts/verify-deploy.sh https://staging.kesefle.app   # override URL
#
# Exits 0 if all critical checks pass, 1 otherwise.

set -u
BASE="${1:-https://kesefle.vercel.app}"
pass=0
fail=0

c_ok() { printf '\033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
c_no() { printf '\033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
c_warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

http_code() {
  curl -s -o /dev/null -w "%{http_code}" --max-redirs 0 "$1"
}

echo "Verifying $BASE …"
echo ""

# 1. Health endpoint
echo "── API health ──"
health=$(curl -s "$BASE/api/health")
ok=$(echo "$health" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('ok') else '0')" 2>/dev/null || echo "0")
if [ "$ok" = "1" ]; then c_ok "/api/health returns ok:true"; else c_no "/api/health ok=$ok (KV/env_vars problem)"; fi

kv=$(echo "$health" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('deps',{}).get('kv',{}).get('ok') else '0')" 2>/dev/null || echo "0")
if [ "$kv" = "1" ]; then c_ok "KV connected"; else c_no "KV not connected — check KV_REST_API_URL+TOKEN env vars"; fi

# 2. Public pages
echo ""
echo "── Public pages (28 routes) ──"
for r in / /en /pricing /demo /compare /trust /help /roadmap /changelog /referral /about /press /docs /testimonials /cases /blog /tools /privacy /terms /status /welcome /account /offline /thanks /open /404 ; do
  code=$(http_code "$BASE$r")
  if [ "$code" = "200" ]; then c_ok "$r → 200"
  elif [ "$code" = "404" ]; then c_no "$r → 404"
  else c_warn "$r → $code"
  fi
done

# 3. Blog + Tools sub-pages
echo ""
echo "── Blog articles ──"
for r in /blog/expense-tracking-freelancer /blog/budget-vs-cashflow /blog/whatsapp-business-tools ; do
  code=$(http_code "$BASE$r")
  if [ "$code" = "200" ]; then c_ok "$r → 200"; else c_no "$r → $code"; fi
done

echo ""
echo "── Free tools ──"
for r in /tools/freelancer-profitability /tools/budget-calculator /tools/vat-calculator /tools/cashflow-projector ; do
  code=$(http_code "$BASE$r")
  if [ "$code" = "200" ]; then c_ok "$r → 200"; else c_no "$r → $code"; fi
done

# 4. Discoverability files
echo ""
echo "── Discoverability ──"
for r in /sitemap.xml /robots.txt /humans.txt /.well-known/security.txt /opensearch.xml /manifest.webmanifest /sw.js /icon-192.png /icon-512.png /lib/analytics.js ; do
  code=$(http_code "$BASE$r")
  if [ "$code" = "200" ]; then c_ok "$r → 200"; else c_no "$r → $code"; fi
done

# 5. URL redirects
echo ""
echo "── URL redirects (expect 307) ──"
for r in /signup /login /careers /support /security /api-docs /invite /faq ; do
  code=$(http_code "$BASE$r")
  if [ "$code" = "307" ] || [ "$code" = "308" ]; then c_ok "$r → $code (redirect)"; else c_warn "$r → $code (expected 307/308)"; fi
done

# 6. Auth-gated endpoints (expect 401)
echo ""
echo "── Auth-gated APIs (expect 401 without token) ──"
for r in "/api/account?action=delete" "/api/account?action=export" "/api/referral?action=mine" "/api/admin?action=users" "/api/sheet/summary" ; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$r")
  if [ "$code" = "401" ]; then c_ok "$r → 401 (auth required)"; else c_warn "$r → $code"; fi
done

# 7. POST endpoints
echo ""
echo "── Anonymous POST endpoints ──"
code=$(curl -s -o /dev/null -X POST "$BASE/api/events?action=track" -H 'Content-Type: application/json' -d '{"event":"page_view","session":"verifydeploy"}' -w "%{http_code}")
if [ "$code" = "204" ]; then c_ok "/api/events?action=track → 204"; else c_no "/api/events track → $code"; fi

code=$(curl -s -o /dev/null -X POST "$BASE/api/events?action=nps" -H 'Content-Type: application/json' -d '{"score":9,"session":"verifydeploy","path":"/test"}' -w "%{http_code}")
if [ "$code" = "200" ]; then c_ok "/api/events?action=nps → 200"; else c_no "/api/events nps → $code"; fi

# 8. Sitemap parse
echo ""
echo "── Sitemap ──"
sitemap_urls=$(curl -s "$BASE/sitemap.xml" | grep -c '<loc>')
if [ "$sitemap_urls" -ge 20 ]; then c_ok "sitemap.xml has $sitemap_urls URLs"; else c_no "sitemap.xml has only $sitemap_urls URLs"; fi

# Summary
echo ""
echo "─────────────────────────────"
printf "PASS: \033[32m%d\033[0m   FAIL: \033[31m%d\033[0m\n" "$pass" "$fail"
echo "─────────────────────────────"

if [ "$fail" -gt 0 ]; then exit 1; fi
exit 0
