# Liteverse retrieval schema

Search `Knowledge/cards/*.md`; verify against `Knowledge/fulltext/*.md` when precision matters. A full-text page begins with `<!-- page: N -->`. Cards use evidence IDs such as `[E1]`, and `## Evidence index` maps them to page, section, equation, figure, or table locators.

Treat a card's `TODO` or provisional statement as unresolved. Do not cite it as a verified result. Preserve distinctions among the paper's claim, the user's annotation, and Liteverse project interpretation.

Stable claim projections live at `Knowledge/claims/<paper-id>.json`. Each claim records its `claimId`, type, section, text, evidence locators, verification status, and the exact artifact revision/hash. Legacy provisional sections are excluded from claims and FTS.

Immutable revisions live below `Knowledge/artifacts/<paper-id>/revisions/<revision>/`; `Knowledge/artifacts/<paper-id>/current.json` and `Knowledge/papers.json` are rebuildable pointers. Never bypass an artifact mismatch by reading the mutable card directly.

Use the exact `paper_id` from frontmatter with `read-paper.mjs`. The canonical PDF path is recorded in `Knowledge/papers.json` and card metadata when available.
