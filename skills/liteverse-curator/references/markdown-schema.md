# Liteverse Markdown schema

## Storage

Within the support directory, use:

- `Knowledge/fulltext/<paper-id>.md`
- `Knowledge/cards/<paper-id>.md`
- `Knowledge/papers.json` for deterministic deduplication and paths
- `Knowledge/claims/<paper-id>.json` for the rebuildable stable-claim projection
- `Knowledge/artifacts/<paper-id>/revisions/<revision>/` for immutable card, full-text, claim, and manifest bytes
- `Library/PDFs/<paper-id>.pdf` for the preserved canonical PDF

Paper IDs contain only lowercase ASCII letters, digits, and hyphens.

After completing the card, run `generate-claims.mjs`. The artifact manifest pins the source PDF, card, full text, and claim sidecar by SHA-256. `Knowledge/papers.json` stores the active revision/hash pointer. A claim ID is derived deterministically from paper, claim type, normalized statement, and evidence IDs; editing a scientific statement creates a new claim identity and artifact revision.

## Full-text Markdown

Begin with YAML frontmatter containing at least:

```yaml
paper_id: example-2026
title: "Exact paper title"
authors: ["First Author", "Second Author"]
source_type: pdf
source_sha256: "..."
arxiv_id: null
doi: null
extraction_status: extracted
verification_status: card_draft
metadata_status: provisional
library_item_id: null
library_item_revision: null
annotation_revisions: []
```

`verification_status` is one of `imported`, `extracted`, `needs_ocr`, `card_draft`, `evidence_verified`, `needs_attention`, or `source_missing`. PDF extraction alone never produces `evidence_verified`.

Use `metadata_status: provisional` for abbreviated or inherited author metadata such as “et al.”. Only official arXiv metadata or an original-source metadata check may promote it to `official_verified` or `source_verified`.

Preserve page boundaries exactly as HTML comments:

```markdown
<!-- page: 1 -->

Extracted text from page one.
```

Do not silently join or renumber pages. Set `extraction_status: needs_ocr` and avoid scientific synthesis when no meaningful text is available.

## Knowledge card Markdown

Frontmatter contains identifiers, exact metadata, source hash, paths, primary/secondary categories, tags, classification status, and provenance revisions. Use these body headings:

1. `## Research question`
2. `## Methods`
3. `## Equations and conventions`
4. `## Main results`
5. `## Limitations`
6. `## Project role`
7. `## Evidence index`
8. `## Annotation provenance`

For `evidence_verified` and `needs_attention` cards, every bullet in the first six scientific sections must cite at least one existing evidence ID such as `[E1]`. Every evidence-index entry must use the exact three-part form `E# — original-source locator — faithful paraphrase`. The locator must contain an explicit page, section, equation, figure, or table value (for example `PDF p. 4`, `pp. 4–5`, `Sec. II`, `Eq. (7)`, `Fig. 2`, or `Table I`); vague source names and placeholders are invalid. The corresponding full-text artifact must retain at least one positive-integer `<!-- page: N -->` marker. Other card states may keep unresolved fields as explicit `TODO` entries; never infer content from a title or abstract alone.

Annotation provenance retains annotation ID, annotation revision, disposition, checked source locator, and integration time. Original notes remain in their append-only store. Every file derived from an annotation includes a machine-readable marker:

```markdown
<!-- liteverse-annotation-provenance: {"annotationId":"paper-note-1","sourceRevision":2} -->
```

`mark-annotation.mjs` requires the exact annotation ID and source revision in each declared derived file before it will organize the annotation.
