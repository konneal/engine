"""Wire MKO chunks into the live index (producer-native clean corpus).

Replaces the HTML-scraped clean-corpus chunks (doc_id clean:*) in
idx_oiml_public_v2 with the MKO bundles' chunks (doc_id mko:*). Serving
metadata is remapped to the existing lanes — corpus "oiml", tier
"curated" — with provenance preserved (producer: "mko", unit_id,
unit_hash). Old clean chunk ids are deleted from Vectorize after the
MKO upsert completes.

  .venv/bin/python scripts/wire_mko.py --embed   # embed (resumable) + upsert + delete old
  .venv/bin/python scripts/wire_mko.py --check   # dry-run counts only
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest.cf import CF  # noqa: E402

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"
MKO_CHUNKS = ARTIFACTS / "mko_chunks.jsonl"
MKO_EMBED = ARTIFACTS / "mko_embeddings.jsonl"
OLD_CHUNKS = ARTIFACTS / "chunks.jsonl"
UPSERT_STATE = ARTIFACTS / "upsert_state_idx_oiml_public_v2_mko.txt"
BATCH = 50


def serving_chunk(rec: dict) -> dict:
    md = dict(rec["metadata"])
    md["corpus"] = "oiml"
    md["tier"] = "curated"
    md["producer"] = "mko"
    md.setdefault("chunk_text", rec.get("text", ""))
    # Vectorize metadata values must be scalar — typed payloads (table/
    # term/formula dicts) stay in the artifacts and chunk_text, not metadata
    md = {k: v for k, v in md.items() if isinstance(v, (str, int, float, bool))}
    return {"id": rec["id"], "metadata": md}


def _load_mko_contexts() -> dict[str, str]:
    """Contextual preambles keyed by chunk id (the enrichment protocol)."""
    path = ARTIFACTS / "enriched-contexts.jsonl"
    out: dict[str, str] = {}
    if path.exists():
        with path.open(encoding="utf-8") as f:
            for line in f:
                rec = json.loads(line)
                if rec.get("id") and rec.get("context"):
                    out[rec["id"]] = rec["context"].strip()
    return out


def old_clean_ids() -> list[str]:
    out = []
    with OLD_CHUNKS.open(encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            if (rec.get("metadata") or {}).get("corpus") == "clean":
                out.append(rec["id"])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--embed", action="store_true", help="embed + upsert + delete old clean ids")
    ap.add_argument("--check", action="store_true", help="counts only")
    ap.add_argument("--verify", action="store_true", help="invariant gate: contexts cover every MKO chunk; fails loudly otherwise")
    args = ap.parse_args()

    chunks = [json.loads(l) for l in MKO_CHUNKS.open(encoding="utf-8")]
    old = old_clean_ids()
    print(f"mko chunks: {len(chunks)} ({len({c['doc_id'] for c in chunks})} docs) | old clean chunks to replace: {len(old)}")
    if args.verify:
        contexts = _load_mko_contexts()
        missing = [c["id"] for c in chunks if c["id"] not in contexts]
        embedded = sum(1 for _ in MKO_EMBED.open(encoding="utf-8")) if MKO_EMBED.exists() else 0
        print(f"verify: contexts {len(contexts)} | mko chunks {len(chunks)} | embeddings {embedded}")
        if missing:
            print(f"FAIL: {len(missing)} chunks lack contextual preambles (e.g. {missing[:3]})")
            return 1
        if embedded and embedded < len(chunks):
            print(f"FAIL: embeddings ({embedded}) < chunks ({len(chunks)}) — embed incomplete")
            return 1
        print("verify: OK — enrichment coverage complete")
        return 0
    if args.check:
        return 0

    cf = CF()
    info = cf.vectorize_info()
    print(f"index {info.get('name')}: vectors={info.get('vectorCount')}")

    if args.embed:
        done: set[str] = set()
        if MKO_EMBED.exists():
            with MKO_EMBED.open() as f:
                for line in f:
                    done.add(json.loads(line)["id"])
        todo = [c for c in chunks if c["id"] not in done]
        print(f"embedding {len(todo)} chunks ({len(done)} already done)…")
        with MKO_EMBED.open("a", encoding="utf-8") as out:
            import time

            contexts = _load_mko_contexts()
            unenriched = [c["id"] for c in todo if c["id"] not in contexts]
            if unenriched and not os.environ.get("ALLOW_UNENRICHED"):
                raise SystemExit(
                    f"REFUSING: {len(unenriched)} chunks have no contextual preamble. "
                    "Run `ENRICH_SOURCE=artifacts/mko_chunks.jsonl python -m ingest.cli enrich` first — "
                    "un-enriched upserts regress retrieval (the 2026-08-28 incident). "
                    "Override with ALLOW_UNENRICHED=1 if you truly mean it."
                )

            def embed_batch(items, attempts=3):
                # the enrichment protocol embeds CONTEXT+text, never bare text
                texts = [
                    f"{contexts[c['id']]} {c['metadata'].get('chunk_text') or c.get('text', '')}".strip()
                    if c["id"] in contexts
                    else c["metadata"].get("chunk_text") or c.get("text", "")
                    for c in items
                ]
                last = None
                for a in range(attempts):
                    try:
                        vecs = cf.embed(texts)
                        if vecs and len(vecs) == len(items):
                            return list(zip(items, vecs))
                    except Exception as e:  # noqa: BLE001
                        last = e
                    time.sleep(4 * (a + 1))
                # batch keeps failing → isolate the offender(s) per-item
                out_ok = []
                for c in items:
                    try:
                        v = cf.embed([c["metadata"].get("chunk_text") or c.get("text", "")])
                        if v and len(v) == 1:
                            out_ok.append((c, v[0]))
                    except Exception as e:  # noqa: BLE001
                        print(f"  !! skipped {c['id']} ({c['metadata'].get('docidentifier')}): {str(e)[:100]}", flush=True)
                return out_ok

            n = 0
            for i in range(0, len(todo), BATCH):
                batch = todo[i : i + BATCH]
                for c, v in embed_batch(batch):
                    out.write(json.dumps({"id": c["id"], "values": v}) + "\n")
                    n += 1
                print(f"  embedded {min(i + BATCH, len(todo))}/{len(todo)}", flush=True)

    # upsert (resumable via CF state file)
    served = {c["id"]: serving_chunk(c) for c in chunks}
    vectors = []
    with MKO_EMBED.open(encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            c = served.get(rec["id"])
            if c:
                vectors.append({"id": rec["id"], "values": rec["values"], "metadata": c["metadata"]})
    print(f"upserting {len(vectors)} vectors…")
    cf.vectorize_upsert(vectors, state_path=UPSERT_STATE)

    # retire the HTML-path clean chunks
    print(f"deleting {len(old)} old clean chunk ids…")
    for i in range(0, len(old), 100):
        cf.vectorize_delete(old[i : i + 100])
        print(f"  deleted {min(i + 100, len(old))}/{len(old)}", flush=True)
    print("done: MKO clean corpus live; HTML-path clean chunks retired")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
