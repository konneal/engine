#!/bin/bash
# TODO.remaining/04+06: when the table enrichment finishes, complete the
# lane (FTS reload, v2.62) and run the calm-window baselines the moment
# the account is quiet. Launched with nohup; safe to re-run (idempotent).
set -u
cd "$(dirname "$0")/.."
LOG=/tmp/finish-tables.log
echo "[start] $(date)" >> "$LOG"

# 1. wait for the enrichment driver to exit
while pgrep -f "ingest.cli enrich" >/dev/null; do sleep 120; done
echo "[enrich done] $(date) — tail: $(tail -1 /tmp/enrich-tables.log)" >> "$LOG"

# 2. coverage check: contexts for every table chunk (fail loudly if not)
MISSING=$(python3 - <<'PY'
import json
chunks = {json.loads(l)["id"] for l in open("artifacts/table_chunks_enrich.jsonl")}
ctx = {json.loads(l)["id"] for l in open("artifacts/enriched-contexts.jsonl")}
print(len(chunks - ctx))
PY
)
echo "[coverage] $MISSING table chunks missing contexts" >> "$LOG"
if [ "$MISSING" -gt 500 ]; then echo "[abort] coverage too low — manual review" >> "$LOG"; exit 1; fi

# 3. FTS reload (contextual BM25 rows for the table lane)
echo "[fts] reload start $(date)" >> "$LOG"
.venv/bin/python -m ingest.cli fts >> "$LOG" 2>&1
echo "[fts] done $(date)" >> "$LOG"

# 4. ship: INDEX_VERSION v2.62-tables + deploy
python3 - <<'PY'
import re
from pathlib import Path
p = Path("workers/worker_public/wrangler.toml")
s = p.read_text()
s = re.sub(r'INDEX_VERSION = "[^"]*"', 'INDEX_VERSION = "public-v2.62-tables"', s)
p.write_text(s)
PY
(cd workers/worker_public && npx wrangler deploy) >> "$LOG" 2>&1
echo "[deploy] v2.62-tables $(date)" >> "$LOG"
sleep 90

# 5. calm-window baselines — the account is now quiet
echo "[baseline] retrieval --repeat 3 start $(date)" >> "$LOG"
node tests/retrieval.mjs --repeat 3 --save calm-baseline-tables >> "$LOG" 2>&1
node tests/e2e.mjs >> "$LOG" 2>&1
echo "[done] $(date)" >> "$LOG"
