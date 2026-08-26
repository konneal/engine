from __future__ import annotations

import argparse
import hashlib as _h
import json
import sys
from pathlib import Path

from .chunk import Chunk, chunk_doc, doc_content_hash
from .config import ARTIFACTS
from .models import ManifestEntry
from .parse import apply_precedence, load_corpus, normalize_identifier
from .enrich import run as run_enrich
from .graph import build as graph_build, apply as graph_apply

CHUNKS_PATH = ARTIFACTS / "chunks.jsonl"
MANIFEST_PATH = ARTIFACTS / "manifest.json"
EMBED_PATH = ARTIFACTS / "embeddings.jsonl"


def attach_families(docs) -> list:
    """Multi-part publications (R 60-1/-2/-3, R 76-1/-2, …): synthesize a
    dedicated FAMILY chunk per publication so 'what parts does R 60 have'
    retrieves the family structure directly. Generic across ALL families."""
    families: dict[tuple[str, str], list] = {}
    for d in docs:
        if d.doctype and d.doc_number:
            families.setdefault((d.doctype, d.doc_number), []).append(d)

    family_chunks = []
    for (doctype, number), members in families.items():
        if len(members) < 2:
            continue

        base_ident = f"OIML {doctype} {number}"

        # one entry per normalized identity; curated preferred, newest edition
        best: dict[str, tuple[int, str, str]] = {}
        for d in members:
            raw = d.docidentifier or base_ident
            ident = normalize_identifier(raw)
            edition = (d.edition or "").strip()
            title = d.title.split("—")[0].strip() if "—" in d.title else d.title
            is_part = ident.startswith(base_ident + "-")
            rank = (
                1 if d.corpus == "clean" else 0,
                edition if edition.isdigit() else "0000",
                1 if d.language == "en" else 0,
            )
            cur = best.get(ident)
            if cur is None or rank > cur[0]:
                best[ident] = (rank, ident, title)

        if len(best) < 2:
            continue

        # parts have numeric suffixes (R 60-1, R 60-2); annexes don't
        # (R 60-Annexe A). The base is not a part — it's the umbrella.
        part_idents = []
        annex_idents = []
        for ident in best:
            if ident == base_ident:
                continue
            suffix = ident[len(base_ident):].lstrip("-").strip()
            if suffix and suffix[0].isdigit():
                part_idents.append(ident)
            else:
                annex_idents.append(ident)
        n_parts = len(part_idents)
        n_annexes = len(annex_idents)
        n_total = n_parts + n_annexes

        lines = [f"- {ident} — {title}" for _r, ident, title in best.values() if ident != base_ident]

        # find the base doc for metadata
        base_doc = next(
            (d for d in members if normalize_identifier(d.docidentifier or "") == base_ident and d.corpus == "clean"),
            None,
        ) or next(
            (d for d in members if normalize_identifier(d.docidentifier or "") == base_ident),
            members[0],
        )

        parts_label = f"{n_parts} part{'s' if n_parts != 1 else ''}"
        annexes_label = f" and {n_annexes} annex{'es' if n_annexes != 1 else ''}" if n_annexes else ""
        text = (
            f"{base_doc.title.split('—')[0].strip()} ({base_ident}) is a multi-part OIML publication. "
            f"It comprises {parts_label}{annexes_label}:\n"
            + "\n".join(lines)
            + f"\n\n{base_ident} has {parts_label}{annexes_label} ({n_total} components total)."
        )

        cid = 'c' + _h.sha1(f'family|{doctype}|{number}|{_h.sha256(text.encode()).hexdigest()[:12]}'.encode()).hexdigest()[:16]
        family_chunks.append(Chunk(
            id=cid,
            doc_id=f"family:{doctype}-{number}",
            chunk_ref=f"{base_ident} family",
            text=text,
            metadata={
                "chunk_text": text,
                "doc_id": f"family:{doctype}-{number}",
                "docidentifier": base_ident,
                "doctype": doctype,
                "doc_number": number,
                "edition": "",
                "language": "en",
                "clause_anchor": "family",
                "clause_title": f"{base_ident} publication family (parts and annexes)",
                "tier": "curated",
                "corpus": "synthetic",
                "status": "in-force",
                "superseded_by": "",
                "text_ref": f"family/{doctype}-{number}",
            },
        ))

        # annotate each member's overview with a short family pointer
        for d in members:
            d.family_members = [f"{ident} — {title}" for _r, ident, title in best.values()]

    return family_chunks


def build(corpus_filter: str | None, limit: int | None) -> None:
    ARTIFACTS.mkdir(exist_ok=True)
    corpora = ["clean", "dirty"] if corpus_filter in (None, "all") else [corpus_filter]
    docs = []
    for corpus in corpora:
        loaded = load_corpus(corpus)
        print(f"{corpus}: parsed {len(loaded)} docs")
        docs.extend(loaded)

    docs, dropped = apply_precedence(docs)
    family_chunks = attach_families(docs)
    shells = [d for d in docs if d.tier == "shell"]
    indexable = [d for d in docs if d.tier != "shell" and d.sections]
    if limit:
        indexable = indexable[:limit]
    print(f"kept {len(indexable)} docs; dropped {len(dropped)} (clean-precedence); {len(shells)} shells flagged")

    chunks = list(family_chunks)
    manifest = []
    for d in indexable:
        doc_chunks = chunk_doc(d)
        chunks.extend(doc_chunks)
        manifest.append(
            ManifestEntry(
                doc_id=d.doc_id,
                chunk_count=len(doc_chunks),
                content_hash=doc_content_hash(doc_chunks),
                tier=d.tier,
                corpus=d.corpus,
            ),
        )
    print(f"  + {len(family_chunks)} family chunks (multi-part structure)")

    with CHUNKS_PATH.open("w", encoding="utf-8") as f:
        for c in chunks:
            f.write(c.model_dump_json() + "\n")
    with MANIFEST_PATH.open("w", encoding="utf-8") as f:
        json.dump([m.model_dump() for m in manifest], f, indent=1)

    report = {
        "docs_indexable": len(indexable),
        "docs_dropped_precedence": len(dropped),
        "shells": [d.doc_id for d in shells],
        "chunks": len(chunks),
        "family_chunks": len(family_chunks),
        "by_language": {},
        "by_doctype": {},
    }
    for d in indexable:
        report["by_language"][d.language] = report["by_language"].get(d.language, 0) + 1
        report["by_doctype"][d.doctype or "?"] = report["by_doctype"].get(d.doctype or "?", 0) + 1
    (ARTIFACTS / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k not in ("shells",)}, indent=1))
    print(f"wrote {CHUNKS_PATH} ({len(chunks)} chunks)")

