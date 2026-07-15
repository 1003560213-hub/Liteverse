import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;

export function fail(message) {
  throw new Error(message);
}

export function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function stableText(value, pretty = false) {
  return `${JSON.stringify(stable(value), null, pretty ? 2 : 0)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function resolveSupport(explicit) {
  return path.resolve(
    explicit
      ?? process.env.LITEVERSE_SUPPORT_DIR
      ?? path.join(homedir(), "Library", "Application Support", "Liteverse"),
  );
}

export async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJsonWithText(filePath, label = filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") fail(`${label} does not exist: ${filePath}`);
    throw error;
  }
  try {
    return { value: JSON.parse(text), text };
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
}

export async function atomicWrite(filePath, text) {
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

export async function withLock(lockPath, callback) {
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

function artifactRecord(paper, label) {
  const integrity = paper?.artifacts?.integrity ?? paper?.artifact ?? paper?.integrity;
  object(integrity, `${label}.artifacts.integrity`);
  if (!Number.isInteger(integrity.artifactRevision) || integrity.artifactRevision < 1) {
    fail(`${label} lacks a positive artifactRevision`);
  }
  if (!SHA256.test(integrity.artifactSha256 ?? "")) fail(`${label} lacks a valid artifactSha256`);
  const record = {
    paperId: paper.id,
    artifactRevision: integrity.artifactRevision,
    artifactSha256: integrity.artifactSha256,
  };
  for (const field of ["sourceSha256", "cardSha256", "fulltextSha256", "claimsSha256"]) {
    const value = integrity[field];
    if (value !== undefined && value !== null && !SHA256.test(value)) {
      fail(`${label}.artifacts.integrity.${field} must be a lowercase SHA-256`);
    }
    record[field] = value ?? null;
  }
  return record;
}

export function paperArtifactFingerprint(papers, label = "papers") {
  if (!Array.isArray(papers)) fail(`${label} must be an array`);
  const seen = new Set();
  const records = papers.map((paper, index) => {
    object(paper, `${label}[${index}]`);
    if (typeof paper.id !== "string" || !paper.id) fail(`${label}[${index}].id must be a string`);
    if (seen.has(paper.id)) fail(`${label} contains duplicate paper ${paper.id}`);
    seen.add(paper.id);
    return artifactRecord(paper, `${label} paper ${paper.id}`);
  }).sort((left, right) => left.paperId.localeCompare(right.paperId));
  return sha256(stableText({ schema: "liteverse-paper-artifact-fingerprint-v1", papers: records }));
}

export function assignmentFingerprint(papers) {
  const assignments = [...papers].map((paper) => ({
    paperId: paper.id,
    primaryCategory: paper.primaryCategory,
    secondaryCategory: paper.secondaryCategory ?? null,
  })).sort((left, right) => left.paperId.localeCompare(right.paperId));
  return sha256(stableText({ schema: "liteverse-partition-assignments-v1", assignments }));
}

function categoryKind(category) {
  return category.kind ?? "macro";
}

function stableNebulaHash(value) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function isFiniteVector3(value) {
  return Array.isArray(value) && value.length === 3 && value.every((component) => Number.isFinite(component));
}

function roundedVector(vector) {
  return vector.map((component) => Number(component.toFixed(6)));
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function assignDeterministicPartitionLayout(source, current, categories, papers, seed) {
  const nextCategories = categories.map((category) => ({ ...category }));
  const currentPrimaryMembers = new Map();
  for (const paper of current?.papers ?? []) {
    if (!currentPrimaryMembers.has(paper.primaryCategory)) currentPrimaryMembers.set(paper.primaryCategory, []);
    currentPrimaryMembers.get(paper.primaryCategory).push(paper.id);
  }
  for (const members of currentPrimaryMembers.values()) members.sort();
  const nextPrimaryMembers = new Map();
  for (const paper of papers) {
    if (!nextPrimaryMembers.has(paper.primaryCategory)) nextPrimaryMembers.set(paper.primaryCategory, []);
    nextPrimaryMembers.get(paper.primaryCategory).push(paper.id);
  }
  for (const members of nextPrimaryMembers.values()) members.sort();
  const currentById = new Map((current?.categories ?? []).map((category) => [category.id, category]));
  const sourceById = new Map((source?.categories ?? []).map((category) => [category.id, category]));
  const macroIndexes = nextCategories
    .map((category, index) => ({ category, index }))
    .filter(({ category }) => categoryKind(category) === "macro")
    .map(({ index }) => index);
  const usedCenters = [];
  const unresolved = [];
  for (const index of macroIndexes) {
    const category = nextCategories[index];
    const currentCategory = currentById.get(category.id);
    const oldMembers = currentPrimaryMembers.get(category.id) ?? [];
    const newMembers = nextPrimaryMembers.get(category.id) ?? [];
    if (currentCategory && sameMembers(oldMembers, newMembers) && isFiniteVector3(currentCategory.center)) {
      category.center = roundedVector(currentCategory.center);
      usedCenters.push(category.center);
    } else {
      delete category.center;
      unresolved.push(index);
    }
  }
  const layoutSeed = typeof seed === "string" && seed ? seed : "liteverse-partition-layout-v1";
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const candidateCount = 192;
  const offset = stableNebulaHash(`${layoutSeed}:centers`) % candidateCount;
  const phase = (stableNebulaHash(`${layoutSeed}:phase`) / 0x1_0000_0000) * Math.PI * 2;
  const candidates = Array.from({ length: candidateCount }, (_, rawIndex) => {
    const index = (rawIndex + offset) % candidateCount;
    const unitZ = 1 - (2 * (index + 0.5)) / candidateCount;
    const planar = Math.sqrt(Math.max(0, 1 - unitZ * unitZ));
    const angle = phase + index * goldenAngle;
    return roundedVector([
      3.8 * planar * Math.cos(angle),
      2.55 * planar * Math.sin(angle),
      0.95 * unitZ,
    ]);
  });
  for (const [unresolvedOrder, categoryIndex] of unresolved.entries()) {
    const category = nextCategories[categoryIndex];
    let selected;
    if (macroIndexes.length === 1 && usedCenters.length === 0) {
      selected = [0, 0, 0];
    } else if (usedCenters.length === 0 && unresolvedOrder === 0) {
      selected = candidates[0];
    } else {
      let bestDistance = -1;
      for (const candidate of candidates) {
        const minimumDistance = Math.min(...usedCenters.map((center) => {
          const x = (candidate[0] - center[0]) / 3.8;
          const y = (candidate[1] - center[1]) / 2.55;
          const z = (candidate[2] - center[2]) / 0.95;
          return x * x + y * y + z * z;
        }));
        if (minimumDistance > bestDistance) {
          bestDistance = minimumDistance;
          selected = candidate;
        }
      }
    }
    if (!isFiniteVector3(selected)) fail(`could not generate a finite center for category ${category.id}`);
    category.center = roundedVector(selected);
    usedCenters.push(category.center);
  }
  for (const category of nextCategories) {
    if (categoryKind(category) !== "system") continue;
    const existing = currentById.get(category.id) ?? sourceById.get(category.id);
    category.center = isFiniteVector3(existing?.center) ? roundedVector(existing.center) : [0, -3.15, -0.85];
  }

  const categoryCenters = new Map(nextCategories.map((category) => [category.id, category.center]));
  const papersByCategory = new Map();
  for (const paper of papers) {
    if (!papersByCategory.has(paper.primaryCategory)) papersByCategory.set(paper.primaryCategory, []);
    papersByCategory.get(paper.primaryCategory).push(paper);
  }
  const positions = new Map();
  const occupied = new Set();
  for (const [categoryId, members] of papersByCategory) {
    const center = categoryCenters.get(categoryId);
    if (!isFiniteVector3(center)) fail(`paper category ${categoryId} lacks a finite center`);
    members.sort((left, right) => {
      const difference = stableNebulaHash(`${layoutSeed}:paper:${left.id}`)
        - stableNebulaHash(`${layoutSeed}:paper:${right.id}`);
      return difference || left.id.localeCompare(right.id);
    });
    const count = members.length;
    const cloudRadius = Math.min(1.15, 0.48 + 0.09 * Math.sqrt(count));
    const categoryPhase = (stableNebulaHash(`${layoutSeed}:cloud:${categoryId}`) / 0x1_0000_0000) * Math.PI * 2;
    members.forEach((paper, rank) => {
      const radialFraction = 0.32 + 0.68 * Math.cbrt((rank + 0.5) / count);
      const unitZ = 1 - (2 * (rank + 0.5)) / count;
      const planar = Math.sqrt(Math.max(0, 1 - unitZ * unitZ));
      const angle = categoryPhase + rank * goldenAngle;
      const radius = cloudRadius * radialFraction;
      const position = roundedVector([
        center[0] + radius * planar * Math.cos(angle),
        center[1] + radius * 0.82 * planar * Math.sin(angle),
        center[2] + radius * 0.72 * unitZ,
      ]);
      let key = position.join(",");
      let collisionIndex = 0;
      while (occupied.has(key)) {
        collisionIndex += 1;
        position[2] = Number((position[2] + collisionIndex * 0.000001).toFixed(6));
        key = position.join(",");
      }
      occupied.add(key);
      positions.set(paper.id, position);
    });
  }
  return {
    categories: nextCategories,
    papers: papers.map((paper) => ({ ...paper, position: positions.get(paper.id) })),
  };
}

export function assignCategoryNebulaAssets(source, current, categories) {
  const sourceVisuals = source?.visuals ?? {};
  const currentVisuals = current?.visuals ?? {};
  const sourceAssets = Array.isArray(sourceVisuals.nebulaAssets) ? sourceVisuals.nebulaAssets : [];
  const currentAssets = Array.isArray(currentVisuals.nebulaAssets) ? currentVisuals.nebulaAssets : [];
  const assets = sourceAssets.length ? sourceAssets : currentAssets;
  const enabledAssets = assets.filter((asset) => asset?.enabled === true && typeof asset.id === "string" && asset.id);
  if (!enabledAssets.length) fail("partition choice requires at least one enabled nebula asset");
  if (new Set(enabledAssets.map((asset) => asset.id)).size !== enabledAssets.length) {
    fail("nebula asset catalog contains duplicate enabled IDs");
  }
  const validAssetIds = new Set(enabledAssets.map((asset) => asset.id));
  const seed = sourceVisuals.nebulaAssignmentSeed ?? currentVisuals.nebulaAssignmentSeed ?? "liteverse-nebula";
  const currentMacros = (current?.categories ?? []).filter((category) => categoryKind(category) === "macro");
  const currentById = new Map(currentMacros.map((category) => [category.id, category]));
  const sourceById = new Map(
    (source?.categories ?? []).filter((category) => categoryKind(category) === "macro").map((category) => [category.id, category]),
  );
  const usage = new Map(enabledAssets.map((asset) => [asset.id, 0]));
  let maximumOrder = 0;
  for (const category of currentMacros) {
    if (validAssetIds.has(category.nebulaAssetId)) {
      usage.set(category.nebulaAssetId, usage.get(category.nebulaAssetId) + 1);
    }
    if (Number.isInteger(category.nebulaAssignmentOrder) && category.nebulaAssignmentOrder > maximumOrder) {
      maximumOrder = category.nebulaAssignmentOrder;
    }
  }
  const usedOrders = new Set();
  const unresolved = [];
  const resolved = categories.map((rawCategory, index) => {
    const category = { ...rawCategory };
    if (categoryKind(category) === "system") {
      delete category.nebulaAssetId;
      delete category.nebulaAssignmentOrder;
      return category;
    }
    const existing = currentById.get(category.id) ?? sourceById.get(category.id);
    if (existing && validAssetIds.has(existing.nebulaAssetId)
        && Number.isInteger(existing.nebulaAssignmentOrder) && existing.nebulaAssignmentOrder > 0) {
      if (usedOrders.has(existing.nebulaAssignmentOrder)) {
        fail(`reused category ${category.id} has a duplicate nebulaAssignmentOrder`);
      }
      category.nebulaAssetId = existing.nebulaAssetId;
      category.nebulaAssignmentOrder = existing.nebulaAssignmentOrder;
      usedOrders.add(existing.nebulaAssignmentOrder);
    } else {
      delete category.nebulaAssetId;
      delete category.nebulaAssignmentOrder;
      unresolved.push(index);
    }
    return category;
  });
  for (const index of unresolved) {
    const category = resolved[index];
    const minimumUsage = Math.min(...usage.values());
    const candidates = enabledAssets
      .filter((asset) => usage.get(asset.id) === minimumUsage)
      .sort((left, right) => {
        const difference = stableNebulaHash(`${seed}:${category.id}:${left.id}`)
          - stableNebulaHash(`${seed}:${category.id}:${right.id}`);
        return difference || left.id.localeCompare(right.id);
      });
    const selected = candidates[0];
    if (!selected) fail(`could not assign a nebula asset to category ${category.id}`);
    do maximumOrder += 1;
    while (usedOrders.has(maximumOrder));
    category.nebulaAssetId = selected.id;
    category.nebulaAssignmentOrder = maximumOrder;
    usedOrders.add(maximumOrder);
    usage.set(selected.id, usage.get(selected.id) + 1);
  }
  return {
    categories: resolved,
    visuals: {
      ...currentVisuals,
      ...sourceVisuals,
      nebulaAssignmentSeed: seed,
      nebulaAssets: assets,
    },
  };
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be non-empty text`);
  return value.trim();
}

