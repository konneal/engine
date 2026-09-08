#!/usr/bin/env python3
"""Index all 5 comparison lanes (TODO.model-rag).

For each lane: enrich (via /admin/enrich — contexts KV-cached), embed
(via /admin/enrich's embed, or /admin/vectors embed mode), and upsert
to the correct idx_exp_* Vectorize index.

Usage:
  .venv/bin/python scripts/index_comparison_lanes.py --lane primmel
  .venv/bin/python scripts/index_comparison_lanes.py --all
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingest.vector_adapter import normalize_chunk  # noqa: E402

# script lane name → adapter target (the index the corpus belongs to)
ADAPTER_TARGET = {
    "plain": "exp_plain",
    "adoc": "exp_adoc",
    "mko": "exp_mko",
    "primmel": "primmel",
    "primmel_flat": "primmel_flat",
    "composed": "exp_composed",
}

BASE = os.environ.get("BASE_URL", "https://ai.oimlsmart.org")
ADMIN = os.environ.get("ADMIN_TOKEN", "")
if not ADMIN:
    from pathlib import Path as P
    env = P(".env")
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("ADMIN_TOKEN="):
                ADMIN = line.split("=", 1)[1].strip()
                break

if not ADMIN:
    raise SystemExit("ADMIN_TOKEN required (env or .env)")

ARTIFACTS = Path("artifacts")
LANES = {
    "plain": ("exp_plain_chunks.jsonl", "idx_exp_plain"),
    "adoc": ("exp_adoc_chunks.jsonl", "idx_exp_adoc"),
    "mko": ("exp_mko_chunks.jsonl", "idx_exp_mko"),
    "primmel": ("primmel_chunks.jsonl", "idx_exp_primmel"),
    "primmel_flat": ("primmel_flat_chunks.jsonl", "idx_exp_primmel_flat"),
    "composed": ("exp_composed_chunks.jsonl", "idx_exp_composed"),
}


def api(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {ADMIN}", "content-type": "application/json",
                 "User-Agent": "oiml-lane-indexer/1.0"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def enrich_chunks(chunks: list[dict], lane: str) -> list[dict]:
    """Generate situating preambles via /admin/enrich mode:"context" —
    context ONLY, never an upsert: this endpoint's default mode writes the
    enriched chunk into the PRODUCTION index, which is how 1,126 lane
    vectors leaked there on 2026-09-02. Lane chunks are embedded and
    upserted into THEIR OWN index in embed_and_upsert below."""
    enriched = []
    batch = 6
    total = len(chunks)
    ok = fail = 0
    for i in range(0, total, batch):
        b = chunks[i : i + batch]
        try:
            res = api("/admin/enrich", {"mode": "context", "chunks": [
                {"id": c["id"], "text": c["text"][:1500], "metadata": c["metadata"]}
                for c in b
            ]})
            results = res.get("results", [])
            for r in results:
                if r.get("ok"):
                    ok += 1
                    ctx = r.get("context", "")
                    cid = r["id"]
                    for c in b:
                        if c["id"] == cid:
                            enriched_text = f"{ctx}\n\n{c['text']}"[:6000]
                            enriched.append({**c, "enriched_text": enriched_text})
                            break
                else:
                    fail += 1
                    print(f"  enrich FAIL {r.get('id')}: {r.get('error', '?')[:80]}")
        except Exception as e:
            fail += len(b)
            print(f"  enrich batch FAIL: {str(e)[:100]}")
        print(f"  enrich {min(i + batch, total)}/{total} (ok={ok} fail={fail})", flush=True)
        time.sleep(18)  # respect AI rate limits
    return enriched


def embed_and_upsert(enriched: list[dict], index_name: str, lane: str):
    """Embed via /admin/vectors embed mode, then upsert via Vectorize REST."""

    total = len(enriched)
    upserted = 0
    for i in range(0, total, 8):
        batch = enriched[i : i + 8]
        texts = [c["enriched_text"] for c in batch]
        try:
            res = api("/admin/vectors", {"mode": "embed", "texts": texts})
            vectors = res.get("vectors", [])
            if len(vectors) != len(batch):
                print(f"  embed mismatch: {len(vectors)} vectors for {len(batch)} chunks")
                continue

            # build the upsert payload THROUGH the adapter — the single
            # boundary that enforces corpus vocabulary, metadata size,
            # anchor sanity, and the target-index guard (a chunk foreign
            # to this lane's index refuses here, never at the wire)
            vs = []
            for c, v in zip(batch, vectors):
                md = dict(c["metadata"])
                md["chunk_text"] = c["enriched_text"]
                md["ctx"] = "1"
                vs.append(normalize_chunk({"id": c["id"], "text": c["enriched_text"], "metadata": md}, target=ADAPTER_TARGET[lane]).upsert(v, target=ADAPTER_TARGET[lane]))

            # upsert via Vectorize REST (the token has vectorize scope)
            token = os.environ.get("API_TOKEN", "")
            if not token:
                for line in Path.home().joinpath(".cloudflare-credentials-oimlsmart").read_text().splitlines():
                    if line.startswith("export API_TOKEN="):
                        token = line.split("=", 1)[1].strip()
                        break
            account = "06cad8ae9a017c856ab496c6bca9a9d8"
            req = urllib.request.Request(
                f"https://api.cloudflare.com/client/v4/accounts/{account}/vectorize/v2/indexes/{index_name}/upsert",
                data=json.dumps({"vectors": vs}).encode(),
                headers={"Authorization": f"Bearer {token}", "content-type": "application/json",
                         "User-Agent": "oiml-lane-indexer/1.0"},
            )
            with urllib.request.urlopen(req, timeout=60):
                upserted += len(vs)
        except Exception as e:
            print(f"  upsert batch FAIL at {i}: {str(e)[:120]}")
        print(f"  upsert {min(i + 8, total)}/{total} (done={upserted})", flush=True)
        time.sleep(3)
    return upserted


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lane", default=None)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--skip-enrich", action="store_true", help="reuse cached contexts only")
    args = ap.parse_args()

    targets = list(LANES.keys()) if args.all else ([args.lane] if args.lane else [])
    if not targets:
        ap.error("specify --lane <name> or --all")

    for lane in targets:
        artifact_name, index_name = LANES[lane]
        artifact = ARTIFACTS / artifact_name
        if not artifact.exists():
            print(f"[{lane}] SKIP — no artifact {artifact_name}")
            continue

        chunks = [json.loads(l) for l in artifact.open() if l.strip()]
        print(f"\n[{lane}] {len(chunks)} chunks → {index_name}")

        if args.skip_enrich:
            # just use the raw text (no enrichment — for the ablation)
            enriched = [{**c, "enriched_text": c["text"][:6000]} for c in chunks]
        else:
            enriched = enrich_chunks(chunks, lane)

        if enriched:
            n = embed_and_upsert(enriched, index_name, lane)
            print(f"[{lane}] DONE: {n}/{len(chunks)} upserted to {index_name}")
        else:
            print(f"[{lane}] NO ENRICHED CHUNKS — enrichment failed")


if __name__ == "__main__":
    main()
