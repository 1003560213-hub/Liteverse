import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const universe = JSON.parse(
  await readFile(path.join(root, "data/universe.json"), "utf8"),
);

const ids = new Set();
const categoryIds = new Set(universe.categories.map((category) => category.id));
const errors = [];

const schemaV3 = universe.schemaVersion === "3.0.0";
if (!new Set(["2.0.0", "3.0.0"]).has(universe.schemaVersion)) {
  errors.push(`schemaVersion must be 2.0.0 or 3.0.0; received ${universe.schemaVersion}`);
}
if (!Number.isInteger(universe.revision) || universe.revision < 1) {
  errors.push("revision must be a positive integer");
}
const macroCategories = universe.categories.filter((category) => (category.kind ?? "macro") === "macro");
const systemCategories = universe.categories.filter((category) => category.kind === "system");
if (macroCategories.length > 10 || (!schemaV3 && macroCategories.length < 1)) {
  errors.push(`The macro-region count must satisfy the current schema's 0/1-10 constraint; received ${macroCategories.length}`);
}
if (systemCategories.length > 1 || systemCategories.some((category) => category.id !== "liteverse-staging")) {
  errors.push("Only one system staging region with the id liteverse-staging is allowed");
}
if (!schemaV3 && systemCategories.length) {
  errors.push("The system staging region requires schemaVersion 3.0.0");
}

const usagePolicy = universe.usagePolicy;
if (
  usagePolicy?.managedBy !== "liteverse-retriever" ||
  usagePolicy?.manualUpdates !== false ||
  usagePolicy?.initialValue !== 0 ||
  usagePolicy?.counter !== "useCount" ||
  usagePolicy?.dedupeScope !== "codex-task-paper" ||
  usagePolicy?.ledger !== "Usage/events.jsonl" ||
  usagePolicy?.cache !== "Usage/counts.json" ||
  usagePolicy?.visualNormalization?.type !== "log1p" ||
  usagePolicy?.visualNormalization?.referenceCount !== 32 ||
  usagePolicy?.regionAggregation !== "primary-category-mean"
) {
  errors.push(
    "usagePolicy must declare Retriever-only counting, task-paper deduplication, the audit ledger, and the log1p(32) mapping",
  );
}
if (Object.hasOwn(universe, "temperaturePolicy")) {
  errors.push("Legacy temperaturePolicy must not be retained");
}

const nebulaAssets = universe.visuals?.nebulaAssets || [];
if (universe.visuals?.nebulaAssetCatalogVersion !== 2) {
  errors.push("visuals.nebulaAssetCatalogVersion must be 2");
}
const nebulaAssetIds = new Set();
const nebulaAssetSources = new Set();
for (const asset of nebulaAssets) {
  if (!asset.id || nebulaAssetIds.has(asset.id)) {
    errors.push(`Duplicate or missing nebula asset id: ${asset.id || "(empty)"}`);
  }
  if (!asset.src || nebulaAssetSources.has(asset.src)) {
    errors.push(`Duplicate or missing nebula asset path: ${asset.src || "(empty)"}`);
  }
  nebulaAssetIds.add(asset.id);
  nebulaAssetSources.add(asset.src);
  if (!asset.src?.startsWith("./")) {
    errors.push(`${asset.id}: the nebula asset path must begin with ./`);
  } else {
    try {
      await access(path.join(root, "public", asset.src.slice(2)));
    } catch {
      errors.push(`${asset.id}: nebula artwork does not exist at ${asset.src}`);
    }
  }
}

if (!universe.visuals?.nebulaAssignmentSeed || nebulaAssets.length === 0) {
  errors.push("visuals.nebulaAssignmentSeed or nebulaAssets is missing");
}
if (nebulaAssets.filter((asset) => asset.enabled).length < 10) {
  errors.push("At least 10 enabled region-nebula assets are required to support 10 macro regions");
}

