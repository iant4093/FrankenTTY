#!/bin/sh
# shellcheck shell=sh
# FrankenTTY installer for macOS and Linux.
#
#   curl -fsSL https://github.com/iant4093/FrankenTTY/releases/latest/download/install.sh | sh
#   sh install.sh [--yes] [--no-ffmpeg] [--help]
#
# Environment:
#   FRANKENTTY_RELEASE_BASE  where archives and SHA256SUMS live (default: latest GitHub release;
#                            file:// URLs work, which the tests use)
#   FRANKENTTY_INSTALL_DIR   target directory (default: $HOME/.local/bin)
#   FRANKENTTY_UNAME_M       TEST ONLY: pretend `uname -m` printed this value
#
# Installs one binary. Never uses sudo for FrankenTTY itself. Does not edit shell rc files.
# The whole script is wrapped in main() so a truncated download cannot run half a script.

set -eu

BASE_DEFAULT="https://github.com/iant4093/FrankenTTY/releases/latest/download"
TMPDIR_MADE=""

say() { printf '%s\n' "$*"; }
warn() { printf 'frankentty install: warning: %s\n' "$*" >&2; }
die() {
  printf 'frankentty install: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMPDIR_MADE" ] && [ -d "$TMPDIR_MADE" ]; then
    rm -rf "$TMPDIR_MADE"
  fi
}

usage() {
  cat <<'EOF'
Usage: sh install.sh [--yes] [--no-ffmpeg] [--help]

  --yes         answer yes to the FFmpeg install question
  --no-ffmpeg   do not check for or offer to install FFmpeg
  --help        show this text

Environment: FRANKENTTY_RELEASE_BASE, FRANKENTTY_INSTALL_DIR
EOF
}

detect_os() {
  case "$(uname -s)" in
    Darwin) OS=macos ;;
    Linux) OS=linux ;;
    *) die "unsupported operating system: $(uname -s). On Windows use install.ps1." ;;
  esac
}

detect_arch() {
  raw=${FRANKENTTY_UNAME_M:-$(uname -m)}
  case "$raw" in
    arm64 | aarch64) ARCH=arm64 ;;
    x86_64 | amd64) ARCH=x64 ;;
    *) die "unsupported CPU architecture: $raw (supported: arm64, x64)" ;;
  esac
  # A shell running under Rosetta reports x86_64 on an Apple Silicon Mac.
  if [ -z "${FRANKENTTY_UNAME_M:-}" ] && [ "$OS" = macos ] && [ "$ARCH" = x64 ]; then
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
      ARCH=arm64
    fi
  fi
}

# download URL DEST
download() {
  case "$1" in
    file://*)
      cp "${1#file://}" "$2" || die "cannot read $1"
      ;;
    *)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1"
      elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1" || die "download failed: $1"
      else
        die "neither curl nor wget is installed"
      fi
      ;;
  esac
}

# sha256 FILE: prints the lowercase hex digest.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "need sha256sum or shasum to verify the download"
  fi
}

on_path() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

print_path_hint() {
  say ""
  say "$INSTALL_DIR is not on your PATH. Add it with:"
  case "$(basename "${SHELL:-sh}")" in
    zsh)
      # shellcheck disable=SC2016
      printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc\n' "$INSTALL_DIR"
      ;;
    bash)
      # shellcheck disable=SC2016
      printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc\n' "$INSTALL_DIR"
      ;;
    fish)
      printf '  fish_add_path %s\n' "$INSTALL_DIR"
      ;;
    *)
      # shellcheck disable=SC2016
      printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.profile\n' "$INSTALL_DIR"
      ;;
  esac
  say "Then open a new terminal."
}

have_tty() {
  # /dev/tty exists even without a controlling terminal, so test that it can be opened.
  (: </dev/tty) 2>/dev/null
}

detect_pkg_manager() {
  PM=""
  if [ "$OS" = macos ]; then
    command -v brew >/dev/null 2>&1 && PM=brew
    return 0
  fi
  for candidate in apt-get dnf pacman zypper brew; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PM=$candidate
      return 0
    fi
  done
}

# Sets FFMPEG_CMD (display text) and NEED_SUDO.
ffmpeg_command_text() {
  NEED_SUDO=""
  if [ "$(id -u)" != 0 ] && [ "$PM" != brew ]; then
    NEED_SUDO=1
  fi
  prefix=""
  [ -n "$NEED_SUDO" ] && prefix="sudo "
  case "$PM" in
    brew) FFMPEG_CMD="brew install ffmpeg" ;;
    apt-get) FFMPEG_CMD="${prefix}apt-get install -y ffmpeg" ;;
    dnf) FFMPEG_CMD="${prefix}dnf install -y ffmpeg" ;;
    pacman) FFMPEG_CMD="${prefix}pacman -S --noconfirm ffmpeg" ;;
    zypper) FFMPEG_CMD="${prefix}zypper install -y ffmpeg" ;;
    *) FFMPEG_CMD="" ;;
  esac
}

