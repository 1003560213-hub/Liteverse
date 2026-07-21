import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyEvents,
  sha256,
  validateMemoryDraft,
} from "../scripts/_memory-store.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../scripts/research-memory.mjs");

async function execute(support, args, rawTaskId = "raw-task-must-not-persist") {
  const result = await execFileAsync(process.execPath, [cli, ...args, "--support-dir", support, "--json"], {
    env: { ...process.env, LITEVERSE_TASK_ID: rawTaskId, CODEX_THREAD_ID: "ignored-codex-thread" },
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

test("multi-project memory remains append-only, revision guarded, and task IDs stay hashed", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-research-memory-"));
  try {
    const researchInformationPath = path.join(support, "research-information.json");
    await writeFile(researchInformationPath, `${JSON.stringify({
      schemaVersion: 1,
      status: "organized",
      formal: { text: "Original research information, preserved verbatim.\n", sourceRevision: 7 },
    })}\n`, "utf8");

    const initialized = await execute(support, [
      "project", "create-or-init",
      "--project", "project-default",
      "--name", "Numerical methods project",
      "--description", "Shared literature, isolated project memory",
      "--import-existing-research",
      "--activate",
      "--expected-revision", "0",
    ]);
    assert.equal(initialized.project.revision, 2);
    assert.equal(initialized.activeProjectId, "project-default");

    const memoryPath = path.join(support, "Projects", "project-default", "memory", "current.json");
    const importedProjection = JSON.parse(await readFile(memoryPath, "utf8"));
    assert.equal(importedProjection.items[0].content, "Original research information, preserved verbatim.\n");
    assert.equal(importedProjection.items[0].source.sourceRevision, 7);

    const rawTaskId = "raw-task-must-not-persist";
    const taskHash = createHash("sha256").update(rawTaskId).digest("hex");
    const begun = await execute(support, [
      "task", "begin", "--project", "project-default",
      "--summary", "Implement a literature-backed solver",
      "--expected-revision", "2",
    ], rawTaskId);
    assert.equal(begun.task.taskHash, taskHash);
    assert.equal(begun.revision, 3);
    const repeatedBegin = await execute(support, [
      "task", "begin", "--project", "project-default",
      "--summary", "Implement a literature-backed solver",
      "--expected-revision", "3",
    ], rawTaskId);
    assert.equal(repeatedBegin.started, false);
    assert.equal(repeatedBegin.revision, 3);

    const ledgerPath = path.join(support, "Projects", "project-default", "memory", "events.jsonl");
    assert.doesNotMatch(await readFile(ledgerPath, "utf8"), new RegExp(rawTaskId));

    const firstMemory = await execute(support, [
      "record", "memory", "--project", "project-default",
      "--memory-id", "mem-goal-a", "--type", "goal",
      "--title", "Current goal", "--content", "Validate the reference solver first.",
      "--provenance", "user", "--evidence-state", "user_declared",
      "--expected-revision", "3",
    ], rawTaskId);
    assert.equal(firstMemory.revision, 4);

    await assert.rejects(
      execute(support, [
        "record", "memory", "--project", "project-default",
        "--memory-id", "mem-invalid-ai", "--type", "finding",
        "--title", "Invalid certainty", "--content", "An unsupported AI claim.",
        "--provenance", "aiInference", "--evidence-state", "supported",
        "--expected-revision", "4",
      ], rawTaskId),
      /AI inferences must remain provisional/,
    );

    const evidencePath = path.join(support, "retriever-receipt.json");
    await writeFile(evidencePath, `${JSON.stringify([{
      paperId: "example-2025",
      claimId: "claim-convergence",
      evidenceId: "E2",
      artifactRevision: 3,
      artifactHash: "a".repeat(64),
      locator: "p. 7, Eq. (12)",
    }], null, 2)}\n`, "utf8");
    const paperMemory = await execute(support, [
      "record", "memory", "--project", "project-default",
      "--memory-id", "mem-paper-result", "--type", "finding",
      "--title", "Located convergence result", "--content", "The adopted result is limited to the cited setup.",
      "--provenance", "paperEvidence", "--evidence-state", "supported",
      "--paper-evidence-file", evidencePath,
      "--expected-revision", "4",
    ], rawTaskId);
    assert.equal(paperMemory.revision, 5);
    assert.equal(paperMemory.memory.paperEvidence[0].artifactHash, "a".repeat(64));

    const artifactPath = path.join(support, "code-artifact.json");
    await writeFile(artifactPath, `${JSON.stringify({
      kind: "code",
      path: "/workspace/solver.mjs",
      gitCommit: "abc1234",
      contentHash: "b".repeat(64),
      command: "node solver.mjs --check",
      resultSummary: "All deterministic checks passed.",
    }, null, 2)}\n`, "utf8");
    const codeMemory = await execute(support, [
      "record", "memory", "--project", "project-default",
      "--memory-id", "mem-solver-code", "--type", "code",
      "--title", "Validated solver", "--content", "Solver implementation and check summary.",
      "--provenance", "computationArtifact", "--evidence-state", "supported",
      "--artifact-file", artifactPath,
      "--expected-revision", "5",
    ], rawTaskId);
    assert.equal(codeMemory.revision, 6);
    assert.equal(codeMemory.memory.computationArtifact.path, "/workspace/solver.mjs");
    assert.equal(codeMemory.memory.computationArtifact.source, undefined);

    const replacement = await execute(support, [
      "record", "memory", "--project", "project-default",
      "--memory-id", "mem-goal-b", "--type", "decision",
      "--title", "Refined goal", "--content", "Validate the reference solver and document boundary sensitivity.",
      "--provenance", "user", "--evidence-state", "user_declared",
      "--supersedes", "mem-goal-a", "--contradicts", "mem-paper-result",
      "--expected-revision", "6",
    ], rawTaskId);
    assert.equal(replacement.revision, 7);

    const projected = JSON.parse(await readFile(memoryPath, "utf8"));
    const oldGoal = projected.items.find((item) => item.memoryId === "mem-goal-a");
    const cited = projected.items.find((item) => item.memoryId === "mem-paper-result");
    assert.equal(oldGoal.state, "superseded");
    assert.equal(oldGoal.supersededBy, "mem-goal-b");
    assert.deepEqual(cited.contradictedBy, ["mem-goal-b"]);
    assert.equal(cited.evidenceState, "supported", "a contradiction link must not silently downgrade evidence");

    const search = await execute(support, [
      "search", "--project", "project-default", "--query", "boundary sensitivity",
    ], rawTaskId);
    assert.equal(search.results[0].memoryId, "mem-goal-b");
    assert.ok(search.results.every((item) => item.state === "active"));

    const concurrent = ["mem-concurrent-a", "mem-concurrent-b"].map((memoryId) => execute(support, [
      "record", "memory", "--project", "project-default",
      "--memory-id", memoryId, "--type", "next_step",
      "--title", memoryId, "--content", `Follow-up for ${memoryId}`,
      "--provenance", "aiInference", "--evidence-state", "provisional",
      "--expected-revision", "7",
    ], rawTaskId));
    const settled = await Promise.allSettled(concurrent);
    assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
    assert.match(settled.find((entry) => entry.status === "rejected").reason.stderr, /revision conflict/);

    const outputPath = path.join(support, "task-outputs.json");
    await writeFile(outputPath, `${JSON.stringify([{
      kind: "experiment",
      path: "/workspace/results/run-01",
      configHash: "c".repeat(64),
      dataHash: "d".repeat(64),
      command: "run-simulation --config run-01.toml",
      resultSummary: "Run completed and conserved the monitored quantity.",
    }], null, 2)}\n`, "utf8");
    const completed = await execute(support, [
      "task", "complete", "--project", "project-default",
      "--result-summary", "Implemented and checked the solver.",
      "--memory-id", "mem-solver-code", "--outputs-file", outputPath,
      "--expected-revision", "8",
    ], rawTaskId);
    assert.equal(completed.revision, 9);
    assert.equal(completed.task.outputs[0].dataHash, "d".repeat(64));
    const repeatedComplete = await execute(support, [
      "task", "complete", "--project", "project-default",
      "--result-summary", "Implemented and checked the solver.",
      "--memory-id", "mem-solver-code", "--outputs-file", outputPath,
      "--expected-revision", "9",
    ], rawTaskId);
    assert.equal(repeatedComplete.completed, false);
    assert.equal(repeatedComplete.revision, 9);

    const handoff = await execute(support, [
      "handoff", "build", "--project", "project-default", "--expected-revision", "9",
    ], rawTaskId);
    assert.equal(handoff.revision, 10);
    assert.match(handoff.jsonPath, new RegExp(`Tasks/${taskHash}/handoffs/`));
    const handoffJson = await readFile(handoff.jsonPath, "utf8");
    assert.doesNotMatch(handoffJson, new RegExp(rawTaskId));
    assert.match(handoffJson, new RegExp(taskHash));

    const status = await execute(support, ["status", "--project", "project-default"], rawTaskId);
    assert.equal(status.projects[0].revision, 10);
    assert.ok(Object.values(status.projects[0].projectionHealth).every((entry) => entry.ok));
    const ledger = await readFile(ledgerPath, "utf8");
    assert.equal(ledger.trim().split("\n").length, 10);
    assert.doesNotMatch(ledger, new RegExp(rawTaskId));

    const secondProject = await execute(support, [
      "project", "create-or-init", "--project", "project-secondary",
      "--name", "Independent project", "--expected-revision", "0",
    ], rawTaskId);
    assert.equal(secondProject.project.revision, 1);
    assert.equal(secondProject.activeProjectId, "project-default");
    const isolatedSearch = await execute(support, [
      "search", "--project", "project-secondary", "--query", "reference solver",
    ], rawTaskId);
    assert.equal(isolatedSearch.resultCount, 0);
    const allStatus = await execute(support, ["status"], rawTaskId);
    assert.equal(allStatus.projectCount, 2);

    await writeFile(ledgerPath, "{broken-tail", { encoding: "utf8", flag: "a" });
    await assert.rejects(
      execute(support, ["status", "--project", "project-default"], rawTaskId),
      /invalid append-only ledger/,
    );
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("region notes and user knowledge cards remain user-declared, revision-scoped memory", () => {
  const content = "# Soliton response\n\nUser observation pending scientific review.\n";
  const regionMemory = {
    memoryId: "mem-region-doc-first",
    type: "project_context",
    title: "Soliton response notes",
    content,
    state: "active",
    evidenceState: "user_declared",
    provenance: "user",
    supersedes: [],
    contradicts: [],
    paperEvidence: [],
    scope: {
      kind: "nebula_region",
      categoryId: "soliton-dynamics",
      categoryNameAtAssignment: "Soliton Dynamics",
      graphRevisionAtAssignment: 12,
    },
    presentation: {
      documentId: "regiondoc-soliton-dynamics",
      kind: "knowledge_card",
      format: "markdown",
    },
    source: {
      kind: "app_region_document",
      input: "file_import",
      fileName: "soliton-notes.md",
      byteLength: Buffer.byteLength(content, "utf8"),
      contentSha256: sha256(content),
    },
  };

  const validated = validateMemoryDraft(regionMemory);
  assert.equal(validated.scope.graphRevisionAtAssignment, 12);
  assert.equal(validated.presentation.kind, "knowledge_card");
  assert.equal(validated.source.fileName, "soliton-notes.md");

  assert.throws(
    () => validateMemoryDraft({ ...regionMemory, evidenceState: "provisional" }),
    /remain user\/user_declared/,
  );
  assert.throws(
    () => validateMemoryDraft({
      ...regionMemory,
      source: { ...regionMemory.source, contentSha256: "a".repeat(64) },
    }),
    /contentSha256 does not match/,
  );
  assert.throws(
    () => validateMemoryDraft({
      ...regionMemory,
      source: { ...regionMemory.source, fileName: "soliton-notes.txt" },
    }),
    /format must match/,
  );

  const replacement = {
    ...regionMemory,
    memoryId: "mem-region-doc-second",
    content: `${content}\nEdited after checking the simulation setup.\n`,
    supersedes: [regionMemory.memoryId],
    source: {
      kind: "app_region_document",
      input: "manual",
      byteLength: Buffer.byteLength(`${content}\nEdited after checking the simulation setup.\n`, "utf8"),
      contentSha256: sha256(`${content}\nEdited after checking the simulation setup.\n`),
    },
  };
  const timestamp = "2026-07-20T00:00:00.000Z";
  const state = applyEvents("project-default", [
    {
      schemaVersion: 1,
      eventId: "event-project-init",
      timestamp,
      projectId: "project-default",
      revision: 1,
      type: "project_initialized",
      name: "Default project",
      description: "",
    },
    {
      schemaVersion: 1,
      eventId: "event-region-first",
      timestamp,
      projectId: "project-default",
      revision: 2,
      type: "memory_recorded",
      memory: regionMemory,
    },
    {
      schemaVersion: 1,
      eventId: "event-region-second",
      timestamp: "2026-07-20T00:01:00.000Z",
      projectId: "project-default",
      revision: 3,
      type: "memory_recorded",
      memory: replacement,
    },
  ]);
  assert.equal(state.memories.get(regionMemory.memoryId).state, "superseded");
  assert.equal(state.memories.get(regionMemory.memoryId).supersededBy, replacement.memoryId);
  assert.equal(state.memories.get(replacement.memoryId).state, "active");
  assert.throws(
    () => applyEvents("project-default", [
      {
        schemaVersion: 1,
        eventId: "event-project-init-two",
        timestamp,
        projectId: "project-default",
        revision: 1,
        type: "project_initialized",
        name: "Default project",
        description: "",
      },
      {
        schemaVersion: 1,
        eventId: "event-region-first-two",
        timestamp,
        projectId: "project-default",
        revision: 2,
        type: "memory_recorded",
        memory: regionMemory,
      },
      {
        schemaVersion: 1,
        eventId: "event-region-duplicate",
        timestamp,
        projectId: "project-default",
        revision: 3,
        type: "memory_recorded",
        memory: { ...replacement, supersedes: [] },
      },
    ]),
    /already has an active version/,
  );
});
