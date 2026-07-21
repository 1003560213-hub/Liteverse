#!/usr/bin/env node
import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  atomicWriteJson,
  atomicWriteText,
  BATCH_SCHEMA,
  fail,
  fileSha,
  loadPreparedAdoptionInputs,
  nonempty,
  object,
  preparedPin,
  readPreparedCatalogFingerprint,
  readJsonBytes,
  readOptionalJson,
  RESULT_SCHEMA,
  sha256,
  sha256Text,
  stableJson,
  withDirectoryLock,
  withPlanningLock,
} from "./_review-batch-common.mjs";

const ADOPTION_SCHEMA = "liteverse-curation-adoption-v1";
const ADOPTION_DECISION_SCHEMA = "liteverse-curation-adoption-decisions-v1";
const EVIDENCE_SCHEMA = "liteverse-curation-evidence-index-v1";
const PAPER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const metadataStates = new Set(["provisional", "official_verified", "source_verified"]);

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argumentsFor(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function usage() {
  console.log(`Usage: adopt-review-results.mjs --result MANIFEST.json [--result MANIFEST.json ...] [options]

Validate one or more committed review results and adopt their source-pinned drafts into
the canonical working Knowledge projection plus a complete unstaged snapshot.
It never writes Graph/current, Graph/staged, Graph/pending-update, Usage, or
project Memory.

Options:
  --support-dir DIR       Liteverse Application Support root
  --assignments FILE      Optional hash-pinned existing-region assignments
  --write-assignment-template
                          Write a pinned editable template, then stop
  --json                  Emit machine-readable output

Without --assignments, every new paper enters the liteverse-staging system
region as provisional. Run finalization, claim generation, relation merge, and
stage-refresh separately against the emitted working snapshot.`);
}

function safeRelative(value, label) {
  const relative = nonempty(value, label);
  if (path.isAbsolute(relative)) fail(`${label} must be relative`);
  const parts = relative.split(/[\\/]+/);
  if (parts.some((part) => !part || part === "." || part === "..")) fail(`${label} is unsafe`);
  return parts.join(path.sep);
}

function inside(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(`${label} escapes ${resolvedRoot}`);
  }
  return resolved;
}

function stripFrontmatter(text) {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? text.slice(match[0].length) : text;
}

function yaml(value) {
  return JSON.stringify(value);
}

function renderCard(paper, reviewedCard, evidence, assignment) {
  const source = paper.source;
  const lines = [
    "---",
    `paper_id: ${yaml(paper.paperId)}`,
    `title: ${yaml(paper.title)}`,
    `authors: ${yaml(paper.authors)}`,
    `metadata_status: ${yaml(paper.metadataStatus)}`,
    `source_type: ${yaml(source.kind)}`,
    `source_storage_mode: ${yaml(source.storageMode)}`,
    `source_pdf_path: ${yaml(source.pdfPath)}`,
    `source_sha256: ${yaml(paper.sourceSha256)}`,
    `arxiv_id: ${yaml(source.arxivId ?? null)}`,
    `doi: ${yaml(source.doi ?? null)}`,
    `pdf_path: ${yaml(source.pdfPath)}`,
    `fulltext_path: ${yaml(`Knowledge/fulltext/${paper.paperId}.md`)}`,
    `extraction_status: ${yaml(paper.extractionStatus)}`,
    `verification_status: ${yaml(evidence.verificationStatus)}`,
    "card_schema_version: liteverse-card-v1",
    `evidence_count: ${evidence.evidence.length}`,
    `library_item_id: ${yaml(paper.itemId)}`,
    `library_item_revision: ${paper.itemRevision}`,
    `local_preparation_source_revision: ${paper.sourceRevision}`,
    `review_packet_sha256: ${yaml(paper.packetSha256)}`,
    `curation_batch_id: ${yaml(evidence.batchId)}`,
    `primary_category: ${yaml(assignment.primaryCategory)}`,
    `secondary_category: ${yaml(assignment.secondaryCategory)}`,
    `classification_status: ${yaml(assignment.classificationStatus)}`,
    `classification_evidence_ids: ${yaml(assignment.evidenceIds)}`,
    `classification_rationale: ${yaml(assignment.rationale)}`,
    `tags: ${yaml(assignment.tags)}`,
    "annotation_revisions: []",
    "---",
    "",
    stripFrontmatter(reviewedCard).trim(),
    "",
  ];
  return lines.join("\n");
}

