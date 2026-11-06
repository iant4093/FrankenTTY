#!/usr/bin/env bash
# Builds the release assets in release/: SEA binaries per platform, archives, the npm-style
# bundle, the installers and SHA256SUMS. Same entry point for CI and local use.
#
# Usage: bash scripts/build-release.sh [--targets all|host] [--node-version 26.13.0]
#
# Node binaries come from https://nodejs.org/dist/ and are checked against SHASUMS256.txt.
# The builder is the official Node binary for this host, never Homebrew's (SEA is disabled there).
# Logs go to build/logs/release.log.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

TARGETS_ARG=all
NODE_VERSION=26.13.0

usage() {
  echo "Usage: bash scripts/build-release.sh [--targets all|host] [--node-version X.Y.Z]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --targets)
      [ $# -ge 2 ] || { echo "error: --targets needs a value (all|host)" >&2; exit 2; }
      TARGETS_ARG=$2
      shift 2
      ;;
    --node-version)
      [ $# -ge 2 ] || { echo "error: --node-version needs a value" >&2; exit 2; }
      NODE_VERSION=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$TARGETS_ARG" in
  all | host) ;;
  *) echo "error: --targets must be all or host, got: $TARGETS_ARG" >&2; exit 2 ;;
esac
# The version ends up in a download URL, so accept digits and dots only.
if ! printf '%s' "$NODE_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: --node-version must look like 26.13.0, got: $NODE_VERSION" >&2
  exit 2
fi

# name:node-platform:archive-extension. Release asset names use "macos", Node uses "darwin"/"win".
TARGET_DEFS="macos-arm64:darwin-arm64:tar.gz macos-x64:darwin-x64:tar.gz linux-x64:linux-x64:tar.xz linux-arm64:linux-arm64:tar.xz windows-x64:win-x64:zip"

CACHE="$ROOT/build/node-cache/v$NODE_VERSION"
LOG="$ROOT/build/logs/release.log"
RELEASE="$ROOT/release"
mkdir -p "$ROOT/build/logs"
: >"$LOG"

target_def() {
  local def
  for def in $TARGET_DEFS; do
    if [ "${def%%:*}" = "$1" ]; then
      echo "$def"
      return 0
    fi
  done
  return 1
}
target_plat() { local d rest; d=$(target_def "$1") || return 1; rest=${d#*:}; echo "${rest%%:*}"; }
target_ext() { local d; d=$(target_def "$1") || return 1; echo "${d##*:}"; }
node_bin() {
  case "$1" in
    windows-*) echo "$CACHE/bin/$1/node.exe" ;;
    *) echo "$CACHE/bin/$1/node" ;;
  esac
}
sea_out() {
  case "$1" in
    windows-*) echo "$ROOT/build/sea/$1/frankentty.exe" ;;
    *) echo "$ROOT/build/sea/$1/frankentty" ;;
  esac
}
asset_name() {
  case "$1" in
    windows-*) echo "frankentty-$1.zip" ;;
    *) echo "frankentty-$1.tar.gz" ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# --- host detection -------------------------------------------------------------------------
case "$(uname -s)" in
  Darwin) HOST_OS=macos ;;
  Linux) HOST_OS=linux ;;
  *) echo "error: unsupported build host: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) HOST_ARCH=arm64 ;;
  x86_64 | amd64) HOST_ARCH=x64 ;;
  *) echo "error: unsupported build host CPU: $(uname -m)" >&2; exit 1 ;;
esac
HOST_NAME="$HOST_OS-$HOST_ARCH"

CAN_SIGN=0
if command -v codesign >/dev/null 2>&1; then CAN_SIGN=1; fi
if [ "$HOST_OS" = macos ] && [ "$CAN_SIGN" -eq 0 ]; then
  echo "error: codesign not found; macOS binaries cannot be built unsigned" >&2
  exit 1
fi

SELECTED=""
if [ "$TARGETS_ARG" = host ]; then
  SELECTED=$HOST_NAME
