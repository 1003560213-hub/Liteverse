#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(message);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  console.log(`Usage: screen-incremental-classification.mjs --snapshot FILE --input FILE [--output FILE]

Ranks new papers against the already selected macro regions without modifying a
graph. The output is routing-only and never constitutes verified classification.

Input accepts either an array or { "papers": [...] }. Each paper needs paperId
or id plus enough title, summary, abstract, tags, or candidate text to screen.`);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedText(value) {
  if (Array.isArray(value)) return value.map(boundedText).filter(Boolean).join(" ");
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function tokens(value) {
  const normalized = boundedText(value).normalize("NFKC").toLocaleLowerCase("en-US");
  const groups = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const output = [];
  for (const group of groups) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(group)) {
      const characters = [...group];
      output.push(...characters);
      for (let index = 0; index + 1 < characters.length; index += 1) {
        output.push(`${characters[index]}${characters[index + 1]}`);
      }
      continue;
    }
    if (group.length >= 2 || /^\d+$/.test(group)) output.push(group);
  }
  return output;
}

function termFrequency(values) {
  const counts = new Map();
  for (const token of values) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function weightedVector(tf, idf) {
  const vector = new Map();
  for (const [token, count] of tf) vector.set(token, (1 + Math.log(count)) * (idf.get(token) ?? 1));
  return vector;
}

function cosine(left, right) {
  let numerator = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  for (const [token, value] of left) numerator += value * (right.get(token) ?? 0);
  return leftNorm && rightNorm ? numerator / Math.sqrt(leftNorm * rightNorm) : 0;
}

function weightedCoverage(query, profile) {
  let matched = 0;
  let total = 0;
  for (const [token, value] of query) {
    total += value;
    if (profile.has(token)) matched += value;
  }
  return total ? matched / total : 0;
}

function paperText(paper) {
  return [
    boundedText(paper.title),
    boundedText(paper.shortTitle),
    boundedText(paper.abstract),
    boundedText(paper.summary),
    boundedText(paper.projectRole),
    boundedText(paper.tags),
    boundedText(paper.candidateText),
    boundedText(paper.claims?.map((claim) => claim?.text)),
  ].filter(Boolean).join(" ");
}

function categoryText(category, members) {
  return [
    `${boundedText(category.name)} `.repeat(3),
    `${boundedText(category.description)} `.repeat(2),
    ...members.map(paperText),
  ].filter(Boolean).join(" ");
}

function roundScore(value) {
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function screenIncrementalClassification(snapshot, input) {
  const categories = (snapshot?.categories ?? []).filter((category) =>
    category && typeof category.id === "string" && category.id !== "liteverse-staging" && category.kind !== "system");
  if (!categories.length || categories.length > 10) fail("snapshot must contain from one through ten selected macro regions");
  const existingPapers = Array.isArray(snapshot?.papers) ? snapshot.papers : [];
  const newPapers = Array.isArray(input) ? input : input?.papers;
  if (!Array.isArray(newPapers) || !newPapers.length) fail("input must contain at least one paper");

  const seen = new Set();
  for (const paper of newPapers) {
    const paperId = paper?.paperId ?? paper?.id;
    if (typeof paperId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(paperId)) fail("each input paper needs a lowercase paperId or id");
    if (seen.has(paperId)) fail(`duplicate input paper: ${paperId}`);
    if (!tokens(paperText(paper)).length) fail(`${paperId}: no usable screening text`);
    seen.add(paperId);
  }

  const categoryDocuments = categories.map((category) => ({
    category,
    tf: termFrequency(tokens(categoryText(
      category,
      existingPapers.filter((paper) => paper.primaryCategory === category.id || paper.categoryIds?.[0] === category.id),
    ))),
  }));
  const documentFrequency = new Map();
  for (const { tf } of categoryDocuments) {
    for (const token of tf.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const idf = new Map([...documentFrequency].map(([token, count]) => [
    token,
    Math.log((1 + categoryDocuments.length) / (1 + count)) + 1,
  ]));
  const profiles = categoryDocuments.map(({ category, tf }) => ({ category, vector: weightedVector(tf, idf) }));

  const queryVectors = new Map();
  const assignments = newPapers.map((paper) => {
    const paperId = paper.paperId ?? paper.id;
    const vector = weightedVector(termFrequency(tokens(paperText(paper))), idf);
    queryVectors.set(paperId, vector);
    const candidates = profiles.map(({ category, vector: profile }) => {
      const cosineScore = cosine(vector, profile);
      const coverageScore = weightedCoverage(vector, profile);
      const matchScore = roundScore(0.72 * cosineScore + 0.28 * coverageScore);
      return {
        categoryId: category.id,
        categoryName: category.name,
        matchScore,
        diagnostics: {
          cosine: Number(cosineScore.toFixed(6)),
          queryCoverage: Number(coverageScore.toFixed(6)),
        },
      };
    }).sort((left, right) => right.matchScore - left.matchScore || left.categoryId.localeCompare(right.categoryId));
    return {
      paperId,
      candidates: candidates.slice(0, 3),
      recommendedCategoryId: candidates[0].categoryId,
      recommendedMatchScore: candidates[0].matchScore,
      provisional: true,
      requiresScientificConfirmation: true,
    };
  });

  const lowFit = assignments.filter((assignment) => assignment.recommendedMatchScore < 60);
  let withinClusterConsistency = null;
  if (lowFit.length >= 4) {
    let total = 0;
    let pairs = 0;
    for (let left = 0; left < lowFit.length; left += 1) {
      for (let right = left + 1; right < lowFit.length; right += 1) {
        total += cosine(queryVectors.get(lowFit[left].paperId), queryVectors.get(lowFit[right].paperId));
        pairs += 1;
      }
    }
    withinClusterConsistency = roundScore(pairs ? total / pairs : 0);
  }

  const fingerprintInput = {
    snapshotRevision: snapshot.revision ?? null,
    categories: categories.map((category) => ({ id: category.id, name: category.name, description: category.description ?? "" })),
    existingPapers: existingPapers.map((paper) => ({ id: paper.id, primaryCategory: paper.primaryCategory, text: paperText(paper) })),
    input: newPapers.map((paper) => ({ id: paper.paperId ?? paper.id, text: paperText(paper) })),
  };
  return {
    schemaVersion: "liteverse-incremental-classification-v1",
    routingOnly: true,
    writesGraph: false,
    baseRevision: snapshot.revision ?? null,
    sourceFingerprint: sha256(stableJson(fingerprintInput)),
    assignments,
    repartitionAdvisory: {
      lowFitPaperIds: lowFit.map((assignment) => assignment.paperId),
      withinClusterConsistency,
      proposeThreeOptions: lowFit.length >= 4 && withinClusterConsistency >= 70,
      rule: "At least four low-fit papers and at least 70% within-cluster consistency are required before proposing a new macro region.",
    },
  };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) return usage();
  const snapshotPath = argument("--snapshot");
  const inputPath = argument("--input");
  if (!snapshotPath || !inputPath) return usage(), process.exitCode = 2;
  const [snapshot, input] = await Promise.all([
    readFile(path.resolve(snapshotPath), "utf8").then(JSON.parse),
    readFile(path.resolve(inputPath), "utf8").then(JSON.parse),
  ]);
  const result = screenIncrementalClassification(snapshot, input);
  const output = argument("--output");
  if (output) await atomicWriteJson(path.resolve(output), result);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`screen-incremental-classification: ${error.message}`);
    process.exitCode = 2;
  });
}
