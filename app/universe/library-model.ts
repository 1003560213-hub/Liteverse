import type { Brief as Tier0Brief, LibraryAnalysis as Tier0Library } from "../../scripts/lib/liteverse-tier0.mjs";
import type { GalaxyHierarchy } from "./hierarchy";
import type { EvidenceTier, ProvisionalLayout, SkyPaperMeta } from "./sky/model";
import type { Paper, UniverseGraph } from "./types";
import type { LibraryItem, WorkspaceState } from "./workspace";

/**
 * One entry per paper the researcher can work with: reviewed graph papers
 * (Tier 1/2) and locally prepared, not-yet-reviewed library items (Tier 0).
 */
export type LibraryEntry = {
  id: string;
  kind: "paper" | "item";
  title: string;
  shortTitle: string;
  authors: string;
  year: number | null;
  tier: EvidenceTier;
  paper?: Paper;
  item?: LibraryItem;
  brief?: Tier0Brief;
  heat: number;
  centrality: number;
  regionLabel: string;
  galaxyId: string | null;
};

export const TIER_LABELS: Record<EvidenceTier, string> = {
  0: "Extracted",
  1: "Reviewed",
  2: "Verified",
};

export const TIER_DETAILS: Record<EvidenceTier, string> = {
  0: "Verbatim key points extracted locally. Not yet reviewed.",
  1: "AI-reviewed card draft. Evidence not yet original-page verified.",
  2: "Evidence verified against original PDF pages.",
};

export function tierForPaper(paper: Paper): EvidenceTier {
  return paper.verificationStatus === "evidence_verified" ? 2 : 1;
}

export function heatFor(count: number) {
  return Math.min(1, Math.log1p(Math.max(0, count)) / Math.log1p(32));
}

function shortTitleOf(title: string) {
  const clean = title.replace(/\s+/g, " ").trim();
  return clean.length > 64 ? `${clean.slice(0, 61).trimEnd()}…` : clean;
}

/** Library items that are prepared locally but not yet part of the graph. */
export function incomingItems(workspace: WorkspaceState, graph: UniverseGraph) {
  const graphIds = new Set(graph.papers.map((paper) => paper.id));
  return workspace.library.items.filter((item) =>
    item.catalogSource !== "universe" &&
    item.status !== "organized" &&
    item.disposition !== "duplicate" &&
    !(item.graphPaperId && graphIds.has(item.graphPaperId)) &&
    item.preparation?.state === "ready");
}

export function buildLibraryEntries(input: {
  graph: UniverseGraph;
  hierarchy: GalaxyHierarchy;
  workspace: WorkspaceState;
  briefs: ReadonlyMap<string, Tier0Brief>;
  library: Tier0Library | null;
  heatScope: "project" | "global";
}) {
  const { graph, hierarchy, workspace, briefs, library } = input;
  const categoryName = new Map(graph.categories.map((category) => [category.id, category.name]));
  const entries: LibraryEntry[] = [];
  for (const paper of graph.papers) {
    const count = input.heatScope === "project" ? workspace.projectUseCounts[paper.id] || 0 : paper.useCount || 0;
    entries.push({
      id: paper.id,
      kind: "paper",
      title: paper.title,
      shortTitle: paper.shortTitle || shortTitleOf(paper.title),
      authors: paper.authors,
      year: Number.isFinite(paper.year) ? paper.year : null,
      tier: tierForPaper(paper),
      paper,
      brief: briefs.get(paper.id),
      heat: heatFor(count),
      centrality: library?.inDegree?.[paper.id] || 0,
      regionLabel: categoryName.get(paper.primaryCategory) || "Unassigned",
      galaxyId: hierarchy.galaxyByPaperId.get(paper.id)?.id || null,
    });
  }
  for (const item of incomingItems(workspace, graph)) {
    const brief = briefs.get(item.id);
    const title = brief?.title || item.source?.catalogMetadata?.title || item.displayTitle;
    const authors = item.source?.catalogMetadata?.authors?.join(", ") || "";
    entries.push({
      id: item.id,
      kind: "item",
      title,
      shortTitle: shortTitleOf(title),
      authors,
      year: brief?.identity?.year ?? null,
      tier: 0,
      item,
      brief,
      heat: 0,
      centrality: library?.inDegree?.[item.id] || 0,
      regionLabel: "Incoming",
      galaxyId: null,
    });
  }
  return entries;
}

/**
 * Groups unreviewed papers into provisional regions and galaxies using the
 * Tier-0 clusters computed over the whole library, so an incoming paper lands
 * next to the material it shares references and vocabulary with.
 */