function validateCategory(category, label, currentMacros, paperIds, assignments) {
  object(category, label);
  if (!SAFE_ID.test(category.id ?? "")) fail(`${label}.id must be a safe lowercase ID`);
  const kind = categoryKind(category);
  if (!new Set(["macro", "system"]).has(kind)) fail(`${label}.kind must be macro or system`);
  if (kind === "system" && category.id !== "liteverse-staging") {
    fail(`${label} uses unsupported system category ${category.id}`);
  }
  requireText(category.name, `${label}.name`);
  requireText(category.description, `${label}.description`);
  if (kind === "macro" && (typeof category.color !== "string" || !/^#[a-fA-F0-9]{6}$/.test(category.color))) {
    fail(`${label}.color must be a six-digit hex color`);
  }
  const current = currentMacros.get(category.id);
  if (current) {
    if (current.name !== category.name || (current.description ?? "") !== category.description) {
      fail(`${label} reuses current ID ${category.id} with a different name or scope`);
    }
    return;
  }
  if (kind !== "macro") return;
  const members = assignments.filter((assignment) => assignment.primaryCategory === category.id).map((assignment) => assignment.paperId).sort();
  if (members.length < 4) fail(`new macro category ${category.id} requires at least four primary papers`);
  const creation = object(category.creationEvidence, `${label}.creationEvidence`);
  const recordedMembers = Array.isArray(creation.memberIds) ? [...creation.memberIds].sort() : fail(`${label}.creationEvidence.memberIds must be an array`);
  if (recordedMembers.some((id) => typeof id !== "string" || !paperIds.has(id))) {
    fail(`${label}.creationEvidence.memberIds contains an unknown paper`);
  }
  if (new Set(recordedMembers).size !== recordedMembers.length || JSON.stringify(recordedMembers) !== JSON.stringify(members)) {
    fail(`${label}.creationEvidence.memberIds must exactly match its primary papers`);
  }
  if (!Number.isFinite(creation.clusterConsistency) || creation.clusterConsistency < 70 || creation.clusterConsistency > 100) {
    fail(`${label}.creationEvidence.clusterConsistency must be 70..100`);
  }
  requireText(creation.scopeDefinition, `${label}.creationEvidence.scopeDefinition`);
  const scores = object(creation.existingRegionMatchScores, `${label}.creationEvidence.existingRegionMatchScores`);
  for (const paperId of members) {
    const memberScores = object(scores[paperId], `${label}.creationEvidence.existingRegionMatchScores.${paperId}`);
    for (const oldId of currentMacros.keys()) {
      if (!Object.hasOwn(memberScores, oldId)) {
        fail(`${label} lacks ${oldId} match score for ${paperId}`);
      }
    }
    if (Object.keys(memberScores).some((oldId) => !currentMacros.has(oldId))) {
      fail(`${label} has an unknown existing-region score for ${paperId}`);
    }
    if (Object.values(memberScores).some((score) => !Number.isFinite(score) || score < 0 || score > 100)) {
      fail(`${label} existing-region scores for ${paperId} must be 0..100`);
    }
  }
}

function normalizeAssignment(raw, label) {
  object(raw, label);
  if (typeof raw.paperId !== "string" || !raw.paperId) fail(`${label}.paperId must be a string`);
  if (typeof raw.primaryCategory !== "string" || !raw.primaryCategory) fail(`${label}.primaryCategory must be a string`);
  if (raw.secondaryCategory !== undefined && raw.secondaryCategory !== null) {
    if (typeof raw.secondaryCategory !== "string" || !raw.secondaryCategory) {
      fail(`${label}.secondaryCategory must be a string when present`);
    }
    if (raw.secondaryCategory === raw.primaryCategory) fail(`${label} secondaryCategory must differ from primaryCategory`);
  }
  const status = raw.classificationStatus ?? "classified";
  if (!new Set(["classified", "provisional"]).has(status)) {
    fail(`${label}.classificationStatus must be classified or provisional`);
  }
  const evidenceIds = Array.isArray(raw.evidenceIds) ? raw.evidenceIds : fail(`${label}.evidenceIds must be an array`);
  if (!evidenceIds.length || evidenceIds.some((id) => typeof id !== "string" || !id.trim())) {
    fail(`${label}.evidenceIds must contain at least one evidence or claim ID`);
  }
  return {
    paperId: raw.paperId,
    primaryCategory: raw.primaryCategory,
    secondaryCategory: raw.secondaryCategory ?? null,
    classificationStatus: status,
    rationale: requireText(raw.rationale, `${label}.rationale`),
    evidenceIds: [...new Set(evidenceIds.map((id) => id.trim()))].sort(),
  };
}

function normalizeTradeoffs(value, label) {
  object(value, label);
  const normalizeList = (items, field) => {
    if (!Array.isArray(items) || !items.length) fail(`${label}.${field} must be a non-empty array`);
    return items.map((item, index) => requireText(item, `${label}.${field}[${index}]`));
  };
  return {
    strengths: normalizeList(value.strengths, "strengths"),
    limitations: normalizeList(value.limitations, "limitations"),
  };
}

function partitionDifference(left, right, paperIds) {
  const leftMap = new Map(left.assignments.map((item) => [item.paperId, item.primaryCategory]));
  const rightMap = new Map(right.assignments.map((item) => [item.paperId, item.primaryCategory]));
  let pairCount = 0;
  let changedPairs = 0;
  for (let first = 0; first < paperIds.length; first += 1) {
    for (let second = first + 1; second < paperIds.length; second += 1) {
      pairCount += 1;
      const leftTogether = leftMap.get(paperIds[first]) === leftMap.get(paperIds[second]);
      const rightTogether = rightMap.get(paperIds[first]) === rightMap.get(paperIds[second]);
      if (leftTogether !== rightTogether) changedPairs += 1;
    }
  }
  const ratio = pairCount ? changedPairs / pairCount : 0;
  return { leftOptionId: left.optionId, rightOptionId: right.optionId, changedPairs, pairCount, ratio };
}

export function validatePartitionOptions(current, snapshot, input) {
  object(current, "current graph");
  object(snapshot, "source snapshot");
  object(input, "partition option input");
  if (!Number.isInteger(current.revision) || current.revision < 1) fail("current graph revision must be positive");
  const papers = Array.isArray(snapshot.papers) ? snapshot.papers : fail("source snapshot papers must be an array");
  const paperIds = papers.map((paper) => paper.id).sort();
  if (!paperIds.length) fail("partition proposals require at least one paper");
  if (new Set(paperIds).size !== paperIds.length || paperIds.some((id) => typeof id !== "string" || !id)) {
    fail("source snapshot paper IDs must be unique non-empty strings");
  }
  const paperIdSet = new Set(paperIds);
  const queries = Array.isArray(input.retrievalQueries) ? input.retrievalQueries : fail("retrievalQueries must be an array");
  if (!queries.length) fail("retrievalQueries must record at least one corpus search");
  const retrievalQueries = queries.map((query, index) => {
    object(query, `retrievalQueries[${index}]`);
    const consideredPaperIds = Array.isArray(query.consideredPaperIds)
      ? [...new Set(query.consideredPaperIds)].sort()
      : fail(`retrievalQueries[${index}].consideredPaperIds must be an array`);
    if (consideredPaperIds.some((id) => !paperIdSet.has(id))) {
      fail(`retrievalQueries[${index}] references an unknown paper`);
    }
    return {
      query: requireText(query.query, `retrievalQueries[${index}].query`),
      consideredPaperIds,
      summary: requireText(query.summary, `retrievalQueries[${index}].summary`),
    };
  });
  const searchedPaperIds = [...new Set(retrievalQueries.flatMap((query) => query.consideredPaperIds))].sort();
  if (JSON.stringify(searchedPaperIds) !== JSON.stringify(paperIds)) {
    fail("retrievalQueries must collectively cover every paper in the locked corpus");
  }
  const rawOptions = Array.isArray(input.options) ? input.options : fail("options must be an array");
  if (rawOptions.length !== 3) fail("a partition proposal must contain exactly three options");
  const currentMacros = new Map(
    (current.categories ?? []).filter((category) => categoryKind(category) === "macro").map((category) => [category.id, category]),
  );
  const optionIds = new Set();
  const options = rawOptions.map((raw, optionIndex) => {
    object(raw, `options[${optionIndex}]`);
    if (!SAFE_ID.test(raw.optionId ?? "")) fail(`options[${optionIndex}].optionId must be a safe lowercase ID`);
    if (optionIds.has(raw.optionId)) fail(`duplicate option ID ${raw.optionId}`);
    optionIds.add(raw.optionId);
    const categories = Array.isArray(raw.categories) ? raw.categories : fail(`option ${raw.optionId}.categories must be an array`);
    const categoryIds = new Set();
    for (const category of categories) {
      if (categoryIds.has(category?.id)) fail(`option ${raw.optionId} contains duplicate category ${category.id}`);
      categoryIds.add(category?.id);
    }
    const macros = categories.filter((category) => categoryKind(category) === "macro");
    const systems = categories.filter((category) => categoryKind(category) === "system");
    if (macros.length < 1 || macros.length > 10) fail(`option ${raw.optionId} must contain 1..10 macro categories`);
    if (systems.length > 1) fail(`option ${raw.optionId} may contain at most one system staging category`);
    const rawAssignments = Array.isArray(raw.assignments) ? raw.assignments : fail(`option ${raw.optionId}.assignments must be an array`);
    const assignments = rawAssignments.map((item, index) => normalizeAssignment(item, `option ${raw.optionId}.assignments[${index}]`));
    const assignedIds = assignments.map((item) => item.paperId).sort();
    if (new Set(assignedIds).size !== assignedIds.length || JSON.stringify(assignedIds) !== JSON.stringify(paperIds)) {
      fail(`option ${raw.optionId} assignments must cover every paper exactly once and contain no extras`);
    }
    for (const assignment of assignments) {
      if (!categoryIds.has(assignment.primaryCategory)) fail(`option ${raw.optionId} paper ${assignment.paperId} has unknown primaryCategory`);
      if (assignment.secondaryCategory && !categoryIds.has(assignment.secondaryCategory)) {
        fail(`option ${raw.optionId} paper ${assignment.paperId} has unknown secondaryCategory`);
      }
      const primary = categories.find((category) => category.id === assignment.primaryCategory);
      if (categoryKind(primary) === "system" && assignment.classificationStatus !== "provisional") {
        fail(`option ${raw.optionId} paper ${assignment.paperId} in liteverse-staging must be provisional`);
      }
    }
    for (const category of categories) {
      if (!assignments.some((assignment) => assignment.primaryCategory === category.id)) {
        fail(`option ${raw.optionId} contains empty category ${category.id}`);
      }
    }
    for (const [categoryIndex, category] of categories.entries()) {
      validateCategory(category, `option ${raw.optionId}.categories[${categoryIndex}]`, currentMacros, paperIdSet, assignments);
    }
    return {
      optionId: raw.optionId,
      name: requireText(raw.name, `option ${raw.optionId}.name`),
      strategy: requireText(raw.strategy, `option ${raw.optionId}.strategy`),
      summary: requireText(raw.summary ?? raw.rationale, `option ${raw.optionId}.summary`),
      rationale: requireText(raw.rationale, `option ${raw.optionId}.rationale`),
      tradeoffs: normalizeTradeoffs(raw.tradeoffs, `option ${raw.optionId}.tradeoffs`),
      categories: stable(categories),
      assignments: assignments.sort((left, right) => left.paperId.localeCompare(right.paperId)),
    };
  });
  if (new Set(options.map((option) => option.strategy.toLowerCase())).size !== 3) {
    fail("all three partition options must describe distinct strategies");
  }
  const differences = [];
  for (let left = 0; left < options.length; left += 1) {
    for (let right = left + 1; right < options.length; right += 1) {
      const difference = partitionDifference(options[left], options[right], paperIds);
      const minimumChangedPairs = Math.max(1, Math.ceil(difference.pairCount * 0.15));
      if (difference.changedPairs < minimumChangedPairs) {
        fail(`options ${difference.leftOptionId} and ${difference.rightOptionId} are not materially distinct`);
      }
      differences.push({ ...difference, minimumChangedPairs });
    }
  }
  return {
    searchSummary: requireText(input.searchSummary, "searchSummary"),
    metadata: input.metadata === undefined || input.metadata === null ? null : stable(object(input.metadata, "metadata")),
    retrievalQueries,
    options,
    materialDifferences: differences,
    paperIds,
  };
}

export function assertOutsideGraph(support, outputPath, label) {
  const graphRoot = path.join(support, "Graph");
  const resolved = path.resolve(outputPath);
  const relative = path.relative(graphRoot, resolved);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    fail(`${label} must be an ordinary unstaged file outside the Graph directory`);
  }
  return resolved;
}

