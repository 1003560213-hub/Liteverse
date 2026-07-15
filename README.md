# Liteverse

Liteverse is a local-first research-memory workspace. It combines an explorable
literature universe with evidence-aware retrieval and durable project memory:

- **Literature truth** preserves PDFs, page-marked full text, knowledge cards,
  stable claims, and evidence-backed paper relationships.
- **Project memory** preserves goals, conventions, decisions, code and experiment
  metadata, findings, conflicts, open questions, and task handoffs.
- **Task context** records the exact claims, evidence, artifact revisions, and
  project conventions that an AI task actually adopted.

Papers remain the stars in the 3D universe. Claims, code, experiments, and task
history are available in the Memory and Context interfaces without permanently
adding them to the high-cost 3D scene.

The macOS app keeps its mutable workspace under:

```text
~/Library/Application Support/Liteverse/
```

New installations start with an empty universe. Personal PDFs, knowledge,
project memory, annotations, usage events, and graph data are never bundled into
a public build.

## Three Skills, one local interface

Liteverse deliberately uses three Skills with non-overlapping responsibilities:

1. **`liteverse-curator`** ingests queued PDF/arXiv papers, deduplicates them,
   produces full-text and card Markdown, generates claims, assigns papers within
   a user-approved broad taxonomy, scores evidence-backed relationships,
   integrates annotations, and stages an atomic App Refresh. For a first
   taxonomy or an explicit repartition, it searches the complete verified
   library and presents exactly three materially different options; it never
   chooses one without an explicit selection or delegated-choice instruction.
   It does not write usage or project memory.
2. **`liteverse-retriever`** searches, reads, compares, cites, and applies
   verified literature. It builds Context Packs and records auditable adoption
   only after verifying pinned artifact hashes. It does not curate papers or
   rewrite project decisions.
3. **`liteverse-research-memory`** maintains append-only, multi-project goals,
   conventions, assumptions, decisions, findings, code/experiment metadata,
   conflicts, task results, and handoffs. Paper evidence must arrive through a
   Retriever receipt; this Skill never modifies the literature truth layer.

The same deterministic core is exposed through the provider-neutral `liteverse`
local CLI. Codex is the first adapter. A stdio MCP adapter is a future extension
and is **not implemented in version 0.3.2**.

When working with an AI, natural language is enough. For example:

> Use the Liteverse library to complete this simulation-code task.

This instruction activates literature retrieval. If the task produces reusable
research, code, experiment, or decision knowledge, Research Memory records it as
an append-only project event. AI inferences remain provisional; only exact paper
evidence or reproducible computation-artifact metadata can support a result.

## Core workflow

1. Select or create a project in Liteverse.
2. Open **Settings → Literature** and add either a PDF or an arXiv link.
3. Run Codex in this project. Curator processes the queue. When the library
   needs its first macro taxonomy, or when repartitioning is requested, Codex
   searches the current library and presents exactly three alternatives with
   their trade-offs. No option is preselected and the current graph is unchanged.
4. Reply to Codex with the chosen option, or explicitly delegate the choice to
   Codex and ask it to use its recommendation. Curator records the exact option
   and the delegation rationale, validates it against the graph revision and
   artifact fingerprint, and only then prepares an immutable staged graph. A
   delegated choice is an auditable user decision, not a silent default.
5. Choose **Refresh** in the App. The native bridge validates and atomically
   promotes the staged graph.
6. Ask Codex to use Liteverse, or use `liteverse context build`, for a research,
   writing, or code task. Search is free; verified evidence actually adopted by
   the task is counted once per task, project, and paper.
7. Reusable outcomes are appended to the selected project's memory and can be
   inspected in **Memory Center**, while the exact AI input is available in
   **AI Context Center**.

Liteverse does not launch Codex in the background and does not treat shared tags,
filenames, user notes, or AI inference as scientific evidence.

## CLI

From this repository, use `npm run liteverse -- <command>`. After installing the
bundled integration, use `${CODEX_HOME:-~/.codex}/bin/liteverse` directly.

