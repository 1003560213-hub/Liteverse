# Liteverse macro taxonomy

## Assignment contract

- Do not install or prefer a fixed default taxonomy. A valid explicitly selected taxonomy is durable project state and should be reused for ordinary incremental additions; it is not a default for a new universe.
- Search the complete corpus and prepare exactly three materially distinct partition options only for first initialization, an explicit user-requested repartition, or a stable novel-cluster advisory that passes the creation gate below.
- For ordinary additions, run `screen-incremental-classification.mjs`, treat all scores as routing-only, and scientifically confirm the new papers against the existing regions. Do not reclassify unchanged papers.
- When three options are required, ask the user to choose one. Do not classify or stage from a proposal alone.
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

Persist the spatial layout at the same time. An unchanged reused region may retain its finite center and acts as an occupied footprint for subsequent placement. Generate all other macro centers deterministically from option order and the assignment seed on a bounded ellipsoidal/Fibonacci distribution sized for the existing universe view. Score those three-dimensional candidates against the hash-pinned default-background occupancy profile and the App's default-camera projection: prefer visually blank footprints, softly penalize projected nebula overlap and window-chrome intrusion, then retain normalized three-dimensional separation as a depth-preserving reward. This is a soft preference, not a collision ban; crowded layouts up to ten regions may overlap. If the packaged default background or its crop changes, regenerate and re-pin the profile before release. Regenerate every paper position from stable paper-ID ordering and a golden-angle three-dimensional cloud around its primary center. Positions must be unique, finite, reproducible, and remain within the region cloud radius; never leave positions tied to the previous taxonomy.

## Nested galaxy routing

After card finalization, claims, and relation review are complete, the staging gate derives galaxies inside each selected macro nebula. These are routing and visualization groups, not additional scientific categories, so they require no fourth partition proposal and must never change the user's selected macro taxonomy. Every paper belongs to exactly one galaxy under its primary region. One through three papers form one galaxy; larger regions normally use approximately one galaxy per five papers, with at least two and never more than twelve. Existing v2 anchor-based IDs, concentric-orbit positions, assets, and compatible memberships remain stable as papers are added.

Place each region's galaxies around its central knowledge black hole on deterministic three-dimensional rings. Fill all four inner-ring slots before using the eight-slot outer ring, preserve the black-hole clearance, and refuse a placement that would violate the minimum galaxy-center separation. The depth component is part of the persisted position and must not be flattened by Curator or App fallback. Across the full universe, assign every supplied galaxy image before reusing one; after exhaustion, balance usage globally and resolve ties from the stable hierarchy seed. These rules are implemented by the shared hierarchy contract, never duplicated in a Skill-only approximation.

Deterministic routing may use normalized tags and the topology/status of already reviewed paper relations only to choose a visual group. It must not persist or display that internal affinity as scientific similarity, relationship strength, or confidence. Galaxy-to-galaxy lanes are derived from the original paper relations at runtime; do not create aggregate scientific relations, add percentages, duplicate evidence, or alter Usage.

After an explicit choice, `apply-partition-choice.mjs` revalidates all three options and locks, selects exactly one option, appends the user decision, and emits an ordinary unstaged snapshot. Any revision, snapshot, or artifact drift invalidates the proposal and requires three fresh options.

## Incremental classification lease

A selected taxonomy remains in force until the user requests repartition or the
stable novel-cluster gate is met. Screen only the incoming papers against
profiles built from current region names, descriptions, and member literature:

```bash
node scripts/screen-incremental-classification.mjs \
  --snapshot <unstaged-snapshot.json> --input <new-papers.json>
```

The output is deterministic, `routingOnly: true`, and never writes a graph.
Its 0–100 match values are lexical routing diagnostics, not scientific
similarity or relationship strength. Confirm assignments using the paper's
original-page evidence. A single low-fit paper remains provisional in the
nearest region. Only at least four low-fit papers with at least 70% provisional
within-cluster consistency may trigger three new full-corpus options; the
ordinary screener never creates a category or applies an assignment itself.

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