# Runs the package manager with an argv, never through eval.
run_ffmpeg_install() {
  case "$PM" in
    brew) brew install ffmpeg ;;
    apt-get) ${NEED_SUDO:+sudo} apt-get install -y ffmpeg ;;
    dnf) ${NEED_SUDO:+sudo} dnf install -y ffmpeg ;;
    pacman) ${NEED_SUDO:+sudo} pacman -S --noconfirm ffmpeg ;;
    zypper) ${NEED_SUDO:+sudo} zypper install -y ffmpeg ;;
    *) return 1 ;;
  esac
}

check_ffmpeg() {
  missing=""
  for tool in ffmpeg ffprobe ffplay; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  if [ -z "$missing" ]; then
    say "FFmpeg found (ffmpeg, ffprobe, ffplay)."
    return 0
  fi

  say ""
  say "FrankenTTY needs FFmpeg. Missing:$missing"
  detect_pkg_manager
  ffmpeg_command_text
  if [ -z "$PM" ]; then
    say "No supported package manager found. Install FFmpeg from https://ffmpeg.org/download.html"
    return 0
  fi
  say "Install command: $FFMPEG_CMD"

  answer=""
  if [ "$ASSUME_YES" = 1 ]; then
    answer=y
  elif have_tty; then
    printf 'Install FFmpeg now? [y/N] '
    read -r answer </dev/tty || answer=""
  else
    say "Run that command yourself, then you are ready."
    return 0
  fi

  case "$answer" in
    y | Y | yes | YES | Yes)
      if run_ffmpeg_install; then
        say "FFmpeg installed."
      else
        warn "FFmpeg install failed. Run this yourself: $FFMPEG_CMD"
      fi
      ;;
    *)
      say "Skipped. Run this when you are ready: $FFMPEG_CMD"
      ;;
  esac
}

main() {
  ASSUME_YES=0
  SKIP_FFMPEG=0
  for arg in "$@"; do
    case "$arg" in
      --yes | -y) ASSUME_YES=1 ;;
      --no-ffmpeg) SKIP_FFMPEG=1 ;;
      --help | -h)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "unknown option: $arg"
        ;;
    esac
  done

  BASE=${FRANKENTTY_RELEASE_BASE:-$BASE_DEFAULT}
  BASE=${BASE%/}
  INSTALL_DIR=${FRANKENTTY_INSTALL_DIR:-${HOME:?HOME is not set}/.local/bin}

  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
    || die "need sha256sum or shasum to verify the download"
  command -v tar >/dev/null 2>&1 || die "need tar to unpack the download"

  detect_os
  detect_arch
  ARCHIVE="frankentty-$OS-$ARCH.tar.gz"
  say "Installing FrankenTTY for $OS-$ARCH"

  TMPDIR_MADE=$(mktemp -d "${TMPDIR:-/tmp}/frankentty-install.XXXXXX") || die "cannot create a temp directory"
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP

  download "$BASE/$ARCHIVE" "$TMPDIR_MADE/$ARCHIVE"
  download "$BASE/SHA256SUMS" "$TMPDIR_MADE/SHA256SUMS"

  expected=$(awk -v f="$ARCHIVE" '{ n = $2; sub(/^\*/, "", n); if (n == f) { print tolower($1); exit } }' "$TMPDIR_MADE/SHA256SUMS")
  [ -n "$expected" ] || die "SHA256SUMS has no entry for $ARCHIVE"
  actual=$(sha256 "$TMPDIR_MADE/$ARCHIVE")
  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for $ARCHIVE (expected $expected, got $actual). Nothing was installed."
  fi
  say "Checksum verified."

  mkdir "$TMPDIR_MADE/extract"
  tar -xzf "$TMPDIR_MADE/$ARCHIVE" -C "$TMPDIR_MADE/extract" frankentty || die "cannot extract $ARCHIVE"
  [ -f "$TMPDIR_MADE/extract/frankentty" ] || die "$ARCHIVE does not contain frankentty"

  mkdir -p "$INSTALL_DIR" || die "cannot create $INSTALL_DIR"
  # Copy next to the target, then rename: the rename is atomic on one filesystem.
  staged="$INSTALL_DIR/.frankentty.$$"
  cp "$TMPDIR_MADE/extract/frankentty" "$staged" || die "cannot write to $INSTALL_DIR"
  chmod 755 "$staged"
  mv -f "$staged" "$INSTALL_DIR/frankentty" || {
    rm -f "$staged"
    die "cannot install to $INSTALL_DIR/frankentty"
  }
  say "Installed $INSTALL_DIR/frankentty"

  on_path "$INSTALL_DIR" || print_path_hint

  if [ "$SKIP_FFMPEG" = 0 ]; then
    check_ffmpeg
  fi

  say ""
  say "Uninstall: rm \"$INSTALL_DIR/frankentty\""
  say "Run: frankentty --demo"
}

main "$@"
