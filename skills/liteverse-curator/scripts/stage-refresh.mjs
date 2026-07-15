#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  assignCategoryNebulaAssets,
  assignmentFingerprint,
  findDecisionRecord,
  isFiniteVector3,
  validateDecisionRecord,
} from "./partition-contract.mjs";

function fail(message) {
  throw new Error(message);
}

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function usage() {
  console.log(`Usage: stage-refresh.mjs --snapshot next-graph.json [options]

Options:
  --support-dir DIR       Liteverse Application Support root
  --refresh-id ID         Stable batch ID; otherwise generated
  --library-items FILE    JSON array of {itemId, revision, paperId}; replacement
                          recovery requires the exact old manifest batch
  --replace-pending       Transfer and replace the same pending batch after
                          revalidating graph and library ownership
  --stagger-ms N          Animation spacing, default 500
  --wave-duration-ms N    Wave lifetime, default 2400

The script writes an immutable staged snapshot, manifest, and pending pointer.
It never modifies Graph/current.json or Usage.`);
}

function integer(value, label, minimum = 0) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) fail(`${label} must be an integer >= ${minimum}`);
  return number;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(filePath, label = filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") fail(`${label} does not exist: ${filePath}`);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function serializedJson(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

async function atomicWrite(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
}

async function withLock(lockPath, callback) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) fail(`timed out waiting for lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function uniqueIds(items, label) {
  if (!Array.isArray(items)) fail(`${label} must be an array`);
  const ids = new Set();
  for (const [index, item] of items.entries()) {
    object(item, `${label}[${index}]`);
    if (typeof item.id !== "string" || !item.id) fail(`${label}[${index}].id must be a string`);
    if (ids.has(item.id)) fail(`${label} contains duplicate ID ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

const relationRubric = Object.freeze({
  directDependency: new Set([0, 12, 24, 35]),
  coreQuestion: new Set([0, 8, 16, 25]),
  methodContinuity: new Set([0, 7, 14, 20]),
  resultRelationship: new Set([0, 7, 14, 20]),
});

const graphSchemas = new Set(["2.0.0", "3.0.0"]);
const verificationStates = new Set([
  "imported",
  "extracted",
  "needs_ocr",
  "card_draft",
  "evidence_verified",
  "needs_attention",
  "source_missing",
]);
const extractionStates = new Set(["pending", "extracted", "needs_ocr", "failed"]);
const metadataStates = new Set(["provisional", "official_verified", "source_verified"]);

function categoryKind(category) {
  return category.kind ?? "macro";
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) fail(`${label} must be support-relative`);
  const parts = value.split(/[\\/]+/);
  if (parts.some((part) => !part || part === "." || part === "..")) fail(`${label} contains unsafe segments`);
  return value;
}

function validateV3Paper(paper) {
  if (Object.hasOwn(paper, "verified")) fail(`paper ${paper.id} must not keep legacy verified in schema v3`);
  if (!verificationStates.has(paper.verificationStatus)) {
    fail(`paper ${paper.id} has invalid verificationStatus ${paper.verificationStatus}`);
  }
  if (!metadataStates.has(paper.metadataStatus)) fail(`paper ${paper.id} has invalid metadataStatus ${paper.metadataStatus}`);
  const source = object(paper.source, `paper ${paper.id}.source`);
  if (!["pdf", "arxiv"].includes(source.kind)) fail(`paper ${paper.id}.source.kind must be pdf or arxiv`);
  const expectedPdf = `Library/PDFs/${paper.id}.pdf`;
  if (safeRelativePath(source.pdfPath, `paper ${paper.id}.source.pdfPath`) !== expectedPdf) {
    fail(`paper ${paper.id}.source.pdfPath must be ${expectedPdf}`);
  }
  if (!/^[a-f0-9]{64}$/.test(source.sha256 ?? "")) fail(`paper ${paper.id}.source.sha256 must be lowercase SHA-256`);
  const artifacts = object(paper.artifacts, `paper ${paper.id}.artifacts`);
  const expectedCard = `Knowledge/cards/${paper.id}.md`;
  const expectedFulltext = `Knowledge/fulltext/${paper.id}.md`;
  if (safeRelativePath(artifacts.cardPath, `paper ${paper.id}.artifacts.cardPath`) !== expectedCard) {
    fail(`paper ${paper.id}.artifacts.cardPath must be ${expectedCard}`);
  }
  if (safeRelativePath(artifacts.fulltextPath, `paper ${paper.id}.artifacts.fulltextPath`) !== expectedFulltext) {
    fail(`paper ${paper.id}.artifacts.fulltextPath must be ${expectedFulltext}`);
  }
  if (!extractionStates.has(artifacts.extractionStatus)) {
    fail(`paper ${paper.id} has invalid extractionStatus ${artifacts.extractionStatus}`);
  }
  if (artifacts.cardSchemaVersion !== "liteverse-card-v1") {
    fail(`paper ${paper.id}.artifacts.cardSchemaVersion must be liteverse-card-v1`);
  }
  if (!Number.isInteger(artifacts.evidenceCount) || artifacts.evidenceCount < 0) {
    fail(`paper ${paper.id}.artifacts.evidenceCount must be a non-negative integer`);
  }
  if (paper.pdfPath !== expectedPdf || paper.markdownPath !== expectedCard || paper.fulltextPath !== expectedFulltext) {
    fail(`paper ${paper.id} legacy compatibility paths must match schema-v3 source/artifacts paths`);
  }
  if (paper.verificationStatus === "needs_ocr" && artifacts.extractionStatus !== "needs_ocr") {
    fail(`paper ${paper.id} needs_ocr status is inconsistent with extractionStatus`);
  }
  if (paper.verificationStatus === "evidence_verified") {
    if (artifacts.extractionStatus !== "extracted" || artifacts.evidenceCount < 1 || paper.metadataStatus === "provisional") {
      fail(`paper ${paper.id} cannot be evidence_verified without extracted full text and evidence`);
    }
  }
}