else
  for def in $TARGET_DEFS; do
    name=${def%%:*}
    case "$name" in
      macos-*)
        if [ "$CAN_SIGN" -eq 0 ]; then
          echo "WARN: codesign not available, skipping $name (arm64 macOS refuses unsigned binaries)"
          continue
        fi
        ;;
    esac
    SELECTED="$SELECTED $name"
  done
  SELECTED=${SELECTED# }
fi
export ROOT NODE_VERSION CACHE HOST_NAME SELECTED TARGET_DEFS CAN_SIGN TARGETS_ARG RELEASE

# --- steps ----------------------------------------------------------------------------------
# Each step runs in a subshell with errexit on, so any failing command inside fails the step.
run_step() {
  local name="$1" rc
  shift
  echo "== $name =="
  echo "== $name ==" >>"$LOG"
  set +e
  ( set -e; "$@" ) >>"$LOG" 2>&1
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "PASS: $name"
  else
    echo "FAIL: $name (log: build/logs/release.log)"
    tail -40 "$LOG"
    echo
    echo "RESULT: FAIL"
    exit 1
  fi
}

step_prereqs() {
  local tool
  for tool in node npm curl tar unzip zip awk grep; do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool"; exit 1; }
  done
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
    || { echo "missing required tool: sha256sum or shasum"; exit 1; }
  [ -f LICENSE ] || { echo "LICENSE not found in repo root"; exit 1; }
  echo "host: $HOST_NAME  targets: $SELECTED  node-version: $NODE_VERSION"
}

step_bundle() {
  npm run --silent bundle
  [ -s dist/frankentty.cjs ]
}

fetch_node() {
  local name="$1" plat ext archive url sums expected actual bindir
  plat=$(target_plat "$name")
  ext=$(target_ext "$name")
  archive="node-v$NODE_VERSION-$plat.$ext"
  url="https://nodejs.org/dist/v$NODE_VERSION/$archive"
  sums="$CACHE/SHASUMS256.txt"
  mkdir -p "$CACHE"
  if [ ! -s "$sums" ]; then
    curl -fsSL --retry 3 -o "$sums.part" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
    mv "$sums.part" "$sums"
  fi
  expected=$(awk -v f="$archive" '$2 == f { print $1 }' "$sums")
  [ -n "$expected" ] || { echo "no checksum for $archive in SHASUMS256.txt"; exit 1; }
  if [ -f "$CACHE/$archive" ]; then
    actual=$(sha256_of "$CACHE/$archive")
    if [ "$actual" != "$expected" ]; then
      echo "cached $archive is corrupt, downloading again"
      rm -f "$CACHE/$archive"
    fi
  fi
  if [ ! -f "$CACHE/$archive" ]; then
    echo "downloading $url"
    curl -fL --retry 3 -o "$CACHE/$archive.part" "$url"
    mv "$CACHE/$archive.part" "$CACHE/$archive"
  fi
  actual=$(sha256_of "$CACHE/$archive")
  if [ "$actual" != "$expected" ]; then
    echo "CHECKSUM MISMATCH for $archive: expected $expected, got $actual"
    exit 1
  fi
  echo "verified $archive ($expected)"
  bindir="$CACHE/bin/$name"
  rm -rf "$bindir"
  mkdir -p "$bindir"
  case "$ext" in
    zip) unzip -o -j -q "$CACHE/$archive" "node-v$NODE_VERSION-$plat/node.exe" -d "$bindir" ;;
    *) tar -xf "$CACHE/$archive" -C "$bindir" --strip-components=2 "node-v$NODE_VERSION-$plat/bin/node" ;;
  esac
  [ -s "$(node_bin "$name")" ]
  case "$name" in windows-*) ;; *) chmod 755 "$(node_bin "$name")" ;; esac
}

step_fetch_all() {
  local name
  for name in $SELECTED; do
    fetch_node "$name"
  done
}

