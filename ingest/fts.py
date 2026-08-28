"""Load the full-corpus lexical index (D1 chunks + FTS5) for BM25 prefilter.

G-ETSI-1 (arXiv:2604.09868 §II-B5): sparse retrieval must scan the whole
corpus, not merely re-rank dense hits. Sources:

- artifacts/chunks.jsonl — dirty + synthetic lanes (clean-corpus rows are
  skipped: replaced by the MKO producer-native chunks)
- artifacts/mko_chunks.jsonl — MKO chunks (the live clean corpus), remapped
  to the serving lanes (corpus "oiml", tier "curated", producer "mko")
- contextual preambles from artifacts/enriched-contexts.jsonl when present
  (Anthropic contextual BM25)
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

from .config import ARTIFACTS

CHUNKS = ARTIFACTS / "chunks.jsonl"
MKO_CHUNKS = ARTIFACTS / "mko_chunks.jsonl"
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


def _insert_sql(rec: dict, contexts: dict[str, str]) -> tuple[str, bool] | None:
    md = dict(rec.get("metadata") or {})
    if md.get("corpus") == "mko":
        md["corpus"] = "oiml"
        md["tier"] = "curated"
        md["producer"] = "mko"
    body = rec.get("text") or md.get("chunk_text") or ""
    body = re.sub(r"\s+", " ", body).strip()
    if not body:
        return None
    ctx = contexts.get(rec["id"])
    fts = f"{ctx.strip()} {body}" if ctx else body
    fts = fts[:4000]
    display = body[:2800]
    sql = (
        "INSERT OR REPLACE INTO chunks "
        "(id, doc_id, docidentifier, doctype, doc_number, edition, language, "
        "clause_anchor, clause_title, status, superseded_by, corpus, tier, text, fts_text) VALUES ("
        f"'{_esc(str(rec['id']))}',"
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
    return sql, bool(ctx)


def build_rows(limit: int | None = None) -> tuple[list[str], int, int]:
    contexts = _load_contexts()
    inserts: list[str] = []
    n_ctx = 0
    n = 0
    # dirty + synthetic lanes (clean superseded by MKO)
    with CHUNKS.open(encoding="utf-8") as src:
        for line in src:
            if limit is not None and n >= limit:
                break
            rec = json.loads(line)
            if (rec.get("metadata") or {}).get("corpus") == "clean":
                continue
            row = _insert_sql(rec, contexts)
            if row:
                inserts.append(row[0])
                n_ctx += row[1]
                n += 1
    # MKO producer-native clean corpus
    if MKO_CHUNKS.is_file():
        with MKO_CHUNKS.open(encoding="utf-8") as src:
            for line in src:
                rec = json.loads(line)
                row = _insert_sql(rec, contexts)
                if row:
                    inserts.append(row[0])
                    n_ctx += row[1]
                    n += 1
    return inserts, n, n_ctx


def _run_sql(path: Path, attempts: int = 3) -> None:
    wrangler_dir = Path(__file__).resolve().parents[1] / "workers" / "worker_public"
    env = os.environ.copy()
    env["CLOUDFLARE_ACCOUNT_ID"] = env.get("CLOUDFLARE_ACCOUNT_ID") or "06cad8ae9a017c856ab496c6bca9a9d8"
    cmd = [
        "npx", "wrangler", "d1", "execute", "rag-public",
        "--remote", "--file", str(path),
        "-c", "wrangler.toml",
    ]
    last = ""
    for attempt in range(attempts):
        r = subprocess.run(cmd, cwd=wrangler_dir, capture_output=True, text=True, env=env)
        if r.returncode == 0:
            return
        last = r.stderr[-2500:] or r.stdout[-2500:]
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"d1 execute failed ({attempts} attempts):\n{last}")


def apply(limit: int | None = None, resume: bool = False) -> None:
    inserts, n, n_ctx = build_rows(limit)
    print(f"fts: prepared {n} rows ({n_ctx} with context preamble)", flush=True)

    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as tf:
        tf.write("DELETE FROM chunks;\n")
        clear_path = Path(tf.name)
    print("fts: clearing…", flush=True)
    _run_sql(clear_path)
    clear_path.unlink(missing_ok=True)

    total = len(inserts)
    for i in range(0, total, BATCH):
        batch = inserts[i : i + BATCH]
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as tf:
            tf.write("\n".join(batch) + "\n")
            bpath = Path(tf.name)
        print(f"fts: {min(i + BATCH, total)}/{total}", flush=True)
        _run_sql(bpath)
        bpath.unlink(missing_ok=True)
    print(f"fts: done ({total} rows)", flush=True)


def _count_rows() -> int:
    wrangler_dir = Path(__file__).resolve().parents[1] / "workers" / "worker_public"
    env = os.environ.copy()
    env["CLOUDFLARE_ACCOUNT_ID"] = env.get("CLOUDFLARE_ACCOUNT_ID") or "06cad8ae9a017c856ab496c6bca9a9d8"
    r = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "rag-public", "--remote",
         "--command", "SELECT COUNT(*) n FROM chunks", "-c", "wrangler.toml", "--json"],
        cwd=wrangler_dir, capture_output=True, text=True, env=env,
    )
    m = re.search(r'"n":\s*(\d+)', r.stdout)
    return int(m.group(1)) if m else 0
