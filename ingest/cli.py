from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .chunk import chunk_doc, doc_content_hash
from .config import ARTIFACTS
from .models import ManifestEntry
from .parse import apply_precedence, load_corpus

CHUNKS_PATH = ARTIFACTS / "chunks.jsonl"
MANIFEST_PATH = ARTIFACTS / "manifest.json"
EMBED_PATH = ARTIFACTS / "embeddings.jsonl"


def build(corpus_filter: str | None, limit: int | None) -> None:
    ARTIFACTS.mkdir(exist_ok=True)
    corpora = ["clean", "dirty"] if corpus_filter in (None, "all") else [corpus_filter]
    docs = []
    for corpus in corpora:
        loaded = load_corpus(corpus)
        print(f"{corpus}: parsed {len(loaded)} docs")
        docs.extend(loaded)

    docs, dropped = apply_precedence(docs)
    shells = [d for d in docs if d.tier == "shell"]
    indexable = [d for d in docs if d.tier != "shell" and d.sections]
    if limit:
        indexable = indexable[:limit]
    print(f"kept {len(indexable)} docs; dropped {len(dropped)} (clean-precedence); {len(shells)} shells flagged")

    chunks = []
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
            )
        )

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
        "by_language": {},
        "by_doctype": {},
    }
    for d in indexable:
        report["by_language"][d.language] = report["by_language"].get(d.language, 0) + 1
        report["by_doctype"][d.doctype or "?"] = report["by_doctype"].get(d.doctype or "?", 0) + 1
    (ARTIFACTS / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "shells"}, indent=1))
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
        return group, cf.embed([c["text"] for c in group])

    batches = [todo[i : i + batch] for i in range(0, len(todo), batch)]
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
    from .cf import CF

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
    print(f"upserting {len(vectors)} vectors")
    cf.vectorize_upsert(vectors)
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
    p = argparse.ArgumentParser(prog="oiml-rag-ingest")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("parse", help="parse corpora → chunks.jsonl + manifest.json")
    sp.add_argument("--corpus", choices=["clean", "dirty", "all"], default="all")
    sp.add_argument("--limit", type=int, default=None)
    se = sub.add_parser("embed", help="embed chunks via Workers AI (resumable)")
    se.add_argument("--limit", type=int, default=None)
    sub.add_parser("upsert", help="upsert embeddings into Vectorize")
    sub.add_parser("probe", help="probe embeddings + index connectivity")
    args = p.parse_args(argv)

    if args.cmd == "parse":
        build(args.corpus if args.corpus != "all" else None, args.limit)
    elif args.cmd == "embed":
        embed(args.limit)
    elif args.cmd == "upsert":
        upsert()
    elif args.cmd == "probe":
        probe()
    return 0


if __name__ == "__main__":
    sys.exit(main())