build_target() {
  local name="$1" out cfg builder
  out=$(sea_out "$name")
  cfg="$ROOT/build/sea/$name/sea-config.json"
  builder=$(node_bin "$HOST_NAME")
  rm -rf "$ROOT/build/sea/$name"
  mkdir -p "$ROOT/build/sea/$name"
  "$builder" scripts/sea-config.mjs "$cfg" dist/frankentty.cjs "$out" "$(node_bin "$name")"
  "$builder" --build-sea "$cfg"
  [ -s "$out" ]
  case "$name" in
    macos-*) codesign --sign - --force "$out" ;;
  esac
  echo "built $out ($(wc -c <"$out" | tr -d ' ') bytes)"
}

step_build_all() {
  local name
  for name in $SELECTED; do
    build_target "$name"
  done
}

package_target() {
  local name="$1" stage bin asset
  stage="$ROOT/build/stage/$name"
  asset="$RELEASE/$(asset_name "$name")"
  rm -rf "$stage"
  mkdir -p "$stage"
  case "$name" in
    windows-*)
      cp "$(sea_out "$name")" "$stage/frankentty.exe"
      cp LICENSE "$stage/LICENSE"
      rm -f "$asset"
      (cd "$stage" && zip -q -X "$asset" frankentty.exe LICENSE)
      ;;
    *)
      bin="$stage/frankentty"
      cp "$(sea_out "$name")" "$bin"
      chmod 755 "$bin"
      cp LICENSE "$stage/LICENSE"
      chmod 644 "$stage/LICENSE"
      # COPYFILE_DISABLE stops bsdtar on macOS from adding ._ AppleDouble entries.
      COPYFILE_DISABLE=1 tar -czf "$asset" -C "$stage" frankentty LICENSE
      ;;
  esac
  echo "packaged $asset ($(wc -c <"$asset" | tr -d ' ') bytes)"
}

step_package() {
  local name
  rm -rf "$RELEASE"
  mkdir -p "$RELEASE"
  for name in $SELECTED; do
    package_target "$name"
  done
  cp dist/frankentty.cjs "$RELEASE/frankentty.cjs"
  cp scripts/install.sh "$RELEASE/install.sh"
  cp scripts/install.ps1 "$RELEASE/install.ps1"
}

step_checksums() {
  local f
  cd "$RELEASE"
  rm -f SHA256SUMS
  : >SHA256SUMS.part
  for f in *; do
    [ "$f" = SHA256SUMS.part ] && continue
    printf '%s  %s\n' "$(sha256_of "$f")" "$f" >>SHA256SUMS.part
  done
  mv SHA256SUMS.part SHA256SUMS
  # Verify what was just written.
  while read -r hash name; do
    [ "$(sha256_of "$name")" = "$hash" ] || { echo "SHA256SUMS verify failed for $name"; exit 1; }
  done <SHA256SUMS
  cat SHA256SUMS
}

step_smoke() {
  local want got dir
  want=$(node -p "require('./package.json').version")
  dir="$ROOT/build/smoke"
  rm -rf "$dir"
  mkdir -p "$dir"
  tar -xzf "$RELEASE/$(asset_name "$HOST_NAME")" -C "$dir"
  [ -x "$dir/frankentty" ] || { echo "extracted frankentty is not executable"; exit 1; }
  got=$("$dir/frankentty" --version)
  echo "binary version: $got, package.json version: $want"
  [ "$got" = "$want" ]
}

run_step prereqs step_prereqs
run_step bundle step_bundle
run_step fetch-node step_fetch_all
run_step build-sea step_build_all
run_step package step_package
run_step checksums step_checksums
run_step smoke step_smoke

echo
echo "Release assets in release/:"
for f in "$RELEASE"/*; do
  printf '  %12s  %s\n' "$(wc -c <"$f" | tr -d ' ')" "$(basename "$f")"
done
echo
echo "RESULT: PASS"
