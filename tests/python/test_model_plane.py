"""smart_repo() resolution + rejection diagnostics (ingest/model_plane.py).

Run: .venv/bin/python -m pytest tests/python -q

The invariants under test:
  - resolution order: SMART_REPO (declared) first, then the sibling layout;
    the first candidate carrying browser/public/data/model-plane/index.json
    wins.
  - a candidate that EXISTS but lacks the bundles is named with its git
    branch and the missing path — never a generic SKIP (the misread behind
    oimlsmart/smart#252).
  - the SKIP contract is unchanged: --check with no usable checkout exits 0
    with the message; the build path still refuses (SystemExit).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from ingest import model_plane
from ingest.model_plane import (
    BUNDLES_INDEX,
    smart_repo,
    smart_repo_diagnosis,
)


def _with_bundles(root: Path) -> Path:
    index = root / BUNDLES_INDEX
    index.parent.mkdir(parents=True)
    index.write_text('{"standards": []}', encoding="utf-8")
    return root


def _on_branch(root: Path, branch: str) -> Path:
    git = root / ".git"
    git.mkdir(parents=True, exist_ok=True)
    (git / "HEAD").write_text(f"ref: refs/heads/{branch}\n", encoding="utf-8")
    return root


@pytest.fixture(autouse=True)
def no_siblings(monkeypatch):
    """Hermetic candidates: the real sibling layout must never leak in."""
    monkeypatch.setattr(model_plane, "_sibling_candidates", lambda: [])


# ── resolution ───────────────────────────────────────────────────────

def test_declared_env_hit(monkeypatch, tmp_path: Path):
    declared = _with_bundles(tmp_path / "smart-declared")
    monkeypatch.setenv("SMART_REPO", str(declared))
    assert smart_repo() == declared


def test_sibling_hit(monkeypatch, tmp_path: Path):
    monkeypatch.delenv("SMART_REPO", raising=False)
    sibling = _with_bundles(tmp_path / "smart")
    monkeypatch.setattr(model_plane, "_sibling_candidates", lambda: [tmp_path / "absent", sibling])
    assert smart_repo() == sibling


def test_declared_wins_over_siblings(monkeypatch, tmp_path: Path):
    declared = _with_bundles(tmp_path / "declared")
    sibling = _with_bundles(tmp_path / "sibling")
    monkeypatch.setenv("SMART_REPO", str(declared))
    monkeypatch.setattr(model_plane, "_sibling_candidates", lambda: [sibling])
    assert smart_repo() == declared


# ── the diagnostics ──────────────────────────────────────────────────

def test_candidate_exists_but_no_bundles_names_branch_and_missing_index(tmp_path: Path):
    parked = _on_branch(tmp_path / "smart", "fix/regenerate-data-collapse")
    assert smart_repo([parked]) is None
    diag = smart_repo_diagnosis([parked])
    assert str(parked) in diag
    assert "branch fix/regenerate-data-collapse" in diag
    assert BUNDLES_INDEX in diag
    assert "declare SMART_REPO" in diag


def test_no_candidates_message(tmp_path: Path):
    missing = tmp_path / "no-such-checkout"
    assert smart_repo([missing]) is None
    diag = smart_repo_diagnosis([missing])
    assert "does not exist" in diag
    assert "declare SMART_REPO" not in diag  # nothing found to diagnose — plain absence


def test_declared_missing_path_is_named(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("SMART_REPO", str(tmp_path / "typo"))
    assert smart_repo() is None
    assert "does not exist" in smart_repo_diagnosis()


def test_branch_reading_variants(tmp_path: Path):
    from ingest.model_plane import _git_branch

    assert _git_branch(tmp_path) == ""                       # no .git at all
    detached = tmp_path / "detached"
    (detached / ".git").mkdir(parents=True)
    (detached / ".git" / "HEAD").write_text("b1f99c1f9aa19aa19aa19aa19aa19aa19aa19aa1\n", encoding="utf-8")
    assert _git_branch(detached) == "detached @ b1f99c1f9aa1"
    # worktree: .git is a file pointing at the real gitdir
    gitdir = tmp_path / "real-gitdir"
    gitdir.mkdir()
    (gitdir / "HEAD").write_text("ref: refs/heads/feat/wt\n", encoding="utf-8")
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / ".git").write_text(f"gitdir: {gitdir}\n", encoding="utf-8")
    assert _git_branch(wt) == "feat/wt"


# ── the SKIP contract ────────────────────────────────────────────────

def test_check_skip_keeps_exit_zero_and_explains(monkeypatch, tmp_path: Path, capsys):
    monkeypatch.delenv("SMART_REPO", raising=False)
    parked = _on_branch(tmp_path / "smart", "legacy-branch")
    monkeypatch.setattr(model_plane, "_sibling_candidates", lambda: [parked])
    rc = model_plane.main(["--check"])
    assert rc == 0
    out = capsys.readouterr().out
    assert out.startswith("model-plane freshness: SKIP — ")
    assert "legacy-branch" in out and BUNDLES_INDEX in out


def test_build_without_checkout_still_refuses(monkeypatch):
    monkeypatch.delenv("SMART_REPO", raising=False)
    with pytest.raises(SystemExit):
        model_plane.main([])
