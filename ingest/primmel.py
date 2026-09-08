"""Primmel projector (TODO.model-rag/01): the document-as-model lane.

Reads a Primmel model directory (smart/data/<std>/) and projects it into
the RAG record shapes — the same contracts MKO feeds, plus the frontier
unit types (calculation, constraint, sequence, note, aspect, behavior,
schema). Every chunk carries its provenance URN (urn#clause); typed
payloads go to unit_payloads; references/uses/supersession become graph
edges. Entities: TYPE classes project as schema units; INSTANCES are
skipped (sample/public gating happens upstream of any future enable).

  .venv/bin/python -m ingest.cli primmel --src ~/src/oimlsmart/smart/data/r60
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import yaml


DOCIDENTIFIER = "OIML R 60:2021"
DOC_NUMBER = "60"
EDITION = "2021"
BASE_URN = "urn:oiml:pub:r:60:2021"


def _load(path: Path):
    if not path.is_file():
        return None
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _txt(spelling) -> str:
    """localized [{spelling: {value}}] → plain text."""
    if isinstance(spelling, list):
        return " ".join(str(e.get("value", "")).strip() for e in spelling if isinstance(e, dict)).strip()
    return str(spelling or "").strip()


def _uid(kind: str, key: str) -> str:
    return "u:" + kind[0] + hashlib.sha1(f"{BASE_URN}|{kind}|{key}".encode()).hexdigest()[:12]


def _unit(kind: str, key: str, title: str, body: str, clause: str, payload: dict | None = None) -> dict:
    unit_id = _uid(kind, key)
    text = f"{DOCIDENTIFIER} ({EDITION}) — {title}\n{clause and f'[{clause}] ' or ''}{body}".strip()
    meta = {
        "chunk_text": text[:2800],
        "doc_id": "oiml-r60-2021",
        "docidentifier": DOCIDENTIFIER,
        "doctype": "R",
        "doc_number": DOC_NUMBER,
        "edition": EDITION,
        "language": "en",
        "clause_anchor": clause or "",
        "clause_title": title[:200],
        "block": kind,
        "tier": "curated",
        "corpus": "primmel",
        "producer": "primmel",
        "status": "in-force",
        "text_ref": f"{BASE_URN}#{clause or key}",
        "unit_id": unit_id,
    }
    rec = {
        "id": "p" + hashlib.sha1(f"{BASE_URN}|{kind}|{key}".encode()).hexdigest()[:16],
        "doc_id": "oiml-r60-2021",
        "chunk_ref": f"{DOCIDENTIFIER} {title} ({kind})",
        "text": text,
        "metadata": meta,
    }
    if payload is not None:
        rec["payload"] = {"unit_id": unit_id, "type": kind, "payload": payload}
    return rec


def project(src: Path) -> dict:
    chunks: list[dict] = []
    payloads: list[str] = []
    edges: list[tuple[str, str, str]] = []
    glossary: list[dict] = []
    counts: dict[str, int] = {}

    def emit(rec: dict):
        chunks.append(rec)
        if "payload" in rec:
            p = rec["payload"]
            esc = json.dumps(p["payload"]).replace("'", "''")
            payloads.append(
                f"INSERT OR REPLACE INTO unit_payloads (unit_id, doc_id, docidentifier, type, payload) VALUES "
                f"('{p['unit_id']}', 'oiml-r60-2021', '{DOCIDENTIFIER}', '{p['type']}', '{esc}');"
            )
        counts[rec["metadata"]["block"]] = counts.get(rec["metadata"]["block"], 0) + 1

    # terminology → glossary + term units
    terms = (_load(src / "terminology.yaml") or {}).get("terms", [])
    for t in terms:
        term = _txt(t.get("term")) or t.get("id")
        definition = _txt(t.get("definition"))
        vocab = t.get("vocab_ref") or {}
        clause = str(t.get("section") or "")
        body = definition + (f" [{vocab.get('register')} {vocab.get('clause')}]" if vocab else "")
        emit(_unit("term", t["id"], term, body, clause,
                   {"id": t["id"], "definition": definition, "vocab_ref": vocab, "sources": t.get("source", [])}))
        glossary.append({"id": t["id"], "term": term, "definition": definition, "clause": clause})
        for s in t.get("source", []):
            edges.append((f"term:{t['id']}", "defines_at", s))

    # attributes → typed term units
    for a in (_load(src / "model" / "attributes.yaml") or {}).get("attribute_definitions", []):
        name = _txt(a.get("name"))
        definition = _txt(a.get("definition"))
        srcu = a.get("source")
        srcu = srcu if isinstance(srcu, dict) else {}
        clause = str(srcu.get("clause") or "")
        body = (f"{definition} Typed: {a.get('value_type')}"
                + (f", enum {a.get('enum')}" if a.get("enum") else "")
                + f". Scope: {a.get('scope')}, origin: {a.get('origin')}.")
        emit(_unit("attribute", a["id"], name, body, clause,
                   {"id": a["id"], "value_type": a.get("value_type"), "enum": a.get("enum"),
                    "origin": a.get("origin"), "scope": a.get("scope"), "is_dimension": a.get("is_dimension"),
                    "source_urn": srcu.get("doc", "") + (f"#{clause}" if clause else "")}))

    # aspects / behaviors → registry units
    for path, kind in ((src / "model" / "aspects.yaml", "aspect"), (src / "model" / "behaviors.yaml", "behavior")):
        data = _load(path) or {}
        items = data.get("aspects") or data.get("behaviors") or []
        for it in items:
            if not isinstance(it, dict) or not it.get("id"):
                continue
            title = it.get("id").replace("_", " ")
            body = _txt(it.get("response")) or _txt(it.get("description")) or title
            if it.get("stimulus"):
                body = f"Stimulus: {it['stimulus']}. Response: {body}"
            emit(_unit(kind, it["id"], title, body, str(it.get("source", {}).get("clause", "") if isinstance(it.get("source"), dict) else ""),
                       {k: it.get(k) for k in ("id", "kind", "stimulus") if k in it}))

    # formulas (operator signature) / calculations (typed IO) / constraints (OCL)
    for f in (_load(src / "specification" / "formulas.yaml") or {}).get("formulas", []):
        label = _txt(f.get("label")) or f["name"]
        _src = f.get("source")
        clause = str((_src.get("clause") if isinstance(_src, dict) else "") or "")
        body = f"{_txt(f.get('description'))} Operator: {f.get('type')}" + (f"({', '.join(f.get('params', []))})" if f.get("params") else "")
        emit(_unit("formula", f["name"], label, body, clause,
                   {"name": f["name"], "type": f.get("type"), "params": f.get("params", []),
                    "expression": f.get("expression"), "description": _txt(f.get("description"))}))
    for c in (_load(src / "specification" / "calculations.yaml") or {}).get("calculations", []):
        _src = c.get("source")
        clause = str((_src.get("clause") if isinstance(_src, dict) else "") or "")
        inputs = "; ".join(f"{i['name']}({i.get('type')}{' ' + i.get('unit', '') if i.get('unit') else ''})" for i in c.get("inputs", []))
        body = f"{_txt(c.get('description'))}. Inputs: {inputs or '—'}."
        emit(_unit("calculation", c["identifier"], c["name"], body, clause,
                   {"identifier": c["identifier"], "inputs": c.get("inputs", []), "reference": c.get("reference")}))
    for k in (_load(src / "specification" / "constraints.yaml") or {}).get("constraints", []):
        _src = k.get("source")
        clause = str((_src.get("clause") if isinstance(_src, dict) else "") or "")
        body = f"{_txt(k.get('violation_meaning'))} Check: {k.get('check')}. On violation: {k.get('on_violation')}."
        emit(_unit("constraint", k["id"], _txt(k.get("name")) or k["id"], body, clause,
                   {"id": k["id"], "check": k.get("check"), "violation_meaning": _txt(k.get("violation_meaning")),
                    "on_violation": k.get("on_violation")}))

    # tables (typed columns) / test sequences (ordered) / notes (overrides)
    for t in (_load(src / "specification" / "tables.yaml") or {}).get("tables", []):
        cols = ", ".join(f"{c['name']}:{c.get('type')}" + (f"[{c.get('unit')}]" if c.get("unit") else "") for c in t.get("columns", []))
        body = f"{_txt(t.get('description'))}. Columns: {cols}."
        emit(_unit("table", t["id"], t["id"], body, "",
                   {"id": t["id"], "columns": t.get("columns", []), "rows": t.get("rows", [])}))
    for sq in (_load(src / "specification" / "test-sequences.yaml") or {}).get("test_sequences", []):
        steps = "; ".join(
            f"{st['order']}. " + str(st.get("test") or st.get("phase") or st.get("name") or "")
            + (f" ({st['role']})" if st.get("role") else "")
            for st in sq.get("steps", []) if isinstance(st, dict)
        )
        body = f"{_txt(sq.get('description'))} Order: {steps}."
        emit(_unit("sequence", sq["id"], _txt(sq.get("name")) or sq["id"], body, "",
                   {"id": sq["id"], "steps": sq.get("steps", [])}))
    for n in (_load(src / "notes.yaml") or {}).get("notes", []):
        emit(_unit("note", n["id"], n.get("type", "NOTE"), n.get("message", ""), "",
                   {"id": n["id"], "type": n.get("type"), "message": n.get("message")}))

    # references → cites edges; standard lifecycle → graph; composition → edges
    for r in (_load(src / "references.yaml") or {}).get("references", []):
        edges.append((f"{DOCIDENTIFIER}#{r.get('clause', '')}", "cites", f"{r.get('document')}#{r.get('clause', '')}"))
    std = _load(src / "standard.yaml") or {}
    for sup in (std.get("edition", {}) or {}).get("supersedes", []):
        edges.append((BASE_URN, "superseded_by", sup))
    for use in std.get("uses", []) or []:
        edges.append((BASE_URN, "composes", use))

    return {"chunks": chunks, "payloads": payloads, "edges": edges, "glossary": glossary, "counts": counts}