function validLocatorValue(value, relationId, evidenceId, field) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      fail(`relation ${relationId} evidence ${evidenceId} ${field} must be a positive integer when numeric`);
    }
    return true;
  }
  if (typeof value !== "string" || !value.trim()) return false;
  const trimmed = value.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed) && (!Number.isInteger(Number(trimmed)) || Number(trimmed) <= 0)) {
    fail(`relation ${relationId} evidence ${evidenceId} ${field} must be a positive integer when numeric`);
  }
  return true;
}

function relationLocator(evidence, relationId) {
  const locator = evidence?.locator && typeof evidence.locator === "object" ? evidence.locator : evidence;
  const values = ["page", "section", "equation", "figure", "table"].map((field) =>
    validLocatorValue(locator?.[field], relationId, evidence?.id ?? "unknown", field));
  return values.some(Boolean);
}

function validateScoredRelation(relation) {
  const components = object(relation.components, `relation ${relation.id}.components`);
  const evidence = Array.isArray(relation.evidence)
    ? relation.evidence
    : fail(`relation ${relation.id}.evidence must be an array`);
  const evidenceById = new Map();
  for (const item of evidence) {
    object(item, `relation ${relation.id} evidence`);
    if (typeof item.id !== "string" || !item.id) fail(`relation ${relation.id} has evidence without an ID`);
    if (evidenceById.has(item.id)) fail(`relation ${relation.id} has duplicate evidence ${item.id}`);
    if (![relation.source, relation.target].includes(item.paperId)) {
      fail(`relation ${relation.id} evidence ${item.id} references a third paper`);
    }
    if (typeof item.paraphrase !== "string" || !item.paraphrase.trim()) {
      fail(`relation ${relation.id} evidence ${item.id} lacks a faithful paraphrase`);
    }
    evidenceById.set(item.id, item);
  }
  const referenced = new Set();
  let strength = 0;
  for (const [name, allowed] of Object.entries(relationRubric)) {
    const component = object(components[name], `relation ${relation.id}.components.${name}`);
    if (!allowed.has(component.score)) fail(`relation ${relation.id} has a non-rubric ${name} score`);
    if (!Array.isArray(component.evidenceIds) || component.evidenceIds.some((id) => typeof id !== "string")) {
      fail(`relation ${relation.id} ${name} evidenceIds must be strings`);
    }
    if (component.score > 0 && component.evidenceIds.length === 0) {
      fail(`relation ${relation.id} has a nonzero ${name} score without evidence`);
    }
    for (const evidenceId of component.evidenceIds) {
      if (!evidenceById.has(evidenceId)) fail(`relation ${relation.id} references unknown evidence ${evidenceId}`);
      referenced.add(evidenceId);
    }
    strength += component.score;
  }
  if (relation.strength !== strength) fail(`relation ${relation.id} strength does not equal its rubric sum`);
  const confidence = object(relation.confidenceComponents, `relation ${relation.id}.confidenceComponents`);
  for (const name of ["sourceCoverage", "locatorPrecision", "crossConfirmation"]) {
    if (!Number.isFinite(confidence[name]) || confidence[name] < 0 || confidence[name] > 100) {
      fail(`relation ${relation.id} confidence component ${name} must be 0..100`);
    }
  }
  const expectedConfidence = Math.round(
    confidence.sourceCoverage * 0.4 + confidence.locatorPrecision * 0.35 + confidence.crossConfirmation * 0.25,
  );
  if (relation.confidence !== expectedConfidence) {
    fail(`relation ${relation.id} confidence does not equal its weighted components`);
  }
  const locatedPapers = new Set(
    [...referenced]
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((item) => relationLocator(item, relation.id))
      .map((item) => item.paperId),
  );
  const formalEligible = locatedPapers.has(relation.source) && locatedPapers.has(relation.target);
  if (relation.formalEligible !== formalEligible) fail(`relation ${relation.id} formalEligible is inconsistent with evidence`);
  const expectedStatus = formalEligible && strength >= 60 && expectedConfidence >= 75
    ? "verified"
    : formalEligible && strength >= 40 && expectedConfidence >= 50
      ? "candidate"
      : "suggestion";
  if (relation.status !== expectedStatus) fail(`relation ${relation.id} status should be ${expectedStatus}`);
}

