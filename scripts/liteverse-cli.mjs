#!/usr/bin/env -S node --no-warnings
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  atomicWrite,
  atomicWriteJson,
  readJson,
  relativeManagedPath,
  resolveProjectId,
  resolveSupport,
  SHA256,
  sha256Text,
  verifyPaperArtifact,
} from "./lib/liteverse-core.mjs";

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
  liteverse-cli.mjs curation batch build [--item ID ...] [--char-budget N] [--max-papers 3..5] [--allow-partial]
  liteverse-cli.mjs curation batch apply --batch FILE --decisions FILE
  liteverse-cli.mjs curation batch adopt --result FILE [--result FILE ...] [--assignments FILE | --write-assignment-template]
  liteverse-cli.mjs curation classify --snapshot FILE --input FILE [--output FILE]
  liteverse-cli.mjs doctor [--fix] [--quick] [--json]
  liteverse-cli.mjs index rebuild [--json]
  liteverse-cli.mjs tier0 build [--json]
  liteverse-cli.mjs digest packet --galaxy ID [--max-chars N]
  liteverse-cli.mjs digest apply --galaxy ID --packet FILE --digest FILE [--json]

Common options:
  --support-dir DIR    Liteverse Application Support root
  --task-id ID         Controlled test/recovery task ID override

Task identity resolves as --task-id, LITEVERSE_TASK_ID, then CODEX_THREAD_ID.
Search and status never increment usage. Context build and evidence read adopt
verified artifacts and count once per task, project, and paper.

Tier 0 (deterministic, no AI, never evidence):
  tier0 build     Verifies every adopted paper's pinned full text and every
                  library item whose local preparation is ready, extracts
                  verbatim Paper Briefs, citation edges, similarity neighbours,
                  clusters and reading paths, and writes only the rebuildable
                  cache Cache/Tier0/{briefs/<id>.json,library.json}.
  digest packet   Prints a Tier-1 galaxy review packet (Tier-0 quotes with IDs,
                  in-galaxy citation contexts, answer schema) for an AI agent.
                  Default --max-chars 36000.
  digest apply    Validates the agent's digest against its packet (every cell
                  and relation must cite packet quote IDs of the right papers)
                  and stores it immutably under Knowledge/digests/<galaxy>/.
                  Relations stay candidates. Never writes Graph or Usage.`);
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

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function bytesSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value.includes("..")) {
    throw new Error(`${label} must match ${SAFE_ID}`);
  }
  return value;
}

function insideDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readRegularFile(root, candidate, label) {
  if (!insideDirectory(root, candidate)) throw new Error(`${label} escapes ${root}`);
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular, non-symlink file`);
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!insideDirectory(realRoot, realFile)) throw new Error(`${label} real path escapes its job directory`);
  return readFile(candidate);
}

