"""One-command MKO pipeline (the orchestration gap, closed).

  .venv/bin/python -m ingest.cli mko            # full run
  .venv/bin/python -m ingest.cli mko --dry      # gates + counts only

Sequences the stages this session proved must never run out of order:

  1. EXPORT    bundles from mn-samples-oiml via the metanorma-document
               checkout (scripts/export_mko.rb)          [skippable]
  2. INGEST    bundles → artifacts/mko_*.{jsonl,sql,json}
  3. ENRICH    contextual preambles until coverage is complete
               (the /admin/enrich endpoint embeds context+text and
               upserts as it goes; rounds retry rate-limit casualties)
  4. GATE      scripts/wire_mko.py --verify MUST pass — the pipeline
               refuses to continue on un-enriched chunks
  5. WIRE      embed (context-aware) + upsert + retire old/stale ids
  6. LEXICAL   D1 FTS reload (contextual BM25 rows)
  7. GRAPH     mko_graph.sql → D1 graph_nodes/graph_edges

The pipeline STOPS before shipping: bump INDEX_VERSION and deploy remain
human actions (production releases are explicit).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
BUNDLES = Path("/tmp/mko-bundles")
MN_DOCUMENT = Path.home() / "src/mn/metanorma-document"
ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "06cad8ae9a017c856ab496c6bca9a9d8")
ENRICH_ROUNDS = 8


def _run(cmd: list[str], extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    print(f"  $ {' '.join(cmd[:6])}{' …' if len(cmd) > 6 else ''}", flush=True)
    env = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT, **(extra_env or {})}
    return subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)


def _step(name: str, r: subprocess.CompletedProcess) -> None:
    tail = (r.stdout or "").strip().splitlines()[-1:] or [(r.stderr or "").strip()[-160:]]
    print(f"  [{name}] {'ok' if r.returncode == 0 else 'FAIL'}: {tail[0][:150]}", flush=True)
    if r.returncode != 0:
        print((r.stderr or r.stdout)[-1500:], flush=True)
        raise SystemExit(f"stage {name} failed")


def missing_contexts() -> int:
    chunks = {json.loads(l)["id"] for l in (ARTIFACTS / "mko_chunks.jsonl").open()}
    ctx_path = ARTIFACTS / "enriched-contexts.jsonl"
    ctx = {json.loads(l)["id"] for l in ctx_path.open()} if ctx_path.exists() else set()
    return len(chunks - ctx)


def run_mko(skip_export: bool = False, dry: bool = False, skip_fts: bool = False, skip_graph: bool = False) -> None:
    print("MKO pipeline — stages stop at 'ready to ship' (INDEX_VERSION bump + deploy stay human)", flush=True)

    if not skip_export:
        print("1. EXPORT", flush=True)
        r = subprocess.run(
            ["bundle", "exec", "ruby", str(ROOT / "scripts/export_mko.rb"), str(BUNDLES)],
            cwd=MN_DOCUMENT, capture_output=True, text=True,
        )
        _step("export", r)

    print("2. INGEST", flush=True)
    bundles = sorted(str(p) for p in BUNDLES.glob("*.mko"))
    if not bundles:
        raise SystemExit(f"no bundles in {BUNDLES} — run without --skip-export")
    _step("ingest", _run([".venv/bin/python", "scripts/ingest_mko.py", *bundles]))

    if dry:
        m = missing_contexts()
        print(f"[dry] contexts missing: {m}; chunks: "
              f"{sum(1 for _ in (ARTIFACTS / 'mko_chunks.jsonl').open())}", flush=True)
        return

    print("3. ENRICH (rounds until coverage)", flush=True)
    for rnd in range(1, ENRICH_ROUNDS + 1):
        m = missing_contexts()
        if m == 0:
            print(f"  coverage complete after {rnd - 1} enrichment round(s)", flush=True)
            break
        print(f"  round {rnd}: {m} chunks missing contexts", flush=True)
        r = _run([".venv/bin/python", "-m", "ingest.cli", "enrich",
                  "--rpm", "45", "--batch", "5", "--concurrency", "3"],
                 extra_env={"ENRICH_SOURCE": "artifacts/mko_chunks.jsonl"})
        _step(f"enrich-{rnd}", r)
    else:
        raise SystemExit(f"enrichment coverage incomplete after {ENRICH_ROUNDS} rounds — investigate")

    print("4. GATE (verify)", flush=True)
    _step("verify", _run([".venv/bin/python", "scripts/wire_mko.py", "--verify"]))

    print("5. WIRE (embed+upsert+retire)", flush=True)
    if not os.environ.get("CLOUDFLARE_API_TOKEN"):
        raise SystemExit(
            "WIRE needs CLOUDFLARE_API_TOKEN (Vectorize REST). Export it in your shell "
            "and re-run with --skip-export (earlier stages are idempotent). "
            "NOTE: if enrichment just ran, the /admin/enrich endpoint already upserted "
            "enriched vectors live — the wire stage then only matters for id bookkeeping."
        )
    _step("wire", _run([".venv/bin/python", "scripts/wire_mko.py", "--embed", "--reembed"],
                       extra_env={"VECTORIZE_INDEX": "idx_oiml_public_v2"}))

    if not skip_fts:
        print("6. LEXICAL (D1 FTS reload)", flush=True)
        _step("fts", _run([".venv/bin/python", "-m", "ingest.cli", "fts"]))

    if not skip_graph:
        print("7. GRAPH (D1 apply)", flush=True)
        sql = ARTIFACTS / "mko_graph.sql"
        lines = sql.read_text(encoding="utf-8").splitlines(keepends=True)
        with tempfile.TemporaryDirectory() as td:
            parts = []
            for i in range(0, len(lines), 2000):
                p = Path(td) / f"g{i}.sql"
                p.write_text("".join(lines[i : i + 2000]))
                parts.append(p)
            for p in parts:
                r = subprocess.run(
                    ["npx", "wrangler", "d1", "execute", "rag-public", "--remote",
                     "--file", str(p), "-c", "workers/worker_public/wrangler.toml"],
                    cwd=ROOT, capture_output=True, text=True,
                    env={**os.environ, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT},
                )
                _step(f"graph {p.name}", r)
                time.sleep(2)

    print("\nREADY TO SHIP — human steps:", flush=True)
    print("  1. bump INDEX_VERSION in workers/worker_public/wrangler.toml", flush=True)
    print("  2. wrangler deploy (workers/worker_public)", flush=True)
    print("  3. node tests/e2e.mjs && node tests/retrieval.mjs --save <tag>", flush=True)
