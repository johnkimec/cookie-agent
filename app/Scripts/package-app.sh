#!/bin/bash
# Wrap the SwiftPM executable in Cookie Agent.app.
# Run on a Mac, from anywhere. The bundle file name is not Cookie.app.
#
# SwiftPM writes dependency resources next to the binary
# (iosMath fonts, HighlightJS, MarkdownText assets). Bundle.module looks in
# Contents/Resources first, not in .build. Copy those *.bundle directories in.
#
# MarkdownText's Assets.xcassets and Media.xcassets are the only resources on
# SwiftStreamingMarkdown's library product, so the build still runs actool.
# There is no other asset product to switch to, and this script does not fork
# the package. A machine that has never run `xcodebuild -runFirstLaunch`
# fails that compile until Xcode's first-launch packages are installed.
set -euo pipefail

copy_resource_bundles() {
  local bin="$1"
  local dest_resources="$2"
  local release_dir real_bin real_dir dir bundle name
  release_dir="$(dirname "$bin")"
  real_bin="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$bin")"
  real_dir="$(dirname "$real_bin")"
  shopt -s nullglob
  for dir in "$release_dir" "$real_dir"; do
    for bundle in "$dir"/*.bundle; do
      name="$(basename "$bundle")"
      if [[ ! -d "$dest_resources/$name" ]]; then
        cp -R "$bundle" "$dest_resources/$name"
      fi
    done
  done
  shopt -u nullglob

  local required=(
    iosMath_iosMath.bundle
    HighlightSwift_HighlightSwift.bundle
    SwiftStreamingMarkdown_SwiftStreamingMarkdown.bundle
  )
  for name in "${required[@]}"; do
    if [[ ! -d "$dest_resources/$name" ]]; then
      echo "packaged app is missing Contents/Resources/$name" >&2
      echo "swift build should leave that bundle next to CookieAgent." >&2
      exit 1
    fi
  done
  require_iosmath_font "$dest_resources/iosMath_iosMath.bundle"
}

# Swift 6.3.3 leaves the font at the bundle root. Swift 6.4 builds a
# standard bundle and nests it under Contents/Resources. Either file is enough.
require_iosmath_font() {
  local bundle="$1"
  local flat="$bundle/fonts/latinmodern-math.otf"
  local standard="$bundle/Contents/Resources/fonts/latinmodern-math.otf"
  if [[ -f "$flat" || -f "$standard" ]]; then
    return 0
  fi
  echo "iosMath bundle is missing fonts/latinmodern-math.otf" >&2
  echo "checked $flat" >&2
  echo "checked $standard" >&2
  return 1
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:-"$ROOT/dist/Cookie Agent.app"}"

swift build --package-path "$ROOT/app" -c release
BIN="$ROOT/app/.build/release/CookieAgent"
if [[ ! -x "$BIN" ]]; then
  echo "missing $BIN" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST/Contents/MacOS" "$DEST/Contents/Resources"
cp "$BIN" "$DEST/Contents/MacOS/CookieAgent"
copy_resource_bundles "$BIN" "$DEST/Contents/Resources"
cp "$ROOT/app/Support/Info.plist" "$DEST/Contents/Info.plist"
plutil -insert CookieRepoRoot -string "$ROOT" "$DEST/Contents/Info.plist"
chmod +x "$DEST/Contents/MacOS/CookieAgent"
codesign --force --sign - "$DEST"
plutil -lint "$DEST/Contents/Info.plist" >/dev/null
test -x "$DEST/Contents/MacOS/CookieAgent"
echo "built $DEST"
