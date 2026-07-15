#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import {
  assertOutsideGraph,
  atomicWrite,
  exists,
  fail,
  paperArtifactFingerprint,
  readJsonWithText,
  resolveSupport,
  sha256,
  stableText,
  validatePartitionOptions,
  withLock,
} from "./partition-contract.mjs";

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  console.log(`Usage: propose-partitions.mjs --snapshot FILE --options FILE [options]

Options:
  --support-dir DIR   Liteverse Application Support root
  --proposal-id ID    Stable proposal-set ID; otherwise derived from content
  --output FILE       Immutable proposal truth outside Graph; default Planning/partition-proposals/<id>.json

The options JSON must contain exactly three materially distinct partitions plus
the searches used to derive them. It writes immutable truth under Planning and
the rebuildable App projection Graph/partition-proposals.json; it never writes
current, staged, pending-update, history, queues, or Usage.`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const snapshotPath = argument("--snapshot");
  const optionsPath = argument("--options");
  if (!snapshotPath || !optionsPath) fail("--snapshot and --options are required");
  const support = resolveSupport(argument("--support-dir"));
  const currentResult = await readJsonWithText(path.join(support, "Graph", "current.json"), "Graph/current.json");
  const snapshotResult = await readJsonWithText(path.resolve(snapshotPath), "source snapshot");
  const optionsResult = await readJsonWithText(path.resolve(optionsPath), "partition options");
  const normalized = validatePartitionOptions(currentResult.value, snapshotResult.value, optionsResult.value);
  const currentArtifactFingerprint = paperArtifactFingerprint(currentResult.value.papers ?? [], "current graph papers");
  const corpusArtifactFingerprint = paperArtifactFingerprint(snapshotResult.value.papers ?? [], "source snapshot papers");
  const contentDigest = sha256(stableText({
    baseRevision: currentResult.value.revision,
    currentArtifactFingerprint,
    corpusArtifactFingerprint,
    sourceSnapshotSha256: sha256(snapshotResult.text),
    normalized,
  }));
  const requestedId = argument("--proposal-id");
  const proposalSetId = requestedId ?? `partition-r${currentResult.value.revision}-${contentDigest.slice(0, 12)}`;
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(proposalSetId)) fail("proposal ID must be a safe lowercase ID");
  const proposal = {
    schemaVersion: "liteverse-partition-proposal-v1",
    proposalSetId,
    baseRevision: currentResult.value.revision,
    currentArtifactFingerprint,
    corpusArtifactFingerprint,
    sourceSnapshotSha256: sha256(snapshotResult.text),
    sourceSnapshotUpdated: snapshotResult.value.updated ?? null,
    validationDigest: contentDigest,
    paperIds: normalized.paperIds,
    searchSummary: normalized.searchSummary,
    metadata: normalized.metadata,
    retrievalQueries: normalized.retrievalQueries,
    materialDifferences: normalized.materialDifferences,
    options: normalized.options,
  };
  const outputPath = assertOutsideGraph(
    support,
    argument("--output") ?? path.join(support, "Planning", "partition-proposals", `${proposalSetId}.json`),
    "proposal output",
  );
  const proposalText = stableText(proposal, true);
  const truthRelativePath = path.relative(support, outputPath).split(path.sep).join("/");
  if (!truthRelativePath.startsWith("Planning/partition-proposals/")) {
    fail("proposal truth must be stored under Planning/partition-proposals/");
  }
  const projectionPath = path.join(support, "Graph", "partition-proposals.json");
  const projectedOptions = proposal.options.map((option) => {
    const primaryCounts = new Map();
    for (const assignment of option.assignments) {
      primaryCounts.set(assignment.primaryCategory, (primaryCounts.get(assignment.primaryCategory) ?? 0) + 1);
    }
    const regions = option.categories
      .filter((category) => (category.kind ?? "macro") === "macro")
      .map((category) => ({
        id: category.id,
        name: category.name,
        description: category.description,
        paperCount: primaryCounts.get(category.id) ?? 0,
      }));
    const sizes = regions.map((region) => region.paperCount);
    return {
      optionId: option.optionId,
      name: option.name,
      summary: option.summary,
      tradeoffs: option.tradeoffs,
      regions,
      assignments: option.assignments,
      metrics: {
        paperCount: option.assignments.length,
        regionCount: regions.length,
        minRegionSize: Math.min(...sizes),
        maxRegionSize: Math.max(...sizes),
      },
    };
  });
  const projection = {
    schemaVersion: "liteverse-partition-proposals-v1",
    status: "awaiting_user",
    proposalSetId,
    baseRevision: proposal.baseRevision,
    artifactFingerprint: currentArtifactFingerprint,
    searchSummary: proposal.searchSummary,
    truthPath: truthRelativePath,
    truthSha256: sha256(proposalText),
    options: projectedOptions,
  };
  await withLock(path.join(support, ".locks", "partition-proposal.lock"), async () => {
    if (await exists(outputPath)) {
      const existing = await readJsonWithText(outputPath, "existing partition proposal truth");
      if (stableText(existing.value, true) !== proposalText) {
        fail(`immutable proposal truth already exists with different content: ${outputPath}`);
      }
    } else {
      await atomicWrite(outputPath, proposalText);
    }
    await atomicWrite(projectionPath, stableText(projection, true));
  });
  console.log(stableText({
    status: "awaiting_user_partition_choice",
    proposalSetId,
    baseRevision: proposal.baseRevision,
    currentArtifactFingerprint,
    optionIds: proposal.options.map((option) => option.optionId),
    outputPath,
    projectionPath,
  }, true).trimEnd());
}

main().catch((error) => {
  console.error(`propose-partitions: ${error.message}`);
  process.exitCode = 2;
});
