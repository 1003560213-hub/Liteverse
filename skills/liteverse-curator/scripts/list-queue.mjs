#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

function fail(message) {
  throw new Error(message);
}

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  console.log(`Usage: list-queue.mjs [--support-dir DIR] [--json]

List pending/processing literature and pending annotations with immutable IDs
and optimistic-lock revisions. This command is read-only.`);
}

async function readOptionalJson(filePath, fallback, label) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
}

function validateRevision(item, label) {
  if (!Number.isInteger(item.revision) || item.revision < 1) fail(`${label} has an invalid revision`);
  if (typeof item.id !== "string" || !item.id) fail(`${label} has an invalid ID`);
}

function sorted(items, compare) {
  return [...items].sort(compare);
}

function sourceProjection(item, support) {
  const storageMode = item.source?.storageMode ?? "managed";
  if (!new Set(["managed", "linked"]).has(storageMode)) {
    fail(`library item ${item.id} has invalid source.storageMode`);
  }
  if (storageMode === "linked") {
    const pdfPath = item.source?.pdfPath ?? item.localPath;
    if (typeof pdfPath !== "string" || !path.isAbsolute(pdfPath) || path.resolve(pdfPath) !== pdfPath) {
      fail(`library item ${item.id} linked PDF path must be normalized and absolute`);
    }
    const linkedRootPath = item.source?.linkedRootPath;
    const relativePath = item.source?.relativePath;
    if (
      typeof linkedRootPath !== "string"
      || !path.isAbsolute(linkedRootPath)
      || path.resolve(linkedRootPath) !== linkedRootPath
      || typeof relativePath !== "string"
      || !relativePath
      || path.isAbsolute(relativePath)
      || relativePath.split(/[\\/]+/).some((part) => !part || part === "." || part === "..")
      || path.resolve(linkedRootPath, ...relativePath.split(/[\\/]+/)) !== pdfPath
    ) {
      fail(`library item ${item.id} linked root and relative path are invalid`);
    }
    return { sourceStorageMode: storageMode, linkedPdfPath: pdfPath };
  }
  return {
    sourceStorageMode: storageMode,
    ...(item.storedFilename
      ? { storedPdfPath: path.join(support, "Library", "PDFs", item.storedFilename) }
      : {}),
  };
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
  const library = await readOptionalJson(
    path.join(support, "library.json"),
    { schemaVersion: 1, nextNumber: 1, items: [] },
    "library.json",
  );
  const annotations = await readOptionalJson(
    path.join(support, "user-annotations.json"),
    [],
    "user-annotations.json",
  );
  if (!library || typeof library !== "object" || Array.isArray(library) || !Array.isArray(library.items)) {
    fail("library.json must be an object with an items array");
  }
  if (!Array.isArray(annotations)) fail("user-annotations.json must be an array");
  for (const [index, item] of library.items.entries()) {
    validateRevision(item, `library item ${index}`);
    if (!Number.isInteger(item.number) || item.number < 1) fail(`library item ${item.id} has an invalid number`);
  }
  for (const [index, item] of annotations.entries()) {
    validateRevision(item, `annotation ${index}`);
    if (typeof item.paperId !== "string" || !item.paperId) fail(`annotation ${item.id} lacks paperId`);
    if (typeof item.text !== "string" || !item.text.trim()) fail(`annotation ${item.id} lacks text`);
  }

  const pendingStatuses = new Set(["pending_codex", "processing", "needs_attention"]);
  const pendingLiterature = sorted(
    library.items.filter((item) => pendingStatuses.has(item.status)).map((item) => ({
      ...item,
      ...sourceProjection(item, support),
    })),
    (left, right) => (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id),
  );
  const readyToRefresh = sorted(
    library.items.filter((item) => item.status === "ready_to_refresh").map((item) => ({
      ...item,
      ...sourceProjection(item, support),
    })),
    (left, right) => (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id),
  );
  const pendingAnnotations = sorted(
    annotations.filter((item) => item.status === "pending"),
    (left, right) => left.paperId.localeCompare(right.paperId) || left.id.localeCompare(right.id),
  );
  const result = { supportDirectory: support, pendingLiterature, readyToRefresh, pendingAnnotations };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!pendingLiterature.length && !readyToRefresh.length && !pendingAnnotations.length) {
    console.log("Liteverse: no pending literature, refreshes, or annotations.");
    return;
  }
  for (const item of pendingLiterature) {
    console.log(`literature ${item.id} [${item.status}] revision ${item.revision}: ${item.displayTitle ?? "Untitled"}`);
  }
  for (const item of readyToRefresh) {
    console.log(`literature ${item.id} [ready_to_refresh] revision ${item.revision}: ${item.displayTitle ?? "Untitled"}`);
  }
  for (const item of pendingAnnotations) {
    console.log(`annotation ${item.id} [pending] revision ${item.revision} for ${item.paperId}`);
  }
}

main().catch((error) => {
  console.error(`list-queue: ${error.message}`);
  process.exitCode = 2;
});
