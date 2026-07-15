# Liteverse macro taxonomy

## Assignment contract

- Do not install, preserve, or prefer a fixed default taxonomy. Existing regions are historical state, not an automatic recommendation.
- Search the complete available corpus and prepare exactly three materially distinct partition options before assigning regions.
- Ask the user to choose one option. Do not classify or stage from a proposal alone.
- Keep each option between one and ten macro regions.
- Give every paper exactly one `primaryCategory` and at most one `secondaryCategory`.
- Record methods, targets, regimes, observables, codes, and model variants as tags rather than regions.
- When a paper fits imperfectly, place it in the nearest macro region and set `classificationStatus: "provisional"`.

## Three-option proposal

Each option records a different scientific organizing principle, its rationale, and its tradeoffs. It must cover the identical locked paper corpus. Every assignment records evidence or claim IDs and a concise rationale. Labels alone do not make options different: the proposal validator compares label-independent primary co-membership and requires at least 15% of paper pairs to change together/apart status between every pair of options.

For a large corpus, `compose-partition-options.mjs` accepts three compact region plans and expands them from hash-pinned claims sidecars. It prefers each paper's first `evidence_verified` claim ID for classification provenance. If none exists, it accepts a `needs_attention` claim only when the paper is also `needs_attention` and that claim retains non-empty evidence or evidence IDs; the assignment is then explicitly `provisional`, and metadata lists the affected paper. Every other unverified state fails closed. Its old-taxonomy comparison is an explicitly declared routing heuristic—prior primary 82, prior secondary 66, other 18—not a scientific similarity measurement. Review the expanded file before proposing it.

Run `propose-partitions.mjs` only after the source snapshot has immutable artifact pins. The proposal locks:

- current `baseRevision`;
- the current graph's paper-artifact fingerprint;
- the proposed corpus's paper-artifact fingerprint;
- the SHA-256 of the exact source snapshot.

The proposal is read-only planning state. Its immutable truth lives under `Planning/partition-proposals/`; `Graph/partition-proposals.json` is only a rebuildable App projection with schema `liteverse-partition-proposals-v1` and status `awaiting_user`. Present all three options neutrally, including strengths and limitations. Silence, timeout, previous taxonomy, and unrequested Codex preference are not a selection. An explicit instruction such as “recommend and choose for me” or “use your recommended option without asking again” delegates the choice to Codex and is valid selection authority: compare all three options, choose the recommended one, keep `--confirmed-by-user`, and record `delegated choice` plus the recommendation basis in `confirmationNote`.

When applying a choice, persist each macro region's nebula identity. Reused category IDs retain their valid asset and assignment order. New categories use assets unused by the current graph first; after exhaustion, reuse an enabled asset with the least current/assigned usage and resolve ties deterministically from the assignment seed, category ID, and asset ID. New assignment orders continue from the current graph's maximum. Never rely on the App's temporary in-memory fallback.

Persist the spatial layout at the same time. An unchanged reused region may retain its finite center. Generate all other macro centers deterministically from option order and the assignment seed on a bounded ellipsoidal/Fibonacci distribution sized for the existing universe view. Regenerate every paper position from stable paper-ID ordering and a golden-angle three-dimensional cloud around its primary center. Positions must be unique, finite, reproducible, and remain within the region cloud radius; never leave positions tied to the previous taxonomy.

After an explicit choice, `apply-partition-choice.mjs` revalidates all three options and locks, selects exactly one option, appends the user decision, and emits an ordinary unstaged snapshot. Any revision, snapshot, or artifact drift invalidates the proposal and requires three fresh options.

## Empty workspace bootstrap

- A new public workspace has no macro regions until the first three-option decision is completed.
- Use the fixed `liteverse-staging` category with `kind: "system"` for isolated or insufficiently clustered papers. It does not count toward the ten-region limit and does not receive a normal region nebula.
- Every paper in `liteverse-staging` must have `classificationStatus: "provisional"`.
- Create the first macro regions only when at least four papers satisfy the same evidence requirements used for later regions. With no existing macro region, each member's `existingRegionMatchScores` is an empty object. Move papers out of staging through a staged Refresh; never turn a single upload into a permanent region.

## Creating macro regions

For an automatic incremental region on an already selected taxonomy, create it only when all conditions hold:

1. At least four papers form a persistent theme.
2. Every member's best match to all existing regions is below 60/100.
3. The cluster's internally documented consistency is at least 70/100.
4. The theme is scientifically broader than a method, code, object, author group, or parameter choice.
5. The snapshot category records `creationEvidence.memberIds`, `existingRegionMatchScores`, `clusterConsistency`, and a concise `scopeDefinition`. The staged manifest must copy this validated record into `categories.newCategories[].creationEvidence` for audit.

A single low-fit paper never creates a region. Keep it provisional in the nearest region.

For a user-requested full-corpus repartition, every proposed macro region still needs at least four primary papers, at least 70/100 cluster consistency, a broad scope, complete membership evidence, and the global ten-region limit. Record every member's 0–100 match to each old region as a transparent comparison metric, but do not require those values to be below 60: a competing taxonomy can legitimately regroup papers that fit the former taxonomy. The below-60 rule resumes for later automatic incremental additions.

Reusing an existing category ID means reusing its exact name and scope. A genuinely different scope receives a new ID and must pass the creation rules. An explicit partition decision may retire old macro regions; it must never preserve them as empty shells merely to bypass the decision contract.

## Classification evidence

Base classification on the paper's stated research question, principal method, and principal result. Record a short rationale and at least one page, section, equation, figure, or table locator in the card. Classification similarity scores are routing judgments, not relationship strength.
