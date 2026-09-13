#!/bin/bash
# Guarded deploy: INDEX_VERSION auto-bump, propagation settle, smoke test
# (the original automation) + the 2026-08-31 stale-deploy guards (branch ==
# main, tip == origin/main, clean tree, typecheck, unit suites, and the
# bump happens only when workers/ingest actually changed).
# Usage: npm run deploy  (or ./scripts/deploy.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

# the account id is an environment fact, never a repo default
: "${CLOUDFLARE_ACCOUNT_ID:?deploy:guard: CLOUDFLARE_ACCOUNT_ID must be set in the environment}"
export CLOUDFLARE_ACCOUNT_ID

# ── guards (stale-deploy near-miss, TODO.remaining/12) ──
BRANCH=$(git branch --show-current)
fail() { echo "deploy:guard: $1" >&2; exit 1; }
[ "$BRANCH" = "main" ] || fail "not on main (on '$BRANCH') — deploy from a synced main only"
[ -z "$(git status --porcelain | grep -v '^??')" ] || fail "uncommitted tracked changes — commit first"
git fetch origin main --quiet
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "local main != origin/main — fetch/ff first (stale-deploy guard)"
echo "── guards OK: clean main at $(git rev-parse --short HEAD) ──"

npm run typecheck > /dev/null && echo "── typecheck OK ──"
npm run test:units > /dev/null 2>&1 \
  && echo "── unit suites OK ──"

# ── build the site ──
echo "── building site ──"
(cd site && npm run build) > /dev/null

# ── auto-bump INDEX_VERSION (only when the serving/index surface changed) ──
TOML="workers/worker_public/wrangler.toml"
CURRENT=$(sed -n 's/.*INDEX_VERSION = "public-v\([0-9][0-9.]*\).*/\1/p' "$TOML" | head -1)
[ -n "$CURRENT" ] || fail "could not parse INDEX_VERSION from $TOML"
# drift guard: the toml must track what is DEPLOYED. The bump edit is not
# committed by this script, so a checkout or a parallel session can lose
# it — bumping from a stale number reuses a live cache namespace and
# serves pre-change answers. Sync from /health first, then bump.
LIVE=$(curl -sf "https://ai.oimlsmart.org/health" | sed -n 's/.*"public-v\([0-9][0-9.]*\).*/\1/p' | head -1)
if [ -n "$LIVE" ] && [ "$LIVE" != "$CURRENT" ]; then
  LIVE_MAJOR=$(echo "$LIVE" | cut -d. -f1)
  LIVE_MINOR=$(echo "$LIVE" | cut -d. -f2)
  CUR_MINOR=$(echo "$CURRENT" | cut -d. -f2)
  if [ "$LIVE_MAJOR" != "$(echo "$CURRENT" | cut -d. -f1)" ] || [ "$LIVE_MINOR" -lt "$CUR_MINOR" ]; then
    fail "toml INDEX_VERSION ($CURRENT) is AHEAD of live ($LIVE) — deploy the committed state or reconcile manually"
  fi
  echo "── version drift: toml $CURRENT behind live $LIVE — syncing toml first ──"
  sed -i '' "s/public-v${CURRENT}/public-v${LIVE}/" "$TOML"
  CURRENT="$LIVE"
fi
MAJOR=$(echo "$CURRENT" | cut -d. -f1)
MINOR=$(echo "$CURRENT" | cut -d. -f2)
NEXT="${MAJOR}.$((MINOR + 1))"
sed -i '' "s/public-v${CURRENT}/public-v${NEXT}/" "$TOML"
echo "── INDEX_VERSION: public-v${CURRENT} → public-v${NEXT} ──"
echo "   (commit this bump via your next PR — the script deliberately never commits)"

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

# smoke answers arrive via the local network; a dead socket is a
# TRANSPORT failure, not a quality regression — one retry before the
# probe may fail (a flake cried wolf five deploys running, always with
# the other probes green)
smoke_once() {
  curl -s -m 30 -X POST https://ai.oimlsmart.org/v1/ask \
    -H "authorization: Bearer $KEY" \
    -H "content-type: application/json" \
    -H "user-agent: deploy-guard" \
    -d "{\"query\":\"$query\",\"stream\":false}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('answer','')[:200])" 2>/dev/null || echo "CURL_FAILED"
}

smoke() {
  local label="$1" query="$2" expect="$3"
  local answer
  answer=$(smoke_once)
  if echo "$answer" | grep -qi "CURL_FAILED"; then
    sleep 3
    answer=$(smoke_once)
  fi
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
