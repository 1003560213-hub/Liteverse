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

## Task and handoff projection

`tasks.json` and each `Tasks/<taskHash>/task.json` contain only the hash, status, summaries, timestamps, linked memory IDs, and metadata-only outputs. Context Packs remain owned by Retriever. Research Memory writes handoffs only under `Tasks/<taskHash>/handoffs/` and records both artifact paths and hashes in the ledger.

A handoff contains the project and task summaries, active memory, explicit conflicts, open questions, and next steps as matching JSON and Markdown. It never expands paper evidence into paper content.

