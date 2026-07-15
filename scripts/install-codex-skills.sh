#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
if [[ -d "$SCRIPT_DIR/../skills" ]]; then
  SOURCE_DIR="${SCRIPT_DIR}/../skills"
  CLI_SOURCE_DIR="$SCRIPT_DIR"
elif [[ -d "$SCRIPT_DIR/CodexSkills" ]]; then
  SOURCE_DIR="${SCRIPT_DIR}/CodexSkills"
  CLI_SOURCE_DIR="${SCRIPT_DIR}/LiteverseCLI"
else
  echo "Liteverse Codex Skills source was not found." >&2
  exit 2
fi

CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
DESTINATION="$CODEX_ROOT/skills"
mkdir -p "$DESTINATION"

for SKILL in liteverse-curator liteverse-retriever liteverse-research-memory; do
  if [[ ! -f "$SOURCE_DIR/$SKILL/SKILL.md" ]]; then
    echo "Missing bundled Skill: $SKILL" >&2
    exit 2
  fi
  /usr/bin/rsync -a --delete --exclude '__pycache__' --exclude '*.py[cod]' \
    "$SOURCE_DIR/$SKILL/" "$DESTINATION/$SKILL/"
done

if [[ ! -f "$CLI_SOURCE_DIR/liteverse-cli.mjs" || ! -d "$CLI_SOURCE_DIR/lib" ]]; then
  echo "Liteverse CLI source was not found." >&2
  exit 2
fi

CLI_DESTINATION="$CODEX_ROOT/liteverse-cli"
mkdir -p "$CLI_DESTINATION" "$CODEX_ROOT/bin"
/usr/bin/rsync -a --delete \
  --include 'liteverse-cli.mjs' --include 'lib/' --include 'lib/liteverse-*.mjs' --exclude '*' \
  "$CLI_SOURCE_DIR/" "$CLI_DESTINATION/"
/bin/chmod +x "$CLI_DESTINATION/liteverse-cli.mjs"
/bin/ln -sfn "$CLI_DESTINATION/liteverse-cli.mjs" "$CODEX_ROOT/bin/liteverse"

echo "Liteverse Codex Skills installed in: $DESTINATION"
echo "Liteverse CLI installed at: $CODEX_ROOT/bin/liteverse"