// Mirrors the local-preparation checks of the Curator review batch: the
// manifest hash is pinned by library.json and the full-text output hash and
// size are pinned by the manifest.
async function loadPreparedFulltext(support, item) {
  const itemId = safeId(item.id, "library item id");
  const preparation = item.preparation;
  const jobId = safeId(preparation.jobId, `library item ${itemId} preparation.jobId`);
  const jobDirectory = path.join(support, "Work", "LocalPipeline", jobId);
  const manifestPath = path.join(jobDirectory, "manifest.json");
  if (preparation.manifestPath !== `Work/LocalPipeline/${jobId}/manifest.json`) {
    throw new Error(`library item ${itemId} manifestPath does not match its jobId`);
  }
  if (!SHA256.test(preparation.resultSha256 ?? "")) throw new Error(`library item ${itemId} preparation.resultSha256 is not a SHA-256`);
  const manifestBytes = await readRegularFile(jobDirectory, manifestPath, `library item ${itemId} manifest`);
  if (bytesSha256(manifestBytes) !== preparation.resultSha256) throw new Error(`library item ${itemId} preparation manifest hash mismatch`);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`library item ${itemId} manifest is invalid JSON: ${error.message}`);
  }
  if (manifest?.schemaVersion !== "liteverse-local-result-v1" || manifest.state !== "ready" || manifest.extractionStatus !== "extracted") {
    throw new Error(`library item ${itemId} local preparation is not an extracted ready result`);
  }
  if (manifest.itemId !== itemId || manifest.jobId !== jobId) throw new Error(`library item ${itemId} manifest identity is stale`);
  const outputs = Array.isArray(manifest.outputs) ? manifest.outputs.filter((output) => output?.role === "fulltext") : [];
  if (outputs.length !== 1) throw new Error(`library item ${itemId} manifest must contain exactly one fulltext output`);
  const output = outputs[0];
  const parts = String(output.path ?? "").split(/[\\/]+/);
  if (!output.path || path.isAbsolute(output.path) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`library item ${itemId} fulltext output.path is unsafe`);
  }
  if (!SHA256.test(output.sha256 ?? "")) throw new Error(`library item ${itemId} fulltext output.sha256 is not a SHA-256`);
  const bytes = await readRegularFile(jobDirectory, path.join(jobDirectory, ...parts), `library item ${itemId} fulltext output`);
  if (bytesSha256(bytes) !== output.sha256) throw new Error(`library item ${itemId} fulltext output hash mismatch`);
  if (output.size !== bytes.byteLength) throw new Error(`library item ${itemId} fulltext output size mismatch`);
  return { manifest, fulltext: bytes.toString("utf8") };
}

function metadataYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : null;
}

