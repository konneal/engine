#!/bin/bash
# The promotion gate as one command (TODO.impl/32): every THRESHOLDS
# docstring says "golden ×3 + annealment ×6" — this runs exactly that
# against BASE_URL (default: production) and fails on ANY failed run.
#
#   scripts/gates.sh                      # full gate: golden ×3, annealment ×6
#   scripts/gates.sh --quick              # smoke: golden ×1, annealment ×1
#   scripts/gates.sh --golden 5 --annealment 10
#
# Live spend: golden ≈38 queries/run, annealment 18/run — the full gate
# is the pre-promotion cadence, not a CI step (e2e stays manual for the
# same reason).
set -uo pipefail
cd "$(dirname "$0")/.."

GOLDEN_RUNS=3
ANNEAL_RUNS=6
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) GOLDEN_RUNS=1; ANNEAL_RUNS=1 ;;
    --golden) GOLDEN_RUNS="$2"; shift ;;
    --annealment) ANNEAL_RUNS="$2"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

FAIL=0
run_and_check() {
  local label="$1" n="$2"; shift 2
  local pass=0
  for i in $(seq 1 "$n"); do
    if "$@" > /tmp/gates-$label-$i.log 2>&1; then
      echo "  ✓ $label run $i/$n"
      pass=$((pass + 1))
    else
      echo "  ✗ $label run $i/$n"
      tail -5 "/tmp/gates-$label-$i.log" | sed 's/^/      /'
      FAIL=1
    fi
  done
  echo "$label: $pass/$n"
}

echo "── promotion gate: golden ×$GOLDEN_RUNS + annealment ×$ANNEAL_RUNS against ${BASE_URL:-https://ai.oimlsmart.org} ──"
run_and_check golden "$GOLDEN_RUNS" node scripts/eval.mjs
run_and_check annealment "$ANNEAL_RUNS" node tests/annealment.mjs

if [ $FAIL -eq 1 ]; then
  echo "── GATE FAILED ──"
  exit 1
fi
echo "── gate passed ──"
