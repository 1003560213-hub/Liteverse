# Liteverse Curator review-batch contract

The review-batch pipeline moves mechanical validation and candidate routing out
of Codex's scientific reasoning loop. It does not turn extracted text into
verified knowledge by itself.

## Build boundary

Run `scripts/build-review-batch.mjs` after the App has committed local
preparation. The builder revalidates all of the following before selecting a
paper:

- the current `library.json` item ID and committed successor revision;
- `preparation.state`, job ID, source revision, manifest path, and exact
  manifest-byte SHA-256;
- the manifest item/job identity, catalog fingerprint, extraction state,
  storage mode, source SHA-256, output size, and output SHA-256;
- the managed or linked original source bytes;
- the review packet's item/source revision and source SHA-256.

It accepts `liteverse-review-packet-v1` and
`liteverse-review-packet-v2`. V2 candidates retain the source-pinned candidate
or anchor ID, original PDF page, page-text SHA-256, section, and UTF-16
character range. V1 candidates receive a deterministic derived routing ID but
do not gain anchors that were absent from the packet.

The output schema is `liteverse-curation-review-batch-v1`. A normal batch has
3–5 papers. `--char-budget` bounds candidate excerpts and adjacent context;
selection is deterministic and round-robin across papers and scientific kinds.
The builder first preserves at least one complete source-pinned candidate per
paper, then rotates through research question, method, result, limitation,
assumption, and equation candidates before spending remaining budget on more
high-ranked entries. It may clip optional neighbouring context, but it never
clips the candidate text covered by the recorded character range. An explicit
`--allow-partial` is required to drain a final one- or two-paper queue. Every
candidate remains:

```json
{"status":"provisional","purpose":"routing_only","verificationState":"unverified"}
```

The batch contains no generated claim, relation score, category decision, or
scientific summary. Its byte hash pins every later decision.

Section, figure, table, and citation anchors are emitted only as a bounded
`navigationAnchors` list. They do not enter the scientific `candidates` array
and require no accept/reject response. Equation candidates remain scientific
review items because their meaning and conventions may affect a claim.

When local preparation produced a BM25 relation screen, the builder validates
and carries its at-most-24 entries as `relationShortlist`, together with the
index fingerprint and Review Packet anchor IDs that formed the query. Each
entry may retain a bounded snippet plus up to two verified, artifact-pinned
matching claims and their locators, so Curator does not repeat the catalog
search. The shortlist is routing-only:
it prevents a redundant full-library search, but its rank is neither relation
strength nor evidence and it may not create a line without both papers' source
locations.

## Decision boundary

`scripts/apply-review-batch.mjs` accepts only
`liteverse-curation-decisions-v1`. The root pins `batchId` and the exact batch
SHA-256. Every paper also pins:

- `itemId`, `itemRevision`, and local-preparation `sourceRevision`;
- `paperId`, the preparation `catalogFingerprint`, `sourceSha256`, and
  `packetSha256`.

There must be exactly one `accept`, `qualify`, or `reject` decision for every
routing candidate. Accepted and qualified candidates require a target card
section and a faithful paraphrase. `qualify` additionally requires an explicit
qualification. Rejections require a reason and do not enter the card or
evidence index. To avoid repeating mechanical rejection text, a paper may set
`defaultUnspecifiedDecision: "reject"` with one non-empty
`defaultRejectionReason`; every omitted candidate is then deterministically
rejected. Without that explicit opt-in, omissions fail closed. Evidence IDs are
assigned deterministically by the script; Codex must not author them.

## Original-page review attestation

The default output remains `card_draft`. A paper may request
`evidence_verified` only with a `liteverse-original-page-review-v1` object that
contains all of the following:

- `attested: true`, `reviewMethod: "original_pdf_page"`, reviewer, and a valid
  review time;
- the exact source and packet SHA-256 pins;
- the declaration `I reviewed the cited original PDF pages against the pinned
  source hash.`;
- exact coverage of all accepted and qualified candidate IDs;
- a positive original PDF page for every covered candidate;
- for Review Packet v2, the exact page-text SHA-256 for each reviewed page.

A missing, partial, malformed, or stale attestation fails closed when
`evidence_verified` is requested. Merely accepting an extraction candidate
never promotes a card.

## Transactions and resume

All mutable output is confined to `Planning/Curator/`:

