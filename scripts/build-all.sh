#!/usr/bin/env bash
# Build standalone mdpubs binaries for macOS + Linux.
# Output: dist/mdpubs-<os>-<arch>  (+ matching .sha256)
#
# Bun cross-compiles via --target. These names are what install.sh expects.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/mdpubs-* 2>/dev/null || true

VERSION="$(grep -m1 '"version"' package.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
echo "Building mdpubs v${VERSION}"

# bun target  ->  released asset name
build() {
  local target="$1" out="$2"
  echo "  - ${out}"
  bun build src/cli.ts --compile --target="${target}" --outfile "dist/${out}"
  # checksum (cross-platform: prefer sha256sum, fall back to shasum)
  if command -v sha256sum >/dev/null; then
    (cd dist && sha256sum "${out}" > "${out}.sha256")
  else
    (cd dist && shasum -a 256 "${out}" > "${out}.sha256")
  fi
}

build bun-darwin-arm64  mdpubs-darwin-arm64   # Apple Silicon Macs
build bun-darwin-x64    mdpubs-darwin-x64     # Intel Macs
build bun-linux-x64     mdpubs-linux-x64      # most Linux
build bun-linux-arm64   mdpubs-linux-arm64    # ARM Linux

echo
echo "Done. Artifacts in dist/:"
ls -1 dist/mdpubs-*
echo
echo "Next: create a GitHub release and upload these, e.g."
echo "  gh release create v${VERSION} dist/mdpubs-* --title \"mdpubs-cli v${VERSION}\" --notes \"...\""
