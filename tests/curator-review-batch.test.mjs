import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const scripts = path.join(root, "skills", "liteverse-curator", "scripts");
const buildScript = path.join(scripts, "build-review-batch.mjs");
const applyScript = path.join(scripts, "apply-review-batch.mjs");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeBytes(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
}

function v1Packet(index, sourceSha) {
  const candidate = (text, signals = []) => ({
    page: 1,
    text,
    signals,
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
      title: `Paper ${index}`,
      authors: [`Author ${index}`],
      metadataStatus: "source_verified",
    },
    pageCount: 1,
    extractionStatus: "extracted",
    sectionHeadingCandidates: [candidate("1 Introduction")],
    equationLikeLineCandidates: [candidate(`E_${index} = m c^2`, ["equation_like"])],
    sentenceCandidates: {
      methods: [candidate(`We use deterministic method ${index}.`, ["method"])],
      results: [candidate(`We find deterministic result ${index}.`, ["result"])],
      limitations: [candidate(`This approximation is limited in fixture ${index}.`, ["limitation"])],
    },
  };
}

function v2Item(index, sourceSha, pageSha, kind, prefix) {
  const text = `${kind.replaceAll("_", " ")} candidate ${index}`;
  const digest = sha256(Buffer.from(`${sourceSha}:${kind}:${index}`, "utf8"));
  const id = `rp2-${prefix}-${digest}`;
  return {
    id,
    ...(prefix === "candidate" ? { candidateId: id } : { anchorId: id }),
    kind,
    page: 1,
    section: "Methods",
    ordinal: index,
    characterRange: { start: index * 30, end: index * 30 + text.length, encoding: "utf16" },
    sourceSha256: sourceSha,
    pageTextSha256: pageSha,
    text,
    context: { previous: `Previous ${index}`, current: text, next: `Next ${index}` },
    signals: [kind],
    routingScore: 80 - index,
    status: "provisional",
    purpose: "routing_only",
    verificationState: "unverified",
  };
}

function v2Packet(index, sourceSha) {
  const pageSha = sha256(Buffer.from(`page-text-${index}`, "utf8"));
  return {
    schemaVersion: "liteverse-review-packet-v2",
    paperId: `paper-${index}`,
    itemId: `item-${index}`,
    itemRevision: 1,
    sourceSha256: sourceSha,
    status: "provisional",
    purpose: "routing_only",
    canonicalMetadata: {
      title: `Paper ${index}`,
      authors: [`Author ${index}`],
      metadataStatus: "source_verified",
    },
    pageCount: 1,
    extractionStatus: "extracted",
    pageExtractionQuality: [{
      page: 1,
      pageTextSha256: pageSha,
      characterCount: 400,
      meaningfulCharacterCount: 360,
      wordCount: 70,
      quality: "good",
    }],
    candidateSets: {
      researchQuestions: [v2Item(index, sourceSha, pageSha, "research_question", "candidate")],
      methods: [v2Item(index + 10, sourceSha, pageSha, "method", "candidate")],
      results: [v2Item(index + 20, sourceSha, pageSha, "result", "candidate")],
      limitations: [v2Item(index + 30, sourceSha, pageSha, "limitation", "candidate")],
      assumptions: [v2Item(index + 40, sourceSha, pageSha, "assumption", "candidate")],
    },
    anchors: {
      sections: [v2Item(index + 50, sourceSha, pageSha, "section", "anchor")],
      equations: [v2Item(index + 60, sourceSha, pageSha, "equation", "anchor")],
      figures: [],
      tables: [],
      citations: [],
    },
  };
}

