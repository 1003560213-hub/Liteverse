#!/usr/bin/env -S node --no-warnings
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readJson, resolveProjectId, resolveSupport } from "./lib/liteverse-core.mjs";

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integer(flag, fallback, minimum, maximum) {
  const value = Number(argument(flag) ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function help() {
  console.log(`Liteverse local research-memory CLI

Usage:
  liteverse-cli.mjs status [--json]
  liteverse-cli.mjs search --query TEXT [--limit N] [--json]
  liteverse-cli.mjs context build --query TEXT [--project ID] [--budget-chars N] [--limit N] [--json]
  liteverse-cli.mjs evidence read --paper ID [--section NAME] [--claim ID] [--evidence E#] [--page N[-M]] [--max-chars N] [--json]
  liteverse-cli.mjs memory search --query TEXT [--project ID | --all-projects]
  liteverse-cli.mjs task begin|complete --project ID [research-memory options]
  liteverse-cli.mjs project create-or-init --project ID [research-memory options]
  liteverse-cli.mjs doctor [--fix] [--quick] [--json]
  liteverse-cli.mjs index rebuild [--json]

Common options:
  --support-dir DIR    Liteverse Application Support root
  --task-id ID         Controlled test/recovery task ID override

Task identity resolves as --task-id, LITEVERSE_TASK_ID, then CODEX_THREAD_ID.
Search and status never increment usage. Context build and evidence read adopt
verified artifacts and count once per task, project, and paper.`);
}

function output(value, json, human) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(human(value));
}

async function status(support, json) {
  const [graph, papers, projects, pending, counts] = await Promise.all([
    readJson(path.join(support, "Graph", "current.json"), { optional: true }),
    readJson(path.join(support, "Knowledge", "papers.json"), { optional: true }),
    readJson(path.join(support, "Projects", "projects.json"), { optional: true }),
    readJson(path.join(support, "Graph", "pending-update.json"), { optional: true }),
    readJson(path.join(support, "Usage", "counts.json"), { optional: true }),
  ]);
  let artifactCount = 0;
  try {
    artifactCount = (await readdir(path.join(support, "Knowledge", "artifacts"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const value = {
    schemaVersion: "liteverse-status-v1",
    support,
    graphRevision: graph?.revision ?? null,
    graphPaperCount: graph?.papers?.length ?? 0,
    indexedPaperCount: papers?.papers?.length ?? 0,
    pinnedArtifactCount: artifactCount,
    projectCount: projects?.items?.length ?? projects?.projects?.length ?? 0,
    activeProjectId: projects?.activeProjectId ?? "project-default",
    pendingRefresh: pending?.refreshId ?? null,
    uniqueUsageCount: counts?.uniqueEventCount ?? 0,
  };
  output(value, json, (item) => [
    `Liteverse: ${item.graphPaperCount} papers · graph r${item.graphRevision ?? "?"}`,
    `Artifacts: ${item.pinnedArtifactCount}/${item.indexedPaperCount} pinned`,
    `Projects: ${item.projectCount} · active ${item.activeProjectId}`,
    `Pending Refresh: ${item.pendingRefresh ?? "none"}`,
    `Adopted evidence events: ${item.uniqueUsageCount}`,
  ].join("\n"));
}

async function delegateEvidence(support) {
  const script = resolveSkillScript("liteverse-retriever", "read-paper.mjs");
  const forwarded = process.argv.slice(4).filter((value, index, all) => {
    if (value === "--support-dir") return false;
    if (index > 0 && all[index - 1] === "--support-dir") return false;
    return true;
  });
  const args = [script, ...forwarded, "--support-dir", support];
  const taskId = argument("--task-id");
  if (taskId && !args.includes("--task-id")) args.push("--task-id", taskId);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`evidence reader exited ${code ?? signal}`)));
  });
}

