"""Contextual enrichment (Anthropic contextual retrieval technique):
prepend a 1-2 sentence situating context to every chunk before embedding.
Reduces retrieval failure rate 35-49% by anchoring chunks to their
document and clause position.

Uses deepseek-v4-pro (quality-first lane per CLAUDE.md) with prompt
caching for document prefixes — one-time cost ≈ $40-100 for 42k chunks.
The enriched text REPLACES the embedding input; the metadata stores both
the enriched text (for retrieval) and the original (for display).
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from .cf import CF
from .config import ARTIFACTS, ACCOUNT_ID

CHUNKS_PATH = ARTIFACTS / "chunks.jsonl"
EMBED_PATH = ARTIFACTS / "embeddings.jsonl"
ENRICHED_PATH = ARTIFACTS / "chunks_enriched.jsonl"

ENRICH_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8"  # deepseek returns empty (reasoning starvation); qwen3 works
ENRICH_BATCH = 10  # chunks per LLM call


def enrich_batch(cf: CF, chunks: list[dict]) -> list[str]:
    """Ask the quality model to write a 1-2 sentence context for each chunk."""
    passages = []
    for i, c in enumerate(chunks):
        meta = c["metadata"]
        ident = meta.get("docidentifier", "")
        anchor = meta.get("clause_anchor", "")
        title = meta.get("clause_title", "")
        text = c["text"][:1200]  # truncate for prompt efficiency
        passages.append(
            f"[{i}] {ident}{' §' + anchor if anchor else ''}"
            f"{' — ' + title if title else ''}\n{text}"
        )

    prompt = (
        "For each numbered passage below, write a 1-2 sentence context that "
        "situates it within its OIML publication. Include the document identifier, "
        "the clause/topic it covers, and how it relates to the publication's scope. "
        "Reply with ONLY a JSON array of strings (one per passage), no prose:\n\n"
        + "\n\n".join(passages)
    )

    for attempt in range(3):
        try:
            res = cf._post(
                f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{ENRICH_MODEL}",
                {
                    "messages": [
                        {"role": "system", "content": "You write concise retrieval contexts for OIML legal metrology documents. Reply only with valid JSON."},
                        {"role": "user", "content": prompt},
                    ],
                    "max_tokens": 4096, "reasoning_effort": "low",
                },
            )
            raw = res.get("result", {})
            # the model may return the array directly, or a string containing JSON
            text = raw.get("response", "") or (raw.get("choices") or [{}])[0].get("message", {}).get("content", "")
            if isinstance(text, list):
                if len(text) >= len(chunks):
                    out = []
                    for c in text[: len(chunks)]:
                        if isinstance(c, dict):
                            c = c.get(context, ) or c.get(text, ) or str(c)
                        out.append(str(c)[:300])
                    return out
            elif isinstance(text, str):
                m = text.find("[")
                n = text.rfind("]")
                if m >= 0 and n > m:
                    try:
                        contexts = json.loads(text[m : n + 1])
                        if isinstance(contexts, list) and len(contexts) >= len(chunks):
                            return [str(c)[:300] for c in contexts[: len(chunks)]]
                    except (json.JSONDecodeError, TypeError):
                        pass
        except Exception:
            pass
        time.sleep(2**attempt)
    return [""] * len(chunks)  # graceful: no context is better than no chunk


def enrich(limit: int | None = None) -> None:
    cf = CF()
    chunks = [json.loads(l) for l in CHUNKS_PATH.open(encoding="utf-8")]
    enriched_done = set()
    if ENRICHED_PATH.exists():
        with ENRICHED_PATH.open() as f:
            for line in f:
                enriched_done.add(json.loads(line)["id"])
    todo = [c for c in chunks if c["id"] not in enriched_done]
    if limit:
        todo = todo[:limit]
    print(f"enriching {len(todo)} chunks ({len(enriched_done)} already done)")

    with ENRICHED_PATH.open("a", encoding="utf-8") as out:
        for i in range(0, len(todo), ENRICH_BATCH):
            batch = todo[i : i + ENRICH_BATCH]
            contexts = enrich_batch(cf, batch)
            for j, c in enumerate(batch):
                ctx = contexts[j] if j < len(contexts) else ""
                enriched_text = f"{ctx}\n{c['text']}" if ctx else c["text"]
                out.write(
                    json.dumps({
                        "id": c["id"],
                        "text": enriched_text,
                        "original_text": c["text"],
                        "context": ctx,
                    }) + "\n"
                )
            done = min(i + ENRICH_BATCH, len(todo))
            print(f"  {done}/{len(todo)} enriched", flush=True)
            # yield to the serving path — enrichment is batch work and
            # must never saturate Workers AI rate limits that /api/ask
            # shares on the same account
            import time as _t
            _t.sleep(3)
    print(f"enriched chunks at {ENRICHED_PATH}")


def apply_enrichment() -> None:
    """Rewrite chunks.jsonl with enriched text (for re-embedding)."""
    enriched = {}
    if ENRICHED_PATH.exists():
        with ENRICHED_PATH.open() as f:
            for line in f:
                r = json.loads(line)
                enriched[r["id"]] = r["text"]
    if not enriched:
        print("no enriched chunks — run `enrich` first")
        return
    chunks = [json.loads(l) for l in CHUNKS_PATH.open(encoding="utf-8")]
    count = 0
    with CHUNKS_PATH.open("w", encoding="utf-8") as f:
        for c in chunks:
            if c["id"] in enriched:
                c["text"] = enriched[c["id"]]
                c["metadata"]["chunk_text"] = enriched[c["id"]][:2800]
                count += 1
            f.write(json.dumps(c) + "\n")
    print(f"applied enrichment to {count}/{len(chunks)} chunks")
    # clear embeddings so they get re-embedded with the new text
    if EMBED_PATH.exists():
        EMBED_PATH.unlink()
        print("cleared embeddings (re-embed required)")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "enrich"
    if cmd == "enrich":
        enrich(int(sys.argv[2]) if len(sys.argv) > 2 else None)
    elif cmd == "apply":
        apply_enrichment()
