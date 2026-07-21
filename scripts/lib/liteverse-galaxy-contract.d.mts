export const GALAXY_HIERARCHY_SCHEMA: "liteverse-hierarchy-v1";
export const GALAXY_HIERARCHY_ALGORITHM: "deterministic-galaxy-routing-v2";
export const GALAXY_RELATION_PROJECTION: "galaxy-lanes-from-paper-relations-v1";
export const MAX_GALAXIES_PER_NEBULA: 12;
export const MIN_BLACK_HOLE_CLEARANCE: number;
export const MIN_GALAXY_CENTER_SEPARATION: number;
export const GALAXY_RING_RADII: readonly number[];
export const GALAXY_RING_CAPACITIES: readonly number[];
export const GALAXY_ASSET_IDS: readonly string[];

export type ContractGalaxy = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  position: [number, number, number];
  assetId: string;
  seedPaperId: string;
  paperIds: string[];
};

export function stableHierarchyHash(value: string): number;
export function targetGalaxyCount(paperCount: number): number;
export function blackHoleClearance(
  position: [number, number, number],
  origin: [number, number, number],
): number;
export function galaxyRingIndex(
  position: [number, number, number],
  origin: [number, number, number],
): number;
export function deriveGalaxyHierarchyRecords(
  graph: unknown,
  options?: { previousGraph?: unknown },
): {
  galaxies: ContractGalaxy[];
  assignmentByPaperId: Map<string, string>;
  seed: string;
};
