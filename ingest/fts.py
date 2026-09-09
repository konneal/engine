"""Load the full-corpus lexical index (D1 chunks + FTS5) for BM25 prefilter.

G-ETSI-1 (arXiv:2604.09868 §II-B5): sparse retrieval must scan the whole
corpus, not merely re-rank dense hits. Sources:

- artifacts/chunks.jsonl — dirty + synthetic lanes (clean-corpus rows are
  skipped: replaced by the MKO producer-native chunks)
- artifacts/mko_chunks.jsonl — MKO chunks (the live clean corpus), remapped
  to the serving lanes (corpus "oiml", tier "curated", producer "mko")
- contextual preambles from artifacts/enriched-contexts.jsonl when present
  (Anthropic contextual BM25)

Whole-edition EN-only exclusions (ingest/corpus-exclusions.yaml, issue #72)
are honored at the load door for every source — a lane artifact can predate
an exclusion, and the checked-in list is the record of what the EN index
refuses.
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
from .langid import load_exclusions

CHUNKS = ARTIFACTS / "chunks.jsonl"
MKO_CHUNKS = ARTIFACTS / "mko_chunks.jsonl"
TYPED_TABLES = ARTIFACTS / "table_chunks_enrich.jsonl"
CHANGED = ARTIFACTS / "mko_changed.jsonl"
MODEL_CHUNKS = ARTIFACTS / "model_chunks.jsonl"
CONTEXTS = ARTIFACTS / "enriched-contexts.jsonl"
BATCH = 50

# — unit-level language detection (TODO.remaining/09) —
# OIML EN editions embed official French/Spanish annexes with no marker;
# the declared doc language says "en" for all of them (issue #72: an ES
# annex chunk poisoned family-relative edition steering). Stopword ratios
# on the first ~200 words are enough to TAG the mismatch — we tag, never
# drop: bilingual annexes are official content.
_LANG_MARKERS = {
    "en": {"the", "and", "of", "to", "in", "is", "that", "for", "with", "as"},
    "fr": {"le", "la", "les", "de", "des", "et", "est", "une", "dans", "pour"},
    "es": {"el", "la", "los", "las", "de", "que", "y", "una", "para", "con"},
    "de": {"der", "die", "das", "und", "ist", "von", "mit", "für", "den", "dem"},
}


def _detect_language(text: str) -> str | None:
    words = re.findall(r"[a-zà-öø-ÿ]+", text[:1600].lower())
    if len(words) < 20:
        return None  # too short to judge — keep the declared language
    counts = {lang: sum(1 for w in words if w in stop) for lang, stop in _LANG_MARKERS.items()}
    best = max(counts, key=counts.get)
    if counts[best] < 3:
        return None
    runner = sorted(counts.values(), reverse=True)
    if runner[0] <= runner[1] * 1.5:
        return None  # no clear winner (bilingual front matter) — keep declared
    return best


# — whole-edition EN-only exclusions (issue #72) —
# The checked-in list is the audit record of what the EN index refuses;
# EVERY source lane honors it here at the load door. The parse gate keeps
# chunks.jsonl clean, but a lane artifact can predate an exclusion — the
# table lane's table_chunks_enrich.jsonl was generated before the R 79:2015
# ES entry and re-imported 6 excluded-edition chunks into the lexical lane.
_excluded_ids_cache: frozenset[str] | None = None


def _excluded_ids() -> frozenset[str]:
    global _excluded_ids_cache
    if _excluded_ids_cache is None:
        _excluded_ids_cache = frozenset(e.doc_id for e in load_exclusions())
    return _excluded_ids_cache


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
    doc_id = str(md.get("doc_id") or rec.get("doc_id") or "")
    if doc_id in _excluded_ids():
        return None  # whole-edition EN-only exclusion (issue #72)
    body = rec.get("text") or md.get("chunk_text") or ""
    body = re.sub(r"\s+", " ", body).strip()
    if not body:
        return None
    ctx = contexts.get(rec["id"])
    fts = f"{ctx.strip()} {body}" if ctx else body
    fts = fts[:4000]
    display = body[:2800]
    # unit-level langid: tag bilingual-annex content with its ACTUAL
    # language when it clearly disagrees with the declared one
    lang = str(md.get("language") or "en")
    if lang in _LANG_MARKERS:
        detected = _detect_language(body)
        if detected and detected != lang:
            md["declared_language"] = lang
            lang = detected
    sql = (
        "INSERT OR REPLACE INTO chunks "
        "(id, doc_id, docidentifier, doctype, doc_number, edition, language, "
        "clause_anchor, clause_title, status, superseded_by, corpus, tier, text, fts_text, "
        "unit_id, block) VALUES ("
        f"'{_esc(str(rec['id']))}',"
        f"'{_esc(doc_id)}',"
        f"'{_esc(str(md.get('docidentifier') or ''))}',"
        f"'{_esc(str(md.get('doctype') or ''))}',"
        f"'{_esc(str(md.get('doc_number') or ''))}',"
        f"'{_esc(str(md.get('edition') or ''))}',"
        f"'{_esc(lang)}',"
        f"'{_esc(str(md.get('clause_anchor') or ''))}',"
        f"'{_esc(str(md.get('clause_title') or ''))}',"
        f"'{_esc(str(md.get('status') or 'unknown'))}',"
        f"'{_esc(str(md.get('superseded_by') or ''))}',"
        f"'{_esc(str(md.get('corpus') or ''))}',"
        f"'{_esc(str(md.get('tier') or ''))}',"
        f"'{_esc(display)}',"
        f"'{_esc(fts)}',"
        f"'{_esc(str(md.get('unit_id') or ''))}',"
        f"'{_esc(str(md.get('block') or ''))}'"
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
    # Typed-table lane (TODO.remaining/09): the 10.4k table chunks were
    # dense-only — BM25 could not see the objects that hold the normative
    # values. They carry unit_id + block, so they land with unit identity.
    if TYPED_TABLES.is_file():
        with TYPED_TABLES.open(encoding="utf-8") as src:
            for line in src:
                rec = json.loads(line)
                row = _insert_sql(rec, contexts)
                if row:
                    inserts.append(row[0])
                    n_ctx += row[1]
                    n += 1
    # the model plane (TODO.ai-platform/05): the machine content joins the
    # lexical lane too — an exact-jargon query ("d_max E_max", "5.3.2 MPE")
    # hits the model node by BM25 exactly like a prose clause
    if MODEL_CHUNKS.is_file():
        with MODEL_CHUNKS.open(encoding="utf-8") as src:
            for line in src:
                rec = json.loads(line)
                row = _insert_sql(rec, contexts)
                if row:
                    inserts.append(row[0])
                    n_ctx += row[1]
                    n += 1
    return inserts, n, n_ctx


def build_changed_rows() -> tuple[list[str], int, int]:
    """Incremental apply (TODO.remaining/10): only the ids the MKO pipeline
    marked changed (artifacts/mko_changed.jsonl, written by the diff step).
    INSERT OR REPLACE upserts in place — the ai/au triggers sync chunks_fts,
    so no DELETE and no full pass. Recovery path is `fts --full`."""
    if not CHANGED.is_file():
        raise SystemExit("no artifacts/mko_changed.jsonl — run the mko pipeline, or use --full")
    changed_ids = {json.loads(line)["id"] for line in CHANGED.open(encoding="utf-8") if line.strip()}
    contexts = _load_contexts()
    inserts: list[str] = []
    n_ctx = 0
    for source in (CHUNKS, MKO_CHUNKS, TYPED_TABLES):
        if not source.is_file():
            continue
        with source.open(encoding="utf-8") as src:
            for line in src:
                rec = json.loads(line)
                if rec.get("id") not in changed_ids:
                    continue
                if (rec.get("metadata") or {}).get("corpus") == "clean":
                    continue
                row = _insert_sql(rec, contexts)
                if row:
                    inserts.append(row[0])
                    n_ctx += row[1]
    return inserts, len(inserts), n_ctx


def _run_sql(path: Path, attempts: int = 3) -> None:
    wrangler_dir = Path(__file__).resolve().parents[1] / "workers" / "worker_public"
    env = os.environ.copy()
    env["CLOUDFLARE_ACCOUNT_ID"] = env["CLOUDFLARE_ACCOUNT_ID"]
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


def apply(limit: int | None = None, resume: bool = False, incremental: bool = False) -> None:
    if incremental:
        inserts, n, n_ctx = build_changed_rows()
        print(f"fts: incremental — {n} changed rows ({n_ctx} with context preamble)", flush=True)
    else:
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
    print(f"fts: done ({total} rows{' incremental' if incremental else ''})", flush=True)


def _count_rows() -> int:
    wrangler_dir = Path(__file__).resolve().parents[1] / "workers" / "worker_public"
    env = os.environ.copy()
    env["CLOUDFLARE_ACCOUNT_ID"] = env["CLOUDFLARE_ACCOUNT_ID"]
    r = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "rag-public", "--remote",
         "--command", "SELECT COUNT(*) n FROM chunks", "-c", "wrangler.toml", "--json"],
        cwd=wrangler_dir, capture_output=True, text=True, env=env,
    )
    m = re.search(r'"n":\s*(\d+)', r.stdout)
    return int(m.group(1)) if m else 0
