#!/bin/sh
# Downloads the exact arXiv PDF used by the demo and verifies its SHA-256.
# The PDF is deliberately not committed: arXiv's license governs redistribution.
set -eu
cd "$(dirname "$0")"

URL="https://arxiv.org/pdf/1910.02884v1"
EXPECTED="ed604a4100b10e17139d1fc8eb05f617effd5cb5c30533e4c325b08e1d9cae93"
OUT="paper.pdf"

curl --fail --location --silent --show-error --max-time 120 "$URL" -o "$OUT"

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$OUT" | awk '{print $1}')
else
  ACTUAL=$(shasum -a 256 "$OUT" | awk '{print $1}')
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "SHA-256 mismatch: expected $EXPECTED, got $ACTUAL" >&2
  echo "The upstream PDF changed; review the new version before using it as a source." >&2
  exit 1
fi

echo "Verified $OUT (SHA-256 $ACTUAL)"
echo "Import this file by absolute path, or use https://arxiv.org/abs/1910.02884v1 directly."