const categoryOrders = new Set();
const seenCategoryIds = new Set();
for (const category of universe.categories) {
  if (seenCategoryIds.has(category.id)) errors.push(`Duplicate category id: ${category.id}`);
  seenCategoryIds.add(category.id);
  if (!["macro", "system"].includes(category.kind ?? "macro")) {
    errors.push(`${category.id}: category.kind must be macro or system`);
  }
  if (category.kind === "system") continue;
  if (!nebulaAssetIds.has(category.nebulaAssetId)) {
    errors.push(`${category.id}: unknown nebula asset ${category.nebulaAssetId}`);
  }
  if (
    !Number.isInteger(category.nebulaAssignmentOrder) ||
    category.nebulaAssignmentOrder <= 0 ||
    categoryOrders.has(category.nebulaAssignmentOrder)
  ) {
    errors.push(`${category.id}: nebulaAssignmentOrder must be a unique positive integer`);
  }
  categoryOrders.add(category.nebulaAssignmentOrder);
}

const initialAssignments = [...macroCategories]
  .sort((left, right) => left.nebulaAssignmentOrder - right.nebulaAssignmentOrder)
  .slice(0, Math.min(nebulaAssets.filter((asset) => asset.enabled).length, universe.categories.length));
if (
  new Set(initialAssignments.map((category) => category.nebulaAssetId)).size !==
  initialAssignments.length
) {
  errors.push("Regions must use distinct enabled nebula assets before any artwork is reused");
}

for (const paper of universe.papers) {
  if (ids.has(paper.id)) errors.push(`Duplicate paper id: ${paper.id}`);
  ids.add(paper.id);
  if (
    !Number.isInteger(paper.useCount) ||
    paper.useCount < 0
  ) {
    errors.push(`${paper.id}: useCount must be a non-negative integer`);
  }
  if (
    Object.hasOwn(paper, "temperature") ||
    Object.hasOwn(paper, "baseHeat") ||
    Object.hasOwn(paper, "lifetimeUses")
  ) {
    errors.push(`${paper.id}: legacy temperature/baseHeat/lifetimeUses fields must not be retained`);
  }
  if (!categoryIds.has(paper.primaryCategory)) {
    errors.push(`${paper.id}: unknown primary category ${paper.primaryCategory}`);
  }
  if (
    universe.categories.find((category) => category.id === paper.primaryCategory)?.kind === "system" &&
    paper.classificationStatus !== "provisional"
  ) {
    errors.push(`${paper.id}: papers in the system staging region must be provisional`);
  }
  if (!Array.isArray(paper.categoryIds) || paper.categoryIds.length < 1 || paper.categoryIds.length > 2) {
    errors.push(`${paper.id}: exactly one primary region and at most one secondary region are required`);
  }
  if (!paper.categoryIds?.includes(paper.primaryCategory)) {
    errors.push(`${paper.id}: categoryIds must include primary category ${paper.primaryCategory}`);
  }
  if (new Set(paper.categoryIds || []).size !== (paper.categoryIds || []).length) {
    errors.push(`${paper.id}: categoryIds must not contain duplicates`);
  }
  for (const categoryId of paper.categoryIds || []) {
    if (!categoryIds.has(categoryId)) {
      errors.push(`${paper.id}: unknown category ${categoryId}`);
    }
  }
  if (paper.markdownPath !== `Knowledge/cards/${paper.id}.md`) {
    errors.push(`${paper.id}: markdownPath must point to the Application Support knowledge card`);
  }
  if (paper.fulltextPath !== `Knowledge/fulltext/${paper.id}.md`) {
    errors.push(`${paper.id}: fulltextPath must point to the page-marked full-text artifact`);
  }
  if (schemaV3) {
    const expectedPdf = `Library/PDFs/${paper.id}.pdf`;
    const expectedCard = `Knowledge/cards/${paper.id}.md`;
    const expectedFulltext = `Knowledge/fulltext/${paper.id}.md`;
    const verificationStates = new Set(["imported", "extracted", "needs_ocr", "card_draft", "evidence_verified", "needs_attention", "source_missing"]);
    const extractionStates = new Set(["pending", "extracted", "needs_ocr", "failed"]);
    const metadataStates = new Set(["provisional", "official_verified", "source_verified"]);
    if (Object.hasOwn(paper, "verified") || !verificationStates.has(paper.verificationStatus) || !metadataStates.has(paper.metadataStatus)) {
      errors.push(`${paper.id}: schema v3 requires an explicit verificationStatus and must not retain verified`);
    }
    if (
      paper.source?.pdfPath !== expectedPdf || paper.pdfPath !== expectedPdf ||
      !/^[a-f0-9]{64}$/.test(paper.source?.sha256 || "") ||
      !["pdf", "arxiv"].includes(paper.source?.kind)
    ) {
      errors.push(`${paper.id}: source must include the managed PDF path, source kind, and SHA-256`);
    }
    if (
      paper.artifacts?.cardPath !== expectedCard || paper.artifacts?.fulltextPath !== expectedFulltext ||
      paper.markdownPath !== expectedCard || paper.fulltextPath !== expectedFulltext ||
      !extractionStates.has(paper.artifacts?.extractionStatus) ||
      paper.artifacts?.cardSchemaVersion !== "liteverse-card-v1" ||
      !Number.isInteger(paper.artifacts?.evidenceCount) || paper.artifacts.evidenceCount < 0
    ) {
      errors.push(`${paper.id}: artifacts must declare card and full-text paths, extraction status, schema, and evidence count`);
    }
    if (
      paper.verificationStatus === "evidence_verified" &&
      (paper.artifacts?.extractionStatus !== "extracted" || paper.artifacts?.evidenceCount < 1 || paper.metadataStatus === "provisional")
    ) {
      errors.push(`${paper.id}: evidence_verified requires extracted full text and at least one evidence item`);
    }
  } else {
    for (const [kind, target] of [
      ["PDF", paper.pdfPath],
      ["Seed Markdown", path.join(root, "data", "papers", `${paper.id}.md`)],
    ]) {
      try {
        await access(target);
      } catch {
        errors.push(`${paper.id}: ${kind} does not exist at ${target}`);
      }
    }
  }
}

