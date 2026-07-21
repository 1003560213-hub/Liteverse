# Liteverse graph and Refresh contract

## Runtime paths

The support directory owns mutable state:

```text
Graph/current.json
Graph/staged/<refresh-id>/snapshot.json
Graph/staged/<refresh-id>/manifest.json
Graph/history/
Graph/pending-update.json
Planning/partition-proposals/<proposal-set-id>.json
Planning/partition-snapshots/<decision-id>.json
Planning/partition-decisions.jsonl
Usage/events.jsonl
Usage/counts.json
```

Curator may create staged files and `pending-update.json`. Curator must never modify `Graph/current.json`, graph history, or Usage.

Partition proposal and choice commands write immutable truth only under `Planning/`. A proposal also atomically updates the rebuildable App projection `Graph/partition-proposals.json`; it never changes current, staged, pending-update, history, queues, or Usage. The decision ledger is append-only.

The App projection uses `schemaVersion: "liteverse-partition-proposals-v1"` and `status: "awaiting_user"`. Its top level directly exposes `proposalSetId`, `baseRevision`, `artifactFingerprint`, `searchSummary`, `truthPath`, `truthSha256`, and exactly three `options`. Each projected option contains `optionId`, `name`, `summary`, structured `tradeoffs.strengths`/`tradeoffs.limitations`, `regions` with primary-paper counts, complete assignments, and deterministic paper/region size metrics. After a valid choice, the same projection moves to `status: "selected"` and points to the append-only decision and unstaged snapshot. Planning truth remains authoritative.

## Partition decision gate

There is no default four-region taxonomy. Before a classification or reclassification, Curator must:

1. lock one source snapshot to current `baseRevision`, exact snapshot SHA-256, current paper-artifact fingerprint, and corpus paper-artifact fingerprint;
2. validate exactly three materially distinct options, each with 1–10 macro regions and complete paper assignments;
3. present all three options and wait for an explicit user choice, unless the user explicitly delegated recommendation and selection to Codex;
4. append one `liteverse-partition-decision-v1` record and write the selected ordinary unstaged snapshot;
5. invoke `stage-refresh.mjs` separately.

The selected snapshot carries `partitionDecision` with `decisionId`, `proposalSetId`, `optionId`, `baseRevision`, both artifact fingerprints, the fixed ledger path, and the canonical decision-record hash. If current revision or any locked artifact changes, selection and staging fail closed.

Explicit delegated authority such as “recommend and choose for me” counts as user confirmation. The decision still uses `--confirmed-by-user`; its `confirmationNote` must state `delegated choice` and the evidence-based recommendation rationale. A timeout, silence, or general preference does not count.

The selected snapshot also persists nebula assignments. Reused regions keep valid `nebulaAssetId` and `nebulaAssignmentOrder`. New regions consume assets unused by current categories before deterministically least-used reuse, and receive unique orders beginning above the current maximum.

The selected snapshot persists its three-dimensional layout rather than relying on render-time defaults. Preserve an unchanged reused region's valid center; treat preserved centers as occupied, and place new or changed macro centers deterministically on the bounded universe ellipsoid using option order and seed. Candidate scoring uses the hash-pinned default-background occupancy profile plus a soft default-camera projected-overlap penalty, so available blank regions are preferred without making overlap illegal or flattening depth. Recompute paper positions as stable golden-angle clouds around each primary center. For schema-v3 and every partition-decision snapshot, staging rejects any macro `center` or paper `position` that is not exactly three finite numbers.

Repartitioning may update machine-generated classification text in `projectRole`, but never rewrite its scientific-use body. Recognize the leading `Primary region: …; secondary region: ….` form and sentence-boundary `Classification: primary \`…\`` annotations. A compatibility matcher may also recognize historical non-English generated markers, but it must normalize them to the English canonical form. Remove only a recognized generated annotation, retain all preceding scientific text, and append a canonical annotation from the selected primary and optional secondary category. Ordinary academic uses of “classification” do not match and remain untouched. `classificationRationale` carries the new classification provenance separately.

To repair a selected-but-uncommitted snapshot without creating or altering a decision, rerun `apply-partition-choice.mjs` with the identical proposal, source snapshot, option, output path, and `--rebuild-selected`. This mode requires the selected App projection and exact append-only decision to match. If Refresh is already pending, pass the rebuilt snapshot to `stage-refresh.mjs --replace-pending` with a fresh refresh ID. When the existing manifest contains library items, also pass the exact same item IDs, paper IDs, and revisions through `--library-items`; otherwise omit that flag.

`stage-refresh.mjs` normally rejects category deletion. It permits macro-category replacement only when the selected snapshot and exactly one append-only ledger record agree on all decision fields, current/corpus fingerprints, complete selected category IDs, and the primary/secondary assignment hash. This exception never permits paper or relationship deletion.

## Revisions and staging