async function tier0Build(support, json) {
  const started = performance.now();
  const tier0 = await import("./lib/liteverse-tier0.mjs");
  const cacheRoot = path.join(support, "Cache", "Tier0");
  const briefsRoot = path.join(cacheRoot, "briefs");
  const inputs = [];
  const skipped = [];
  const superseded = [];
  const catalog = await readJson(path.join(support, "Knowledge", "papers.json"), { optional: true });
  if (catalog && !Array.isArray(catalog.papers)) throw new Error("Knowledge/papers.json has no papers array");
  const adoptedIds = new Set();
  const papers = [...(catalog?.papers ?? [])].sort((left, right) => String(left.paperId ?? left.id).localeCompare(String(right.paperId ?? right.id)));
  for (const paper of papers) {
    const id = String(paper.paperId ?? paper.id ?? "");
    try {
      safeId(id, "paper ID");
      const verified = await verifyPaperArtifact(support, paper, { requireFulltext: true });
      adoptedIds.add(id);
      inputs.push({
        id,
        origin: "adopted",
        fulltext: verified.fulltextText,
        fulltextSha256: verified.artifact.fulltextSha256,
        title: paper.title ?? verified.card.title,
        authors: paper.authors ?? verified.card.authors,
        year: metadataYear(paper.year ?? verified.card.metadata?.year),
        arxivId: paper.arxivId ?? paper.identifiers?.arxiv ?? verified.card.metadata?.arxiv_id ?? null,
        doi: paper.doi ?? paper.identifiers?.doi ?? verified.card.metadata?.doi ?? null,
        provenance: { artifactRevision: verified.artifact.artifactRevision, artifactSha256: verified.artifact.artifactSha256 },
      });
    } catch (error) {
      skipped.push({ id, origin: "adopted", reason: error.message });
    }
  }
  const library = await readJson(path.join(support, "library.json"), { optional: true });
  const items = Array.isArray(library?.items) ? library.items : [];
  for (const item of [...items].sort((left, right) => String(left?.id).localeCompare(String(right?.id)))) {
    if (item?.preparation?.state !== "ready") continue;
    const id = String(item.id ?? "");
    try {
      const { manifest, fulltext } = await loadPreparedFulltext(support, item);
      const intendedPaperId = manifest.paper?.paperId ?? null;
      if (adoptedIds.has(id) || (intendedPaperId && adoptedIds.has(intendedPaperId))) {
        superseded.push({ id, paperId: adoptedIds.has(id) ? id : intendedPaperId, reason: "an adopted paper already provides this Tier-0 brief" });
        continue;
      }
      const metadata = manifest.canonicalMetadata ?? {};
      inputs.push({
        id,
        origin: "prepared",
        fulltext,
        fulltextSha256: sha256Text(fulltext),
        title: metadata.title ?? item.displayTitle ?? item.title ?? id,
        authors: metadata.authors ?? item.authors ?? [],
        year: metadataYear(metadata.year ?? item.year),
        arxivId: metadata.arxivId ?? item.arxivId ?? null,
        doi: metadata.doi ?? item.doi ?? null,
        provenance: { itemId: id, itemRevision: item.revision ?? null, jobId: item.preparation.jobId, manifestSha256: item.preparation.resultSha256, intendedPaperId },
      });
    } catch (error) {
      skipped.push({ id, origin: "prepared", reason: error.message });
    }
  }

  const briefs = [];
  let reused = 0;
  const briefStarted = performance.now();
  for (const input of inputs) {
    const inputFingerprint = sha256Text(tier0.canonicalJson({
      builderVersion: tier0.TIER0_BUILDER_VERSION,
      id: input.id,
      title: input.title ?? null,
      authors: input.authors ?? [],
      year: input.year,
      arxivId: input.arxivId,
      doi: input.doi,
      fulltextSha256: input.fulltextSha256,
      origin: input.origin,
      provenance: input.provenance,
    }));
    const briefPath = path.join(briefsRoot, `${input.id}.json`);
    const cached = await readJson(briefPath, { optional: true }).catch(() => null);
    if (cached?.schemaVersion === tier0.TIER0_SCHEMA && cached.inputFingerprint === inputFingerprint && cached.fulltextSha256 === input.fulltextSha256) {
      briefs.push(cached);
      reused += 1;
      continue;
    }
    const brief = {
      ...tier0.buildPaperBrief({
        paperId: input.id,
        title: input.title,
        authors: input.authors,
        year: input.year,
        arxivId: input.arxivId,
        doi: input.doi,
        fulltext: input.fulltext,
      }),
      origin: input.origin,
      provenance: input.provenance,
      inputFingerprint,
    };
    await atomicWriteJson(briefPath, brief);
    briefs.push(brief);
  }
  const keep = new Set(briefs.map((brief) => `${brief.paperId}.json`));
  for (const name of await readdir(briefsRoot).catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)))) {
    if (name.endsWith(".json") && !keep.has(name)) await rm(path.join(briefsRoot, name), { force: true });
  }
  const libraryStarted = performance.now();
  const analysis = tier0.buildLibraryAnalysis(briefs);
  analysis.sources = Object.fromEntries(briefs.map((brief) => [brief.paperId, { origin: brief.origin, provenance: brief.provenance }]));
  analysis.skipped = skipped;
  analysis.superseded = superseded;
  analysis.inputFingerprint = sha256Text(tier0.canonicalJson(briefs.map((brief) => [brief.paperId, brief.inputFingerprint])));
  const libraryPath = path.join(cacheRoot, "library.json");
  await atomicWriteJson(libraryPath, analysis);
  const finished = performance.now();
  const value = {
    schemaVersion: "liteverse-tier0-build-v1",
    briefCount: briefs.length,
    adopted: briefs.filter((brief) => brief.origin === "adopted").length,
    prepared: briefs.filter((brief) => brief.origin === "prepared").length,
    reused,
    rebuilt: briefs.length - reused,
    skipped,
    superseded,
    citationEdges: analysis.citationEdges.length,
    regions: analysis.clusters.coarse.count,
    galaxies: analysis.clusters.fine.count,
    stability: analysis.clusters.coarse.stability,
    timingsMs: {
      briefs: Math.round(libraryStarted - briefStarted),
      library: Math.round(finished - libraryStarted),
      total: Math.round(finished - started),
    },
    paths: { briefs: relativeManagedPath(support, briefsRoot), library: relativeManagedPath(support, libraryPath) },
  };
  output(value, json, (item) => [
    `Tier 0: ${item.briefCount} briefs (${item.adopted} adopted, ${item.prepared} prepared; ${item.reused} reused) in ${item.timingsMs.total} ms`,
    `Connections: ${item.citationEdges} citation edges · ${item.regions} regions · ${item.galaxies} galaxies · stability ARI ${item.stability}`,
    ...item.skipped.map((entry) => `[skipped] ${entry.origin} ${entry.id}: ${entry.reason}`),
    `Cache: ${item.paths.library}`,
  ].join("\n"));
}

