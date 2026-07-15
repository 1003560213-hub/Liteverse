#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const scoreScript = fileURLToPath(new URL("./score-connection.mjs", import.meta.url));

function fail(message) {
  throw new Error(message);
}

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function protectedGraphKind(pathname) {
  const parts = path.normalize(pathname).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== "Graph") continue;
    const tail = parts.slice(index + 1);
    if (tail.length === 1 && tail[0] === "current.json") return "Graph/current.json";
    if (tail[0] === "staged") return "immutable Graph/staged artifact";
    if (tail[0] === "history") return "immutable Graph/history artifact";
  }
  return undefined;
}

async function refuseProtectedGraphTarget(pathname) {
  const candidates = new Set([path.resolve(pathname)]);
  try {
    candidates.add(await realpath(pathname));
  } catch {
    // The normal JSON read below reports a missing file.  The lexical guard is
    // still effective before that read.
  }
  for (const candidate of candidates) {
    const kind = protectedGraphKind(candidate);
    if (kind) fail(`refusing to modify ${kind}`);
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

async function json(pathname) {
  return JSON.parse(await readFile(pathname, "utf8"));
}

async function jsonFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const pathname = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name !== "inputs") output.push(...await jsonFiles(pathname));
    else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "summary.json") output.push(pathname);
  }
  return output.sort();
}

async function atomicWrite(pathname, text) {
  const directory = path.dirname(pathname);
  const temporaryDirectory = await mkdtemp(path.join(directory, ".relation-merge-"));
  const temporary = path.join(temporaryDirectory, path.basename(pathname));
  try {
    await writeFile(temporary, text, "utf8");
    await rename(temporary, pathname);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function deterministicRescore(pathname) {
  const output = execFileSync(process.execPath, [scoreScript, "--input", pathname], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(output);
}

async function main() {
  const snapshotPath = argument("--snapshot");
  const reviewDirectory = argument("--review-dir");
  if (!snapshotPath || !reviewDirectory) {
    fail("Usage: merge-relation-review.mjs --snapshot snapshot.json --review-dir relation-review [--support-dir path] [--require-all] [--dry-run]");
  }
  const explicitSupport = argument("--support-dir");
  const resolvedSnapshot = path.resolve(snapshotPath);
  const support = path.resolve(
    explicitSupport
      || process.env.LITEVERSE_SUPPORT_DIR
      || path.join(process.env.HOME, "Library", "Application Support", "Liteverse"),
  );
  await refuseProtectedGraphTarget(snapshotPath);
  const snapshot = await json(resolvedSnapshot);
  if (!String(snapshot.schemaVersion || "").startsWith("3.")) fail("only schema-v3 unstaged snapshots may be merged");
  if (!Array.isArray(snapshot.relations)) fail("snapshot relations must be an array");

  const existing = new Map(snapshot.relations.map((relation) => [relation.id, relation]));
  if (existing.size !== snapshot.relations.length || existing.has(undefined)) fail("snapshot relation IDs must be unique strings");
  const reviewed = new Map();
  for (const pathname of await jsonFiles(path.resolve(reviewDirectory))) {
    const scored = await json(pathname);
    if (!scored.id || typeof scored.id !== "string") fail(`review has no relation id: ${pathname}`);
    if (reviewed.has(scored.id)) fail(`duplicate relation review: ${scored.id}`);
    const current = existing.get(scored.id);
    if (!current) fail(`review does not match a snapshot relation: ${scored.id}`);
    if (scored.source !== current.source || scored.target !== current.target) {
      fail(`review endpoints changed for ${scored.id}`);
    }
    const rescored = deterministicRescore(pathname);
    if (JSON.stringify(stable(scored)) !== JSON.stringify(stable(rescored))) {
      fail(`review is not a deterministic score-connection output: ${scored.id}`);
    }
    if (!["suggestion", "candidate", "verified"].includes(scored.status)) {
      fail(`invalid publication status for ${scored.id}`);
    }
    reviewed.set(scored.id, scored);
  }

  if (hasFlag("--require-all")) {
    const missing = [...existing.keys()].filter((id) => !reviewed.has(id));
    if (missing.length) fail(`missing relation reviews: ${missing.join(", ")}`);
  }
  if (!reviewed.size) fail("no scored relation reviews found");

  snapshot.relations = snapshot.relations.map((current) => {
    const scored = reviewed.get(current.id);
    if (!scored) return current;
    return {
      ...current,
      ...scored,
      relationVersion: "liteverse-relation-v1",
      scoringStatus: "scored_v1",
      ...(current.legacyConfidence === undefined ? {} : { legacyConfidence: current.legacyConfidence }),
      ...(current.legacyStatus === undefined ? {} : { legacyStatus: current.legacyStatus }),
    };
  });
  snapshot.updated = new Date().toISOString();
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (!hasFlag("--dry-run")) await atomicWrite(resolvedSnapshot, serialized);
  const statusCounts = Object.fromEntries(
    ["suggestion", "candidate", "verified"].map((status) => [
      status,
      [...reviewed.values()].filter((relation) => relation.status === status).length,
    ]),
  );
  process.stdout.write(`${JSON.stringify({
    status: hasFlag("--dry-run") ? "validated" : "merged",
    supportDir: support,
    snapshot: resolvedSnapshot,
    snapshotSha256: createHash("sha256").update(serialized).digest("hex"),
    reviewedRelationCount: reviewed.size,
    statusCounts,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`merge-relation-review: ${error.message}`);
  process.exitCode = 2;
});
