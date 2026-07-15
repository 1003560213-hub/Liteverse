# Liteverse usage contract

`Usage/events.jsonl` is an append-only audit ledger. `Usage/counts.json` is a disposable cache reconstructed by `rebuild-usage.mjs`.

The v2 unique count key is the SHA-256 hash of the resolved task ID, project ID, and paper ID. Task identity resolves from `LITEVERSE_TASK_ID`, then `CODEX_THREAD_ID`; raw task IDs are never stored. Legacy v1 task/paper events remain valid. Repeated reads in the same task/project return the paper without another event. A different task or project produces a new event. Events may record pinned artifact revision/hash and adopted claim/evidence IDs; global and per-project paper counts are both rebuildable.

`search-papers.mjs` never writes Usage. Curator conversion, validation, App clicks, and manual file opens never write Usage.

An adopted read first verifies the canonical card, requested full text, and requested claim sidecar against the pinned SHA-256 values in `Knowledge/papers.json`. Missing pins, hash mismatches, and revision conflicts fail before Usage is touched.

If a crash leaves only an invalid final JSONL fragment, a later counted read discards that non-event tail under the usage lock before appending. A valid event without its final newline is retained and terminated. Complete invalid lines are rejected rather than silently skipped.

The App maps integer `useCount` to `min(1, log1p(useCount) / log1p(32))`; it computes region brightness as the mean normalized heat of papers whose primary category is that region.
