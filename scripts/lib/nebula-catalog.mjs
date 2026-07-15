export function mergeNebulaAssetCatalog(currentGraph, packagedGraph) {
  const currentVisuals = currentGraph?.visuals || {};
  const packagedVisuals = packagedGraph?.visuals || {};
  const currentAssets = Array.isArray(currentVisuals.nebulaAssets)
    ? currentVisuals.nebulaAssets
    : [];
  const packagedAssets = Array.isArray(packagedVisuals.nebulaAssets)
    ? packagedVisuals.nebulaAssets
    : [];
  if (packagedAssets.length === 0) {
    throw new Error("Packaged graph does not contain a nebula asset catalog.");
  }

  const knownIds = new Set(
    currentAssets
      .map((asset) => asset?.id)
      .filter((assetId) => typeof assetId === "string" && assetId.length > 0),
  );
  const addedAssetIds = [];
  const mergedAssets = [...currentAssets];
  for (const asset of packagedAssets) {
    if (
      !asset ||
      typeof asset.id !== "string" ||
      asset.id.length === 0 ||
      typeof asset.src !== "string" ||
      asset.src.length === 0 ||
      knownIds.has(asset.id)
    ) {
      continue;
    }
    mergedAssets.push(asset);
    knownIds.add(asset.id);
    addedAssetIds.push(asset.id);
  }

  const catalogVersion = packagedVisuals.nebulaAssetCatalogVersion ?? 1;
  const versionChanged = currentVisuals.nebulaAssetCatalogVersion !== catalogVersion;
  const changed = addedAssetIds.length > 0 || versionChanged;
  if (!changed) return { graph: currentGraph, changed, addedAssetIds };

  return {
    graph: {
      ...currentGraph,
      visuals: {
        ...currentVisuals,
        nebulaAssignmentSeed:
          currentVisuals.nebulaAssignmentSeed || packagedVisuals.nebulaAssignmentSeed,
        nebulaAssetCatalogVersion: catalogVersion,
        nebulaAssets: mergedAssets,
      },
    },
    changed,
    addedAssetIds,
  };
}

export function stableNebulaHash(value) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function resolveNebulaAssetAssignments(categories, assets, seed) {
  const enabledAssets = assets.filter((asset) => asset?.enabled);
  const validIds = new Set(assets.map((asset) => asset?.id).filter(Boolean));
  const assignments = new Map();
  const usage = new Map(enabledAssets.map((asset) => [asset.id, 0]));

  for (const category of categories) {
    if (!category.nebulaAssetId || !validIds.has(category.nebulaAssetId)) continue;
    assignments.set(category.id, category.nebulaAssetId);
    if (usage.has(category.nebulaAssetId)) {
      usage.set(category.nebulaAssetId, usage.get(category.nebulaAssetId) + 1);
    }
  }

  for (const category of categories) {
    if (assignments.has(category.id) || enabledAssets.length === 0) continue;
    const minimumUsage = Math.min(...usage.values());
    const candidates = enabledAssets
      .filter((asset) => usage.get(asset.id) === minimumUsage)
      .sort(
        (left, right) =>
          stableNebulaHash(`${seed}:${category.id}:${left.id}`) -
          stableNebulaHash(`${seed}:${category.id}:${right.id}`),
      );
    const selected = candidates[0];
    if (!selected) continue;
    assignments.set(category.id, selected.id);
    usage.set(selected.id, usage.get(selected.id) + 1);
  }

  return assignments;
}