async function loadTier0Cache(support, paperIds) {
  const library = await readJson(path.join(support, "Cache", "Tier0", "library.json"), { optional: true });
  if (!library) throw new Error("Tier-0 cache is missing; run liteverse-cli.mjs tier0 build first");
  const catalog = await readJson(path.join(support, "Knowledge", "papers.json"), { optional: true });
  const pins = new Map((catalog?.papers ?? []).map((paper) => [paper.paperId ?? paper.id, paper.artifact ?? paper.artifacts?.integrity ?? null]));
  const briefs = [];
  for (const paperId of paperIds) {
    safeId(paperId, "paper ID");
    const brief = await readJson(path.join(support, "Cache", "Tier0", "briefs", `${paperId}.json`), { optional: true });
    if (!brief) throw new Error(`no Tier-0 brief for ${paperId}; run liteverse-cli.mjs tier0 build`);
    const pin = pins.get(paperId);
    if (pin?.fulltextSha256 && pin.fulltextSha256 !== brief.fulltextSha256) {
      throw new Error(`Tier-0 brief for ${paperId} is stale (full-text pin changed); run liteverse-cli.mjs tier0 build`);
    }
    briefs.push(brief);
  }
  return { library, briefs };
}

function galaxyMembers(graph, galaxyId) {
  const galaxy = (Array.isArray(graph?.galaxies) ? graph.galaxies : []).find((item) => item?.id === galaxyId);
  if (!galaxy) throw new Error(`galaxy ${galaxyId} is not in Graph/current.json`);
  const paperIds = (Array.isArray(graph.papers) ? graph.papers : []).filter((paper) => paper?.galaxyId === galaxyId).map((paper) => paper.id);
  if (!paperIds.length) throw new Error(`galaxy ${galaxyId} has no papers`);
  return { galaxy, paperIds };
}

async function digestPacket(support) {
  const galaxyId = safeId(argument("--galaxy"), "--galaxy");
  const maxChars = integer("--max-chars", 36000, 2000, 1_000_000);
  const graph = await readJson(path.join(support, "Graph", "current.json"));
  const { galaxy, paperIds } = galaxyMembers(graph, galaxyId);
  const { library, briefs } = await loadTier0Cache(support, paperIds);
  const { buildGalaxyPacket } = await import("./lib/liteverse-tier0.mjs");
  const packet = buildGalaxyPacket({
    galaxyId,
    galaxyTitle: galaxy.name ?? "",
    paperIds,
    briefs,
    library,
    maxChars,
    graphRevision: Number.isInteger(graph.revision) ? graph.revision : null,
  });
  console.log(JSON.stringify(packet, null, 2));
}

