#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
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
  console.log(`Usage: search-papers.mjs --query "terms" [options]

Options:
  --support-dir DIR   Liteverse Application Support root
  --limit N           Maximum results, default 10
  --json              Emit machine-readable JSON

This command uses the shared SQLite FTS5/BM25 index when the Liteverse runtime
is available. It never changes Usage. Legacy provisional card sections are not
indexed.`);
}

function normalize(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || value.startsWith("[")) {
    try {
      return JSON.parse(value);
    } catch {
      return value.replace(/^['"]|['"]$/g, "");
    }
  }
  return value.replace(/^['"]|['"]$/g, "");
}

function parseCard(text, fallbackId) {
  const metadata = {};
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (frontmatter) {
    for (const line of frontmatter[1].split("\n")) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match) metadata[match[1]] = parseScalar(match[2]);
    }
  }
  const paperId = metadata.paper_id ?? metadata.paperId ?? fallbackId;
  const title = metadata.title ?? text.match(/^#\s+(.+)$/m)?.[1] ?? paperId;
  const authors = metadata.authors ?? metadata.author ?? [];
  const tags = metadata.tags ?? [];
  const body = frontmatter ? text.slice(frontmatter[0].length) : text;
  return { paperId, title, authors, tags, body, metadata };
}

function snippet(body, tokens) {
  const compact = body.replace(/^#+\s+/gm, "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const normalized = normalize(compact);
  const positions = tokens.map((token) => normalized.indexOf(token)).filter((position) => position >= 0);
  const approximate = positions.length ? Math.max(0, Math.min(...positions) - 80) : 0;
  return `${approximate > 0 ? "…" : ""}${compact.slice(approximate, approximate + 280)}${compact.length > approximate + 280 ? "…" : ""}`;
}

function scoreCard(card, tokens) {
  const fields = {
    id: normalize(card.paperId),
    title: normalize(card.title),
    authors: normalize(Array.isArray(card.authors) ? card.authors.join(" ") : String(card.authors)),
    tags: normalize(Array.isArray(card.tags) ? card.tags.join(" ") : String(card.tags)),
    body: normalize(card.body),
  };
  let score = 0;
  for (const token of tokens) {
    if (fields.id.includes(token)) score += 8;
    if (fields.title.includes(token)) score += 12;
    if (fields.authors.includes(token)) score += 6;
    if (fields.tags.includes(token)) score += 5;
    const occurrences = fields.body.split(token).length - 1;
    score += Math.min(occurrences, 5);
  }
  if (tokens.every((token) => `${fields.title} ${fields.tags} ${fields.body}`.includes(token))) score += 5;
  return score;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const query = argument("--query");
  if (!query?.trim()) fail("missing required --query");
  const limit = Number(argument("--limit") ?? 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("--limit must be an integer from 1 through 100");
  const support = path.resolve(
    argument("--support-dir")
      ?? process.env.LITEVERSE_SUPPORT_DIR
      ?? path.join(homedir(), "Library", "Application Support", "Liteverse"),
  );
  try {
    let runtime = null;
    for (const candidate of [
      new URL("../../../scripts/lib/liteverse-search.mjs", import.meta.url),
      new URL("../../../liteverse-cli/lib/liteverse-search.mjs", import.meta.url),
      new URL("../../../LiteverseCLI/lib/liteverse-search.mjs", import.meta.url),
    ]) {
      try {
        runtime = await import(candidate);
        break;
      } catch (error) {
        if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      }
    }
    if (!runtime) throw Object.assign(new Error("Liteverse shared search runtime is unavailable"), { code: "ERR_MODULE_NOT_FOUND" });
    const result = await runtime.searchLiteverse(support, query, { limit });
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!result.results.length) {
      console.log(`No Liteverse papers matched: ${query}`);
      return;
    }
    for (const item of result.results) {
      console.log(`${item.paperId}  [BM25 ${item.rank.toFixed(4)}]  ${item.title}`);
      if (item.authors?.length) console.log(`  ${item.authors.join(", ")}`);
      if (item.snippet) console.log(`  ${item.snippet}`);
    }
    return;
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ENOENT") throw error;
    // A standalone Skill installation can still search older unpinned libraries.
    // Once the shared Liteverse runtime is installed, the FTS path above is used.
  }
  const cardsDir = path.join(support, "Knowledge", "cards");
  let names;
  try {
    names = (await readdir(cardsDir)).filter((name) => name.endsWith(".md")).sort();
  } catch (error) {
    if (error.code === "ENOENT") fail(`knowledge cards directory does not exist: ${cardsDir}`);
    throw error;
  }
  const tokens = [...new Set(normalize(query).split(/\s+/).filter(Boolean))];
  if (tokens.length === 0) fail("query contains no searchable letters or digits after normalization");
  const results = [];
  for (const name of names) {
    const cardPath = path.join(cardsDir, name);
    const card = parseCard(await readFile(cardPath, "utf8"), name.slice(0, -3));
    const score = scoreCard(card, tokens);
    if (score > 0) {
      results.push({
        paperId: card.paperId,
        title: card.title,
        authors: card.authors,
        tags: card.tags,
        score,
        snippet: snippet(card.body, tokens),
        cardPath,
      });
    }
  }
  results.sort((left, right) => right.score - left.score || left.paperId.localeCompare(right.paperId));
  const selected = results.slice(0, limit);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ query, count: selected.length, results: selected }, null, 2));
    return;
  }
  if (!selected.length) {
    console.log(`No Liteverse papers matched: ${query}`);
    return;
  }
  for (const result of selected) {
    console.log(`${result.paperId}  [${result.score}]  ${result.title}`);
    if (result.authors?.length) console.log(`  ${Array.isArray(result.authors) ? result.authors.join(", ") : result.authors}`);
    if (result.snippet) console.log(`  ${result.snippet}`);
  }
}

main().catch((error) => {
  console.error(`search-papers: ${error.message}`);
  process.exitCode = 2;
});
