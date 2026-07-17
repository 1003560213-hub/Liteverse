# Liteverse queue contract

## Paths

All mutable paths are relative to the Liteverse support directory:

- `library.json`: uploaded literature queue and catalog.
- `user-annotations.json`: complete current annotation array.
- `codex-inbox.jsonl`: append-only annotation creation, edit, and Curator audit events.
- `Library/PDFs/<storedFilename>`: PDF bytes saved by the App before curation.
- `user-notes/<paper-id>.md`: readable mirror of raw annotations; never the authoritative source.

Do not confuse `codex-inbox.jsonl` with `workspace-inbox.jsonl`, which carries separate literature/research-memory events in older App workflows.

## library.json

The root is an object:

```json
{"schemaVersion":1,"nextNumber":2,"items":[]}
```

Each item includes:

- `id`: immutable UUID-like string.
- `number`: positive catalog number used for `LIT-0001` display.
- `sourceType`: `pdf` or `arxiv`.
- `storedFilename` for PDF, or canonical `arxivUrl` for arXiv.
- `displayTitle` and `titleStatus`.
- `status`: `pending_codex`, `processing`, `needs_attention`, `ready_to_refresh`, or `organized`.
- `revision`: positive optimistic-lock integer.
- timestamps such as `createdAt` and `updatedAt`.
- optional processing and graph fields: `processingToken`, `attentionReason`, `graphPaperId`, `refreshId`, and `disposition`.
- optional deterministic-preparation field `preparation`, as defined by `local-preparation-contract.md`. Unknown or stale preparation output never changes the queue state by itself.

Always lock by item ID plus revision. `stage-refresh.mjs` accepts only `pending_codex` or `processing`, increments the revision, and writes the updated revision into the staged manifest.

An App preparation commit also uses item ID plus revision. It may install hash-verified draft artifacts, increment the revision, and set `preparation.state: "ready"`, but it leaves `status: "pending_codex"`. Curator must lock the resulting new revision. A failed or unreadable result sets `preparation.state: "needs_attention"` and the existing queue `status: "needs_attention"`; it must retain the source and diagnostic rather than delete the item.

The sole exception is explicit `--replace-pending` recovery. It must receive the complete library-item set from the old pending manifest and verifies the live items are still `ready_to_refresh`, at the recorded revisions, mapped to the same papers, and owned by the old refresh. It transfers them to the replacement refresh without incrementing their revisions; missing, added, changed, stale, or orphaned items abort recovery.

## user-annotations.json

The root is an array. Every annotation contains:

```json
{
  "id": "paper-id-20260713120000-0",
  "paperId": "paper-id",
  "paperTitle": "Exact paper title",
  "text": "Raw user observation or question",
  "createdAt": "ISO-8601 timestamp",
  "updatedAt": "ISO-8601 timestamp",
  "status": "pending",
  "revision": 1
}
```

An organized annotation additionally has `status: "organized"`, an incremented revision, and `organizedAt`. Editing in the App returns it to `pending` at the next revision. Never overwrite or delete the raw text.

Use `list-queue.mjs --json` to lock the pending revision. Add the annotation provenance marker to every file derived from it. After the staged snapshot and pending pointer are durable, call `mark-annotation.mjs` for exactly that one ID and revision.

## codex-inbox.jsonl

Each line is an immutable JSON object with `eventId`, `action`, `timestamp`, and action payload. The App writes `annotation_created` or `annotation_updated` events containing the annotation. Curator appends `annotation_organized_by_codex` with:

- `annotationId`
- `sourceRevision`
- `organizedRevision`
- `refreshId`
- declared derived file paths

Append one complete UTF-8 JSON line and sync it. Never rewrite, compact, or bulk-mark this ledger.

## Revision discipline

1. List queues and retain ID/revision pairs.
2. Re-read and compare before every state transition.
3. Refuse stale revisions; never merge silently.
4. Produce Markdown and staged graph before marking an annotation organized.
5. Mark one annotation at a time so each audit event maps to one source observation.
