import { createHash } from "node:crypto";
import {
  blackHoleClearance,
  deriveGalaxyHierarchyRecords,
  GALAXY_ASSET_IDS,
  GALAXY_HIERARCHY_ALGORITHM,
  GALAXY_HIERARCHY_SCHEMA,
  GALAXY_RING_CAPACITIES,
  GALAXY_RING_RADII,
  GALAXY_RELATION_PROJECTION,
  galaxyRingIndex,
  MAX_GALAXIES_PER_NEBULA,
  MIN_BLACK_HOLE_CLEARANCE,
  MIN_GALAXY_CENTER_SEPARATION,
  targetGalaxyCount,
} from "./liteverse-galaxy-contract.mjs";

export {
  blackHoleClearance,
  GALAXY_ASSET_IDS,
  GALAXY_HIERARCHY_ALGORITHM,
  GALAXY_HIERARCHY_SCHEMA,
  GALAXY_RING_CAPACITIES,
  GALAXY_RING_RADII,
  GALAXY_RELATION_PROJECTION,
  galaxyRingIndex,
  MAX_GALAXIES_PER_NEBULA,
  MIN_BLACK_HOLE_CLEARANCE,
  MIN_GALAXY_CENTER_SEPARATION,
  targetGalaxyCount,
};

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

