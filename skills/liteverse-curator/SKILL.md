---
name: liteverse-curator
description: Organize or migrate Liteverse PDF and arXiv libraries, convert papers into full-text and knowledge-card Markdown, search a corpus and propose exactly three user-selectable macro-partition schemes, apply only an explicitly chosen partition, create or re-evaluate evidence-backed paper relationships, integrate handwritten annotations, and prepare an atomic staged graph for App Refresh. Use whenever Codex is asked to process the Liteverse literature or annotation queue, curate new papers, classify or repartition literature without default regions, score connections, or make a refresh batch ready.
---

# Liteverse Curator

Curate evidence first, obtain an explicit partition decision, then publish one complete staged revision. Never edit `Graph/current.json`.

## Workflow

1. Resolve the support directory from `--support-dir`, `LITEVERSE_SUPPORT_DIR`, or `~/Library/Application Support/Liteverse`.
2. Run `scripts/list-queue.mjs --json`. Record each literature or annotation ID and revision before reading files. Refuse to finalize an item whose revision changed.
3. Materialize each upload with `scripts/materialize-paper.py`. Let the script hash and deduplicate the source, preserve the PDF, write page-marked full text, and create a knowledge-card skeleton. For a legacy graph with external PDF paths, first run `scripts/migrate-managed-library.py` without `--apply`, inspect its plan, then rerun with `--apply`. It writes a resumable manifest, backups, managed PDFs, draft artifacts, and a schema-v3 snapshot input without changing the current graph.
4. Read the full text or original PDF and complete every supported card claim with evidence locators. Treat an unreadable scan as `needs_ocr`; do not invent a summary.
5. Read `references/taxonomy.md`. Search the cards, claims, and verified relations across the complete corpus. Design exactly three materially distinct options with 1–10 macro regions, complete primary assignments, optional single secondary assignments, evidence IDs, strategy, rationale, and structured strengths/limitations. Do not treat any historical four-region layout as a default. To avoid manually expanding many assignments, write a compact three-option plan and run `scripts/compose-partition-options.mjs`; it verifies pinned claim sidecars and deterministically expands the plan.
6. Run `scripts/propose-partitions.mjs --snapshot <unstaged-snapshot> --options <expanded-options.json>`. Present its three options to the user and stop unless the user has explicitly delegated selection by saying, for example, “recommend and choose for me” or “use your recommended option without asking again.” A proposal alone is not permission to classify, stage, or refresh.
7. After the user explicitly chooses one option—or explicitly delegates that choice to Codex—run `scripts/apply-partition-choice.mjs` with that option ID, `--confirmed-by-user`, a confirmation note, and an ISO decision time. For delegation, the note must identify it as a `delegated choice` and record the recommendation basis. The script rechecks `baseRevision`, the exact source snapshot, and current/corpus artifact fingerprints, appends the choice, assigns persistent unused-first nebula assets, deterministically regenerates finite category centers and paper positions, and writes an ordinary unstaged snapshot. Never infer a choice from silence or a prior preference. Use `--rebuild-selected` only to regenerate the exact already-recorded selection; it adds no decision and cannot change the option.
8. Read `references/relation-rubric.md`. Screen candidate pairs, read both source papers, then pass a scoring JSON document to `scripts/score-connection.mjs`. Keep project relevance separate from scientific strength.
9. Treat handwritten notes as user observations or questions until checked against the full text or PDF. Update cards and relationships only with the annotation ID and revision retained in provenance.
10. After scientific card curation, run `scripts/finalize-curated-snapshot.py` against the unstaged schema-v3 snapshot. For verified/needs-attention cards it requires exact original-source evidence locators, valid `[E#]` references on every scientific bullet, and a positive full-text page marker. It validates every paper before writing any full text, then synchronizes metadata and derives graph summaries/status.
11. Run `scripts/generate-claims.mjs --snapshot <same-unstaged-snapshot>`. It creates stable claim sidecars plus immutable, hash-pinned card/full-text revisions, updates the rebuildable paper projection, and copies the integrity pin into that snapshot. It structurally refuses current, staged, and history graphs.
12. Merge reviewed deterministic relation outputs into that snapshot with `scripts/merge-relation-review.mjs --support-dir <path>`. The flag overrides `LITEVERSE_SUPPORT_DIR`. Use `--require-all` for a full legacy re-score; the script re-runs the scoring formula and refuses changed endpoints or duplicates. Both finalization and merge structurally refuse `*/Graph/current.json` and all targets under `*/Graph/staged/` or `*/Graph/history/`.
13. Validate the chosen complete graph and stage it with `scripts/stage-refresh.mjs`. Category replacement is accepted only when its snapshot points to the matching append-only partition decision. The script writes `Graph/staged/<refresh-id>/` plus `Graph/pending-update.json`; it never promotes the graph.
14. Mark exactly one annotation with `scripts/mark-annotation.mjs --id <id> --revision <n> --refresh-id <id> --derived-file <path>`. The script verifies provenance markers, staged bytes, hash, and revision before updating the annotation and audit. Never bulk-mark annotations.

