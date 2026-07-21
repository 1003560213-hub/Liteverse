#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  atomicWriteJson,
  BATCH_SCHEMA,
  batchPaperProjection,
  candidateCharacters,
  CHECKPOINT_SCHEMA,
  fail,
  fileSha,
  loadPreparedItem,
  object,
  preparedPin,
  readJsonBytes,
  readOptionalJson,
  sha256Text,
  stableJson,
  withPlanningLock,
} from "./_review-batch-common.mjs";

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argumentsFor(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag) values.push(process.argv[index + 1]);
  }
  return values.filter((value) => value !== undefined);
}

function integerArgument(flag, fallback, minimum, maximum) {
  const raw = argument(flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${flag} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function usage() {
  console.log(`Usage: build-review-batch.mjs [--support-dir DIR] [--item ID ...]
       [--char-budget N] [--max-papers 3..5] [--allow-partial] [--json]

Validate committed local-preparation outputs and build one deterministic,
routing-only Curator review batch. A batch contains 3-5 papers by default and
resumes the exact active batch until apply-review-batch.mjs commits it.`);
}

const scientificCoverageOrder = Object.freeze([
  "research_question",
  "method",
  "result",
  "limitation",
  "assumption",
  "equation",
]);

function clipContext(value, limit) {
  if (limit <= 0 || !value) return null;
  if (value.length <= limit) return value;
  if (limit <= 1) return "…";
  return `${value.slice(0, limit - 1)}…`;
}

function fitContextOnly(candidate, budget) {
  // candidate.text is source-pinned by its character range. Truncating it would
  // silently detach the review decision from the original anchor, so only the
  // optional neighbouring context may be clipped.
  const baseCost = candidate.text.length + candidate.sourceAnchor.locator.length;
  if (baseCost > budget) return null;
  const contextBudget = budget - baseCost;
  const previousLimit = Math.floor(contextBudget / 2);
  const previous = clipContext(candidate.context.previous, previousLimit);
  const next = clipContext(candidate.context.next, contextBudget - (previous?.length ?? 0));
  return { ...candidate, context: { previous, next } };
}

function candidateBaseCost(candidate) {
  return candidate.text.length + candidate.sourceAnchor.locator.length;
}

function bestFirstCandidate(paper) {
  const core = paper.candidates.filter((candidate) => scientificCoverageOrder.includes(candidate.kind));
  return [...core].sort((left, right) =>
    right.routingScore - left.routingScore
      || candidateBaseCost(left) - candidateBaseCost(right)
      || left.candidateId.localeCompare(right.candidateId))[0] ?? null;
}

function selectCandidates(prepared, characterBudget) {
  const selected = prepared.map(() => []);
  const selectedIds = prepared.map(() => new Set());
  let used = 0;

  const firstCandidates = prepared.map(bestFirstCandidate);
  for (let paperIndex = 0; paperIndex < firstCandidates.length; paperIndex += 1) {
    if (!firstCandidates[paperIndex]) {
      fail(`paper ${prepared[paperIndex].paperId} has no scientific routing candidate; inspect its extraction before review`);
    }
  }
  const minimumRequired = firstCandidates.reduce((total, candidate) =>
    total + (candidate ? candidateBaseCost(candidate) : 0), 0);
  if (minimumRequired > characterBudget) {
    fail(`--char-budget is too small to retain one complete source-pinned candidate per paper (minimum ${minimumRequired})`);
  }
  for (let paperIndex = 0; paperIndex < prepared.length; paperIndex += 1) {
    const candidate = firstCandidates[paperIndex];
    if (!candidate) continue;
    const papersRemaining = prepared.length - paperIndex;
    const fairBudget = Math.max(candidateBaseCost(candidate), Math.floor((characterBudget - used) / papersRemaining));
    const fitted = fitContextOnly(candidate, fairBudget);
    selected[paperIndex].push(fitted);
    selectedIds[paperIndex].add(candidate.candidateId);
    used += candidateCharacters(fitted);
  }

  const byKind = prepared.map((paper) => new Map(scientificCoverageOrder.map((kind) => [
    kind,
    paper.candidates.filter((candidate) => candidate.kind === kind),
  ])));
  // Rotate the starting kind between papers. Under a tight budget, the batch
  // still covers different scientific facets instead of spending every paper's
  // allowance on a block of research-question candidates.
  for (let round = 0; round < scientificCoverageOrder.length; round += 1) {
    for (let paperIndex = 0; paperIndex < prepared.length; paperIndex += 1) {
      const kind = scientificCoverageOrder[(round + paperIndex) % scientificCoverageOrder.length];
      const candidate = byKind[paperIndex].get(kind)
        .find((entry) => !selectedIds[paperIndex].has(entry.candidateId));
      if (!candidate) continue;
      const fitted = fitContextOnly(candidate, characterBudget - used);
      if (!fitted) continue;
      selected[paperIndex].push(fitted);
      selectedIds[paperIndex].add(candidate.candidateId);
      used += candidateCharacters(fitted);
    }
  }

  const remaining = prepared.map((paper, paperIndex) => paper.candidates
    .filter((candidate) => scientificCoverageOrder.includes(candidate.kind))
    .filter((candidate) => !selectedIds[paperIndex].has(candidate.candidateId))
    .sort((left, right) => right.routingScore - left.routingScore
      || candidateBaseCost(left) - candidateBaseCost(right)
      || left.candidateId.localeCompare(right.candidateId)));
  const cursors = prepared.map(() => 0);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let paperIndex = 0; paperIndex < prepared.length; paperIndex += 1) {
      while (cursors[paperIndex] < remaining[paperIndex].length) {
        const candidate = remaining[paperIndex][cursors[paperIndex]++];
        const fitted = fitContextOnly(candidate, characterBudget - used);
        if (!fitted) continue;
        selected[paperIndex].push(fitted);
        selectedIds[paperIndex].add(candidate.candidateId);
        used += candidateCharacters(fitted);
        progressed = true;
        break;
      }
    }
  }
  for (const candidates of selected) candidates.sort((left, right) =>
    left.sourceAnchor.page - right.sourceAnchor.page
      || (left.sourceAnchor.characterRange?.start ?? left.sourceAnchor.ordinal)
        - (right.sourceAnchor.characterRange?.start ?? right.sourceAnchor.ordinal)
      || left.candidateId.localeCompare(right.candidateId));
  return { selected, used };
}