async function createPreparedSupport(parent, count = 5) {
  const support = path.join(parent, "Support");
  const items = [];
  for (let index = 1; index <= count; index += 1) {
    const jobId = `job-${index}`;
    const itemId = `item-${index}`;
    const paperId = `paper-${index}`;
    const source = Buffer.from(`%PDF deterministic source ${index}\n`, "utf8");
    const sourceSha = sha256(source);
    const packet = index % 2 === 0 ? v2Packet(index, sourceSha) : v1Packet(index, sourceSha);
    const job = path.join(support, "Work", "LocalPipeline", jobId);
    const outputs = [
      ["pdf", "source.pdf", source],
      ["fulltext", "fulltext.md", Buffer.from(`<!-- page: 1 -->\n\nFull text ${index}.\n`)],
      ["card", "card.md", Buffer.from(`---\npaper_id: ${paperId}\nverification_status: card_draft\n---\n`)],
      ["review_packet", "review-packet.json", jsonBytes(packet)],
    ];
    for (const [, relative, bytes] of outputs) await writeBytes(path.join(job, relative), bytes);
    const manifest = {
      schemaVersion: "liteverse-local-result-v1",
      jobId,
      itemId,
      itemRevision: 1,
      catalogFingerprint: "absent",
      state: "ready",
      sourceSha256: sourceSha,
      extractionStatus: "extracted",
      canonicalMetadata: {
        title: `Paper ${index}`,
        authors: [`Author ${index}`],
        metadataStatus: "source_verified",
        storageMode: "managed",
      },
      paper: { paperId, verificationStatus: "card_draft" },
      outputs: outputs.map(([role, relative, bytes]) => ({
        role,
        path: relative,
        sha256: sha256(bytes),
        size: bytes.byteLength,
      })),
    };
    const manifestBytes = jsonBytes(manifest);
    await writeBytes(path.join(job, "manifest.json"), manifestBytes);
    await writeBytes(path.join(support, "Library", "PDFs", `${paperId}.pdf`), source);
    items.push({
      id: itemId,
      number: index,
      sourceType: "pdf",
      storedFilename: `${paperId}.pdf`,
      displayTitle: `Paper ${index}`,
      status: "pending_codex",
      revision: 2,
      source: { storageMode: "managed", sha256: sourceSha },
      preparation: {
        schemaVersion: 1,
        state: "ready",
        jobId,
        sourceRevision: 1,
        resultSha256: sha256(manifestBytes),
        manifestPath: `Work/LocalPipeline/${jobId}/manifest.json`,
        ...(packet.schemaVersion === "liteverse-review-packet-v2" ? {
          screeningCandidates: [{
            paperId: "existing-related-paper",
            rank: 1.234567891,
            routingOnly: true,
            title: "Existing related paper",
            snippet: "A source-pinned search snippet.",
            artifactRevision: 2,
            artifactSha256: "a".repeat(64),
            matchingClaims: [{
              claimId: "claim-existing-result",
              type: "result",
              section: "Main results",
              text: "A verified result candidate from the existing paper.",
              verificationStatus: "evidence_verified",
              artifactRevision: 2,
              artifactSha256: "a".repeat(64),
              rank: 0.125,
              evidence: [{ evidenceId: "E1", locator: "PDF p. 4" }],
            }],
          }],
          screeningMethod: "fts5_bm25_review_packet_v2",
          screeningIndexFingerprint: "f".repeat(64),
          screeningAnchorIds: [packet.candidateSets.researchQuestions[0].id],
        } : {}),
      },
    });
  }
  await writeBytes(path.join(support, "library.json"), jsonBytes({ schemaVersion: 1, nextNumber: count + 1, items }));
  return support;
}

async function appendPoisonPreparedItems(support, firstNumber, lastNumber) {
  const libraryPath = path.join(support, "library.json");
  const library = JSON.parse(await readFile(libraryPath, "utf8"));
  for (let index = firstNumber; index <= lastNumber; index += 1) {
    const jobId = `poison-job-${index}`;
    library.items.push({
      id: `poison-item-${index}`,
      number: index,
      sourceType: "pdf",
      storedFilename: `poison-paper-${index}.pdf`,
      displayTitle: `Poison Paper ${index}`,
      status: "pending_codex",
      revision: 2,
      source: { storageMode: "managed", sha256: "0".repeat(64) },
      preparation: {
        schemaVersion: 1,
        state: "ready",
        jobId,
        sourceRevision: 1,
        resultSha256: "0".repeat(64),
        manifestPath: `Work/LocalPipeline/${jobId}/manifest.json`,
      },
    });
  }
  library.nextNumber = lastNumber + 1;
  await writeFile(libraryPath, jsonBytes(library));
}

async function runBuild(support, extra = []) {
  const { stdout } = await execFileAsync(process.execPath, [
    buildScript,
    "--support-dir", support,
    "--char-budget", "6000",
    "--json",
    ...extra,
  ]);
  return JSON.parse(stdout);
}

function targetSection(kind) {
  return ({
    research_question: "research_question",
    method: "methods",
    result: "main_results",
    limitation: "limitations",
    assumption: "equations_and_conventions",
    equation: "equations_and_conventions",
  })[kind] ?? "project_role";
}