function validateNewCategories(current, snapshot, currentCategories, fullRepartition = false) {
  const newCategories = snapshot.categories.filter(
    (category) => !currentCategories.has(category.id) && categoryKind(category) === "macro",
  );
  const existingMacroCategories = current.categories.filter((category) => categoryKind(category) === "macro");
  const manifestEvidence = [];
  for (const category of newCategories) {
    const members = snapshot.papers.filter((paper) => paper.primaryCategory === category.id);
    if (members.length < 4) fail(`new category ${category.id} requires at least four primary papers`);
    const creation = object(category.creationEvidence, `category ${category.id}.creationEvidence`);
    const memberIds = creation.memberIds;
    if (!Array.isArray(memberIds) || memberIds.some((id) => typeof id !== "string" || !id)) {
      fail(`new category ${category.id} requires creationEvidence.memberIds`);
    }
    const uniqueMemberIds = [...new Set(memberIds)].sort();
    if (uniqueMemberIds.length !== memberIds.length) {
      fail(`new category ${category.id} creationEvidence.memberIds contains duplicates`);
    }
    const primaryMemberIds = members.map((paper) => paper.id).sort();
    if (JSON.stringify(uniqueMemberIds) !== JSON.stringify(primaryMemberIds)) {
      fail(`new category ${category.id} creationEvidence.memberIds must match its primary papers`);
    }
    const consistency = Number(creation.clusterConsistency);
    if (!Number.isFinite(consistency) || consistency < 70 || consistency > 100) {
      fail(`new category ${category.id} requires clusterConsistency from 70 through 100`);
    }
    if (typeof creation.scopeDefinition !== "string" || !creation.scopeDefinition.trim()) {
      fail(`new category ${category.id} requires a non-empty scopeDefinition`);
    }
    const scores = creation.existingRegionMatchScores;
    if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
      fail(`new category ${category.id} requires existingRegionMatchScores by member`);
    }
    for (const paper of members) {
      const memberScores = scores[paper.id];
      if (!memberScores || typeof memberScores !== "object" || Array.isArray(memberScores)) {
        fail(`new category ${category.id} lacks existing-region scores for ${paper.id}`);
      }
      const values = Object.values(memberScores);
      const invalidScore = fullRepartition
        ? values.some((score) => !Number.isFinite(score) || score < 0 || score > 100)
        : values.some((score) => !Number.isFinite(score) || score < 0 || score >= 60);
      if (invalidScore) {
        fail(fullRepartition
          ? `all existing-region match scores for ${paper.id} in ${category.id} must be 0..100`
          : `all existing-region match scores for ${paper.id} in ${category.id} must be 0..59`);
      }
      for (const oldCategory of existingMacroCategories) {
        if (!(oldCategory.id in memberScores)) {
          fail(`new category ${category.id} lacks ${oldCategory.id} match score for ${paper.id}`);
        }
      }
    }
    manifestEvidence.push({
      categoryId: category.id,
      creationEvidence: {
        ...creation,
        memberIds: primaryMemberIds,
        clusterConsistency: consistency,
        scopeDefinition: creation.scopeDefinition.trim(),
        existingRegionMatchScores: stable(scores),
      },
    });
  }
  return manifestEvidence.sort((left, right) => left.categoryId.localeCompare(right.categoryId));
}

