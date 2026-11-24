#!/usr/bin/env bash
# Refresh the vendored fingerprints from enthec/webappanalyzer (no key needed).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
git clone --depth 1 https://github.com/enthec/webappanalyzer.git "$TMP/wa"
rm -rf "$DIR/technologies"
cp -r "$TMP/wa/src/technologies" "$DIR/technologies"
cp "$TMP/wa/src/categories.json" "$TMP/wa/src/groups.json" "$TMP/wa/LICENSE" "$DIR/"
COMMIT="$(git -C "$TMP/wa" rev-parse HEAD)"
sed -i "s/^- Commit: .*/- Commit: ${COMMIT} ($(git -C "$TMP/wa" log -1 --format=%ci))/" "$DIR/SOURCE.md"
rm -rf "$TMP"
echo "Fingerprints updated to ${COMMIT}. Now run: pnpm test"