- `review-batches/<batch-id>/batch.json`
- `review-batches/checkpoint.json`
- `review-results/<batch-id>/`
- `journals/`
- `.transactions/`

The checkpoint retains an active batch until application commits, so rerunning
the builder resumes the exact hash-pinned batch. Application uses a transaction
directory and journal, then atomically renames the complete result and advances
the checkpoint. Reapplying byte-identical decisions is idempotent; conflicting
decisions fail closed. Review-batch and adoption locks publish PID/token owner
records; a dead owner older than 60 seconds is atomically quarantined before
recovery, while ownerless legacy locks are never guessed stale.

Neither script may write `Graph/current.json`, `Graph/staged/`,
`Graph/history/`, `Graph/pending-update.json`, `Usage/`, project memory, queues,
or canonical `Knowledge/` artifacts. The generated card and evidence index are
review results for the later Curator finalization transaction, not published
truth.

## Deterministic adoption bridge

After applying every ready review batch for the current extraction wave, run
`scripts/adopt-review-results.mjs` with one `--result` argument per committed
result manifest. The command accepts one result for a small queue or many
results in one transaction for a large queue. It revalidates:

- every result, batch, source, packet, item ID, item revision, and preparation
  source revision;
- every result-card and evidence-index byte hash;
- the current schema-v3 Graph revision and exact byte hash;
- the live managed or linked PDF and the page-marked full-text output;
- strict SHA-256, arXiv ID, and DOI duplicate keys across the live catalog and
  the entire adoption set. An exact title-plus-authors match remains a possible
  duplicate for review and is never an automatic merge key;
- optional `liteverse-curation-adoption-decisions-v1` existing-region
  assignments, including their aggregate batch/result pins and reviewed
  evidence IDs.

The App preparation manifest pins the catalog seen at extraction time. Do not
adopt the first 3–5-paper result while other papers from that same preparation
wave still need Review Batch construction. Build and apply all batches first,
then pass all result manifests to one adoption command. This keeps the catalog
fingerprint stable throughout review and lets a 10+ paper queue reuse its
original extraction. This is enforced fail-closed: any other `pending_codex` or
`processing` item with `preparation.state: ready` and the same catalog
fingerprint must be represented by the supplied result set. Items with a
different fingerprint, `preparation.state: needs_attention`, an auto-resolved
duplicate, or an already organized status do not block the wave. Adoption
performs a fresh strict duplicate screen before the single catalog write; it
never reruns PDF extraction.

Without an assignments file, adoption adds the papers to the sole
`liteverse-staging` system region with `classificationStatus: "provisional"`.
It does not infer a scientific category. An explicit assignment may use an
existing macro region. A `classified` assignment requires an
`evidence_verified` review result and at least one reviewed Evidence ID;
otherwise it fails closed. New macro regions still require the independent
taxonomy decision contract.

Use `--write-assignment-template` to write the exact aggregate batch/result,
base-Graph, item/source revision, paper, source, packet, and available Evidence
ID pins under `Planning/Curator/adoption-templates/`, then stop without adopting
anything. Edit only the category, classification status, rationale, selected
Evidence IDs, and tags, and pass the resulting file back with `--assignments`.
This avoids hand-calculating aggregate hashes while preserving a fail-closed
scientific decision boundary.

The adoption transaction validates the complete set before installing any
canonical working bytes. Cards, full texts, and managed PDFs are additive and
installed only when the target is absent or byte-identical. A conflicting file
fails closed. `Knowledge/papers.json` is written once, after all additive files
are durable. A planned/committed journal plus byte-identical replay makes an
interrupted adoption resumable. Linked PDFs remain external and are never
copied.

Adoption emits these draft-only outputs:

- `Planning/Curator/adoptions/<adoption-id>/base-snapshot.json`
- `Planning/Curator/adoptions/<adoption-id>/working-snapshot.json`
- `Planning/Curator/adoptions/<adoption-id>/library-items.json`
- `Planning/Curator/adoptions/<adoption-id>/manifest.json`

The adoption manifest explicitly records
`immutableArtifactsPublished: false`. Canonical cards/full texts and
`Knowledge/papers.json` remain a working projection until the complete working
snapshot passes `finalize-curated-snapshot.py` and the new paper IDs pass
`generate-claims.mjs --snapshot`. Only then may reviewed relation outputs be
merged and `stage-refresh.mjs` be invoked with the emitted library-items file.
Adoption itself never writes current, staged, pending, history, Usage, or
project Memory.
