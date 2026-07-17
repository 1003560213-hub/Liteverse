# Liteverse project instructions

At the start of every Codex session opened on this project, run:

```bash
node scripts/codex-note-queue.mjs list
node scripts/codex-workspace-queue.mjs list
```

Process pending work in this order: any legacy pending research revision,
manual annotations, then uploaded PDF/arXiv literature. Never launch the App
merely to inspect a queue or use the knowledge base.

## Liteverse task routing

Treat natural-language requests such as “use the Liteverse library for this
research, writing, or code task” as an explicit instruction to use Liteverse.
Use the shared local CLI when possible:

```bash
node scripts/liteverse-cli.mjs status
node scripts/liteverse-cli.mjs search --query "..."
node scripts/liteverse-cli.mjs context build --project <project-id> --query "..."
```

For a reusable task, resolve the selected project, begin the task, retrieve only
the evidence actually needed, record durable results, and complete the task with
a handoff when useful. Generic AI integrations must provide
`LITEVERSE_TASK_ID`; Codex falls back to `CODEX_THREAD_ID`. Persist only the
SHA-256 task hash. The raw task identifier must never appear in a ledger,
projection, Context Pack, handoff, filename, or log.

The repository maintains exactly three Skills under `skills/`; active copies
live under `~/.codex/skills/`:

- Use `$liteverse-curator` for queued PDF/arXiv ingestion, page-marked full-text
  and knowledge-card generation, stable claims, deduplication, broad
  classification, three-option taxonomy proposals, explicit partition-decision
  recording, evidence-backed relationship scoring, annotation integration, and
  staged App Refresh publication. Curator never writes Usage or project memory.
- Use `$liteverse-retriever` whenever a task searches, reads, summarizes,
  compares, cites, verifies, or applies Liteverse literature, including research,
  writing, and code design. It owns Context Packs and adopted-evidence receipts.
- Use `$liteverse-research-memory` for project goals, conventions, assumptions,
  decisions, findings, open questions, exclusions, next steps, code/experiment
  metadata, task outcomes, conflicts, and handoffs. It must obtain paper evidence
  through Retriever and never modify `Knowledge/`, `Graph/`, `Usage/`, or PDFs.

The macOS App may run the bundled, short-lived `LiteverseLocalWorker` for
deterministic preparation. A valid `library.json` item with
`preparation.state: "ready"` already has hash-pinned page extraction and a card
skeleton; Curator verifies and reuses those bytes instead of repeating the
materializer. Local preparation, review packets, and candidate scores are never
scientific evidence and never promote a card, relationship, classification, or
Usage count.

Do not split these responsibilities into per-feature Skills. The CLI is the
provider-neutral interface; Codex is the first adapter. Liteverse has no
background daemon, bundled Node/Python runtime, local model, automatic online
literature search, cloud sync, or shipped stdio MCP adapter.

## Macro-region decisions

Liteverse has no privileged four-region taxonomy. On an empty library that is
ready for its first classification, or whenever the user explicitly requests a
repartition, Curator must search the complete verified catalog and produce
exactly three materially different, fully assigned macro-region options. Explain
the organizing principle, region counts, strengths, limitations, and ambiguous
papers for each option, then ask the user to choose. Do not recommend, preselect,
apply, or stage an option while the proposal is awaiting a decision.

The App may display and copy the three options, but it cannot select or apply
one. Only an explicit natural-language user choice handled by Codex may create
the append-only decision record. An explicit instruction such as “choose your
recommended option for me” is a valid delegated choice; record both the selected
option and the recommendation rationale rather than treating it as a default.
Lock the decision to the proposal-set ID, option ID, base graph revision, and
artifact fingerprint; stale or incomplete proposals fail closed. Applying a
valid decision may replace old macro regions, but it must never delete papers or
relations. `Graph/current.json` remains unchanged until the resulting staged
snapshot passes the ordinary Refresh.

Every option must cover every paper exactly once as a primary assignment, use
between one and ten macro regions, give each paper at most one secondary region,
and obey the stable-cluster rule below. A lone paper cannot create a nebula.

