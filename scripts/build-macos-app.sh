#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
APP="$ROOT/Liteverse.app"
CONTENTS="$APP/Contents"

cd "$ROOT"
npm run typecheck:app
npm run validate:data
npm run desktop:build

rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources/web"

ICONSET="$ROOT/build/Liteverse.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for SPEC in \
  "16 icon_16x16.png" \
  "32 icon_16x16@2x.png" \
  "32 icon_32x32.png" \
  "64 icon_32x32@2x.png" \
  "128 icon_128x128.png" \
  "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" \
  "512 icon_256x256@2x.png" \
  "512 icon_512x512.png" \
  "1024 icon_512x512@2x.png"; do
  SIZE="${SPEC%% *}"
  NAME="${SPEC#* }"
  /usr/bin/sips -z "$SIZE" "$SIZE" "$ROOT/public/liteverse-brand.png" \
    --out "$ICONSET/$NAME" >/dev/null
done
/usr/bin/iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/Liteverse.icns"

/usr/bin/clang \
  -fobjc-arc \
  -mmacosx-version-min=13.0 \
  -framework Cocoa \
  -framework UniformTypeIdentifiers \
  -framework WebKit \
  -lsqlite3 \
  "$ROOT/macos/LiteverseApp.m" \
  -o "$CONTENTS/MacOS/Liteverse"

/bin/zsh "$ROOT/scripts/build-local-worker.sh" "$CONTENTS/MacOS/LiteverseLocalWorker"

/usr/bin/ditto "$ROOT/dist-desktop" "$CONTENTS/Resources/web"
/usr/bin/find "$CONTENTS/Resources/web" -name '.DS_Store' -delete
# The UI never displays these sources above the sizes below. Pre-scaling the
# packaged copies avoids decoding multi-megapixel artwork just to immediately
# downsample it into an offscreen canvas; the original user assets stay intact.
/usr/bin/sips -z 256 256 "$ROOT/public/liteverse-brand.png" \
  --out "$CONTENTS/Resources/web/liteverse-brand.png" >/dev/null
/usr/bin/sips -c 355 355 --cropOffset 120 630 "$ROOT/public/liteverse-star-source.png" \
  --out "$CONTENTS/Resources/web/liteverse-star-source.png" >/dev/null
/usr/bin/sips -z 256 256 "$CONTENTS/Resources/web/liteverse-star-source.png" \
  --out "$CONTENTS/Resources/web/liteverse-star-source.png" >/dev/null
for REGION_ASSET in "$CONTENTS/Resources/web/nebula-regions"/*.png; do
  /usr/bin/sips -Z 768 "$REGION_ASSET" --out "$REGION_ASSET" >/dev/null
done
/bin/cp "$ROOT/data/empty-universe.json" "$CONTENTS/Resources/seed-universe.json"
mkdir -p "$CONTENTS/Resources/CodexSkills"
/usr/bin/rsync -a --delete --exclude '__pycache__' --exclude '*.py[cod]' \
  "$ROOT/skills/" "$CONTENTS/Resources/CodexSkills/"
mkdir -p "$CONTENTS/Resources/LiteverseCLI/lib"
/bin/cp "$ROOT/scripts/liteverse-cli.mjs" "$CONTENTS/Resources/LiteverseCLI/liteverse-cli.mjs"
/usr/bin/rsync -a --delete --include 'liteverse-*.mjs' --exclude '*' \
  "$ROOT/scripts/lib/" "$CONTENTS/Resources/LiteverseCLI/lib/"
/bin/chmod +x "$CONTENTS/Resources/LiteverseCLI/liteverse-cli.mjs"
/bin/cp "$ROOT/scripts/install-codex-skills.sh" "$CONTENTS/Resources/install-codex-skills.sh"
/bin/chmod +x "$CONTENTS/Resources/install-codex-skills.sh"
# Public builds start with a private, empty workspace. Existing users keep the
# graph already stored in Application Support; personal research cards are
# deliberately never bundled into a distributable app.
mkdir -p "$CONTENTS/Resources/seed-papers"
/bin/cp "$ROOT/macos/Info.plist" "$CONTENTS/Info.plist"
if [[ -n "${LITEVERSE_WORKSPACE_DIRECTORY:-}" ]]; then
  if [[ ! "$LITEVERSE_WORKSPACE_DIRECTORY" =~ '^[A-Za-z0-9._-]{1,64}$' ]] || \
      [[ "$LITEVERSE_WORKSPACE_DIRECTORY" == "." || "$LITEVERSE_WORKSPACE_DIRECTORY" == ".." ]]; then
    echo "Invalid LITEVERSE_WORKSPACE_DIRECTORY" >&2
    exit 1
  fi
  /usr/libexec/PlistBuddy -c \
    "Add :LiteverseWorkspaceDirectory string $LITEVERSE_WORKSPACE_DIRECTORY" \
    "$CONTENTS/Info.plist"
fi
/usr/bin/xattr -cr "$APP"
/usr/bin/codesign --force --deep --sign - "$APP"
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
/usr/bin/xattr -dr com.apple.provenance "$APP" 2>/dev/null || true

/usr/bin/plutil -lint "$CONTENTS/Info.plist"
/usr/bin/codesign --verify --deep --strict "$APP"

echo "Liteverse.app was created at: $APP"
