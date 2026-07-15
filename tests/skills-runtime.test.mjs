import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const curator = path.join(root, "skills", "liteverse-curator", "scripts");
const retriever = path.join(root, "skills", "liteverse-retriever", "scripts");

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("Skill scripts enforce scoring, taxonomy, queue, and counted-read contracts", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-skills-test-"));
  const env = { ...process.env, LITEVERSE_SUPPORT_DIR: support };
  const current = {
    schemaVersion: "2.0.0",
    revision: 1,
    updated: "2026-07-13",
    categories: [{ id: "macro", name: "Macro" }],
    papers: [{
      id: "seed-paper",
      title: "Seed Paper",
      primaryCategory: "macro",
      categoryIds: ["macro"],
      useCount: 0,
    }],
    relations: [],
  };
  const next = {
    ...current,
    revision: 2,
    papers: [{ ...current.papers[0], summary: "Evidence-backed update" }],
  };
  const card = `---
paper_id: seed-paper
title: "Seed Paper"
authors: ["Researcher"]
tags: ["wave"]
---

# Seed Paper

## Research question

Wave dynamics [E1].

<!-- liteverse-annotation-provenance: {"annotationId":"ann-1","sourceRevision":1} -->
`;
  const fulltext = `---\npaper_id: seed-paper\n---\n\n<!-- page: 1 -->\n\nWave dynamics evidence.\n`;
  try {
    await Promise.all([
      writeJson(path.join(support, "Graph", "current.json"), current),
      writeJson(path.join(support, "user-annotations.json"), [{
        id: "ann-1",
        paperId: "seed-paper",
        paperTitle: "Seed Paper",
        text: "Check the wave result.",
        status: "pending",
        revision: 1,
        createdAt: "2026-07-13T00:00:00Z",
        updatedAt: "2026-07-13T00:00:00Z",
      }]),
      mkdir(path.join(support, "Knowledge", "cards"), { recursive: true }),
      mkdir(path.join(support, "Knowledge", "fulltext"), { recursive: true }),
    ]);
    await writeFile(path.join(support, "Knowledge", "cards", "seed-paper.md"), card, "utf8");
    await writeFile(path.join(support, "Knowledge", "fulltext", "seed-paper.md"), fulltext, "utf8");

    const queue = JSON.parse((await execFileAsync(
      process.execPath,
      [path.join(curator, "list-queue.mjs"), "--json"],
      { env },
    )).stdout);
    assert.equal(queue.pendingAnnotations[0].revision, 1);

    const search = JSON.parse((await execFileAsync(
      process.execPath,
      [path.join(retriever, "search-papers.mjs"), "--query", "wave", "--json"],
      { env },
    )).stdout);
    assert.equal(search.results[0].paperId, "seed-paper");
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [path.join(retriever, "search-papers.mjs"), "--query", "!!!", "--json"],
        { env },
      ),
      /no searchable letters or digits/,
    );
    await assert.rejects(access(path.join(support, "Usage", "events.jsonl")));

    const firstRead = JSON.parse((await execFileAsync(
      process.execPath,
      [path.join(retriever, "read-paper.mjs"), "--paper", "seed-paper", "--task-id", "task-a", "--json"],
      { env },
    )).stdout);
    const repeatedRead = JSON.parse((await execFileAsync(
      process.execPath,
      [path.join(retriever, "read-paper.mjs"), "--paper", "seed-paper", "--task-id", "task-a", "--fulltext", "--json"],
      { env },
    )).stdout);
    const secondTask = JSON.parse((await execFileAsync(
      process.execPath,
      [path.join(retriever, "read-paper.mjs"), "--paper", "seed-paper", "--task-id", "task-b", "--json"],
      { env },
    )).stdout);
    assert.deepEqual(
      [firstRead.counted, repeatedRead.counted, secondTask.counted],
      [true, false, true],
    );
    assert.equal(secondTask.useCount, 2);
    assert.match(repeatedRead.fulltext, /<!-- page: 1 -->/);
    const ledgerText = await readFile(path.join(support, "Usage", "events.jsonl"), "utf8");
    assert.doesNotMatch(ledgerText, /task-a|task-b/);

    const scoringInput = {
      id: "seed-related",
      source: "seed-paper",
      target: "related-paper",
      components: {
        directDependency: { score: 24, evidenceIds: ["E1", "E2"] },
        coreQuestion: { score: 25, evidenceIds: ["E1", "E2"] },
        methodContinuity: { score: 14, evidenceIds: ["E1", "E2"] },
        resultRelationship: { score: 14, evidenceIds: ["E1", "E2"] },
      },
      confidenceComponents: {
        sourceCoverage: 90,
        locatorPrecision: 90,
        crossConfirmation: 80,
      },
      evidence: [
        { id: "E1", paperId: "seed-paper", locator: { page: 1 }, paraphrase: "Seed evidence." },
        { id: "E2", paperId: "related-paper", locator: { section: "2" }, paraphrase: "Related evidence." },
      ],
    };
    const scorePath = path.join(support, "score.json");
    await writeJson(scorePath, scoringInput);
    const scoreOne = (await execFileAsync(
      process.execPath,
      [path.join(curator, "score-connection.mjs"), "--input", scorePath],
      { env },
    )).stdout;
    const scoreTwo = (await execFileAsync(
      process.execPath,
      [path.join(curator, "score-connection.mjs"), "--input", scorePath],
      { env },
    )).stdout;
    assert.equal(createHash("sha256").update(scoreOne).digest("hex"), createHash("sha256").update(scoreTwo).digest("hex"));
    assert.equal(JSON.parse(scoreOne).status, "verified");
    await writeJson(scorePath, {
      ...scoringInput,
      evidence: [
        { id: "E1", paperId: "seed-paper", locator: { page: 0 }, paraphrase: "Invalid page." },
        scoringInput.evidence[1],
      ],
    });
    await assert.rejects(
      execFileAsync(process.execPath, [path.join(curator, "score-connection.mjs"), "--input", scorePath], { env }),
      /positive integer/,
    );

    const invalidSnapshotPath = path.join(support, "invalid-snapshot.json");
    await writeJson(invalidSnapshotPath, {
      ...next,
      papers: [{ ...next.papers[0], secondaryCategory: "unknown", categoryIds: ["macro", "unknown"] }],
    });
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [path.join(curator, "stage-refresh.mjs"), "--snapshot", invalidSnapshotPath, "--refresh-id", "invalid-secondary"],
        { env },
      ),
      /unknown secondaryCategory|unknown category/,
    );
    await writeJson(invalidSnapshotPath, { ...next, categories: [], papers: [], relations: [] });
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [path.join(curator, "stage-refresh.mjs"), "--snapshot", invalidSnapshotPath, "--refresh-id", "invalid-removal"],
        { env },
      ),
      /may not remove existing category/,
    );

    const snapshotPath = path.join(support, "next.json");
    await writeJson(snapshotPath, next);
    const currentBefore = await readFile(path.join(support, "Graph", "current.json"));
    await execFileAsync(
      process.execPath,
      [path.join(curator, "stage-refresh.mjs"), "--snapshot", snapshotPath, "--refresh-id", "annotation-refresh"],
      { env },
    );
    const currentAfter = await readFile(path.join(support, "Graph", "current.json"));
    assert.deepEqual(currentAfter, currentBefore);
    const pending = JSON.parse(await readFile(path.join(support, "Graph", "pending-update.json"), "utf8"));
    assert.deepEqual(pending.diff.papers.changed, ["seed-paper"]);

    await execFileAsync(
      process.execPath,
      [
        path.join(curator, "mark-annotation.mjs"),
        "--id", "ann-1",
        "--revision", "1",
        "--refresh-id", "annotation-refresh",
        "--derived-file", "Knowledge/cards/seed-paper.md",
      ],
      { env },
    );
    const annotations = JSON.parse(await readFile(path.join(support, "user-annotations.json"), "utf8"));
    assert.equal(annotations[0].status, "organized");
    assert.equal(annotations[0].revision, 2);
    assert.match(await readFile(path.join(support, "codex-inbox.jsonl"), "utf8"), /annotation_organized_by_codex/);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("Curator staging rejects graph deletions and safely transfers a replaced pending library batch", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-stage-recovery-test-"));
  const env = { ...process.env, LITEVERSE_SUPPORT_DIR: support };
  const stage = path.join(curator, "stage-refresh.mjs");
  const papers = ["seed-paper", "related-paper"].map((id) => ({
    id,
    title: id,
    primaryCategory: "macro",
    categoryIds: ["macro"],
    useCount: 0,
  }));
  const relation = {
    id: "seed-related",
    source: "seed-paper",
    target: "related-paper",
    type: "legacy",
    label: "Legacy relationship",
    strength: null,
    confidence: null,
  };
  const current = {
    schemaVersion: "2.0.0",
    revision: 1,
    updated: "2026-07-14T00:00:00Z",
    categories: [{ id: "macro", name: "Macro" }],
    papers,
    relations: [relation],
  };
  const next = {
    ...current,
    revision: 2,
    papers: [{ ...papers[0], summary: "Reviewed summary" }, papers[1]],
  };
  const libraryPath = path.join(support, "library.json");
  const currentPath = path.join(support, "Graph", "current.json");
  const usageEventsPath = path.join(support, "Usage", "events.jsonl");
  const usageCountsPath = path.join(support, "Usage", "counts.json");

  try {
    await Promise.all([
      writeJson(currentPath, current),
      writeJson(libraryPath, {
        schemaVersion: 1,
        nextNumber: 2,
        items: [{
          id: "item-1",
          number: 1,
          sourceType: "pdf",
          displayTitle: "Seed Paper",
          status: "processing",
          revision: 3,
          updatedAt: "2026-07-14T00:00:00Z",
        }],
      }),
      mkdir(path.dirname(usageEventsPath), { recursive: true }),
    ]);
    await writeFile(usageEventsPath, "{\"event\":\"preserve\"}\n", "utf8");
    await writeJson(usageCountsPath, { "seed-paper": 7 });
    const currentBefore = await readFile(currentPath);
    const usageEventsBefore = await readFile(usageEventsPath);
    const usageCountsBefore = await readFile(usageCountsPath);

    const deletionPath = path.join(support, "deletion.json");
    await writeJson(deletionPath, {
      ...next,
      papers: [next.papers[0]],
      relations: [],
    });
    await assert.rejects(
      execFileAsync(process.execPath, [stage, "--snapshot", deletionPath, "--refresh-id", "paper-deletion"], { env }),
      /may not remove existing paper related-paper/,
    );

    await writeJson(deletionPath, { ...next, relations: [] });
    await assert.rejects(
      execFileAsync(process.execPath, [stage, "--snapshot", deletionPath, "--refresh-id", "relation-deletion"], { env }),
      /may not remove existing relation seed-related/,
    );

    const snapshotPath = path.join(support, "next.json");
    const initialItemsPath = path.join(support, "initial-items.json");
    await writeJson(snapshotPath, next);
    await writeJson(initialItemsPath, [{ itemId: "item-1", revision: 3, paperId: "seed-paper" }]);
    await execFileAsync(
      process.execPath,
      [stage, "--snapshot", snapshotPath, "--refresh-id", "initial-refresh", "--library-items", initialItemsPath],
      { env },
    );
    const initiallyReady = JSON.parse(await readFile(libraryPath, "utf8")).items[0];
    assert.equal(initiallyReady.status, "ready_to_refresh");
    assert.equal(initiallyReady.revision, 4);
    assert.equal(initiallyReady.refreshId, "initial-refresh");

    const replacementSnapshotPath = path.join(support, "replacement.json");
    await writeJson(replacementSnapshotPath, {
      ...next,
      papers: [{ ...next.papers[0], summary: "Replacement reviewed summary" }, next.papers[1]],
    });
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [stage, "--snapshot", replacementSnapshotPath, "--refresh-id", "missing-items", "--replace-pending"],
        { env },
      ),
      /requires --library-items for the complete existing batch/,
    );
    assert.equal(JSON.parse(await readFile(libraryPath, "utf8")).items[0].refreshId, "initial-refresh");

    const mismatchedItemsPath = path.join(support, "mismatched-items.json");
    await writeJson(mismatchedItemsPath, [{ itemId: "item-1", revision: 4, paperId: "related-paper" }]);
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          stage,
          "--snapshot", replacementSnapshotPath,
          "--refresh-id", "mismatched-items",
          "--replace-pending",
          "--library-items", mismatchedItemsPath,
        ],
        { env },
      ),
      /must exactly match the existing pending manifest/,
    );
    const afterMismatch = JSON.parse(await readFile(libraryPath, "utf8")).items[0];
    assert.equal(afterMismatch.revision, 4);
    assert.equal(afterMismatch.refreshId, "initial-refresh");

    const replacementItemsPath = path.join(support, "replacement-items.json");
    await writeJson(replacementItemsPath, [{ itemId: "item-1", revision: 4, paperId: "seed-paper" }]);
    await execFileAsync(
      process.execPath,
      [
        stage,
        "--snapshot", replacementSnapshotPath,
        "--refresh-id", "replacement-refresh",
        "--replace-pending",
        "--library-items", replacementItemsPath,
      ],
      { env },
    );
    const transferred = JSON.parse(await readFile(libraryPath, "utf8")).items[0];
    assert.equal(transferred.status, "ready_to_refresh");
    assert.equal(transferred.revision, 4);
    assert.equal(transferred.graphPaperId, "seed-paper");
    assert.equal(transferred.refreshId, "replacement-refresh");
    const replacementManifest = JSON.parse(await readFile(
      path.join(support, "Graph", "staged", "replacement-refresh", "manifest.json"),
      "utf8",
    ));
    assert.deepEqual(replacementManifest.libraryItems, [{ itemId: "item-1", revision: 4, paperId: "seed-paper" }]);
    assert.deepEqual(replacementManifest.papers.removed, []);
    assert.deepEqual(replacementManifest.relations.removed, []);
    assert.deepEqual(await readFile(currentPath), currentBefore);
    assert.deepEqual(await readFile(usageEventsPath), usageEventsBefore);
    assert.deepEqual(await readFile(usageCountsPath), usageCountsBefore);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("Curator staging accepts ten macro regions and rejects an eleventh", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-ten-regions-test-"));
  const env = { ...process.env, LITEVERSE_SUPPORT_DIR: support };
  const categories = Array.from({ length: 10 }, (_, index) => ({
    id: `macro-${index + 1}`,
    name: `Macro ${index + 1}`,
  }));
  const current = {
    schemaVersion: "2.0.0",
    revision: 1,
    updated: "2026-07-13",
    categories,
    papers: [{
      id: "seed-paper",
      title: "Seed Paper",
      primaryCategory: categories[0].id,
      categoryIds: [categories[0].id],
      useCount: 0,
    }],
    relations: [],
  };

  try {
    await writeJson(path.join(support, "Graph", "current.json"), current);
    const tenRegionSnapshot = path.join(support, "ten-regions.json");
    await writeJson(tenRegionSnapshot, { ...current, revision: 2 });
    await execFileAsync(
      process.execPath,
      [path.join(curator, "stage-refresh.mjs"), "--snapshot", tenRegionSnapshot, "--refresh-id", "ten-regions"],
      { env },
    );

    const elevenRegionSnapshot = path.join(support, "eleven-regions.json");
    await writeJson(elevenRegionSnapshot, {
      ...current,
      revision: 2,
      categories: [...categories, { id: "macro-11", name: "Macro 11" }],
    });
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [path.join(curator, "stage-refresh.mjs"), "--snapshot", elevenRegionSnapshot, "--refresh-id", "eleven-regions"],
        { env },
      ),
      /at most ten macro categories/,
    );
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("Curator copies validated new-region creation evidence into the manifest", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-category-evidence-test-"));
  const env = { ...process.env, LITEVERSE_SUPPORT_DIR: support };
  const current = {
    schemaVersion: "2.0.0",
    revision: 1,
    updated: "2026-07-13",
    categories: [{ id: "existing", name: "Existing" }],
    papers: [{
      id: "seed-paper",
      title: "Seed Paper",
      primaryCategory: "existing",
      categoryIds: ["existing"],
      useCount: 0,
    }],
    relations: [],
  };
  const memberIds = ["new-paper-1", "new-paper-2", "new-paper-3", "new-paper-4"];
  const existingRegionMatchScores = Object.fromEntries(
    memberIds.map((paperId, index) => [paperId, { existing: 45 + index }]),
  );
  const creationEvidence = {
    memberIds,
    existingRegionMatchScores,
    clusterConsistency: 78,
    scopeDefinition: "A persistent broad scientific theme distinct from the existing macro region.",
  };
  const next = {
    ...current,
    revision: 2,
    categories: [
      ...current.categories,
      { id: "new-region", name: "New Region", creationEvidence },
    ],
    papers: [
      ...current.papers,
      ...memberIds.map((paperId) => ({
        id: paperId,
        title: paperId,
        primaryCategory: "new-region",
        categoryIds: ["new-region"],
        useCount: 0,
      })),
    ],
  };

  try {
    await writeJson(path.join(support, "Graph", "current.json"), current);
    const snapshotPath = path.join(support, "new-region.json");
    await writeJson(snapshotPath, {
      ...next,
      categories: [
        current.categories[0],
        {
          ...next.categories[1],
          creationEvidence: { ...creationEvidence, memberIds: memberIds.slice(1) },
        },
      ],
    });
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [path.join(curator, "stage-refresh.mjs"), "--snapshot", snapshotPath, "--refresh-id", "bad-category-evidence"],
        { env },
      ),
      /memberIds must match its primary papers/,
    );

    await writeJson(snapshotPath, next);
    await execFileAsync(
      process.execPath,
      [path.join(curator, "stage-refresh.mjs"), "--snapshot", snapshotPath, "--refresh-id", "category-evidence"],
      { env },
    );
    const manifest = JSON.parse(await readFile(
      path.join(support, "Graph", "staged", "category-evidence", "manifest.json"),
      "utf8",
    ));
    assert.deepEqual(manifest.categories.added, ["new-region"]);
    assert.deepEqual(manifest.categories.changed, []);
    assert.deepEqual(manifest.categories.removed, []);
    assert.deepEqual(manifest.categories.newCategories, [{
      categoryId: "new-region",
      creationEvidence,
    }]);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});