## Immutable literature and Context Packs

Shared PDFs and literature knowledge are stored once across all projects.
`Knowledge/artifacts/<paper-id>/revisions/<revision>/` holds immutable card,
full-text, and claim revisions. `Knowledge/artifacts/<paper-id>/current.json`,
`Knowledge/papers.json`, Graph, Library, and the FTS index are validated,
rebuildable projections—not the source of truth.

Before adopting evidence, Retriever must verify the artifact revision and all
pinned SHA-256 hashes. Missing pins, changed cards, claim conflicts, malformed
JSON/JSONL, or projection revision mismatches fail closed. Do not work around a
failure by reading the mutable card with `cat`, `rg`, an ordinary file tool, or a
custom script. Run:

```bash
node scripts/liteverse-cli.mjs doctor
```

A Context Pack must pin the project, hashed task ID, Graph and Memory revisions,
artifact revisions/hashes, adopted claims and evidence locators, selection
reasons, project conventions, limitations, counter-evidence, conflicts, and
unresolved questions. Generate the smallest useful pack; do not load whole
full-text files by default. Legacy provisional card sections must never enter a
formal Context Pack.

`Cache/` contains only the rebuildable local FTS5/BM25 index. It is excluded
from backup and may be regenerated with:

```bash
node scripts/liteverse-cli.mjs index rebuild
```

## Paper usage policy

Paper activity is a non-negative integer `useCount`. Only Retriever or its CLI
paths may append `Usage/events.jsonl` and rebuild `Usage/counts.json`.

- `search`, `status`, and candidate preview never count.
- `context build` and `evidence read` count only after requested artifacts pass
  integrity verification and the paper is genuinely adopted.
- The unique v2 key is hashed task ID + project ID + paper ID. Repeated use in
  one task/project counts once; different tasks or projects count separately.
- `Usage/counts.json` exposes both project-level and global counts for the shared
  paper and is always rebuildable from the append-only ledger.
- Manual notes, App clicks, Curator processing, validation, and ordinary PDF or
  Markdown opening never count.

Do not edit Usage files manually. The App must never expose a manual usage
control. Project heat is the default; global heat is an optional view. The App
maps activity with `min(1, log1p(useCount) / log1p(32))` and averages normalized
primary-paper activity for each region.

## Multi-project research memory

`Projects/<project-id>/memory/events.jsonl` is the append-only truth for project
memory. `project.json`, `memory/current.json`, `tasks.json`, per-task JSON, and
`Projects/projects.json` are atomic projections that must share the same project
revision and ledger hash. A corrupt ledger or stale projection is an error, not
an empty project.

Each memory item has a stable ID and independent lifecycle and evidence states:

- `state`: `active | superseded | retired`
- `evidenceState`: `user_declared | provisional | supported | contradicted`
- `provenance`: `user | paperEvidence | computationArtifact | aiInference`

User statements remain `user_declared`; AI inference remains `provisional`.
Only an exact Retriever receipt or reproducible computation artifact can support
a result. Updates append a new item or explicit `supersedes` / `contradicts`
relationship; never silently rewrite history. Keep contradictory items visible.

Code and experiments store metadata only: repository path, Git commit or content
hash, config/data hashes, command, test result, and concise outcome. Never copy a
repository, source tree, configuration corpus, or simulation dataset into
project memory. Search only the active project unless the user explicitly asks
for cross-project results.

Research Information from older builds is legacy input. Preserve its complete
text when migrating it into a project before structuring it into goals,
decisions, conventions, findings, open questions, exclusions, and next steps.
Never replace a newer project ledger with the legacy file.

## Literature upload queue

When the workspace queue returns pending PDF or arXiv entries:

1. Inspect each entry separately. For PDFs, read the saved copy under
   `~/Library/Application Support/Liteverse/Library/PDFs/`; for arXiv entries,
   verify title, authors, identifier, version, and content against the original
   arXiv paper page before use. Network access is explicit for this requested
   source only; do not run automatic related-literature discovery.
