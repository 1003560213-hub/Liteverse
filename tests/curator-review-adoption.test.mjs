import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const curator = path.join(root, "skills", "liteverse-curator", "scripts");
const buildScript = path.join(curator, "build-review-batch.mjs");
const applyScript = path.join(curator, "apply-review-batch.mjs");
const adoptScript = path.join(curator, "adopt-review-results.mjs");
const finalizeScript = path.join(curator, "finalize-curated-snapshot.py");
const claimsScript = path.join(curator, "generate-claims.mjs");
const stageScript = path.join(curator, "stage-refresh.mjs");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function put(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
}

function packet(index, sourceSha) {
  const candidate = (text) => ({
    page: 1,
    text,
    signals: [],
    status: "provisional",
    purpose: "routing_only",
  });
  return {
    schemaVersion: "liteverse-review-packet-v1",
    paperId: `paper-${index}`,
    itemId: `item-${index}`,
    itemRevision: 1,
    sourceSha256: sourceSha,
    status: "provisional",
    purpose: "routing_only",
    canonicalMetadata: {
      title: `Reviewed Paper ${index}`,
      authors: [`Author ${index}`],
      metadataStatus: "source_verified",
      storageMode: "managed",
      arxivId: null,
      doi: null,
    },
    pageCount: 1,
    extractionStatus: "extracted",
    sectionHeadingCandidates: [candidate("Research objective"), candidate("Project relevance")],
    equationLikeLineCandidates: [candidate(`x_${index} = 1`)],
    sentenceCandidates: {
      methods: [candidate(`Method statement ${index}.`)],
      results: [candidate(`Result statement ${index}.`)],
      limitations: [candidate(`Limitation statement ${index}.`)],
    },
  };
}

async function fixture(parent, count = 3) {
  const support = path.join(parent, "Support");
  const current = {
    schemaVersion: "3.0.0",
    revision: 1,
    title: "Liteverse",
    updated: "2026-07-21T00:00:00.000Z",
    visuals: {},
    categories: [],
    galaxies: [],
    papers: [],
    relations: [],
    usagePolicy: {},
  };
  await put(path.join(support, "Graph", "current.json"), jsonBytes(current));
  const items = [];
  for (let index = 1; index <= count; index += 1) {
    const source = Buffer.from(`%PDF-1.4\nreview-adoption-${index}\n%%EOF\n`, "utf8");
    const sourceSha = sha256(source);
    const fulltext = Buffer.from(`<!-- page: 1 -->\n\nOriginal extracted page ${index}.\n`, "utf8");
    const card = Buffer.from(`---\npaper_id: "paper-${index}"\nverification_status: "card_draft"\n---\n`, "utf8");
    const reviewPacket = jsonBytes(packet(index, sourceSha));
    const job = path.join(support, "Work", "LocalPipeline", `job-${index}`);
    const outputs = [
      ["pdf", "source.pdf", source],
      ["fulltext", "fulltext.md", fulltext],
      ["card", "card.md", card],
      ["review_packet", "review-packet.json", reviewPacket],
    ];
    for (const [, relative, bytes] of outputs) await put(path.join(job, relative), bytes);
    const manifest = {
      schemaVersion: "liteverse-local-result-v1",
      jobId: `job-${index}`,
      itemId: `item-${index}`,
      itemRevision: 1,
      catalogFingerprint: "absent",
      state: "ready",
      sourceSha256: sourceSha,
      extractionStatus: "extracted",
      canonicalMetadata: packet(index, sourceSha).canonicalMetadata,
      paper: { paperId: `paper-${index}`, verificationStatus: "card_draft" },
      outputs: outputs.map(([role, relative, bytes]) => ({
        role,
        path: relative,
        sha256: sha256(bytes),
        size: bytes.byteLength,
      })),
    };
    const manifestBytes = jsonBytes(manifest);
    await put(path.join(job, "manifest.json"), manifestBytes);
    await put(path.join(support, "Library", "PDFs", `paper-${index}.pdf`), source);
    items.push({
      id: `item-${index}`,
      number: index,
      revision: 2,
      status: "pending_codex",
      sourceType: "pdf",
      storedFilename: `paper-${index}.pdf`,
      displayTitle: `Reviewed Paper ${index}`,
      source: { storageMode: "managed", sha256: sourceSha },
      preparation: {
        schemaVersion: 1,
        state: "ready",
        jobId: `job-${index}`,
        sourceRevision: 1,
        resultSha256: sha256(manifestBytes),
        manifestPath: `Work/LocalPipeline/job-${index}/manifest.json`,
      },
    });
  }
  await put(path.join(support, "library.json"), jsonBytes({ schemaVersion: 1, nextNumber: count + 1, items }));
  return support;
}

