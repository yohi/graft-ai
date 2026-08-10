#!/usr/bin/env bash
set -euo pipefail

API_BASE="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

echo "Checking Tail Worker script exists..."
curl -s "${API_BASE}/workers/scripts/graft-ai-aig-tail" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  | jq -e '.success' >/dev/null || fail "Tail Worker not found"

echo "Checking proxy tail consumer configuration..."
curl -s "${API_BASE}/workers/scripts/graft-ai-aig-proxy/subdomain" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  > /tmp/proxy_subdomain.json
jq -e '.success' /tmp/proxy_subdomain.json >/dev/null || fail "proxy subdomain lookup failed"

PROXY_URL="https://graft-ai-aig-proxy.${WORKERS_SUBDOMAIN}.workers.dev"
echo "Sending test request to proxy: ${PROXY_URL}"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${PROXY_URL}/workers-ai/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "X-Proxy-Secret: ${PROXY_SECRET}" \
  -d '{"model":"@cf/meta/llama-3.2-1b-instruct","messages":[{"role":"user","content":"graft-ai ci ping"}]}' \
  || echo "000")

# A 401/403 from the upstream AI Gateway is acceptable for connectivity check;
# 5xx or network failure is not.
if [[ "$HTTP_STATUS" =~ ^5[0-9][0-9]$ || "$HTTP_STATUS" == "000" ]]; then
  fail "Proxy request failed with HTTP ${HTTP_STATUS}"
fi

echo "Proxy returned HTTP ${HTTP_STATUS}; waiting 10s for Loki ingestion..."
sleep 10

echo "Querying Loki labels..."
LOKI_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "${GRAFANA_LOKI_USERNAME}:${GRAFANA_LOKI_TOKEN}" \
  "${GRAFANA_LOKI_URL}/loki/api/v1/label/env/values" \
  || echo "000")
[[ "$LOKI_STATUS" == "200" ]] || fail "Loki label query returned HTTP ${LOKI_STATUS}"

if [[ -n "${LOGPUSH_JOB_ID:-}" ]]; then
  echo "Checking Logpush job ${LOGPUSH_JOB_ID}..."
  curl -s "${API_BASE}/logpush/jobs/${LOGPUSH_JOB_ID}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    | jq -e '.success and .result.enabled == true' >/dev/null \
    || fail "Logpush job check failed"
fi

echo "Deployment verification passed."
