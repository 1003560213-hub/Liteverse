# Liteverse local preparation contract

The macOS App may prepare an uploaded PDF or an explicitly submitted arXiv source before Curator runs. Preparation is deterministic routing work, not scientific curation.

## Trust boundary

- `LiteverseLocalWorker` is an on-demand helper, never a daemon.
- It may read the selected source and write only `Work/LocalPipeline/<job-id>/` while running.
- It must never write `Graph/current.json`, Graph history, Usage, project memory, partition decisions, formal relationships, or evidence-verified claims.
- The native App validates and atomically installs a completed result. Curator validates that installed result again before using it.
- A local card remains `card_draft` or `needs_ocr`. Extraction alone never produces `evidence_verified`.

## Job request

The helper accepts one UTF-8 JSON object on standard input:

```json
{
  "schemaVersion": "liteverse-local-job-v1",
  "operation": "materialize",
  "jobId": "uuid",
  "itemId": "library-item-id",
  "itemRevision": 1,
  "catalogFingerprint": "sha256",
  "supportDir": "/absolute/Application Support/Liteverse",
  "source": {
    "kind": "pdf",
    "pdfPath": "/absolute/path/to/managed.pdf"
  }
}
```

For arXiv, `kind` is `arxiv` and `arxivId` is a canonical identifier supplied by the user. Network access is limited to official metadata and PDF endpoints for that identifier. The worker never discovers or downloads related literature.

## Result manifest

The helper prints one JSON result and writes the same bytes atomically to the job directory:

```json
{
  "schemaVersion": "liteverse-local-result-v1",
  "jobId": "uuid",
  "itemId": "library-item-id",
  "itemRevision": 1,
  "catalogFingerprint": "sha256",
  "state": "ready",
  "sourceSha256": "sha256",
  "canonicalMetadata": {},
  "duplicateOf": null,
  "extractionStatus": "extracted",
  "outputs": [
    {"role": "pdf", "path": "source.pdf", "sha256": "sha256", "size": 1},
    {"role": "fulltext", "path": "fulltext.md", "sha256": "sha256", "size": 1},
    {"role": "card", "path": "card.md", "sha256": "sha256", "size": 1},
    {"role": "review_packet", "path": "review-packet.json", "sha256": "sha256", "size": 1}
  ],
  "screeningCandidates": []
}
```

`state` is `ready`, `duplicate`, or `needs_attention`. `extractionStatus` is `extracted` or `needs_ocr`. Output paths are relative to the job directory and may not escape it. Every installed byte must match its declared size and SHA-256.

## Library projection

The App may add this optional field without changing the existing queue status machine:

```json
{
  "preparation": {
    "schemaVersion": 1,
    "state": "queued",
    "jobId": "uuid",
    "sourceRevision": 1,
    "resultSha256": null,
    "manifestPath": null
  }
}
```

`state` is `queued`, `ready`, or `needs_attention`. A successful preparation increments the queue item revision and records the installed manifest hash. The existing `status` remains `pending_codex` until Curator stages a complete reviewed graph.

Curator must reject preparation when the item revision, source revision, catalog fingerprint, manifest hash, source hash, or any output hash differs. A malformed or incomplete job is not an empty result and must fail closed.

## Candidate data

The deterministic `review-packet.json` may contain capped, page-numbered section headings, equation-like lines, and method/result/limitation sentence candidates. Every candidate remains `provisional` and `routing_only`.

Review packets, BM25/TF-IDF scores, citation matches, partition skeletons, and relation candidates are rebuildable caches. They may narrow the pages and pairs Codex inspects, but they are not original-source evidence, relation strength, confidence, or verified classification. They never enter a formal Context Pack until Curator creates and pins verified claims.
