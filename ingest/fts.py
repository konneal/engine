"""Load the full-corpus lexical index (D1 chunks + FTS5) for BM25 prefilter.

G-ETSI-1 (arXiv:2604.09868 §II-B5): sparse retrieval must scan the whole
corpus, not merely re-rank dense hits. Body from artifacts/chunks.jsonl;
contextual preambles from artifacts/enriched-contexts.jsonl when present
(Anthropic contextual BM25).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from .config import ARTIFACTS

CHUNKS = ARTIFACTS / "chunks.jsonl"
CONTEXTS = ARTIFACTS / "enriched-contexts.jsonl"
BATCH = 50


def _esc(s: str) -> str:
    return s.replace("'", "''")


def _load_contexts() -> dict[str, str]:
    out: dict[str, str] = {}
    if not CONTEXTS.is_file():
        return out
    with CONTEXTS.open(encoding="utf-8") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            cid, ctx = rec.get("id"), (rec.get("context") or "").strip()
            if cid and ctx:
                out[cid] = ctx
    return out


def build_rows(limit: int | None = None) -> tuple[list[str], int, int]:
    contexts = _load_contexts()
    inserts: list[str] = []
    n_ctx = 0
    n = 0
    with CHUNKS.open(encoding="utf-8") as src:
        for line in src:
            if limit is not None and n >= limit:
                break
            rec = json.loads(line)
            md = rec.get("metadata") or {}
            cid = rec["id"]
            body = rec.get("text") or md.get("chunk_text") or ""
            body = re.sub(r"\s+", " ", body).strip()
            if not body:
                continue
            ctx = contexts.get(cid)
            if ctx:
                n_ctx += 1
            fts = f"{ctx.strip()} {body}" if ctx else body
            fts = fts[:4000]
            display = body[:2800]
            inserts.append(
                "INSERT OR REPLACE INTO chunks "
                "(id, doc_id, docidentifier, doctype, doc_number, edition, language, "
                "clause_anchor, clause_title, status, superseded_by, corpus, tier, text, fts_text) VALUES ("
                f"'{_esc(cid)}',"
                f"'{_esc(str(md.get('doc_id') or rec.get('doc_id') or ''))}',"
                f"'{_esc(str(md.get('docidentifier') or ''))}',"
                f"'{_esc(str(md.get('doctype') or ''))}',"
                f"'{_esc(str(md.get('doc_number') or ''))}',"
                f"'{_esc(str(md.get('edition') or ''))}',"
                f"'{_esc(str(md.get('language') or 'en'))}',"
                f"'{_esc(str(md.get('clause_anchor') or ''))}',"
                f"'{_esc(str(md.get('clause_title') or ''))}',"
                f"'{_esc(str(md.get('status') or 'unknown'))}',"
                f"'{_esc(str(md.get('superseded_by') or ''))}',"
                f"'{_esc(str(md.get('corpus') or ''))}',"
                f"'{_esc(str(md.get('tier') or ''))}',"
                f"'{_esc(display)}',"
                f"'{_esc(fts)}'"
                ");"
            )
            n += 1
    return inserts, n, n_ctx


def _run_sql(path: Path) -> None:
    wrangler_dir = Path(__file__).resolve().parents[1] / "workers" / "worker_public"
    env = os.environ.copy()
    env["CLOUDFLARE_ACCOUNT_ID"] = env.get("CLOUDFLARE_ACCOUNT_ID") or "06cad8ae9a017c856ab496c6bca9a9d8"
    cmd = [
        "npx", "wrangler", "d1", "execute", "rag-public",
        "--remote", "--file", str(path),
        "-c", "wrangler.toml",
    ]
    r = subprocess.run(cmd, cwd=wrangler_dir, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise RuntimeError(f"d1 execute failed:\n{r.stderr[-2500:] or r.stdout[-2500:]}")


def apply(limit: int | None = None) -> None:
    inserts, n, n_ctx = build_rows(limit)
    print(f"fts: prepared {n} rows ({n_ctx} with context preamble)")

    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as tf:
        tf.write("DELETE FROM chunks;\n")
        clear_path = Path(tf.name)
    print("fts: clearing…")
    _run_sql(clear_path)
    clear_path.unlink(missing_ok=True)

    total = len(inserts)
    for i in range(0, total, BATCH):
        batch = inserts[i : i + BATCH]
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as tf:
            tf.write("\n".join(batch) + "\n")
            bpath = Path(tf.name)
        print(f"fts: {min(i + BATCH, total)}/{total}")
        _run_sql(bpath)
        bpath.unlink(missing_ok=True)
    print(f"fts: done ({total} rows)")