export function validateDecisionRecord(record, snapshot, current) {
  object(record, "partition decision record");
  if (record.schemaVersion !== "liteverse-partition-decision-v1" || record.kind !== "partition_decision") {
    fail("partition decision record has an unsupported schema");
  }
  if (record.baseRevision !== current.revision) fail("partition decision baseRevision no longer matches current graph");
  const currentFingerprint = paperArtifactFingerprint(current.papers ?? [], "current graph papers");
  if (record.currentArtifactFingerprint !== currentFingerprint) {
    fail("partition decision current paper artifact fingerprint no longer matches");
  }
  const corpusFingerprint = paperArtifactFingerprint(snapshot.papers ?? [], "partition snapshot papers");
  if (record.corpusArtifactFingerprint !== corpusFingerprint) {
    fail("partition decision corpus artifact fingerprint no longer matches");
  }
  const categoryIds = (snapshot.categories ?? []).map((category) => category.id).sort();
  if (JSON.stringify(record.selectedCategoryIds) !== JSON.stringify(categoryIds)) {
    fail("partition decision selected categories do not match the snapshot");
  }
  if (record.paperAssignmentsSha256 !== assignmentFingerprint(snapshot.papers ?? [])) {
    fail("partition decision paper assignments do not match the snapshot");
  }
  return record;
}

