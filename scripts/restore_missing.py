#!/usr/bin/env python3
"""Restore missing vectors from local artifacts (2026-09-10).

Companion to reconcile_index.py: reconcile deletes strays, this restores
gaps. Probes the live index (mode:get, presence = id appears), then
upserts only the missing ids from chunk jsonl + embeddings. WRITES RIDE
THE REST LANE, not the worker binding: the binding 502s sustained bulk
upserts after ~1.1k vectors (2026-09-10/11 — reads never failed, writes
clamped; the REST mutation endpoint took the identical payload fine), the
same read-via-worker/write-via-REST split reconcile and the embed lane
already use.

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
from ingest.config import ARTIFACTS, CANONICAL_CHUNK_SOURCES, INDEX_NAME  # noqa: E402
from ingest.vector_adapter import wire_meta  # noqa: E402

BASE = "https://ai.oimlsmart.org"
DEFAULT_SOURCES = CANONICAL_CHUNK_SOURCES


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


def upsert_rest(rest_base: str, vectors: list[dict]) -> None:
    from ingest.cf import CF  # noqa: PLC0415 — auth is only needed when writing

    backoff = 10.0
    last: Exception | None = None
    for attempt in range(8):
        try:
            CF()._post(f"{rest_base}/upsert", {"vectors": vectors})  # own retry ladder inside
            if attempt:
                print(f"    ok after {attempt + 1} attempts", flush=True)
            return
        except Exception as e:  # noqa: BLE001
            last = e
        detail = getattr(getattr(last, "response", None), "text", "")[:300]
        print(f"    attempt {attempt + 1} failed at {vectors[0]['id']}: {type(last).__name__} {str(last)[:160]} body={detail}", flush=True)
        time.sleep(backoff)
        backoff = min(backoff * 2, 120)
    raise SystemExit(f"REST upsert failed after 8 attempts at id {vectors[0]['id']}: {last!r}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="*", type=Path, help="chunk jsonl files (default: canonical four)")
    ap.add_argument("--batch", type=int, default=25)
    ap.add_argument("--pace", type=float, default=0.0, help="sleep (s) after each successful batch — ride a rolling vectors/min quota")
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

    from ingest.cf import ACCOUNT_ID  # noqa: PLC0415

    rest_base = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/vectorize/v2/indexes/{INDEX_NAME}"

    ids = list(todo)
    print(f"canonical: {len(chunks)} · probing presence...", flush=True)
    found = present_ids(token, ids)
    missing = [i for i in todo if i not in found]
    print(f"present: {len(found)} · missing: {len(missing)}", flush=True)
    if not missing:
        return 0

    done = 0
    skipped = 0
    for i in range(0, len(missing), args.batch):
        group = missing[i : i + args.batch]
        vectors = [
            {"id": c["id"], "values": emb[c["id"]], "metadata": wire_meta(chunks[c["id"]]["metadata"])}
            for c in (chunks[i] for i in group)
        ]
        try:
            upsert_rest(rest_base, vectors)
        except SystemExit as e:
            print(f"  SKIP batch at {group[0]}: {e}", flush=True)
            skipped += len(group)
            continue
        done += len(group)
        if args.pace:
            time.sleep(args.pace)
        if done % 250 < args.batch:
            print(f"  restored {done}/{len(missing)}", flush=True)
    print(f"RESTORED {done}/{len(missing)} · skipped {skipped} (rerun to pick them up)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
