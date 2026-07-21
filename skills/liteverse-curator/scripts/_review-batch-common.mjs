import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

export const BATCH_SCHEMA = "liteverse-curation-review-batch-v1";
export const CHECKPOINT_SCHEMA = "liteverse-curation-review-checkpoint-v1";
export const DECISION_SCHEMA = "liteverse-curation-decisions-v1";
export const RESULT_SCHEMA = "liteverse-curation-review-result-v1";
export const ATTESTATION_SCHEMA = "liteverse-original-page-review-v1";

const shaPattern = /^[a-f0-9]{64}$/;
const candidateKinds = new Set([
  "research_question",
  "method",
  "result",
  "limitation",
  "assumption",
  "section",
  "equation",
  "figure",
  "table",
  "citation",
]);
const navigationKinds = new Set(["section", "figure", "table", "citation"]);
const kindOrder = new Map([
  "research_question",
  "method",
  "result",
  "limitation",
  "assumption",
  "equation",
  "figure",
  "table",
  "section",
  "citation",
].map((kind, index) => [kind, index]));

export function fail(message) {
  throw new Error(message);
}

export function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

export function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}

export function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text) {
  return sha256(Buffer.from(text, "utf8"));
}

export function assertSha(value, label) {
  if (typeof value !== "string" || !shaPattern.test(value)) fail(`${label} must be a lowercase SHA-256`);
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

export async function readJsonBytes(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    fail(`${label} cannot be read: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
  return { bytes, value };
}

export async function readOptionalJson(filePath, fallback, label) {
  try {
    return (await readJsonBytes(filePath, label)).value;
  } catch (error) {
    if (/ cannot be read: ENOENT:/.test(error.message)) return structuredClone(fallback);
    throw error;
  }
}

export function inside(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(`${label} escapes ${resolvedRoot}`);
  }
  return resolved;
}

export function supportRelative(support, relative, label) {
  nonempty(relative, label);
  if (path.isAbsolute(relative)) fail(`${label} must be relative to the support directory`);
  const parts = relative.split(/[\\/]+/);
  if (parts.some((part) => !part || part === "." || part === "..")) fail(`${label} is unsafe`);
  return inside(support, path.join(support, ...parts), label);
}

async function durableWrite(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  const directory = await open(path.dirname(filePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function atomicWriteJson(filePath, value) {
  await durableWrite(filePath, Buffer.from(stableJson(value), "utf8"));
}

export async function atomicWriteText(filePath, text) {
  await durableWrite(filePath, Buffer.from(text, "utf8"));
}

export async function fileSha(filePath) {
  return sha256(await readFile(filePath));
}

async function readLockOwner(lockPath) {
  try {
    const owner = (await readJsonBytes(path.join(lockPath, "owner.json"), "lock owner")).value;
    return owner && typeof owner === "object" && !Array.isArray(owner) ? owner : null;
  } catch {
    // A creator may still be publishing owner.json, and legacy locks did not
    // have an owner at all. Both states are busy, never grounds for deletion.
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function withDirectoryLock(lockPath, action, operation = "Curator transaction") {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 15_000;
  const token = randomUUID();
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await atomicWriteJson(path.join(lockPath, "owner.json"), {
          schemaVersion: 1,
          pid: process.pid,
          createdAt: new Date().toISOString(),
          token,
          operation,
        });
      } catch (ownerError) {
        await rm(lockPath, { recursive: true, force: true });
        throw ownerError;
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const details = await stat(lockPath);
        const owner = await readLockOwner(lockPath);
        if (Date.now() - details.mtimeMs > 60_000
            && typeof owner?.token === "string" && owner.token
            && Number.isInteger(owner.pid) && !processIsAlive(owner.pid)) {
          const quarantinePath = `${lockPath}.stale.${randomUUID()}`;
          await rename(lockPath, quarantinePath);
          await rm(quarantinePath, { recursive: true, force: true });
          continue;
        }
      } catch (inspectionError) {
        if (inspectionError.code === "ENOENT") continue;
        // A legacy ownerless file or a concurrently published owner is busy.
        // Preserve it and let the ordinary timeout report the conflict.
      }
      if (Date.now() >= deadline) fail(`timed out waiting for lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await action();
  } finally {
    const owner = await readLockOwner(lockPath);
    if (owner?.token === token) await rm(lockPath, { recursive: true, force: true });
  }
}

export async function withPlanningLock(support, action) {
  const planningRoot = path.join(support, "Planning", "Curator");
  await mkdir(planningRoot, { recursive: true });
  const lockPath = path.join(planningRoot, ".review-batch.lock");
  return withDirectoryLock(lockPath, () => action(planningRoot), "Curator review-batch transaction");
}

function manifestOutput(manifest, role) {
  const outputs = Array.isArray(manifest.outputs) ? manifest.outputs : fail("local preparation manifest outputs must be an array");
  const matches = outputs.filter((output) => output?.role === role);
  if (matches.length !== 1) fail(`local preparation manifest must contain exactly one ${role} output`);
  return object(matches[0], `${role} output`);
}

async function validateOutput(jobDirectory, raw, role) {
  const output = object(raw, `${role} output`);
  const relative = nonempty(output.path, `${role} output.path`);
  if (path.isAbsolute(relative) || relative.split(/[\\/]+/).some((part) => !part || part === "." || part === "..")) {
    fail(`${role} output.path is unsafe`);
  }
  const outputPath = inside(jobDirectory, path.join(jobDirectory, ...relative.split(/[\\/]+/)), `${role} output.path`);
  const [canonicalJob, canonicalOutput, outputInfo] = await Promise.all([
    realpath(jobDirectory),
    realpath(outputPath),
    lstat(outputPath),
  ]);
  inside(canonicalJob, canonicalOutput, `${role} output real path`);
  if (outputInfo.isSymbolicLink() || !outputInfo.isFile()) fail(`${role} output must be a regular, non-symlink file`);
  const bytes = await readFile(outputPath);
  if (sha256(bytes) !== assertSha(output.sha256, `${role} output.sha256`)) fail(`${role} output hash mismatch`);
  if (!Number.isInteger(output.size) || output.size !== bytes.byteLength) fail(`${role} output size mismatch`);
  return { outputPath, bytes, sha256: output.sha256, size: output.size };
}

function candidateText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function clipped(value, limit) {
  const text = candidateText(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function normalizeV2Candidate(raw, topSourceSha, label) {
  const item = object(raw, label);
  const aliases = [item.id, item.candidateId, item.anchorId].filter((value) => typeof value === "string" && value);
  if (aliases.length === 0 || new Set(aliases).size !== 1) fail(`${label} requires one consistent id/candidateId/anchorId`);
  const candidateId = aliases[0];
  if (!/^rp2-(?:candidate|anchor)-[a-f0-9]{64}$/.test(candidateId)) fail(`${label}.id is not source-pinned`);
  const kind = nonempty(item.kind, `${label}.kind`);
  if (!candidateKinds.has(kind)) fail(`${label}.kind is unsupported`);
  const page = positiveInteger(item.page, `${label}.page`);
  if (item.sourceSha256 !== topSourceSha) fail(`${label}.sourceSha256 does not match the packet`);
  const pageTextSha256 = assertSha(item.pageTextSha256, `${label}.pageTextSha256`);
  const range = object(item.characterRange, `${label}.characterRange`);
  if (!Number.isInteger(range.start) || range.start < 0 || !Number.isInteger(range.end) || range.end <= range.start || range.encoding !== "utf16") {
    fail(`${label}.characterRange must be a positive UTF-16 half-open range`);
  }
  const text = clipped(item.text, 2400);
  if (!text) fail(`${label}.text is empty`);
  if (item.status !== "provisional" || item.purpose !== "routing_only" || item.verificationState !== "unverified") {
    fail(`${label} is not an unverified routing-only candidate`);
  }
  const context = object(item.context, `${label}.context`);
  const section = item.section === null || item.section === undefined ? null : clipped(item.section, 240);
  return {
    candidateId,
    kind,
    sourceAnchor: {
      page,
      locator: `PDF p. ${page}${section ? `, ${section}` : ""}`,
      section,
      ordinal: Number.isInteger(item.ordinal) && item.ordinal >= 0 ? item.ordinal : 0,
      characterRange: { start: range.start, end: range.end, encoding: "utf16" },
      pageTextSha256,
    },
    text,
    context: {
      previous: clipped(context.previous, 800) || null,
      next: clipped(context.next, 800) || null,
    },
    signals: Array.isArray(item.signals)
      ? [...new Set(item.signals.filter((signal) => typeof signal === "string" && signal.trim()).map((signal) => clipped(signal, 120)))].sort()
      : [],
    routingScore: Number.isInteger(item.routingScore) ? item.routingScore : 0,
    status: "provisional",
    purpose: "routing_only",
    verificationState: "unverified",
  };
}

function normalizeV1Candidate(raw, topSourceSha, kind, index, label) {
  const item = object(raw, label);
  const page = positiveInteger(item.page, `${label}.page`);
  const text = clipped(item.text, 2400);
  if (!text) fail(`${label}.text is empty`);
  if (item.status !== "provisional" || item.purpose !== "routing_only") fail(`${label} is not routing-only`);
  const candidateId = `rp1-${sha256Text(stableJson({ sourceSha256: topSourceSha, kind, page, text, index }))}`;
  return {
    candidateId,
    kind,
    sourceAnchor: {
      page,
      locator: `PDF p. ${page}`,
      section: null,
      ordinal: index,
      characterRange: null,
      pageTextSha256: null,
    },
    text,
    context: { previous: null, next: null },
    signals: Array.isArray(item.signals)
      ? [...new Set(item.signals.filter((signal) => typeof signal === "string" && signal.trim()).map((signal) => clipped(signal, 120)))].sort()
      : [],
    routingScore: 0,
    status: "provisional",
    purpose: "routing_only",
    verificationState: "unverified",
  };
}

function flattenedV2(packet) {
  const groups = [];
  const candidateSets = object(packet.candidateSets, "review packet candidateSets");
  const mapping = [
    ["researchQuestions", "research_question"],
    ["methods", "method"],
    ["results", "result"],
    ["limitations", "limitation"],
    ["assumptions", "assumption"],
  ];
  for (const [name] of mapping) {
    if (!Array.isArray(candidateSets[name])) fail(`review packet candidateSets.${name} must be an array`);
    groups.push(...candidateSets[name]);
  }
  const anchors = object(packet.anchors, "review packet anchors");
  for (const name of ["sections", "equations", "figures", "tables", "citations"]) {
    if (!Array.isArray(anchors[name])) fail(`review packet anchors.${name} must be an array`);
    groups.push(...anchors[name]);
  }
  return groups;
}

function normalizedCandidates(packet) {
  const sourceSha = assertSha(packet.sourceSha256, "review packet sourceSha256");
  let candidates;
  if (packet.schemaVersion === "liteverse-review-packet-v2") {
    const quality = Array.isArray(packet.pageExtractionQuality)
      ? packet.pageExtractionQuality
      : fail("v2 review packet pageExtractionQuality must be an array");
    const pageHashes = new Map();
    for (const [index, raw] of quality.entries()) {
      const item = object(raw, `pageExtractionQuality[${index}]`);
      const page = positiveInteger(item.page, `pageExtractionQuality[${index}].page`);
      if (pageHashes.has(page)) fail(`duplicate pageExtractionQuality page ${page}`);
      pageHashes.set(page, assertSha(item.pageTextSha256, `pageExtractionQuality[${index}].pageTextSha256`));
    }
    candidates = flattenedV2(packet).map((item, index) => normalizeV2Candidate(item, sourceSha, `v2 candidate[${index}]`));
    for (const candidate of candidates) {
      if (pageHashes.get(candidate.sourceAnchor.page) !== candidate.sourceAnchor.pageTextSha256) {
        fail(`candidate ${candidate.candidateId} pageTextSha256 is not pinned by pageExtractionQuality`);
      }
    }
  } else if (packet.schemaVersion === "liteverse-review-packet-v1") {
    const sentence = object(packet.sentenceCandidates, "review packet sentenceCandidates");
    const groups = [
      [packet.sectionHeadingCandidates, "section"],
      [packet.equationLikeLineCandidates, "equation"],
      [sentence.methods, "method"],
      [sentence.results, "result"],
      [sentence.limitations, "limitation"],
    ];
    candidates = [];
    for (const [rawItems, kind] of groups) {
      if (!Array.isArray(rawItems)) fail(`v1 review packet ${kind} candidates must be an array`);
      for (const raw of rawItems) candidates.push(normalizeV1Candidate(raw, sourceSha, kind, candidates.length, `v1 ${kind} candidate`));
    }
  } else {
    fail(`unsupported review packet schemaVersion: ${packet.schemaVersion ?? "missing"}`);
  }
  const unique = new Map();
  for (const candidate of candidates) {
    if (unique.has(candidate.candidateId)) fail(`duplicate review candidate ${candidate.candidateId}`);
    unique.set(candidate.candidateId, candidate);
  }
  return [...unique.values()].sort((left, right) =>
    (kindOrder.get(left.kind) ?? 999) - (kindOrder.get(right.kind) ?? 999)
      || right.routingScore - left.routingScore
      || left.sourceAnchor.page - right.sourceAnchor.page
      || (left.sourceAnchor.characterRange?.start ?? left.sourceAnchor.ordinal)
        - (right.sourceAnchor.characterRange?.start ?? right.sourceAnchor.ordinal)
      || left.candidateId.localeCompare(right.candidateId));
}

async function validateLinkedSource(item, expectedSha) {
  const descriptor = object(item.source, `library item ${item.id} source`);
  const pdfPath = nonempty(descriptor.pdfPath ?? item.localPath, `library item ${item.id} linked pdfPath`);
  const rootPath = nonempty(descriptor.linkedRootPath, `library item ${item.id} linkedRootPath`);
  if (!path.isAbsolute(pdfPath) || path.resolve(pdfPath) !== pdfPath || !path.isAbsolute(rootPath) || path.resolve(rootPath) !== rootPath) {
    fail(`library item ${item.id} linked paths must be normalized and absolute`);
  }
  const relative = nonempty(descriptor.relativePath, `library item ${item.id} source.relativePath`);
  if (path.isAbsolute(relative) || relative.split(/[\\/]+/).some((part) => !part || part === "." || part === "..")) {
    fail(`library item ${item.id} source.relativePath is unsafe`);
  }
  if (path.resolve(rootPath, ...relative.split(/[\\/]+/)) !== pdfPath) fail(`library item ${item.id} linked path does not match its root`);
  if (await realpath(rootPath) !== rootPath || await realpath(pdfPath) !== pdfPath) fail(`library item ${item.id} linked paths are not canonical`);
  let cursor = rootPath;
  for (const part of relative.split(/[\\/]+/)) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) fail(`library item ${item.id} linked source traverses a symbolic link`);
  }
  if ((await fileSha(pdfPath)) !== expectedSha) fail(`library item ${item.id} linked source hash mismatch`);
}

async function validateManagedSource(support, item, manifest, jobDirectory, expectedSha) {
  let sourcePath = null;
  if (typeof item.storedFilename === "string" && item.storedFilename) {
    if (path.basename(item.storedFilename) !== item.storedFilename) fail(`library item ${item.id} storedFilename is unsafe`);
    sourcePath = path.join(support, "Library", "PDFs", item.storedFilename);
    try {
      await stat(sourcePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      sourcePath = null;
    }
  }
  if (!sourcePath) {
    const pdfOutput = manifestOutput(manifest, "pdf");
    sourcePath = (await validateOutput(jobDirectory, pdfOutput, "pdf")).outputPath;
  }
  const sourceInfo = await lstat(sourcePath);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) fail(`library item ${item.id} managed source must be a regular, non-symlink file`);
  if ((await fileSha(sourcePath)) !== expectedSha) fail(`library item ${item.id} managed source hash mismatch`);
}

export async function loadPreparedItem(support, item, { allowCatalogDrift = false } = {}) {
  object(item, "library item");
  const itemId = nonempty(item.id, "library item.id");
  const itemRevision = positiveInteger(item.revision, `library item ${itemId} revision`);
  if (!["pending_codex", "processing"].includes(item.status)) fail(`library item ${itemId} is not pending Curator review`);
  const preparation = object(item.preparation, `library item ${itemId} preparation`);
  if (preparation.schemaVersion !== 1 || preparation.state !== "ready") fail(`library item ${itemId} preparation is not ready schema v1`);
  const sourceRevision = positiveInteger(preparation.sourceRevision, `library item ${itemId} preparation.sourceRevision`);
  if (itemRevision !== sourceRevision + 1) fail(`library item ${itemId} revision is not the committed successor of preparation.sourceRevision`);
  const jobId = nonempty(preparation.jobId, `library item ${itemId} preparation.jobId`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) fail(`library item ${itemId} preparation.jobId is unsafe`);
  const manifestPath = supportRelative(support, preparation.manifestPath, `library item ${itemId} preparation.manifestPath`);
  const expectedDirectory = path.join(support, "Work", "LocalPipeline", jobId);
  if (path.dirname(manifestPath) !== expectedDirectory || path.basename(manifestPath) !== "manifest.json") {
    fail(`library item ${itemId} manifestPath does not match its jobId`);
  }
  const [canonicalJob, canonicalManifest, manifestInfo] = await Promise.all([
    realpath(expectedDirectory),
    realpath(manifestPath),
    lstat(manifestPath),
  ]);
  inside(canonicalJob, canonicalManifest, `library item ${itemId} manifest real path`);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) fail(`library item ${itemId} manifest must be a regular, non-symlink file`);
  const manifestRead = await readJsonBytes(manifestPath, `library item ${itemId} local preparation manifest`);
  const manifestSha = sha256(manifestRead.bytes);
  if (manifestSha !== assertSha(preparation.resultSha256, `library item ${itemId} preparation.resultSha256`)) {
    fail(`library item ${itemId} preparation manifest hash mismatch`);
  }
  const manifest = object(manifestRead.value, `library item ${itemId} local preparation manifest`);
  if (manifest.schemaVersion !== "liteverse-local-result-v1" || manifest.state !== "ready" || manifest.extractionStatus !== "extracted") {
    fail(`library item ${itemId} local preparation is not an extracted ready result`);
  }
  if (manifest.itemId !== itemId || manifest.itemRevision !== sourceRevision || manifest.jobId !== jobId) {
    fail(`library item ${itemId} manifest identity or revision is stale`);
  }
  const catalogPath = path.join(support, "Knowledge", "papers.json");
  let catalogFingerprint = "absent";
  try {
    catalogFingerprint = await fileSha(catalogPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (manifest.catalogFingerprint !== "absent") {
    assertSha(manifest.catalogFingerprint, `library item ${itemId} manifest.catalogFingerprint`);
  }
  if (manifest.catalogFingerprint !== catalogFingerprint && !allowCatalogDrift) {
    fail(`library item ${itemId} catalog fingerprint is stale`);
  }
  const sourceSha = assertSha(manifest.sourceSha256, `library item ${itemId} manifest.sourceSha256`);
  if (item.source?.sha256 !== undefined && item.source.sha256 !== sourceSha) fail(`library item ${itemId} source descriptor hash mismatch`);
  const storageMode = item.source?.storageMode ?? manifest.canonicalMetadata?.storageMode ?? "managed";
  if (storageMode !== (manifest.canonicalMetadata?.storageMode ?? storageMode)) fail(`library item ${itemId} storage mode mismatch`);
  if (storageMode === "linked") await validateLinkedSource(item, sourceSha);
  else if (storageMode === "managed") await validateManagedSource(support, item, manifest, expectedDirectory, sourceSha);
  else fail(`library item ${itemId} has unsupported storage mode ${storageMode}`);

  const roles = new Set();
  for (const raw of manifest.outputs) {
    const role = nonempty(raw?.role, `library item ${itemId} output role`);
    if (roles.has(role)) fail(`library item ${itemId} has duplicate ${role} outputs`);
    roles.add(role);
    await validateOutput(expectedDirectory, raw, role);
  }
  for (const required of ["fulltext", "card", "review_packet"]) {
    if (!roles.has(required)) fail(`library item ${itemId} lacks ${required} output`);
  }
  if ((storageMode === "linked") === roles.has("pdf")) fail(`library item ${itemId} pdf output does not match storage mode`);

  const packetArtifact = await validateOutput(expectedDirectory, manifestOutput(manifest, "review_packet"), "review_packet");
  let packet;
  try {
    packet = JSON.parse(packetArtifact.bytes.toString("utf8"));
  } catch (error) {
    fail(`library item ${itemId} review packet is invalid JSON: ${error.message}`);
  }
  object(packet, `library item ${itemId} review packet`);
  if (packet.itemId !== itemId || packet.itemRevision !== sourceRevision || packet.sourceSha256 !== sourceSha) {
    fail(`library item ${itemId} review packet identity, revision, or source hash is stale`);
  }
  if (packet.status !== "provisional" || packet.purpose !== "routing_only") fail(`library item ${itemId} review packet is not routing-only`);
  const candidates = normalizedCandidates(packet);
  const packetCandidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
  const rawShortlist = preparation.screeningCandidates ?? [];
  if (!Array.isArray(rawShortlist) || rawShortlist.length > 24) {
    fail(`library item ${itemId} relation screening candidates must be an array of at most 24 entries`);
  }
  const seenShortlistPaperIds = new Set();
  const relationCandidates = rawShortlist.map((raw, index) => {
    const entry = object(raw, `library item ${itemId} screeningCandidates[${index}]`);
    const paperId = nonempty(entry.paperId, `library item ${itemId} screeningCandidates[${index}].paperId`);
    if (seenShortlistPaperIds.has(paperId)) fail(`library item ${itemId} relation screening repeats ${paperId}`);
    seenShortlistPaperIds.add(paperId);
    if (typeof entry.rank !== "number" || !Number.isFinite(entry.rank)) {
      fail(`library item ${itemId} screeningCandidates[${index}].rank must be finite`);
    }
    const projected = { paperId, rank: Number(entry.rank.toFixed(8)), routingOnly: true };
    for (const key of ["title", "verificationStatus", "primaryCategory", "secondaryCategory", "artifactSha256"]) {
      if (typeof entry[key] === "string" && entry[key].trim()) projected[key] = clipped(entry[key], key === "title" ? 500 : 160);
    }
    if (entry.artifactSha256 !== undefined) assertSha(entry.artifactSha256, `library item ${itemId} screeningCandidates[${index}].artifactSha256`);
    if (Number.isInteger(entry.artifactRevision) && entry.artifactRevision >= 1) projected.artifactRevision = entry.artifactRevision;
    if (typeof entry.snippet === "string" && entry.snippet.trim()) projected.snippet = clipped(entry.snippet, 600);
    const rawClaims = entry.matchingClaims ?? [];
    if (!Array.isArray(rawClaims) || rawClaims.length > 2) {
      fail(`library item ${itemId} screeningCandidates[${index}].matchingClaims must have at most two entries`);
    }
    projected.matchingClaims = rawClaims.map((rawClaim, claimIndex) => {
      const claim = object(rawClaim, `library item ${itemId} screeningCandidates[${index}].matchingClaims[${claimIndex}]`);
      const result = {
        claimId: nonempty(claim.claimId, `screening claim ID`),
        text: clipped(nonempty(claim.text, `screening claim text`), 600),
        routingOnly: true,
      };
      for (const key of ["type", "section", "verificationStatus", "artifactSha256"]) {
        if (typeof claim[key] === "string" && claim[key].trim()) result[key] = clipped(claim[key], 160);
      }
      if (claim.artifactSha256 !== undefined) assertSha(claim.artifactSha256, `screening claim artifactSha256`);
      if (Number.isInteger(claim.artifactRevision) && claim.artifactRevision >= 1) result.artifactRevision = claim.artifactRevision;
      if (typeof claim.rank === "number" && Number.isFinite(claim.rank)) result.rank = Number(claim.rank.toFixed(8));
      if (Array.isArray(claim.evidence) && stableJson(claim.evidence).length <= 4_000) result.evidence = claim.evidence;
      return result;
    });
    return projected;
  });
  const screeningAnchorIds = preparation.screeningAnchorIds ?? [];
  if (!Array.isArray(screeningAnchorIds) || screeningAnchorIds.some((candidateId) =>
    typeof candidateId !== "string" || !packetCandidateIds.has(candidateId))) {
    fail(`library item ${itemId} screeningAnchorIds are not pinned by its review packet`);
  }
  const screeningMethod = relationCandidates.length > 0
    ? nonempty(preparation.screeningMethod, `library item ${itemId} preparation.screeningMethod`)
    : (typeof preparation.screeningMethod === "string" ? preparation.screeningMethod : null);
  const paperId = nonempty(packet.paperId ?? manifest.paper?.paperId, `library item ${itemId} paperId`);
  const metadata = object(packet.canonicalMetadata ?? manifest.canonicalMetadata, `library item ${itemId} canonicalMetadata`);
  return {
    itemId,
    itemNumber: Number.isInteger(item.number) ? item.number : Number.MAX_SAFE_INTEGER,
    itemRevision,
    sourceRevision,
    jobId,
    manifestSha256: manifestSha,
    catalogFingerprint: manifest.catalogFingerprint,
    sourceSha256: sourceSha,
    packetSha256: packetArtifact.sha256,
    packetSchemaVersion: packet.schemaVersion,
    paperId,
    title: nonempty(metadata.title ?? item.displayTitle, `library item ${itemId} title`),
    authors: Array.isArray(metadata.authors) ? metadata.authors.filter((author) => typeof author === "string" && author.trim()).map((author) => author.trim()) : [],
    metadataStatus: typeof metadata.metadataStatus === "string" ? metadata.metadataStatus : "provisional",
    candidates,
    relationShortlist: {
      routingOnly: true,
      method: screeningMethod,
      indexFingerprint: preparation.screeningIndexFingerprint === undefined
        ? null
        : assertSha(preparation.screeningIndexFingerprint, `library item ${itemId} preparation.screeningIndexFingerprint`),
      queryAnchorIds: [...new Set(screeningAnchorIds)].sort(),
      candidates: relationCandidates,
    },
  };
}

export async function readPreparedCatalogFingerprint(support, item) {
  object(item, "library item");
  const itemId = nonempty(item.id, "library item.id");
  if (!["pending_codex", "processing"].includes(item.status)) return null;
  const preparation = item.preparation;
  if (!preparation || typeof preparation !== "object" || Array.isArray(preparation)
      || preparation.schemaVersion !== 1 || preparation.state !== "ready") return null;
  const sourceRevision = positiveInteger(preparation.sourceRevision, `library item ${itemId} preparation.sourceRevision`);
  if (positiveInteger(item.revision, `library item ${itemId} revision`) !== sourceRevision + 1) {
    fail(`library item ${itemId} revision is not the committed successor of preparation.sourceRevision`);
  }
  const jobId = nonempty(preparation.jobId, `library item ${itemId} preparation.jobId`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) fail(`library item ${itemId} preparation.jobId is unsafe`);
  const manifestPath = supportRelative(support, preparation.manifestPath, `library item ${itemId} preparation.manifestPath`);
  const expectedDirectory = path.join(support, "Work", "LocalPipeline", jobId);
  if (path.dirname(manifestPath) !== expectedDirectory || path.basename(manifestPath) !== "manifest.json") {
    fail(`library item ${itemId} manifestPath does not match its jobId`);
  }
  const [canonicalJob, canonicalManifest, manifestInfo] = await Promise.all([
    realpath(expectedDirectory),
    realpath(manifestPath),
    lstat(manifestPath),
  ]);
  inside(canonicalJob, canonicalManifest, `library item ${itemId} manifest real path`);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    fail(`library item ${itemId} manifest must be a regular, non-symlink file`);
  }
  const manifestRead = await readJsonBytes(manifestPath, `library item ${itemId} local preparation manifest`);
  if (sha256(manifestRead.bytes) !== assertSha(preparation.resultSha256, `library item ${itemId} preparation.resultSha256`)) {
    fail(`library item ${itemId} preparation manifest hash mismatch`);
  }
  const manifest = object(manifestRead.value, `library item ${itemId} local preparation manifest`);
  if (manifest.schemaVersion !== "liteverse-local-result-v1" || manifest.state !== "ready"
      || manifest.extractionStatus !== "extracted" || manifest.itemId !== itemId
      || manifest.itemRevision !== sourceRevision || manifest.jobId !== jobId) {
    fail(`library item ${itemId} local preparation manifest is not reviewable`);
  }
  if (manifest.catalogFingerprint === "absent") return "absent";
  return assertSha(manifest.catalogFingerprint, `library item ${itemId} manifest.catalogFingerprint`);
}

export async function loadPreparedAdoptionInputs(support, item, options = {}) {
  const prepared = await loadPreparedItem(support, item, options);
  const jobDirectory = path.join(support, "Work", "LocalPipeline", prepared.jobId);
  const manifestPath = path.join(jobDirectory, "manifest.json");
  const manifestRead = await readJsonBytes(manifestPath, `library item ${prepared.itemId} local preparation manifest`);
  if (sha256(manifestRead.bytes) !== prepared.manifestSha256) {
    fail(`library item ${prepared.itemId} preparation manifest changed during adoption`);
  }
  const manifest = object(manifestRead.value, `library item ${prepared.itemId} local preparation manifest`);
  const fulltext = await validateOutput(jobDirectory, manifestOutput(manifest, "fulltext"), "fulltext");
  const metadata = object(
    manifest.canonicalMetadata,
    `library item ${prepared.itemId} canonicalMetadata`,
  );
  const storageMode = item.source?.storageMode ?? metadata.storageMode ?? "managed";
  let sourceInputPath;
  let source;
  if (storageMode === "linked") {
    const descriptor = object(item.source, `library item ${prepared.itemId} source`);
    sourceInputPath = nonempty(
      descriptor.pdfPath ?? item.localPath,
      `library item ${prepared.itemId} linked pdfPath`,
    );
    source = {
      ...descriptor,
      kind: item.sourceType === "arxiv" || metadata.arxivId ? "arxiv" : "pdf",
      storageMode: "linked",
      pdfPath: sourceInputPath,
      sha256: prepared.sourceSha256,
      arxivId: metadata.arxivId ?? descriptor.arxivId ?? null,
      doi: metadata.doi ?? descriptor.doi ?? null,
    };
  } else {
    sourceInputPath = null;
    if (typeof item.storedFilename === "string" && item.storedFilename) {
      if (path.basename(item.storedFilename) !== item.storedFilename) {
        fail(`library item ${prepared.itemId} storedFilename is unsafe`);
      }
      const storedPath = path.join(support, "Library", "PDFs", item.storedFilename);
      try {
        const info = await lstat(storedPath);
        if (info.isSymbolicLink() || !info.isFile()) {
          fail(`library item ${prepared.itemId} managed source must be a regular, non-symlink file`);
        }
        sourceInputPath = storedPath;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (!sourceInputPath) {
      sourceInputPath = (await validateOutput(jobDirectory, manifestOutput(manifest, "pdf"), "pdf")).outputPath;
    }
    if ((await fileSha(sourceInputPath)) !== prepared.sourceSha256) {
      fail(`library item ${prepared.itemId} managed source changed during adoption`);
    }
    source = {
      ...(item.source && typeof item.source === "object" ? item.source : {}),
      kind: item.sourceType === "arxiv" || metadata.arxivId ? "arxiv" : "pdf",
      storageMode: "managed",
      pdfPath: `Library/PDFs/${prepared.paperId}.pdf`,
      sha256: prepared.sourceSha256,
      arxivId: metadata.arxivId ?? item.source?.arxivId ?? null,
      doi: metadata.doi ?? item.source?.doi ?? null,
    };
  }
  return {
    ...prepared,
    sourceInputPath,
    source,
    fulltextPath: fulltext.outputPath,
    fulltextSha256: fulltext.sha256,
    fulltextSize: fulltext.size,
    extractionStatus: manifest.extractionStatus,
    metadata: {
      ...metadata,
      title: prepared.title,
      authors: prepared.authors,
      metadataStatus: prepared.metadataStatus,
    },
  };
}

export function candidateCharacters(candidate) {
  return candidate.text.length
    + (candidate.context.previous?.length ?? 0)
    + (candidate.context.next?.length ?? 0)
    + candidate.sourceAnchor.locator.length;
}

export function batchPaperProjection(prepared, candidates) {
  return {
    itemId: prepared.itemId,
    itemRevision: prepared.itemRevision,
    sourceRevision: prepared.sourceRevision,
    paperId: prepared.paperId,
    title: prepared.title,
    authors: prepared.authors,
    metadataStatus: prepared.metadataStatus,
    catalogFingerprint: prepared.catalogFingerprint,
    sourceSha256: prepared.sourceSha256,
    manifestSha256: prepared.manifestSha256,
    packetSha256: prepared.packetSha256,
    packetSchemaVersion: prepared.packetSchemaVersion,
    candidates,
    navigationAnchors: prepared.candidates
      .filter((candidate) => navigationKinds.has(candidate.kind))
      .sort((left, right) => right.routingScore - left.routingScore
        || left.sourceAnchor.page - right.sourceAnchor.page
        || left.candidateId.localeCompare(right.candidateId))
      .slice(0, 12)
      .map((candidate) => ({
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        sourceAnchor: candidate.sourceAnchor,
        routingScore: candidate.routingScore,
        status: "provisional",
        purpose: "navigation_only",
        verificationState: "unverified",
      })),
    relationShortlist: prepared.relationShortlist,
  };
}

export function preparedPin(prepared) {
  return {
    itemId: prepared.itemId,
    itemRevision: prepared.itemRevision,
    sourceRevision: prepared.sourceRevision,
    paperId: prepared.paperId,
    catalogFingerprint: prepared.catalogFingerprint,
    sourceSha256: prepared.sourceSha256,
    manifestSha256: prepared.manifestSha256,
    packetSha256: prepared.packetSha256,
  };
}