function decisionsFor(batch, batchSha256, { attest = false, sparse = false } = {}) {
  return {
    schemaVersion: "liteverse-curation-decisions-v1",
    batchId: batch.batchId,
    batchSha256,
    papers: batch.papers.map((paper) => {
      const accepted = paper.candidates.slice(0, 1);
      const decisions = paper.candidates.flatMap((candidate, index) => index === 0 ? [{
        candidateId: candidate.candidateId,
        decision: "accept",
        targetSection: targetSection(candidate.kind),
        faithfulParaphrase: `Faithful reviewed paraphrase for ${paper.paperId}.`,
      }] : sparse ? [] : [{
        candidateId: candidate.candidateId,
        decision: "reject",
        reason: "Not a claim needed for this compact knowledge card.",
      }]);
      const result = {
        itemId: paper.itemId,
        itemRevision: paper.itemRevision,
        sourceRevision: paper.sourceRevision,
        paperId: paper.paperId,
        sourceSha256: paper.sourceSha256,
        packetSha256: paper.packetSha256,
        requestedVerificationStatus: attest ? "evidence_verified" : "card_draft",
        decisions,
        ...(sparse ? {
          defaultUnspecifiedDecision: "reject",
          defaultRejectionReason: "Not adopted by this compact scientific review.",
        } : {}),
      };
      if (attest) {
        result.originalPageReview = {
          schemaVersion: "liteverse-original-page-review-v1",
          attested: true,
          reviewer: "Codex test reviewer",
          reviewedAt: "2026-07-21T00:00:00.000Z",
          reviewMethod: "original_pdf_page",
          sourceSha256: paper.sourceSha256,
          packetSha256: paper.packetSha256,
          declaration: "I reviewed the cited original PDF pages against the pinned source hash.",
          candidateIds: accepted.map((candidate) => candidate.candidateId),
          pages: accepted.map((candidate) => ({
            page: candidate.sourceAnchor.page,
            reviewedOriginal: true,
            candidateIds: [candidate.candidateId],
            ...(candidate.sourceAnchor.pageTextSha256
              ? { pageTextSha256: candidate.sourceAnchor.pageTextSha256 }
              : {}),
          })),
        };
      }
      return result;
    }),
  };
}

async function treeHashes(rootPath, ignoredFirstComponent = null) {
  const output = {};
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      if (!prefix && ignoredFirstComponent === entry.name) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else output[relative] = sha256(await readFile(absolute));
    }
  }
  await visit(rootPath);
  return output;
}

