#!/usr/bin/env node
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { recordUsage } from "./_usage-ledger.mjs";
import {
  bounded,
  readVerifiedArtifact,
  selectPages,
  selectSections,
  selectedClaims,
} from "./_artifact-reader.mjs";

const PAPER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argumentsFor(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1] !== undefined) values.push(process.argv[index + 1]);
  }
  return values;
}

function usage() {
  console.log(`Usage: read-paper.mjs --paper PAPER-ID [options]

Options:
  --section NAME       Return one card section; repeat as needed
  --claim CLAIM-ID     Return a pinned claim; repeat as needed
  --evidence E#        Return claims using an evidence ID; repeat as needed
  --page N[-M]         Return selected page-marked full text; repeat as needed
  --fulltext           Include full text, bounded by --max-chars
  --max-chars N        Total output budget, default 24000
  --project ID         Project usage namespace; defaults to LITEVERSE_PROJECT_ID or the active project
  --json               Emit content and count result as JSON
  --support-dir DIR    Liteverse Application Support root
  --task-id ID         Controlled test/recovery override

Task ID order: --task-id, LITEVERSE_TASK_ID, then CODEX_THREAD_ID. Artifact
hashes are verified before the append-only usage event is written.`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) return usage();
  const paperId = argument("--paper");
  if (!paperId || !PAPER_ID.test(paperId)) throw new Error("--paper must be a lowercase Liteverse paper ID");
  const taskId = argument("--task-id") ?? process.env.LITEVERSE_TASK_ID ?? process.env.CODEX_THREAD_ID;
  if (!taskId?.trim()) throw new Error("LITEVERSE_TASK_ID or CODEX_THREAD_ID is required for an adopted read; --task-id is only for controlled tests/recovery");
  const support = path.resolve(argument("--support-dir") ?? process.env.LITEVERSE_SUPPORT_DIR ?? path.join(homedir(), "Library", "Application Support", "Liteverse"));
  const explicitProject = argument("--project") ?? process.env.LITEVERSE_PROJECT_ID;
  let projectId = explicitProject;
  if (!projectId) {
    try {
      const registry = JSON.parse(await readFile(path.join(support, "Projects", "projects.json"), "utf8"));
      projectId = registry.activeProjectId;
      if (Array.isArray(registry.items) &&
          !registry.items.some((item) => (item?.projectId ?? item?.id) === projectId)) {
        throw new Error("activeProjectId is not registered");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`cannot resolve the active Liteverse project: ${error.message}`);
      projectId = "project-default";
    }
  }
  if (!PROJECT_ID.test(projectId ?? "")) throw new Error("--project must be a lowercase Liteverse project ID");
  const sectionSelectors = argumentsFor("--section");
  const claimSelectors = argumentsFor("--claim");
  const evidenceSelectors = argumentsFor("--evidence");
  const pageSelectors = argumentsFor("--page");
  const needsClaims = claimSelectors.length > 0 || evidenceSelectors.length > 0;
  const needsFulltext = process.argv.includes("--fulltext") || pageSelectors.length > 0;
  const artifact = await readVerifiedArtifact(support, paperId, { fulltext: needsFulltext, claims: needsClaims });
  const claims = selectedClaims(artifact.claims, claimSelectors, evidenceSelectors);
  const card = selectSections(artifact.card, sectionSelectors);
  const fulltext = needsFulltext
    ? (pageSelectors.length ? selectPages(artifact.fulltext, pageSelectors) : artifact.fulltext)
    : null;
  if (pageSelectors.length && !fulltext) throw new Error(`requested pages were not found for ${paperId}`);
  const parts = [card.trim()];
  if (claims.length) parts.push(`## Selected claims\n\n${claims.map((claim) => `- **${claim.claimId}** (${claim.section}): ${claim.text}`).join("\n")}`);
  if (fulltext !== null) parts.push(`<!-- liteverse-fulltext-begins: ${paperId} -->\n\n${fulltext.trim()}`);
  const maxChars = Number(argument("--max-chars") ?? 24000);
  const output = bounded(`${parts.join("\n\n")}\n`, maxChars);
  const claimIds = claims.map((claim) => claim.claimId);
  const evidenceIds = [...new Set(claims.flatMap((claim) => claim.evidenceIds ?? []).concat(evidenceSelectors))];
  // The integrity gate above must finish before this call.
  const count = await recordUsage(support, taskId, paperId, {
    projectId,
    artifactRevision: artifact.integrity?.artifactRevision,
    artifactSha256: artifact.integrity?.artifactSha256,
    claimIds,
    evidenceIds,
  });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({
      paperId,
      projectId,
      artifactRevision: artifact.integrity?.artifactRevision ?? null,
      artifactSha256: artifact.integrity?.artifactSha256 ?? null,
      cardPath: artifact.cardPath,
      fulltextPath: needsFulltext ? artifact.fulltextPath : null,
      selectedClaimIds: claimIds,
      selectedEvidenceIds: evidenceIds,
      sections: sectionSelectors,
      pages: pageSelectors,
      maxChars,
      truncated: output.truncated,
      content: output.text,
      ...count,
      // Backward-compatible fields for consumers that expected the old JSON shape.
      card,
      fulltext,
    }, null, 2));
    return;
  }
  process.stdout.write(output.text.endsWith("\n") ? output.text : `${output.text}\n`);
  console.error(`Liteverse usage: ${paperId} ${count.counted ? "counted" : "already counted in this task/project"}; useCount=${count.useCount}`);
  if (count.ignoredPartialTail) console.error("Liteverse usage: ignored an incomplete final ledger fragment; rebuild remains possible.");
}

main().catch((error) => {
  console.error(`read-paper: ${error.message}`);
  process.exitCode = 2;
});
