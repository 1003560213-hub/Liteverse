#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import {
  appendDecision,
  assignCategoryNebulaAssets,
  assignDeterministicPartitionLayout,
  assertOutsideGraph,
  assignmentFingerprint,
  atomicWrite,
  fail,
  findDecisionRecord,
  paperArtifactFingerprint,
  readJsonWithText,
  resolveSupport,
  sha256,
  stableText,
  validateDecisionRecord,
  validatePartitionOptions,
} from "./partition-contract.mjs";

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  console.log(`Usage: apply-partition-choice.mjs --proposal FILE --snapshot FILE --option-id ID [options]

Required confirmation:
  --confirmed-by-user       Assert that the user explicitly chose this one option
  --confirmation-note TEXT  Concise provenance for the explicit user choice
  --decided-at ISO          Stable ISO-8601 decision time

Other options:
  --support-dir DIR         Liteverse Application Support root
  --output FILE             Ordinary unstaged snapshot outside Graph
  --rebuild-selected        Rebuild the exact recorded selection without
                            appending a new decision (safe repair mode)

This command rechecks the base revision, current artifact fingerprint, exact
source snapshot, and all three options. It appends one decision record and
writes an unstaged snapshot; run stage-refresh.mjs separately afterward.`);
}

function safeRegionName(value) {
  return String(value).replaceAll("`", "'").replace(/[“”]/g, "").trim();
}

// Older private builds emitted a small set of generated non-English region
// markers. Keep a compatibility matcher so importing those workspaces does not
// damage the scientific prose, but always normalize the generated annotation
// to the public release's canonical English form.
const legacyGeneratedPrefix = new RegExp(
  "^\\u4f5c\\u4e3a[\\u201c\"][^\\u201d\"\\n]+[\\u201d\"]\\u533a\\u57df\\u4e2d\\u7684",
);
const legacyContributionTail = new RegExp(
  "[\\uff1b;]\\s*\\u5206\\u7c7b\\u4e0a\\u6838\\u5fc3\\u8d21\\u732e\\u662f[\\s\\S]*$",
);
const legacyBasisTail = new RegExp(
  "([\\u3002.!?\\uff01\\uff1f])\\s*\\u5206\\u7c7b\\u4f9d\\u636e\\uff1a[\\s\\S]*$",
);

function rewriteMachineGeneratedProjectRole(projectRole, primaryName, secondaryName = null) {
  if (typeof projectRole !== "string" || !projectRole) return projectRole;
  let rewritten = projectRole;
  const token = '(?:`[^`\\n]+`|“[^”\\n]+”|"[^"\\n]+"|[^;.\\n]+)';
  const englishPrefix = new RegExp(
    `^Primary region:\\s*${token}\\s*(?:;\\s*secondary region:\\s*${token}\\s*)?\\.`,
    "i",
  );
  const englishMatch = projectRole.match(englishPrefix);
  if (englishMatch) {
    const primary = safeRegionName(primaryName);
    const secondary = secondaryName ? safeRegionName(secondaryName) : null;
    const prefix = secondary
      ? `Primary region: \`${primary}\`; secondary region: \`${secondary}\`.`
      : `Primary region: \`${primary}\`.`;
    rewritten = `${prefix}${projectRole.slice(englishMatch[0].length)}`;
  }
  const legacyPrefixMatch = rewritten.match(legacyGeneratedPrefix);
  if (legacyPrefixMatch) {
    const primary = safeRegionName(primaryName);
    rewritten = `Primary region: \`${primary}\`. ${rewritten.slice(legacyPrefixMatch[0].length)}`;
  }

  let tailStart = null;
  const leadingEnglishTail = rewritten.match(/^Classification:\s*primary\s+`[^`\n]+`[\s\S]*$/i);
  if (leadingEnglishTail) tailStart = 0;
  const englishTail = rewritten.match(/([.!?\u3002\uff01\uff1f])\s+Classification:\s*primary\s+`[^`\n]+`[\s\S]*$/i);
  if (englishTail) tailStart = englishTail.index + englishTail[1].length;
  const legacyContributionMatch = rewritten.match(legacyContributionTail);
  if (legacyContributionMatch) {
    tailStart = legacyContributionMatch.index;
  }
  const legacyBasisMatch = rewritten.match(legacyBasisTail);
  if (legacyBasisMatch) {
    tailStart = legacyBasisMatch.index + legacyBasisMatch[1].length;
  }
  if (tailStart !== null) {
    const body = rewritten.slice(0, tailStart).trimEnd();
    const primary = safeRegionName(primaryName);
    const secondary = secondaryName ? safeRegionName(secondaryName) : null;
    const canonicalTail = secondary
      ? `Classification: primary \`${primary}\`; secondary \`${secondary}\`.`
      : `Classification: primary \`${primary}\`; no secondary region.`;
    const separator = !body
      ? ""
      : /[.!?\u3002\uff01\uff1f]$/.test(body)
        ? " "
        : ". ";
    rewritten = `${body}${separator}${canonicalTail}`;
  }
  return rewritten;
}