for (const relation of universe.relations) {
  if (!ids.has(relation.source)) {
    errors.push(`${relation.id}: source does not exist: ${relation.source}`);
  }
  if (!ids.has(relation.target)) {
    errors.push(`${relation.id}: target does not exist: ${relation.target}`);
  }
  if (!relation.note || !relation.status || !relation.evidence) {
    errors.push(`${relation.id}: note, status, or evidence is missing`);
  }
  if (
    relation.relationVersion === "legacy-unscored" ||
    relation.scoringStatus === "legacy_unscored"
  ) {
    if (
      relation.status !== "pending_scoring" ||
      relation.strength !== null ||
      relation.confidence !== null ||
      !Number.isFinite(relation.legacyConfidence) ||
      relation.legacyConfidence < 0 ||
      relation.legacyConfidence > 1
    ) {
      errors.push(`${relation.id}: a legacy relation must retain legacyConfidence and be marked pending_scoring`);
    }
    continue;
  }
  if (relation.rubric !== "liteverse-relation-v1") {
    errors.push(`${relation.id}: unknown relation-scoring version ${relation.rubric || relation.relationVersion}`);
    continue;
  }
  if (
    !Number.isInteger(relation.strength) || relation.strength < 0 || relation.strength > 100 ||
    !Number.isInteger(relation.confidence) || relation.confidence < 0 || relation.confidence > 100
  ) {
    errors.push(`${relation.id}: strength and confidence must be integers from 0 to 100`);
  }
  const expectedStatus = relation.formalEligible && relation.strength >= 60 && relation.confidence >= 75
    ? "verified"
    : relation.formalEligible && relation.strength >= 40 && relation.confidence >= 50
      ? "candidate"
      : "suggestion";
  if (relation.status !== expectedStatus) {
    errors.push(`${relation.id}: status must be ${expectedStatus}; received ${relation.status}`);
  }
  if (["candidate", "verified"].includes(relation.status)) {
    const locatedPaperIds = new Set(
      (Array.isArray(relation.evidence) ? relation.evidence : [])
        .filter((item) => {
          const locator = item?.locator || item;
          return ["page", "section", "equation", "figure", "table"].some(
            (field) => Number.isFinite(locator?.[field]) || Boolean(locator?.[field]?.trim?.()),
          );
        })
        .map((item) => item.paperId),
    );
    if (!locatedPaperIds.has(relation.source) || !locatedPaperIds.has(relation.target)) {
      errors.push(`${relation.id}: a visible relation requires precise source locations in both papers`);
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(
  `Literature-universe data is valid: ${universe.papers.length} papers, ${universe.relations.length} relations, and ${universe.categories.length} nebulae.`,
);