2. Use `$liteverse-curator`; preserve the canonical source, create both a
   page-marked full-text file and structured knowledge card, generate stable
   claims, and publish an immutable artifact revision.
3. Search related library papers only after identifying the source. Add a stellar
   relation only when both original papers have evidence locations. `no-link` is
   valid; never invent a connection to make the graph denser. Preserve old
   `confidence` only as `legacyConfidence`, never as new scientific strength.
4. When creating a category, leave `nebulaAssetId` and
   `nebulaAssignmentOrder` unset, then run `npm run nebula:assign`. This consumes
   unused assets before reuse and never rerolls an existing region for appearance.
5. Keep at most ten macro regions. A new region requires at least four papers,
   all existing-region matches below 60, and cluster consistency at least 70. A
   lone paper stays provisional in its nearest macro region.
6. Stage a complete snapshot under `Graph/staged/` and atomically publish
   `Graph/pending-update.json`; never edit `Graph/current.json` directly. Only
   then move the exact queue item revision to `ready_to_refresh`.
7. For duplicate or no-link items that do not change the graph, mark that exact
   library item and revision:

```bash
node scripts/codex-workspace-queue.mjs mark-literature <item-id> \
  --revision <n> --disposition <duplicate|no-link> \
  [--title "Verified title"] [--arxiv-url "https://arxiv.org/abs/..."]
```

Use `needs-attention` when the source cannot be identified or a scientific
ambiguity requires user input. Never use a bulk `mark all` operation. Added or
merged papers become `organized` only after the App validates and commits the
Refresh.

`~/Library/Application Support/Liteverse/workspace-inbox.jsonl` is an
append-only audit trail. Never delete or rewrite it. Liteverse does not launch
Codex in the background; the queue remains discoverable next time Codex starts.

## Legacy research queue

The workspace queue still recognizes `pending_setup` and `pending_update`
records from older Liteverse builds. Only for such a record:

1. Treat the draft as user-declared project context, not verified science.
2. Reconcile it with current project state while preserving uncertainty,
   conventions, exclusions, and the exact original text.
3. Write the organized version to an Application Support planning file, such as
   `~/Library/Application Support/Liteverse/Planning/research-memory/revision-<n>.md`.
   Never place a user's research memory in this source repository.
4. Publish only the exact draft revision reviewed:

```bash
node scripts/codex-workspace-queue.mjs publish-research \
  --revision <n> \
  --from "$HOME/Library/Application Support/Liteverse/Planning/research-memory/revision-<n>.md"
```

If the revision changed, stop and re-read the newest draft. After publication,
migrate the preserved text through `$liteverse-research-memory`; never overwrite
the current project ledger with an older draft.

## Annotation queue

If pending Liteverse annotations are returned, process them before literature:

1. Read the raw note returned by the queue command, stored under
   `~/Library/Application Support/Liteverse/user-annotations.json`, and its paper
   entry.
2. Treat manual notes as user observations, questions, or provisional
   interpretations—not verified paper findings.
3. Consult the pinned knowledge card, page-marked full text, and original PDF
   whenever a note changes a formula, convention, claim, or paper relationship.
4. Integrate useful content into the card/full-text pair and immutable artifact;
   when justified, stage relation or tag changes in the same Refresh. Preserve
   uncertainty, source, annotation ID, and revision.
5. Never delete or rewrite
   `~/Library/Application Support/Liteverse/codex-inbox.jsonl`; it is the
   append-only annotation audit trail.
6. Only after all file and graph changes land successfully, mark the exact
   annotation ID and revision through Curator:

```bash
node skills/liteverse-curator/scripts/mark-annotation.mjs \
  --id <annotation-id> --revision <n> --refresh-id <refresh-id> \
  --derived-file <application-support-relative-path>
```

Do not mark a note organized merely because it was read. The legacy direct mark
path is intentionally rejected because it cannot prove the derived artifact or
Refresh provenance.
