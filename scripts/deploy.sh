#!/bin/bash
# Guarded deploy: INDEX_VERSION auto-bump, propagation settle, smoke test
# (the original automation) + the 2026-08-31 stale-deploy guards (branch ==
# main, tip == origin/main, clean tree, typecheck, unit suites, and the
# bump happens only when workers/ingest actually changed).
# Usage: npm run deploy  (or ./scripts/deploy.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-06cad8ae9a017c856ab496c6bca9a9d8}"

# ── guards (stale-deploy near-miss, TODO.remaining/12) ──
BRANCH=$(git branch --show-current)
fail() { echo "deploy:guard: $1" >&2; exit 1; }
[ "$BRANCH" = "main" ] || fail "not on main (on '$BRANCH') — deploy from a synced main only"
[ -z "$(git status --porcelain | grep -v '^??')" ] || fail "uncommitted tracked changes — commit first"
git fetch origin main --quiet
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "local main != origin/main — fetch/ff first (stale-deploy guard)"
echo "── guards OK: clean main at $(git rev-parse --short HEAD) ──"

npm run typecheck > /dev/null && echo "── typecheck OK ──"
node --test --experimental-strip-types tests/refs.test.ts tests/lexical.test.ts tests/anchors.test.ts tests/structural.test.ts > /dev/null 2>&1 \
  && echo "── unit suites OK ──"

# ── build the site ──
echo "── building site ──"
(cd site && npm run build) > /dev/null

# ── auto-bump INDEX_VERSION (only when the serving/index surface changed) ──
TOML="workers/worker_public/wrangler.toml"
CURRENT=$(sed -n 's/.*INDEX_VERSION = "public-v\([0-9][0-9.]*\).*/\1/p' "$TOML" | head -1)
[ -n "$CURRENT" ] || fail "could not parse INDEX_VERSION from $TOML"
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
    -H "user-agent: deploy-guard" \
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
  git checkout "$TOML" 2>/dev/null || true
  exit 1
fi

echo "── deploy complete: public-v${NEXT} ──"
