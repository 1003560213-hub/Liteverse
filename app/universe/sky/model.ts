import type { GalaxyHierarchy } from "../hierarchy";
import type { Category, UniverseGraph, Vector3 } from "../types";
import { stableHierarchyHash } from "../hierarchy";

/**
 * Pure view model for the 3D sky. Everything the renderer draws is derived
 * here from the committed graph (reviewed papers) plus the Tier-0 analysis of
 * unreviewed library items. Nothing in this module writes data.
 */

export type EvidenceTier = 0 | 1 | 2;

export type SkyPaperMeta = {
  id: string;
  title: string;
  shortTitle: string;
  year: number | null;
  tier: EvidenceTier;
  heat: number;
  /** In-library citation in-degree, from Tier-0 reference resolution. */
  centrality: number;
};

export type ProvisionalLayout = {
  regions: Array<{ key: string; label: string; paperIds: string[] }>;
  galaxies: Array<{ key: string; regionKey: string; label: string; paperIds: string[] }>;
};

export type SkyRegion = {
  id: string;
  label: string;
  color: string;
  center: Vector3;
  radius: number;
  provisional: boolean;
  paperCount: number;
  galaxyIds: string[];
  noteCount: number;
  styleIndex: number;
};

export type SkyGalaxy = {
  id: string;
  regionId: string;
  label: string;
  position: Vector3;
  radius: number;
  archetype: number;
  paperIds: string[];
  provisional: boolean;
  inclination: number;
  positionAngle: number;
  spin: number;
  heat: number;
};

export type SkyStar = {
  id: string;
  galaxyId: string;
  position: Vector3;
  meta: SkyPaperMeta;
};

export type FilamentKind = "citation" | "verified" | "candidate" | "unscored";

export type SkyFilament = {
  id: string;
  sourceGalaxyId: string;
  targetGalaxyId: string;
  kind: FilamentKind;
  weight: number;
  relationKey?: string;
};

export type SkyModel = {
  regions: SkyRegion[];
  galaxies: SkyGalaxy[];
  stars: SkyStar[];
  filaments: SkyFilament[];
  regionById: Map<string, SkyRegion>;
  galaxyById: Map<string, SkyGalaxy>;
  starById: Map<string, SkyStar>;
  galaxyByPaperId: Map<string, SkyGalaxy>;
  extent: number;
};

export type SkyModelInput = {
  graph: UniverseGraph;
  hierarchy: GalaxyHierarchy;
  provisional: ProvisionalLayout;
  paperMeta: ReadonlyMap<string, SkyPaperMeta>;
  citationEdges: ReadonlyArray<{ source: string; target: string }>;
  relationLanes: ReadonlyArray<{ key: string; sourceGalaxyId: string; targetGalaxyId: string; state: FilamentKind }>;
  noteCountByCategory: ReadonlyMap<string, number>;
};

const TAU = Math.PI * 2;
const ARCHETYPE_COUNT = 10;
const PROVISIONAL_COLORS = ["#9fb4d8", "#c8b39a", "#a9c7bd", "#c3a6c8", "#b7c29a", "#d0a99f"];

function unit(hashInput: string) {
  return (stableHierarchyHash(hashInput) % 100_000) / 100_000;
}

/** Galaxy identity art: map the persisted 2D asset id (e.g. "03-...png") to a 3D archetype. */
export function archetypeForAsset(assetId: string | undefined, fallbackKey: string) {
  const match = assetId?.match(/^(\d{2})-/);
  if (match) {
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < ARCHETYPE_COUNT) return index;
  }
  return stableHierarchyHash(`${fallbackKey}:archetype`) % ARCHETYPE_COUNT;
}

export function galaxyRadiusForCount(count: number) {
  return Math.min(0.95, 0.42 + 0.17 * Math.log2(1 + Math.max(0, count)));
}

function orientation(key: string) {
  // Random isotropic orientation: cos(i) uniform. Keep galaxies away from
  // exactly edge-on so their structure remains legible at small sizes.
  const cosInclination = 0.22 + 0.78 * unit(`${key}:inclination`);
  return {
    inclination: Math.acos(cosInclination),
    positionAngle: unit(`${key}:pa`) * TAU,
    spin: unit(`${key}:spin`) < 0.5 ? -1 : 1,
  };
}

/**
 * Places a paper inside its galaxy disk (galaxy frame, before inclination).
 * Foundational papers (high in-library citation in-degree) sit near the bulge;
 * later papers wind outward along a logarithmic arm, like younger stars.
 */