function buildChosenSnapshot(source, option, current, decisionBase) {
  const nebula = assignCategoryNebulaAssets(
    source,
    current,
    option.categories.map((category) => ({ ...category, kind: category.kind ?? "macro" })),
  );
  const categories = nebula.categories;
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const assignments = new Map(option.assignments.map((assignment) => [assignment.paperId, assignment]));
  const papers = source.papers.map((paper) => {
    const assignment = assignments.get(paper.id);
    const next = {
      ...paper,
      primaryCategory: assignment.primaryCategory,
      categoryIds: [assignment.primaryCategory, assignment.secondaryCategory].filter(Boolean),
      classificationStatus: assignment.classificationStatus,
      classificationRationale: assignment.rationale,
      classificationEvidenceIds: assignment.evidenceIds,
    };
    const rewrittenProjectRole = rewriteMachineGeneratedProjectRole(
      paper.projectRole,
      categoryNames.get(assignment.primaryCategory),
      assignment.secondaryCategory ? categoryNames.get(assignment.secondaryCategory) : null,
    );
    if (rewrittenProjectRole !== undefined) next.projectRole = rewrittenProjectRole;
    if (assignment.secondaryCategory) next.secondaryCategory = assignment.secondaryCategory;
    else delete next.secondaryCategory;
    return next;
  });
  const layout = assignDeterministicPartitionLayout(
    source,
    current,
    categories,
    papers,
    `${nebula.visuals.nebulaAssignmentSeed ?? "liteverse-nebula"}:${decisionBase.optionId}`,
  );
  return {
    ...source,
    revision: Math.max(Number(source.revision) || 0, current.revision + 1),
    visuals: nebula.visuals,
    categories: layout.categories,
    papers: layout.papers,
    partitionDecision: {
      decisionId: decisionBase.decisionId,
      proposalSetId: decisionBase.proposalSetId,
      optionId: decisionBase.optionId,
      baseRevision: decisionBase.baseRevision,
      currentArtifactFingerprint: decisionBase.currentArtifactFingerprint,
      corpusArtifactFingerprint: decisionBase.corpusArtifactFingerprint,
      decisionRecordPath: "Planning/partition-decisions.jsonl",
      recordSha256: null,
    },
  };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const proposalPath = argument("--proposal");
  const snapshotPath = argument("--snapshot");
  const optionId = argument("--option-id");
  const confirmationNote = argument("--confirmation-note");
  const decidedAt = argument("--decided-at");
  const rebuildSelected = process.argv.includes("--rebuild-selected");
  if (!proposalPath || !snapshotPath || !optionId) fail("--proposal, --snapshot, and --option-id are required");
  if (!rebuildSelected) {
    if (!process.argv.includes("--confirmed-by-user")) fail("refusing to choose a partition without --confirmed-by-user");
    if (typeof confirmationNote !== "string" || !confirmationNote.trim()) fail("--confirmation-note is required");
    if (typeof decidedAt !== "string" || Number.isNaN(Date.parse(decidedAt)) || !/^\d{4}-\d{2}-\d{2}T/.test(decidedAt)) {
      fail("--decided-at must be an ISO-8601 timestamp");
    }
  }
  const support = resolveSupport(argument("--support-dir"));
  const proposalResult = await readJsonWithText(path.resolve(proposalPath), "partition proposal");
  const sourceResult = await readJsonWithText(path.resolve(snapshotPath), "source snapshot");
  const currentResult = await readJsonWithText(path.join(support, "Graph", "current.json"), "Graph/current.json");
  const proposal = proposalResult.value;
  const proposalRelativePath = path.relative(support, path.resolve(proposalPath)).split(path.sep).join("/");
  if (!proposalRelativePath.startsWith("Planning/partition-proposals/")) {
    fail("--proposal must reference immutable truth under Planning/partition-proposals/");
  }
  if (proposal.schemaVersion !== "liteverse-partition-proposal-v1") fail("partition proposal has an unsupported schema");
  const projectionPath = path.join(support, "Graph", "partition-proposals.json");
  const projectionResult = await readJsonWithText(projectionPath, "Graph/partition-proposals.json");
  const projection = projectionResult.value;
  const expectedProjectionStatus = rebuildSelected ? "selected" : "awaiting_user";
  if (projection.schemaVersion !== "liteverse-partition-proposals-v1"
      || projection.status !== expectedProjectionStatus
      || projection.proposalSetId !== proposal.proposalSetId
      || projection.baseRevision !== proposal.baseRevision
      || projection.artifactFingerprint !== proposal.currentArtifactFingerprint
      || projection.truthPath !== proposalRelativePath
      || projection.truthSha256 !== sha256(proposalResult.text)) {
    fail("the App proposal projection does not point to this active immutable proposal truth");
  }
  if (rebuildSelected && (projection.selectedOptionId !== optionId
      || typeof projection.decisionId !== "string"
      || typeof projection.decisionRecordPath !== "string"
      || typeof projection.decisionRecordSha256 !== "string")) {
    fail("--rebuild-selected requires a complete matching selected projection");
  }
  if (proposal.baseRevision !== currentResult.value.revision) fail("partition proposal baseRevision is stale");
  const currentArtifactFingerprint = paperArtifactFingerprint(currentResult.value.papers ?? [], "current graph papers");
  if (proposal.currentArtifactFingerprint !== currentArtifactFingerprint) {
    fail("partition proposal current paper artifact fingerprint is stale");
  }
  if (proposal.sourceSnapshotSha256 !== sha256(sourceResult.text)) fail("partition proposal source snapshot hash is stale");
  const corpusArtifactFingerprint = paperArtifactFingerprint(sourceResult.value.papers ?? [], "source snapshot papers");
  if (proposal.corpusArtifactFingerprint !== corpusArtifactFingerprint) fail("partition proposal corpus artifact fingerprint is stale");
  const normalized = validatePartitionOptions(currentResult.value, sourceResult.value, proposal);
  const validationDigest = sha256(stableText({
    baseRevision: currentResult.value.revision,
    currentArtifactFingerprint,
    corpusArtifactFingerprint,
    sourceSnapshotSha256: sha256(sourceResult.text),
    normalized,
  }));
  if (proposal.validationDigest !== validationDigest) fail("partition proposal validation digest does not match its contents");
  const matching = proposal.options.filter((option) => option.optionId === optionId);
  if (matching.length !== 1) fail("the chosen option must match exactly one of the three proposed options");
  let decision;
  let decisionId;
  let draftSnapshot;
  if (rebuildSelected) {
    decision = await findDecisionRecord(support, {
      decisionId: projection.decisionId,
      proposalSetId: proposal.proposalSetId,
      optionId,
      baseRevision: proposal.baseRevision,
      currentArtifactFingerprint,
      corpusArtifactFingerprint,
      decisionRecordPath: projection.decisionRecordPath,
      recordSha256: projection.decisionRecordSha256,
    });
    if (decision.proposalTruthPath !== proposalRelativePath
        || decision.proposalSha256 !== sha256(proposalResult.text)
        || decision.sourceSnapshotSha256 !== proposal.sourceSnapshotSha256) {
      fail("recorded partition decision does not match the immutable proposal or source snapshot");
    }
    decisionId = decision.decisionId;
    draftSnapshot = buildChosenSnapshot(sourceResult.value, matching[0], currentResult.value, decision);
    validateDecisionRecord(decision, draftSnapshot, currentResult.value);
  } else {
    const decisionBase = {
      schemaVersion: "liteverse-partition-decision-v1",
      kind: "partition_decision",
      proposalSetId: proposal.proposalSetId,
      optionId,
      baseRevision: proposal.baseRevision,
      currentArtifactFingerprint,
      corpusArtifactFingerprint,
      proposalTruthPath: proposalRelativePath,
      proposalSha256: sha256(proposalResult.text),
      sourceSnapshotSha256: proposal.sourceSnapshotSha256,
      decidedAt: new Date(decidedAt).toISOString(),
      confirmationNote: confirmationNote.trim(),
    };
    decisionId = `partition-decision-${sha256(stableText(decisionBase)).slice(0, 16)}`;
    draftSnapshot = buildChosenSnapshot(sourceResult.value, matching[0], currentResult.value, { ...decisionBase, decisionId });
    decision = {
      ...decisionBase,
      decisionId,
      selectedCategoryIds: draftSnapshot.categories.map((category) => category.id).sort(),
      paperAssignmentsSha256: assignmentFingerprint(draftSnapshot.papers),
    };
  }
  const ledger = await appendDecision(support, decision);
  draftSnapshot.partitionDecision.recordSha256 = ledger.recordSha256;
  const outputPath = assertOutsideGraph(
    support,
    argument("--output") ?? path.join(support, "Planning", "partition-snapshots", `${decisionId}.json`),
    "chosen snapshot output",
  );
  const outputRelativePath = path.relative(support, outputPath).split(path.sep).join("/");
  if (!outputRelativePath.startsWith("Planning/partition-snapshots/")) {
    fail("chosen snapshot must be stored under Planning/partition-snapshots/");
  }
  await atomicWrite(outputPath, stableText(draftSnapshot, true));
  await atomicWrite(projectionPath, stableText({
    ...projection,
    status: "selected",
    selectedOptionId: optionId,
    decisionId,
    decisionRecordPath: ledger.relativePath,
    decisionRecordSha256: ledger.recordSha256,
    selectedSnapshotPath: outputRelativePath,
    selectedSnapshotSha256: sha256(stableText(draftSnapshot, true)),
  }, true));
  console.log(stableText({
    status: rebuildSelected ? "partition_choice_rebuilt_unstaged" : "partition_choice_applied_unstaged",
    decisionId,
    proposalSetId: proposal.proposalSetId,
    optionId,
    outputPath,
    decisionRecordPath: ledger.path,
    projectionPath,
    next: "Run stage-refresh.mjs --snapshot <outputPath> after final graph validation.",
  }, true).trimEnd());
}

main().catch((error) => {
  console.error(`apply-partition-choice: ${error.message}`);
  process.exitCode = 2;
});
