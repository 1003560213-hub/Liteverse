# Evidence and append-only merge policy

## Evidence states and provenance

Keep epistemic status separate from origin:

| Origin | Allowed use |
| --- | --- |
| `user` | Preserve a user statement as `user_declared`; do not silently certify it. |
| `aiInference` | Preserve a useful inference as `provisional` only. |
| `paperEvidence` | Require a Retriever receipt with paper, claim, evidence, and artifact SHA-256. |
| `computationArtifact` | Require reproducible metadata, not embedded code or data. |

`supported` and `contradicted` require exact paper evidence or a reproducible computation artifact. A paper receipt has `paperId`, `claimId`, `evidenceId`, `artifactHash`, and optional `artifactRevision` and `locator`. The Skill validates the receipt but never opens the referenced paper artifact.

A region document labelled “knowledge card” is still user-authored project
memory. The label controls presentation only: the App must construct it as
`user/user_declared`, with no paper receipt or computation artifact, and must
not expose a control that upgrades it to `supported`. Scientific restructuring
or verification requires a later append-only Research Memory event following
the ordinary evidence rules.

For a code or experiment record, store only:

- `kind`: `code` or `experiment`
- `path`
- at least one of `gitCommit`, `contentHash`, `configHash`, or `dataHash`
- optional execution `command`
- `resultSummary`

Do not store file contents, patches, repository snapshots, configurations, datasets, logs, or raw simulation output.

## Merge behavior

- Add an independent fact as a new active memory.
- Replace an older active statement by recording the new memory with `supersedes`. The projection marks the old item `superseded` and links both directions; the ledger retains both creation events.
- Express disagreement with `contradicts`. Keep both items and both evidence states visible. Do not automatically declare either side false.
- Retire an item only by appending `memory_retired` with a reason.
- Reject unknown relationship targets, self-links, duplicate IDs, attempts to supersede non-active memory, and stale expected revisions.

When an AI result conflicts with a supported item, preserve the result as provisional and link the contradiction. Do not downgrade the supported item without new paper evidence or a reproducible computation artifact.
