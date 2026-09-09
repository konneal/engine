"""The model plane (TODO.ai-platform/05): the SMART Recommendation MODELS
join the retrieval.

The packages' machine content — the requirements' constraints, the
applicability rules, the acceptance criteria, the conformance tests, the
term definitions, the subject constraints, the characteristics, the state
machines — indexes ALONGSIDE the prose corpus. The index DERIVES from the
primmel packages (the single source of truth), never a hand-copied
extract: the smart repo's derive-model-plane.ts projects the packages into
committed bundles (browser/public/data/model-plane/*.json — byte-clean-
guarded by its ssot direction 4), and this module consumes those bundles
from the sibling smart checkout (SMART_REPO env; the estate's cross-repo
pattern — every upstream is a read-only sibling).

The freshness gate (the wave's must-pass leg): every bundle carries a
per-standard `source_hash` — a content hash over the primmel package. The
committed pins (ingest/model_plane_pins.json) record WHAT the index
derived from. `model-plane --check` compares: a package change moves the
hash, the gate exits 1, and the index is honestly stale until a re-index
(`python -m ingest.cli model-plane`) lands and refreshes the pins.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from .config import ARTIFACTS

MODEL_CHUNKS_PATH = ARTIFACTS / "model_typed_chunks.jsonl"
MODEL_NODES_PATH = ARTIFACTS / "model_nodes.jsonl"
PINS_PATH = Path(__file__).resolve().parent / "model_plane_pins.json"

# Vectorize metadata caps (25 attrs/vector on the current plan); the
# model-node keys join the standard chunk keys well under the cap.
MAX_TEXT = 1800


BUNDLES_INDEX = "browser/public/data/model-plane/index.json"


def _sibling_candidates() -> list[Path]:
    """The estate's sibling layout: the checkout next to this repo, then
    the canonical ~/src/oimlsmart/smart."""
    return [Path(__file__).resolve().parents[2] / "smart", Path.home() / "src/oimlsmart/smart"]


def smart_repo_candidates() -> list[Path]:
    declared = os.environ.get("SMART_REPO", "").strip()
    cands = ([Path(declared)] if declared else []) + _sibling_candidates()
    # the sibling next to this repo can BE ~/src/oimlsmart/smart (the
    # estate layout) — name each real candidate once
    out: list[Path] = []
    seen: set[str] = set()
    for c in cands:
        key = str(c.resolve())
        if key not in seen:
            seen.add(key)
            out.append(c)
    return out


def _has_bundles(repo: Path) -> bool:
    return (repo / BUNDLES_INDEX).is_file()


def _git_branch(repo: Path) -> str:
    """The checkout's current branch, read straight from .git/HEAD (no
    subprocess; worktree .git files resolved). '' when unreadable."""
    git = repo / ".git"
    try:
        head = git / "HEAD"
        if git.is_file():
            # worktree/submodule: '.git' holds 'gitdir: <path>'
            line = git.read_text(encoding="utf-8").strip()
            if not line.startswith("gitdir:"):
                return ""
            gitdir = Path(line.split(":", 1)[1].strip())
            head = (repo / gitdir if not gitdir.is_absolute() else gitdir) / "HEAD"
        ref = head.read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    if ref.startswith("ref: refs/heads/"):
        return ref.removeprefix("ref: refs/heads/")
    if re.fullmatch(r"[0-9a-f]{40}", ref):
        return f"detached @ {ref[:12]}"
    return ""


def _display(path: Path) -> str:
    home = str(Path.home())
    s = str(path)
    return "~" + s[len(home):] if s.startswith(home + os.sep) else s


def smart_repo(candidates: list[Path] | None = None) -> Path | None:
    """The smart checkout: SMART_REPO, else the estate's sibling layout —
    the first candidate carrying the committed model-plane bundles."""
    for c in (smart_repo_candidates() if candidates is None else candidates):
        if _has_bundles(c):
            return c
    return None


def smart_repo_diagnosis(candidates: list[Path] | None = None) -> str:
    """Why no candidate qualified — per-candidate detail so a checkout that
    EXISTS but lacks the bundles (parked on a legacy branch) is named with
    its branch instead of vanishing into a generic SKIP (the misread that
    produced oimlsmart/smart#252)."""
    cands = smart_repo_candidates() if candidates is None else candidates
    notes = []
    for c in cands:
        if not c.is_dir():
            notes.append(f"{_display(c)} does not exist")
            continue
        branch = _git_branch(c)
        where = f" (branch {branch})" if branch else ""
        notes.append(f"found {_display(c)}{where} but no {BUNDLES_INDEX} — not a v2 checkout carrying the committed bundles")
    if not notes:
        return "no candidates at all"
    if all(not c.is_dir() for c in cands):
        return "; ".join(notes)
    return "; ".join(notes) + " — declare SMART_REPO to a v2 checkout"


def load_bundles(repo: Path) -> dict[str, dict]:
    plane_dir = repo / "browser/public/data/model-plane"
    index = json.loads((plane_dir / "index.json").read_text(encoding="utf-8"))
    out: dict[str, dict] = {}
    for entry in index["standards"]:
        bundle = json.loads((plane_dir / entry["file"]).read_text(encoding="utf-8"))
        bundle["_plane"] = index.get("plane")
        out[bundle["standard"]] = bundle
    return out


def _urn_parts(base_urn: str) -> tuple[str, str, str]:
    # urn:oiml:pub:r:60:2021 → ("r", "60", "2021")
    m = re.match(r"^urn:oiml:pub:([rdbge]):(\d{1,3})(?::(\d{4}))?$", base_urn or "", re.I)
    if not m:
        return "", "", ""
    return m.group(1).lower(), m.group(2), m.group(3) or ""


def _clip(s: str | None, n: int = 600) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + " …"


def _app_text(app: dict | None) -> str:
    if not app:
        return ""
    parts = []
    for dim, cond in app.items():
        if isinstance(cond, list):
            parts.append(f"{dim.replace('_', ' ')}: {', '.join(map(str, cond))}")
        elif isinstance(cond, dict) and isinstance(cond.get("values"), list):
            mode = cond.get("match", "any")
            parts.append(f"{dim.replace('_', ' ')} ({mode}): {', '.join(map(str, cond['values']))}")
    return "; ".join(parts)


def node_text(standard: str, bundle: dict, node: dict) -> str:
    """The grounding text for one model node — the node's OWN declared
    content, composed deterministically (nothing paraphrased)."""
    kind = node["kind"]
    label = bundle.get("label") or standard
    clause = node.get("clause") or {}
    head = f"[OIML SMART model — {kind.replace('_', ' ')}] {node.get('name') or node['id']} ({node['id']})"
    prov = label
    if clause.get("urn"):
        prov += f" · provenance {clause['urn']}"
    lines = [head, prov]
    if node.get("statement"):
        lines.append(f"Statement: {_clip(node['statement'])}")
    if node.get("definition"):
        lines.append(f"Definition: {_clip(node['definition'])}")
    if node.get("purpose"):
        lines.append(f"Purpose: {_clip(node['purpose'])}")
    if node.get("method"):
        lines.append(f"Method: {_clip(node['method'], 400)}")
    limit = node.get("limit") or {}
    if limit.get("expression"):
        lines.append(f"Machine limit (the constraint the platform's verdict engine evaluates): {limit['expression']}")
    if limit.get("accepts"):
        a = limit["accepts"]
        lines.append(f"Machine limit: {a.get('verdict')} {a.get('op')} {a.get('limit')} (canonical acceptance)")
    if node.get("check"):
        lines.append(f"Machine check: {node['check']}")
    if node.get("derive"):
        lines.append(f"Derivation: {node['derive']} (inputs: {', '.join(node.get('inputs') or [])})")
    app = _app_text(node.get("applicability"))
    if app:
        lines.append(f"Applicability: {app}")
    if node.get("binds_to"):
        lines.append(f"Binds to: {', '.join(node['binds_to'])}")
    if node.get("targets"):
        lines.append(f"Verifies requirements: {', '.join(node['targets'])}")
    if node.get("preconditions"):
        pcs = "; ".join(f"{p.get('id')}: {_clip(p.get('check') or ('state = ' + p['state'] if p.get('state') else ''), 120)}" for p in node["preconditions"])
        lines.append(f"Run-validity preconditions (a violation voids the run, never a fail): {pcs}")
    ac = node.get("acceptance_criteria") or {}
    if ac.get("description"):
        lines.append(f"Acceptance: {_clip(ac['description'], 300)}")
    if node.get("violation_meaning"):
        lines.append(f"Violation meaning (verbatim): {_clip(node['violation_meaning'], 300)} — on violation: {node.get('on_violation')}")
    if node.get("states"):
        trans = "; ".join(f"{t.get('from')}→{t.get('to')} ({t.get('action')})" for t in node.get("transitions") or [])
        lines.append(f"States: {', '.join(node['states'])}. Transitions: {_clip(trans, 400)}")
    if node.get("values"):
        vals = "; ".join(f"{v.get('id')}{' implies ' + ', '.join(v['implies']) if v.get('implies') else ''}" for v in node["values"])
        lines.append(f"Values: {_clip(vals, 400)}")
    if node.get("source_discrepancy"):
        sd = node["source_discrepancy"]
        lines.append(
            "DECLARED SOURCE DISCREPANCY (the model and the text disagree — always surface this and cite both): "
            + _clip(sd.get("summary"), 300)
            + f" Sources: {', '.join(sd.get('sources') or [])}. Resolution: {sd.get('resolution')} — {_clip(sd.get('rationale'), 300)}"
        )
    return "\n".join(lines)[:MAX_TEXT]


def node_chunk(standard: str, bundle: dict, node: dict) -> dict:
    doctype, doc_number, edition = _urn_parts(bundle.get("base_urn") or "")
    clause = node.get("clause") or {}
    cid = "m" + hashlib.sha1(f"{standard}|{node['id']}".encode()).hexdigest()[:16]
    text = node_text(standard, bundle, node)
    return {
        "id": cid,
        "doc_id": f"model:{standard}",
        "chunk_ref": f"{standard}{node['id']}",
        "text": text,
        "metadata": {
            "chunk_text": text,
            "doc_id": f"model:{standard}",
            "docidentifier": bundle.get("label") or standard,
            "doctype": doctype,
            "doc_number": doc_number,
            "edition": edition,
            "language": "en",
            "clause_anchor": clause.get("clause") or "model",
            "clause_title": f"{node['kind'].replace('_', ' ').title()} — {node.get('name') or node['id']}",
            "tier": "curated",
            "corpus": "smart-model",
            "status": "in-force",
            "superseded_by": "",
            "text_ref": f"model-plane/{standard}{node['id']}",
            "model_node": node["id"],
            "model_kind": node["kind"],
            "standard": standard,
        },
    }


def build(repo: Path, *, write_pins: bool = True) -> dict:
    """Emit the model-plane artifacts from the smart checkout's bundles."""
    bundles = load_bundles(repo)
    ARTIFACTS.mkdir(exist_ok=True)
    n_chunks = 0
    with MODEL_CHUNKS_PATH.open("w", encoding="utf-8") as f:
        for standard, bundle in sorted(bundles.items()):
            for node in bundle["nodes"]:
                f.write(json.dumps(node_chunk(standard, bundle, node), ensure_ascii=False) + "\n")
                n_chunks += 1
    n_nodes = 0
    with MODEL_NODES_PATH.open("w", encoding="utf-8") as f:
        for standard, bundle in sorted(bundles.items()):
            for node in bundle["nodes"]:
                content = json.dumps(node, ensure_ascii=False, sort_keys=True)
                clause = node.get("clause") or {}
                f.write(
                    json.dumps(
                        {
                            "standard": standard,
                            "node_id": node["id"],
                            "kind": node["kind"],
                            "name": node.get("name") or node["id"],
                            "clause_doc": clause.get("doc") or "",
                            "clause_ref": clause.get("clause") or "",
                            "content": content,
                            "content_hash": hashlib.sha256(content.encode()).hexdigest(),
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                n_nodes += 1
    pins = {
        "plane": next(iter(bundles.values()), {}).get("_plane"),
        "standards": {
            s: {"source_hash": b["source_hash"], "node_count": len(b["nodes"])}
            for s, b in sorted(bundles.items())
        },
    }
    if write_pins:
        PINS_PATH.write_text(json.dumps(pins, indent=1) + "\n", encoding="utf-8")
    print(f"model-plane: {n_chunks} chunks + {n_nodes} nodes from {len(bundles)} standards")
    return pins


def check(repo: Path) -> int:
    """The freshness gate: the pinned source ≡ the smart checkout's current
    bundles. A package change moves a source_hash — the index is honestly
    stale until a re-index lands. Exit 1 on drift, 0 when current."""
    if not PINS_PATH.is_file():
        print("model-plane freshness: NO PINS — the model plane was never indexed (run python -m ingest.cli model-plane)")
        return 1
    pins = json.loads(PINS_PATH.read_text(encoding="utf-8"))
    bundles = load_bundles(repo)
    plane = next(iter(bundles.values()), {}).get("_plane")
    stale: list[str] = []
    if pins.get("plane") != plane:
        stale.append(f"the bundle shape moved ({pins.get('plane')} → {plane})")
    for standard, bundle in sorted(bundles.items()):
        pin = (pins.get("standards") or {}).get(standard)
        if not pin:
            stale.append(f"{standard}: never indexed")
            continue
        if pin.get("source_hash") != bundle["source_hash"]:
            stale.append(f"{standard}: the package moved (hash {pin.get('source_hash', '')[:12]}… → {bundle['source_hash'][:12]}…)")
        elif pin.get("node_count") != len(bundle["nodes"]):
            stale.append(f"{standard}: node count moved ({pin.get('node_count')} → {len(bundle['nodes'])})")
    for standard in (pins.get("standards") or {}):
        if standard not in bundles:
            stale.append(f"{standard}: indexed but no longer in the bundles")
    if stale:
        print("model-plane freshness: STALE — a package change re-indexes:")
        for s in stale:
            print(f"  ✗ {s}")
        print("re-index: .venv/bin/python -m ingest.cli model-plane  (then embed + upsert + the D1 apply)")
        return 1
    print(f"model-plane freshness: current ({len(bundles)} standards, pins ≡ bundles)")
    return 0


def _run_sql(path: Path) -> None:
    from .fts import _run_sql as fts_run_sql

    fts_run_sql(path)


def _esc(s) -> str:
    # bundle fields can arrive as lists (observed: two dead_load geometry
    # constraint names) — serialize anything non-string verbatim
    return (s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)).replace("'", "''")


def apply() -> None:
    """Load model_nodes + model_plane_meta into D1 (the deterministic
    model-node store the ask path binds chips against). Idempotent:
    per-standard replace, meta upserted from the pins."""
    if not MODEL_NODES_PATH.is_file():
        raise SystemExit("run `model-plane` (build) first")
    pins = json.loads(PINS_PATH.read_text(encoding="utf-8")) if PINS_PATH.is_file() else {}
    rows = [json.loads(l) for l in MODEL_NODES_PATH.open(encoding="utf-8")]
    standards = sorted({r["standard"] for r in rows})
    statements = [f"DELETE FROM model_nodes WHERE standard IN ({', '.join(repr(s) for s in standards)});", "DELETE FROM model_plane_meta;"]
    for r in rows:
        statements.append(
            "INSERT OR REPLACE INTO model_nodes (standard, node_id, kind, name, clause_doc, clause_ref, content, content_hash) VALUES ("
            f"'{_esc(r['standard'])}','{_esc(r['node_id'])}','{_esc(r['kind'])}','{_esc(r['name'])}',"
            f"'{_esc(r['clause_doc'])}','{_esc(r['clause_ref'])}','{_esc(r['content'])}','{_esc(r['content_hash'])}');"
        )
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    for standard in standards:
        pin = (pins.get("standards") or {}).get(standard) or {}
        statements.append(
            "INSERT OR REPLACE INTO model_plane_meta (standard, package, plane, source_hash, node_count, indexed_at) VALUES ("
            f"'{_esc(standard)}','{_esc(standard)}','{_esc(str(pins.get('plane') or ''))}',"
            f"'{_esc(str(pin.get('source_hash') or ''))}',{int(pin.get('node_count') or 0)},'{_esc(now)}');"
        )
    batch = 40
    for i in range(0, len(statements), batch):
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as tf:
            tf.write("\n".join(statements[i : i + batch]) + "\n")
            bpath = Path(tf.name)
        print(f"model-plane d1: {min(i + batch, len(statements))}/{len(statements)}", flush=True)
        _run_sql(bpath)
        bpath.unlink(missing_ok=True)
    print(f"model-plane d1: {len(rows)} nodes + {len(standards)} meta rows applied")


def main(argv: list[str]) -> int:
    write_pins = "--no-pins" not in argv
    do_check = "--check" in argv
    do_apply = "--apply" in argv
    repo = smart_repo()
    if repo is None:
        diag = smart_repo_diagnosis()
        if do_check:
            # the honest SKIP (exit 0 — the contract CI's ingest job rides
            # on) — but now it says WHY, per candidate
            print(f"model-plane freshness: SKIP — {diag}")
            return 0
        raise SystemExit(f"no smart checkout found: {diag}")
    if do_check:
        return check(repo)
    build(repo, write_pins=write_pins)
    if do_apply:
        apply()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
