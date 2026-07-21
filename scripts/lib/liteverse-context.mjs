import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  atomicWrite,
  atomicWriteJson,
  PROJECT_ID,
  readJson,
  sha256Text,
  truncateText,
  verifyPaperArtifact,
} from "./liteverse-core.mjs";
import { readIndexedPaper, searchLiteverse } from "./liteverse-search.mjs";
import { hashTask, recordUsage } from "./liteverse-usage.mjs";

async function loadProjectContext(support, projectId) {
  const projectRoot = path.join(support, "Projects", projectId);
  const [project, memory] = await Promise.all([
    readJson(path.join(projectRoot, "project.json"), { optional: true }),
    readJson(path.join(projectRoot, "memory", "current.json"), { optional: true }),
  ]);
  if (!project && !memory && projectId === "project-default") {
    const legacy = await readJson(path.join(support, "research-information.json"), { optional: true });
    return {
      project: { projectId, name: "Default project", revision: legacy?.formal?.sourceRevision ?? legacy?.draft?.revision ?? 0 },
      memory: {
        projectId,
        revision: legacy?.formal?.sourceRevision ?? legacy?.draft?.revision ?? 0,
        ledgerHash: null,
        items: legacy?.formal?.text ? [{ memoryId: "legacy-research-information", type: "research_information", title: "Research information", content: legacy.formal.text, state: "active", evidenceState: "user_declared", provenance: "user" }] : [],
      },
      legacyFallback: true,
    };
  }
  if (!project) throw new Error(`project does not exist: ${projectId}`);
  if (!memory) throw new Error(`project memory projection does not exist: ${projectId}`);
  if (project.projectId !== projectId || memory.projectId !== projectId) throw new Error(`project identity conflict for ${projectId}`);
  const projectedRevision = project.revision;
  const projectedHash = project.ledgerHash;
  if (projectedRevision !== undefined && Number(projectedRevision) !== Number(memory.revision)) {
    throw new Error(`project/memory revision conflict for ${projectId}: ${projectedRevision} != ${memory.revision}`);
  }
  if (projectedHash !== memory.ledgerHash) throw new Error(`project/memory ledgerHash conflict for ${projectId}`);
  return { project, memory, legacyFallback: false };
}

function memorySelection(memory, maxChars) {
  const active = (memory.items ?? [])
    .filter((item) => item.state === "active")
    .sort((left, right) => String(left.memoryId).localeCompare(String(right.memoryId)));
  const selected = [];
  let used = 0;
  for (const item of active) {
    const content = String(item.content ?? "");
    if (!content) continue;
    const remaining = maxChars - used;
    if (remaining < 100) break;
    const bounded = truncateText(content, remaining);
    selected.push({
      memoryId: item.memoryId,
      type: item.type,
      title: item.title,
      content: bounded.text,
      evidenceState: item.evidenceState,
      provenance: item.provenance,
      updatedRevision: item.updatedRevision,
    });
    used += bounded.text.length;
  }
  return selected;
}

function claimTrust(claim) {
  if (claim.verificationStatus === "evidence_verified") return "verified_original_source";
  if (claim.verificationStatus === "needs_attention") return "verified_with_attention_flag";
  return "provisional_not_for_formal_use";
}

function markdownForPack(pack) {
  const lines = [
    `# Liteverse Context Pack`,
    "",
    `- Project: \`${pack.projectId}\``,
    `- Pack ID: \`${pack.packId}\``,
    `- Task hash: \`${pack.taskHash}\``,
    `- Query: ${pack.query}`,
    `- Graph revision: ${pack.graphRevision}`,
    `- Memory revision: ${pack.memoryRevision}`,
    `- Memory ledger hash: ${pack.memoryLedgerHash ? `\`${pack.memoryLedgerHash}\`` : "legacy/unavailable"}`,
    `- Character budget: ${pack.budgetChars}`,
    "",
    "## Selected literature claims",
    "",
  ];
  for (const claim of pack.selectedClaims) {
    lines.push(`### ${claim.paperId} · ${claim.claimId}`, "", claim.text, "");
    lines.push(`- Trust: ${claim.trust}`);
    lines.push(`- Artifact: revision ${claim.artifactRevision}, \`${claim.artifactSha256}\``);
    lines.push(`- Claim content hash: \`${claim.contentHash}\``);
    lines.push(`- Selection reason: ${claim.whySelected}`);
    if (claim.evidenceLocators.length) {
      lines.push("- Evidence:");
      for (const evidence of claim.evidenceLocators) lines.push(`  - ${evidence.evidenceId}: ${evidence.locator}`);
    }
    lines.push("");
  }
  lines.push("## Active project memory", "");
  for (const item of pack.projectMemory) lines.push(`### ${item.title || item.memoryId}`, "", item.content, "", `- State: ${item.evidenceState} · ${item.provenance}`, "");
  lines.push("## Limitations", "");
  if (pack.limitations.length) pack.limitations.forEach((item) => lines.push(`- ${item}`));
  else lines.push("- None recorded in the selected evidence.");
  lines.push("", "## Conflicts", "");
  if (pack.conflicts.length) pack.conflicts.forEach((item) => lines.push(`- ${item}`));
  else lines.push("- None recorded in the active project memory.");
  return `${lines.join("\n")}\n`;
}