export function provisionalLayoutFor(
  entries: readonly LibraryEntry[],
  library: Tier0Library | null,
  chosenOption: { regions: Array<{ key: string; label: string; paperIds: string[] }> } | null,
): ProvisionalLayout {
  const incoming = entries.filter((entry) => entry.kind === "item");
  if (incoming.length === 0) return { regions: [], galaxies: [] };
  const incomingIds = new Set(incoming.map((entry) => entry.id));

  const coarse = new Map<string, { label: string; ids: string[] }>();
  if (chosenOption) {
    for (const region of chosenOption.regions) {
      const ids = region.paperIds.filter((id) => incomingIds.has(id));
      if (ids.length) coarse.set(region.key, { label: region.label, ids });
    }
  } else if (library?.clusters?.coarse) {
    const labels = library.clusters.coarse.labels || [];
    for (const id of incomingIds) {
      const index = library.clusters.coarse.assignment[id];
      if (index === undefined) continue;
      const key = `c${index}`;
      const group = coarse.get(key) || { label: labels[index] || `Cluster ${index + 1}`, ids: [] };
      group.ids.push(id);
      coarse.set(key, group);
    }
  }
  const assigned = new Set([...coarse.values()].flatMap((group) => group.ids));
  const leftovers = [...incomingIds].filter((id) => !assigned.has(id));
  if (leftovers.length) coarse.set("unsorted", { label: "Unsorted", ids: leftovers });

  const regions: ProvisionalLayout["regions"] = [];
  const galaxies: ProvisionalLayout["galaxies"] = [];
  const fine = library?.clusters?.fine;
  for (const [key, group] of coarse) {
    regions.push({ key, label: group.label, paperIds: group.ids });
    const byGalaxy = new Map<string, { label: string; ids: string[] }>();
    for (const id of group.ids) {
      const index = fine?.assignment?.[id];
      const galaxyKey = index === undefined ? `${key}:g` : `${key}:f${index}`;
      const label = index === undefined ? group.label : fine?.labels?.[index] || group.label;
      const bucket = byGalaxy.get(galaxyKey) || { label, ids: [] };
      bucket.ids.push(id);
      byGalaxy.set(galaxyKey, bucket);
    }
    // Keep at most twelve galaxies per region; merge the smallest into the largest.
    const ordered = [...byGalaxy.entries()].sort((left, right) => right[1].ids.length - left[1].ids.length);
    while (ordered.length > 12) {
      const [, smallest] = ordered.pop()!;
      ordered[0][1].ids.push(...smallest.ids);
    }
    for (const [galaxyKey, bucket] of ordered) {
      galaxies.push({ key: galaxyKey, regionKey: key, label: bucket.label, paperIds: bucket.ids });
    }
  }
  return { regions, galaxies };
}

export function skyMetaFor(entries: readonly LibraryEntry[]) {
  return new Map<string, SkyPaperMeta>(entries.map((entry) => [entry.id, {
    id: entry.id,
    title: entry.title,
    shortTitle: entry.shortTitle,
    year: entry.year,
    tier: entry.tier,
    heat: entry.heat,
    centrality: entry.centrality,
  }]));
}

/** Topological reading order of the in-library citation graph: cited work first. */
export function readingPath(
  memberIds: readonly string[],
  edges: ReadonlyArray<{ source: string; target: string }>,
  entries: ReadonlyMap<string, LibraryEntry>,
) {
  const members = new Set(memberIds);
  const prerequisites = new Map(memberIds.map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    if (members.has(edge.source) && members.has(edge.target) && edge.source !== edge.target) {
      prerequisites.get(edge.source)!.add(edge.target);
    }
  }
  const order: string[] = [];
  const placed = new Set<string>();
  const rank = (id: string) => {
    const entry = entries.get(id);
    return [entry?.year || 9999, -(entry?.centrality || 0), id] as const;
  };
  const compare = (left: string, right: string) => {
    const a = rank(left);
    const b = rank(right);
    return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
  };
  while (order.length < memberIds.length) {
    const ready = memberIds.filter((id) => !placed.has(id) && [...prerequisites.get(id)!].every((dependency) => placed.has(dependency)));
    // Break citation cycles deterministically by the earliest remaining paper.
    const next = (ready.length ? ready : memberIds.filter((id) => !placed.has(id))).sort(compare)[0];
    order.push(next);
    placed.add(next);
  }
  return order;
}