test("review-batch builder is deterministic, bounded, v2-anchor aware, and resumable", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-review-build-"));
  try {
    const supportA = await createPreparedSupport(path.join(temporary, "a"));
    const supportB = await createPreparedSupport(path.join(temporary, "b"));
    const first = await runBuild(supportA);
    const second = await runBuild(supportB);
    const resumed = await runBuild(supportA);
    assert.equal(first.paperCount, 5);
    assert.equal(first.batchSha256, second.batchSha256);
    assert.equal(resumed.batchSha256, first.batchSha256);
    assert.equal(resumed.resumed, true);
    const [bytesA, bytesB] = await Promise.all([readFile(first.batchPath), readFile(second.batchPath)]);
    assert.deepEqual(bytesA, bytesB);
    const batch = JSON.parse(bytesA);
    assert.equal(batch.papers.length, 5);
    assert.ok(batch.constraints.candidateCharacters <= batch.constraints.characterBudget);
    assert.ok(batch.papers.every((paper) => paper.candidates.length >= 1));
    assert.equal(batch.guardrails.verifiedClaims, false);
    assert.doesNotMatch(bytesA.toString("utf8"), /faithfulParaphrase|"requestedVerificationStatus"\s*:\s*"evidence_verified"/);
    const v2 = batch.papers.find((paper) => paper.packetSchemaVersion === "liteverse-review-packet-v2");
    assert.ok(v2.candidates.some((candidate) => candidate.candidateId.startsWith("rp2-")));
    assert.ok(v2.candidates.every((candidate) => candidate.sourceAnchor.pageTextSha256));
    assert.ok(v2.candidates.every((candidate) => candidate.sourceAnchor.characterRange.encoding === "utf16"));
    assert.ok(v2.candidates.some((candidate) => candidate.kind === "method"));
    assert.ok(v2.candidates.some((candidate) => candidate.kind === "result"));
    assert.ok(v2.candidates.some((candidate) => candidate.kind === "limitation"));
    assert.ok(v2.navigationAnchors.length >= 1);
    assert.ok(v2.navigationAnchors.every((candidate) => candidate.purpose === "navigation_only"));
    assert.ok(v2.candidates.every((candidate) => !["section", "figure", "table", "citation"].includes(candidate.kind)));
    assert.equal(v2.relationShortlist.routingOnly, true);
    assert.equal(v2.relationShortlist.method, "fts5_bm25_review_packet_v2");
    assert.equal(v2.relationShortlist.indexFingerprint, "f".repeat(64));
    assert.equal(v2.relationShortlist.candidates[0].paperId, "existing-related-paper");
    assert.equal(v2.relationShortlist.candidates[0].rank, 1.23456789);
    assert.equal(v2.relationShortlist.candidates[0].matchingClaims[0].claimId, "claim-existing-result");
    assert.equal(v2.relationShortlist.candidates[0].matchingClaims[0].evidence[0].locator, "PDF p. 4");
    assert.equal(v2.relationShortlist.queryAnchorIds.length, 1);
    assert.ok(v2.candidates.every((candidate) => !candidate.text.endsWith("…")),
      "source-pinned candidate text must never be truncated to satisfy the batch budget");
    assert.ok(batch.papers.flatMap((paper) => paper.candidates).every((candidate) =>
      candidate.status === "provisional" && candidate.purpose === "routing_only"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("review-batch transactions recover a stale lock owned by a dead process", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-review-build-stale-lock-"));
  try {
    const support = await createPreparedSupport(temporary, 5);
    const lockPath = path.join(support, "Planning", "Curator", ".review-batch.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), jsonBytes({
      schemaVersion: 1,
      pid: 2_147_483_647,
      createdAt: "2000-01-01T00:00:00.000Z",
      token: "dead-owner-token",
      operation: "interrupted test transaction",
    }));
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(lockPath, old, old);
    const built = await runBuild(support);
    assert.equal(built.paperCount, 5);
    await assert.rejects(readFile(path.join(lockPath, "owner.json")), /ENOENT/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a 1,000-item queue validates artifacts only for the selected three-to-five-paper batch", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-review-large-queue-"));
  try {
    for (const batchSize of [3, 5]) {
      const support = await createPreparedSupport(path.join(temporary, `batch-${batchSize}`), batchSize);
      // Every entry beyond the requested batch is metadata-valid and eligible,
      // but its manifest and PDF are intentionally absent. The build can
      // succeed only if artifact validation is bounded to
      // eligible.slice(0, maxPapers).
      await appendPoisonPreparedItems(support, batchSize + 1, 1_000);

      const started = process.hrtime.bigint();
      const built = await runBuild(support, ["--max-papers", String(batchSize)]);
      const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1e6;
      const batch = JSON.parse(await readFile(built.batchPath, "utf8"));

      assert.equal(built.paperCount, batchSize);
      assert.deepEqual(batch.papers.map((paper) => paper.itemId),
        Array.from({ length: batchSize }, (_, index) => `item-${index + 1}`));
      assert.equal(batch.papers.some((paper) => paper.itemId.startsWith("poison-item-")), false);
      context.diagnostic(
        `1,000-item metadata queue -> ${batchSize} validated artifacts in ${elapsedMilliseconds.toFixed(1)} ms`,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("application is deterministic, excludes rejections, and writes only Planning/Curator", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-review-apply-"));
  try {
    const supportA = await createPreparedSupport(path.join(temporary, "a"));
    const supportB = await createPreparedSupport(path.join(temporary, "b"));
    const beforeA = await treeHashes(supportA, "Planning");
    const buildA = await runBuild(supportA);
    const buildB = await runBuild(supportB);
    const batchA = JSON.parse(await readFile(buildA.batchPath, "utf8"));
    const batchB = JSON.parse(await readFile(buildB.batchPath, "utf8"));
    assert.deepEqual(batchA, batchB);
    const decisions = decisionsFor(batchA, buildA.batchSha256, { sparse: true });
    const decisionsPathA = path.join(temporary, "decisions-a.json");
    const decisionsPathB = path.join(temporary, "decisions-b.json");
    await Promise.all([writeFile(decisionsPathA, jsonBytes(decisions)), writeFile(decisionsPathB, jsonBytes(decisions))]);
    const [appliedA, appliedB] = await Promise.all([
      execFileAsync(process.execPath, [applyScript, "--support-dir", supportA, "--batch", buildA.batchPath, "--decisions", decisionsPathA, "--json"]),
      execFileAsync(process.execPath, [applyScript, "--support-dir", supportB, "--batch", buildB.batchPath, "--decisions", decisionsPathB, "--json"]),
    ]);
    const resultA = JSON.parse(appliedA.stdout);
    const resultB = JSON.parse(appliedB.stdout);
    const repeated = JSON.parse((await execFileAsync(process.execPath, [
      applyScript, "--support-dir", supportA, "--batch", buildA.batchPath, "--decisions", decisionsPathA, "--json",
    ])).stdout);
    assert.equal(repeated.resumed, true);
    assert.equal(repeated.resultManifestSha256, resultA.resultManifestSha256);
    const manifestA = JSON.parse(await readFile(resultA.manifestPath, "utf8"));
    const manifestB = JSON.parse(await readFile(resultB.manifestPath, "utf8"));
    assert.deepEqual(manifestA, manifestB);
    for (const output of manifestA.outputs) {
      assert.equal(output.verificationStatus, "card_draft");
      assert.equal(output.acceptedCount, 1);
      assert.ok(output.rejectedCount >= 1);
      const card = await readFile(path.join(resultA.resultDirectory, output.cardPath), "utf8");
      assert.match(card, /Faithful reviewed paraphrase/);
      assert.doesNotMatch(card, /Not a claim needed/);
    }
    assert.deepEqual(await treeHashes(supportA, "Planning"), beforeA);
    for (const forbidden of ["Graph", "Usage", "Projects", "Memory"]) {
      assert.equal((await readdir(supportA)).includes(forbidden), false);
    }
    const checkpoint = JSON.parse(await readFile(path.join(supportA, "Planning", "Curator", "review-batches", "checkpoint.json"), "utf8"));
    assert.equal(checkpoint.activeBatch, null);
    assert.deepEqual(checkpoint.completedItemIds, batchA.papers.map((paper) => paper.itemId).sort());
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("stale hashes and incomplete verification attestations fail closed", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-review-stale-"));
  try {
    const support = await createPreparedSupport(temporary);
    const built = await runBuild(support);
    const batch = JSON.parse(await readFile(built.batchPath, "utf8"));
    const decisions = decisionsFor(batch, built.batchSha256, { attest: true });
    delete decisions.papers[0].originalPageReview.pages[0].reviewedOriginal;
    const badAttestationPath = path.join(temporary, "bad-attestation.json");
    await writeFile(badAttestationPath, jsonBytes(decisions));
    await assert.rejects(
      execFileAsync(process.execPath, [applyScript, "--support-dir", support, "--batch", built.batchPath, "--decisions", badAttestationPath]),
      /must attest a positive original PDF page/,
    );
    assert.equal((await readdir(path.join(support, "Planning", "Curator"))).includes("review-results"), false);

    const valid = decisionsFor(batch, built.batchSha256, { attest: true });
    const validPath = path.join(temporary, "valid.json");
    await writeFile(validPath, jsonBytes(valid));
    const applied = JSON.parse((await execFileAsync(process.execPath, [
      applyScript, "--support-dir", support, "--batch", built.batchPath, "--decisions", validPath, "--json",
    ])).stdout);
    const resultManifest = JSON.parse(await readFile(applied.manifestPath, "utf8"));
    assert.ok(resultManifest.outputs.every((output) => output.verificationStatus === "evidence_verified"));

    const staleSupport = await createPreparedSupport(path.join(temporary, "stale"));
    const staleBuild = await runBuild(staleSupport);
    const staleBatch = JSON.parse(await readFile(staleBuild.batchPath, "utf8"));
    const staleDecisionsPath = path.join(temporary, "stale-decisions.json");
    await writeFile(staleDecisionsPath, jsonBytes(decisionsFor(staleBatch, staleBuild.batchSha256)));
    await writeFile(path.join(staleSupport, "Work", "LocalPipeline", "job-1", "review-packet.json"), "{}\n");
    await assert.rejects(
      execFileAsync(process.execPath, [applyScript, "--support-dir", staleSupport, "--batch", staleBuild.batchPath, "--decisions", staleDecisionsPath]),
      /review_packet output hash mismatch/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