function isFiniteVector3(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function squaredDistance(left, right) {
  return (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2;
}

export function hierarchyAssignmentSha256(graph) {
  return sha256(stableJson({
    galaxies: (Array.isArray(graph.galaxies) ? graph.galaxies : [])
      .map((galaxy) => ({
        id: galaxy.id,
        categoryId: galaxy.categoryId,
        name: galaxy.name,
        description: galaxy.description,
        position: galaxy.position,
        assetId: galaxy.assetId,
        seedPaperId: galaxy.seedPaperId,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    papers: (Array.isArray(graph.papers) ? graph.papers : [])
      .map((paper) => ({ id: paper.id, galaxyId: paper.galaxyId }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }));
}

export function materializeGalaxyHierarchy(graph, { previousGraph = null } = {}) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    throw new Error("graph must be an object");
  }
  if (graph.schemaVersion !== "3.0.0") return graph;
  const { galaxies, assignmentByPaperId, seed } = deriveGalaxyHierarchyRecords(graph, {
    previousGraph: previousGraph ?? graph,
  });
  const next = {
    ...graph,
    hierarchy: {
      ...(graph.hierarchy ?? {}),
      schemaVersion: GALAXY_HIERARCHY_SCHEMA,
      algorithm: GALAXY_HIERARCHY_ALGORITHM,
      relationProjection: GALAXY_RELATION_PROJECTION,
    },
    visuals: {
      ...(graph.visuals ?? {}),
      galaxyAssignmentSeed: seed,
    },
    galaxies: galaxies.map((galaxy) => ({
      id: galaxy.id,
      categoryId: galaxy.categoryId,
      name: galaxy.name,
      description: galaxy.description,
      position: galaxy.position,
      assetId: galaxy.assetId,
      seedPaperId: galaxy.seedPaperId,
    })),
    papers: graph.papers.map((paper) => ({
      ...paper,
      galaxyId: assignmentByPaperId.get(paper.id),
    })),
  };
  next.hierarchy.assignmentSha256 = hierarchyAssignmentSha256(next);
  return next;
}

function issue(code, message, details = undefined) {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

export function inspectGalaxyHierarchy(graph) {
  const papers = Array.isArray(graph?.papers) ? graph.papers : [];
  const galaxies = Array.isArray(graph?.galaxies) ? graph.galaxies : [];
  const categories = Array.isArray(graph?.categories) ? graph.categories : [];
  const present = Boolean(graph?.hierarchy || Array.isArray(graph?.galaxies)
    || papers.some((paper) => paper.galaxyId));
  if (!present) {
    return { present: false, valid: true, galaxyCount: 0, assignmentSha256: null, issues: [] };
  }

  const issues = [];
  if (graph?.schemaVersion !== "3.0.0") {
    issues.push(issue("hierarchy.schema_graph", "galaxy hierarchy requires graph schemaVersion 3.0.0"));
  }
  if (graph?.hierarchy?.schemaVersion !== GALAXY_HIERARCHY_SCHEMA) {
    issues.push(issue("hierarchy.schema", `hierarchy.schemaVersion must be ${GALAXY_HIERARCHY_SCHEMA}`));
  }
  if (graph?.hierarchy?.algorithm !== GALAXY_HIERARCHY_ALGORITHM) {
    issues.push(issue("hierarchy.algorithm", `hierarchy.algorithm must be ${GALAXY_HIERARCHY_ALGORITHM}`));
  }
  if (graph?.hierarchy?.relationProjection !== GALAXY_RELATION_PROJECTION) {
    issues.push(issue(
      "hierarchy.relation_projection",
      `hierarchy.relationProjection must be ${GALAXY_RELATION_PROJECTION}`,
    ));
  }
  if (!Array.isArray(graph?.galaxies)) {
    issues.push(issue("hierarchy.galaxies_missing", "hierarchy-enabled graph must contain a galaxies array"));
  }
  if (typeof graph?.visuals?.galaxyAssignmentSeed !== "string" || !graph.visuals.galaxyAssignmentSeed) {
    issues.push(issue("hierarchy.seed_missing", "visuals.galaxyAssignmentSeed must be a non-empty string"));
  }

  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const paperById = new Map(papers.map((paper) => [paper.id, paper]));
  const galaxyById = new Map();
  const countsByCategory = new Map();
  const galaxiesByCategory = new Map();
  const globalAssetCounts = new Map(GALAXY_ASSET_IDS.map((assetId) => [assetId, 0]));
  for (const galaxy of galaxies) {
    if (!galaxy || typeof galaxy !== "object" || Array.isArray(galaxy)
        || typeof galaxy.id !== "string" || !galaxy.id) {
      issues.push(issue("hierarchy.galaxy_id", "every galaxy must have a non-empty string id"));
      continue;
    }
    if (galaxyById.has(galaxy.id)) {
      issues.push(issue("hierarchy.galaxy_duplicate", `duplicate galaxy id ${galaxy.id}`));
      continue;
    }
    galaxyById.set(galaxy.id, galaxy);
    const category = categoryById.get(galaxy.categoryId);
    if (!category) {
      issues.push(issue(
        "hierarchy.galaxy_category",
        `galaxy ${galaxy.id} references unknown category ${galaxy.categoryId}`,
      ));
    }
    countsByCategory.set(galaxy.categoryId, (countsByCategory.get(galaxy.categoryId) ?? 0) + 1);
    const siblings = galaxiesByCategory.get(galaxy.categoryId) ?? [];
    siblings.push(galaxy);
    galaxiesByCategory.set(galaxy.categoryId, siblings);
    if (!isFiniteVector3(galaxy.position)) {
      issues.push(issue(
        "hierarchy.galaxy_position",
        `galaxy ${galaxy.id}.position must be a finite three-number vector`,
      ));
    } else if (isFiniteVector3(category?.center)) {
      if (blackHoleClearance(galaxy.position, category.center) < MIN_BLACK_HOLE_CLEARANCE) {
        issues.push(issue(
          "hierarchy.black_hole_clearance",
          `galaxy ${galaxy.id} intrudes into the central black-hole space`,
        ));
      }
      if (galaxyRingIndex(galaxy.position, category.center) < 0) {
        issues.push(issue(
          "hierarchy.galaxy_orbit_ring",
          `galaxy ${galaxy.id} is not on a supported concentric orbit ring`,
        ));
      }
    }
    if (!GALAXY_ASSET_IDS.includes(galaxy.assetId)) {
      issues.push(issue("hierarchy.galaxy_asset", `galaxy ${galaxy.id} has unknown assetId ${galaxy.assetId}`));
    } else {
      globalAssetCounts.set(galaxy.assetId, globalAssetCounts.get(galaxy.assetId) + 1);
    }
    if (typeof galaxy.name !== "string" || !galaxy.name.trim()
        || typeof galaxy.description !== "string" || !galaxy.description.trim()) {
      issues.push(issue("hierarchy.galaxy_text", `galaxy ${galaxy.id} requires non-empty name and description`));
    }
    if (!paperById.has(galaxy.seedPaperId)) {
      issues.push(issue(
        "hierarchy.seed_paper",
        `galaxy ${galaxy.id} seedPaperId ${galaxy.seedPaperId} does not exist`,
      ));
    }
  }

  for (const [categoryId, count] of countsByCategory) {
    if (count > MAX_GALAXIES_PER_NEBULA) {
      issues.push(issue(
        "hierarchy.galaxy_limit",
        `category ${categoryId} has ${count} galaxies; maximum is ${MAX_GALAXIES_PER_NEBULA}`,
      ));
    }
    const category = categoryById.get(categoryId);
    if (!isFiniteVector3(category?.center)) continue;
    const siblings = galaxiesByCategory.get(categoryId) ?? [];
    const ringCounts = GALAXY_RING_CAPACITIES.map(() => 0);
    for (const galaxy of siblings) {
      const ringIndex = galaxyRingIndex(galaxy.position, category.center);
      if (ringIndex >= 0) ringCounts[ringIndex] += 1;
    }
    for (let ringIndex = 0; ringIndex < ringCounts.length; ringIndex += 1) {
      if (ringCounts[ringIndex] > GALAXY_RING_CAPACITIES[ringIndex]) {
        issues.push(issue(
          "hierarchy.galaxy_orbit_capacity",
          `category ${categoryId} exceeds orbit ring ${ringIndex} capacity`,
        ));
      }
      if (ringIndex > 0 && ringCounts[ringIndex] > 0
          && ringCounts[ringIndex - 1] < GALAXY_RING_CAPACITIES[ringIndex - 1]) {
        issues.push(issue(
          "hierarchy.galaxy_orbit_order",
          `category ${categoryId} uses orbit ring ${ringIndex} before filling the inner ring`,
        ));
      }
    }
    for (let leftIndex = 0; leftIndex < siblings.length; leftIndex += 1) {
      const left = siblings[leftIndex];
      if (!isFiniteVector3(left.position)) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < siblings.length; rightIndex += 1) {
        const right = siblings[rightIndex];
        if (!isFiniteVector3(right.position)) continue;
        if (squaredDistance(left.position, right.position) < MIN_GALAXY_CENTER_SEPARATION ** 2) {
          issues.push(issue(
            "hierarchy.galaxy_collision",
            `galaxies ${left.id} and ${right.id} overlap inside category ${categoryId}`,
          ));
        }
      }
    }
  }

  const expectedDistinctAssets = Math.min(galaxies.length, GALAXY_ASSET_IDS.length);
  const distinctAssets = [...globalAssetCounts.values()].filter((count) => count > 0).length;
  if (distinctAssets < expectedDistinctAssets) {
    issues.push(issue(
      "hierarchy.asset_reuse_order",
      "the universe reuses galaxy artwork before all supplied assets are used",
    ));
  }
  const globalUsages = [...globalAssetCounts.values()];
  if (globalUsages.length && Math.max(...globalUsages) - Math.min(...globalUsages) > 1) {
    issues.push(issue(
      "hierarchy.asset_reuse_balance",
      "the universe does not balance galaxy artwork reuse",
    ));
  }

  const membersByGalaxy = new Map();
  for (const paper of papers) {
    if (typeof paper.galaxyId !== "string" || !paper.galaxyId) {
      issues.push(issue("hierarchy.paper_unassigned", `paper ${paper.id} has no galaxyId`));
      continue;
    }
    const galaxy = galaxyById.get(paper.galaxyId);
    if (!galaxy) {
      issues.push(issue(
        "hierarchy.paper_orphan",
        `paper ${paper.id} references unknown galaxy ${paper.galaxyId}`,
      ));
      continue;
    }
    if (galaxy.categoryId !== paper.primaryCategory) {
      issues.push(issue(
        "hierarchy.cross_nebula",
        `paper ${paper.id} galaxy ${galaxy.id} is outside primaryCategory ${paper.primaryCategory}`,
      ));
    }
    const members = membersByGalaxy.get(galaxy.id) ?? [];
    members.push(paper.id);
    membersByGalaxy.set(galaxy.id, members);
  }
  for (const galaxy of galaxies) {
    if (!galaxyById.has(galaxy?.id)) continue;
    const members = membersByGalaxy.get(galaxy.id) ?? [];
    if (!members.length) issues.push(issue("hierarchy.galaxy_empty", `galaxy ${galaxy.id} has no papers`));
    if (!members.includes(galaxy.seedPaperId)) {
      issues.push(issue(
        "hierarchy.seed_assignment",
        `galaxy ${galaxy.id} seed paper is not assigned to that galaxy`,
      ));
    }
  }

  const assignmentSha256 = hierarchyAssignmentSha256({ galaxies, papers });
  if (graph?.hierarchy?.assignmentSha256 !== assignmentSha256) {
    issues.push(issue(
      "hierarchy.assignment_hash",
      "hierarchy.assignmentSha256 does not match galaxy and paper assignments",
      {
        expected: assignmentSha256,
        actual: graph?.hierarchy?.assignmentSha256 ?? null,
      },
    ));
  }
  return {
    present: true,
    valid: issues.length === 0,
    galaxyCount: galaxies.length,
    assignmentSha256,
    countsByCategory: Object.fromEntries(
      [...countsByCategory].sort(([left], [right]) => String(left).localeCompare(String(right))),
    ),
    issues,
  };
}

export function assertValidGalaxyHierarchy(graph) {
  const result = inspectGalaxyHierarchy(graph);
  if (!result.present) throw new Error("schema-v3 staged graph is missing its galaxy hierarchy");
  if (!result.valid) throw new Error(result.issues[0].message);
  return result;
}
