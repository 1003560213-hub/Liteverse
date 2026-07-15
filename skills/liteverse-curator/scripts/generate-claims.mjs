#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

async function loadRuntime() {
  const candidates = [
    new URL("../../../scripts/lib/liteverse-core.mjs", import.meta.url),
    new URL("../../../liteverse-cli/lib/liteverse-core.mjs", import.meta.url),
    new URL("../../../LiteverseCLI/lib/liteverse-core.mjs", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("Liteverse CLI runtime is missing; reinstall the bundled Skills and CLI");
}

const {
  artifactFields,
  atomicWriteJson,
  readJson,
  snapshotPaperArtifact,
} = await loadRuntime();

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
  console.log(`Usage: generate-claims.mjs [--paper ID ... | --all] [options]

Create stable claim sidecars and immutable card/full-text artifact revisions.
Updates Knowledge/papers.json as a projection; never edits Graph/current.json.

Options:
  --paper ID          Process one paper; repeat as needed
  --all               Process all indexed papers (default when no --paper)
  --support-dir DIR   Liteverse Application Support root
  --snapshot FILE     Pin generated integrity data into an unstaged schema-v3 snapshot
  --skip-pdf-hash     Recovery-only shortcut; preserve the pinned source hash
  --json              Emit machine-readable result`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) return usage();
  const support = path.resolve(argument("--support-dir") ?? process.env.LITEVERSE_SUPPORT_DIR ?? path.join(homedir(), "Library", "Application Support", "Liteverse"));
  const indexPath = path.join(support, "Knowledge", "papers.json");
  const index = await readJson(indexPath);
  if (!Array.isArray(index?.papers)) throw new Error(`invalid papers index: ${indexPath}`);
  const requested = new Set(argumentsFor("--paper"));
  const selected = requested.size ? index.papers.filter((paper) => requested.has(paper.paperId)) : index.papers;
  const missing = [...requested].filter((paperId) => !selected.some((paper) => paper.paperId === paperId));
  if (missing.length) throw new Error(`unknown paper IDs: ${missing.join(", ")}`);
  const updates = new Map();
  const result = [];
  let projectionChanges = 0;
  for (const paper of selected) {
    const artifact = await snapshotPaperArtifact(support, paper, { verifyPdf: !process.argv.includes("--skip-pdf-hash") });
    const projected = {
      ...paper,
      verificationStatus: artifact.card.verificationStatus,
      evidenceCount: artifact.card.evidence.size,
      artifact: artifactFields(artifact),
      artifacts: { ...(paper.artifacts ?? {}), integrity: artifactFields(artifact) },
    };
    updates.set(paper.paperId, projected);
    if (JSON.stringify(projected) !== JSON.stringify(paper)) projectionChanges += 1;
    result.push({
      paperId: paper.paperId,
      artifactRevision: artifact.artifactRevision,
      artifactSha256: artifact.artifactSha256,
      claimCount: artifact.claimCount,
      createdRevision: artifact.changed,
    });
  }
  const needsWrite = projectionChanges > 0 || Number(index.schemaVersion) < 3 || !Number.isInteger(index.revision);
  const next = {
    ...index,
    schemaVersion: Math.max(Number(index.schemaVersion) || 0, 3),
    revision: needsWrite ? (Number(index.revision) || 0) + 1 : index.revision,
    generatedAt: needsWrite ? new Date().toISOString() : index.generatedAt,
    papers: index.papers.map((paper) => updates.get(paper.paperId) ?? paper),
  };
  if (needsWrite) await atomicWriteJson(indexPath, next);
  const snapshotArgument = argument("--snapshot");
  let snapshotPath = null;
  if (snapshotArgument) {
    snapshotPath = path.resolve(snapshotArgument);
    const normalized = snapshotPath.split(path.sep).join("/");
    if (/\/Graph\/current\.json$/.test(normalized) || /\/Graph\/(?:staged|history)\//.test(normalized)) {
      throw new Error("--snapshot must be an unstaged mutable snapshot, never Graph/current, staged, or history");
    }
    const snapshot = await readJson(snapshotPath);
    if (!String(snapshot.schemaVersion ?? "").startsWith("3.") || !Array.isArray(snapshot.papers)) {
      throw new Error("--snapshot must contain a complete schema-v3 papers array");
    }
    const selectedIds = new Set(selected.map((paper) => paper.paperId));
    const found = new Set();
    snapshot.papers = snapshot.papers.map((paper) => {
      if (!selectedIds.has(paper.id)) return paper;
      const indexed = updates.get(paper.id);
      found.add(paper.id);
      return {
        ...paper,
        artifacts: {
          ...(paper.artifacts ?? {}),
          integrity: indexed.artifact,
        },
      };
    });
    const absent = [...selectedIds].filter((paperId) => !found.has(paperId));
    if (absent.length) throw new Error(`snapshot is missing generated papers: ${absent.join(", ")}`);
    await atomicWriteJson(snapshotPath, snapshot);
  }
  const output = { status: "generated", support, count: result.length, projectionChanges, snapshot: snapshotPath, papers: result };
  if (process.argv.includes("--json")) console.log(JSON.stringify(output, null, 2));
  else for (const item of result) console.log(`${item.paperId}: r${item.artifactRevision}, ${item.claimCount} claims${item.createdRevision ? " (new immutable revision)" : ""}`);
}

main().catch((error) => {
  console.error(`generate-claims: ${error.message}`);
  process.exitCode = 2;
});
