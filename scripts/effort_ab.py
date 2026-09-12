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


def judge_pair(cf, chunk: dict, low: str, high: str) -> str:
    import random as _r

    # blind the order so position bias cannot favor a lane
    a_low = _r.random() < 0.5
    ca, cb = (low, high) if a_low else (high, low)
    user = (
        f"Locator: {chunk['metadata'].get('docidentifier', '')} §{chunk['metadata'].get('clause_anchor', '')}\n\n"
        f"Chunk text:\n{chunk['text'][:1500]}\n\n"
        f"Candidate A:\n{ca}\n\nCandidate B:\n{cb}"
    )
    body = {
        "messages": [
            {"role": "system", "content": JUDGE_PROMPT.strip()},
            {"role": "user", "content": user},
        ],
        "max_tokens": 4096,
    }
    r = cf._post(f"https://api.cloudflare.com/client/v4/accounts/{_ACCOUNT}/ai/run/{JUDGE_MODEL}", body)
    text = ""
    result = r.get("result", r)
    if isinstance(result, dict):
        text = result.get("response") or (result.get("choices") or [{}])[0].get("message", {}).get("content", "")
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

    from ingest.cf import ACCOUNT_ID, CF  # noqa: PLC0415

    _ACCOUNT = ACCOUNT_ID
    OUT.mkdir(parents=True, exist_ok=True)
    token = token_from_env()
    admin = httpx.Client(
        base_url=BASE,
        headers={"Authorization": f"Bearer {token}", "user-agent": "oiml-effort-ab/1.0"},
        timeout=httpx.Timeout(180.0),
    )

    chunks = [
        json.loads(l) for l in (ARTIFACTS / "chunks.jsonl").open(encoding="utf-8")
        if (json.loads(l)["metadata"].get("corpus") or "") != "synthetic"
    ]
    random.seed(args.seed)
    sample = random.sample(chunks, args.n)

    results = []
    for i, c in enumerate(sample):
        pair = None
        for attempt in range(3):
            pair = enrich_pair(admin, c)
            if pair:
                break
            time.sleep(3 * (attempt + 1))
        if not pair:
            continue
        row = {"id": c["id"], "locator": f"{c['metadata'].get('docidentifier', '')} §{c['metadata'].get('clause_anchor', '')}", **pair}
        results.append(row)
        if (i + 1) % 20 == 0:
            print(f"  enriched {i + 1}/{args.n}", flush=True)
    (OUT / "results.jsonl").write_text("\n".join(json.dumps(r) for r in results) + "\n", encoding="utf-8")
    print(f"pairs: {len(results)}")

    cf = CF()
    judged = random.sample(results, min(args.judge_n, len(results)))
    wins = {"low": 0, "high": 0, "tie": 0}
    for i, r in enumerate(judged):
        for attempt in range(4):
            try:
                wins[judge_pair(cf, next(c for c in sample if c["id"] == r["id"]), r["low"], r["high"])] += 1
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
        "Judge lane: " + JUDGE_MODEL + " (blind order). Generation lane: /admin/enrich mode:ab (no side effects).",
    ]
    (OUT / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