export function starOffsetInGalaxy(
  galaxyRadius: number,
  rankByCentrality: number,
  total: number,
  yearFraction: number,
  key: string,
): Vector3 {
  const fraction = total <= 1 ? 0 : rankByCentrality / (total - 1);
  const radius = galaxyRadius * (0.08 + 0.78 * Math.sqrt(fraction));
  const arm = stableHierarchyHash(`${key}:arm`) % 2;
  const pitch = 0.3; // ~17 degrees
  const theta = Math.log(Math.max(0.05, radius / galaxyRadius) / 0.08) / Math.tan(pitch) +
    arm * Math.PI + yearFraction * 0.6 + (unit(`${key}:jitter`) - 0.5) * 0.5;
  const height = (unit(`${key}:z`) - 0.5) * galaxyRadius * 0.06;
  return [Math.cos(theta) * radius, height, Math.sin(theta) * radius];
}

/** Rotate a galaxy-frame offset by inclination (about x) and position angle (about y). */
export function orientOffset(offset: Vector3, inclination: number, positionAngle: number): Vector3 {
  const [x, y, z] = offset;
  const cosI = Math.cos(inclination);
  const sinI = Math.sin(inclination);
  const y1 = y * cosI - z * sinI;
  const z1 = y * sinI + z * cosI;
  const cosP = Math.cos(positionAngle);
  const sinP = Math.sin(positionAngle);
  return [x * cosP + z1 * sinP, y1, -x * sinP + z1 * cosP];
}

function styleIndexForCategory(category: Category, fallback: number) {
  const match = category.nebulaAssetId?.match(/(\d+)$/);
  return match ? (Number(match[1]) - 1) % ARCHETYPE_COUNT : fallback;
}

