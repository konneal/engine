#!/usr/bin/env python3
"""Index reconciliation (TODO.impl/40): the production Vectorize index's
id set must equal the canonical chunk set (parse output + model plane).
Upserts never delete, so ids that leave the canonical set keep serving
forever — this script enumerates the index, diffs against canonical, and
deletes the strays.

Usage:
    .venv/bin/python scripts/reconcile_index.py [--apply]

Without --apply it reports only. Auth: the wrangler OAuth token (same as
the ingest CLI's REST fallback) or CLOUDFLARE_API_TOKEN.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingest.config import ACCOUNT_ID, INDEX_NAME  # noqa: E402

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/vectorize/v2/indexes/{INDEX_NAME}"


def canonical_ids() -> set[str]:
    """Four derivations, one index: parse chunks (prose), the retrieval
    plane, the projection nodes, and the MKO unit chunks (typed
    tables/formulas/figures — the unit_id/block source for the answer
    contract)."""
    ids: set[str] = set()
    for name in ("chunks.jsonl", "model_retrieval_chunks.jsonl", "model_typed_chunks.jsonl", "mko_chunks.jsonl"):
        p = ARTIFACTS / name
        if not p.is_file():
            sys.exit(f"missing {p} — run the parse/model-plane build first")
        with p.open(encoding="utf-8") as fh:
            for line in fh:
                ids.add(json.loads(line)["id"])
    return ids


def index_ids() -> set[str]:
    """Enumerate every vector id in the index via wrangler's list-vectors
    (cursor-paginated; the raw REST route is not exposed, the CLI is)."""
    import subprocess

    out: set[str] = set()
    cursor: str | None = None
    wrangler_dir = Path(__file__).resolve().parents[1] / "workers" / "worker_public"
    env = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID}
    while True:
        cmd = ["npx", "wrangler", "vectorize", "list-vectors", INDEX_NAME, "--json"]
        if cursor:
            cmd += [f"--cursor={cursor}"]
        r = subprocess.run(cmd, cwd=wrangler_dir, capture_output=True, text=True, env=env, timeout=180)
        if r.returncode != 0:
            sys.exit(f"wrangler list-vectors failed: {r.stderr[-300:]}")
        try:
            blob = json.loads(r.stdout)
        except json.JSONDecodeError:
            sys.exit(f"unparseable list-vectors output: {r.stdout[:200]}")
        for v in blob.get("vectors", []):
            vid = v.get("id") if isinstance(v, dict) else v
            if vid:
                out.add(vid)
        cursor = blob.get("nextCursor") if blob.get("isTruncated") else None
        if not cursor:
            return out


def delete(ids: list[str]) -> int:
    """Delete via wrangler's delete-vectors CLI (OAuth path — the REST
    route intermittently 401s on the wrangler token)."""
    import subprocess

    deleted = 0
    wrangler_dir = Path(__file__).resolve().parents[1] / "workers" / "worker_public"
    env = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID}
    for i in range(0, len(ids), 100):
        batch = ids[i : i + 100]
        for attempt in range(6):
            r = subprocess.run(
                ["npx", "wrangler", "vectorize", "delete-vectors", INDEX_NAME,
                 "--ids", *batch],
                cwd=wrangler_dir, capture_output=True, text=True, env=env, timeout=180,
            )
            if r.returncode == 0:
                deleted += len(batch)
                break
            print(f"  delete retry {attempt}: {r.stderr[-160:].strip()}")
            time.sleep(min(60, 5 * (attempt + 1)))
        else:
            sys.exit(f"delete kept failing at batch {i}")
        if (i // 100) % 20 == 0:
            print(f"  deleted {deleted}/{len(ids)}", flush=True)
    return deleted


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually delete (default: report only)")
    args = ap.parse_args()

    canon = canonical_ids()
    print(f"canonical ids: {len(canon)}")
    live = index_ids()
    print(f"index ids: {len(live)}")
    stale = sorted(live - canon)
    missing = sorted(canon - live)
    print(f"stale in index (not canonical): {len(stale)}")
    for s in stale[:20]:
        print("  ", s)
    print(f"canonical but absent from index (need upsert): {len(missing)}")

    if not stale:
        print("drift: 0 — index reconciled")
        return 0
    if not args.apply:
        print("report-only; rerun with --apply to delete the strays")
        return 1
    n = delete(stale)
    print(f"deleted {n}/{len(stale)}")
    live2 = index_ids()
    drift = live2 - canon
    print(f"post-run drift: {len(drift)}")
    return 0 if not drift else 1


if __name__ == "__main__":
    sys.exit(main())
