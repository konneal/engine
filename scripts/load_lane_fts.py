"""Load comparison-lane FTS rows into the rag-comparison D1 (EXP_DB).

The /v1/lane endpoint's lexical leg reads chunks_<lane> joined against
chunks_<lane>_fts; only the primmel lane was ever loaded (190 rows).
This loads every lane's artifact rows (raw source text — the lexical
lane matches on producer text, matching how primmel was loaded).
Idempotent per lane: DELETE + INSERT OR REPLACE via the fts triggers.
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

ARTIFACTS = Path("artifacts")
LANES = {
    "plain": "exp_plain_chunks.jsonl",
    "adoc": "exp_adoc_chunks.jsonl",
    "mko": "exp_mko_chunks.jsonl",
    "primmel_flat": "primmel_flat_chunks.jsonl",
    "composed": "exp_composed_chunks.jsonl",
}
ENV = dict(os.environ)


def run_sql(path: Path) -> None:
    r = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "rag-comparison", "--remote",
         "--file", str(path), "-c", "workers/worker_public/wrangler.toml"],
        capture_output=True, text=True, timeout=600, env=ENV, stdin=subprocess.DEVNULL,
    )
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout)[-200:])


def esc(s) -> str:
    return (s or "").replace("'", "''")


def main() -> int:
    for lane, fname in LANES.items():
        rows = [json.loads(l) for l in (ARTIFACTS / fname).open()]
        stmts = [f"DELETE FROM chunks_{lane};"]
        for rec in rows:
            m = rec.get("metadata", {})
            text = (m.get("chunk_text") or rec.get("text") or "")[:4000]
            fts = f"{m.get('docidentifier','')} {m.get('clause_title','')} {text}"[:6000]
            stmts.append(
                f"INSERT OR REPLACE INTO chunks_{lane} (id, doc_id, docidentifier, doctype, doc_number, edition, language, clause_anchor, clause_title, status, superseded_by, corpus, tier, text, fts_text, unit_id, block, source_lane, linked_clause) VALUES ("
                f"'{esc(rec['id'])}','{esc(m.get('doc_id'))}','{esc(m.get('docidentifier'))}','{esc(m.get('doctype'))}',"
                f"'{esc(m.get('doc_number'))}','{esc(m.get('edition'))}','{esc(m.get('language'))}','{esc(m.get('clause_anchor'))}',"
                f"'{esc(m.get('clause_title'))}','{esc(m.get('status'))}','{esc(m.get('superseded_by'))}','{esc(m.get('corpus'))}',"
                f"'{esc(m.get('tier'))}','{esc(text)}','{esc(fts)}','{esc(m.get('unit_id'))}','{esc(m.get('block'))}',"
                f"'{esc(m.get('source_lane'))}','{esc(m.get('linked_clause'))}');"
            )
        batch = 100
        for i in range(0, len(stmts), batch):
            with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as tf:
                tf.write("\n".join(stmts[i : i + batch]) + "\n")
                p = Path(tf.name)
            run_sql(p)
            p.unlink()
            print(f"  {lane}: {min(i + batch, len(stmts))}/{len(stmts)} stmts", flush=True)
        print(f"lane {lane}: {len(rows)} rows loaded", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
