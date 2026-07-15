import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  expandSearchText,
  readJson,
  resolveManagedPath,
  SEARCH_ALIAS_ENTRIES,
  sha256Text,
  verifyPaperArtifact,
} from "./liteverse-core.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const SEARCH_SCHEMA_VERSION = "liteverse-search-v2";
const QUERY_CONTRACT_VERSION = "liteverse-query-v1";
const ALIAS_CONTRACT_JSON = canonicalJson(SEARCH_ALIAS_ENTRIES);
const ALIAS_CONTRACT_SHA256 = sha256Text(ALIAS_CONTRACT_JSON);

async function withSearchIndexLock(support, callback) {
  const lockPath = path.join(support, ".locks", "search-index.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const details = await stat(lockPath).catch((statError) => {
        if (statError.code === "ENOENT") return null;
        throw statError;
      });
      if (!details) continue;
      if (Date.now() - details.mtimeMs > 60_000) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for search index lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function loadPaperIndex(support) {
  const filePath = path.join(support, "Knowledge", "papers.json");
  const sourceText = await readFile(filePath, "utf8");
  let index;
  try {
    index = JSON.parse(sourceText);
  } catch (error) {
    throw new Error(`invalid JSON at ${filePath}: ${error.message}`);
  }
  if (!index || !Array.isArray(index.papers)) throw new Error(`Knowledge/papers.json has no papers array: ${filePath}`);
  return { filePath, index, sourceSha256: sha256Text(sourceText) };
}

function indexFingerprint(index) {
  const projection = index.papers.map((paper) => ({
    paperId: paper.paperId,
    title: paper.title,
    authors: paper.authors,
    tags: paper.tags,
    verificationStatus: paper.verificationStatus,
    primaryCategory: paper.primaryCategory,
    secondaryCategory: paper.secondaryCategory,
    artifact: paper.artifact ?? paper.artifacts?.integrity ?? null,
  })).sort((left, right) => left.paperId.localeCompare(right.paperId));
  return sha256Text(canonicalJson(projection));
}

function openDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  // The macOS App opens this cache with SQLITE_OPEN_READONLY. A database left
  // in WAL mode cannot be opened read-only when its transient -wal/-shm files
  // are absent, so every CLI access keeps the durable file in DELETE mode.
  database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;");
  return database;
}

