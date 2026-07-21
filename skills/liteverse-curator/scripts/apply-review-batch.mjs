#!/usr/bin/env node
import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  ATTESTATION_SCHEMA,
  atomicWriteJson,
  atomicWriteText,
  BATCH_SCHEMA,
  CHECKPOINT_SCHEMA,
  DECISION_SCHEMA,
  fail,
  fileSha,
  loadPreparedItem,
  nonempty,
  object,
  preparedPin,
  readJsonBytes,
  readOptionalJson,
  RESULT_SCHEMA,
  sha256,
  stableJson,
  withPlanningLock,
} from "./_review-batch-common.mjs";

const declaration = "I reviewed the cited original PDF pages against the pinned source hash.";
const sectionNames = new Map([
  ["research_question", "Research question"],
  ["methods", "Methods"],
  ["equations_and_conventions", "Equations and conventions"],
  ["main_results", "Main results"],
  ["limitations", "Limitations"],
  ["project_role", "Project role"],
]);

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  console.log(`Usage: apply-review-batch.mjs --batch BATCH.json --decisions DECISIONS.json
       [--support-dir DIR] [--json]

Fail-closed application of source- and packet-pinned accept/qualify/reject
decisions. Writes deterministic drafts and an evidence index only below
Planning/Curator; it never writes Graph, Usage, or project Memory.`);
}

function exactPins(paper, decision, label) {
  for (const key of ["itemId", "itemRevision", "sourceRevision", "paperId", "sourceSha256", "packetSha256"]) {
    if (decision[key] !== paper[key]) fail(`${label}.${key} does not match the batch pin`);
  }
}

function validateAttestation(raw, paper, acceptedCandidates, label) {
  const attestation = object(raw, `${label}.originalPageReview`);
  if (attestation.schemaVersion !== ATTESTATION_SCHEMA
      || attestation.attested !== true
      || attestation.reviewMethod !== "original_pdf_page"
      || attestation.declaration !== declaration) {
    fail(`${label}.originalPageReview is not an explicit original-page-review attestation`);
  }
  nonempty(attestation.reviewer, `${label}.originalPageReview.reviewer`);
  const reviewedAt = nonempty(attestation.reviewedAt, `${label}.originalPageReview.reviewedAt`);
  if (!Number.isFinite(Date.parse(reviewedAt))) fail(`${label}.originalPageReview.reviewedAt is not ISO-8601`);
  if (attestation.sourceSha256 !== paper.sourceSha256 || attestation.packetSha256 !== paper.packetSha256) {
    fail(`${label}.originalPageReview source or packet hash is stale`);
  }
  const expectedIds = acceptedCandidates.map((candidate) => candidate.candidateId).sort();
  if (!Array.isArray(attestation.candidateIds)
      || stableJson([...attestation.candidateIds].sort()) !== stableJson(expectedIds)) {
    fail(`${label}.originalPageReview.candidateIds must exactly cover accepted and qualified candidates`);
  }
  if (!Array.isArray(attestation.pages) || attestation.pages.length === 0) {
    fail(`${label}.originalPageReview.pages must be a non-empty array`);
  }
  const covered = new Set();
  for (const [index, rawPage] of attestation.pages.entries()) {
    const pageReview = object(rawPage, `${label}.originalPageReview.pages[${index}]`);
    if (!Number.isInteger(pageReview.page) || pageReview.page < 1 || pageReview.reviewedOriginal !== true) {
      fail(`${label}.originalPageReview.pages[${index}] must attest a positive original PDF page`);
    }
    if (!Array.isArray(pageReview.candidateIds) || pageReview.candidateIds.length === 0) {
      fail(`${label}.originalPageReview.pages[${index}].candidateIds must be non-empty`);
    }
    for (const candidateId of pageReview.candidateIds) {
      const candidate = acceptedCandidates.find((item) => item.candidateId === candidateId);
      if (!candidate || candidate.sourceAnchor.page !== pageReview.page) {
        fail(`${label}.originalPageReview page coverage does not match candidate ${candidateId}`);
      }
      const pageHash = candidate.sourceAnchor.pageTextSha256;
      if (pageHash && pageReview.pageTextSha256 !== pageHash) {
        fail(`${label}.originalPageReview page text hash is stale for ${candidateId}`);
      }
      if (covered.has(candidateId)) fail(`${label}.originalPageReview covers candidate ${candidateId} more than once`);
      covered.add(candidateId);
    }
  }
  if (stableJson([...covered].sort()) !== stableJson(expectedIds)) {
    fail(`${label}.originalPageReview.pages do not cover every accepted or qualified candidate`);
  }
  return {
    schemaVersion: ATTESTATION_SCHEMA,
    reviewer: attestation.reviewer.trim(),
    reviewedAt,
    reviewMethod: "original_pdf_page",
    sourceSha256: paper.sourceSha256,
    packetSha256: paper.packetSha256,
    declaration,
    candidateIds: expectedIds,
    pages: attestation.pages.map((pageReview) => ({
      page: pageReview.page,
      reviewedOriginal: true,
      candidateIds: [...pageReview.candidateIds].sort(),
      ...(pageReview.pageTextSha256 ? { pageTextSha256: pageReview.pageTextSha256 } : {}),
    })).sort((left, right) => left.page - right.page || left.candidateIds.join().localeCompare(right.candidateIds.join())),
  };
}

