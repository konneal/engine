"""The answer-cache invalidation one-shot (oimlsmart/rag#72).

Run: .venv/bin/python -m pytest tests/python -q

The invariants under test are the ops guardrails:
  - the script refuses to run without the explicit confirm flag
    (the estate's one-shot pattern, cf. scripts/delete_orphans.py);
  - --dry-run reads but never writes;
  - a bump writes a fresh UTC stamp to sys:corpus_gen.
"""
from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "invalidate_answer_cache",
    Path(__file__).resolve().parents[2] / "scripts" / "invalidate_answer_cache.py",
)
iac = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = iac
SPEC.loader.exec_module(iac)


class FakeCF:
    def __init__(self, stored: dict[str, str] | None = None) -> None:
        self.stored = dict(stored or {})
        self.writes: list[tuple[str, str, str]] = []

    def kv_get(self, namespace_id: str, key: str) -> str | None:
        return self.stored.get(key)

    def kv_put(self, namespace_id: str, key: str, value: str) -> None:
        self.writes.append((namespace_id, key, value))
        self.stored[key] = value


def test_refuses_without_the_namespace_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RAG_PUBLIC_KV", raising=False)
    with pytest.raises(SystemExit, match="refusing to run"):
        iac.main()


def test_refuses_a_wrong_confirm_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RAG_PUBLIC_KV", "0")
    with pytest.raises(SystemExit, match="refusing to run"):
        iac.main()


def test_dry_run_reads_but_never_writes(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setenv("RAG_PUBLIC_KV", "1")
    fake = FakeCF({iac.GENERATION_KEY: "20260904T120000Z"})
    monkeypatch.setattr(iac, "CF", lambda: fake)
    monkeypatch.setattr(sys, "argv", ["invalidate_answer_cache.py", "--dry-run"])
    iac.main()
    assert fake.writes == []
    assert "20260904T120000Z" in capsys.readouterr().out


def test_bump_writes_a_fresh_generation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RAG_PUBLIC_KV", "1")
    fake = FakeCF()
    monkeypatch.setattr(iac, "CF", lambda: fake)
    monkeypatch.setattr(sys, "argv", ["invalidate_answer_cache.py"])
    iac.main()
    assert len(fake.writes) == 1
    ns, key, value = fake.writes[0]
    assert ns == iac.PRODUCTION_KV
    assert key == "sys:corpus_gen"
    assert value == fake.stored["sys:corpus_gen"]


def test_generation_stamp_is_utc_and_sortable() -> None:
    stamp = iac.new_generation(datetime(2026, 9, 4, 12, 0, 0, tzinfo=timezone.utc))
    assert stamp == "20260904T120000Z"
    assert iac.new_generation() >= "20260904T000000Z"
