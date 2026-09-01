# ARCHIVED 2026-09-01: the embedding-smoothing experiment (G-ETSI-4,
# arXiv 2409.04737-informed) measured inconclusive at our eval power and
# was rolled back from production. Kept for the next attempt; see
# artifacts/eval/retrieval-smooth-a075.json for the numbers that stopped it.

"""Embedding smoothing over the section graph (G-ETSI-4, arXiv:2604.09868
eq. 10): blend each MKO chunk's vector with the mean of its structural
neighbors — parent section, child sections, sibling sections — via the
worker's /admin/vectors binding endpoint (the binding is the credential).

  .venv/bin/python scripts/smooth_mko.py --alpha 0.75          # live A/B
  .venv/bin/python scripts/smooth_mko.py --rollback FILE       # restore

Backup: artifacts/vectors-backup-<ts>.jsonl holds the pre-smoothing
vectors; rollback re-upserts them verbatim. Metadata is normalized on
upsert (corpus oiml, tier curated, producer mko).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
BUNDLES = Path("/tmp/mko-bundles")
BASE = "https://ai.oimlsmart.org"
BATCH = 20  # Vectorize getByIds caps at 20 ids; upsert payloads go via @file


def _env_admin() -> str:
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("ADMIN_TOKEN="):
            return line.partition("=")[2].strip()
    raise SystemExit("ADMIN_TOKEN not in .env")


ADMIN = _env_admin()


def api(payload: dict, attempts: int = 4) -> dict:
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
        json.dump(payload, tf)
        payload_path = tf.name
    for a in range(attempts):
        r = subprocess.run(
            ["curl", "-sS", "-X", "POST", f"{BASE}/admin/vectors",
             "-H", f"authorization: Bearer {ADMIN}",
             "-H", "content-type: application/json",
             "-d", f"@{payload_path}"],
            capture_output=True, text=True, timeout=180,
        )
        try:
            d = json.loads(r.stdout)
            if "error" not in d:
                return d
        except json.JSONDecodeError:
            pass
        time.sleep(3 * (a + 1))
    raise SystemExit(f"admin/vectors failed after {attempts} attempts: {r.stdout[:200]}")


def fetch_vectors(ids: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for i in range(0, len(ids), BATCH):
        batch = ids[i : i + BATCH]
        d = api({"mode": "get", "ids": batch})
        for v in d.get("vectors", []):
            out[v["id"]] = v
        print(f"  fetched {min(i + BATCH, len(ids))}/{len(ids)}", flush=True)
    return out


def normalize_meta(md: dict) -> dict:
    md = dict(md or {})
    md["corpus"] = "oiml"
    md["tier"] = "curated"
    md["producer"] = "mko"
    return {k: v for k, v in md.items() if isinstance(v, (str, int, float, bool))}


def upsert_vectors(vectors: list[dict]) -> None:
    for i in range(0, len(vectors), BATCH):
        api({"mode": "upsert", "vectors": vectors[i : i + BATCH]})
        print(f"  upserted {min(i + BATCH, len(vectors))}/{len(vectors)}", flush=True)


def unit_neighbors_map() -> dict[str, list[str]]:
    """unit_id → neighbor unit_ids (parent ∪ children ∪ siblings), all docs."""
    parent: dict[str, str] = {}
    children: dict[str, list[str]] = {}
    for bundle in sorted(BUNDLES.glob("*.mko")):
        units_file = bundle / "units.jsonl"
        if not units_file.exists():
            continue
        for line in units_file.read_text(encoding="utf-8").splitlines():
            u = json.loads(line)
            uid = u["id"]
            if u.get("parent"):
                parent[uid] = u["parent"]
                children.setdefault(u["parent"], []).append(uid)
    neighbors: dict[str, list[str]] = {}
    for uid, par in parent.items():
        n = {par} | set(children.get(par, [])) | set(children.get(uid, []))
        n.discard(uid)
        neighbors[uid] = sorted(n)
    return neighbors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--alpha", type=float, default=0.75)
    ap.add_argument("--iters", type=int, default=1)
    ap.add_argument("--rollback", type=str, default=None, help="backup file to restore")
    args = ap.parse_args()

    chunks = [json.loads(l) for l in (ARTIFACTS / "mko_chunks.jsonl").open(encoding="utf-8")]
    ids = [c["id"] for c in chunks]

    if args.rollback:
        backup = [json.loads(l) for l in Path(args.rollback).open(encoding="utf-8")]
        print(f"rollback: restoring {len(backup)} vectors from {args.rollback}")
        upsert_vectors(backup)
        print("rollback complete")
        return 0

    print(f"smoothing: {len(chunks)} chunks, α={args.alpha}, iters={args.iters}")
    live = fetch_vectors(ids)
    missing = [i for i in ids if i not in live]
    if missing:
        raise SystemExit(f"{len(missing)} chunks have no live vector — wire first (e.g. {missing[:3]})")

    backup_path = ARTIFACTS / f"vectors-backup-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    with backup_path.open("w", encoding="utf-8") as f:
        for i in ids:
            v = live[i]
            f.write(json.dumps({"id": i, "values": v["values"], "metadata": v.get("metadata")}) + "\n")
    print(f"backup: {backup_path}")

    neighbors = unit_neighbors_map()
    unit_of = {c["id"]: (c["metadata"].get("unit_id") or "") for c in chunks}
    # chunk neighbors = chunks whose unit is a structural neighbor of mine
    chunks_by_unit: dict[str, list[str]] = {}
    for c in chunks:
        u = unit_of[c["id"]]
        if u:
            chunks_by_unit.setdefault(u, []).append(c["id"])
    neighbor_chunks: dict[str, list[str]] = {}
    for cid, u in unit_of.items():
        if not u:
            continue
        nb_ids: list[str] = []
        for nu in neighbors.get(u, []):
            nb_ids.extend(chunks_by_unit.get(nu, []))
        neighbor_chunks[cid] = nb_ids
    coverage = sum(1 for c in ids if neighbor_chunks.get(c))
    print(f"neighbor coverage: {coverage}/{len(ids)} chunks have structural neighbors")

    vectors = {i: live[i]["values"] for i in ids}
    for it in range(args.iters):
        new: dict[str, list[float]] = {}
        for cid in ids:
            v = vectors[cid]
            nbs = [vectors[n] for n in neighbor_chunks.get(cid, []) if n in vectors]
            if not nbs:
                new[cid] = v
                continue
            dim = len(v)
            mean = [sum(col) / len(nbs) for col in zip(*nbs)]
            new[cid] = [args.alpha * v[k] + (1 - args.alpha) * mean[k] for k in range(dim)]
        vectors = new
        print(f"  iteration {it + 1} done")

    out = [{"id": i, "values": vectors[i], "metadata": normalize_meta(live[i].get("metadata"))} for i in ids]
    smooth_path = ARTIFACTS / "vectors-smoothed.jsonl"
    smooth_path.write_text("\n".join(json.dumps(v) for v in out) + "\n", encoding="utf-8")
    upsert_vectors(out)
    print("smoothed vectors live. NEXT: node tests/retrieval.mjs --save smooth-a{args.alpha}; "
          f"regression → rollback: scripts/smooth_mko.py --rollback {backup_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
