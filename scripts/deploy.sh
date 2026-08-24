#!/bin/bash
# Deploy with INDEX_VERSION auto-bump, propagation settle, and smoke test.
# Usage: npm run deploy  (or ./scripts/deploy.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-06cad8ae9a017c856ab496c6bca9a9d8}"

# ── build the site ──
echo "── building site ──"
(cd site && npm run build) > /dev/null

# ── auto-bump INDEX_VERSION ──
TOML="workers/worker_public/wrangler.toml"
CURRENT=$(grep -o 'INDEX_VERSION = "public-v[0-9.]*"' "$TOML" | grep -o '[0-9.]*')
MAJOR=$(echo "$CURRENT" | cut -d. -f1)
MINOR=$(echo "$CURRENT" | cut -d. -f2)
NEXT="${MAJOR}.$((MINOR + 1))"
sed -i '' "s/public-v${CURRENT}/public-v${NEXT}/" "$TOML"
echo "── INDEX_VERSION: public-v${CURRENT} → public-v${NEXT} ──"

# ── deploy ──
echo "── deploying ──"
(cd workers/worker_public && npx wrangler deploy 2>&1 | grep -E "Version ID|Deployed")

# ── settle: wait for edge propagation ──
echo "── waiting 90s for edge propagation ──"
sleep 90

# ── smoke test: 3 golden queries ──
echo "── smoke test ──"
KEY=$(grep '^KEY=' .env | cut -d= -f2)
FAIL=0

smoke() {
  local label="$1" query="$2" expect="$3"
  local answer
  answer=$(curl -s -m 30 -X POST https://ai.oimlsmart.org/v1/ask \
    -H "authorization: Bearer $KEY" \
    -H "content-type: application/json" \
    -d "{\"query\":\"$query\",\"stream\":false}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('answer','')[:200])" 2>/dev/null || echo "CURL_FAILED")
  if echo "$answer" | grep -qi "$expect"; then
    echo "  ✓ $label"
  else
    echo "  ✗ $label — got: $answer"
    FAIL=1
  fi
}

smoke "R 60 mentions load cells" "What is R 60?" "load cell"
smoke "load cell definition" "What is a load cell?" "transducer\|measuring"
smoke "refusal works" "How do I make lasagna?" "don't have information"

if [ $FAIL -eq 1 ]; then
  echo "── SMOKE FAILED — check answers; the deploy is live but quality regressed ──"
  exit 1
fi

echo "── deploy complete: public-v${NEXT} ──"