async function digestApply(support, json) {
  const galaxyId = safeId(argument("--galaxy"), "--galaxy");
  const packetPath = argument("--packet");
  const digestPath = argument("--digest");
  if (!packetPath || !digestPath) throw new Error("digest apply requires --packet FILE and --digest FILE");
  const [packet, digest, graph] = await Promise.all([
    readJson(path.resolve(packetPath)),
    readJson(path.resolve(digestPath)),
    readJson(path.join(support, "Graph", "current.json")),
  ]);
  if (packet?.galaxyId !== galaxyId) throw new Error(`packet galaxyId ${packet?.galaxyId} does not match --galaxy ${galaxyId}`);
  const { paperIds } = galaxyMembers(graph, galaxyId);
  const members = new Set(paperIds);
  const departed = (packet.papers ?? []).map((paper) => paper.paperId).filter((paperId) => !members.has(paperId));
  if (departed.length) throw new Error(`packet is stale: ${departed.join(", ")} no longer belong to galaxy ${galaxyId}`);
  const { validateGalaxyDigest } = await import("./lib/liteverse-tier0.mjs");
  const result = validateGalaxyDigest(packet, digest);
  if (!result.ok) throw new Error(`digest rejected (${result.errors.length} errors):\n  - ${result.errors.join("\n  - ")}`);
  const cited = new Set();
  const collect = (ids) => ids.forEach((id) => cited.add(id));
  for (const paper of result.digest.papers) collect(paper.gistQuoteIds);
  for (const row of result.digest.matrix) for (const field of Object.values(row)) if (field && typeof field === "object") collect(field.quoteIds);
  for (const relation of result.digest.relations) {
    collect(relation.sourceQuoteIds);
    collect(relation.targetQuoteIds);
  }
  const quotes = {};
  for (const paper of packet.papers) {
    for (const quote of [...paper.quotes, ...(paper.quantities ?? [])]) {
      if (cited.has(quote.id) && !quotes[quote.id]) quotes[quote.id] = { paperId: paper.paperId, kind: quote.kind ?? "quantity", text: quote.text, page: quote.page };
    }
  }
  for (const context of packet.citationContexts ?? []) {
    if (cited.has(context.quoteId) && !quotes[context.quoteId]) quotes[context.quoteId] = { paperId: context.source, kind: "citation_context", citedPaperId: context.target, text: context.text, page: context.page };
  }
  const record = {
    ...result.digest,
    packet: {
      packetSha256: packet.packetSha256,
      graphRevision: packet.graphRevision ?? null,
      paperIds: packet.papers.map((paper) => paper.paperId),
      truncated: Boolean(packet.truncated),
    },
    quotes: Object.fromEntries(Object.keys(quotes).sort().map((id) => [id, quotes[id]])),
    warnings: result.warnings,
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const digestSha256 = sha256Text(text);
  const directory = path.join(support, "Knowledge", "digests", galaxyId);
  const recordPath = path.join(directory, `${digestSha256}.json`);
  const existing = await readFile(recordPath, "utf8").catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (existing === null) await atomicWrite(recordPath, text);
  else if (sha256Text(existing) !== digestSha256) throw new Error(`immutable digest ${recordPath} exists with different content`);
  const pointerPath = path.join(directory, "current.json");
  const previous = await readJson(pointerPath, { optional: true });
  const pointer = {
    schemaVersion: "liteverse-galaxy-digest-pointer-v1",
    galaxyId,
    digestSha256,
    packetSha256: packet.packetSha256,
    path: relativeManagedPath(support, recordPath),
    createdAt: new Date().toISOString(),
    previousDigestSha256: previous?.digestSha256 && previous.digestSha256 !== digestSha256 ? previous.digestSha256 : previous?.previousDigestSha256 ?? null,
  };
  await atomicWriteJson(pointerPath, pointer);
  output({ ...pointer, relationCount: record.relations.length, warnings: result.warnings }, json, (item) => [
    `Stored galaxy digest ${item.digestSha256} for ${item.galaxyId} (${item.relationCount} candidate relations).`,
    ...item.warnings.map((warning) => `[warning] ${warning}`),
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

async function delegateCurator(support, scriptName, commandArguments) {
  const script = resolveSkillScript("liteverse-curator", scriptName);
  const args = [script, ...withoutSupportArguments(commandArguments), "--support-dir", support];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`curation command exited ${code ?? signal}`)));
  });
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h") || process.argv.length < 3) return help();
  const [command, subcommand, action] = process.argv.slice(2);
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
  if (command === "curation" && subcommand === "batch" && action === "build") {
    return delegateCurator(support, "build-review-batch.mjs", process.argv.slice(5));
  }
  if (command === "curation" && subcommand === "batch" && action === "apply") {
    return delegateCurator(support, "apply-review-batch.mjs", process.argv.slice(5));
  }
  if (command === "curation" && subcommand === "batch" && action === "adopt") {
    return delegateCurator(support, "adopt-review-results.mjs", process.argv.slice(5));
  }
  if (command === "curation" && subcommand === "classify") {
    return delegateCurator(support, "screen-incremental-classification.mjs", process.argv.slice(4));
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
  if (command === "tier0" && subcommand === "build") return tier0Build(support, json);
  if (command === "digest" && subcommand === "packet") return digestPacket(support);
  if (command === "digest" && subcommand === "apply") return digestApply(support, json);
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
