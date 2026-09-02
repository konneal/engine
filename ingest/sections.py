"""Section-summary units (FABLE/BEAR multi-granularity, arXiv:2601.18116).

The corpus's clause chunks start at depth 2 ("3.1") — the clause tree has
no depth-1 nodes. This driver builds depth-1 unit specs from
artifacts/chunks.jsonl and feeds them to the deployed /admin/section
endpoint, which generates each section summary (quality-first lane,
KV-cached per unit id — re-runs are free), embeds it toc-path ⊕ summary
style, and upserts the navigation node into the production index. Serving
descends from a ranked section unit to its quotable child clauses
(pipeline.ts "section descent").

  artifacts/section_units.jsonl  every unit spec built this run

Usage:
  .venv/bin/python -m ingest.cli sections --docs "R 76-1,R 79"   # families
  .venv/bin/python -m ingest.cli sections --limit 200            # first N
  .venv/bin/python -m ingest.cli sections --dry                  # specs only

Requires ADMIN_TOKEN in .env.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import httpx

from .config import ARTIFACTS

CHUNKS_PATH = Path(os.environ.get("SECTIONS_SOURCE", ARTIFACTS / "chunks.jsonl"))
UNITS_PATH = ARTIFACTS / "section_units.jsonl"

DOC_FIELDS = (
    "doc_id",
    "docidentifier",
    "doctype",
    "doc_number",
    "edition",
    "language",
    "tier",
    "corpus",
    "status",
    "superseded_by",
)


def _dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return out


def _anchor_key(anchor: str) -> tuple[int, ...]:
    try:
        return tuple(int(p) for p in anchor.split("."))
    except ValueError:
        return (10**9,)


def build_specs(docs: list[str] | None = None, limit: int | None = None) -> list[dict]:
    """One unit per doc per depth-1 clause that has ≥2 distinct children."""
    want = [d.strip().lower() for d in docs or [] if d.strip()]
    per_doc: dict[str, dict[str, dict]] = {}
    doc_meta: dict[str, dict] = {}
    with CHUNKS_PATH.open() as f:
        for line in f:
            r = json.loads(line)
            md = r["metadata"]
            if md.get("corpus") == "synthetic":
                continue
            anchor = str(md.get("clause_anchor", ""))
            if not anchor or not anchor.replace(".", "").isdigit() or "." not in anchor:
                continue
            doc = md["doc_id"]
            ident = md.get("docidentifier", "").lower().replace("oiml ", "")
            if want and not any(ident.startswith(w) or md.get("doc_number", "").lower().startswith(w) for w in want):
                continue
            doc_meta.setdefault(doc, {k: md.get(k) for k in DOC_FIELDS if md.get(k) is not None})
            per_doc.setdefault(doc, {}).setdefault(anchor, {"title": md.get("clause_title", ""), "excerpt": r["text"]})

    specs: list[dict] = []
    for doc, children in per_doc.items():
        roots: dict[str, list[str]] = {}
        for anchor in children:
            root = anchor.split(".")[0]
            roots.setdefault(root, []).append(anchor)
        for root, anchors in roots.items():
            if len(anchors) < 2:
                continue
            ordered = sorted(anchors, key=_anchor_key)[:12]
            m = dict(doc_meta[doc])
            m["clause_anchor"] = root
            specs.append(
                {
                    "id": f"sec-{doc.replace('/', '_')}-{root}",
                    "metadata": m,
                    "children": [
                        {
                            "anchor": a,
                            "title": children[a]["title"],
                            "excerpt": children[a]["excerpt"][:300],
                        }
                        for a in ordered
                    ],
                }
            )
            if limit and len(specs) >= limit:
                return specs
    return specs


def run(docs: list[str] | None = None, limit: int | None = None, batch: int = 6, dry: bool = False) -> int:
    env = {**os.environ, **_dotenv(ARTIFACTS.parent / ".env")}
    specs = build_specs(docs, limit)
    if not specs:
        print("sections: no units to build (no depth-1 clause with ≥2 children matched)")
        return 1

    with UNITS_PATH.open("w", encoding="utf-8") as fh:
        for s in specs:
            fh.write(json.dumps(s, ensure_ascii=False) + "\n")
    print(f"sections: {len(specs)} unit specs → {UNITS_PATH}")
    if dry:
        return 0

    base = env.get("RAG_BASE", "https://ai.oimlsmart.org").rstrip("/")
    token = env.get("ADMIN_TOKEN")
    if not token:
        print("ADMIN_TOKEN missing (set it in .env)")
        return 1

    ok = fail = 0
    with httpx.Client(timeout=300) as client:
        for i in range(0, len(specs), min(batch, 6)):
            chunk = specs[i : i + min(batch, 6)]
            try:
                res = client.post(
                    f"{base}/admin/section",
                    headers={"authorization": f"Bearer {token}", "user-agent": "oiml-section-indexer/1.0"},
                    json={"units": chunk},
                )
                body = res.json()
                results = body.get("results", [])
                for u, r in zip(chunk, results):
                    if r.get("ok"):
                        ok += 1
                    else:
                        fail += 1
                        print(f"  FAIL {u['id']}: {r.get('error')}")
                usage = body.get("usage", {})
                print(f"  {min(i + len(chunk), len(specs))}/{len(specs)} (ok={ok} fail={fail} gen={usage.get('requests', 0)} cached={usage.get('cache_hits', 0)})", flush=True)
            except Exception as e:  # noqa: BLE001
                fail += len(chunk)
                print(f"  batch FAIL: {e}")
            time.sleep(1)
    print(f"[sections] DONE: {ok}/{len(specs)} upserted, {fail} failed")
    return 0 if fail == 0 else 1
