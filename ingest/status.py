"""Publication status from the relaton bibliography (read-only upstream).

The bibliography (~/src/relaton/relaton-data-oiml) carries each edition's
stage — in-force / superseded / withdrawn / joint — and its successor via
`relation: hasSuccessor`. We key by "IDENT:YEAR" (e.g. "OIML R 60:2000")
to match parsed documents, defaulting to unknown.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import yaml

RELATON_DIR = Path(
    os.environ.get("OIML_RELATON_DIR", str(Path.home() / "src/relaton/relaton-data-oiml/data"))
)

_cache: dict[str, dict[str, str]] | None = None


def _norm_ident(raw: str) -> str:
    """'OIML R 60-1:2017 (E)' → 'OIML R 60-1:2017' (stable key form)."""
    s = re.sub(r"\s*\([A-Z/]+\)\s*$", "", (raw or "").strip())
    s = re.sub(r"\s+", " ", s)
    return s


def load_status_map() -> dict[str, dict[str, str]]:
    global _cache
    if _cache is not None:
        return _cache
    out: dict[str, dict[str, str]] = {}
    for f in sorted(RELATON_DIR.glob("*.yaml")):
        try:
            d = yaml.safe_load(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(d, dict):
            continue
        idents = [x.get("content", "") for x in (d.get("docidentifier") or []) if isinstance(x, dict)]
        key = _norm_ident(next((i for i in idents if i.upper().startswith("OIML")), ""))
        if not key:
            continue
        stage = ""
        st = d.get("status")
        if isinstance(st, dict):
            inner = st.get("stage")
            stage = inner.get("content", "") if isinstance(inner, dict) else str(inner or "")
        successor = ""
        for rel in d.get("relation") or []:
            if isinstance(rel, dict) and rel.get("type") == "hasSuccessor":
                bib = rel.get("bibitem") or {}
                succ = [
                    x.get("content", "")
                    for x in (bib.get("docidentifier") or [])
                    if isinstance(x, dict)
                ]
                successor = _norm_ident(next((s for s in succ if s.upper().startswith("OIML")), ""))
                if successor:
                    break
        entry = {"status": stage or "unknown", "superseded_by": successor}
        out.setdefault(key, entry)
        # part-level records sometimes omit the year on the base ident
        base = _norm_ident(key.rsplit(":", 1)[0]) if ":" in key else ""
        if base and base not in out:
            out[base] = entry
    _cache = out
    return out


def status_for(docidentifier: str, edition: str) -> dict[str, str]:
    m = load_status_map()
    base = _norm_ident(docidentifier or "")
    for key in (f"{base}:{edition}" if edition else "", base):
        if key and key in m:
            return m[key]
    return {"status": "unknown", "superseded_by": ""}
