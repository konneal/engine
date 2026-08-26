"""Graph projection builder (Stage 6, G8): relaton-data-oiml structural
relations + Glossarist concept datasets → D1 graph tables on the public
worker. Read-only over the sibling repos; writes SQL applied via wrangler.

  .venv/bin/python -m ingest.cli graph

Edge kinds:
  part_of     hasPart / partOf / includedIn (doc ↔ doc, doc ↔ family)
  variant_of  instanceOf / hasInstance / translatedFrom (edition/language)
  successor   hasSuccessor (edition supersession chains)
  amends      amends / updates
  defines     vocab concept → source document (when the concept cites one)
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import yaml

from .config import ARTIFACTS

RELATON = Path.home() / "src/relaton/relaton-data-oiml/data"
VOCAB = Path.home() / "src/oimlsmart/vocab/datasets"
OUT = ARTIFACTS / "graph.sql"

EDGE_KIND = {
    "hasPart": "part_of",
    "partOf": "part_of",
    "includedIn": "part_of",
    "instanceOf": "variant_of",
    "hasInstance": "variant_of",
    "translatedFrom": "variant_of",
    "hasSuccessor": "successor",
    "amends": "amends",
    "updates": "amends",
}

SERIES = re.compile(r"^(OIML\s+)?([RDBGEV])\s*(\d{1,3})")


def norm_id(raw: str) -> str | None:
    """'OIML R 60-1:2017' → doc node id 'doc:OIML-R-60-1-2017'."""
    s = re.sub(r"\s*\([EFSG]\)$", "", str(raw).strip())
    s = s.replace("+Amendment", "-Amd")
    if not SERIES.match(s):
        return None
    return "doc:" + re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")


def family_of(raw: str) -> str | None:
    m = SERIES.match(str(raw))
    if not m:
        return None
    return f"family:{m.group(2)}-{m.group(3)}"


def esc(s: str) -> str:
    return s.replace("'", "''")[:200]


def build() -> int:
    nodes: dict[str, str] = {}
    edges: set[tuple[str, str, str]] = set()
    skipped = 0

    for f in sorted(RELATON.glob("*.yaml")):
        try:
            d = yaml.safe_load(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            skipped += 1
            continue
        dis = d.get("docidentifier") or []
        primary = next((x.get("content") for x in dis if x.get("primary")), None) or (
            dis[0].get("content") if dis else None
        )
        if not primary:
            skipped += 1
            continue
        node = norm_id(primary)
        if not node:
            skipped += 1
            continue
        titles = d.get("title") or []
        label = next((t.get("content") for t in titles if t.get("language") == "eng"), None) or (
            titles[0].get("content") if titles else primary
        )
        nodes[node] = f"doc|{esc(label or primary)}"

        fam = family_of(primary)
        if fam:
            nodes.setdefault(fam, "family|" + fam.split(":", 1)[1])
            edges.add((node, fam, "part_of"))

        for r in d.get("relation") or []:
            kind = EDGE_KIND.get(r.get("type"))
            if not kind:
                continue
            b = r.get("bibitem") or {}
            for di in b.get("docidentifier") or []:
                other = norm_id(di.get("content", ""))
                if other and other != node:
                    edges.add((node, other, kind))

    # vocab concepts (public projection: OIML + VIM/VIML terminology).
    # Glossarist files are multi-document YAML: the concept record carries
    # data.identifier + authoritative source refs; the localized record
    # carries terms[].designation. defines edges: source doc → concept.
    concepts = 0
    defines = 0
    for ds in ["oiml-complete", "viml-2022", "vim-2012"]:
        cdir = VOCAB / ds / "concepts"
        if not cdir.is_dir():
            continue
        for f in sorted(cdir.glob("*.yaml")):
            cid = None
            term = None
            src_doc = None
            try:
                for doc in yaml.safe_load_all(f.read_text(encoding="utf-8")):
                    if not isinstance(doc, dict):
                        continue
                    data = doc.get("data") or {}
                    cid = cid or data.get("identifier")
                    for terms in [data.get("terms") or []]:
                        if terms and not term:
                            term = terms[0].get("designation") or terms[0].get("term")
                    for src in data.get("sources") or []:
                        ref = ((src.get("origin") or {}).get("ref") or {}).get("source")
                        if ref and not src_doc:
                            src_doc = norm_id(ref)
                    for dom in data.get("domains") or []:
                        urn = str(dom.get("source", ""))
                        m2 = re.match(r"urn:oiml:pub:([a-z]):(\d+)", urn)
                        if m2 and not src_doc:
                            src_doc = f"doc:OIML-{m2.group(1).upper()}-{m2.group(2)}-LATEST"
            except Exception:  # noqa: BLE001
                continue
            if not cid:
                continue
            concepts += 1
            nodes[f"concept:{cid}"] = f"concept|{esc(str(term or cid))}"
            if src_doc and src_doc in nodes:
                edges.add((src_doc, f"concept:{cid}", "defines"))
                defines += 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as out:
        # d1 execute wraps the file atomically itself and rejects explicit
        # BEGIN/COMMIT — plain statements only
        out.write("DELETE FROM graph_nodes;\nDELETE FROM graph_edges;\n")
        node_rows = [(nid.split(":", 1)[0], label) for nid, label in nodes.items()]
        for nid, v in nodes.items():
            kind, label = v.split("|", 1)
            out.write(f"INSERT OR IGNORE INTO graph_nodes (id, kind, label) VALUES ('{nid}', '{kind}', '{label}');\n")
        for src, dst, kind in sorted(edges):
            if src in nodes and dst in nodes:
                out.write(f"INSERT OR IGNORE INTO graph_edges (src, dst, kind) VALUES ('{src}', '{dst}', '{kind}');\n")


    kept = sum(1 for s, d, k in edges if s in nodes and d in nodes)
    print(
        f"graph: {len(nodes)} nodes ({sum(1 for v in node_rows if v[0]=='doc')} docs, "
        f"{sum(1 for v in node_rows if v[0]=='family')} families, {concepts} concepts), "
        f"{kept} edges ({defines} defines), {skipped} non-publication records skipped → {OUT}"
    )
    return 0


def apply() -> int:
    if not OUT.exists():
        print("no graph.sql — run `graph` first")
        return 1
    r = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "rag-public", "--remote", "--file", str(OUT)],
        cwd=Path(__file__).resolve().parents[1] / "workers" / "worker_public",
        env={"PATH": "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin", **{}},
    )
    return r.returncode


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    sys.exit(build() if cmd == "build" else (apply() if cmd == "apply" else 2))
