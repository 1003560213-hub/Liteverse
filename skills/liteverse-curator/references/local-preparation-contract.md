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
    "storageMode": "managed",
    "pdfPath": "/absolute/path/to/managed.pdf"
  }
}
```

For a PDF discovered in a user-selected folder, keep `kind: "pdf"`, set `storageMode: "linked"`, and pass the normalized absolute `pdfPath`, `linkedRootPath`, and safe `relativePath`. Require both real paths to equal their recorded paths, reject a symlink root, PDF, intermediate component, or ancestor alias, and require the PDF to stay within the selected root. The worker reads that file in place and must not copy it into the job directory or managed vault. A Zotero-discovered stored attachment uses the same linked contract and may additionally retain `source.provenance: {"catalog":"zotero","itemKey":"...","attachmentKey":"..."}` plus bounded `source.catalogMetadata` title, author, and DOI hints in Library and later graph provenance. The App queries these fields read-only and forwards them to the Worker so identity cleanup and strict DOI screening do not need another Codex pass. They remain provisional catalog metadata: they are not paper evidence, do not create claims or relationships, and cannot promote verification. If the richer Zotero schema query is unavailable, attachment discovery safely falls back to title-only metadata. Liteverse never writes Zotero. For arXiv, `kind` is `arxiv`, storage is managed, and `arxivId` is a canonical identifier supplied by the user. Network access is limited to official metadata and PDF endpoints for that identifier. The worker never discovers or downloads related literature.

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

The `pdf` output is required for managed PDF/arXiv jobs and forbidden for linked jobs. A linked result instead preserves the request's source reference and `sourceSha256`; only `fulltext`, `card`, and `review_packet` are installed. The native commit gate re-hashes the external file after Worker exit so a file changed during preparation cannot be accepted.

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

Curator must reject preparation when the item revision, source revision, catalog fingerprint, manifest hash, storage mode, source path/root/relative path, source hash, or any output hash differs. A malformed or incomplete job is not an empty result and must fail closed. For linked sources, Curator reads the original at the recorded absolute path and never looks for an installed `source.pdf`.

## Candidate data

`liteverse-review-packet-v2` scans the complete extracted document before applying deterministic per-kind caps. It records source-pinned candidate/anchor IDs, positive PDF pages, section, UTF-16 character range, page-text hash, previous/current/next context, extraction quality, and provisional research-question, method, result, limitation, assumption, equation, figure, table, section, and citation routing entries. It retains the v1 projection fields during migration. Every entry remains `provisional`, `routing_only`, and `unverified`; use `review-batch-contract.md` before converting any accepted entry into a card claim.

Review packets, BM25/TF-IDF scores, citation matches, partition skeletons, and relation candidates are rebuildable caches. They may narrow the pages and pairs Codex inspects, but they are not original-source evidence, relation strength, confidence, or verified classification. They never enter a formal Context Pack until Curator creates and pins verified claims.
