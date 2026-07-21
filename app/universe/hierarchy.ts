import {
  type Category,
  type Paper,
  type Relation,
  type UniverseGraph,
  type Vector3,
} from "./types";
import {
  deriveGalaxyHierarchyRecords,
  GALAXY_ASSET_IDS,
  MAX_GALAXIES_PER_NEBULA as CONTRACT_MAX_GALAXIES_PER_NEBULA,
  stableHierarchyHash,
} from "../../scripts/lib/liteverse-galaxy-contract.mjs";

export const MAX_GALAXIES_PER_NEBULA = CONTRACT_MAX_GALAXIES_PER_NEBULA;
export const GALAXY_ASSETS = GALAXY_ASSET_IDS;
export { stableHierarchyHash };

export type Galaxy = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  position: Vector3;
  assetId: string;
  paperIds: string[];
  seedPaperId: string;
};

export type GalaxyRelationLane = {
  id: string;
  key: string;
  sourceGalaxyId: string;
  targetGalaxyId: string;
  relation: Relation;
  laneIndex: number;
  laneCount: number;
};

export type PersonalMemory = {
  id?: string;
  memoryId?: string;
  type: string;
  title?: string;
  statement?: string;
  content?: string;
  state: string;
  evidenceState: string;
  provenance: string | string[];
  scope?: {
    categoryId?: string;
    regionId?: string;
    graphRevision?: number;
    [key: string]: unknown;
  } | null;
  presentation?: {
    kind?: "note" | "knowledge_card" | string;
    format?: "markdown" | "plain_text" | string;
    title?: string;
    [key: string]: unknown;
  } | null;
  source?: {
    kind?: string;
    categoryId?: string;
    regionId?: string;
    format?: string;
    originalFilename?: string;
    [key: string]: unknown;
  } | null;
  createdAt?: string;
  updatedAt?: string;
};

export type GalaxyHierarchy = {
  galaxies: Galaxy[];
  galaxyById: Map<string, Galaxy>;
  galaxyByPaperId: Map<string, Galaxy>;
  galaxiesByCategoryId: Map<string, Galaxy[]>;
  relationLanes: GalaxyRelationLane[];
};

function relationLanes(
  relations: Relation[],
  galaxyByPaperId: Map<string, Galaxy>,
) {
  const groups = new Map<string, Array<{ relation: Relation; source: Galaxy; target: Galaxy }>>();
  for (const relation of relations) {
    const source = galaxyByPaperId.get(relation.source);
    const target = galaxyByPaperId.get(relation.target);
    if (!source || !target || source.id === target.id) continue;
    const key = [source.id, target.id].sort().join("--");
    const records = groups.get(key) || [];
    records.push({ relation, source, target });
    groups.set(key, records);
  }
  const lanes: GalaxyRelationLane[] = [];
  for (const [key, records] of groups) {
    records.sort((left, right) => left.relation.id.localeCompare(right.relation.id));
    records.forEach((record, laneIndex) => {
      const [sourceGalaxyId, targetGalaxyId] = [record.source.id, record.target.id].sort();
      lanes.push({
        id: `galaxy-lane-${record.relation.id}`,
        key,
        sourceGalaxyId,
        targetGalaxyId,
        relation: record.relation,
        laneIndex,
        laneCount: records.length,
      });
    });
  }
  return lanes;
}

export function buildGalaxyHierarchy(graph: UniverseGraph): GalaxyHierarchy {
  // App fallback and Curator staging deliberately share this pure contract.
  // Passing the graph as its own preservation source also makes a partially
  // materialized incremental snapshot route exactly as stage-refresh will.
  const { galaxies } = deriveGalaxyHierarchyRecords(graph, { previousGraph: graph });
  const galaxyById = new Map(galaxies.map((galaxy) => [galaxy.id, galaxy]));
  const galaxyByPaperId = new Map<string, Galaxy>();
  const galaxiesByCategoryId = new Map<string, Galaxy[]>();
  for (const galaxy of galaxies) {
    for (const paperId of galaxy.paperIds) galaxyByPaperId.set(paperId, galaxy);
    const siblings = galaxiesByCategoryId.get(galaxy.categoryId) || [];
    siblings.push(galaxy);
    galaxiesByCategoryId.set(galaxy.categoryId, siblings);
  }
  for (const siblings of galaxiesByCategoryId.values()) {
    siblings.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }
  return {
    galaxies,
    galaxyById,
    galaxyByPaperId,
    galaxiesByCategoryId,
    relationLanes: relationLanes(graph.relations, galaxyByPaperId),
  };
}

export function paperPositionInGalaxy(
  paper: Paper,
  galaxy: Galaxy,
  index: number,
  total: number,
): Vector3 {
  const ring = Math.floor(index / 12);
  const slots = Math.min(12, Math.max(1, total - ring * 12));
  const angle = ((index % 12) / slots) * Math.PI * 2 +
    (stableHierarchyHash(`${galaxy.id}:${paper.id}:angle`) % 720) / 720 * 0.24;
  const radius = 0.62 + ring * 0.38 + (index % 3) * 0.05;
  return [
    galaxy.position[0] + Math.cos(angle) * radius,
    galaxy.position[1] + Math.sin(angle) * radius * 0.72,
    galaxy.position[2] + ((stableHierarchyHash(`${paper.id}:depth`) % 101) / 100 - 0.5) * 0.72,
  ];
}

function memorySearchText(memory: PersonalMemory) {
  return [memory.title, memory.statement, memory.content, memory.type]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
}

export function memoriesByCategory(
  memories: PersonalMemory[],
  categories: Category[],
  papers: Paper[],
) {
  const result = new Map(categories.map((category) => [category.id, [] as PersonalMemory[]]));
  const validCategoryIds = new Set(categories.map((category) => category.id));
  const vocabulary = new Map(categories.map((category) => {
    const words = new Set(
      [category.name, category.description, ...papers
        .filter((paper) => paper.primaryCategory === category.id)
        .flatMap((paper) => paper.tags)]
        .join(" ")
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4),
    );
    return [category.id, words] as const;
  }));
  for (const memory of memories.filter((item) => {
    const presentationKind = item.presentation?.kind || item.type;
    return item.state === "active" &&
      (presentationKind === "note" || presentationKind === "knowledge_card");
  })) {
    const explicit = memory.scope?.categoryId || memory.scope?.regionId ||
      memory.source?.categoryId || memory.source?.regionId;
    let categoryId = explicit && validCategoryIds.has(explicit) ? explicit : undefined;
    if (!categoryId && categories.length > 0) {
      const text = memorySearchText(memory);
      const bestMatch = [...vocabulary.entries()]
        .map(([id, words]) => ({
          id,
          score: [...words].reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0),
        }))
        .sort((left, right) => right.score - left.score ||
          stableHierarchyHash(`${memory.memoryId || memory.id}:${left.id}`) -
            stableHierarchyHash(`${memory.memoryId || memory.id}:${right.id}`))[0];
      categoryId = bestMatch && bestMatch.score > 0 ? bestMatch.id : undefined;
    }
    if (categoryId) result.get(categoryId)?.push(memory);
  }
  for (const items of result.values()) {
    items.sort((left, right) =>
      (right.updatedAt || right.createdAt || "").localeCompare(left.updatedAt || left.createdAt || "") ||
      (left.memoryId || left.id || "").localeCompare(right.memoryId || right.id || ""),
    );
  }
  return result;
}
