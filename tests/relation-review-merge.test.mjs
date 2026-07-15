import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const curatorScripts = path.join(root, "skills", "liteverse-curator", "scripts");

test("relation review merge re-scores every file and preserves legacy metadata", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-relation-merge-"));
  try {
    const support = path.join(temporary, "support");
    const reviewDirectory = path.join(temporary, "review");
    await Promise.all([
      mkdir(path.join(support, "Graph"), { recursive: true }),
      mkdir(reviewDirectory, { recursive: true }),
      mkdir(path.join(reviewDirectory, "inputs"), { recursive: true }),
    ]);
    const snapshotPath = path.join(temporary, "snapshot.json");
    const snapshot = {
      schemaVersion: "3.0.0",
      revision: 2,
      updated: "2026-01-01",
      visuals: {},
      categories: [],
      papers: [],
      relations: [{
        id: "a-b",
        source: "a",
        target: "b",
        type: "extends",
        label: "Extends",
        note: "legacy note",
        strength: null,
        confidence: null,
        legacyConfidence: 0.82,
        legacyStatus: "verified",
      }],
    };
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
    const inputPath = path.join(temporary, "input.json");
    const reviewPath = path.join(reviewDirectory, "a-b.json");
    await writeFile(inputPath, `${JSON.stringify({
      id: "a-b",
      source: "a",
      target: "b",
      type: "extends",
      label: "Extends",
      note: "Evidence-backed note",
      components: {
        directDependency: { score: 24, evidenceIds: ["A1", "B1"] },
        coreQuestion: { score: 16, evidenceIds: ["A1", "B1"] },
        methodContinuity: { score: 14, evidenceIds: ["A1", "B1"] },
        resultRelationship: { score: 14, evidenceIds: ["A1", "B1"] },
      },
      confidenceComponents: { sourceCoverage: 90, locatorPrecision: 90, crossConfirmation: 90 },
      evidence: [
        { id: "A1", paperId: "a", paraphrase: "Paper A states the method.", locator: { page: 2, section: "Methods" } },
        { id: "B1", paperId: "b", paraphrase: "Paper B extends that method.", locator: { page: 3, section: "Methods" } },
      ],
    })}\n`);
    await execFileAsync(process.execPath, [
      path.join(curatorScripts, "score-connection.mjs"),
      "--input", inputPath,
      "--output", reviewPath,
    ]);
    await writeFile(path.join(reviewDirectory, "inputs", "a-b.json"), await readFile(inputPath));
    await execFileAsync(process.execPath, [
      path.join(curatorScripts, "merge-relation-review.mjs"),
      "--snapshot", snapshotPath,
      "--review-dir", reviewDirectory,
      "--support-dir", support,
      "--require-all",
    ]);

    const relation = JSON.parse(await readFile(snapshotPath, "utf8")).relations[0];
    assert.equal(relation.strength, 68);
    assert.equal(relation.confidence, 90);
    assert.equal(relation.status, "verified");
    assert.equal(relation.scoringStatus, "scored_v1");
    assert.equal(relation.legacyConfidence, 0.82);
    assert.equal(relation.legacyStatus, "verified");

    const tampered = JSON.parse(await readFile(reviewPath, "utf8"));
    tampered.strength = 100;
    await writeFile(reviewPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [
        path.join(curatorScripts, "merge-relation-review.mjs"),
        "--snapshot", snapshotPath,
        "--review-dir", reviewDirectory,
      ], { env: { ...process.env, LITEVERSE_SUPPORT_DIR: support } }),
      /not a deterministic score-connection output/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("relation merge structurally rejects graph current, staged, and history targets without environment setup", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-relation-path-guard-"));
  const reviewDirectory = path.join(temporary, "review");
  const cleanEnvironment = { ...process.env };
  delete cleanEnvironment.LITEVERSE_SUPPORT_DIR;
  const targets = [
    [path.join(temporary, "Graph", "current.json"), /Graph\/current\.json/],
    [path.join(temporary, "Graph", "staged", "refresh", "snapshot.json"), /immutable Graph\/staged artifact/],
    [path.join(temporary, "Graph", "history", "revision.json"), /immutable Graph\/history artifact/],
  ];
  try {
    await mkdir(reviewDirectory, { recursive: true });
    for (const [target, message] of targets) {
      await assert.rejects(
        execFileAsync(process.execPath, [
          path.join(curatorScripts, "merge-relation-review.mjs"),
          "--snapshot", target,
          "--review-dir", reviewDirectory,
        ], { env: cleanEnvironment }),
        message,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
