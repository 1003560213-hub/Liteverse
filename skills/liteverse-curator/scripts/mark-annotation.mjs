#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

function fail(message) {
  throw new Error(message);
}

function argumentsFor(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag) {
      const value = process.argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
      values.push(value);
    }
  }
  return values;
}

function oneArgument(flag) {
  const values = argumentsFor(flag);
  if (values.length !== 1) fail(`${flag} must be supplied exactly once`);
  return values[0];
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) fail(`${label} must be a positive integer`);
  return number;
}

function usage() {
  console.log(`Usage: mark-annotation.mjs --id ID --revision N --refresh-id ID \\
  --derived-file PATH [--derived-file PATH ...] [--support-dir DIR]

Mark exactly one pending annotation organized. Every declared derived file must
contain its Liteverse annotation provenance marker. The staged snapshot, hash,
pending pointer, current base revision, and annotation revision are revalidated.
There is intentionally no bulk or --all mode.`);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") fail(`${label} does not exist: ${filePath}`);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
}

async function atomicWrite(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
}

async function withLock(lockPath, callback) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const details = await stat(lockPath).catch(() => null);
      if (details && Date.now() - details.mtimeMs > 60_000) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) fail(`timed out waiting for lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function insideSupport(support, candidate, label) {
  const resolved = path.resolve(support, candidate);
  if (resolved !== support && !resolved.startsWith(`${support}${path.sep}`)) {
    fail(`${label} must remain inside the Liteverse support directory`);
  }
  return resolved;
}

function assertMatchingRefresh(pending, manifest, snapshot, refreshId) {
  if (pending.refreshId !== refreshId || manifest.refreshId !== refreshId) fail("refresh ID does not match staged files");
  for (const field of ["baseRevision", "targetRevision"]) {
    if (!Number.isInteger(pending[field]) || pending[field] < 1 || pending[field] !== manifest[field]) {
      fail(`${field} is missing or inconsistent between pending update and manifest`);
    }
  }
  if (snapshot.revision !== pending.targetRevision) fail("snapshot revision does not match pending targetRevision");
  if (pending.snapshotSha256 !== manifest.snapshotSha256) fail("pending and manifest snapshot hashes differ");
}

function provenanceMarkers(text, filePath) {
  const values = [];
  const pattern = /<!--\s*liteverse-annotation-provenance:\s*(\{[^\n]*\})\s*-->/g;
  for (const match of text.matchAll(pattern)) {
    try {
      values.push(JSON.parse(match[1]));
    } catch (error) {
      fail(`invalid annotation provenance marker in ${filePath}: ${error.message}`);
    }
  }
  return values;
}

function annotationMirror(annotations, paperId) {
  const notes = annotations.filter((annotation) => annotation.paperId === paperId);
  const title = notes.find((annotation) => annotation.paperTitle)?.paperTitle ?? paperId;
  const lines = [
    `# User annotations: ${title}`,
    "",
    "> Raw notes written in Liteverse. Codex may reorganize them, but must preserve this source record and verification status.",
    "",
  ];
  for (const annotation of notes) {
    lines.push(
      `## ${annotation.id}`,
      "",
      `- Status: \`${annotation.status}\``,
      `- Revision: \`${annotation.revision}\``,
      `- Updated: \`${annotation.updatedAt ?? ""}\``,
      ...(annotation.organizedAt ? [`- Organized: \`${annotation.organizedAt}\``] : []),
      "",
      annotation.text,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function appendAudit(auditPath, event) {
  await mkdir(path.dirname(auditPath), { recursive: true });
  const handle = await open(auditPath, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(event)}\n`, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const annotationId = oneArgument("--id");
  if (["all", "*"].includes(annotationId.toLocaleLowerCase())) fail("bulk annotation marking is forbidden");
  const sourceRevision = positiveInteger(oneArgument("--revision"), "--revision");
  const refreshId = oneArgument("--refresh-id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(refreshId)) fail("--refresh-id contains unsafe characters");
  const derivedArguments = argumentsFor("--derived-file");
  if (derivedArguments.length === 0) fail("at least one --derived-file is required");
  const supportValues = argumentsFor("--support-dir");
  if (supportValues.length > 1) fail("--support-dir may be supplied only once");
  const support = path.resolve(
    supportValues[0]
      ?? process.env.LITEVERSE_SUPPORT_DIR
      ?? path.join(homedir(), "Library", "Application Support", "Liteverse"),
  );
  const annotationsPath = path.join(support, "user-annotations.json");
  const pendingPath = path.join(support, "Graph", "pending-update.json");
  const auditPath = path.join(support, "codex-inbox.jsonl");

  await withLock(path.join(support, ".locks", "mark-annotation.lock"), async () => {
    const pending = await readJson(pendingPath, "Graph/pending-update.json");
    const snapshotPath = insideSupport(support, pending.snapshotPath, "snapshotPath");
    const manifestPath = insideSupport(support, pending.manifestPath, "manifestPath");
    const expectedStage = path.join(support, "Graph", "staged", refreshId);
    if (path.dirname(snapshotPath) !== expectedStage || path.dirname(manifestPath) !== expectedStage) {
      fail("pending refresh paths do not point to the requested staged directory");
    }
    const [manifest, snapshotBytes, current, annotations] = await Promise.all([
      readJson(manifestPath, "staged manifest"),
      readFile(snapshotPath),
      readJson(path.join(support, "Graph", "current.json"), "Graph/current.json"),
      readJson(annotationsPath, "user-annotations.json"),
    ]);
    let snapshot;
    try {
      snapshot = JSON.parse(snapshotBytes.toString("utf8"));
    } catch (error) {
      fail(`staged snapshot is invalid JSON: ${error.message}`);
    }
    assertMatchingRefresh(pending, manifest, snapshot, refreshId);
    const actualHash = createHash("sha256").update(snapshotBytes).digest("hex");
    if (actualHash !== pending.snapshotSha256) fail("staged snapshot SHA-256 does not match pending update");
    if (current.revision !== pending.baseRevision) fail("current graph revision changed after staging");
    if (!Array.isArray(annotations)) fail("user-annotations.json must be an array");
    const annotationIndex = annotations.findIndex((annotation) => annotation.id === annotationId);
    if (annotationIndex < 0) fail(`unknown annotation: ${annotationId}`);
    const annotation = annotations[annotationIndex];
    if (annotation.revision !== sourceRevision) {
      fail(`revision mismatch for ${annotationId}: expected ${sourceRevision}, current ${annotation.revision}`);
    }
    if (annotation.status !== "pending") fail(`${annotationId} is ${annotation.status}, not pending`);

    const derivedFiles = [...new Set(derivedArguments.map((value) => insideSupport(support, value, "derived file")))];
    if (derivedFiles.length !== derivedArguments.length) fail("duplicate --derived-file values are not allowed");
    for (const filePath of derivedFiles) {
      const details = await stat(filePath).catch(() => null);
      if (!details?.isFile() || details.size === 0) fail(`derived file is missing or empty: ${filePath}`);
      const content = await readFile(filePath, "utf8");
      const matches = provenanceMarkers(content, filePath).filter(
        (marker) => marker.annotationId === annotationId && marker.sourceRevision === sourceRevision,
      );
      if (matches.length !== 1) {
        fail(`derived file must contain exactly one matching provenance marker: ${filePath}`);
      }
    }

    const organizedAt = new Date().toISOString();
    const relativeDerivedFiles = derivedFiles.map((filePath) => path.relative(support, filePath));
    const nextAnnotations = annotations.map((item, index) => index === annotationIndex
      ? {
          ...item,
          status: "organized",
          revision: sourceRevision + 1,
          updatedAt: organizedAt,
          organizedAt,
          organizedRefreshId: refreshId,
          derivedFiles: relativeDerivedFiles,
        }
      : item);
    const oldAnnotationsBytes = await readFile(annotationsPath);
    const mirrorPath = path.join(support, "user-notes", `${annotation.paperId}.md`);
    const oldMirrorBytes = await exists(mirrorPath) ? await readFile(mirrorPath) : null;
    let annotationsWritten = false;
    let mirrorWritten = false;
    try {
      await atomicWrite(annotationsPath, Buffer.from(`${JSON.stringify(nextAnnotations, null, 2)}\n`));
      annotationsWritten = true;
      await atomicWrite(mirrorPath, Buffer.from(annotationMirror(nextAnnotations, annotation.paperId)));
      mirrorWritten = true;
      await appendAudit(auditPath, {
        eventId: randomUUID(),
        action: "annotation_organized_by_codex",
        timestamp: organizedAt,
        annotationId,
        sourceRevision,
        organizedRevision: sourceRevision + 1,
        refreshId,
        derivedFiles: relativeDerivedFiles,
      });
    } catch (error) {
      if (annotationsWritten) await atomicWrite(annotationsPath, oldAnnotationsBytes).catch(() => {});
      if (mirrorWritten) {
        if (oldMirrorBytes) await atomicWrite(mirrorPath, oldMirrorBytes).catch(() => {});
        else await rm(mirrorPath, { force: true }).catch(() => {});
      }
      throw error;
    }
    console.log(JSON.stringify({
      status: "organized",
      annotationId,
      sourceRevision,
      organizedRevision: sourceRevision + 1,
      refreshId,
      derivedFiles: relativeDerivedFiles,
    }, null, 2));
  });
}

main().catch((error) => {
  console.error(`mark-annotation: ${error.message}`);
  process.exitCode = 2;
});
