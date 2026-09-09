#!/usr/bin/env python3
"""Enrichment replay (2026-09-09): any full index upsert from local
artifacts (ingest.cli upsert) overwrites in-place contextual enrichment
with raw-text vectors + chunk_text — enrichment lives ONLY in the index
and the KV context cache. The durable record (artifacts/
enriched-contexts.jsonl, written by the enrich driver) lets a restore
replay every recorded context with ZERO model generation: embed the
context+text composite via the binding (/admin/vectors mode:"embed",
the same embedding model the index already uses) and upsert with
ctx:"1" metadata — exactly the shape /admin/enrich writes.

Run this after every full-restore upsert, BEFORE the promotion gate.

Usage:
    .venv/bin/python scripts/replay_enrichment.py [--apply]
    [--source FILE]...   # extra chunk jsonl files (defaults: chunks +
                         # model_retrieval_chunks + model_typed_chunks)

Without --apply: report only (coverage + what would be replayed).
Auth: ADMIN_TOKEN from .env, same as the enrich driver.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingest.config import ARTIFACTS  # noqa: E402

BASE = os.environ.get("BASE_URL", "https://ai.oimlsmart.org")
RECORDS = ARTIFACTS / "enriched-contexts.jsonl"
DEFAULT_SOURCES = [
    ARTIFACTS / "chunks.jsonl",
    ARTIFACTS / "model_retrieval_chunks.jsonl",
    ARTIFACTS / "model_typed_chunks.jsonl",
]
# /admin/enrich's own composite formula and caps — the replay must be
# byte-identical to what a cache-hit enrich run would have upserted
EMBED_CAP = 6000


def token_from_env() -> str:
    env = (Path(__file__).resolve().parents[1] / ".env").read_text()
    for line in env.splitlines():
        if line.startswith("ADMIN_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"')
    sys.exit("ADMIN_TOKEN missing from .env")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="embed + upsert (default: report only)")
    ap.add_argument("--source", action="append", type=Path, help="chunk jsonl to replay (repeatable)")
    args = ap.parse_args()

    contexts: dict[str, str] = {}
    for line in RECORDS.open(encoding="utf-8"):
        d = json.loads(line)
        contexts[d["id"]] = d["context"]
    print(f"recorded contexts: {len(contexts)}")

    chunks: list[dict] = []
    for src in args.source or DEFAULT_SOURCES:
        if src.is_file():
            n = 0
            for line in src.open(encoding="utf-8"):
                chunks.append(json.loads(line))
                n += 1
            print(f"  {src.name}: {n}")
        else:
            print(f"  {src.name}: absent — skipped")

    # synthetic (authored overview) chunks already carry situating text;
    # the enrich driver never touched them
    replayable = [
        c for c in chunks
        if c["id"] in contexts and c.get("metadata", {}).get("corpus") != "synthetic"
    ]
    uncovered = [
        c for c in chunks
        if c["id"] not in contexts and c.get("metadata", {}).get("corpus") != "synthetic"
    ]
    print(f"chunks: {len(chunks)} · replayable: {len(replayable)} · no recorded context: {len(uncovered)} (stay raw)")

    if not args.apply:
        print("report-only; rerun with --apply to replay")
        return 0

    token = token_from_env()
    # the ingest CLI's own REST embed lane: 100-text batches beat the
    # worker's serial 16-per-request binding loop ~6x, with the same
    # model and shape-probing; upserts ride the admin binding (fast)
    from ingest.cf import CF  # noqa: PLC0415

    cf = CF()
    admin = httpx.Client(
        base_url=BASE,
        headers={"Authorization": f"Bearer {token}"},
        timeout=httpx.Timeout(180.0),
    )
    batch = 24  # the REST ai/run lane rejects larger embed payloads (400)

    groups = [replayable[i : i + batch] for i in range(0, len(replayable), batch)]

    def embed_group(group: list[dict]) -> list[list[float]]:
        # /admin/enrich embeds the composite sliced to 6000 chars — mirror
        texts = [f"{contexts[c['id']]}\n\n{c['text']}"[:EMBED_CAP] for c in group]
        for attempt in range(5):
            try:
                return cf.embed(texts)
            except Exception:  # noqa: BLE001 — transient ladder first
                time.sleep(3 * (attempt + 1))
        # batch persistently rejected: bisect — embed one-by-one so one
        # bad text never aborts the replay
        out: list[list[float]] = []
        for t in texts:
            for attempt in range(5):
                try:
                    out.extend(cf.embed([t]))
                    break
                except Exception:
                    time.sleep(2 * (attempt + 1))
            else:
                raise SystemExit(f"embed failed even alone: {t[:80]}")
        return out

    def upsert_group(args: tuple[list[dict], list[list[float]]]) -> None:
        group, vecs = args
        vectors = [
            {
                "id": c["id"],
                "values": v,
                "metadata": {**c["metadata"], "chunk_text": t, "ctx": "1"},
            }
            for c, t, v in zip(group, [f"{contexts[c['id']]}\n\n{c['text']}" for c in group], vecs, strict=True)
        ]
        for attempt in range(5):
            try:
                r = admin.post("/admin/vectors", json={"mode": "upsert", "vectors": vectors})
                r.raise_for_status()
                return
            except Exception as e:  # noqa: BLE001
                if attempt == 4:
                    raise SystemExit(f"upsert failed at id {group[0]['id']}: {e}")
                time.sleep(3 * (attempt + 1))

    from concurrent.futures import ThreadPoolExecutor  # noqa: PLC0415

    done = 0
    with ThreadPoolExecutor(max_workers=12) as pool:
        for result in pool.map(upsert_group, zip(groups, pool.map(embed_group, groups), strict=True)):
            done += batch
            if done % 2000 < batch:
                print(f"  replayed ~{min(done, len(replayable))}/{len(replayable)}", flush=True)
    print(f"replayed {len(replayable)}/{len(replayable)} — enrichment restored (contexts from the durable record)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