function batchFrom(prepared, characterBudget) {
  const { selected, used } = selectCandidates(prepared, characterBudget);
  const sourcePins = prepared.map(preparedPin);
  const inputFingerprint = sha256Text(stableJson(sourcePins));
  const core = {
    schemaVersion: BATCH_SCHEMA,
    inputFingerprint,
    constraints: {
      paperCountMinimum: 3,
      paperCountMaximum: 5,
      characterBudget,
      candidateCharacters: used,
    },
    papers: prepared.map((paper, index) => batchPaperProjection(paper, selected[index])),
    guardrails: {
      candidatePurpose: "routing_only",
      candidateStatus: "provisional",
      originalSourceEvidence: false,
      verifiedClaims: false,
      formalRelationships: false,
      writesGraph: false,
      writesUsage: false,
      writesResearchMemory: false,
    },
  };
  const batchId = `review-${sha256Text(stableJson(core)).slice(0, 24)}`;
  return { ...core, batchId };
}

async function validateActiveBatch(support, planningRoot, checkpoint, itemById) {
  const active = object(checkpoint.activeBatch, "checkpoint.activeBatch");
  const batchPath = path.join(planningRoot, "review-batches", active.batchId, "batch.json");
  if (await fileSha(batchPath) !== active.batchSha256) fail("active review batch hash mismatch");
  const batch = object((await readJsonBytes(batchPath, "active review batch")).value, "active review batch");
  if (batch.schemaVersion !== BATCH_SCHEMA || batch.batchId !== active.batchId) fail("active review batch identity mismatch");
  for (const paper of batch.papers ?? []) {
    const item = itemById.get(paper.itemId);
    if (!item) fail(`active review batch item ${paper.itemId} is no longer present`);
    const live = await loadPreparedItem(support, item);
    const expected = preparedPin(live);
    const pinned = Object.fromEntries(Object.keys(expected).map((key) => [key, paper[key]]));
    if (stableJson(expected) !== stableJson(pinned)) fail(`active review batch item ${paper.itemId} is stale`);
  }
  return { batch, batchPath, batchSha256: active.batchSha256, resumed: true };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const support = path.resolve(
    argument("--support-dir")
      ?? process.env.LITEVERSE_SUPPORT_DIR
      ?? path.join(homedir(), "Library", "Application Support", "Liteverse"),
  );
  const charBudget = integerArgument("--char-budget", 36_000, 3_000, 250_000);
  const maxPapers = integerArgument("--max-papers", 5, 3, 5);
  const requestedItems = new Set(argumentsFor("--item"));
  const allowPartial = process.argv.includes("--allow-partial");
  const library = object((await readJsonBytes(path.join(support, "library.json"), "library.json")).value, "library.json");
  if (!Array.isArray(library.items)) fail("library.json must contain an items array");
  const itemById = new Map();
  for (const item of library.items) {
    if (typeof item?.id !== "string" || !item.id || itemById.has(item.id)) fail("library.json contains a missing or duplicate item ID");
    itemById.set(item.id, item);
  }
  for (const itemId of requestedItems) {
    if (!itemById.has(itemId)) fail(`requested library item ${itemId} does not exist`);
  }

  const result = await withPlanningLock(support, async (planningRoot) => {
    const checkpointPath = path.join(planningRoot, "review-batches", "checkpoint.json");
    const checkpoint = await readOptionalJson(checkpointPath, {
      schemaVersion: CHECKPOINT_SCHEMA,
      completedItemIds: [],
      activeBatch: null,
    }, "review-batch checkpoint");
    object(checkpoint, "review-batch checkpoint");
    if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA || !Array.isArray(checkpoint.completedItemIds)) {
      fail("review-batch checkpoint is malformed or has an unsupported schema");
    }
    if (checkpoint.activeBatch) return validateActiveBatch(support, planningRoot, checkpoint, itemById);

    const completed = new Set(checkpoint.completedItemIds);
    const eligible = library.items
      .filter((item) => ["pending_codex", "processing"].includes(item.status))
      .filter((item) => item.preparation?.state === "ready")
      .filter((item) => !completed.has(item.id))
      .filter((item) => requestedItems.size === 0 || requestedItems.has(item.id))
      .sort((left, right) => (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER)
        || left.id.localeCompare(right.id));
    if (eligible.length === 0) fail("no unreviewed, locally prepared literature is ready for a Curator batch");
    if (eligible.length < 3 && !allowPartial) {
      fail(`only ${eligible.length} paper(s) are ready; wait for 3 or use --allow-partial for an explicit final batch`);
    }
    const selectedItems = eligible.slice(0, maxPapers);
    const prepared = [];
    for (const item of selectedItems) prepared.push(await loadPreparedItem(support, item));
    const batch = batchFrom(prepared, charBudget);
    const batchText = stableJson(batch);
    const batchSha256 = sha256Text(batchText);
    const batchDirectory = path.join(planningRoot, "review-batches", batch.batchId);
    const batchPath = path.join(batchDirectory, "batch.json");
    const journalPath = path.join(planningRoot, "journals", `build-${batch.batchId}.json`);
    await atomicWriteJson(journalPath, {
      schemaVersion: "liteverse-curator-transaction-v1",
      transactionId: `build-${batch.batchId}`,
      operation: "build_review_batch",
      state: "planned",
      writes: [path.relative(support, batchPath), path.relative(support, checkpointPath)],
      inputFingerprint: batch.inputFingerprint,
    });
    await atomicWriteJson(batchPath, batch);
    await atomicWriteJson(checkpointPath, {
      schemaVersion: CHECKPOINT_SCHEMA,
      completedItemIds: [...completed].sort(),
      activeBatch: {
        batchId: batch.batchId,
        batchSha256,
        inputFingerprint: batch.inputFingerprint,
        itemIds: batch.papers.map((paper) => paper.itemId),
      },
    });
    await atomicWriteJson(journalPath, {
      schemaVersion: "liteverse-curator-transaction-v1",
      transactionId: `build-${batch.batchId}`,
      operation: "build_review_batch",
      state: "committed",
      writes: [path.relative(support, batchPath), path.relative(support, checkpointPath)],
      inputFingerprint: batch.inputFingerprint,
      outputSha256: batchSha256,
    });
    return { batch, batchPath, batchSha256, resumed: false };
  });

  const output = {
    batchId: result.batch.batchId,
    batchPath: result.batchPath,
    batchSha256: result.batchSha256,
    paperCount: result.batch.papers.length,
    candidateCharacters: result.batch.constraints.candidateCharacters,
    resumed: result.resumed,
  };
  console.log(process.argv.includes("--json") ? JSON.stringify(output, null, 2) : `${output.batchId}\n${output.batchPath}`);
}

main().catch((error) => {
  console.error(`build-review-batch: ${error.message}`);
  process.exitCode = 2;
});