function resolveSkillScript(skillName, scriptName) {
  for (const directory of ["skills", "CodexSkills"]) {
    const candidate = path.resolve(import.meta.dirname, "..", directory, skillName, "scripts", scriptName);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`bundled Skill script is missing: ${skillName}/${scriptName}`);
}

function withoutSupportArguments(values) {
  return values.filter((value, index, all) => {
    if (value === "--support-dir") return false;
    if (index > 0 && all[index - 1] === "--support-dir") return false;
    return true;
  });
}

async function delegateResearchMemory(support, commandArguments) {
  const script = resolveSkillScript("liteverse-research-memory", "research-memory.mjs");
  const args = [script, ...withoutSupportArguments(commandArguments), "--support-dir", support];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`research-memory command exited ${code ?? signal}`)));
  });
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h") || process.argv.length < 3) return help();
  const [command, subcommand] = process.argv.slice(2);
  const support = resolveSupport(argument("--support-dir"));
  const json = process.argv.includes("--json");
  if (command === "status") return status(support, json);
  if (command === "search") {
    const { searchLiteverse } = await import("./lib/liteverse-search.mjs");
    const result = await searchLiteverse(support, argument("--query"), { limit: integer("--limit", 10, 1, 100) });
    return output(result, json, (item) => item.results.length
      ? item.results.map((paper) => `${paper.paperId}\t${paper.title}\tBM25=${paper.rank.toFixed(4)}`).join("\n")
      : `No Liteverse papers matched: ${item.query}`);
  }
  if (command === "context" && subcommand === "build") {
    const { buildContextPack } = await import("./lib/liteverse-context.mjs");
    const projectId = await resolveProjectId(support, argument("--project"));
    const taskId = argument("--task-id") ?? process.env.LITEVERSE_TASK_ID ?? process.env.CODEX_THREAD_ID;
    const result = await buildContextPack(support, {
      query: argument("--query"),
      projectId,
      taskId,
      budgetChars: integer("--budget-chars", 16000, 1000, 1_000_000),
      limit: integer("--limit", 5, 1, 30),
      outputDirectory: argument("--output-dir"),
    });
    return output({ ...result.pack, usage: result.usage, paths: { json: result.jsonPath, markdown: result.markdownPath } }, json, () => result.markdown);
  }
  if (command === "evidence" && subcommand === "read") return delegateEvidence(support);
  if (command === "memory" && subcommand === "search") {
    return delegateResearchMemory(support, ["search", ...process.argv.slice(4)]);
  }
  if (command === "task" && (subcommand === "begin" || subcommand === "complete")) {
    return delegateResearchMemory(support, process.argv.slice(2));
  }
  if (command === "project" && subcommand === "create-or-init") {
    return delegateResearchMemory(support, process.argv.slice(2));
  }
  if (command === "doctor") {
    const { doctorLiteverse } = await import("./lib/liteverse-doctor.mjs");
    const result = await doctorLiteverse(support, { fix: process.argv.includes("--fix"), deep: !process.argv.includes("--quick") });
    output(result, json, (item) => [
      `Liteverse Doctor: ${item.status.toUpperCase()} · ${item.paperCount} papers · graph r${item.graphRevision}`,
      `Findings: ${item.counts.error} errors, ${item.counts.warning} warnings`,
      ...(item.fixed ? [`Repaired ${item.updatedPapers} paper projections; created ${item.artifactRevisionsCreated} artifact revisions.`] : []),
      ...item.findings.map((entry) => `[${entry.severity}] ${entry.code}: ${entry.message}`),
    ].join("\n"));
    if (result.counts.error) process.exitCode = 2;
    return;
  }
  if (command === "index" && subcommand === "rebuild") {
    const { rebuildSearchIndex } = await import("./lib/liteverse-search.mjs");
    const result = await rebuildSearchIndex(support);
    return output(result, json, (item) => `Rebuilt ${item.databasePath} for ${item.paperCount} papers.`);
  }
  throw new Error(`unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}

main().catch((error) => {
  console.error(`liteverse: ${error.message}`);
  process.exitCode = 2;
});
