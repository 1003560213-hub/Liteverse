---
name: liteverse-research-memory
description: Maintain traceable, multi-project Liteverse research memory for goals, conventions, assumptions, decisions, findings, open questions, code artifacts, experiments, task outcomes, conflicts, and handoffs. Use when a research or code-writing task should reuse project context, when the user asks to use the Liteverse library and the task creates reusable project knowledge, when starting or completing a Liteverse-backed task, or when preserving results for a later Codex or AI session. Do not use it in place of liteverse-retriever for reading or citing papers.
---

# Liteverse Research Memory

Preserve project knowledge as append-only events. Treat projections as rebuildable views, not truth.

## Workflow

1. Resolve the support directory from `--support-dir`, `LITEVERSE_SUPPORT_DIR`, or `~/Library/Application Support/Liteverse`.
2. Run `scripts/status.mjs --json`. Select the project explicitly when more than one exists.
3. Initialize a project with `scripts/project.mjs create-or-init --project <id> --name <name> --activate`. For the first migration, add `--import-existing-research` to preserve the complete existing Research Information as one user-declared memory before later structuring it.
4. Begin each reusable task with `scripts/begin-task.mjs --project <id> --summary <text>`. Let `LITEVERSE_TASK_ID` identify a generic AI task; Codex falls back to `CODEX_THREAD_ID`. Never invent a persistent raw task identifier.
5. Search active project memory with `scripts/search-memory.mjs --project <id> --query <text>`. Do not search across projects unless the user explicitly requests `--all-projects`.
6. If the task needs literature, invoke `liteverse-retriever` first. Accept only its paper, claim, evidence, artifact revision, and artifact hash receipt; never read paper cards, Graph, or Usage through this Skill.
7. Record every reusable outcome with `scripts/record-memory.mjs`. Keep AI inference `provisional`. Mark a result `supported` only with exact Retriever evidence or reproducible computation-artifact metadata.
8. Express replacement with `--supersedes` and disagreement with `--contradicts`. Append a new item; never rewrite or delete the old item. Retire obsolete active items with `--retire` and a reason.
9. Complete the task with `scripts/complete-task.mjs`, linking the memory IDs and metadata-only code or experiment outputs.
10. Build a portable continuation packet with `scripts/build-handoff.mjs`. Give later agents the handoff, not an unbounded dump of every project file.

Pass `--expected-revision <n>` on coordinated writes. On a conflict, reload status and reconcile the new events; do not retry against a stale revision.

## Epistemic rules

- Use `provenance=user` with `evidenceState=user_declared` for user statements.
- Use `provenance=aiInference` only with `evidenceState=provisional`.
- Use `provenance=paperEvidence` only with a Retriever receipt containing `paperId`, `claimId`, `evidenceId`, and SHA-256 `artifactHash`.
- Use `provenance=computationArtifact` for code and experiments. Store only path, Git commit or content/config/data hashes, command, and result summary; never copy source code, repositories, configs, or simulation data into memory.
- Keep contradicted items and their challengers visible. A relationship does not silently overwrite epistemic state.
- Never modify `Knowledge/`, `Graph/`, `Usage/`, PDF files, or Retriever receipts from this Skill.

## Resources

- Read `references/memory-contract.md` before changing schemas, projections, or concurrency behavior.
- Read `references/evidence-and-merge-policy.md` before recording supported, contradicted, superseding, code, or experiment memory.
- Run `scripts/research-memory.mjs --help` for the complete umbrella interface. The small command scripts are stable wrappers around it.