function validateGraph(current, snapshot) {
  object(current, "current graph");
  object(snapshot, "staged snapshot");
  if (!graphSchemas.has(current.schemaVersion)) fail(`unsupported current graph schema ${current.schemaVersion}`);
  if (!graphSchemas.has(snapshot.schemaVersion)) fail(`unsupported snapshot graph schema ${snapshot.schemaVersion}`);
  if (current.schemaVersion === "3.0.0" && snapshot.schemaVersion !== "3.0.0") {
    fail("schema-v3 graphs cannot be downgraded");
  }
  const baseRevision = integer(current.revision, "current revision", 1);
  const targetRevision = integer(snapshot.revision, "snapshot revision", 1);
  if (targetRevision <= baseRevision) fail("snapshot revision must be greater than current revision");

  const currentCategoryIds = uniqueIds(current.categories, "current.categories");
  const categoryIds = uniqueIds(snapshot.categories, "snapshot.categories");
  const macroCategories = snapshot.categories.filter((category) => categoryKind(category) === "macro");
  const systemCategories = snapshot.categories.filter((category) => categoryKind(category) === "system");
  const unknownKinds = snapshot.categories.filter((category) => !["macro", "system"].includes(categoryKind(category)));
  if (unknownKinds.length) fail(`category ${unknownKinds[0].id} has invalid kind ${categoryKind(unknownKinds[0])}`);
  if (macroCategories.length > 10) fail("Liteverse supports at most ten macro categories");
  if (systemCategories.length > 1 || systemCategories.some((category) => category.id !== "liteverse-staging")) {
    fail("Liteverse supports only the liteverse-staging system category");
  }
  if (snapshot.schemaVersion === "2.0.0" && systemCategories.length) {
    fail("system categories require graph schema v3");
  }
  const requireSpatialLayout = snapshot.schemaVersion === "3.0.0" || Boolean(snapshot.partitionDecision);
  if (requireSpatialLayout) {
    for (const category of macroCategories) {
      if (!isFiniteVector3(category.center)) {
        fail(`macro category ${category.id}.center must be a finite three-number vector`);
      }
    }
  }
  const removedCategoryIds = [...currentCategoryIds].filter((categoryId) => !categoryIds.has(categoryId)).sort();
  if (removedCategoryIds.length && !snapshot.partitionDecision) {
    fail(`staged snapshot may not remove existing category ${removedCategoryIds[0]} without a recorded partition decision`);
  }
  const currentPaperIds = uniqueIds(current.papers ?? [], "current.papers");
  const paperIds = uniqueIds(snapshot.papers, "snapshot.papers");
  for (const currentPaperId of currentPaperIds) {
    if (!paperIds.has(currentPaperId)) fail(`staged snapshot may not remove existing paper ${currentPaperId}`);
  }
  const currentRelationIds = uniqueIds(current.relations ?? [], "current.relations");
  const relationIds = uniqueIds(snapshot.relations, "snapshot.relations");
  for (const currentRelationId of currentRelationIds) {
    if (!relationIds.has(currentRelationId)) {
      fail(`staged snapshot may not remove existing relation ${currentRelationId}`);
    }
  }

  for (const paper of snapshot.papers) {
    if (requireSpatialLayout && !isFiniteVector3(paper.position)) {
      fail(`paper ${paper.id}.position must be a finite three-number vector`);
    }
    if (!categoryIds.has(paper.primaryCategory)) fail(`paper ${paper.id} has an unknown primaryCategory`);
    if (paper.secondaryCategory !== undefined && paper.secondaryCategory !== null) {
      if (typeof paper.secondaryCategory !== "string" || !categoryIds.has(paper.secondaryCategory)) {
        fail(`paper ${paper.id} has an unknown secondaryCategory`);
      }
      if (paper.secondaryCategory === paper.primaryCategory) {
        fail(`paper ${paper.id} secondaryCategory must differ from primaryCategory`);
      }
    }
    if (paper.categoryIds !== undefined && !Array.isArray(paper.categoryIds)) {
      fail(`paper ${paper.id}.categoryIds must be an array when present`);
    }
    const rawAssignments = paper.categoryIds ?? [paper.primaryCategory, paper.secondaryCategory].filter(Boolean);
    if (rawAssignments.some((categoryId) => typeof categoryId !== "string" || !categoryIds.has(categoryId))) {
      fail(`paper ${paper.id}.categoryIds contains an unknown category`);
    }
    const assignments = [...new Set(rawAssignments)];
    if (assignments.length !== rawAssignments.length) fail(`paper ${paper.id}.categoryIds contains duplicates`);
    if (!assignments.includes(paper.primaryCategory)) fail(`paper ${paper.id} categoryIds must contain primaryCategory`);
    if (assignments.length > 2) fail(`paper ${paper.id} may have only one primary and one secondary category`);
    if (paper.secondaryCategory && !assignments.includes(paper.secondaryCategory)) {
      fail(`paper ${paper.id} secondaryCategory is inconsistent with categoryIds`);
    }
    if (paper.secondaryCategory && assignments.length !== 2) {
      fail(`paper ${paper.id} with secondaryCategory must have exactly two categoryIds`);
    }
    if (!Number.isInteger(paper.useCount) || paper.useCount !== 0) {
      fail(`staged paper ${paper.id} must keep seed useCount at 0; Curator cannot modify temperature`);
    }
    if (snapshot.schemaVersion === "3.0.0") validateV3Paper(paper);
    const primaryKind = categoryKind(snapshot.categories.find((category) => category.id === paper.primaryCategory));
    if (primaryKind === "system" && paper.classificationStatus !== "provisional") {
      fail(`paper ${paper.id} in the system staging category must be provisional`);
    }
  }
  const oldRelations = new Map((current.relations ?? []).map((relation) => [relation.id, relation]));
  for (const relation of snapshot.relations) {
    if (!paperIds.has(relation.source) || !paperIds.has(relation.target)) {
      fail(`relation ${relation.id} references an unknown paper`);
    }
    const oldRelation = oldRelations.get(relation.id);
    const changed = !oldRelation || !stableEqual(oldRelation, relation);
    if (relation.rubric === "liteverse-relation-v1") {
      validateScoredRelation(relation);
    } else if (!oldRelation) {
      fail(`new relation ${relation.id} lacks rubric v1`);
    } else if (changed && (relation.strength !== null || relation.confidence !== null)) {
      fail(`legacy relation ${relation.id} cannot acquire percentages without rubric v1 scoring`);
    }
  }
  const newCategoryEvidence = validateNewCategories(
    current,
    snapshot,
    currentCategoryIds,
    removedCategoryIds.length > 0 && Boolean(snapshot.partitionDecision),
  );
  return { baseRevision, targetRevision, paperIds, relationIds, newCategoryEvidence, removedCategoryIds };
}

