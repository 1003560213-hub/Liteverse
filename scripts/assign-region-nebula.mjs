import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveNebulaAssetAssignments } from "./lib/nebula-catalog.mjs";

const root = path.resolve(import.meta.dirname, "..");
const universePath = path.join(root, "data/universe.json");
const universe = JSON.parse(await readFile(universePath, "utf8"));

const assets = universe.visuals?.nebulaAssets || [];
const enabledAssets = assets.filter((asset) => asset.enabled);
const allAssetIds = new Set(assets.map((asset) => asset.id));
const resolvedAssignments = resolveNebulaAssetAssignments(
  universe.categories,
  assets,
  universe.visuals?.nebulaAssignmentSeed || "liteverse-nebula",
);
let maximumOrder = Math.max(
  0,
  ...universe.categories.map((category) =>
    Number.isInteger(category.nebulaAssignmentOrder)
      ? category.nebulaAssignmentOrder
      : 0,
  ),
);
let changed = false;

for (const category of universe.categories) {
  if (!Number.isInteger(category.nebulaAssignmentOrder) || category.nebulaAssignmentOrder <= 0) {
    maximumOrder += 1;
    category.nebulaAssignmentOrder = maximumOrder;
    changed = true;
  }
  if (allAssetIds.has(category.nebulaAssetId)) continue;
  if (enabledAssets.length === 0) {
    throw new Error("No region-nebula artwork is available. Enable at least one image in visuals.nebulaAssets first.");
  }
  const selectedAssetId = resolvedAssignments.get(category.id);
  if (!selectedAssetId) {
    throw new Error(`Unable to assign nebula artwork to region ${category.id}.`);
  }
  category.nebulaAssetId = selectedAssetId;
  changed = true;
  console.log(`${category.id} -> ${selectedAssetId}`);
}

if (changed) {
  await writeFile(universePath, `${JSON.stringify(universe, null, 2)}\n`, "utf8");
  console.log("Region-nebula assignments were saved to data/universe.json.");
} else {
  console.log("Every region already has a stable nebula assignment; no changes were needed.");
}
