# Research memory contract

## Storage layout

```text
Projects/
  projects.json
  <project-id>/
    project.json
    memory/
      events.jsonl
      current.json
    tasks.json
    Tasks/
      <task-hash>/
        task.json
        context-packs/        # owned by Retriever/CLI
        handoffs/             # owned by Research Memory
```

`memory/events.jsonl` is the only project-memory truth. Every line is an immutable event with a project-local, gap-free `revision`. `project.json`, `memory/current.json`, `tasks.json`, per-task JSON, and `projects.json` are atomic projections. Every project projection carries the same `revision` and `ledgerHash`; consumers must reject mismatches.

All mutations use `.locks/research-memory.lock`, reject a mismatched `--expected-revision`, append and `fsync` the ledger, then atomically replace projections. A malformed JSONL line fails closed. Never interpret a corrupt or missing projection as an empty project.

The App's existing Research Information editor is a first-class user input path. A save appends one `memory_recorded` event with `type: project_context`, `provenance: user`, and `evidenceState: user_declared`; it may supersede the previous active App/legacy Research Information item but never rewrites that event. The App must hold the same lock, reject a stale editor revision or ledger/projection mismatch, preserve the complete text in revision history, `fsync` the ledger, and update every project projection to the resulting revision and ledger hash. A UI success message is forbidden unless this closure succeeds.

## Project and task identity

- Use lowercase slug project IDs.
- Resolve a project from `--project`, `LITEVERSE_PROJECT_ID`, or `projects.json.activeProjectId`, in that order.
- Resolve raw task identity from the controlled `--task-id` override, then `LITEVERSE_TASK_ID`, then `CODEX_THREAD_ID`.
- Persist only `SHA-256(raw task ID)` as `taskHash`. Never put the raw ID in events, projections, handoffs, logs, or filenames.

## Memory projection

`memory/current.json` has:

```json
{
  "schemaVersion": 1,
  "projectId": "project-default",
  "revision": 12,
  "ledgerHash": "<sha256>",
  "generatedAt": "<event timestamp>",
  "items": []
}
```

Each item has stable `memoryId`, `type`, `title`, `content`, `state`, `evidenceState`, `provenance`, timestamps and revisions, plus `supersedes`, `supersededBy`, `contradicts`, and `contradictedBy`. Optional fields are `paperEvidence`, `computationArtifact`, `taskHash`, and migration `source`.

Supported types are `project_context`, `goal`, `convention`, `decision`, `assumption`, `finding`, `open_question`, `exclusion`, `next_step`, `code`, and `experiment`.

### Region notes and user knowledge cards

The App stores a nebula-region note or user knowledge card as an ordinary
`memory_recorded` event with `type: project_context`, `provenance: user`, and
`evidenceState: user_declared`. It is a project-memory document, not a paper
knowledge artifact and not scientific verification. Such a memory carries all
three metadata objects below:

- `scope`: `kind: nebula_region`, the exact `categoryId`, a display-name
  snapshot, and the non-negative Graph revision at assignment time.
- `presentation`: stable `documentId`, `kind: note | knowledge_card`, and
  `format: markdown | plain_text`.
- `source`: `kind: app_region_document`, `input: manual | file_import`, UTF-8
  byte length, SHA-256 of the exact stored UTF-8 content, and only for imports a
  basename ending in `.md` or `.txt`.

The App validates the category against the pinned current Graph revision before
writing. A later repartition never fuzzy-remaps a missing category ID; the UI
must show the document as orphaned until the user explicitly reassigns it.
Editing appends a new memory with the same `documentId` and `supersedes` the
single active version. Removing a document appends `memory_retired`. Imported
absolute paths are never persisted, and the App must reject symbolic links,
non-UTF-8 or NUL-containing files, extensions other than `.md`/`.txt`, and files
larger than 1 MiB.

## Task and handoff projection

`tasks.json` and each `Tasks/<taskHash>/task.json` contain only the hash, status, summaries, timestamps, linked memory IDs, and metadata-only outputs. Context Packs remain owned by Retriever. Research Memory writes handoffs only under `Tasks/<taskHash>/handoffs/` and records both artifact paths and hashes in the ledger.

A handoff contains the project and task summaries, active memory, explicit conflicts, open questions, and next steps as matching JSON and Markdown. It never expands paper evidence into paper content.