function renderFulltext(paper, extractedFulltext, verificationStatus) {
  const source = paper.source;
  const lines = [
    "---",
    `paper_id: ${yaml(paper.paperId)}`,
    `title: ${yaml(paper.title)}`,
    `authors: ${yaml(paper.authors)}`,
    `metadata_status: ${yaml(paper.metadataStatus)}`,
    `source_type: ${yaml(source.kind)}`,
    `source_storage_mode: ${yaml(source.storageMode)}`,
    `source_pdf_path: ${yaml(source.pdfPath)}`,
    `source_sha256: ${yaml(paper.sourceSha256)}`,
    `arxiv_id: ${yaml(source.arxivId ?? null)}`,
    `doi: ${yaml(source.doi ?? null)}`,
    `extraction_status: ${yaml(paper.extractionStatus)}`,
    `verification_status: ${yaml(verificationStatus)}`,
    `library_item_id: ${yaml(paper.itemId)}`,
    `library_item_revision: ${paper.itemRevision}`,
    "annotation_revisions: []",
    "---",
    "",
    stripFrontmatter(extractedFulltext).trim(),
    "",
  ];
  return lines.join("\n");
}

async function regularPinnedFile(root, relative, expectedSha, label) {
  const filePath = inside(root, path.join(root, safeRelative(relative, `${label}.path`)), `${label}.path`);
  const [rootReal, fileReal, info] = await Promise.all([realpath(root), realpath(filePath), lstat(filePath)]);
  inside(rootReal, fileReal, `${label} real path`);
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} must be a regular, non-symlink file`);
  if (!SHA256.test(expectedSha ?? "") || await fileSha(filePath) !== expectedSha) fail(`${label} hash mismatch`);
  return filePath;
}

async function readResult(support, resultPath) {
  const resultRead = await readJsonBytes(resultPath, "review result manifest");
  const result = object(resultRead.value, "review result manifest");
  if (result.schemaVersion !== RESULT_SCHEMA || result.state !== "review_results_ready" || !Array.isArray(result.outputs)) {
    fail("review result manifest is malformed or unsupported");
  }
  const expectedResult = path.join(support, "Planning", "Curator", "review-results", result.batchId, "manifest.json");
  if (resultPath !== expectedResult) fail("--result must be a committed Planning/Curator review result manifest");
  const resultRoot = path.dirname(resultPath);
  const batchPath = path.join(support, "Planning", "Curator", "review-batches", result.batchId, "batch.json");
  const batchRead = await readJsonBytes(batchPath, "review batch");
  const batch = object(batchRead.value, "review batch");
  if (batch.schemaVersion !== BATCH_SCHEMA || batch.batchId !== result.batchId || sha256(batchRead.bytes) !== result.batchSha256) {
    fail("review result is not pinned to the committed review batch");
  }
  if (!Array.isArray(batch.papers) || result.outputs.length !== batch.papers.length) {
    fail("review result must cover every batch paper exactly once");
  }
  const outputByPaper = new Map();
  for (const raw of result.outputs) {
    const output = object(raw, "review result output");
    const paperId = nonempty(output.paperId, "review result output.paperId");
    if (outputByPaper.has(paperId)) fail(`duplicate review result output for ${paperId}`);
    const cardPath = await regularPinnedFile(resultRoot, output.cardPath, output.cardSha256, `review result ${paperId} card`);
    const evidencePath = await regularPinnedFile(
      resultRoot,
      output.evidenceIndexPath,
      output.evidenceIndexSha256,
      `review result ${paperId} evidence`,
    );
    const evidence = object((await readJsonBytes(evidencePath, `review result ${paperId} evidence`)).value, `review result ${paperId} evidence`);
    if (evidence.schemaVersion !== EVIDENCE_SCHEMA || evidence.paperId !== paperId
        || evidence.verificationStatus !== output.verificationStatus || !Array.isArray(evidence.evidence)) {
      fail(`review result ${paperId} evidence index is malformed`);
    }
    if (evidence.evidence.length !== output.acceptedCount) fail(`review result ${paperId} accepted count mismatch`);
    for (const [index, entry] of evidence.evidence.entries()) {
      if (entry?.id !== `E${index + 1}` || typeof entry.faithfulParaphrase !== "string" || !entry.faithfulParaphrase.trim()) {
        fail(`review result ${paperId} evidence IDs or paraphrases are invalid`);
      }
    }
    if (output.verificationStatus === "evidence_verified" && evidence.originalPageReview?.attested !== true) {
      fail(`review result ${paperId} lacks its original-page attestation`);
    }
    outputByPaper.set(paperId, { output, cardPath, evidencePath, evidence });
  }
  for (const paper of batch.papers) {
    const reviewed = outputByPaper.get(paper.paperId);
    if (!reviewed) fail(`review result is missing ${paper.paperId}`);
    for (const key of ["itemId", "itemRevision", "sourceRevision", "paperId", "sourceSha256", "packetSha256"]) {
      if (reviewed.evidence[key] !== paper[key]) fail(`review result ${paper.paperId} ${key} is stale`);
    }
    reviewed.evidence.batchId = batch.batchId;
  }
  return {
    result,
    resultSha256: sha256(resultRead.bytes),
    batch,
    batchSha256: sha256(batchRead.bytes),
    outputByPaper,
  };
}

function combineResults(contexts) {
  const ordered = [...contexts].sort((left, right) => left.batch.batchId.localeCompare(right.batch.batchId));
  const batchPins = ordered.map((context) => ({
    batchId: context.batch.batchId,
    batchSha256: context.batchSha256,
    resultManifestSha256: context.resultSha256,
  }));
  const adoptionId = `adoption-${sha256Text(stableJson(batchPins)).slice(0, 24)}`;
  const papers = [];
  const outputByPaper = new Map();
  const itemIds = new Set();
  for (const context of ordered) {
    for (const paper of context.batch.papers) {
      if (outputByPaper.has(paper.paperId) || itemIds.has(paper.itemId)) {
        fail(`review-result set repeats paper ${paper.paperId} or item ${paper.itemId}`);
      }
      papers.push(paper);
      outputByPaper.set(paper.paperId, context.outputByPaper.get(paper.paperId));
      itemIds.add(paper.itemId);
    }
  }
  return {
    contexts: ordered,
    batchPins,
    adoptionId,
    batch: { batchId: adoptionId, papers },
    batchSha256: sha256Text(stableJson(batchPins.map(({ batchId, batchSha256 }) => ({ batchId, batchSha256 })))),
    resultSha256: sha256Text(stableJson(batchPins.map(({ batchId, resultManifestSha256 }) => ({ batchId, resultManifestSha256 })))),
    outputByPaper,
  };
}

async function assertCompletePreparationWaves(support, library, prepared) {
  const includedItemIds = new Set(prepared.map((paper) => paper.itemId));
  const includedFingerprints = new Set(prepared.map((paper) => paper.catalogFingerprint));
  const omitted = [];
  for (const item of library.items) {
    if (includedItemIds.has(item?.id)) continue;
    if (!["pending_codex", "processing"].includes(item?.status)
        || item?.preparation?.schemaVersion !== 1 || item?.preparation?.state !== "ready") continue;
    const fingerprint = await readPreparedCatalogFingerprint(support, item);
    if (fingerprint !== null && includedFingerprints.has(fingerprint)) omitted.push(item.id);
  }
  if (omitted.length) {
    omitted.sort();
    fail(`adoption omits ${omitted.length} reviewable item(s) from the same preparation wave: ${omitted.slice(0, 12).join(", ")}${omitted.length > 12 ? ", …" : ""}; build and apply every same-catalog batch, then adopt all result manifests together`);
  }
}

function normalizedTags(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function arxivBase(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en-US").replace(/v\d+$/i, "");
}

function doiKey(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en-US").replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
}

function identityKeys(paper) {
  return {
    sha256: paper.sourceSha256 ?? paper.sha256 ?? paper.source?.sha256 ?? null,
    arxiv: arxivBase(paper.source?.arxivId ?? paper.arxivId),
    doi: doiKey(paper.source?.doi ?? paper.doi),
  };
}

function assertNoDuplicatePrepared(prepared, indexedPapers) {
  const seen = new Map();
  const consider = (paper, existing = false) => {
    const keys = identityKeys(paper);
    for (const [kind, value] of Object.entries(keys)) {
      if (!value) continue;
      const key = `${kind}:${value}`;
      const previous = seen.get(key);
      if (previous && previous.paperId !== paper.paperId) {
        fail(`paper ${paper.paperId} conflicts with ${previous.paperId} by ${kind}; resolve the duplicate before adoption`);
      }
      seen.set(key, { paperId: paper.paperId, existing });
    }
  };
  for (const paper of indexedPapers) consider({
    ...paper,
    paperId: paper.paperId ?? paper.id,
    sourceSha256: paper.source?.sha256 ?? paper.sha256,
  }, true);
  for (const paper of prepared) consider(paper, false);
}

async function assignmentsFor(filePath, context, current, reviewedByPaper) {
  const categories = new Map(current.categories.map((category) => [category.id, category]));
  const fallback = new Map(context.batch.papers.map((paper) => [paper.paperId, {
    paperId: paper.paperId,
    primaryCategory: "liteverse-staging",
    secondaryCategory: null,
    classificationStatus: "provisional",
    rationale: "Awaiting scientific macro-region confirmation.",
    evidenceIds: [],
    tags: [],
  }]));
  if (!filePath) return { assignments: fallback, decisionSha256: null };
  const decisionRead = await readJsonBytes(filePath, "adoption assignments");
  const decision = object(decisionRead.value, "adoption assignments");
  if (decision.schemaVersion !== ADOPTION_DECISION_SCHEMA
      || decision.batchId !== context.batch.batchId
      || decision.batchSha256 !== context.batchSha256
      || decision.resultManifestSha256 !== context.resultSha256
      || decision.baseRevision !== current.revision
      || decision.baseGraphSha256 !== current.__sha256) {
    fail("adoption assignments are malformed or pinned to stale inputs");
  }
  if (!Array.isArray(decision.papers) || decision.papers.length !== context.batch.papers.length) {
    fail("adoption assignments must cover every batch paper exactly once");
  }
  const values = new Map();
  for (const raw of decision.papers) {
    const value = object(raw, "adoption paper assignment");
    const paper = context.batch.papers.find((candidate) => candidate.paperId === value.paperId);
    if (!paper || values.has(value.paperId)) fail(`unknown or duplicate adoption assignment ${value.paperId ?? "<missing>"}`);
    for (const key of ["itemId", "itemRevision", "sourceRevision", "paperId", "sourceSha256", "packetSha256"]) {
      if (value[key] !== paper[key]) fail(`adoption assignment ${paper.paperId} ${key} is stale`);
    }
    const primary = nonempty(value.primaryCategory, `adoption assignment ${paper.paperId}.primaryCategory`);
    const primaryCategory = categories.get(primary);
    if (!primaryCategory && primary !== "liteverse-staging") fail(`adoption assignment ${paper.paperId} uses an unknown primary category`);
    const secondary = value.secondaryCategory ?? null;
    if (secondary !== null && (!categories.has(secondary) || secondary === primary)) {
      fail(`adoption assignment ${paper.paperId} has an invalid secondary category`);
    }
    const status = value.classificationStatus ?? "provisional";
    if (!new Set(["classified", "provisional"]).has(status)) fail(`adoption assignment ${paper.paperId} has an invalid status`);
    const evidenceIds = Array.isArray(value.evidenceIds) ? [...new Set(value.evidenceIds)].sort() : fail(`adoption assignment ${paper.paperId}.evidenceIds must be an array`);
    const reviewedIds = new Set(reviewedByPaper.get(paper.paperId).evidence.evidence.map((entry) => entry.id));
    if (evidenceIds.some((id) => typeof id !== "string" || !reviewedIds.has(id))) {
      fail(`adoption assignment ${paper.paperId} references unreviewed evidence`);
    }
    if (status === "classified") {
      if (!primaryCategory || primaryCategory.kind === "system" || reviewedByPaper.get(paper.paperId).evidence.verificationStatus !== "evidence_verified" || evidenceIds.length === 0) {
        fail(`classified adoption assignment ${paper.paperId} requires an existing macro region and verified evidence`);
      }
    }
    values.set(paper.paperId, {
      paperId: paper.paperId,
      primaryCategory: primary,
      secondaryCategory: secondary,
      classificationStatus: status,
      rationale: nonempty(value.rationale, `adoption assignment ${paper.paperId}.rationale`),
      evidenceIds,
      tags: normalizedTags(value.tags, `adoption assignment ${paper.paperId}.tags`),
    });
  }
  return { assignments: values, decisionSha256: sha256(decisionRead.bytes) };
}

function stablePosition(category, paperId, ordinal) {
  const center = Array.isArray(category?.center) && category.center.length === 3
    && category.center.every(Number.isFinite) ? category.center : [0, 0, 0];
  const digest = Buffer.from(sha256Text(`liteverse-adoption-position-v1\u001f${paperId}`), "hex");
  const angle = (digest.readUInt32BE(0) / 0xffffffff) * Math.PI * 2;
  const radius = 0.34 + (digest.readUInt16BE(4) / 0xffff) * 0.22 + ordinal * 0.018;
  const depth = ((digest.readUInt16BE(6) / 0xffff) - 0.5) * 0.42;
  return [
    Number((center[0] + Math.cos(angle) * radius).toFixed(6)),
    Number((center[1] + Math.sin(angle) * radius * 0.72).toFixed(6)),
    Number((center[2] + depth).toFixed(6)),
  ];
}

async function directorySync(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function installExact(stagedPath, targetPath, expectedSha, label) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    const info = await lstat(targetPath);
    if (info.isSymbolicLink() || !info.isFile()) fail(`${label} target is not a regular file`);
    if (await fileSha(targetPath) !== expectedSha) fail(`${label} conflicts with an existing canonical file`);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await link(stagedPath, targetPath);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (await fileSha(targetPath) !== expectedSha) fail(`${label} raced with a conflicting canonical file`);
    return false;
  }
  await directorySync(path.dirname(targetPath));
  return true;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) return usage();
  const resultArguments = argumentsFor("--result");
  if (!resultArguments.length) fail("at least one --result is required");
  const support = path.resolve(
    argument("--support-dir")
      ?? process.env.LITEVERSE_SUPPORT_DIR
      ?? path.join(homedir(), "Library", "Application Support", "Liteverse"),
  );
  const contexts = [];
  for (const resultArgument of resultArguments) {
    contexts.push(await readResult(support, path.resolve(resultArgument)));
  }
  const context = combineResults(contexts);
  const currentPath = path.join(support, "Graph", "current.json");
  const currentRead = await readJsonBytes(currentPath, "Graph/current.json");
  const current = object(currentRead.value, "Graph/current.json");
  current.__sha256 = sha256(currentRead.bytes);
  if (current.schemaVersion !== "3.0.0" || !Number.isInteger(current.revision)
      || !Array.isArray(current.categories) || !Array.isArray(current.papers) || !Array.isArray(current.relations)) {
    fail("adoption requires a complete schema-v3 current graph");
  }
  try {
    await stat(path.join(support, "Graph", "pending-update.json"));
    fail("commit or discard the existing pending Refresh before adopting another batch");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const libraryPath = path.join(support, "library.json");
  const libraryRead = await readJsonBytes(libraryPath, "library.json");
  const library = object(libraryRead.value, "library.json");
  const librarySha256 = sha256(libraryRead.bytes);
  if (!Array.isArray(library.items)) fail("library.json must contain an items array");
  const itemById = new Map(library.items.map((item) => [item.id, item]));
  const prepared = [];
  for (const paper of context.batch.papers) {
    const item = itemById.get(paper.itemId);
    if (!item) fail(`batch item ${paper.itemId} is no longer present`);
    // Adoption performs a fresh strict duplicate screen below, so a catalog
    // revision advanced by an earlier committed adoption does not force PDF
    // extraction to run again.
    const live = await loadPreparedAdoptionInputs(support, item, { allowCatalogDrift: true });
    const expected = preparedPin(live);
    const pinned = Object.fromEntries(Object.keys(expected).map((key) => [key, paper[key]]));
    if (stableJson(expected) !== stableJson(pinned)) fail(`batch item ${paper.itemId} is stale`);
    if (!PAPER_ID.test(live.paperId)) fail(`paper ID ${live.paperId} is unsafe`);
    if (!live.authors.length) fail(`paper ${live.paperId} requires at least one source-checked author before adoption`);
    if (!metadataStates.has(live.metadataStatus)) fail(`paper ${live.paperId} has unsupported metadata status`);
    prepared.push(live);
  }
  await assertCompletePreparationWaves(support, library, prepared);
  if (process.argv.includes("--write-assignment-template")) {
    const templatePath = await withPlanningLock(support, async (planningRoot) => {
      const outputPath = path.join(planningRoot, "adoption-templates", `${context.adoptionId}.json`);
      await atomicWriteJson(outputPath, {
        schemaVersion: ADOPTION_DECISION_SCHEMA,
        batchId: context.adoptionId,
        batchSha256: context.batchSha256,
        resultManifestSha256: context.resultSha256,
        baseRevision: current.revision,
        baseGraphSha256: current.__sha256,
        papers: context.batch.papers.map((paper) => ({
          itemId: paper.itemId,
          itemRevision: paper.itemRevision,
          sourceRevision: paper.sourceRevision,
          paperId: paper.paperId,
          sourceSha256: paper.sourceSha256,
          packetSha256: paper.packetSha256,
          primaryCategory: "liteverse-staging",
          secondaryCategory: null,
          classificationStatus: "provisional",
          rationale: "Awaiting scientific macro-region confirmation.",
          evidenceIds: context.outputByPaper.get(paper.paperId).evidence.evidence.map((entry) => entry.id),
          tags: [],
        })),
      });
      return outputPath;
    });
    const output = {
      status: "assignment_template_ready",
      adoptionId: context.adoptionId,
      path: templatePath,
      sha256: await fileSha(templatePath),
    };
    console.log(process.argv.includes("--json") ? JSON.stringify(output, null, 2) : templatePath);
    return;
  }
  const reviewedByPaper = context.outputByPaper;
  const assignmentContext = await assignmentsFor(
    argument("--assignments") ? path.resolve(argument("--assignments")) : null,
    context,
    current,
    reviewedByPaper,
  );
  const currentPaperIds = new Set(current.papers.map((paper) => paper.id));
  for (const paper of prepared) {
    if (currentPaperIds.has(paper.paperId)) fail(`paper ${paper.paperId} already exists in Graph/current.json`);
  }

  const result = await withPlanningLock(support, async (planningRoot) => withDirectoryLock(
    path.join(support, ".locks", "stage-refresh.lock"),
    async () => withDirectoryLock(
      path.join(support, ".locks", "materialize-paper.lock"),
      async () => {
      if (await fileSha(currentPath) !== current.__sha256) fail("Graph/current.json changed before adoption commit");
      if (await fileSha(libraryPath) !== librarySha256) fail("library.json changed before adoption commit");
      try {
        await stat(path.join(support, "Graph", "pending-update.json"));
        fail("a pending Refresh appeared before adoption commit");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const adoptionRoot = path.join(planningRoot, "adoptions", context.adoptionId);
      const adoptionManifestPath = path.join(adoptionRoot, "manifest.json");
      const existing = await readOptionalJson(adoptionManifestPath, null, "adoption manifest");
      if (existing) {
        object(existing, "adoption manifest");
        if (existing.schemaVersion !== ADOPTION_SCHEMA || existing.resultManifestSha256 !== context.resultSha256
            || existing.baseGraphSha256 !== current.__sha256 || existing.assignmentDecisionSha256 !== assignmentContext.decisionSha256) {
          fail("a conflicting or stale adoption already exists for this review batch");
        }
        return { manifest: existing, manifestPath: adoptionManifestPath, resumed: true };
      }

      const indexPath = path.join(support, "Knowledge", "papers.json");
      const index = await readOptionalJson(indexPath, null, "Knowledge/papers.json");
      if (!index && current.papers.length) fail("Knowledge/papers.json is missing for a non-empty current graph; run liteverse doctor");
      const currentIndex = index ?? { schemaVersion: 3, revision: 0, papers: [] };
      if (!Array.isArray(currentIndex.papers)) fail("Knowledge/papers.json must contain a papers array");
      const indexedById = new Map(currentIndex.papers.map((paper) => [paper.paperId ?? paper.id, paper]));
      for (const graphPaper of current.papers) {
        if (!indexedById.has(graphPaper.id)) fail(`Knowledge/papers.json is missing current paper ${graphPaper.id}`);
      }
      assertNoDuplicatePrepared(prepared, currentIndex.papers);

      const transactionId = `adopt-${context.adoptionId}-${context.resultSha256.slice(0, 16)}`;
      const transactionRoot = path.join(planningRoot, ".transactions", transactionId);
      const journalPath = path.join(planningRoot, "journals", `${transactionId}.json`);
      await rm(transactionRoot, { recursive: true, force: true });
      await mkdir(transactionRoot, { recursive: true });
      const categoryById = new Map(current.categories.map((category) => [category.id, category]));
      const needsStaging = [...assignmentContext.assignments.values()].some((item) => item.primaryCategory === "liteverse-staging");
      const categories = [...current.categories];
      if (needsStaging && !categoryById.has("liteverse-staging")) {
        const staging = {
          id: "liteverse-staging",
          kind: "system",
          name: "Needs Classification",
          description: "Provisional papers awaiting scientific macro-region confirmation.",
          color: "#8E8E93",
          center: [0, 0, 0],
        };
        categories.push(staging);
        categoryById.set(staging.id, staging);
      }

      const graphPapers = [];
      const indexEntries = [];
      const preparedFiles = [];
      const libraryItems = [];
      for (const [ordinal, paper] of prepared.entries()) {
        const reviewed = reviewedByPaper.get(paper.paperId);
        const assignment = assignmentContext.assignments.get(paper.paperId);
        const reviewedCard = await readFile(reviewed.cardPath, "utf8");
        const extractedFulltext = await readFile(paper.fulltextPath, "utf8");
        const cardText = renderCard(paper, reviewedCard, reviewed.evidence, assignment);
        const fulltextText = renderFulltext(paper, extractedFulltext, reviewed.evidence.verificationStatus);
        const cardSha256 = sha256Text(cardText);
        const fulltextSha256 = sha256Text(fulltextText);
        const transactionPaper = path.join(transactionRoot, "papers", paper.paperId);
        const stagedCard = path.join(transactionPaper, "card.md");
        const stagedFulltext = path.join(transactionPaper, "fulltext.md");
        await atomicWriteText(stagedCard, cardText);
        await atomicWriteText(stagedFulltext, fulltextText);
        let stagedPdf = null;
        if (paper.source.storageMode === "managed") {
          const canonicalPdf = path.join(support, paper.source.pdfPath);
          let canonicalPresent = false;
          try {
            const info = await lstat(canonicalPdf);
            if (info.isSymbolicLink() || !info.isFile() || await fileSha(canonicalPdf) !== paper.sourceSha256) {
              fail(`paper ${paper.paperId} conflicts with an existing canonical PDF`);
            }
            canonicalPresent = true;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          if (!canonicalPresent) {
            stagedPdf = path.join(transactionPaper, "source.pdf");
            await mkdir(path.dirname(stagedPdf), { recursive: true });
            await copyFile(paper.sourceInputPath, stagedPdf, constants.COPYFILE_EXCL);
            if (await fileSha(stagedPdf) !== paper.sourceSha256) fail(`paper ${paper.paperId} staged PDF hash mismatch`);
          }
        }
        const cardPath = `Knowledge/cards/${paper.paperId}.md`;
        const fulltextPath = `Knowledge/fulltext/${paper.paperId}.md`;
        const artifacts = {
          cardPath,
          fulltextPath,
          extractionStatus: paper.extractionStatus,
          cardSchemaVersion: "liteverse-card-v1",
          evidenceCount: reviewed.evidence.evidence.length,
        };
        const entry = {
          paperId: paper.paperId,
          title: paper.title,
          authors: paper.authors,
          metadataStatus: paper.metadataStatus,
          sourceType: paper.source.kind,
          sha256: paper.sourceSha256,
          arxivId: paper.source.arxivId ?? null,
          doi: paper.source.doi ?? null,
          pdfPath: paper.source.pdfPath,
          cardPath,
          fulltextPath,
          extractionStatus: paper.extractionStatus,
          verificationStatus: reviewed.evidence.verificationStatus,
          cardSchemaVersion: "liteverse-card-v1",
          evidenceCount: reviewed.evidence.evidence.length,
          primaryCategory: assignment.primaryCategory,
          secondaryCategory: assignment.secondaryCategory,
          classificationStatus: assignment.classificationStatus,
          tags: assignment.tags,
          libraryItemId: paper.itemId,
          libraryItemRevision: paper.itemRevision,
          source: paper.source,
          artifacts,
        };
        indexEntries.push(entry);
        graphPapers.push({
          id: paper.paperId,
          title: paper.title,
          authors: paper.authors.join(", "),
          summary: "Pending deterministic finalization from the reviewed card.",
          projectRole: "Pending deterministic finalization from the reviewed card.",
          primaryCategory: assignment.primaryCategory,
          secondaryCategory: assignment.secondaryCategory,
          categoryIds: [assignment.primaryCategory, assignment.secondaryCategory].filter(Boolean),
          classificationStatus: assignment.classificationStatus,
          classificationRationale: {
            rationale: assignment.rationale,
            evidenceIds: assignment.evidenceIds,
            reviewBatchId: reviewed.evidence.batchId,
          },
          tags: assignment.tags,
          position: stablePosition(categoryById.get(assignment.primaryCategory), paper.paperId, ordinal),
          source: paper.source,
          pdfPath: paper.source.pdfPath,
          markdownPath: cardPath,
          fulltextPath,
          artifacts,
          verificationStatus: reviewed.evidence.verificationStatus,
          metadataStatus: paper.metadataStatus,
          useCount: 0,
        });
        preparedFiles.push({
          paperId: paper.paperId,
          stagedCard,
          stagedFulltext,
          stagedPdf,
          cardPath: path.join(support, cardPath),
          fulltextPath: path.join(support, fulltextPath),
          pdfPath: paper.source.storageMode === "managed" ? path.join(support, paper.source.pdfPath) : null,
          cardSha256,
          fulltextSha256,
          sourceSha256: paper.sourceSha256,
        });
        libraryItems.push({ itemId: paper.itemId, revision: paper.itemRevision, paperId: paper.paperId });
      }

      const missingIndexEntries = [];
      for (const entry of indexEntries) {
        const existingEntry = indexedById.get(entry.paperId);
        if (!existingEntry) missingIndexEntries.push(entry);
        else if (stableJson(existingEntry) !== stableJson(entry)) {
          fail(`paper ${entry.paperId} conflicts with an existing Knowledge/papers.json entry`);
        }
      }
      const nextIndex = missingIndexEntries.length ? {
        ...currentIndex,
        schemaVersion: Math.max(3, Number(currentIndex.schemaVersion) || 0),
        revision: (Number(currentIndex.revision) || 0) + 1,
        generatedAt: current.updated ?? currentIndex.generatedAt ?? "1970-01-01T00:00:00.000Z",
        papers: [...currentIndex.papers, ...missingIndexEntries]
          .sort((left, right) => (left.paperId ?? left.id).localeCompare(right.paperId ?? right.id)),
      } : currentIndex;
      const baseSnapshot = {
        ...current,
        __sha256: undefined,
        revision: current.revision + 1,
        categories,
        papers: [...current.papers, ...graphPapers],
      };
      delete baseSnapshot.__sha256;
      const baseSnapshotText = stableJson(baseSnapshot);
      const libraryItemsValue = {
        schemaVersion: "liteverse-curation-library-items-v1",
        adoptionId: context.adoptionId,
        batchIds: context.batchPins.map((pin) => pin.batchId),
        items: libraryItems.sort((left, right) => left.itemId.localeCompare(right.itemId)),
      };
      const inputFingerprint = sha256Text(stableJson({
        batchSha256: context.batchSha256,
        resultManifestSha256: context.resultSha256,
        assignmentDecisionSha256: assignmentContext.decisionSha256,
        baseGraphSha256: current.__sha256,
        libraryItems: libraryItemsValue.items,
      }));
      await atomicWriteJson(journalPath, {
        schemaVersion: "liteverse-curator-transaction-v1",
        transactionId,
        operation: "adopt_review_results",
        state: "planned",
        inputFingerprint,
        guardrails: { writesCurrentGraph: false, writesStagedGraph: false, writesPendingRefresh: false, writesUsage: false, writesResearchMemory: false },
      });

      // Every batch source, review result, assignment, and complete snapshot is
      // validated above before the first canonical working file is installed.
      // The additive files are installed atomically; an interrupted run leaves
      // no papers projection and resumes by accepting only byte-identical files.
      for (const file of preparedFiles) {
        await installExact(file.stagedCard, file.cardPath, file.cardSha256, `${file.paperId} card`);
        await installExact(file.stagedFulltext, file.fulltextPath, file.fulltextSha256, `${file.paperId} fulltext`);
        if (file.stagedPdf) await installExact(file.stagedPdf, file.pdfPath, file.sourceSha256, `${file.paperId} PDF`);
      }
      await atomicWriteJson(indexPath, nextIndex);
      await mkdir(adoptionRoot, { recursive: true });
      const baseSnapshotPath = path.join(adoptionRoot, "base-snapshot.json");
      const workingSnapshotPath = path.join(adoptionRoot, "working-snapshot.json");
      const libraryItemsPath = path.join(adoptionRoot, "library-items.json");
      await atomicWriteText(baseSnapshotPath, baseSnapshotText);
      await atomicWriteText(workingSnapshotPath, baseSnapshotText);
      await atomicWriteJson(libraryItemsPath, libraryItemsValue);
      const manifest = {
        schemaVersion: ADOPTION_SCHEMA,
        state: "canonical_drafts_adopted",
        adoptionId: context.adoptionId,
        batchPins: context.batchPins,
        batchSha256: context.batchSha256,
        resultManifestSha256: context.resultSha256,
        assignmentDecisionSha256: assignmentContext.decisionSha256,
        baseRevision: current.revision,
        targetRevision: current.revision + 1,
        baseGraphSha256: current.__sha256,
        inputFingerprint,
        baseSnapshotPath: path.relative(support, baseSnapshotPath),
        baseSnapshotSha256: sha256Text(baseSnapshotText),
        workingSnapshotPath: path.relative(support, workingSnapshotPath),
        libraryItemsPath: path.relative(support, libraryItemsPath),
        papers: preparedFiles.map((file) => ({
          paperId: file.paperId,
          cardPath: path.relative(support, file.cardPath),
          cardSha256: file.cardSha256,
          fulltextPath: path.relative(support, file.fulltextPath),
          fulltextSha256: file.fulltextSha256,
          sourceSha256: file.sourceSha256,
        })),
        guardrails: {
          immutableArtifactsPublished: false,
          requiresFinalization: true,
          requiresClaimGeneration: true,
          requiresSeparateStageRefresh: true,
          writesCurrentGraph: false,
          writesStagedGraph: false,
          writesPendingRefresh: false,
          writesUsage: false,
          writesResearchMemory: false,
        },
      };
      await atomicWriteJson(adoptionManifestPath, manifest);
      await atomicWriteJson(journalPath, {
        schemaVersion: "liteverse-curator-transaction-v1",
        transactionId,
        operation: "adopt_review_results",
        state: "committed",
        inputFingerprint,
        adoptionManifestSha256: await fileSha(adoptionManifestPath),
      });
      await rm(transactionRoot, { recursive: true, force: true });
      return { manifest, manifestPath: adoptionManifestPath, resumed: false };
      },
      "Curator review adoption materialization",
    ),
    "Curator review adoption staging",
  ));

  const output = {
    status: result.manifest.state,
    adoptionId: result.manifest.adoptionId,
    batchIds: result.manifest.batchPins.map((pin) => pin.batchId),
    manifestPath: result.manifestPath,
    manifestSha256: await fileSha(result.manifestPath),
    workingSnapshotPath: path.join(support, result.manifest.workingSnapshotPath),
    libraryItemsPath: path.join(support, result.manifest.libraryItemsPath),
    paperIds: result.manifest.papers.map((paper) => paper.paperId),
    resumed: result.resumed,
    next: [
      "finalize-curated-snapshot.py",
      "generate-claims.mjs",
      "merge-relation-review.mjs (when reviewed relations exist)",
      "stage-refresh.mjs",
    ],
  };
  console.log(process.argv.includes("--json") ? JSON.stringify(output, null, 2) : `${output.adoptionId}\n${output.workingSnapshotPath}`);
}

main().catch((error) => {
  console.error(`adopt-review-results: ${error.message}`);
  process.exitCode = 2;
});
