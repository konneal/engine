#!/usr/bin/env bash
# Export the smart repo's primmel packages via primmel-ts's retrieval
# export (primmel/primmel-ts#65) — the canonical, versioned serialization
# for RAG consumers. Prerequisite: the primmel-ts checkout at v1.
#
#   PRIMMEL_TS=~/src/primmel/primmel-ts SMART_PACKAGES=~/src/oimlsmart/smart/primmel-packages \
#     scripts/export_retrieval.sh /tmp/retrieval-export
set -euo pipefail

PRIMMEL_TS="${PRIMMEL_TS:-$HOME/src/primmel/primmel-ts}"
SMART_PACKAGES="${SMART_PACKAGES:-$HOME/src/oimlsmart/smart/primmel-packages}"
OUT="${1:-/tmp/retrieval-export}"
STANDARDS="${STANDARDS:-oiml-r60 oiml-r91 oiml-r129 oiml-r144}"

mkdir -p "$OUT"
cd "$PRIMMEL_TS"
for std in $STANDARDS; do
  npx tsx -e "
import { exportPackageRetrieval } from './packages/primmel/src/export/retrieval.ts';
import { writeFileSync } from 'node:fs';
const doc: any = exportPackageRetrieval('$SMART_PACKAGES/$std');
writeFileSync('$OUT/$std.json', doc.json ?? JSON.stringify(doc, null, 2) + '\n');
console.log('$std:', (doc.document ?? doc).units?.length ?? doc.units?.length ?? '?', 'units');
" 2>&1 | grep -v Warning
done
echo "retrieval export → $OUT"
