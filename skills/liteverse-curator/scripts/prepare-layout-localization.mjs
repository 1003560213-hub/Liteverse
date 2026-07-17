#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  assignDeterministicPartitionLayout,
  atomicWrite,
  paperArtifactFingerprint,
  readJsonWithText,
  resolveSupport,
  sha256,
  stableText,
} from "./partition-contract.mjs";
import {
  backgroundFootprintCost,
  DEFAULT_BACKGROUND_LAYOUT_PROFILE,
  summarizeProjectedNebulaOverlap,
} from "./partition-layout-profile.mjs";

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/u;
const SCHEMA = "liteverse-interface-localization-v1";
const LAYOUT_ALGORITHM = "background-aware-v1";

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

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be non-empty text`);
  return value.trim();
}

function englishText(value, label) {
  const normalized = text(value, label);
  if (HAN.test(normalized)) fail(`${label} still contains Han characters`);
  return normalized;
}

function assertExactIds(mapping, records, label) {
  const expected = records.map((record) => record.id).sort();
  const actual = Object.keys(mapping).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} IDs must exactly match the current graph`);
  }
}

function assertNoHan(graph) {
  const checks = [["title", graph.title]];
  for (const category of graph.categories) {
    checks.push(
      [`category ${category.id}.name`, category.name],
      [`category ${category.id}.description`, category.description],
      [`category ${category.id}.creationEvidence.scopeDefinition`, category.creationEvidence?.scopeDefinition ?? ""],
    );
  }
  for (const paper of graph.papers) {
    checks.push(
      [`paper ${paper.id}.summary`, paper.summary ?? ""],
      [`paper ${paper.id}.projectRole`, paper.projectRole ?? ""],
    );
    for (const [index, tag] of (paper.tags ?? []).entries()) {
      checks.push([`paper ${paper.id}.tags[${index}]`, tag]);
    }
  }
  for (const relation of graph.relations) checks.push([`relation ${relation.id}.label`, relation.label ?? ""]);
  const remaining = checks.filter(([, value]) => typeof value === "string" && HAN.test(value));
  if (remaining.length) fail(`localized graph retains Han text at ${remaining[0][0]}`);
}

