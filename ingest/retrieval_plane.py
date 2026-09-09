"""The retrieval-export model plane (primmel/primmel-ts#65 adoption).

Derives `artifacts/model_chunks.jsonl` from `primmel export retrieval`
output instead of the smart repo's projection bundles — the canonical,
versioned serialization built for RAG consumers. What this buys over the
projection-derived chunks:

- clause anchors are the documents' own numbering via URNs (`#clause-X`),
  never producer UUIDs;
- `edition` (the publication) and `model_version` (the package) are
  distinct, canonical fields;
- every unit's flat `facet` is adapter-congruent with
  ingest/vector_adapter.py's wire schema;
- the FULL unit set (symbols, characteristics — the projection dropped
  ~23% of R 60's units).

Chunk ids keep the historical scheme (`m` + sha1(standard|unit_id)) so
units that survive unchanged between sources are hash-stable and skip
re-embedding. The D1 NODE store keeps its projection-based derivation
(`model-plane`) unchanged — chip binding and the verdict engine key on
it; this module only replaces the CHUNK (vector) source.

Usage:
  scripts/export_retrieval.sh /tmp/retrieval-export
  .venv/bin/python -m ingest.cli retrieval-plane --src /tmp/retrieval-export
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from .config import ARTIFACTS

MODEL_CHUNKS_PATH = ARTIFACTS / "model_retrieval_chunks.jsonl"

DOCTYPE = {"rec": "r", "doc": "d", "bas": "b", "gui": "g", "exp": "e", "rap": "e"}


def unit_text(standard: str, unit: dict) -> str:
    parts: list[str] = []
    name = unit.get("name")
    if isinstance(name, list):
        name = next((n.get("value") for n in name if isinstance(n, dict)), None)
    if name:
        parts.append(str(name))
    kind = str(unit.get("kind", "")).replace("_", " ").title()
    if name:
        parts[0] = f"{parts[0]} ({kind}, {standard})"
    else:
        parts.append(f"{kind} ({standard})")
    for key in ("statement", "definition"):
        v = unit.get(key)
        if isinstance(v, str) and v.strip():
            parts.append(v.strip())
    expr = unit.get("expression")
    if isinstance(expr, str) and expr.strip():
        parts.append(f"Expression: {expr.strip()}")
    acc = unit.get("acceptance_criteria") or {}
    if isinstance(acc, dict):
        d = acc.get("description")
        if isinstance(d, str) and d.strip():
            parts.append(f"Acceptance: {d.strip()}")
        lim = acc.get("limit") or {}
        if isinstance(lim, dict) and lim.get("threshold_expression"):
            parts.append(f"Limit: {lim.get('expression','')} {lim.get('operator','')} {lim.get('threshold_expression','')}")
    if not parts:
        parts.append(json.dumps({k: v for k, v in unit.items() if k in ("id", "kind")}, ensure_ascii=False))
    return "\n".join(parts)


def unit_chunk(standard: str, pkg: dict, unit: dict) -> dict:
    facet = unit.get("facet") or {}
    clause = unit.get("clause") or {}
    cid = "m" + hashlib.sha1(f"{standard}|{unit['id']}".encode()).hexdigest()[:16]
    text = unit_text(standard, unit)
    edition = str(pkg.get("edition") or facet.get("edition") or "")
    return {
        "id": cid,
        "doc_id": f"model:{standard}",
        "chunk_ref": f"{standard}{unit['id']}",
        "text": text,
        "metadata": {
            "chunk_text": text,
            "doc_id": f"model:{standard}",
            "docidentifier": str(facet.get("docidentifier") or pkg.get("title") or standard),
            "doctype": str(facet.get("doctype") or DOCTYPE.get(str(pkg.get("kind") or "rec"), "r")),
            "doc_number": str(facet.get("doc_number") or ""),
            "edition": edition,
            "model_version": str(pkg.get("model_version") or facet.get("model_version") or ""),
            "language": "en",
            "clause_anchor": str(clause.get("clause") or facet.get("clause_anchor") or "model"),
            "clause_title": f"{str(unit.get('kind','unit')).replace('_',' ').title()} — {unit.get('name') if isinstance(unit.get('name'), str) else unit['id']}",
            "tier": "curated",
            "corpus": "smart-model",
            "status": str(pkg.get("status") or "in-force"),
            "superseded_by": "",
            "text_ref": f"retrieval-export/{standard}{unit['id']}",
            "model_node": unit["id"],
            "model_kind": str(unit.get("kind") or "unit"),
            "standard": standard,
            "unit_hash": str(unit.get("content_hash") or facet.get("unit_hash") or ""),
        },
    }


def build(src: Path) -> int:
    files = sorted(src.glob("*.json"))
    if not files:
        raise SystemExit(f"no retrieval exports in {src} — run scripts/export_retrieval.sh")
    n = 0
    with MODEL_CHUNKS_PATH.open("w", encoding="utf-8") as f:
        for fp in files:
            doc = json.loads(fp.read_text(encoding="utf-8"))
            doc = doc.get("document") or doc
            standard = doc.get("package", {}).get("id") or fp.stem
            for unit in doc.get("units", []):
                if not unit.get("id"):
                    continue
                f.write(json.dumps(unit_chunk(standard, doc["package"], unit), ensure_ascii=False) + "\n")
                n += 1
    return n


def run(src: str | None, dry: bool = False) -> int:
    source = Path(src or os.environ.get("RETRIEVAL_EXPORT") or "/tmp/retrieval-export")
    n = build(source) if not dry else 0
    if dry:
        files = sorted(source.glob("*.json"))
        n = sum(len((json.loads(f.read_text()).get("document") or {}).get("units", [])) for f in files)
        print(f"[dry] retrieval-plane: {n} units from {len(files)} exports")
        return 0
    print(f"retrieval-plane: {n} model chunks → {MODEL_CHUNKS_PATH}")
    return 0
