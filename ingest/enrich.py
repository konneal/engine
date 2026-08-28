"""Contextual enrichment driver (quality-first lane, CLAUDE.md model policy).

Feeds chunks from artifacts/chunks.jsonl to the deployed /admin/enrich
endpoint in small batches. The endpoint writes a situating context
(KV-cached per chunk id), embeds context+text, and upserts the chunk in
place — the enrichment persists into every future retrieval of that
chunk. This driver owns batching, concurrency, retries, cost accounting,
and resumability:

  - artifacts/enrich-state.json        done chunk ids (resume across runs)
  - artifacts/enriched-contexts.jsonl  durable record of every context

Usage:
  .venv/bin/python -m ingest.cli enrich --limit 100   # pilot
  .venv/bin/python -m ingest.cli enrich               # full run, resumable

Requires ADMIN_TOKEN in .env (the same secret the worker checks).
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx

from .config import ARTIFACTS

CHUNKS_PATH = Path(os.environ.get("ENRICH_SOURCE", ARTIFACTS / "chunks.jsonl"))
STATE_PATH = ARTIFACTS / "enrich-state.json"
RECORDS_PATH = ARTIFACTS / "enriched-contexts.jsonl"

# authored overview chunks (corpus=synthetic) already carry situating text
SKIP_CORPORA = {"synthetic"}

# USD per M tokens (in, out) — deepseek-v4-pro-0813 lane estimate
PRICE = (1.40, 4.40)


def _dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return out


def load_done() -> set[str]:
    try:
        return set(json.loads(STATE_PATH.read_text())["done"])
    except Exception:  # noqa: BLE001
        return set()


class State:
    def __init__(self) -> None:
        self.done: set[str] = load_done()
        self.lock = threading.Lock()
        self.recs: list[str] = []
        self.usage = {"prompt_tokens": 0, "completion_tokens": 0, "requests": 0, "cache_hits": 0}
        self.failed: list[tuple[str, str]] = []
        self.count = 0

    def snapshot(self) -> None:
        with self.lock:
            tmp = STATE_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps({"done": sorted(self.done)}))
            tmp.replace(STATE_PATH)
            recs, self.recs = self.recs, []
            usage = dict(self.usage)
            count, failed = self.count, list(self.failed)
        if recs:
            with RECORDS_PATH.open("a") as f:
                f.write("\n".join(recs) + "\n")
        return usage, count, failed


class Pace:
    """Global submission gate: cap enrichment requests per minute —
    Workers AI 3021s when the account's inference rate is exceeded."""

    def __init__(self, rpm: int, batch: int) -> None:
        self.gap = 60.0 / max(1, rpm / max(1, batch))
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self) -> None:
        with self.lock:
            now = time.time()
            delay = self.next_at - now
            self.next_at = max(now, self.next_at + self.gap)
        if delay > 0:
            time.sleep(delay)


def run(limit: int | None = None, batch: int = 5, concurrency: int = 3, force: bool = False, rpm: int = 45) -> int:
    env = {**os.environ, **_dotenv(ARTIFACTS.parent / ".env")}
    base = env.get("RAG_BASE", "https://ai.oimlsmart.org").rstrip("/")
    token = env.get("ADMIN_TOKEN")
    if not token:
        print("ADMIN_TOKEN missing (set it in .env)")
        return 1

    done = load_done()
    todo: list[dict] = []
    with CHUNKS_PATH.open() as f:
        for line in f:
            r = json.loads(line)
            if r["metadata"].get("corpus") in SKIP_CORPORA or r["id"] in done:
                continue
            todo.append({"id": r["id"], "text": r["text"], "metadata": r["metadata"]})
            if limit and len(todo) >= limit:
                break
    total = len(todo)
    print(f"chunks to enrich: {total} (skipped: synthetic + {len(done)} already done)")

    st = State()
    batches = [todo[i : i + batch] for i in range(0, total, batch)]
    pace = Pace(rpm, batch)
    client = httpx.Client(timeout=300.0)
    t0 = time.time()

    def send(chunk_batch: list[dict]) -> None:
        last = ""
        for attempt in range(4):
            pace.wait()
            try:
                r = client.post(
                    f"{base}/admin/enrich",
                    json={"chunks": chunk_batch, "force": force},
                    headers={"authorization": f"Bearer {token}"},
                )
                if r.status_code == 200:
                    data = r.json()
                    rate_limited = sum(
                        1 for x in data.get("results", []) if "rate limit" in str(x.get("error", "")).lower() or "3021" in str(x.get("error", ""))
                    )
                    if rate_limited >= max(1, len(chunk_batch) // 2):
                        time.sleep((30, 60, 90)[min(2, attempt)])
                        last = f"rate limited ({rate_limited}/{len(chunk_batch)})"
                        continue
                    with st.lock:
                        for k in st.usage:
                            st.usage[k] += data.get("usage", {}).get(k, 0)
                        st.count += len(chunk_batch)
                    for res in data.get("results", []):
                        if res.get("ok"):
                            with st.lock:
                                st.done.add(res["id"])
                                st.recs.append(json.dumps({"id": res["id"], "context": res.get("context", "")}, ensure_ascii=False))
                        else:
                            with st.lock:
                                st.failed.append((str(res.get("id")), str(res.get("error", "?"))))
                    return
                last = f"HTTP {r.status_code}: {r.text[:120]}"
            except Exception as e:  # noqa: BLE001
                last = str(e)[:120]
            time.sleep((2, 10, 30)[min(2, attempt)])
        with st.lock:
            st.failed.extend((c["id"], last) for c in chunk_batch)

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(send, b) for b in batches]
        for i, fut in enumerate(as_completed(futures), 1):
            fut.result()
            if i % 10 == 0 or i == len(batches):
                usage, count, failed = st.snapshot()
                el = time.time() - t0
                rate = count / el if el else 0.0
                eta = (total - count) / rate / 60 if rate else 0.0
                cost = (usage["prompt_tokens"] * PRICE[0] + usage["completion_tokens"] * PRICE[1]) / 1e6
                print(
                    f"  {count}/{total} | {rate:.1f} c/s | ETA {eta:.0f}m | "
                    f"tok in/out {usage['prompt_tokens']}/{usage['completion_tokens']} | ~${cost:.2f} | failed {len(failed)}",
                    flush=True,
                )
    usage, count, failed = st.snapshot()
    cost = (usage["prompt_tokens"] * PRICE[0] + usage["completion_tokens"] * PRICE[1]) / 1e6
    print(f"done: {count} ok, {len(failed)} failed | tok in/out {usage['prompt_tokens']}/{usage['completion_tokens']} | cache hits {usage['cache_hits']} | ~${cost:.2f}")
    if usage["prompt_tokens"] and count:
        projection = cost / count * 31162
        print(f"observed cost/chunk ~${cost / count:.5f} — full 31k corpus projection: ~${projection:.0f}")
    for cid, e in failed[:10]:
        print(f"  FAILED {cid}: {e}")
    return 0 if not failed else 2


if __name__ == "__main__":
    sys.exit(run())