```bash
# System health and immutable-artifact checks
npm run liteverse -- status
npm run liteverse -- doctor
npm run liteverse -- doctor --fix
npm run liteverse:index

# Search is read-only and never increments usage
npm run liteverse -- search --query "spectral solver stability" --limit 8
npm run liteverse -- memory search --project project-default --query "grid"

# Build a version-pinned JSON + Markdown Context Pack
npm run liteverse -- context build \
  --project project-default \
  --query "boundary conditions for the reference simulation" \
  --budget-chars 18000

# Adopt a minimal verified evidence slice
npm run liteverse -- evidence read \
  --paper <paper-id> --claim <claim-id> --max-chars 5000

# Project and task lifecycle
npm run liteverse -- project create-or-init --project <project-id> --name "Project"
npm run liteverse -- task begin --project <project-id> --summary "Task summary"
npm run liteverse -- task complete --project <project-id> --result-summary "Result summary"
```

Task identity resolves from `--task-id` only for controlled testing or recovery,
then `LITEVERSE_TASK_ID`, then Codex's `CODEX_THREAD_ID`. Only its SHA-256 hash is
persisted. Other AI adapters should provide `LITEVERSE_TASK_ID`; raw task IDs are
never stored in filenames, ledgers, projections, Context Packs, or handoffs.

## Storage and provenance

The literature library is shared across projects, so one PDF and its verified
knowledge are stored only once. Project memory, task history, Context Packs, and
paper roles stay isolated by project.

```text
Library/PDFs/                         managed canonical PDFs
Knowledge/fulltext/                   current page-marked extraction Markdown
Knowledge/cards/                      current structured knowledge cards
Knowledge/claims/                     stable claim projections
Knowledge/artifacts/<paper>/
  revisions/<revision>/               immutable card/fulltext/claim revisions
  current.json                        rebuildable artifact pointer
Knowledge/papers.json                 rebuildable literature projection

Projects/projects.json                project registry and active project
Projects/<project>/
  memory/events.jsonl                 append-only project-memory truth
  memory/current.json                 rebuildable active-memory projection
  tasks.json                          rebuildable task projection
  Tasks/<task-hash>/
    context-packs/                    version-pinned JSON + Markdown AI context
    handoffs/                         JSON + Markdown task continuation packets

Graph/current.json                    graph currently displayed by the App
Graph/staged/                         immutable Refresh candidates
Graph/history/                        committed graph history
Usage/events.jsonl                    append-only evidence-adoption audit
Usage/counts.json                     rebuildable global/project usage cache
Cache/                                rebuildable FTS5/BM25 search index
```

Immutable artifacts and append-only ledgers are the source of truth. Graph,
catalog, memory, task, Library, and usage projections are validated views that
can be rebuilt. The `Cache/` search index contains no unique knowledge and is
excluded from backup. A malformed ledger, missing revision, or SHA-256 mismatch
fails closed; it is never interpreted as an empty workspace.

Do not edit `Graph/current.json`, artifact pointers, project projections, queue
files, or Usage files by hand. Run `liteverse doctor` when an artifact or
projection is rejected.

## Context Pack and usage semantics

A Context Pack is produced as matching JSON and Markdown. It pins the project,
hashed task ID, Graph and Memory revisions, selected claims and evidence
locators, artifact hashes, selection reasons, conventions, limitations,
counter-evidence, conflicts, and unresolved questions. Retrieval is local FTS5
with BM25, structured fields, and verified graph relationships; cloud embeddings
are not used by default.

Search and candidate preview do not count as use. `context build` and
`evidence read` count a paper only after all requested artifacts pass integrity
checks. The unique key is the hashed task ID plus project ID plus paper ID, so:

- repeated adoption in one task and project counts once;
- use in another project or task counts independently;
- global counts still aggregate the shared paper's total use;
- Curator conversion, App clicks, manual Markdown/PDF opening, and validation do
  not change temperature.

The App can switch between project and global heat. It maps integer `useCount`
with `min(1, log1p(useCount) / log1p(32))`; region heat is the mean normalized
heat of its primary papers rather than a raw total.

