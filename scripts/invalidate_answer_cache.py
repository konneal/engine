"""Bump the answer-cache corpus generation after corpus surgery.

The public worker's answer cache (KV: exact `a:` + semantic `sc:` entries,
6h TTL) is namespaced by INDEX_VERSION — which bumps on deploy — and by a
corpus-generation stamp (KV `sys:corpus_gen`). Deleting chunks from
D1/Vectorize touches neither, so cached answers quoting deleted text kept
serving until TTL (oimlsmart/rag#72, 2026-09-04: 32 Spanish chunks of
dirty:r79-2015-spa deleted; the exact-wording canary still drew the old
answer). This one-shot writes a fresh generation stamp; old-generation
entries simply miss and TTL out — nothing is enumerated or deleted.

Run it AFTER the live deletion (D1 + Vectorize) whenever
ingest/corpus-exclusions.yaml gains an entry or an ingest/re-index lands.
KV reads are edge-cached: allow ~60s for the bump to reach every PoP.

Usage:
    RAG_PUBLIC_KV=0f65d12cc77c41b5b91086de1c04f6da .venv/bin/python scripts/invalidate_answer_cache.py [--dry-run]
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest.cf import CF  # noqa: E402

GENERATION_KEY = "sys:corpus_gen"
# the rag-public CACHE namespace (workers/worker_public/wrangler.toml)
PRODUCTION_KV = "0f65d12cc77c41b5b91086de1c04f6da"


def new_generation(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")


def main() -> None:
    if os.environ.get("RAG_PUBLIC_KV") != PRODUCTION_KV:
        sys.exit(f"refusing to run: set RAG_PUBLIC_KV={PRODUCTION_KV} (the rag-public CACHE namespace id)")
    dry = "--dry-run" in sys.argv

    cf = CF()
    current = cf.kv_get(PRODUCTION_KV, GENERATION_KEY)
    print(f"current corpus generation: {current or '(unset — 0)'}")
    gen = new_generation()
    if dry:
        print(f"dry-run: would bump the corpus generation to {gen}")
        return
    cf.kv_put(PRODUCTION_KV, GENERATION_KEY, gen)
    print(f"corpus generation: {gen} — old-generation answer-cache entries now miss (they TTL out)")
    print("KV reads are edge-cached: allow ~60s for the bump to reach every PoP")


if __name__ == "__main__":
    main()
