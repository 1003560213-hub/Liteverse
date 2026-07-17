#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
OUTPUT="${1:-$ROOT/build/LiteverseLocalWorker}"
SWIFTC="${LITEVERSE_SWIFTC:-$(/usr/bin/xcrun --find swiftc)}"
SDK="${LITEVERSE_MACOS_SDK:-$(/usr/bin/xcrun --sdk macosx --show-sdk-path)}"
ARCH="${LITEVERSE_ARCH:-$(/usr/bin/uname -m)}"

/bin/mkdir -p "${OUTPUT:h}"

if ! "$SWIFTC" \
  -swift-version 5 \
  -O \
  -parse-as-library \
  -sdk "$SDK" \
  -target "$ARCH-apple-macosx13.0" \
  -framework Foundation \
  -framework PDFKit \
  -framework CryptoKit \
  "$ROOT/macos/LiteverseLocalWorker.swift" \
  -o "$OUTPUT"; then
  print -u2 "LiteverseLocalWorker could not compile. Ensure swiftc and the selected macOS SDK come from the same Xcode or Command Line Tools installation."
  exit 1
fi

/usr/bin/codesign --force --sign - "$OUTPUT"
/usr/bin/codesign --verify --strict "$OUTPUT"

print "LiteverseLocalWorker was created at: $OUTPUT"