export async function appendDecision(support, record) {
  const ledgerPath = path.join(support, "Planning", "partition-decisions.jsonl");
  const line = stableText(record);
  await withLock(path.join(support, ".locks", "partition-decision.lock"), async () => {
    let existing = "";
    try {
      existing = await readFile(ledgerPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const records = existing.split("\n").filter(Boolean).map((raw, index) => {
      try {
        return JSON.parse(raw);
      } catch (error) {
        fail(`partition decision ledger line ${index + 1} is invalid JSON: ${error.message}`);
      }
    });
    const duplicate = records.find((item) => item.decisionId === record.decisionId);
    if (duplicate) {
      if (stableText(duplicate) !== line) fail(`partition decision ID collision: ${record.decisionId}`);
      return;
    }
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const handle = await open(ledgerPath, "a", 0o600);
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  return { path: ledgerPath, relativePath: "Planning/partition-decisions.jsonl", recordSha256: sha256(line) };
}

export async function findDecisionRecord(support, pointer) {
  object(pointer, "snapshot.partitionDecision");
  if (pointer.decisionRecordPath !== "Planning/partition-decisions.jsonl") {
    fail("partition decision must reference the managed append-only decision ledger");
  }
  const ledgerPath = path.join(support, pointer.decisionRecordPath);
  const { text } = await readJsonLines(ledgerPath, "partition decision ledger");
  const lines = text.split("\n").filter(Boolean);
  const matches = [];
  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail(`partition decision ledger line ${index + 1} is invalid JSON: ${error.message}`);
    }
    if (record.decisionId === pointer.decisionId) matches.push({ record, line: `${JSON.stringify(stable(record))}\n` });
  }
  if (matches.length !== 1) fail(`partition decision ${pointer.decisionId} must appear exactly once in the ledger`);
  if (sha256(matches[0].line) !== pointer.recordSha256) fail("partition decision record hash does not match the snapshot pointer");
  for (const field of ["proposalSetId", "optionId", "baseRevision", "currentArtifactFingerprint", "corpusArtifactFingerprint"]) {
    if (matches[0].record[field] !== pointer[field]) fail(`partition decision pointer ${field} does not match its record`);
  }
  return matches[0].record;
}

async function readJsonLines(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") fail(`${label} does not exist`);
    throw error;
  }
  return { text };
}