function schema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS papers (
      paper_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      authors TEXT NOT NULL,
      tags TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      primary_category TEXT,
      secondary_category TEXT,
      artifact_revision INTEGER NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      card_sha256 TEXT NOT NULL,
      claims_sha256 TEXT NOT NULL,
      claims_path TEXT NOT NULL,
      card_path TEXT NOT NULL,
      fulltext_path TEXT NOT NULL,
      body TEXT NOT NULL,
      legacy_lines_removed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS claims (
      claim_id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL,
      type TEXT NOT NULL,
      section TEXT NOT NULL,
      text TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      artifact_revision INTEGER NOT NULL,
      artifact_sha256 TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS paper_fts USING fts5(
      paper_id UNINDEXED, title, authors, tags, body, aliases,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS claim_fts USING fts5(
      claim_id UNINDEXED, paper_id UNINDEXED, type, section, text, evidence,
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
}

async function rebuildSearchIndexUnlocked(support, { databasePath }) {
  const { index, sourceSha256 } = await loadPaperIndex(support);
  const fingerprint = indexFingerprint(index);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const temporaryPath = `${databasePath}.building-${process.pid}-${Date.now()}`;
  await rm(temporaryPath, { force: true });
  await rm(`${temporaryPath}-journal`, { force: true });
  const database = openDatabase(temporaryPath);
  let committed = false;
  let claimCount = 0;
  try {
    schema(database);
    const insertPaper = database.prepare(`INSERT INTO papers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertPaperFts = database.prepare(`INSERT INTO paper_fts VALUES (?, ?, ?, ?, ?, ?)`);
    const insertClaim = database.prepare(`INSERT INTO claims VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertClaimFts = database.prepare(`INSERT INTO claim_fts VALUES (?, ?, ?, ?, ?, ?)`);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const paper of [...index.papers].sort((left, right) => left.paperId.localeCompare(right.paperId))) {
        const verified = await verifyPaperArtifact(support, paper, { requireClaims: true });
        const card = verified.card;
        const authors = Array.isArray(paper.authors ?? card.authors) ? (paper.authors ?? card.authors).join("; ") : String(paper.authors ?? card.authors ?? "");
        const tags = Array.isArray(paper.tags ?? card.tags) ? (paper.tags ?? card.tags).join("; ") : String(paper.tags ?? card.tags ?? "");
        const fulltextPath = resolveManagedPath(support, paper.fulltextPath ?? paper.artifacts?.fulltextPath, `Knowledge/fulltext/${paper.paperId}.md`);
        insertPaper.run(
          paper.paperId,
          paper.title ?? card.title,
          authors,
          tags,
          paper.verificationStatus ?? card.verificationStatus,
          paper.primaryCategory ?? null,
          paper.secondaryCategory ?? null,
          verified.artifact.artifactRevision,
          verified.artifact.artifactSha256,
          verified.artifact.cardSha256,
          verified.artifact.claimsSha256,
          verified.artifact.immutableClaimsPath,
          verified.artifact.immutableCardPath,
          fulltextPath,
          card.body,
          card.removedLegacyLines,
        );
        const aliases = expandSearchText(`${paper.paperId} ${paper.title ?? card.title} ${authors} ${tags} ${card.body}`);
        insertPaperFts.run(paper.paperId, paper.title ?? card.title, authors, tags, card.body, aliases);
        for (const claim of verified.claims.claims ?? []) {
          claimCount += 1;
          const evidenceText = (claim.evidence ?? []).map((item) => `${item.evidenceId} ${item.locator} ${item.paraphrase}`).join(" ");
          insertClaim.run(
            claim.claimId,
            paper.paperId,
            claim.type,
            claim.section,
            claim.text,
            JSON.stringify(claim.evidence ?? []),
            claim.verificationStatus,
            claim.artifactRevision,
            claim.artifactSha256,
          );
          insertClaimFts.run(
            claim.claimId,
            paper.paperId,
            claim.type,
            claim.section,
            `${claim.text} ${expandSearchText(claim.text)}`,
            `${evidenceText} ${expandSearchText(evidenceText)}`,
          );
        }
      }
      database.prepare("INSERT INTO metadata(key, value) VALUES ('schemaVersion', ?)").run(SEARCH_SCHEMA_VERSION);
      database.prepare("INSERT INTO metadata(key, value) VALUES ('queryContractVersion', ?)").run(QUERY_CONTRACT_VERSION);
      database.prepare("INSERT INTO metadata(key, value) VALUES ('aliasContractJson', ?)").run(ALIAS_CONTRACT_JSON);
      database.prepare("INSERT INTO metadata(key, value) VALUES ('aliasContractSha256', ?)").run(ALIAS_CONTRACT_SHA256);
      database.prepare("INSERT INTO metadata(key, value) VALUES ('fingerprint', ?)").run(fingerprint);
      database.prepare("INSERT INTO metadata(key, value) VALUES ('catalogSha256', ?)").run(sourceSha256);
      database.prepare("INSERT INTO metadata(key, value) VALUES ('paperCount', ?)").run(String(index.papers.length));
      database.prepare("INSERT INTO metadata(key, value) VALUES ('claimCount', ?)").run(String(claimCount));
      database.exec("COMMIT");
      // Flush the completed transaction before making the cache visible. The
      // final rename replaces the prior index atomically, so App searches see
      // either the old complete revision or the new complete revision.
      database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      committed = true;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
    if (!committed) {
      await rm(temporaryPath, { force: true });
      await rm(`${temporaryPath}-journal`, { force: true });
    }
  }
  if (committed) {
    let latestSource;
    try {
      latestSource = await loadPaperIndex(support);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    if (latestSource.sourceSha256 !== sourceSha256) {
      await rm(temporaryPath, { force: true });
      return { retry: true };
    }
    try {
      await rename(temporaryPath, databasePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(`${databasePath}-journal`, { force: true });
  }
  return { databasePath, fingerprint, sourceSha256, paperCount: index.papers.length, claimCount, rebuilt: true };
}

export async function rebuildSearchIndex(support, { databasePath = path.join(support, "Cache", "Search", "liteverse.sqlite") } = {}) {
  return withSearchIndexLock(support, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await rebuildSearchIndexUnlocked(support, { databasePath });
      if (!result.retry) return result;
    }
    throw new Error("Knowledge/papers.json kept changing while rebuilding the search index");
  });
}

export async function ensureSearchIndex(support, options = {}) {
  const databasePath = options.databasePath ?? path.join(support, "Cache", "Search", "liteverse.sqlite");
  const { index, sourceSha256 } = await loadPaperIndex(support);
  const fingerprint = indexFingerprint(index);
  try {
    const database = openDatabase(databasePath);
    try {
      schema(database);
      const metadata = Object.fromEntries(database.prepare("SELECT key, value FROM metadata").all().map((row) => [row.key, row.value]));
      if (metadata.schemaVersion === SEARCH_SCHEMA_VERSION &&
          metadata.queryContractVersion === QUERY_CONTRACT_VERSION &&
          metadata.aliasContractJson === ALIAS_CONTRACT_JSON &&
          metadata.aliasContractSha256 === ALIAS_CONTRACT_SHA256 &&
          metadata.fingerprint === fingerprint &&
          metadata.catalogSha256 === sourceSha256 &&
          Number(metadata.paperCount) === index.papers.length &&
          Number.isInteger(Number(metadata.claimCount)) && Number(metadata.claimCount) >= 0) {
        return {
          databasePath,
          fingerprint,
          sourceSha256,
          paperCount: index.papers.length,
          claimCount: Number(metadata.claimCount),
          rebuilt: false,
        };
      }
    } finally {
      database.close();
    }
  } catch (error) {
    if (!/unable to open|not a database|malformed|no such table/i.test(error.message)) throw error;
  }
  return rebuildSearchIndex(support, { databasePath });
}

function queryExpression(query) {
  const normalized = expandSearchText(query);
  const tokens = [...new Set(normalized.split(/\s+/).filter((token) => token.length > 0))];
  if (!tokens.length) throw new Error("query contains no searchable letters or digits after normalization");
  return tokens.slice(0, 48).map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export async function searchLiteverse(support, query, { limit = 10, includeSuggestions = false } = {}) {
  if (!query?.trim()) throw new Error("missing required query");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 through 100");
  const indexState = await ensureSearchIndex(support);
  const database = openDatabase(indexState.databasePath);
  try {
    const expression = queryExpression(query);
    const rows = database.prepare(`
      SELECT p.paper_id, p.title, p.authors, p.tags, p.verification_status,
             p.primary_category, p.secondary_category, p.artifact_revision,
             p.artifact_sha256, p.card_sha256, p.claims_sha256, p.claims_path,
             p.card_path, p.fulltext_path, p.body,
             p.legacy_lines_removed,
             bm25(paper_fts, 0.0, 8.0, 4.0, 3.0, 1.0, 0.5) AS rank,
             snippet(paper_fts, 4, '⟦', '⟧', ' … ', 36) AS snippet
      FROM paper_fts JOIN papers p ON p.paper_id = paper_fts.paper_id
      WHERE paper_fts MATCH ?
      ORDER BY rank ASC, p.paper_id ASC LIMIT ?
    `).all(expression, Math.max(limit * 3, limit));
    const claimRows = database.prepare(`
      SELECT c.claim_id, c.paper_id, c.type, c.section, c.text,
             c.evidence_json, c.verification_status, c.artifact_revision,
             c.artifact_sha256,
             bm25(claim_fts, 0.0, 0.0, 2.0, 2.0, 7.0, 3.0) AS rank
      FROM claim_fts JOIN claims c ON c.claim_id = claim_fts.claim_id
      WHERE claim_fts MATCH ?
      ORDER BY rank ASC, c.claim_id ASC LIMIT ?
    `).all(expression, Math.max(limit * 8, 40));
    const claimsByPaper = new Map();
    for (const claim of claimRows) {
      const list = claimsByPaper.get(claim.paper_id) ?? [];
      list.push({
        claimId: claim.claim_id,
        type: claim.type,
        section: claim.section,
        text: claim.text,
        evidence: JSON.parse(claim.evidence_json),
        verificationStatus: claim.verification_status,
        artifactRevision: claim.artifact_revision,
        artifactSha256: claim.artifact_sha256,
        rank: claim.rank,
      });
      claimsByPaper.set(claim.paper_id, list);
    }
    const seen = new Map();
    for (const row of rows) seen.set(row.paper_id, row);
    if (seen.size < limit) {
      for (const claim of claimRows) {
        if (seen.has(claim.paper_id)) continue;
        const row = database.prepare(`
          SELECT paper_id, title, authors, tags, verification_status,
                 primary_category, secondary_category, artifact_revision,
                 artifact_sha256, card_sha256, claims_sha256, claims_path,
                 card_path, fulltext_path, body,
                 legacy_lines_removed, 0.0 AS rank, substr(body, 1, 280) AS snippet
          FROM papers WHERE paper_id=?
        `).get(claim.paper_id);
        if (row) seen.set(claim.paper_id, row);
        if (seen.size >= limit * 2) break;
      }
    }
    const graph = await readJson(path.join(support, "Graph", "current.json"), { optional: true });
    const directIds = new Set(seen.keys());
    for (const relation of graph?.relations ?? []) {
      const strength = Number(relation.strength);
      const confidence = Number(relation.confidence);
      if (relation.status !== "verified" || relation.formalEligible === false || strength < 60 || confidence < 75) continue;
      const matchedEndpoint = directIds.has(relation.source) ? relation.source : directIds.has(relation.target) ? relation.target : null;
      if (!matchedEndpoint) continue;
      const neighborId = matchedEndpoint === relation.source ? relation.target : relation.source;
      const existing = seen.get(neighborId);
      if (existing) {
        const expandedBy = [...(existing.expanded_by ?? []), relation.id].sort();
        seen.set(neighborId, { ...existing, expanded_by: expandedBy });
        continue;
      }
      if (seen.size >= Math.max(limit * 2, limit + 6)) continue;
      const neighbor = database.prepare(`
        SELECT paper_id, title, authors, tags, verification_status,
               primary_category, secondary_category, artifact_revision,
               artifact_sha256, card_sha256, claims_sha256, claims_path,
               card_path, fulltext_path, body,
               legacy_lines_removed, 10.0 AS rank, substr(body, 1, 280) AS snippet
        FROM papers WHERE paper_id=?
      `).get(neighborId);
      if (neighbor) seen.set(neighborId, { ...neighbor, expanded_by: [relation.id] });
    }
    const results = [...seen.values()].map((row) => ({
      paperId: row.paper_id,
      title: row.title,
      authors: row.authors ? row.authors.split("; ").filter(Boolean) : [],
      tags: row.tags ? row.tags.split("; ").filter(Boolean) : [],
      verificationStatus: row.verification_status,
      primaryCategory: row.primary_category,
      secondaryCategory: row.secondary_category,
      artifactRevision: row.artifact_revision,
      artifactSha256: row.artifact_sha256,
      rank: Number(row.rank),
      snippet: row.snippet?.replace(/\s+/g, " ").trim() ?? "",
      matchingClaims: (claimsByPaper.get(row.paper_id) ?? []).slice(0, 6),
      legacyLinesRemovedFromIndex: row.legacy_lines_removed,
      relationExpansion: row.expanded_by ?? [],
    }));
    results.sort((left, right) => {
      const leftClaim = left.matchingClaims[0]?.rank ?? 0;
      const rightClaim = right.matchingClaims[0]?.rank ?? 0;
      return (left.rank + leftClaim) - (right.rank + rightClaim) || left.paperId.localeCompare(right.paperId);
    });
    const selected = includeSuggestions
      ? results
      : results.filter((item) => item.verificationStatus === "evidence_verified" || item.verificationStatus === "needs_attention");
    return {
      schemaVersion: "liteverse-search-result-v1",
      query,
      indexFingerprint: indexState.fingerprint,
      indexRebuilt: indexState.rebuilt,
      count: Math.min(selected.length, limit),
      results: selected.slice(0, limit),
    };
  } finally {
    database.close();
  }
}

export async function readIndexedPaper(support, paperId) {
  const { index } = await loadPaperIndex(support);
  const paper = index.papers.find((item) => item.paperId === paperId);
  if (!paper) throw new Error(`paper is not in Knowledge/papers.json: ${paperId}`);
  return paper;
}
