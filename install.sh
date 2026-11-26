#!/usr/bin/env bash
#
# EditAWr installer for Linux and macOS.
#
# Linux: downloads the latest AppImage release and installs it under
#        ~/.local (or $PREFIX). No root is required.
# macOS: there are no prebuilt macOS releases; this builds the app from
#        source, ad-hoc signs it, and installs it to ~/Applications.
#
# Usage:
#   ./install.sh                 # latest release (Linux) / latest source tag (macOS)
#   ./install.sh --version 0.1.2 # a specific release tag (v0.1.2 also works)
#   ./install.sh --prefix DIR    # Linux install prefix (default: ~/.local)
#   ./install.sh --system        # macOS: install to /Applications (uses sudo)
#   ./install.sh --uninstall     # remove the installed app
#
# Environment:
#   PREFIX=...            Linux install prefix (default: ~/.local)
#   EDITAWR_EXTRACT=1     Linux: always run the AppImage with
#                         --appimage-extract-and-run (useful without FUSE 2)

set -euo pipefail

REPO="iambibhas/editawr"
APP_NAME="EditAWr"
PREFIX="${PREFIX:-$HOME/.local}"
SYSTEM=0
VERSION=""
UNINSTALL=0
WORK_DIR=""

log() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

usage() {
  cat <<EOF
Install $APP_NAME on Linux or macOS.

Usage:
  ./install.sh [options]

Options:
  --version TAG     Install a specific release tag (for example 0.1.2 or v0.1.2)
  --prefix DIR      Linux install prefix (default: ~/.local)
  --system          macOS: install to /Applications instead of ~/Applications
  --uninstall       Remove the installed app
  -h, --help        Show this help

Linux installs the latest AppImage. macOS has no prebuilt release; it builds
from source and ad-hoc signs the app locally.
EOF
}

cleanup() {
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

normalize_tag() {
  case "$1" in
    v*) printf '%s' "$1" ;;
    *) printf 'v%s' "$1" ;;
  esac
}

release_json() {
  local tag="${1:-}"
  if [ -n "$tag" ]; then
    curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$tag"
  else
    curl -fsSL "https://api.github.com/repos/$REPO/releases/latest"
  fi
}

json_tag() {
  printf '%s' "$1" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1
}

resolve_tag() {
  local tag
  if [ -n "$VERSION" ]; then
    tag="$(normalize_tag "$VERSION")"
  else
    local json
    if ! json="$(release_json)"; then
      die "could not read the latest GitHub release"
    fi
    tag="$(json_tag "$json")"
    [ -n "$tag" ] || die "could not determine the latest release tag"
  fi
  printf '%s' "$tag"
}

uninstall_linux() {
  local bin_dir="$PREFIX/bin"
  local lib_dir="$PREFIX/lib/editawr"
  local desktop_dir="$PREFIX/share/applications"

  rm -f "$bin_dir/editawr"
  rm -rf "$lib_dir"
  rm -f "$desktop_dir/editawr.desktop"
  log "Removed $APP_NAME from $PREFIX"
}

uninstall_macos() {
  local dest="/Applications"
  if [ "$SYSTEM" -ne 1 ]; then
    dest="$HOME/Applications"
  fi

  if [ -d "$dest/$APP_NAME.app" ]; then
    if [ "$SYSTEM" -eq 1 ]; then
      sudo rm -rf "$dest/$APP_NAME.app"
    else
      rm -rf "$dest/$APP_NAME.app"
    fi
    log "Removed $APP_NAME from $dest"
  else
    log "$APP_NAME is not installed in $dest"
  fi
}

install_linux() {
  if [ "$UNINSTALL" -eq 1 ]; then
    uninstall_linux
    return
  fi

  need curl
  need grep
  need sed

  local machine
  machine="$(uname -m)"
  local suffix
  case "$machine" in
    x86_64|amd64) suffix='x86_64\.AppImage' ;;
    aarch64|arm64) suffix='arm64\.AppImage' ;;
    *) die "unsupported Linux architecture: $machine" ;;
  esac

  local tag json asset_url
  tag="$(resolve_tag)"
  if ! json="$(release_json "$tag")"; then
    die "could not read release $tag"
  fi

  asset_url="$(printf '%s' "$json" | grep -o "https://[^\"]*$suffix" | head -n 1 || true)"
  if [ -z "$asset_url" ]; then
    die "no Linux AppImage for $machine in release $tag"
  fi

  local bin_dir="$PREFIX/bin"
  local lib_dir="$PREFIX/lib/editawr"
  local desktop_dir="$PREFIX/share/applications"
  WORK_DIR="$(mktemp -d)"
  local appimage="$WORK_DIR/EditAWr.AppImage"

  log "Downloading $APP_NAME $tag for $machine"
  curl -fL --retry 3 --retry-delay 1 -o "$appimage" "$asset_url"

  mkdir -p "$bin_dir" "$lib_dir" "$desktop_dir"
  cp "$appimage" "$lib_dir/EditAWr.AppImage"
  chmod 0755 "$lib_dir/EditAWr.AppImage"

  cat > "$bin_dir/editawr" <<EOF
