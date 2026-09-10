#!/usr/bin/env python3
"""Restore missing vectors from local artifacts (2026-09-10).

Companion to reconcile_index.py: reconcile deletes strays, this restores
gaps. Probes the live index (mode:get, presence = id appears), then
upserts only the missing ids from chunk jsonl + embeddings, with an
exponential backoff that can ride out Vectorize rate-limit windows the
short retry ladder cannot (the 2026-09-10 restore lost 42 batches to a
sustained throttle; short retries kept failing).

Usage:
    .venv/bin/python scripts/restore_missing.py [sources...] [--batch N]

Defaults to the canonical four derivations. Python's default user-agent
gets edge-403'd by Cloudflare bot management — a UA header is mandatory.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingest.config import ARTIFACTS  # noqa: E402

BASE = "https://ai.oimlsmart.org"
DEFAULT_SOURCES = [
    ARTIFACTS / "chunks.jsonl",
    ARTIFACTS / "model_retrieval_chunks.jsonl",
    ARTIFACTS / "model_typed_chunks.jsonl",
    ARTIFACTS / "mko_chunks.jsonl",
]


def token_from_env() -> str:
    env = (Path(__file__).resolve().parents[1] / ".env").read_text()
    for line in env.splitlines():
        if line.startswith("ADMIN_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"')
    sys.exit("ADMIN_TOKEN missing from .env")


def post(token: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{BASE}/admin/vectors",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "content-type": "application/json",
            "user-agent": "oiml-ingest/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def present_ids(token: str, ids: list[str]) -> set[str]:
    found: set[str] = set()
    for i in range(0, len(ids), 100):  # route caps at 100 ids, chunks by 20 internally
        for attempt in range(6):
            try:
                got = post(token, {"mode": "get", "ids": ids[i : i + 100]}).get("vectors") or []
                found.update(v["id"] for v in got)
                break
            except Exception:  # noqa: BLE001 — transient ladder first
                time.sleep(2 * (attempt + 1))
        else:
            raise SystemExit(f"presence probe failed at offset {i}")
    return found


def upsert(token: str, vectors: list[dict]) -> None:
    backoff = 15.0
    for attempt in range(8):
        try:
            post(token, {"mode": "upsert", "vectors": vectors})
            return
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429:
                raise SystemExit(f"upsert rejected ({e.code}) — check payload")
        except Exception:  # noqa: BLE001
            pass
        time.sleep(backoff)
        backoff = min(backoff * 2, 300)  # ride out sustained throttle windows
    raise SystemExit(f"upsert failed after 8 attempts at id {vectors[0]['id']}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="*", type=Path, help="chunk jsonl files (default: canonical four)")
    ap.add_argument("--batch", type=int, default=25)
    args = ap.parse_args()
    sources = args.sources or DEFAULT_SOURCES

    token = token_from_env()
    chunks: dict[str, dict] = {}
    for src in sources:
        if not src.is_file():
            sys.exit(f"missing {src}")
        for line in src.open(encoding="utf-8"):
            c = json.loads(line)
            chunks[c["id"]] = c
    emb = {}
    for line in (ARTIFACTS / "embeddings.jsonl").open(encoding="utf-8"):
        r = json.loads(line)
        if r["id"] in chunks:
            emb[r["id"]] = r["values"]
    no_emb = [i for i in chunks if i not in emb]
    if no_emb:
        print(f"WARNING {len(no_emb)} chunks have no embedding (skipped; run embed): {no_emb[:3]}")
    todo = [i for i in chunks if i in emb]

    ids = list(todo)
    print(f"canonical: {len(chunks)} · probing presence...", flush=True)
    found = present_ids(token, ids)
    missing = [i for i in todo if i not in found]
    print(f"present: {len(found)} · missing: {len(missing)}", flush=True)
    if not missing:
        return 0

    done = 0
    for i in range(0, len(missing), args.batch):
        group = missing[i : i + args.batch]
        vectors = [
            {"id": c["id"], "values": emb[c["id"]], "metadata": chunks[c["id"]]["metadata"]}
            for c in (chunks[i] for i in group)
        ]
        upsert(token, vectors)
        done += len(group)
        if done % 250 < args.batch:
            print(f"  restored {done}/{len(missing)}", flush=True)
    print(f"RESTORED {done} missing vectors", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
