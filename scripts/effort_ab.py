#!/usr/bin/env python3
"""Enrichment effort A/B (TODO.impl/62, the V4.1-report experiment).

Compares contextual enrichment generated at LOW vs HIGH reasoning effort
on the same chunks, judged pairwise by a strong independent model. The
enrichment lane is a one-time quality-first pass, so its quality
persists into every future retrieval — a measured win here compounds.

Side-effect free by construction: /admin/enrich mode:"ab" generates
without reading or writing the KV context cache and without touching
the index.

Usage:
    .venv/bin/python scripts/effort_ab.py [--n 100] [--judge-n 60]

Writes artifacts/effort-ab/results.jsonl (both variants per chunk) and
artifacts/effort-ab/report.md (win rates, lengths, token costs).
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingest.config import ARTIFACTS  # noqa: E402

BASE = "https://ai.oimlsmart.org"
OUT = ARTIFACTS / "effort-ab"
JUDGE_PROMPT = Path(__file__).with_name("effort_ab_judge.md").read_text()
# the promotion-gate judge lane: strongest model, never the generator
JUDGE_MODEL = "@cf/deepseek-ai/deepseek-v4-pro-0813"


def token_from_env() -> str:
    env = (Path(__file__).resolve().parents[1] / ".env").read_text()
    for line in env.splitlines():
        if line.startswith("ADMIN_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"')
    sys.exit("ADMIN_TOKEN missing from .env")


def enrich_pair(admin: httpx.Client, chunk: dict) -> dict | None:
    body = {"mode": "ab", "effort": None, "chunks": [
        {"id": chunk["id"], "text": chunk["text"][:1500], "metadata": {
            k: v for k, v in chunk["metadata"].items() if isinstance(v, (str, int, float, bool))
        }}
    ]}
    out = {}
    for effort in ("low", "high"):
        body["effort"] = effort
        r = admin.post("/admin/enrich", json=body)
        if r.status_code != 200:
            print(f"  enrich {effort} failed at {chunk['id']}: {r.status_code}", flush=True)
            return None
        res = (r.json().get("results") or [{}])[0]
        if not res.get("ok"):
            return None
        out[effort] = res.get("context") or ""
    return out


def judge_pair(admin: httpx.Client, chunk: dict, low: str, high: str) -> str:
    import random as _r

    # blind the order so position bias cannot favor a lane
    a_low = _r.random() < 0.5
    ca, cb = (low, high) if a_low else (high, low)
    user = (
        f"Locator: {chunk['metadata'].get('docidentifier', '')} §{chunk['metadata'].get('clause_anchor', '')}\n\n"
        f"Chunk text:\n{chunk['text'][:1500]}\n\n"
        f"Candidate A:\n{ca}\n\nCandidate B:\n{cb}"
    )
    # the judge rides the deployed binding lane: the REST ai/run token
    # 401-flakes on this account, the worker binding does not
    body = {
        "mode": "ab", "effort": "low", "prompt": JUDGE_PROMPT.strip(), "user_text": user,
        "chunks": [{"id": "judge", "text": "x", "metadata": {"corpus": "synthetic", "doc_id": "judge"}}],
    }
    r = admin.post("/admin/enrich", json=body)
    r.raise_for_status()
    res = (r.json().get("results") or [{}])[0]
    text = res.get("context") or ""
    line = text.strip().splitlines()[0].strip() if text.strip() else "TIE — no answer"
    first = line.split("—")[0].strip().upper()
    if first == "A":
        return "low" if a_low else "high"
    if first == "B":
        return "high" if a_low else "low"
    return "tie"


def main() -> int:
    global _ACCOUNT
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=100, help="chunks to compare")
    ap.add_argument("--judge-n", type=int, default=60, help="pairs to judge (subset)")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    from ingest.cf import ACCOUNT_ID  # noqa: PLC0415,F401 — kept for parity with other tools

    _ACCOUNT = ACCOUNT_ID
    OUT.mkdir(parents=True, exist_ok=True)
    token = token_from_env()
    admin = httpx.Client(
        base_url=BASE,
        headers={"Authorization": f"Bearer {token}", "user-agent": "oiml-effort-ab/1.0"},
        timeout=httpx.Timeout(420.0),  # high-effort generation on v4-pro can exceed 3 minutes
    )

    results = []
    chunks = []
    for line in (ARTIFACTS / "chunks.jsonl").open(encoding="utf-8"):
        d = json.loads(line)
        if (d["metadata"].get("corpus") or "") != "synthetic":
            chunks.append(d)
    random.seed(args.seed)
    sample = random.sample(chunks, args.n)

    # incremental and resumable: each completed pair is appended, and a
    # rerun skips ids already compared (a timeout mid-run must not lose
    # the hour of generation it already paid for)
    results_path = OUT / "results.jsonl"
    done: set[str] = set()
    if results_path.exists():
        for line in results_path.open(encoding="utf-8"):
            results_path_line = json.loads(line)
            results.append(results_path_line)
            done.add(results_path_line["id"])
    with results_path.open("a", encoding="utf-8") as sink:
        for i, c in enumerate(sample):
            if c["id"] in done:
                continue
            pair = None
            for attempt in range(3):
                try:
                    pair = enrich_pair(admin, c)
                except Exception as e:  # noqa: BLE001 — transport flake: ladder, then give up on the chunk
                    print(f"  enrich transport error at {c['id']}: {type(e).__name__}", flush=True)
                    pair = None
                if pair:
                    break
                time.sleep(5 * (attempt + 1))
            if not pair:
                continue
            row = {"id": c["id"], "locator": f"{c['metadata'].get('docidentifier', '')} §{c['metadata'].get('clause_anchor', '')}", **pair}
            results.append(row)
            done.add(row["id"])
            sink.write(json.dumps(row) + "\n")
            sink.flush()
            if len(done) % 20 == 0:
                print(f"  enriched {len(done)}/{args.n}", flush=True)
    print(f"pairs: {len(results)}")

    judged = random.sample(results, min(args.judge_n, len(results)))
    sample_by_id = {c["id"]: c for c in sample}
    wins = {"low": 0, "high": 0, "tie": 0}
    for i, r in enumerate(judged):
        for attempt in range(4):
            try:
                wins[judge_pair(admin, sample_by_id.get(r["id"], {"metadata": {}, "text": ""}), r["low"], r["high"])] += 1
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 3:
                    wins["tie"] += 1
                    print(f"  judge failed at {r['id']}: {e}", flush=True)
                time.sleep(5 * (attempt + 1))
        if (i + 1) % 15 == 0:
            print(f"  judged {i + 1}/{len(judged)}", flush=True)

    n = len(judged) or 1
    lines = [
        "# Enrichment effort A/B",
        "",
        f"- chunks compared: {len(results)} · judged: {len(judged)} (seed {args.seed})",
        f"- LOW wins: {wins['low']} ({wins['low'] * 100 // n}%) · HIGH wins: {wins['high']} ({wins['high'] * 100 // n}%) · ties: {wins['tie']} ({wins['tie'] * 100 // n}%)",
        f"- mean preamble length — low: {sum(len(r['low']) for r in results) // max(1, len(results))} chars · high: {sum(len(r['high']) for r in results) // max(1, len(results))} chars",
        "",
        "Judge lane: " + JUDGE_MODEL + " via the worker binding (blind order). Generation lane: /admin/enrich mode:ab (no side effects).",
    ]
    (OUT / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
