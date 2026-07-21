---
name: liteverse-retriever
description: Use the Liteverse library to search, read, compare, summarize, cite, or apply evidence-backed literature while recording auditable usage exactly once per task, project, and paper. Trigger whenever a user says to use Liteverse for a research, academic-writing, or code-writing task; asks to retrieve or compare papers, claims, equations, methods, evidence, or pages; needs an AI Context Pack; or needs a claim verified against extracted full text.
---

# Liteverse Retriever

Search freely; count only papers that the task actually adopts.

## Workflow

1. Resolve the support directory from `--support-dir`, `LITEVERSE_SUPPORT_DIR`, or `~/Library/Application Support/Liteverse`.
2. Prefer the model-independent runtime: `node scripts/liteverse-cli.mjs search --query "..."` or `context build`. Searching and previewing never changes usage.
   The App's `liteverse-context-preview-v1` is a cache-only, revision-pinned shortlist of already verified claims and active project memory. It may be inspected before a task, but `adopted: false` means it is not a formal Context Pack and never counts usage. Build or read the exact evidence through Retriever before relying on it.
3. When a paper is actually used for reasoning, evidence, comparison, citation, or code design, read it with `scripts/read-paper.mjs --paper <paper-id>`. Select the smallest useful slice with `--section`, `--claim`, `--evidence`, `--page`, and `--max-chars`.
4. Use `context build` for multi-paper research, writing, or code tasks. Inspect its pinned claims, limitations, conflicts, and project conventions before acting.
5. Cite the selected claim's evidence locator and, when precision matters, confirm the page-marked full text or PDF.
6. Resolve task identity as explicit recovery `--task-id`, then `LITEVERSE_TASK_ID`, then `CODEX_THREAD_ID`. In one task/project a paper counts once even if read repeatedly; another project or task counts independently.

## Non-negotiable rules

- Do not use `cat`, `rg`, ordinary file reads, or custom scripts to bypass `read-paper.mjs` after deciding to use a paper.
- Do not count search results, Curator reads, App clicks, or manual Markdown opens.
- Do not reinterpret an App local preview as an adopted-evidence receipt. It remains non-adopting even when it contains verified claim metadata.
- Verify artifact revision and hashes before appending usage. On a mismatch, stop, do not count, and run `liteverse doctor`.
- For a folder-linked PDF, also verify its registered root, relative path, real path, storage mode, and live SHA-256 before adoption. A moved, missing, changed, or symlinked source must fail before usage is appended.
- Never adopt a legacy provisional card section. It is excluded from the FTS index and formal Context Packs.
- Do not edit `Usage/events.jsonl` or `Usage/counts.json` by hand. Use `scripts/rebuild-usage.mjs` only to reconstruct the cache from the append-only ledger.
- Refuse adopted reads when neither `LITEVERSE_TASK_ID` nor `CODEX_THREAD_ID` is available. The user may explicitly provide `--task-id` only for a controlled test or recovery.

## Resources

- Read `references/markdown-schema.md` when interpreting a card, locator, or full-text marker.
- Read `references/graph-contract.md` when explaining `useCount`, task deduplication, or visual heat.

Run scripts with `--help` for their complete deterministic interfaces.
