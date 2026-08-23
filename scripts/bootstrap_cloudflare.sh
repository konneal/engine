#!/usr/bin/env bash
# Creates all Cloudflare resources for the public RAG tier and wires them
# into workers/worker_public/wrangler.toml. Requires `npx wrangler login`.
# Safe to re-run — existing resources are detected, not duplicated.

set -euo pipefail
cd "$(dirname "$0")/.."

TOML="workers/worker_public/wrangler.toml"

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "NOT AUTHENTICATED — run: npx wrangler login" >&2
  exit 1
fi

ACCOUNT_ID=$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)
if [ -z "$ACCOUNT_ID" ]; then
  echo "Could not parse account id from wrangler whoami" >&2
  exit 1
fi
echo "account: $ACCOUNT_ID"
echo "CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID" > .env

# --- Vectorize index (qwen3-embedding-0.6b = 1024 dims) ---
if npx wrangler vectorize info idx_oiml_public >/dev/null 2>&1; then
  echo "vectorize: idx_oiml_public exists"
else
  npx wrangler vectorize create idx_oiml_public --dimensions 1024 --metric cosine
fi

# --- KV namespace ---
KV_ID=$(npx wrangler kv namespace list 2>/dev/null | python3 -c "
import json,sys
for ns in json.load(sys.stdin):
    if ns['title'].endswith('rag-public-cache'):
        print(ns['id']); break
")
if [ -z "$KV_ID" ]; then
  OUT=$(npx wrangler kv namespace create CACHE 2>&1 | grep -oE '[0-9a-f]{32}' | head -1)
  KV_ID=$OUT
fi
echo "kv: $KV_ID"
sed -i '' "s/KV_ID_PLACEHOLDER/$KV_ID/" "$TOML"

# --- D1 database ---
D1_ID=$(npx wrangler d1 list --json 2>/dev/null | python3 -c "
import json,sys
for db in json.load(sys.stdin):
    if db['name'] == 'rag-public':
        print(db['uuid']); break
")
if [ -z "$D1_ID" ]; then
  D1_ID=$(npx wrangler d1 create rag-public 2>&1 | grep -oE '[0-9a-f]{32}' | head -1)
fi
echo "d1: $D1_ID"
sed -i '' "s/D1_ID_PLACEHOLDER/$D1_ID/" "$TOML"
npx wrangler d1 execute rag-public --file workers/worker_public/schema.sql --remote -y

# --- Deploy (custom domain commented out until the zone is confirmed) ---
npx wrangler deploy -c workers/worker_public/wrangler.toml

# --- Admin token for API key creation ---
if ! npx wrangler secret list -c workers/worker_public/wrangler.toml 2>/dev/null | grep -q ADMIN_TOKEN; then
  echo
  echo "Set the admin token for API key creation:"
  echo "  openssl rand -hex 24 | npx wrangler secret put ADMIN_TOKEN -c workers/worker_public/wrangler.toml"
fi

echo
echo "Ingest credentials (add to .env or export):"
echo "  export CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID"
echo "  # CLOUDFLARE_API_TOKEN optional — ingest falls back to the wrangler OAuth token"
echo
echo "Then index the corpus:"
echo "  .venv/bin/python -m ingest.cli probe"
echo "  .venv/bin/python -m ingest.cli embed && .venv/bin/python -m ingest.cli upsert"