## Data model and trust states

- Liteverse ships without a default macro taxonomy. A first taxonomy or a
  requested repartition requires three complete Codex proposals and an explicit
  user decision; the App can preview those proposals but cannot apply one.
- A paper belongs to one macro region and may have one secondary region.
- There can be at most ten macro regions. Isolated papers remain provisional;
  they do not create narrow nebulae.
- `evidence_verified` means source, artifact revision, knowledge-card schema, and
  evidence locators have passed validation.
- Candidate relationships are dashed, verified relationships are solid, and
  legacy unscored links remain deliberately faint.
- Old relation confidence values remain historical `legacyConfidence`; they are
  never reinterpreted as reproducible scientific strength.
- User statements are `user_declared`; AI inference is `provisional`; supported
  memory requires an exact Retriever receipt or reproducible computation
  artifact. Superseded and contradicted entries remain visible.
- Code and experiments store paths, Git commit/content/config/data hashes,
  commands, tests, and summaries—not repositories or large simulation data.

## Development

Requirements: macOS 13 or later and Node.js 22.13 or later.

```bash
npm install
npm run dev
npm run lint
npm test
npm run desktop:package
```

Useful focused checks:

```bash
npm run typecheck:app
npm run validate:data
npm run liteverse:doctor
node scripts/codex-note-queue.mjs list
node scripts/codex-workspace-queue.mjs list
```

### Runtime performance contract

- Catalog synchronization is content-addressed and idempotent. An unchanged
  graph must not rewrite `library.json` or wake the workspace observer.
- PDF integrity hashes are cached by path, inode, size, and modification time;
  a changed file is always re-hashed.
- Only nebula artwork assigned to a visible region is decoded. Packaged web
  copies are pre-scaled while source artwork is preserved.
- The universe renders at 24 fps while idle, up to 30 fps during interaction,
  8 fps when unfocused, and pauses when hidden.
- The two main Canvas backing stores share a strict 4.5-megapixel budget.
- At 1,000 papers, the target is warm-cache search p95 below 500 ms and local
  Context Pack assembly below 2 seconds.

`npm run desktop:package` creates `Liteverse.app` using an ad-hoc local
signature. Developer ID signing, notarization, and an update feed require the
distributor's Apple credentials and remain separate release steps.

The distributable app carries all three Codex Skills and the local CLI without
silently activating either. A Codex user can install or update them explicitly:

```bash
"/Applications/Liteverse.app/Contents/Resources/install-codex-skills.sh"
```

The installer writes the three Skills under `${CODEX_HOME:-~/.codex}/skills`,
places the CLI under `${CODEX_HOME:-~/.codex}/liteverse-cli`, and creates
`${CODEX_HOME:-~/.codex}/bin/liteverse`. It never copies personal papers, graph
data, project memory, Context Packs, or usage ledgers.

## Privacy and current boundaries

- Imported PDFs are copied into Liteverse's managed vault; originals are not
  moved or deleted.
- Runtime graph and artifact paths are relative to the workspace root.
- Backups include immutable knowledge, project memory, task records,
  provenance, and optionally PDF bytes. Restore verifies manifest hashes before
  activation; the rebuildable search cache is excluded.
- Version 0.3.2 has no account, cloud sync, background daemon, automatic online
  literature search, or default cloud embedding. Explicitly processing an arXiv
  upload may use the network to verify the requested source.
- The App does not need to remain open for the Skills or CLI to use the local
  workspace.
- stdio MCP and additional AI-provider adapters are planned, not shipped.

## Contributing and security

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and
keep fixtures, screenshots, logs, and example data free of personal research
material. Report security issues through the private process in
[SECURITY.md](SECURITY.md), not through a public issue.

Release maintainers should follow [RELEASING.md](RELEASING.md), including its
clean-seed, privacy, generated-artifact, and asset-rights checks.

## License

Liteverse is released under the [MIT License](LICENSE). The original artwork
shipped in `public/` is covered by the same license; see
[ASSET_LICENSES.md](ASSET_LICENSES.md).
