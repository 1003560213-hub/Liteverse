# Contributing to Liteverse

Thank you for helping improve Liteverse. Contributions should preserve its
local-first, evidence-aware, and fail-closed design.

## Before opening a change

- Discuss substantial behavior or data-contract changes in an issue first.
- Keep pull requests focused and explain the user-visible outcome.
- Do not commit personal papers, research notes, project memory, absolute home
  paths, task identifiers, runtime workspaces, credentials, logs, or backups.
- Use small, fictional fixtures. Do not derive examples from a private research
  library, even when the source paper is public.
- Preserve the empty first-run universe and the separation between immutable
  truth, append-only events, and rebuildable projections.

## Local development

Requirements: macOS 13 or later, Node.js 24 or later, and Python 3.12 or later.

```bash
python3 -m pip install --requirement requirements.txt
npm install
npm run typecheck:app
npm run lint
npm test
```

The native desktop package is macOS-only:

```bash
npm run desktop:package
```

Do not launch a packaged app as part of an automated test. Native contract tests
exercise the bridge without opening the application window.

## Skills

The three Skills under `skills/` are public integration code. Keep their
instructions concise, provider-neutral where possible, and free of personal
project examples. Validate every changed Skill:

```bash
python3 "$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py" \
  skills/liteverse-curator
python3 "$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py" \
  skills/liteverse-retriever
python3 "$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py" \
  skills/liteverse-research-memory
```

If that validator is unavailable, verify that each `SKILL.md` has only `name`
and `description` in its YAML frontmatter and that the directory name matches
the Skill name.

## Pull-request checklist

- Tests cover the changed behavior and relevant failure modes.
- UI text, documentation, examples, errors, and fixtures are in English.
- No feature silently weakens hash, revision, provenance, or queue validation.
- `data/empty-universe.json` remains free of papers, relations, and regions.
- Generated build output and local runtime state remain untracked.
- New visual or third-party assets include clear redistribution rights.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