function validatePaperDecisions(paper, raw, label) {
  const paperDecision = object(raw, label);
  exactPins(paper, paperDecision, label);
  if (!Array.isArray(paperDecision.decisions)) fail(`${label}.decisions must be an array`);
  const candidates = new Map(paper.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const decisions = new Map();
  for (const [index, rawDecision] of paperDecision.decisions.entries()) {
    const decision = object(rawDecision, `${label}.decisions[${index}]`);
    const candidateId = nonempty(decision.candidateId, `${label}.decisions[${index}].candidateId`);
    if (!candidates.has(candidateId)) fail(`${label}.decisions[${index}] references an unknown candidate`);
    if (decisions.has(candidateId)) fail(`${label}.decisions contains duplicate candidate ${candidateId}`);
    if (!["accept", "qualify", "reject"].includes(decision.decision)) {
      fail(`${label}.decisions[${index}].decision must be accept, qualify, or reject`);
    }
    if (decision.decision === "reject") {
      nonempty(decision.reason, `${label}.decisions[${index}].reason`);
      decisions.set(candidateId, { candidateId, decision: "reject", reason: decision.reason.trim() });
      continue;
    }
    const targetSection = nonempty(decision.targetSection, `${label}.decisions[${index}].targetSection`);
    if (!sectionNames.has(targetSection)) fail(`${label}.decisions[${index}].targetSection is unsupported`);
    const faithfulParaphrase = nonempty(decision.faithfulParaphrase, `${label}.decisions[${index}].faithfulParaphrase`);
    if (/\[E\d+\]/.test(faithfulParaphrase)) fail(`${label}.decisions[${index}] must not hand-author evidence IDs`);
    let qualification = null;
    if (decision.decision === "qualify") qualification = nonempty(decision.qualification, `${label}.decisions[${index}].qualification`);
    decisions.set(candidateId, {
      candidateId,
      decision: decision.decision,
      targetSection,
      faithfulParaphrase,
      qualification,
    });
  }
  const defaultDecision = paperDecision.defaultUnspecifiedDecision;
  if (defaultDecision !== undefined && defaultDecision !== "reject") {
    fail(`${label}.defaultUnspecifiedDecision may only be reject`);
  }
  const missingIds = [...candidates.keys()].filter((candidateId) => !decisions.has(candidateId));
  if (missingIds.length > 0 && defaultDecision === "reject") {
    const reason = nonempty(paperDecision.defaultRejectionReason, `${label}.defaultRejectionReason`);
    for (const candidateId of missingIds) {
      decisions.set(candidateId, { candidateId, decision: "reject", reason });
    }
  }
  const expectedIds = [...candidates.keys()].sort();
  if (stableJson([...decisions.keys()].sort()) !== stableJson(expectedIds)) {
    fail(`${label}.decisions must contain exactly one decision for every routing candidate`);
  }
  const acceptedCandidates = paper.candidates.filter((candidate) => decisions.get(candidate.candidateId).decision !== "reject");
  const requestedStatus = paperDecision.requestedVerificationStatus ?? "card_draft";
  if (!["card_draft", "evidence_verified"].includes(requestedStatus)) fail(`${label}.requestedVerificationStatus is unsupported`);
  let attestation = null;
  if (paperDecision.originalPageReview !== undefined) {
    attestation = validateAttestation(paperDecision.originalPageReview, paper, acceptedCandidates, label);
  }
  if (requestedStatus === "evidence_verified") {
    if (acceptedCandidates.length === 0) fail(`${label} cannot verify a card with no accepted evidence`);
    if (!attestation) fail(`${label} requested evidence_verified without an original-page-review attestation`);
  }
  return {
    paperDecision,
    decisions,
    acceptedCandidates,
    verificationStatus: requestedStatus === "evidence_verified" ? "evidence_verified" : "card_draft",
    attestation,
  };
}

function evidenceFor(paper, validated) {
  const evidence = [];
  for (const candidate of paper.candidates) {
    const decision = validated.decisions.get(candidate.candidateId);
    if (decision.decision === "reject") continue;
    const id = `E${evidence.length + 1}`;
    evidence.push({
      id,
      candidateId: candidate.candidateId,
      decision: decision.decision,
      targetSection: decision.targetSection,
      faithfulParaphrase: decision.faithfulParaphrase,
      qualification: decision.qualification,
      locator: candidate.sourceAnchor.locator,
      page: candidate.sourceAnchor.page,
      section: candidate.sourceAnchor.section,
      pageTextSha256: candidate.sourceAnchor.pageTextSha256,
      characterRange: candidate.sourceAnchor.characterRange,
      sourceExcerpt: candidate.text,
      originalPageAttested: validated.verificationStatus === "evidence_verified",
    });
  }
  return evidence;
}

function yaml(value) {
  return JSON.stringify(value);
}

function renderCard(paper, validated, evidence, batch) {
  const lines = [
    "---",
    `paper_id: ${yaml(paper.paperId)}`,
    `title: ${yaml(paper.title)}`,
    `authors: ${yaml(paper.authors)}`,
    `source_sha256: ${yaml(paper.sourceSha256)}`,
    `verification_status: ${yaml(validated.verificationStatus)}`,
    `metadata_status: ${yaml(paper.metadataStatus)}`,
    `library_item_id: ${yaml(paper.itemId)}`,
    `library_item_revision: ${paper.itemRevision}`,
    `local_preparation_source_revision: ${paper.sourceRevision}`,
    `review_packet_sha256: ${yaml(paper.packetSha256)}`,
    `curation_batch_id: ${yaml(batch.batchId)}`,
    "---",
    "",
    `# ${paper.title}`,
    "",
  ];
  for (const [key, title] of sectionNames) {
    lines.push(`## ${title}`, "");
    const sectionEvidence = evidence.filter((entry) => entry.targetSection === key);
    if (sectionEvidence.length === 0) {
      lines.push(validated.verificationStatus === "evidence_verified"
        ? "_No reviewed claim was accepted for this section._"
        : "- TODO: requires scientific review against the original PDF.", "");
      continue;
    }
    for (const entry of sectionEvidence) {
      const qualification = entry.qualification ? ` Qualification: ${entry.qualification}` : "";
      lines.push(`- ${entry.faithfulParaphrase}${qualification} [${entry.id}]`);
    }
    lines.push("");
  }
  lines.push("## Evidence index", "");
  if (evidence.length === 0) lines.push("- TODO: no routing candidate was accepted.");
  else {
    for (const entry of evidence) {
      const qualification = entry.qualification ? ` Qualification: ${entry.qualification}` : "";
      lines.push(`- ${entry.id} — ${entry.locator} — ${entry.faithfulParaphrase}${qualification}`);
    }
  }
  lines.push("", "## Annotation provenance", "", "- No handwritten annotation was integrated by this review batch.", "");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

async function validateLivePins(support, batch, itemById) {
  for (const paper of batch.papers) {
    const item = itemById.get(paper.itemId);
    if (!item) fail(`batch item ${paper.itemId} is no longer in library.json`);
    const live = await loadPreparedItem(support, item);
    const expected = preparedPin(live);
    const pinned = Object.fromEntries(Object.keys(expected).map((key) => [key, paper[key]]));
    if (stableJson(expected) !== stableJson(pinned)) fail(`batch item ${paper.itemId} is stale`);
  }
}

async function checkpointState(planningRoot, batch, batchSha256) {
  const checkpointPath = path.join(planningRoot, "review-batches", "checkpoint.json");
  const checkpoint = object(await readOptionalJson(checkpointPath, null, "review-batch checkpoint"), "review-batch checkpoint");
  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA || !Array.isArray(checkpoint.completedItemIds)) {
    fail("review-batch checkpoint is malformed");
  }
  if (checkpoint.activeBatch?.batchId === batch.batchId && checkpoint.activeBatch?.batchSha256 === batchSha256) {
    return { checkpoint, checkpointPath, state: "active" };
  }
  const completed = new Set(checkpoint.completedItemIds);
  if (checkpoint.activeBatch === null && batch.papers.every((paper) => completed.has(paper.itemId))) {
    return { checkpoint, checkpointPath, state: "completed" };
  }
  fail("review-batch checkpoint no longer owns this batch");
}

async function completeCheckpoint(planningRoot, batch, batchSha256) {
  const state = await checkpointState(planningRoot, batch, batchSha256);
  if (state.state === "completed") return;
  const { checkpoint, checkpointPath } = state;
  const completed = new Set(checkpoint.completedItemIds ?? []);
  for (const paper of batch.papers) completed.add(paper.itemId);
  await atomicWriteJson(checkpointPath, {
    schemaVersion: CHECKPOINT_SCHEMA,
    completedItemIds: [...completed].sort(),
    activeBatch: null,
  });
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const batchArgument = argument("--batch");
  const decisionsArgument = argument("--decisions");
  if (!batchArgument || !decisionsArgument) fail("--batch and --decisions are required");
  const support = path.resolve(
    argument("--support-dir")
      ?? process.env.LITEVERSE_SUPPORT_DIR
      ?? path.join(homedir(), "Library", "Application Support", "Liteverse"),
  );
  const batchPath = path.resolve(batchArgument);
  const decisionsPath = path.resolve(decisionsArgument);
  const batchRead = await readJsonBytes(batchPath, "review batch");
  const batch = object(batchRead.value, "review batch");
  if (batch.schemaVersion !== BATCH_SCHEMA || !Array.isArray(batch.papers) || !batch.batchId) fail("review batch is malformed");
  const expectedBatchPath = path.join(support, "Planning", "Curator", "review-batches", batch.batchId, "batch.json");
  if (batchPath !== expectedBatchPath) fail("review batch must be the active Planning/Curator batch inside the support directory");
  const batchSha256 = sha256(batchRead.bytes);
  const decisionsRead = await readJsonBytes(decisionsPath, "Codex decisions");
  const decisionsInput = object(decisionsRead.value, "Codex decisions");
  const decisionsSha256 = sha256(decisionsRead.bytes);
  if (decisionsInput.schemaVersion !== DECISION_SCHEMA || decisionsInput.batchId !== batch.batchId
      || decisionsInput.batchSha256 !== batchSha256 || !Array.isArray(decisionsInput.papers)) {
    fail("Codex decisions are malformed or pinned to a stale review batch");
  }
  if (decisionsInput.papers.length !== batch.papers.length) fail("Codex decisions must cover every batch paper exactly once");
  const decisionByPaper = new Map();
  for (const raw of decisionsInput.papers) {
    const paperId = nonempty(raw?.paperId, "decision paperId");
    if (decisionByPaper.has(paperId)) fail(`duplicate decisions for paper ${paperId}`);
    decisionByPaper.set(paperId, raw);
  }
  const validated = new Map();
  for (const [index, paper] of batch.papers.entries()) {
    const raw = decisionByPaper.get(paper.paperId);
    if (!raw) fail(`missing decisions for paper ${paper.paperId}`);
    validated.set(paper.paperId, validatePaperDecisions(paper, raw, `papers[${index}]`));
  }

  const library = object((await readJsonBytes(path.join(support, "library.json"), "library.json")).value, "library.json");
  if (!Array.isArray(library.items)) fail("library.json must contain an items array");
  const itemById = new Map(library.items.map((item) => [item.id, item]));
  await validateLivePins(support, batch, itemById);

  const result = await withPlanningLock(support, async (planningRoot) => {
    const ownership = await checkpointState(planningRoot, batch, batchSha256);
    const resultDirectory = path.join(planningRoot, "review-results", batch.batchId);
    const manifestPath = path.join(resultDirectory, "manifest.json");
    try {
      const existing = object((await readJsonBytes(manifestPath, "existing review result manifest")).value, "existing review result manifest");
      if (existing.schemaVersion !== RESULT_SCHEMA || existing.batchSha256 !== batchSha256
          || existing.decisionsSha256 !== decisionsSha256) {
        fail("a conflicting review result already exists for this batch");
      }
      if (ownership.state === "active") await completeCheckpoint(planningRoot, batch, batchSha256);
      return { resultDirectory, manifestPath, resumed: true, manifest: existing };
    } catch (error) {
      if (!/ cannot be read: ENOENT:/.test(error.message)) throw error;
    }

    if (ownership.state !== "active") fail("completed review batch is missing its committed result");
    const transactionId = `apply-${batch.batchId}-${decisionsSha256.slice(0, 16)}`;
    const transactionDirectory = path.join(planningRoot, ".transactions", transactionId);
    const journalPath = path.join(planningRoot, "journals", `${transactionId}.json`);
    await rm(transactionDirectory, { recursive: true, force: true });
    await mkdir(transactionDirectory, { recursive: true });
    await atomicWriteJson(journalPath, {
      schemaVersion: "liteverse-curator-transaction-v1",
      transactionId,
      operation: "apply_review_batch",
      state: "planned",
      batchSha256,
      decisionsSha256,
      writes: [path.relative(support, resultDirectory), path.relative(support, path.join(planningRoot, "review-batches", "checkpoint.json"))],
    });

    const outputs = [];
    for (const paper of batch.papers) {
      const review = validated.get(paper.paperId);
      const evidence = evidenceFor(paper, review);
      const card = renderCard(paper, review, evidence, batch);
      const paperDirectory = path.join(transactionDirectory, "papers", paper.paperId);
      const cardPath = path.join(paperDirectory, "card.md");
      const evidencePath = path.join(paperDirectory, "evidence-index.json");
      await atomicWriteText(cardPath, card);
      await atomicWriteJson(evidencePath, {
        schemaVersion: "liteverse-curation-evidence-index-v1",
        paperId: paper.paperId,
        itemId: paper.itemId,
        itemRevision: paper.itemRevision,
        sourceRevision: paper.sourceRevision,
        sourceSha256: paper.sourceSha256,
        packetSha256: paper.packetSha256,
        verificationStatus: review.verificationStatus,
        originalPageReview: review.attestation,
        evidence,
        rejectedCandidateIds: paper.candidates
          .filter((candidate) => review.decisions.get(candidate.candidateId).decision === "reject")
          .map((candidate) => candidate.candidateId),
      });
      outputs.push({
        paperId: paper.paperId,
        verificationStatus: review.verificationStatus,
        cardPath: path.join("papers", paper.paperId, "card.md"),
        cardSha256: await fileSha(cardPath),
        evidenceIndexPath: path.join("papers", paper.paperId, "evidence-index.json"),
        evidenceIndexSha256: await fileSha(evidencePath),
        acceptedCount: evidence.length,
        rejectedCount: paper.candidates.length - evidence.length,
      });
    }
    const manifest = {
      schemaVersion: RESULT_SCHEMA,
      batchId: batch.batchId,
      batchSha256,
      decisionsSha256,
      state: "review_results_ready",
      outputs,
      guardrails: {
        writesOnlyPlanningCurator: true,
        writesGraph: false,
        writesUsage: false,
        writesResearchMemory: false,
        automaticEvidencePromotion: false,
      },
    };
    await atomicWriteJson(path.join(transactionDirectory, "manifest.json"), manifest);
    await mkdir(path.dirname(resultDirectory), { recursive: true });
    await rename(transactionDirectory, resultDirectory);
    await completeCheckpoint(planningRoot, batch, batchSha256);
    await atomicWriteJson(journalPath, {
      schemaVersion: "liteverse-curator-transaction-v1",
      transactionId,
      operation: "apply_review_batch",
      state: "committed",
      batchSha256,
      decisionsSha256,
      resultManifestSha256: await fileSha(manifestPath),
      writes: [path.relative(support, resultDirectory), path.relative(support, path.join(planningRoot, "review-batches", "checkpoint.json"))],
    });
    return { resultDirectory, manifestPath, resumed: false, manifest };
  });

  const output = {
    batchId: batch.batchId,
    resultDirectory: result.resultDirectory,
    manifestPath: result.manifestPath,
    resultManifestSha256: await fileSha(result.manifestPath),
    resumed: result.resumed,
    papers: result.manifest.outputs.length,
  };
  console.log(process.argv.includes("--json") ? JSON.stringify(output, null, 2) : `${output.batchId}\n${output.resultDirectory}`);
}

main().catch((error) => {
  console.error(`apply-review-batch: ${error.message}`);
  process.exitCode = 2;
});