async function validatePartitionReplacement(support, current, snapshot, removedCategoryIds) {
  if (!removedCategoryIds.length) return null;
  const pointer = object(snapshot.partitionDecision, "snapshot.partitionDecision");
  const record = await findDecisionRecord(support, pointer);
  validateDecisionRecord(record, snapshot, current);
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(record.proposalSetId ?? "")) {
    fail("partition decision proposalSetId is invalid");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(record.optionId ?? "")) {
    fail("partition decision optionId is invalid");
  }
  if (typeof record.proposalTruthPath !== "string"
      || !record.proposalTruthPath.startsWith("Planning/partition-proposals/")
      || record.proposalTruthPath.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("partition decision proposalTruthPath is invalid");
  }
  const proposalText = await readFile(path.join(support, record.proposalTruthPath), "utf8");
  if (createHash("sha256").update(proposalText).digest("hex") !== record.proposalSha256) {
    fail("partition decision proposal truth hash does not match");
  }
  let proposal;
  try {
    proposal = JSON.parse(proposalText);
  } catch (error) {
    fail(`partition proposal truth is invalid JSON: ${error.message}`);
  }
  if (proposal.schemaVersion !== "liteverse-partition-proposal-v1"
      || proposal.proposalSetId !== record.proposalSetId
      || proposal.baseRevision !== record.baseRevision
      || proposal.currentArtifactFingerprint !== record.currentArtifactFingerprint
      || proposal.corpusArtifactFingerprint !== record.corpusArtifactFingerprint) {
    fail("partition proposal truth does not match the decision record");
  }
  if (!Array.isArray(proposal.options) || proposal.options.length !== 3) {
    fail("partition proposal truth must contain exactly three options");
  }
  const selected = proposal.options.filter((option) => option.optionId === record.optionId);
  if (selected.length !== 1) fail("partition decision must select exactly one proposal option");
  const optionCategoryIds = selected[0].categories.map((category) => category.id).sort();
  const snapshotCategoryIds = snapshot.categories.map((category) => category.id).sort();
  if (!stableEqual(optionCategoryIds, snapshotCategoryIds)) {
    fail("partition proposal option categories do not match the selected snapshot");
  }
  const optionAssignmentHash = assignmentFingerprint(selected[0].assignments.map((assignment) => ({
    id: assignment.paperId,
    primaryCategory: assignment.primaryCategory,
    secondaryCategory: assignment.secondaryCategory ?? null,
  })));
  if (optionAssignmentHash !== record.paperAssignmentsSha256) {
    fail("partition proposal option assignments do not match the decision record");
  }
  const expectedNebula = assignCategoryNebulaAssets(
    { visuals: snapshot.visuals, categories: current.categories },
    current,
    selected[0].categories,
  );
  const actualCategories = new Map(snapshot.categories.map((category) => [category.id, category]));
  for (const expected of expectedNebula.categories) {
    const actual = actualCategories.get(expected.id);
    if (actual?.nebulaAssetId !== expected.nebulaAssetId
        || actual?.nebulaAssignmentOrder !== expected.nebulaAssignmentOrder) {
      fail(`partition category ${expected.id} has a non-deterministic nebula assignment`);
    }
  }
  return {
    decisionId: record.decisionId,
    proposalSetId: record.proposalSetId,
    optionId: record.optionId,
    baseRevision: record.baseRevision,
    currentArtifactFingerprint: record.currentArtifactFingerprint,
    corpusArtifactFingerprint: record.corpusArtifactFingerprint,
    decisionRecordPath: pointer.decisionRecordPath,
    recordSha256: pointer.recordSha256,
    proposalTruthPath: record.proposalTruthPath,
    proposalSha256: record.proposalSha256,
  };
}

