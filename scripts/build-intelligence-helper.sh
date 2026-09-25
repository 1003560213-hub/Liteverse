#!/bin/zsh
# Builds the optional Apple Intelligence helper. It needs the macOS 26 SDK
# (Xcode 26 or later). With an older SDK the helper is skipped and Liteverse
# reports that on-device summaries are unavailable; everything else works.
set -euo pipefail

ROOT="${0:A:h:h}"
OUTPUT="${1:-$ROOT/build/LiteverseIntelligence}"
SWIFTC="${LITEVERSE_SWIFTC:-$(/usr/bin/xcrun --find swiftc)}"
SDK="${LITEVERSE_MACOS_SDK:-$(/usr/bin/xcrun --sdk macosx --show-sdk-path)}"
SDK_VERSION="$(/usr/bin/xcrun --sdk macosx --show-sdk-version)"
ARCH="${LITEVERSE_ARCH:-$(/usr/bin/uname -m)}"

if [[ "${SDK_VERSION%%.*}" -lt 26 ]]; then
  print -u2 "Skipping LiteverseIntelligence: the macOS ${SDK_VERSION} SDK has no FoundationModels framework (needs 26+)."
  exit 0
fi

/bin/mkdir -p "${OUTPUT:h}"
"$SWIFTC" \
  -swift-version 5 \
  -O \
  -parse-as-library \
  -sdk "$SDK" \
  -target "$ARCH-apple-macosx26.0" \
  -framework Foundation \
  -framework FoundationModels \
  "$ROOT/macos/LiteverseIntelligence.swift" \
  -o "$OUTPUT"

/usr/bin/codesign --force --sign - "$OUTPUT"
/usr/bin/codesign --verify --strict "$OUTPUT"
print "LiteverseIntelligence was created at: $OUTPUT"