export async function buildContextPack(support, {
  query,
  projectId = "project-default",
  taskId,
  budgetChars = 16000,
  limit = 5,
  outputDirectory = null,
} = {}) {
  if (!query?.trim()) throw new Error("context build requires a non-empty query");
  if (!PROJECT_ID.test(projectId)) throw new Error(`invalid project ID: ${projectId}`);
  if (!taskId?.trim()) throw new Error("LITEVERSE_TASK_ID or CODEX_THREAD_ID is required for context build");
  if (!Number.isInteger(budgetChars) || budgetChars < 1000 || budgetChars > 1_000_000) throw new Error("budgetChars must be an integer from 1000 through 1000000");
  const [graph, projectContext, search] = await Promise.all([
    readJson(path.join(support, "Graph", "current.json")),
    loadProjectContext(support, projectId),
    searchLiteverse(support, query, { limit }),
  ]);
  const taskHash = hashTask(taskId);
  const selected = [];
  const adoptions = [];
  const limitationTexts = [];
  const literatureBudget = Math.floor(budgetChars * 0.72);
  let used = 0;
  for (const result of search.results) {
    const paper = await readIndexedPaper(support, result.paperId);
    const verified = await verifyPaperArtifact(support, paper, {
      requireClaims: true,
      verifySource: true,
    });
    const candidateClaims = result.matchingClaims.length
      ? result.matchingClaims
      : (verified.claims.claims ?? []).filter((claim) => claim.type !== "project_role").slice(0, 2);
    const accepted = [];
    for (const candidate of candidateClaims) {
      if (!candidate.text || candidate.verificationStatus === "card_draft") continue;
      const remaining = literatureBudget - used;
      if (remaining < 120) break;
      const bounded = truncateText(candidate.text, remaining);
      const evidenceLocators = (candidate.evidence ?? []).map((item) => ({
        evidenceId: item.evidenceId,
        locator: item.locator,
      }));
      const selectionReason = result.relationExpansion?.length
        ? `Verified relation-graph expansion via ${result.relationExpansion.join(", ")}`
        : `BM25 match for query “${query}” in ${candidate.section || candidate.type}`;
      const selectedClaim = {
        paperId: result.paperId,
        paperTitle: result.title,
        title: result.title,
        claimId: candidate.claimId,
        type: candidate.type,
        text: bounded.text,
        artifactRevision: verified.artifact.artifactRevision,
        artifactSha256: verified.artifact.artifactSha256,
        contentHash: sha256Text(candidate.text),
        whySelected: selectionReason,
        reason: selectionReason,
        evidenceLocators,
        trust: claimTrust(candidate),
        verificationStatus: candidate.verificationStatus,
      };
      selected.push(selectedClaim);
      accepted.push(selectedClaim);
      used += bounded.text.length;
    }
    const limitations = (verified.claims.claims ?? []).filter((claim) => claim.type === "limitation").slice(0, 2);
    limitationTexts.push(...limitations.map((claim) => `${result.paperId}: ${claim.text}`));
    if (accepted.length) {
      adoptions.push({
        paperId: result.paperId,
        artifactRevision: verified.artifact.artifactRevision,
        artifactSha256: verified.artifact.artifactSha256,
        claimIds: accepted.map((claim) => claim.claimId),
        evidenceIds: [...new Set(accepted.flatMap((claim) => claim.evidenceLocators.map((item) => item.evidenceId)))],
      });
    }
    if (used >= literatureBudget) break;
  }
  if (!selected.length) throw new Error(`no verified Liteverse claims matched: ${query}`);
  // Every artifact has passed integrity checks before any usage event is appended.
  const usage = [];
  for (const adoption of adoptions) {
    usage.push(await recordUsage(support, taskId, adoption.paperId, { projectId, ...adoption }));
  }
  const projectMemory = memorySelection(projectContext.memory, budgetChars - used);
  const conflicts = (projectContext.memory.items ?? [])
    .filter((item) => item.state === "active" && (item.evidenceState === "contradicted" || item.type === "conflict"))
    .map((item) => `${item.title || item.memoryId}: ${item.content}`);
  const packCore = {
    schemaVersion: "liteverse-context-pack-v1",
    projectId,
    taskHash,
    graphRevision: graph.revision ?? null,
    memoryRevision: projectContext.memory.revision ?? 0,
    memoryLedgerHash: projectContext.memory.ledgerHash ?? null,
    query,
    budgetChars,
    selectedClaims: selected,
    projectMemory,
    conflicts,
    limitations: [...new Set(limitationTexts)],
  };
  const packId = `context-${sha256Text(JSON.stringify(packCore)).slice(0, 20)}`;
  const pack = { ...packCore, packId, contextId: packId };
  const markdown = markdownForPack(pack);
  const directory = outputDirectory
    ? path.resolve(outputDirectory)
    : path.join(support, "Projects", projectId, "Tasks", taskHash, "context-packs");
  await mkdir(directory, { recursive: true });
  const jsonPath = path.join(directory, `${packId}.json`);
  const markdownPath = path.join(directory, `${packId}.md`);
  await atomicWriteJson(jsonPath, pack);
  await atomicWrite(markdownPath, markdown);
  return { pack, usage, markdown, jsonPath, markdownPath };
}