function stableEqual(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function diffItems(currentItems, nextItems) {
  const before = new Map((currentItems ?? []).map((item) => [item.id, item]));
  const after = new Map((nextItems ?? []).map((item) => [item.id, item]));
  return {
    added: [...after.keys()].filter((id) => !before.has(id)).sort(),
    changed: [...after.keys()].filter((id) => before.has(id) && !stableEqual(before.get(id), after.get(id))).sort(),
    removed: [...before.keys()].filter((id) => !after.has(id)).sort(),
  };
}

async function loadLibraryItems(filePath) {
  if (!filePath) return [];
  const value = await readJson(filePath, "library items");
  const items = Array.isArray(value) ? value : value.items;
  if (!Array.isArray(items)) fail("--library-items must contain an array or an object with items");
  const ids = new Set();
  return items.map((raw, index) => {
    object(raw, `libraryItems[${index}]`);
    const itemId = raw.itemId ?? raw.id;
    if (typeof itemId !== "string" || !itemId) fail(`libraryItems[${index}].itemId must be a string`);
    if (ids.has(itemId)) fail(`duplicate library item ${itemId}`);
    ids.add(itemId);
    if (typeof raw.paperId !== "string" || !raw.paperId) fail(`libraryItems[${index}].paperId must be a string`);
    return { itemId, revision: integer(raw.revision, `library item ${itemId} revision`, 1), paperId: raw.paperId };
  });
}

function normalizeManifestLibraryItems(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const ids = new Set();
  return value.map((raw, index) => {
    object(raw, `${label}[${index}]`);
    const itemId = raw.itemId ?? raw.id;
    if (typeof itemId !== "string" || !itemId) fail(`${label}[${index}].itemId must be a string`);
    if (ids.has(itemId)) fail(`${label} contains duplicate library item ${itemId}`);
    ids.add(itemId);
    if (typeof raw.paperId !== "string" || !raw.paperId) fail(`${label}[${index}].paperId must be a string`);
    return {
      itemId,
      revision: integer(raw.revision, `${label} item ${itemId} revision`, 1),
      paperId: raw.paperId,
    };
  }).sort((left, right) => left.itemId.localeCompare(right.itemId));
}

async function loadReplacementContext(support, pending, libraryItems, libraryItemsProvided) {
  object(pending, "pending update");
  const manifestRelative = safeRelativePath(pending.manifestPath, "pending update manifestPath");
  const manifest = await readJson(path.join(support, manifestRelative), "existing pending manifest");
  object(manifest, "existing pending manifest");
  if (manifest.refreshId !== pending.refreshId) fail("existing pending manifest refresh ID does not match its pointer");
  if (manifest.baseRevision !== pending.baseRevision || manifest.targetRevision !== pending.targetRevision) {
    fail("existing pending manifest revisions do not match its pointer");
  }
  if (manifest.snapshotSha256 !== pending.snapshotSha256) {
    fail("existing pending manifest snapshot hash does not match its pointer");
  }
  const manifestItems = normalizeManifestLibraryItems(manifest.libraryItems ?? [], "existing pending manifest.libraryItems");
  const pointerItems = normalizeManifestLibraryItems(pending.libraryItems ?? [], "pending update.libraryItems");
  if (!stableEqual(manifestItems, pointerItems)) {
    fail("existing pending manifest library items do not match its pointer");
  }
  if (manifestItems.length && !libraryItemsProvided) {
    fail("replacing a pending refresh with library items requires --library-items for the complete existing batch");
  }
  const requestedItems = [...libraryItems].sort((left, right) => left.itemId.localeCompare(right.itemId));
  if (!stableEqual(requestedItems, manifestItems)) {
    fail("replacement library items must exactly match the existing pending manifest itemId, paperId, and revision");
  }
  return { pending, manifestItems };
}

async function prepareLibraryUpdate(support, libraryItems, refreshId, replacementContext = null) {
  if (!libraryItems.length) return null;
  const libraryPath = path.join(support, "library.json");
  const originalText = await readFile(libraryPath, "utf8");
  let library;
  try {
    library = JSON.parse(originalText);
  } catch (error) {
    fail(`library.json is invalid: ${error.message}`);
  }
  if (!Array.isArray(library.items)) fail("library.json lacks an items array");
  const requested = new Map(libraryItems.map((item) => [item.itemId, item]));
  const replacementItems = replacementContext
    ? new Map(replacementContext.manifestItems.map((item) => [item.itemId, item]))
    : null;
  const updatedIds = new Set();
  const manifestItems = [];
  const nextItems = library.items.map((item) => {
    const expected = requested.get(item.id);
    if (!expected) return item;
    if (replacementItems) {
      const previous = replacementItems.get(item.id);
      if (!previous || !stableEqual(previous, expected)) {
        fail(`replacement library item ${item.id} does not match the existing pending manifest`);
      }
      if (item.revision !== previous.revision) {
        fail(`replacement library item ${item.id} revision no longer matches the existing pending manifest`);
      }
      if (item.status !== "ready_to_refresh") {
        fail(`replacement library item ${item.id} must remain ready_to_refresh, found ${item.status}`);
      }
      if (item.graphPaperId !== previous.paperId) {
        fail(`replacement library item ${item.id} graph paper no longer matches the existing pending manifest`);
      }
      if (item.refreshId !== replacementContext.pending.refreshId) {
        fail(`replacement library item ${item.id} is not owned by the existing pending refresh`);
      }
      updatedIds.add(item.id);
      manifestItems.push(previous);
      return {
        ...item,
        updatedAt: new Date().toISOString(),
        refreshId,
      };
    }
    if (item.revision !== expected.revision) fail(`library item ${item.id} revision changed during curation`);
    if (!["pending_codex", "processing"].includes(item.status)) {
      fail(`library item ${item.id} cannot enter ready_to_refresh from ${item.status}`);
    }
    updatedIds.add(item.id);
    const updatedRevision = expected.revision + 1;
    manifestItems.push({ itemId: item.id, revision: updatedRevision, paperId: expected.paperId });
    return {
      ...item,
      revision: updatedRevision,
      updatedAt: new Date().toISOString(),
      status: "ready_to_refresh",
      graphPaperId: expected.paperId,
      refreshId,
    };
  });
  for (const itemId of requested.keys()) {
    if (!updatedIds.has(itemId)) fail(`library item ${itemId} is missing`);
  }
  manifestItems.sort((left, right) => left.itemId.localeCompare(right.itemId));
  return { libraryPath, originalText, nextText: serializedJson({ ...library, items: nextItems }), manifestItems };
}

function safeRefreshId(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value)) fail("refresh ID contains unsafe characters");
  return value;
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    usage();
    return;
  }
  const snapshotInput = argument("--snapshot");
  if (!snapshotInput) fail("missing required --snapshot");
  const support = path.resolve(
    argument("--support-dir")
      ?? process.env.LITEVERSE_SUPPORT_DIR
      ?? path.join(homedir(), "Library", "Application Support", "Liteverse"),
  );
  const graphRoot = path.join(support, "Graph");
  const currentPath = path.join(graphRoot, "current.json");
  const pendingPath = path.join(graphRoot, "pending-update.json");
  const snapshot = await readJson(path.resolve(snapshotInput), "snapshot");
  const libraryItemsPath = argument("--library-items");
  const libraryItems = await loadLibraryItems(libraryItemsPath);
  const staggerMs = integer(argument("--stagger-ms") ?? 500, "--stagger-ms", 0);
  const waveDurationMs = integer(argument("--wave-duration-ms") ?? 2400, "--wave-duration-ms", 1);

  await withLock(path.join(support, ".locks", "stage-refresh.lock"), async () => {
    const current = await readJson(currentPath, "Graph/current.json");
    const { baseRevision, targetRevision, newCategoryEvidence, removedCategoryIds } = validateGraph(current, snapshot);
    const partitionDecision = await validatePartitionReplacement(support, current, snapshot, removedCategoryIds);
    let replacementContext = null;
    if (await exists(pendingPath)) {
      if (!hasFlag("--replace-pending")) fail("a pending refresh already exists; commit it or use explicit recovery");
      const pending = await readJson(pendingPath, "pending update");
      if (pending.baseRevision !== baseRevision) fail("existing pending refresh has a different base revision");
      replacementContext = await loadReplacementContext(support, pending, libraryItems, Boolean(libraryItemsPath));
    } else if (hasFlag("--replace-pending")) {
      fail("--replace-pending requires an existing pending refresh");
    }

    const snapshotText = serializedJson(snapshot);
    const snapshotSha256 = createHash("sha256").update(snapshotText).digest("hex");
    const generatedId = `refresh-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${snapshotSha256.slice(0, 8)}`;
    const refreshId = safeRefreshId(argument("--refresh-id") ?? generatedId);
    const stagedRoot = path.join(graphRoot, "staged");
    const stagePath = path.join(stagedRoot, refreshId);
    if (await exists(stagePath)) fail(`staged refresh already exists: ${refreshId}`);

    const paperDiff = diffItems(current.papers, snapshot.papers);
    const relationDiff = diffItems(current.relations, snapshot.relations);
    const categoryDiff = diffItems(current.categories, snapshot.categories);
    for (const item of libraryItems) {
      if (!snapshot.papers.some((paper) => paper.id === item.paperId)) {
        fail(`library item ${item.itemId} maps to missing staged paper ${item.paperId}`);
      }
    }
    const libraryUpdate = await prepareLibraryUpdate(support, libraryItems, refreshId, replacementContext);
    const readyLibraryItems = libraryUpdate?.manifestItems ?? [];
    const manifest = {
      schemaVersion: 2,
      graphSchemaVersion: snapshot.schemaVersion,
      refreshId,
      baseRevision,
      targetRevision,
      snapshotSha256,
      createdAt: new Date().toISOString(),
      papers: paperDiff,
      relations: relationDiff,
      categories: {
        ...categoryDiff,
        newCategories: newCategoryEvidence,
      },
      partitionDecision,
      libraryItems: readyLibraryItems,
      animation: { staggerMs, waveDurationMs },
    };
    const pending = {
      schemaVersion: 2,
      graphSchemaVersion: snapshot.schemaVersion,
      refreshId,
      baseRevision,
      targetRevision,
      snapshotSha256,
      snapshotPath: path.relative(support, path.join(stagePath, "snapshot.json")),
      manifestPath: path.relative(support, path.join(stagePath, "manifest.json")),
      addedPaperIds: paperDiff.added,
      addedRelationIds: relationDiff.added,
      diff: { papers: paperDiff, relations: relationDiff, categories: categoryDiff },
      partitionDecision,
      libraryItems: readyLibraryItems,
      animation: manifest.animation,
      createdAt: manifest.createdAt,
    };
    const tempStage = path.join(stagedRoot, `.tmp-${refreshId}-${randomUUID()}`);
    await mkdir(tempStage, { recursive: true });
    let libraryWritten = false;
    let pendingWritten = false;
    try {
      await writeFile(path.join(tempStage, "snapshot.json"), snapshotText, "utf8");
      await writeFile(path.join(tempStage, "manifest.json"), serializedJson(manifest), "utf8");
      await mkdir(stagedRoot, { recursive: true });
      await rename(tempStage, stagePath);
      if (libraryUpdate) {
        await atomicWrite(libraryUpdate.libraryPath, libraryUpdate.nextText);
        libraryWritten = true;
      }
      await atomicWrite(pendingPath, serializedJson(pending));
      pendingWritten = true;
    } catch (error) {
      if (libraryWritten && libraryUpdate) {
        await atomicWrite(libraryUpdate.libraryPath, libraryUpdate.originalText).catch(() => {});
      }
      if (!pendingWritten) await rm(stagePath, { recursive: true, force: true }).catch(() => {});
      await rm(tempStage, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    console.log(serializedJson({ status: "ready_to_refresh", manifest, pending }).trimEnd());
  });
}

main().catch((error) => {
  console.error(`stage-refresh: ${error.message}`);
  process.exitCode = 2;
});