function targetSections(candidates) {
  const sections = [
    "research_question",
    "project_role",
    "main_results",
    "methods",
  ];
  assert.equal(candidates.length, sections.length);
  return candidates.map((candidate, index) => ({
    candidateId: candidate.candidateId,
    decision: "accept",
    targetSection: sections[index],
    faithfulParaphrase: `Source-reviewed ${sections[index].replaceAll("_", " ")}.`,
  }));
}

function decisions(batch, batchSha256) {
  return {
    schemaVersion: "liteverse-curation-decisions-v1",
    batchId: batch.batchId,
    batchSha256,
    papers: batch.papers.map((paper) => ({
      itemId: paper.itemId,
      itemRevision: paper.itemRevision,
      sourceRevision: paper.sourceRevision,
      paperId: paper.paperId,
      sourceSha256: paper.sourceSha256,
      packetSha256: paper.packetSha256,
      requestedVerificationStatus: "card_draft",
      decisions: targetSections(paper.candidates),
    })),
  };
}

test("review results adopt transactionally into immutable-artifact and staged-refresh flow", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-review-adoption-"));
  try {
    const support = await fixture(temporary);
    const currentPath = path.join(support, "Graph", "current.json");
    const currentBefore = await readFile(currentPath);
    const built = JSON.parse((await execFileAsync(process.execPath, [
      buildScript, "--support-dir", support, "--max-papers", "3", "--json",
    ])).stdout);
    const batch = JSON.parse(await readFile(built.batchPath, "utf8"));
    const decisionPath = path.join(temporary, "decisions.json");
    await put(decisionPath, jsonBytes(decisions(batch, built.batchSha256)));
    const applied = JSON.parse((await execFileAsync(process.execPath, [
      applyScript, "--support-dir", support, "--batch", built.batchPath,
      "--decisions", decisionPath, "--json",
    ])).stdout);
    const adopted = JSON.parse((await execFileAsync(process.execPath, [
      adoptScript, "--support-dir", support, "--result", applied.manifestPath, "--json",
    ])).stdout);
    const resumed = JSON.parse((await execFileAsync(process.execPath, [
      adoptScript, "--support-dir", support, "--result", applied.manifestPath, "--json",
    ])).stdout);
    assert.equal(resumed.resumed, true);
    assert.deepEqual(await readFile(currentPath), currentBefore);
    await assert.rejects(access(path.join(support, "Graph", "pending-update.json")));
    await assert.rejects(access(path.join(support, "Graph", "staged")));
    await assert.rejects(access(path.join(support, "Usage")));
    await assert.rejects(access(path.join(support, "Projects")));
    const draftIndex = JSON.parse(await readFile(path.join(support, "Knowledge", "papers.json"), "utf8"));
    assert.equal(draftIndex.papers.length, 3);
    assert.ok(draftIndex.papers.every((paper) => paper.primaryCategory === "liteverse-staging"));

    await execFileAsync("python3", [finalizeScript, "--support-dir", support, "--snapshot", adopted.workingSnapshotPath]);
    for (const paperId of adopted.paperIds) {
      await execFileAsync(process.execPath, [
        claimsScript, "--support-dir", support, "--paper", paperId,
        "--snapshot", adopted.workingSnapshotPath, "--json",
      ]);
    }
    await assert.rejects(access(path.join(support, "Graph", "pending-update.json")));
    const staged = JSON.parse((await execFileAsync(process.execPath, [
      stageScript, "--support-dir", support, "--snapshot", adopted.workingSnapshotPath,
      "--library-items", adopted.libraryItemsPath, "--refresh-id", "review-adoption-test",
    ])).stdout);
    assert.equal(staged.status, "ready_to_refresh");
    assert.deepEqual(staged.manifest.papers.added, ["paper-1", "paper-2", "paper-3"]);
    assert.equal(staged.manifest.libraryItems.length, 3);
    assert.deepEqual(await readFile(currentPath), currentBefore);
    const stagedSnapshot = JSON.parse(await readFile(path.join(support, staged.pending.snapshotPath), "utf8"));
    assert.equal(stagedSnapshot.papers.length, 3);
    assert.ok(stagedSnapshot.papers.every((paper) => paper.artifacts.integrity?.artifactRevision === 1));
    assert.ok(stagedSnapshot.papers.every((paper) => paper.verificationStatus === "card_draft"));
    assert.ok(stagedSnapshot.papers.every((paper) => paper.primaryCategory === "liteverse-staging"));
    const library = JSON.parse(await readFile(path.join(support, "library.json"), "utf8"));
    assert.ok(library.items.every((item) => item.status === "ready_to_refresh"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("adoption fails closed on a changed review result before canonical drafts appear", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-review-adoption-stale-"));
  try {
    const support = await fixture(temporary);
    const built = JSON.parse((await execFileAsync(process.execPath, [
      buildScript, "--support-dir", support, "--max-papers", "3", "--json",
    ])).stdout);
    const batch = JSON.parse(await readFile(built.batchPath, "utf8"));
    const decisionPath = path.join(temporary, "decisions.json");
    await put(decisionPath, jsonBytes(decisions(batch, built.batchSha256)));
    const applied = JSON.parse((await execFileAsync(process.execPath, [
      applyScript, "--support-dir", support, "--batch", built.batchPath,
      "--decisions", decisionPath, "--json",
    ])).stdout);
    const result = JSON.parse(await readFile(applied.manifestPath, "utf8"));
    await writeFile(path.join(path.dirname(applied.manifestPath), result.outputs[0].cardPath), "changed\n", "utf8");
    await assert.rejects(
      execFileAsync(process.execPath, [adoptScript, "--support-dir", support, "--result", applied.manifestPath]),
      /card hash mismatch/,
    );
    await assert.rejects(access(path.join(support, "Knowledge", "papers.json")));
    await assert.rejects(access(path.join(support, "Knowledge", "cards")));
    await assert.rejects(access(path.join(support, "Graph", "pending-update.json")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("partial same-catalog adoption fails before canonical writes and succeeds when the wave is complete", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-review-adoption-partial-wave-"));
  try {
    const support = await fixture(temporary, 6);
    const manifests = [];
    const buildAndApply = async (suffix) => {
      const built = JSON.parse((await execFileAsync(process.execPath, [
        buildScript, "--support-dir", support, "--max-papers", "3", "--json",
      ])).stdout);
      const batch = JSON.parse(await readFile(built.batchPath, "utf8"));
      const decisionPath = path.join(temporary, `decisions-${suffix}.json`);
      await put(decisionPath, jsonBytes(decisions(batch, built.batchSha256)));
      const applied = JSON.parse((await execFileAsync(process.execPath, [
        applyScript, "--support-dir", support, "--batch", built.batchPath,
        "--decisions", decisionPath, "--json",
      ])).stdout);
      manifests.push(applied.manifestPath);
    };

    await buildAndApply("first");
    await assert.rejects(
      execFileAsync(process.execPath, [
        adoptScript, "--support-dir", support, "--result", manifests[0], "--json",
      ]),
      /omits 3 reviewable item\(s\) from the same preparation wave/,
    );
    await assert.rejects(access(path.join(support, "Knowledge", "papers.json")));
    await assert.rejects(access(path.join(support, "Knowledge", "cards")));
    await assert.rejects(access(path.join(support, "Graph", "pending-update.json")));

    await buildAndApply("second");
    const argumentsForAdoption = [adoptScript, "--support-dir", support, "--json"];
    for (const manifest of manifests) argumentsForAdoption.push("--result", manifest);
    const adopted = JSON.parse((await execFileAsync(process.execPath, argumentsForAdoption)).stdout);
    assert.equal(adopted.paperIds.length, 6);
    const index = JSON.parse(await readFile(path.join(support, "Knowledge", "papers.json"), "utf8"));
    assert.equal(index.papers.length, 6);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("partial-wave guard ignores needs-attention, organized, and different-catalog items", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-review-adoption-wave-exclusions-"));
  try {
    const support = await fixture(temporary, 4);
    const fourthManifestPath = path.join(support, "Work", "LocalPipeline", "job-4", "manifest.json");
    const fourthManifest = JSON.parse(await readFile(fourthManifestPath, "utf8"));
    fourthManifest.catalogFingerprint = "f".repeat(64);
    const fourthManifestBytes = jsonBytes(fourthManifest);
    await writeFile(fourthManifestPath, fourthManifestBytes);
    const libraryPath = path.join(support, "library.json");
    const library = JSON.parse(await readFile(libraryPath, "utf8"));
    library.items[3].preparation.resultSha256 = sha256(fourthManifestBytes);
    library.items.push({
      id: "item-needs-attention",
      number: 5,
      revision: 2,
      status: "pending_codex",
      preparation: { schemaVersion: 1, state: "needs_attention" },
    });
    library.items.push({
      id: "item-auto-resolved-duplicate",
      number: 6,
      revision: 2,
      status: "organized",
      disposition: "duplicate",
      preparation: { schemaVersion: 1, state: "ready" },
    });
    await writeFile(libraryPath, jsonBytes(library));

    const built = JSON.parse((await execFileAsync(process.execPath, [
      buildScript, "--support-dir", support, "--max-papers", "3", "--json",
    ])).stdout);
    const batch = JSON.parse(await readFile(built.batchPath, "utf8"));
    const decisionPath = path.join(temporary, "decisions.json");
    await put(decisionPath, jsonBytes(decisions(batch, built.batchSha256)));
    const applied = JSON.parse((await execFileAsync(process.execPath, [
      applyScript, "--support-dir", support, "--batch", built.batchPath,
      "--decisions", decisionPath, "--json",
    ])).stdout);
    const adopted = JSON.parse((await execFileAsync(process.execPath, [
      adoptScript, "--support-dir", support, "--result", applied.manifestPath, "--json",
    ])).stdout);
    assert.equal(adopted.paperIds.length, 3);
    const index = JSON.parse(await readFile(path.join(support, "Knowledge", "papers.json"), "utf8"));
    assert.equal(index.papers.length, 3);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("title and author similarity is not promoted to a strict duplicate key", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-review-adoption-title-match-"));
  try {
    const support = await fixture(temporary, 3);
    const job = path.join(support, "Work", "LocalPipeline", "job-2");
    const packetPath = path.join(job, "review-packet.json");
    const packetValue = JSON.parse(await readFile(packetPath, "utf8"));
    packetValue.canonicalMetadata.title = "Reviewed Paper 1";
    packetValue.canonicalMetadata.authors = ["Author 1"];
    const packetBytes = jsonBytes(packetValue);
    await writeFile(packetPath, packetBytes);
    const manifestPath = path.join(job, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.canonicalMetadata.title = "Reviewed Paper 1";
    manifest.canonicalMetadata.authors = ["Author 1"];
    const packetOutput = manifest.outputs.find((output) => output.role === "review_packet");
    packetOutput.sha256 = sha256(packetBytes);
    packetOutput.size = packetBytes.byteLength;
    const manifestBytes = jsonBytes(manifest);
    await writeFile(manifestPath, manifestBytes);
    const libraryPath = path.join(support, "library.json");
    const library = JSON.parse(await readFile(libraryPath, "utf8"));
    library.items[1].displayTitle = "Reviewed Paper 1";
    library.items[1].preparation.resultSha256 = sha256(manifestBytes);
    await writeFile(libraryPath, jsonBytes(library));

    const built = JSON.parse((await execFileAsync(process.execPath, [
      buildScript, "--support-dir", support, "--max-papers", "3", "--json",
    ])).stdout);
    const batch = JSON.parse(await readFile(built.batchPath, "utf8"));
    const decisionPath = path.join(temporary, "decisions.json");
    await put(decisionPath, jsonBytes(decisions(batch, built.batchSha256)));
    const applied = JSON.parse((await execFileAsync(process.execPath, [
      applyScript, "--support-dir", support, "--batch", built.batchPath,
      "--decisions", decisionPath, "--json",
    ])).stdout);
    const adopted = JSON.parse((await execFileAsync(process.execPath, [
      adoptScript, "--support-dir", support, "--result", applied.manifestPath, "--json",
    ])).stdout);
    assert.equal(adopted.paperIds.length, 3);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("twelve prepared papers drain through multiple review batches and one adoption without re-extraction", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-review-adoption-large-"));
  try {
    const support = await fixture(temporary, 12);
    const extractionHashesBefore = [];
    for (let index = 1; index <= 12; index += 1) {
      extractionHashesBefore.push(sha256(await readFile(path.join(support, "Work", "LocalPipeline", `job-${index}`, "fulltext.md"))));
    }
    const manifests = [];
    for (const expectedCount of [5, 5, 2]) {
      const buildArguments = [
        buildScript, "--support-dir", support, "--max-papers", "5", "--json",
        ...(expectedCount < 3 ? ["--allow-partial"] : []),
      ];
      const built = JSON.parse((await execFileAsync(process.execPath, buildArguments)).stdout);
      assert.equal(built.paperCount, expectedCount);
      const batch = JSON.parse(await readFile(built.batchPath, "utf8"));
      const decisionPath = path.join(temporary, `decisions-${manifests.length}.json`);
      await put(decisionPath, jsonBytes(decisions(batch, built.batchSha256)));
      const applied = JSON.parse((await execFileAsync(process.execPath, [
        applyScript, "--support-dir", support, "--batch", built.batchPath,
        "--decisions", decisionPath, "--json",
      ])).stdout);
      manifests.push(applied.manifestPath);
    }
    const adoptionArguments = [adoptScript, "--support-dir", support, "--json"];
    for (const manifest of manifests) adoptionArguments.push("--result", manifest);
    const template = JSON.parse((await execFileAsync(process.execPath, [
      ...adoptionArguments,
      "--write-assignment-template",
    ])).stdout);
    assert.equal(template.status, "assignment_template_ready");
    const templateValue = JSON.parse(await readFile(template.path, "utf8"));
    assert.equal(templateValue.papers.length, 12);
    assert.ok(templateValue.papers.every((paper) => paper.evidenceIds.length > 0));
    await assert.rejects(access(path.join(support, "Knowledge", "papers.json")));
    const adopted = JSON.parse((await execFileAsync(process.execPath, adoptionArguments)).stdout);
    assert.equal(adopted.paperIds.length, 12);
    assert.equal(adopted.batchIds.length, 3);
    const index = JSON.parse(await readFile(path.join(support, "Knowledge", "papers.json"), "utf8"));
    assert.equal(index.revision, 1);
    assert.equal(index.papers.length, 12);
    const extractionHashesAfter = [];
    for (let index = 1; index <= 12; index += 1) {
      extractionHashesAfter.push(sha256(await readFile(path.join(support, "Work", "LocalPipeline", `job-${index}`, "fulltext.md"))));
    }
    assert.deepEqual(extractionHashesAfter, extractionHashesBefore);
    await assert.rejects(access(path.join(support, "Graph", "pending-update.json")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