function assertPreservedScientificIdentity(current, next) {
  const ids = (records) => records.map((record) => record.id).sort();
  for (const field of ["categories", "papers", "relations"]) {
    if (JSON.stringify(ids(current[field])) !== JSON.stringify(ids(next[field]))) {
      fail(`${field} IDs changed during localization`);
    }
  }
  const currentAssignments = current.papers.map((paper) => ({
    id: paper.id,
    primaryCategory: paper.primaryCategory,
    secondaryCategory: paper.secondaryCategory ?? null,
    categoryIds: paper.categoryIds ?? [],
  })).sort((left, right) => left.id.localeCompare(right.id));
  const nextAssignments = next.papers.map((paper) => ({
    id: paper.id,
    primaryCategory: paper.primaryCategory,
    secondaryCategory: paper.secondaryCategory ?? null,
    categoryIds: paper.categoryIds ?? [],
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (JSON.stringify(currentAssignments) !== JSON.stringify(nextAssignments)) {
    fail("paper category assignments changed during localization");
  }
  const currentRelations = current.relations.map((relation) => ({
    id: relation.id,
    source: relation.source,
    target: relation.target,
    type: relation.type,
    status: relation.status ?? null,
    strength: relation.strength ?? null,
    confidence: relation.confidence ?? null,
  })).sort((left, right) => left.id.localeCompare(right.id));
  const nextRelations = next.relations.map((relation) => ({
    id: relation.id,
    source: relation.source,
    target: relation.target,
    type: relation.type,
    status: relation.status ?? null,
    strength: relation.strength ?? null,
    confidence: relation.confidence ?? null,
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (JSON.stringify(currentRelations) !== JSON.stringify(nextRelations)) {
    fail("relation scientific identity changed during localization");
  }
  if (paperArtifactFingerprint(current.papers) !== paperArtifactFingerprint(next.papers)) {
    fail("paper artifact pins changed during localization");
  }
}

function meanBackgroundCost(categories) {
  if (!categories.length) return 0;
  return categories.reduce((sum, category) => sum + backgroundFootprintCost(category.center).cost, 0)
    / categories.length;
}

function ensureSafeOutput(support, outputPath) {
  const graph = path.join(support, "Graph");
  const current = path.join(graph, "current.json");
  const staged = `${path.join(graph, "staged")}${path.sep}`;
  const history = `${path.join(graph, "history")}${path.sep}`;
  if (outputPath === current || outputPath.startsWith(staged) || outputPath.startsWith(history)) {
    fail("output must be an unstaged Planning file, never current, staged, or history graph state");
  }
}

export function buildLocalizedLayout(current, translations, options) {
  object(current, "current graph");
  object(translations, "translations");
  if (translations.schemaVersion !== SCHEMA) fail(`translations.schemaVersion must be ${SCHEMA}`);
  if (translations.locale !== "en") fail("translations.locale must be en");
  if (translations.baseRevision !== current.revision) fail("translations.baseRevision does not match current graph");
  const categoryTranslations = object(translations.categories, "translations.categories");
  const paperTranslations = object(translations.papers, "translations.papers");
  const relationTranslations = object(translations.relations, "translations.relations");
  assertExactIds(categoryTranslations, current.categories, "translations.categories");
  assertExactIds(paperTranslations, current.papers, "translations.papers");
  assertExactIds(relationTranslations, current.relations, "translations.relations");

  const categories = current.categories.map((category) => {
    const localized = object(categoryTranslations[category.id], `category translation ${category.id}`);
    const creationEvidence = category.creationEvidence
      ? {
          ...category.creationEvidence,
          scopeDefinition: englishText(
            localized.scopeDefinition,
            `category translation ${category.id}.scopeDefinition`,
          ),
        }
      : category.creationEvidence;
    return {
      ...category,
      name: englishText(localized.name, `category translation ${category.id}.name`),
      description: englishText(localized.description, `category translation ${category.id}.description`),
      creationEvidence,
    };
  });
  const papers = current.papers.map((paper) => {
    const localized = object(paperTranslations[paper.id], `paper translation ${paper.id}`);
    if (!Array.isArray(localized.tags)) fail(`paper translation ${paper.id}.tags must be an array`);
    return {
      ...paper,
      summary: englishText(localized.summary, `paper translation ${paper.id}.summary`),
      projectRole: englishText(localized.projectRole, `paper translation ${paper.id}.projectRole`),
      tags: localized.tags.map((tag, index) => englishText(tag, `paper translation ${paper.id}.tags[${index}]`)),
    };
  });
  const relations = current.relations.map((relation) => {
    const localized = object(relationTranslations[relation.id], `relation translation ${relation.id}`);
    return {
      ...relation,
      label: englishText(localized.label, `relation translation ${relation.id}.label`),
    };
  });
  const seed = `${current.visuals?.nebulaAssignmentSeed ?? "liteverse-nebula"}:${current.partitionDecision?.optionId ?? "english-layout-v1"}`;
  const layout = assignDeterministicPartitionLayout(
    current,
    current,
    categories,
    papers,
    seed,
    { preserveUnchangedCenters: false },
  );
  const next = {
    ...current,
    revision: current.revision + 1,
    updated: options.decisionTime,
    title: englishText(translations.title, "translations.title"),
    visuals: {
      ...current.visuals,
      interfaceLocale: "en",
      partitionLayoutAlgorithm: LAYOUT_ALGORITHM,
      partitionLayoutProfileSha256: DEFAULT_BACKGROUND_LAYOUT_PROFILE.sourceSha256,
    },
    categories: layout.categories,
    papers: layout.papers,
    relations,
    interfaceLocalization: {
      schemaVersion: SCHEMA,
      locale: "en",
      baseRevision: current.revision,
      sourceGraphSha256: options.sourceGraphSha256,
      confirmedByUser: true,
      confirmationNote: options.confirmationNote,
      decisionTime: options.decisionTime,
      layoutAlgorithm: LAYOUT_ALGORITHM,
      layoutProfileSha256: DEFAULT_BACKGROUND_LAYOUT_PROFILE.sourceSha256,
    },
  };
  assertNoHan(next);
  assertPreservedScientificIdentity(current, next);
  return next;
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`Usage: prepare-layout-localization.mjs --translations FILE --output FILE --confirmed-by-user [options]

Options:
  --support-dir DIR       Liteverse Application Support root
  --confirmation-note S  English audit note describing the user's request
  --decision-time ISO     Explicit ISO-8601 user-decision time

Writes one complete, unstaged Planning snapshot. It never edits Graph/current.json,
Graph/staged, Graph/history, queues, or Usage.`);
    return;
  }
  const support = resolveSupport(argument("--support-dir"));
  const translationsPath = path.resolve(text(argument("--translations"), "--translations"));
  const outputPath = path.resolve(text(argument("--output"), "--output"));
  ensureSafeOutput(support, outputPath);
  if (!hasFlag("--confirmed-by-user")) fail("--confirmed-by-user is required");
  const confirmationNote = englishText(argument("--confirmation-note"), "--confirmation-note");
  const decisionTime = text(argument("--decision-time"), "--decision-time");
  if (Number.isNaN(Date.parse(decisionTime))) fail("--decision-time must be a valid ISO-8601 timestamp");
  const currentPath = path.join(support, "Graph", "current.json");
  const [{ value: current, text: currentText }, { value: translations }] = await Promise.all([
    readJsonWithText(currentPath, "current graph"),
    readJsonWithText(translationsPath, "translation map"),
  ]);
  const sourceGraphSha256 = sha256(currentText);
  const next = buildLocalizedLayout(current, translations, {
    confirmationNote,
    decisionTime: new Date(decisionTime).toISOString(),
    sourceGraphSha256,
  });
  await atomicWrite(outputPath, stableText(next, true));
  const oldCenters = current.categories.map((category) => category.center);
  const newCenters = next.categories.map((category) => category.center);
  console.log(stableText({
    outputPath,
    baseRevision: current.revision,
    targetRevision: next.revision,
    sourceGraphSha256,
    locale: "en",
    layoutAlgorithm: LAYOUT_ALGORITHM,
    profileSha256: DEFAULT_BACKGROUND_LAYOUT_PROFILE.sourceSha256,
    oldMeanBackgroundCost: meanBackgroundCost(current.categories),
    newMeanBackgroundCost: meanBackgroundCost(next.categories),
    oldProjectedOverlap: summarizeProjectedNebulaOverlap(oldCenters),
    newProjectedOverlap: summarizeProjectedNebulaOverlap(newCenters),
  }, true));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