## Non-negotiable rules

- Do not seed a fixed taxonomy or silently continue the historical four-region layout. Every partition decision starts with exactly three corpus-derived options and ends with one explicit user selection.
- Treat an explicit request for Codex to recommend and choose as delegated selection authority, not as silence. Keep `--confirmed-by-user`, and make `confirmationNote` state `delegated choice` plus the scientific recommendation basis. Without direct selection or this delegation, wait.
- Rewrite only recognized machine-generated region annotations in `projectRole`: the documented leading prefixes and sentence-boundary classification tails. Preserve the scientific-use body and ordinary academic uses of “classification.” Normalize any recognized legacy marker to the canonical English annotation.
- Do not silently promote `needs_attention` evidence. The compact composer may use it only when both paper and claim have that state and the claim retains evidence; mark every resulting assignment provisional and expose it in metadata.
- Do not create a narrow region for an isolated paper. Every newly created macro region requires at least four primary papers and at least 70% within-cluster consistency. For an automatic incremental region, every member must also fit all existing regions below 60%; for an explicit full-corpus repartition, record old-region scores transparently as 0–100 diagnostics but do not use the 60% cutoff to veto a competing taxonomy. Keep smaller groups in `liteverse-staging` as provisional; it is not a macro region.
- Do not let proposal or selection scripts write `Graph/current.json`, `Graph/staged/`, `Graph/pending-update.json`, queues, or Usage. The selected output remains unstaged until `stage-refresh.mjs` passes independently.
- Do not establish a formal relationship without located evidence from both original papers.
- Do not translate legacy `verified` flags into `evidence_verified`. Mechanical extraction produces `card_draft` or `needs_ocr`; evidence verification requires a later original-source review.
- Preserve an old `confidence` as `legacyConfidence`; never reinterpret it as the new relationship strength.
- Do not modify `Usage/events.jsonl`, `Usage/counts.json`, `useCount`, or any visual temperature.
- Do not automatically download or add suggested literature outside the user's library.
- Do not promote staged data to `Graph/current.json`; only the App commit bridge may do that.
- Never use a finalization or relation-merge script to rewrite `Graph/current.json`, an already staged refresh, or graph history, even when those paths are outside the configured support directory.
- Do not overwrite a mismatched managed PDF or backup. Stop on hash conflicts and resume through the migration manifest after the conflict is resolved.
- Do not edit queue JSON by hand. Use `list-queue.mjs`, then preserve the locked revision through materialization, staging, and single-annotation marking.

## Resources

- Read `references/markdown-schema.md` before completing cards or full-text files.
- Read `references/taxonomy.md` for region creation and assignment rules.
- Read `references/relation-rubric.md` before scoring or reviewing a link.
- Read `references/graph-contract.md` before staging a refresh or changing queue state.
- Read `references/queue-contract.md` before reading or updating literature and annotation queues.

Run scripts with `--help` for their complete deterministic interfaces.
