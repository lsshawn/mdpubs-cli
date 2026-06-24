#!/usr/bin/env bash
# mdpubs CLI installer (macOS + Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/lsshawn/mdpubs-cli/main/install.sh | sh
#
# Downloads the right prebuilt binary from the latest GitHub release and installs
# it to ~/.local/bin (no sudo). Override with MDPUBS_INSTALL_DIR=/usr/local/bin.
set -euo pipefail

REPO="lsshawn/mdpubs-cli"
INSTALL_DIR="${MDPUBS_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="mdpubs"

say()  { printf '%s\n' "$*"; }
err()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- detect platform -> released asset name -------------------------------
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) os_tag="darwin" ;;
  Linux)  os_tag="linux" ;;
  *) err "unsupported OS: $os (mdpubs supports macOS and Linux)";;
esac
case "$arch" in
  arm64|aarch64) arch_tag="arm64" ;;
  x86_64|amd64)  arch_tag="x64" ;;
  *) err "unsupported architecture: $arch";;
esac
asset="${BIN_NAME}-${os_tag}-${arch_tag}"

# --- resolve version (latest unless MDPUBS_VERSION is set) -----------------
version="${MDPUBS_VERSION:-latest}"
if [ "$version" = "latest" ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${version}"
fi
url="${base}/${asset}"

say "Installing mdpubs (${asset}) from ${REPO} ..."
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fSL "$url" -o "$tmp" || err "download failed: $url"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url" || err "download failed: $url"
else
  err "need curl or wget to install"
fi

# --- install --------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
chmod +x "$tmp"
mv "$tmp" "$INSTALL_DIR/$BIN_NAME"
trap - EXIT

say "Installed to $INSTALL_DIR/$BIN_NAME"

# --- PATH guidance --------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say ""
    say "NOTE: $INSTALL_DIR is not on your PATH. Add this to your shell profile:"
    say "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

say ""
say "Done. Get started:"
say "  mdpubs login          # paste your API key from https://mdpubs.com/account"
say "  mdpubs publish file.html"