- `current.json` and staged snapshots have a positive integer `revision`.
- A staged snapshot's revision must be greater than the current base revision.
- `manifest.json` records `refreshId`, `baseRevision`, `targetRevision`, SHA-256 of the exact staged snapshot bytes, added/changed/removed paper and relation IDs, affected library item IDs/revisions, and animation defaults. Staging changes each listed item from `pending_codex` or `processing` to `ready_to_refresh`, increments its revision once, and puts that updated revision in the manifest.
- For schema v3, the manifest also records added/changed/removed galaxy IDs plus the validated hierarchy algorithm and assignment SHA-256. These are routing audit fields, not scientific relationship records.
- `pending-update.json` identifies the same refresh, revision pair, paths, and hash.
- Refuse to replace an existing pending refresh unless the caller explicitly requests recovery and the base revision still matches.
- Until Liteverse ships an explicit paper/relation deletion and rollback workflow, staging remains non-destructive for papers and relations. Category removal is allowed only by the partition decision gate above; otherwise every current category remains required.
- Recovery replacement must transfer, not recreate, the old pending batch. When the old manifest lists library items, the caller must pass the complete identical `{itemId, paperId, revision}` set with `--library-items`; each live item must still be `ready_to_refresh`, at that manifest revision, mapped to that paper, and owned by the old refresh. Replacement changes only its refresh ownership and does not increment the revision again. It may neither add nor silently drop a library item.
- Only the App native bridge validates and atomically promotes a staged snapshot.

## Complete snapshot schema

Stage a complete replacement graph, never a partial patch. Preserve existing optional visual fields while satisfying this mapping:

```json
{
  "schemaVersion": "3.0.0",
  "revision": 2,
  "title": "Liteverse",
  "updated": "ISO-8601 timestamp",
  "visuals": {},
  "hierarchy": {
    "schemaVersion": "liteverse-hierarchy-v1",
    "algorithm": "deterministic-galaxy-routing-v2",
    "assignmentSha256": "lowercase SHA-256",
    "relationProjection": "galaxy-lanes-from-paper-relations-v1"
  },
  "categories": [],
  "galaxies": [],
  "papers": [],
  "relations": [],
  "usagePolicy": {}
}
```

Category records have `kind: "macro" | "system"`. Macro records require `id`, `name`, `description`, `color`, and the App's visual placement/nebula fields when already present. The only system category is `liteverse-staging`; it does not count toward the ten-macro limit. Preserve every current category. Every new macro category requires the creation evidence defined in `taxonomy.md`.

For schema v3, `stage-refresh.mjs` additively materializes `hierarchy.schemaVersion: "liteverse-hierarchy-v1"`, deterministic `galaxies`, and one `paper.galaxyId` per paper after all scientific relation review is complete. Each galaxy has a stable anchor-derived ID, exactly one parent `categoryId`, a finite `position`, a packaged `assetId`, and `seedPaperId`. A paper's galaxy parent must equal its `primaryCategory`; a secondary category never creates a second galaxy membership. A non-empty macro region uses two through twelve galaxies when its paper count permits; one through three papers remain one group. The assignment hash covers galaxy routing, centers, assets, anchors, and paper membership without changing the root `3.0.0` schema.

The v2 layout treats the region center as the knowledge black hole and fills deterministic three-dimensional concentric orbits from the inside outward. The inner ring holds four galaxy centers and must be full before the outer eight-slot ring is used. Ring radii preserve the black-hole exclusion zone, depth offsets preserve camera parallax, and every available slot maintains the contract's minimum center separation. Galaxy artwork is assigned across the complete universe: use every supplied image once before any reuse, then keep global reuse counts within one while preserving compatible prior assignments where the balanced quota permits. A v1 hierarchy is re-derived in memory with v2 positions; only a later staged Refresh may persist it.

Galaxy membership is a deterministic visual/retrieval route, not a scientific classification or a relationship score. `relations[]` remains the only scientific relationship truth. The App may derive parallel galaxy lanes from original paper relations, but Curator must not persist aggregate strengths, confidences, or duplicate relation evidence. Existing valid galaxy records are retained during incremental additions; a full macro repartition may rebuild galaxies beneath affected parent categories. Neither materialization nor validation reads or writes Usage.

The staged manifest keeps `categories.added`, `categories.changed`, and `categories.removed` as the category diff. It also includes `categories.newCategories`, with one `{ categoryId, creationEvidence }` record per newly added category. `creationEvidence.memberIds` must exactly match the category's primary papers; the same validated existing-region scores, cluster consistency, and scope definition are copied from the snapshot so the classification decision remains auditable after staging.

Map each knowledge record to a paper star as follows:

