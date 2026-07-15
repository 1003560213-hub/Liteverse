#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  assertOutsideGraph,
  atomicWrite,
  fail,
  object,
  readJsonWithText,
  resolveSupport,
  sha256,
  stableText,
} from "./partition-contract.mjs";

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be non-empty text`);
  return value.trim();
}

function usage() {
  console.log(`Usage: compose-partition-options.mjs --snapshot FILE --plan FILE [options]

Options:
  --support-dir DIR   Liteverse Application Support root
  --output FILE       Expanded propose input; default Planning/partition-inputs/<hash>.json

The compact plan contains exactly three options. Each option has regions with
paperIds, clusterConsistency, scopeDefinition, color, and structured tradeoffs.
The helper reads each paper's pinned claims sidecar, prefers its first
evidence_verified claim ID, and deterministically expands assignments and
creation evidence. A paper/claim pair that is needs_attention may supply an
evidence-bearing provisional anchor; other unverified states fail closed. It
does not write Graph, queues, decisions, or Usage.`);
}

function managedPath(support, configured, label) {
  if (typeof configured !== "string" || !configured || path.isAbsolute(configured)) {
    fail(`${label} must be a support-relative path`);
  }
  const resolved = path.resolve(support, configured);
  const relative = path.relative(support, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail(`${label} escapes support`);
  return resolved;
}

async function classificationAnchor(support, paper) {
  const integrity = paper?.artifacts?.integrity ?? paper?.artifact ?? paper?.integrity;
  object(integrity, `paper ${paper.id}.artifacts.integrity`);
  const claimsPath = managedPath(support, integrity.immutableClaimsPath, `paper ${paper.id} immutableClaimsPath`);
  const claimsText = await readFile(claimsPath, "utf8");
  if (typeof integrity.claimsSha256 !== "string" || sha256(claimsText) !== integrity.claimsSha256) {
    fail(`paper ${paper.id} claims sidecar hash does not match its artifact pin`);
  }
  let sidecar;
  try {
    sidecar = JSON.parse(claimsText);
  } catch (error) {
    fail(`paper ${paper.id} claims sidecar is invalid JSON: ${error.message}`);
  }
  if (sidecar.schemaVersion !== "liteverse-claims-v1" || sidecar.paperId !== paper.id
      || sidecar.artifactSha256 !== integrity.artifactSha256) {
    fail(`paper ${paper.id} claims sidecar does not match its pinned artifact`);
  }
  const claims = Array.isArray(sidecar.claims) ? sidecar.claims : [];
  const verifiedClaim = claims.find((candidate) => candidate.verificationStatus === "evidence_verified");
  if (verifiedClaim && typeof verifiedClaim.claimId === "string" && verifiedClaim.claimId) {
    return {
      claimId: verifiedClaim.claimId,
      classificationStatus: "classified",
      anchorStatus: "evidence_verified",
      rationale: `Evidence-verified classification anchor ${verifiedClaim.claimId}.`,
    };
  }
  const needsAttentionClaim = claims.find((candidate) => {
    if (candidate?.verificationStatus !== "needs_attention") return false;
    const evidenceIds = Array.isArray(candidate.evidenceIds)
      && candidate.evidenceIds.some((evidenceId) => typeof evidenceId === "string" && evidenceId.trim());
    const evidence = Array.isArray(candidate.evidence) && candidate.evidence.length > 0;
    return typeof candidate.claimId === "string" && candidate.claimId && (evidenceIds || evidence);
  });
  if (paper.verificationStatus === "needs_attention" && needsAttentionClaim) {
    return {
      claimId: needsAttentionClaim.claimId,
      classificationStatus: "provisional",
      anchorStatus: "needs_attention",
      rationale: `Provisional classification anchor ${needsAttentionClaim.claimId}: paper and claim are needs_attention but the claim retains evidence references; original-source review is still required.`,
    };
  }
  fail(`paper ${paper.id} has no evidence_verified claim or eligible needs_attention provisional anchor`);
}

function normalizeTradeoffs(raw, label) {
  object(raw, label);
  const list = (value, field) => {
    if (!Array.isArray(value) || !value.length) fail(`${label}.${field} must be a non-empty array`);
    return value.map((item, index) => text(item, `${label}.${field}[${index}]`));
  };
  return { strengths: list(raw.strengths, "strengths"), limitations: list(raw.limitations, "limitations") };
}

function oldRegionScores(paper, currentMacroIds) {
  const secondary = paper.secondaryCategory
    ?? (Array.isArray(paper.categoryIds) ? paper.categoryIds.find((id) => id !== paper.primaryCategory) : null);
  return Object.fromEntries(currentMacroIds.map((categoryId) => [
    categoryId,
    categoryId === paper.primaryCategory ? 82 : categoryId === secondary ? 66 : 18,
  ]));
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const snapshotPath = argument("--snapshot");
  const planPath = argument("--plan");
  if (!snapshotPath || !planPath) fail("--snapshot and --plan are required");
  const support = resolveSupport(argument("--support-dir"));
  const { value: current } = await readJsonWithText(path.join(support, "Graph", "current.json"), "Graph/current.json");
  const { value: snapshot } = await readJsonWithText(path.resolve(snapshotPath), "source snapshot");
  const planResult = await readJsonWithText(path.resolve(planPath), "compact partition plan");
  const plan = object(planResult.value, "compact partition plan");
  if (!Array.isArray(plan.options) || plan.options.length !== 3) fail("compact plan must contain exactly three options");
  const papers = Array.isArray(snapshot.papers) ? snapshot.papers : fail("source snapshot papers must be an array");
  const paperIds = papers.map((paper) => paper.id).sort();
  if (!paperIds.length || new Set(paperIds).size !== paperIds.length) fail("source snapshot paper IDs must be unique");
  const paperById = new Map(papers.map((paper) => [paper.id, paper]));
  const anchorByPaper = new Map();
  for (const paperId of paperIds) anchorByPaper.set(paperId, await classificationAnchor(support, paperById.get(paperId)));
  const provisionalPaperIds = paperIds.filter((paperId) => anchorByPaper.get(paperId).anchorStatus === "needs_attention");
  const currentMacroIds = (current.categories ?? [])
    .filter((category) => (category.kind ?? "macro") === "macro")
    .map((category) => category.id)
    .sort();
  const options = plan.options.map((raw, optionIndex) => {
    object(raw, `options[${optionIndex}]`);
    const optionId = text(raw.optionId, `options[${optionIndex}].optionId`);
    const regions = Array.isArray(raw.regions) ? raw.regions : fail(`option ${optionId}.regions must be an array`);
    if (regions.length < 1 || regions.length > 10) fail(`option ${optionId} must contain 1..10 regions`);
    const assignments = new Map();
    const categories = regions.map((region, regionIndex) => {
      object(region, `option ${optionId}.regions[${regionIndex}]`);
      const regionId = text(region.id, `option ${optionId}.regions[${regionIndex}].id`);
      const members = Array.isArray(region.paperIds) ? [...region.paperIds].sort() : fail(`region ${regionId}.paperIds must be an array`);
      if (members.length < 4) fail(`region ${regionId} requires at least four primary papers`);
      if (new Set(members).size !== members.length || members.some((paperId) => !paperById.has(paperId))) {
        fail(`region ${regionId}.paperIds contains a duplicate or unknown paper`);
      }
      for (const paperId of members) {
        if (assignments.has(paperId)) fail(`option ${optionId} assigns paper ${paperId} to multiple primary regions`);
        assignments.set(paperId, regionId);
      }
      const consistency = Number(region.clusterConsistency);
      if (!Number.isFinite(consistency) || consistency < 70 || consistency > 100) {
        fail(`region ${regionId}.clusterConsistency must be 70..100`);
      }
      return {
        id: regionId,
        kind: "macro",
        name: text(region.name, `region ${regionId}.name`),
        description: text(region.description, `region ${regionId}.description`),
        color: text(region.color, `region ${regionId}.color`),
        creationEvidence: {
          memberIds: members,
          existingRegionMatchScores: Object.fromEntries(
            members.map((paperId) => [paperId, oldRegionScores(paperById.get(paperId), currentMacroIds)]),
          ),
          clusterConsistency: consistency,
          scopeDefinition: text(region.scopeDefinition, `region ${regionId}.scopeDefinition`),
        },
      };
    });
    if (JSON.stringify([...assignments.keys()].sort()) !== JSON.stringify(paperIds)) {
      fail(`option ${optionId} regions must cover every paper exactly once`);
    }
    const secondaryAssignments = raw.secondaryAssignments ?? {};
    object(secondaryAssignments, `option ${optionId}.secondaryAssignments`);
    const categoryIds = new Set(categories.map((category) => category.id));
    return {
      optionId,
      name: text(raw.name, `option ${optionId}.name`),
      strategy: text(raw.strategy, `option ${optionId}.strategy`),
      summary: text(raw.summary, `option ${optionId}.summary`),
      rationale: text(raw.rationale ?? raw.summary, `option ${optionId}.rationale`),
      tradeoffs: normalizeTradeoffs(raw.tradeoffs, `option ${optionId}.tradeoffs`),
      categories,
      assignments: paperIds.map((paperId) => {
        const secondaryCategory = secondaryAssignments[paperId] ?? null;
        if (secondaryCategory && (!categoryIds.has(secondaryCategory) || secondaryCategory === assignments.get(paperId))) {
          fail(`option ${optionId} has invalid secondary assignment for ${paperId}`);
        }
        const anchor = anchorByPaper.get(paperId);
        return {
          paperId,
          primaryCategory: assignments.get(paperId),
          secondaryCategory,
          classificationStatus: anchor.classificationStatus,
          rationale: `Assigned by compact plan ${optionId}. ${anchor.rationale}`,
          evidenceIds: [anchor.claimId],
        };
      }),
    };
  });
  const heuristicDescription = "Old-region match scores are transparent deterministic heuristics: prior primary=82, prior secondary=66, other=18; full repartition does not apply the incremental <60 veto.";
  const expanded = {
    searchSummary: `${text(plan.searchSummary, "searchSummary")} ${heuristicDescription}`,
    metadata: {
      composer: "liteverse-compose-partition-options-v1",
      evidencePolicy: "Prefer the first evidence_verified claimId. A needs_attention claim is only a provisional anchor when its paper is also needs_attention and it retains non-empty evidence/evidenceIds; every other unverified state fails closed.",
      anchorCounts: {
        evidenceVerified: paperIds.length - provisionalPaperIds.length,
        provisionalNeedsAttention: provisionalPaperIds.length,
      },
      provisionalNeedsAttentionPaperIds: provisionalPaperIds,
      oldRegionMatchScoreHeuristic: { priorPrimary: 82, priorSecondary: 66, other: 18 },
      fullRepartition: true,
    },
    retrievalQueries: [{
      query: text(plan.retrievalQuery ?? "verified claims for corpus-level macro partition", "retrievalQuery"),
      consideredPaperIds: paperIds,
      summary: provisionalPaperIds.length
        ? `Every paper used an immutable claims sidecar; ${provisionalPaperIds.length} needs_attention paper(s) use explicit provisional evidence-bearing anchors.`
        : "Every paper was anchored to its first evidence_verified claim in the immutable claims sidecar.",
    }],
    options,
  };
  const digest = sha256(stableText({ snapshot: path.resolve(snapshotPath), plan: planResult.value, expanded }));
  const outputPath = path.resolve(
    argument("--output") ?? path.join(support, "Planning", "partition-inputs", `partition-options-${digest.slice(0, 16)}.json`),
  );
  assertOutsideGraph(support, outputPath, "expanded partition options output");
  const outputRelative = path.relative(support, outputPath).split(path.sep).join("/");
  if (!outputRelative.startsWith("Planning/partition-inputs/")) {
    fail("expanded partition options must be stored under Planning/partition-inputs/");
  }
  await atomicWrite(outputPath, stableText(expanded, true));
  console.log(stableText({
    status: "partition_options_composed",
    outputPath,
    paperCount: paperIds.length,
    optionIds: options.map((option) => option.optionId),
    metadata: expanded.metadata,
  }, true).trimEnd());
}

main().catch((error) => {
  console.error(`compose-partition-options: ${error.message}`);
  process.exitCode = 2;
});
