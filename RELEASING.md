# Release checklist

Use this checklist from a clean clone of the public repository. Never prepare a
release by copying a live Liteverse Application Support workspace.

## Repository hygiene

1. Confirm that `data/` contains only the empty universe and empty annotation
   seed, and that `examples/` contains only fictional, domain-neutral fixtures.
2. Search tracked files for personal paths, names, credentials, research-domain
   examples, non-English prose, runtime ledgers, PDFs, backups, databases, logs,
   and generated packages.
3. Review every new binary asset and record its redistribution terms in
   `ASSET_LICENSES.md`.
4. Confirm that ignored output such as `node_modules/`, `dist/`,
   `dist-desktop/`, `build/`, `Liteverse.app/`, `tmp/`, `.wrangler/`, and local
   environment files is absent from the release commit.
5. Review dependency and secret-scanning alerts before tagging.

## Verification

```bash
npm ci
npm run typecheck:app
npm run lint
npm test
npm run desktop:package
```

Validate all three Skills with the Skill Creator validator described in
`CONTRIBUTING.md`. Inspect the packaged bundle and confirm that it contains
`seed-universe.json` with zero papers, zero relations, and zero categories, plus
an empty `seed-papers/` directory.

The test and packaging flow must not launch Liteverse or read the maintainer's
live `~/Library/Application Support/Liteverse/` workspace.

## Distribution

1. Update the package version, `macos/Info.plist`, release notes, and tag
   consistently.
2. Build from the reviewed tag. The repository's default package is ad-hoc
   signed for local testing only.
3. Public macOS distribution requires the distributor's Developer ID signing,
   hardened-runtime configuration, notarization, and stapling outside this
   repository's default build script.
4. Publish SHA-256 checksums for downloadable artifacts.
5. Install the artifact on a clean macOS account and verify empty onboarding,
   PDF/arXiv import, search, backup validation, and App Refresh before announcing
   the release.