export function buildSkyModel(input: SkyModelInput): SkyModel {
  const { graph, hierarchy, provisional, paperMeta } = input;
  const regions: SkyRegion[] = [];
  const galaxies: SkyGalaxy[] = [];

  const macroCategories = graph.categories.filter((category) => category.kind !== "system");
  macroCategories.forEach((category, index) => {
    const categoryGalaxies = hierarchy.galaxiesByCategoryId.get(category.id) || [];
    const paperCount = categoryGalaxies.reduce((sum, galaxy) => sum + galaxy.paperIds.length, 0);
    let extent = 1.6;
    for (const galaxy of categoryGalaxies) {
      const dx = galaxy.position[0] - category.center[0];
      const dy = galaxy.position[1] - category.center[1];
      const dz = galaxy.position[2] - category.center[2];
      extent = Math.max(extent, Math.hypot(dx, dy, dz) + galaxyRadiusForCount(galaxy.paperIds.length));
    }
    regions.push({
      id: category.id,
      label: category.name,
      color: category.color,
      center: category.center,
      radius: extent,
      provisional: false,
      paperCount,
      galaxyIds: categoryGalaxies.map((galaxy) => galaxy.id),
      noteCount: input.noteCountByCategory.get(category.id) || 0,
      styleIndex: styleIndexForCategory(category, index),
    });
    for (const galaxy of categoryGalaxies) {
      galaxies.push({
        id: galaxy.id,
        regionId: category.id,
        label: galaxy.name,
        position: galaxy.position,
        radius: galaxyRadiusForCount(galaxy.paperIds.length),
        archetype: archetypeForAsset(galaxy.assetId, galaxy.id),
        paperIds: [...galaxy.paperIds],
        provisional: false,
        heat: 0,
        ...orientation(galaxy.id),
      });
    }
  });

  // Unreviewed papers get provisional clusters from the Tier-0 analysis. They
  // sit on an outer ring so that reviewed structure never moves when new
  // material arrives.
  let committedExtent = 0;
  for (const region of regions) {
    committedExtent = Math.max(committedExtent, Math.hypot(...region.center) + region.radius);
  }
  const provisionalRegions = provisional.regions.filter((region) => region.paperIds.length > 0);
  const ringRadius = regions.length === 0
    ? (provisionalRegions.length <= 1 ? 0 : 4.2 + provisionalRegions.length * 0.35)
    : committedExtent + 2.2;
  provisionalRegions.forEach((region, index) => {
    const angle = (index / Math.max(1, provisionalRegions.length)) * TAU + unit(`${region.key}:ring`) * 0.35;
    const center: Vector3 = [
      Math.cos(angle) * ringRadius,
      (unit(`${region.key}:y`) - 0.5) * 1.6,
      Math.sin(angle) * ringRadius,
    ];
    const regionGalaxies = provisional.galaxies.filter((galaxy) => galaxy.regionKey === region.key);
    const regionId = `provisional:${region.key}`;
    let extent = 1.4;
    regionGalaxies.forEach((galaxy, galaxyIndex) => {
      const ringIndex = galaxyIndex < 4 ? 0 : 1;
      const slots = ringIndex === 0 ? Math.min(4, regionGalaxies.length) : Math.max(1, regionGalaxies.length - 4);
      const slot = ringIndex === 0 ? galaxyIndex : galaxyIndex - 4;
      const orbit = regionGalaxies.length === 1 ? 0 : ringIndex === 0 ? 1.7 : 2.8;
      const theta = (slot / slots) * TAU + unit(`${galaxy.key}:phase`) * 0.6;
      const position: Vector3 = [
        center[0] + Math.cos(theta) * orbit,
        center[1] + Math.sin(2 * theta + unit(region.key)) * 0.35,
        center[2] + Math.sin(theta) * orbit * 0.72,
      ];
      const radius = galaxyRadiusForCount(galaxy.paperIds.length);
      extent = Math.max(extent, orbit + radius);
      galaxies.push({
        id: `provisional:${galaxy.key}`,
        regionId,
        label: galaxy.label,
        position,
        radius,
        archetype: stableHierarchyHash(`${galaxy.key}:archetype`) % ARCHETYPE_COUNT,
        paperIds: [...galaxy.paperIds],
        provisional: true,
        heat: 0,
        ...orientation(galaxy.key),
      });
    });
    regions.push({
      id: regionId,
      label: region.label,
      color: PROVISIONAL_COLORS[index % PROVISIONAL_COLORS.length],
      center,
      radius: extent,
      provisional: true,
      paperCount: region.paperIds.length,
      galaxyIds: regionGalaxies.map((galaxy) => `provisional:${galaxy.key}`),
      noteCount: 0,
      styleIndex: index % ARCHETYPE_COUNT,
    });
  });

  const stars: SkyStar[] = [];
  const galaxyByPaperId = new Map<string, SkyGalaxy>();
  for (const galaxy of galaxies) {
    const members = galaxy.paperIds
      .map((id) => paperMeta.get(id))
      .filter((meta): meta is SkyPaperMeta => Boolean(meta));
    const years = members.map((meta) => meta.year).filter((year): year is number => Boolean(year));
    const minYear = years.length ? Math.min(...years) : 0;
    const maxYear = years.length ? Math.max(...years) : 0;
    const ordered = [...members].sort((left, right) =>
      right.centrality - left.centrality ||
      (left.year || 9999) - (right.year || 9999) ||
      left.id.localeCompare(right.id));
    let heatSum = 0;
    ordered.forEach((meta, rank) => {
      heatSum += meta.heat;
      const yearFraction = meta.year && maxYear > minYear ? (meta.year - minYear) / (maxYear - minYear) : 0.5;
      const local = orientOffset(
        starOffsetInGalaxy(galaxy.radius, rank, ordered.length, yearFraction, meta.id),
        galaxy.inclination,
        galaxy.positionAngle,
      );
      stars.push({
        id: meta.id,
        galaxyId: galaxy.id,
        position: [
          galaxy.position[0] + local[0],
          galaxy.position[1] + local[1],
          galaxy.position[2] + local[2],
        ],
        meta,
      });
      galaxyByPaperId.set(meta.id, galaxy);
    });
    galaxy.heat = ordered.length ? heatSum / ordered.length : 0;
  }

  // Citation flow between galaxies (bibliographic, not a scientific relation)
  // plus reviewed relation lanes.
  const flows = new Map<string, SkyFilament>();
  for (const edge of input.citationEdges) {
    const source = galaxyByPaperId.get(edge.source);
    const target = galaxyByPaperId.get(edge.target);
    if (!source || !target || source.id === target.id) continue;
    const key = [source.id, target.id].sort().join("--");
    const current = flows.get(key);
    if (current) current.weight += 1;
    else {
      flows.set(key, {
        id: `citation:${key}`,
        sourceGalaxyId: source.id,
        targetGalaxyId: target.id,
        kind: "citation",
        weight: 1,
      });
    }
  }
  const lanes = new Map<string, SkyFilament>();
  for (const lane of input.relationLanes) {
    const current = lanes.get(lane.key);
    const rank = { verified: 3, candidate: 2, unscored: 1, citation: 0 } as const;
    if (current) {
      current.weight += 1;
      if (rank[lane.state] > rank[current.kind]) current.kind = lane.state;
    } else {
      lanes.set(lane.key, {
        id: `relation:${lane.key}`,
        sourceGalaxyId: lane.sourceGalaxyId,
        targetGalaxyId: lane.targetGalaxyId,
        kind: lane.state,
        weight: 1,
        relationKey: lane.key,
      });
    }
  }

  const regionById = new Map(regions.map((region) => [region.id, region]));
  let extent = 4;
  for (const region of regions) extent = Math.max(extent, Math.hypot(...region.center) + region.radius);
  return {
    regions,
    galaxies,
    stars,
    filaments: [...flows.values(), ...lanes.values()],
    regionById,
    galaxyById: new Map(galaxies.map((galaxy) => [galaxy.id, galaxy])),
    starById: new Map(stars.map((star) => [star.id, star])),
    galaxyByPaperId,
    extent,
  };
}