| Graph field | Source |
|---|---|
| `id` | card `paper_id` |
| `title`, `authors`, `year` | verified metadata |
| `primaryCategory` | classification decision |
| `categoryIds` | primary plus optional secondary, both existing category IDs |
| `summary`, `projectRole`, `tags` | completed knowledge card |
| `source.storageMode` | `managed` or `linked`; absent legacy values mean `managed` |
| `source.pdfPath` and compatibility `pdfPath` | managed `Library/PDFs/<paper-id>.pdf`, or the exact normalized absolute linked path |
| `source.linkedRootPath`, `source.relativePath` | paired root and safe relative provenance for a linked folder item |
| `source.sha256` | SHA-256 of the managed or linked original PDF |
| `markdownPath` | `Knowledge/cards/<paper-id>.md` |
| `fulltextPath` | `Knowledge/fulltext/<paper-id>.md` |
| `artifacts` | card/fulltext paths, extraction state, card schema, evidence count, and `integrity` revision/hash pin |
| `verificationStatus` | explicit scientific-artifact state |
| `useCount` | always `0` in graph snapshots; runtime Usage is merged separately |

If both `secondaryCategory` and `categoryIds` are emitted, the secondary must be the only non-primary member of `categoryIds`. Unknown category references and removal of an existing category are invalid.

For a newly curated or re-curated paper, copy `Knowledge/papers.json`'s `artifacts.integrity` object into the staged graph paper. It pins `artifactRevision`, aggregate `artifactSha256`, source/card/full-text/claim SHA-256 values, immutable paths, and manifest path. A Doctor may repair the paper projection and immutable store, but it never writes the current graph; the next Curator Refresh closes any graph-pin warning.

`stage-refresh.mjs` validates linked source references structurally and re-hashes every linked PDF before it writes staged bytes. It rejects relative, non-normalized, missing, non-file, hash-mismatched, or symlinked paths/ancestors; requires each recorded path to equal its real path; and requires the PDF to remain within the selected root. Managed validation remains support-relative and backward compatible. Neither staging nor immutable artifact creation copies a linked PDF.

Backups include the graph/index source fields and their hashes but omit linked original PDF bytes. Managed PDFs remain governed by the backup's include-PDF option. Import preserves linked absolute references verbatim; missing files do not invalidate the backup archive itself, but workspace health and `liteverse doctor` must report `source.linked_missing` before curation or adoption relies on the original source.

Relations require `id`, `source`, `target`, semantic `type`/`label`, and evidence state. New or re-scored relations use the exact output fields from `score-connection.mjs`. Unscored migrated relations retain null `strength`/`confidence`, `legacyConfidence`, and their pending/legacy marker. Never create percentages by copying legacy values.

Schema v3 may be staged on top of schema v2 as a one-way migration. Do not stage a downgrade. For a legacy personal library, use `migrate-managed-library.py`: its run directory contains an immutable base-graph backup, per-paper hashes/status, artifact backups, and a complete `snapshot.json`. Re-running the same run verifies completed files and resumes failures. It refuses hash-mismatched managed PDFs and never edits `Graph/current.json`.

After curating migrated cards, run `finalize-curated-snapshot.py --support-dir <support> --snapshot <migration-run>/snapshot.json`. This required consistency gate checks each card against its managed PDF, verifies exact evidence locators/references and positive full-text page markers, then synchronizes full-text frontmatter and updates the unstaged snapshot's metadata, summaries, categories, and evidence counts. It validates the complete snapshot before writing any full text. It structurally refuses every `*/Graph/current.json` target and all files under `*/Graph/staged/` or `*/Graph/history/`, independent of the chosen support directory.

Store each relation review as the exact deterministic output of `score-connection.mjs`, then merge the review directory with `merge-relation-review.mjs --support-dir <support>`. The explicit support flag takes precedence over `LITEVERSE_SUPPORT_DIR`, which in turn precedes the default Application Support path. A full migration uses `--require-all`; the merge re-scores every file, refuses duplicate IDs or changed endpoints, preserves legacy values only as historical metadata, and applies the same structural current/staged/history target guard as finalization.

The staged snapshot revision must exceed `Graph/current.json`. Keep IDs stable, include all unchanged categories/papers/relations, and let `stage-refresh.mjs` compute the complete diff. Paper and relation removal is rejected while the App has no deletion confirmation or rollback UI.

## Paper and relation state

- Every paper has one primary category and at most one secondary category.
- Every paper starts with integer `useCount: 0`; Curator never changes it.
- Legacy relationships retain `legacyConfidence` and `scoringStatus: "legacy_unscored"` until re-evaluated.
- New scoring stores `strength`, `confidence`, rubric components, evidence IDs, and `status` (`suggestion`, `candidate`, or `verified`).
- The App omits suggestion lines, draws candidate lines dashed, and verified lines solid.

## Queue state

Literature follows `pending_codex -> processing -> ready_to_refresh -> organized`. Lock an item by ID and revision before processing. A staged manifest carries those revisions; stale revisions must not be organized. An annotation follows the same revision discipline and is marked processed only after all derived files and the staged snapshot are durable.

## Visual temperature

Retriever alone increments `useCount`. The App maps a paper count to `min(1, log1p(useCount) / log1p(32))`. Region brightness is the mean normalized heat of primary-category members, not a sum.
