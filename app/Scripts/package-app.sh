#!/bin/bash
# Wrap the SwiftPM executable in Cookie Agent.app.
# Run on a Mac, from anywhere. The bundle file name is not Cookie.app.
set -euo pipefail

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
cp "$ROOT/app/Support/Info.plist" "$DEST/Contents/Info.plist"
plutil -insert CookieRepoRoot -string "$ROOT" "$DEST/Contents/Info.plist"
chmod +x "$DEST/Contents/MacOS/CookieAgent"
codesign --force --sign - "$DEST"
plutil -lint "$DEST/Contents/Info.plist" >/dev/null
test -x "$DEST/Contents/MacOS/CookieAgent"
echo "built $DEST"