def embed(limit: int | None) -> None:
    from .cf import CF

    cf = CF()
    done: set[str] = set()
    if EMBED_PATH.exists():
        with EMBED_PATH.open() as f:
            for line in f:
                done.add(json.loads(line)["id"])
    elif not CHUNKS_PATH.exists():
        raise SystemExit("run `parse` first")

    chunks = [json.loads(l) for l in CHUNKS_PATH.open(encoding="utf-8")]
    todo = [c for c in chunks if c["id"] not in done]
    if limit:
        todo = todo[:limit]
    print(f"embedding {len(todo)} chunks ({len(done)} already done)")

    batch = 50
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def run_batch(group):
        try:
            return group, cf.embed([c["text"] for c in group])
        except Exception:
            # fall back to per-item: isolate and skip genuinely bad inputs
            texts, vecs = [], []
            for c in group:
                try:
                    v = cf.embed([c["text"]])
                    texts.append(c)
                    vecs.append(v[0])
                except Exception as e:
                    print(f"  ! chunk failed {c['id']}: {e}", flush=True)
            return texts, vecs

    batches = [todo[i : i + 25] for i in range(0, len(todo), 25)]
    with EMBED_PATH.open("a", encoding="utf-8") as out:
        with ThreadPoolExecutor(max_workers=4) as ex:
            futs = [ex.submit(run_batch, g) for g in batches]
            for n, fut in enumerate(as_completed(futs), 1):
                group, vecs = fut.result()
                for c, v in zip(group, vecs):
                    out.write(json.dumps({"id": c["id"], "values": v}) + "\n")
                out.flush()
                if n % 20 == 0 or n == len(batches):
                    print(f"  batches {n}/{len(batches)} ({len(done) + n * batch} chunks)", flush=True)
    print(f"embeddings at {EMBED_PATH}")


def upsert() -> None:
    from .cf import CF, INDEX_NAME

    cf = CF()
    info = cf.vectorize_info()
    print(f"index {info.get('name')}: dims={info.get('dimensions')} vectors={info.get('vectorCount')}")
    chunks = {json.loads(l)["id"]: json.loads(l) for l in CHUNKS_PATH.open(encoding="utf-8")}
    vectors = []
    with EMBED_PATH.open(encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            c = chunks.get(rec["id"])
            if c:
                vectors.append({"id": rec["id"], "values": rec["values"], "metadata": c["metadata"]})
    state = ARTIFACTS / f"upsert_state_{INDEX_NAME}.txt"
    if state.exists():
        print(f"resuming from {state.read_text().strip()}")
    print(f"upserting {len(vectors)} vectors")
    cf.vectorize_upsert(vectors, state)
    print("done")


def probe() -> None:
    from .cf import CF

    cf = CF()
    vecs = cf.embed(["maximum permissible error for class III scales"])
    print(f"embedding OK: dims={len(vecs[0])}")
    try:
        info = cf.vectorize_info()
        print(f"index {info.get('name')}: dims={info.get('dimensions')} vectors={info.get('vectorCount')}")
    except Exception as e:  # noqa: BLE001
        print(f"index info failed: {e}")
    try:
        matches = cf.vectorize_query(vecs[0], top_k=3)
        for m in matches:
            md = m.get("metadata", {})
            print(f"  {m.get('score'):.3f} {md.get('docidentifier')} §{md.get('clause_anchor')} {md.get('clause_title', '')[:60]}")
    except Exception as e:  # noqa: BLE001
        print(f"query failed: {e}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ingest")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name, fn in [("parse", build), ("embed", embed), ("upsert", upsert), ("probe", probe), ("enrich", run_enrich), ("graph", run_graph)]:
        sp = sub.add_parser(name)
        sp.add_argument("--limit", type=int, default=None)
        sp.add_argument("--corpus", default=None)
        sp.add_argument("--batch", type=int, default=5)
        sp.add_argument("--concurrency", type=int, default=3)
        sp.add_argument("--rpm", type=int, default=45)
        sp.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    if args.cmd == "parse":
        build(args.corpus, args.limit)
    elif args.cmd == "embed":
        embed(args.limit)
    elif args.cmd == "upsert":
        upsert()
    elif args.cmd == "probe":
        probe()
    elif args.cmd == "enrich":
        run_enrich(args.limit, args.batch, args.concurrency, args.force, args.rpm)
    elif args.cmd == "graph":
        (graph_apply if args.corpus == "apply" else graph_build)()
    return 0


if __name__ == "__main__":
    sys.exit(main())
