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
  cites       bibliography references (extracted from the indexed
              bibliography chunks; the citation grammar is the profile
              codec's — the same identifier grammar the pipeline uses)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml

from .codecs import codec_for_profile
from .config import ARTIFACTS, CANONICAL_CHUNK_SOURCES

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

SERIES = re.compile(r"^(OIML\s+)?([RDBGEVS])\s*(\d{1,3})")


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


def bibliography_chunks():
    """(docidentifier, edition, text) of the canonical chunk set's
    bibliography sections — normative references and bibliographies,
    wherever the producer marked them by clause title (or the text head
    carries the word when the title did not survive the corpus)."""
    for p in CANONICAL_CHUNK_SOURCES:
        if not p.is_file():
            continue
        with p.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    c = json.loads(line)
                except ValueError:
                    continue
                md = c.get("metadata") or {}
                title = str(md.get("clause_title") or "")
                text = str(c.get("text") or "")
                if (
                    re.search(r"bibliograph", title, re.I)
                    or re.search(r"normative\s+references?", title, re.I)
                    or re.search(r"bibliograph", text[:400], re.I)
                ):
                    yield str(md.get("docidentifier") or ""), str(md.get("edition") or ""), text


def edition_node(docs: dict, docidentifier: str, edition: str) -> str | None:
    """The graph node a chunk's docidentifier+edition belongs to: the
    exact edition when it exists, else the family's active edition, else
    the newest — the SAME family+part resolution the registry build uses,
    so a part never leaks into its siblings."""
    m = SERIES.match(docidentifier)
    if not m:
        return None
    fam = f"{m.group(2)}-{m.group(3)}"
    base_id = re.sub(r"^OIML\s+", "", docidentifier)
    part_m = re.search(r"^[A-Z]+\s+\d+(?:-([A-Za-z0-9]+))?", base_id)
    part = part_m.group(1) if part_m else None
    cands = [nid for nid, rec in docs.items() if rec["family"] == fam and rec["part"] == part]
    if not cands:
        return None
    if edition:
        for n in cands:
            if n.endswith(f"-{edition}"):
                return n
    pool = [n for n in cands if docs[n]["active"]] or cands
    return max(pool, key=lambda n: docs[n]["edition"])


def build() -> int:
    nodes: dict[str, str] = {}
    edges: set[tuple[str, str, str]] = set()
    docs: dict[str, dict] = {}
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
        if node not in docs:  # primary file wins; language instances collapse
            fam = family_of(primary)
            base_id = re.sub(r"^OIML\s+", "", primary)
            part_m = re.search(r"^[A-Z]+\s+\d+(?:-([A-Za-z0-9]+))?", base_id)
            ed_m = re.search(r":(\d{4})", base_id)
            docs[node] = {
                "docidentifier": primary,
                "family": fam.split(":", 1)[1] if fam else "",
                "part": (part_m.group(1) if part_m else None),
                "edition": ed_m.group(1) if ed_m else "",
                "status": ((d.get("status") or {}).get("stage") or {}).get("content", "unknown"),
                "title": label or primary,
            }

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

    # ── documents registry: derive status + active from successor edges ──
    succ_of: dict[str, str] = {}
    for src, dst, kind in edges:
        if kind == "successor":
            succ_of[src] = dst
    for nid, rec in docs.items():
        has_succ = nid in succ_of
        rec["derived_status"] = "superseded" if has_succ else rec["status"]
        rec["superseded_by"] = succ_of.get(nid)
    # active = terminal (no successor) with max edition within family+part
    by_fp: dict[tuple[str, str | None], list[str]] = {}
    for nid, rec in docs.items():
        by_fp.setdefault((rec["family"], rec["part"]), []).append(nid)
    for fp, nids in by_fp.items():
        terminal = [n for n in nids if n not in succ_of]
        # active = terminal AND not superseded by its own status field —
        # a terminal-but-superseded record is a relaton data gap (no
        # successor recorded), surfaced as a family with NO active edition
        live_terminal = [n for n in terminal if docs[n]["status"] != "superseded" and docs[n]["status"] != "withdrawn"]
        if live_terminal:
            top = max(live_terminal, key=lambda n: docs[n]["edition"])
            for n in nids:
                docs[n]["active"] = 1 if n == top else 0
        else:  # cyclic or unanchored chain — nothing marked active
            for n in nids:
                docs[n]["active"] = 0

    # ── cites edges (GraphRAG): what each publication's bibliography
    # actually cites — relaton records how editions relate, not what they
    # reference; the citations live in the documents' own bibliography
    # sections, already chunked. Extraction grammar = the profile codec.
    codec = codec_for_profile("profile")
    cites_edges = 0
    for docidentifier, edition, text in bibliography_chunks():
        src = edition_node(docs, docidentifier, edition)
        if not src:
            continue
        src_rec = docs[src]
        for nid, label in codec.cited_refs(text)[:40]:
            # a publication naming itself is not a citation — the family
            # overview chunks list their own parts
            m = SERIES.match(label)
            if m:
                base_id = re.sub(r"^OIML\s+", "", label)
                pm = re.search(r"^[A-Z]+\s+\d+(?:-([A-Za-z0-9]+))?", base_id)
                part = pm.group(1) if pm else None
                em = re.search(r":(\d{4})", base_id)
                if part and em and part == em.group(1):
                    part = None  # the trailing :year is not a part
                if src_rec["family"] == f"{m.group(2)}-{m.group(3)}" and src_rec["part"] == part:
                    continue
            nodes.setdefault(nid, f"cite|{esc(label)}")
            before = len(edges)
            edges.add((src, nid, "cites"))
            cites_edges += len(edges) - before

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
        out.write("DELETE FROM graph_nodes;\nDELETE FROM graph_edges;\nDELETE FROM documents;\n")
        for nid, rec in docs.items():
            out.write(
                f"INSERT OR IGNORE INTO documents (canonical_id, docidentifier, family, part, edition, status, derived_status, active, superseded_by, title) "
                f"VALUES ('{nid}', '{esc(rec['docidentifier'])}', '{rec['family']}', {repr(rec['part']) if rec['part'] else 'NULL'}, "
                f"'{rec['edition']}', '{rec['status']}', '{rec['derived_status']}', {rec['active']}, "
                f"{('' + chr(39) + rec['superseded_by'] + chr(39)) if rec['superseded_by'] else 'NULL'}, '{esc(rec['title'])}');\n"
            )
        node_rows = [(nid.split(":", 1)[0], label) for nid, label in nodes.items()]
        for nid, v in nodes.items():
            kind, label = v.split("|", 1)
            out.write(f"INSERT OR IGNORE INTO graph_nodes (id, kind, label) VALUES ('{nid}', '{kind}', '{label}');\n")
        for src, dst, kind in sorted(edges):
            if src in nodes and dst in nodes:
                out.write(f"INSERT OR IGNORE INTO graph_edges (src, dst, kind) VALUES ('{src}', '{dst}', '{kind}');\n")


    kept = sum(1 for s, d, k in edges if s in nodes and d in nodes)
    active_ct = sum(1 for r in docs.values() if r.get("active"))
    cite_ct = sum(1 for v in nodes.values() if v.startswith("cite|"))
    print(
        f"documents registry: {len(docs)} editions, {active_ct} active; "
        f"graph: {len(nodes)} nodes ({sum(1 for v in node_rows if v[0]=='doc')} docs, "
        f"{sum(1 for v in node_rows if v[0]=='family')} families, {concepts} concepts, "
        f"{cite_ct} cited refs), "
        f"{kept} edges ({defines} defines, {cites_edges} cites), {skipped} non-publication records skipped → {OUT}"
    )
    return 0


def apply() -> int:
    if not OUT.exists():
        print("no graph.sql — run `graph` first")
        return 1
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
           "CLOUDFLARE_ACCOUNT_ID": os.environ["CLOUDFLARE_ACCOUNT_ID"]}
    r = subprocess.run(
        # the file path must be ABSOLUTE: wrangler resolves it against its
        # own cwd (the worker dir), not the repo root
        ["npx", "wrangler", "d1", "execute", "rag-public", "--remote",
         "--file", str(OUT.resolve() if not OUT.is_absolute() else OUT)],
        cwd=Path(__file__).resolve().parents[1] / "workers" / "worker_public",
        env=env,
    )
    return r.returncode


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    sys.exit(build() if cmd == "build" else (apply() if cmd == "apply" else 2))
