import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const universePath = path.join(root, "data", "universe.json");
const universe = JSON.parse(await readFile(universePath, "utf8"));

if (universe.schemaVersion === "2.0.0") {
  console.log("Liteverse universe schema is already 2.0.0.");
  process.exit(0);
}

if (universe.schemaVersion !== "1.1.0") {
  throw new Error(`Refusing to migrate unexpected schema ${universe.schemaVersion}`);
}

const migrated = {
  ...universe,
  schemaVersion: "2.0.0",
  revision: 1,
  updated: new Date().toISOString().slice(0, 10),
  usagePolicy: {
    schemaVersion: 1,
    managedBy: "liteverse-retriever",
    manualUpdates: false,
    initialValue: 0,
    counter: "useCount",
    dedupeScope: "codex-task-paper",
    ledger: "Usage/events.jsonl",
    cache: "Usage/counts.json",
    visualNormalization: {
      type: "log1p",
      referenceCount: 32,
    },
    regionAggregation: "primary-category-mean",
  },
  papers: universe.papers.map((paper) => {
    const nextPaper = { ...paper };
    delete nextPaper.temperature;
    return {
      ...nextPaper,
      useCount: 0,
      markdownPath: `Knowledge/cards/${paper.id}.md`,
      fulltextPath: `Knowledge/fulltext/${paper.id}.md`,
    };
  }),
  relations: universe.relations.map((relation) => {
    const { confidence, status, ...rest } = relation;
    return {
      ...rest,
      relationVersion: "legacy-unscored",
      scoringStatus: "legacy_unscored",
      strength: null,
      confidence: null,
      status: "pending_scoring",
      legacyConfidence: confidence,
      legacyStatus: status,
    };
  }),
};

delete migrated.temperaturePolicy;

const temporaryPath = `${universePath}.migrating-${process.pid}`;
await writeFile(temporaryPath, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
await rename(temporaryPath, universePath);
console.log(
  `Migrated ${migrated.papers.length} papers and ${migrated.relations.length} relations to runtime schema 2.0.0.`,
);