#!/bin/sh
APP="$lib_dir/EditAWr.AppImage"
if [ "\${EDITAWR_EXTRACT:-0}" = "1" ] \\
  || ! command -v fusermount >/dev/null 2>&1 \\
  || ! ldconfig -p 2>/dev/null | grep -q 'libfuse\\.so\\.2'; then
  exec "\$APP" --appimage-extract-and-run "\$@"
fi
exec "\$APP" "\$@"
EOF
  chmod 0755 "$bin_dir/editawr"

  cat > "$desktop_dir/editawr.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=EditAWr
Comment=RAW-first photo organizer and editor
Exec="$bin_dir/editawr" %F
Terminal=false
Categories=Graphics;Photography;
Icon=applications-graphics
EOF
  chmod 0644 "$desktop_dir/editawr.desktop"
  command -v update-desktop-database >/dev/null 2>&1 \
    && update-desktop-database "$desktop_dir" >/dev/null 2>&1 || true

  log "Installed $APP_NAME $tag to $bin_dir/editawr"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "Add $bin_dir to PATH, then run: editawr" ;;
  esac
}

install_macos() {
  if [ "$UNINSTALL" -eq 1 ]; then
    uninstall_macos
    return
  fi

  need curl
  need tar
  need node
  need npm
  need codesign
  need ditto

  if ! node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1);
  ' >/dev/null 2>&1; then
    die "Node.js 22.12+ is required. Install it from https://nodejs.org/ or with Homebrew: brew install node@22"
  fi

  local src tag
  if [ -f "package.json" ] && [ -d "src" ] && [ -f "scripts/vendor.js" ]; then
    src="$(pwd)"
    tag="${VERSION:-local checkout}"
    log "Building from the current checkout"
  else
    tag="$(resolve_tag)"
    WORK_DIR="$(mktemp -d)"
    log "Downloading $APP_NAME source for $tag"
    curl -fL --retry 3 --retry-delay 1 \
      -o "$WORK_DIR/source.tar.gz" \
      "https://github.com/$REPO/archive/refs/tags/$tag.tar.gz"
    tar -xzf "$WORK_DIR/source.tar.gz" -C "$WORK_DIR"
    src=""
    for candidate in "$WORK_DIR"/editawr-*; do
      if [ -d "$candidate" ]; then
        src="$candidate"
        break
      fi
    done
    [ -n "$src" ] || die "could not find the downloaded source directory"
  fi

  log "Installing build dependencies (this can take a few minutes)"
  (cd "$src" && CSC_IDENTITY_AUTO_DISCOVERY=false npm ci)

  log "Building the macOS app"
  (cd "$src" && CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack)

  local app_path
  app_path="$(find "$src/dist" -type d -name "$APP_NAME.app" 2>/dev/null | head -n 1 || true)"
  [ -n "$app_path" ] || die "the packaged app was not found under $src/dist"

  # There is no Developer ID here, so sign locally with an ad-hoc signature.
  # This is enough for the same Mac to run the app; it is not a distributed
  # trust signature.
  log "Ad-hoc signing $APP_NAME.app"
  codesign --force --deep --sign - "$app_path"
  xattr -dr com.apple.quarantine "$app_path" 2>/dev/null || true

  local dest="/Applications"
  if [ "$SYSTEM" -ne 1 ]; then
    dest="$HOME/Applications"
  fi
  mkdir -p "$dest"

  if [ -e "$dest/$APP_NAME.app" ]; then
    if [ "$SYSTEM" -eq 1 ]; then
      sudo rm -rf "$dest/$APP_NAME.app"
    else
      rm -rf "$dest/$APP_NAME.app"
    fi
  fi

  if [ "$SYSTEM" -eq 1 ]; then
    sudo ditto "$app_path" "$dest/$APP_NAME.app"
  else
    ditto "$app_path" "$dest/$APP_NAME.app"
  fi
  xattr -dr com.apple.quarantine "$dest/$APP_NAME.app" 2>/dev/null || true

  log "Installed $APP_NAME $tag to $dest/$APP_NAME.app"
  log "Launch it with: open \"$dest/$APP_NAME.app\""
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --prefix)
      [ "$#" -ge 2 ] || die "--prefix requires a value"
      PREFIX="$2"
      shift 2
      ;;
    --system)
      SYSTEM=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (use --help)"
      ;;
  esac
done

case "$(uname -s)" in
  Linux)
    install_linux
    ;;
  Darwin)
    install_macos
    ;;
  *)
    die "unsupported operating system: $(uname -s)"
    ;;
esac
