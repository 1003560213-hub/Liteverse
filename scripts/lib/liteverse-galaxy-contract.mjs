export const GALAXY_HIERARCHY_SCHEMA = "liteverse-hierarchy-v1";
export const GALAXY_HIERARCHY_ALGORITHM = "deterministic-galaxy-routing-v2";
export const GALAXY_RELATION_PROJECTION = "galaxy-lanes-from-paper-relations-v1";
export const MAX_GALAXIES_PER_NEBULA = 12;
export const MIN_BLACK_HOLE_CLEARANCE = 1.38;
export const MIN_GALAXY_CENTER_SEPARATION = 0.98;
export const GALAXY_RING_RADII = Object.freeze([1.72, 2.8]);
export const GALAXY_RING_CAPACITIES = Object.freeze([4, 8]);

export const GALAXY_ASSET_IDS = Object.freeze([
  "01-grand-design-spiral-blue-gold.png",
  "02-barred-spiral-cyan-amber.png",
  "03-flocculent-spiral-silver-rose.png",
  "04-elliptical-golden-ivory.png",
  "05-lenticular-blue-gold.png",
  "06-ring-galaxy-violet-blue.png",
  "07-irregular-dwarf-blue-magenta.png",
  "08-interacting-pair-blue-copper.png",
  "09-starburst-red-orange.png",
  "10-seyfert-spiral-violet-copper.png",
]);

const GALAXY_ORBIT_Y_SCALE = 0.72;
const GALAXY_RING_DEPTH = Object.freeze([0.28, 0.46]);
const GALAXY_RING_RADIUS_TOLERANCE = 0.025;
const GENERIC_TAGS = new Set([
  "review",
  "simulation",
  "numerical methods",
  "analytic model",
  "structure formation",
]);

export function stableHierarchyHash(value) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function stableFraction(value) {
  return stableHierarchyHash(value) / 0xffffffff;
}

function stableToken(value) {
  const first = stableHierarchyHash(value).toString(16).padStart(8, "0");
  const second = stableHierarchyHash(`liteverse-secondary\0${[...value].reverse().join("")}`)
    .toString(16)
    .padStart(8, "0");
  return `${first}${second}`;
}

function isFiniteVector3(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function normalizedTag(tag) {
  return tag
    .normalize("NFKC")
    .trim()
    .replace(/[_–—]+/g, "-")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

function normalizedTags(paper) {
  return new Set((Array.isArray(paper.tags) ? paper.tags : [])
    .filter((tag) => typeof tag === "string")
    .map(normalizedTag)
    .filter(Boolean));
}

function normalizedPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value <= 1 ? value * 100 : value));
}

function relationDisplayState(relation) {
  const strength = normalizedPercent(relation?.strength);
  const confidence = normalizedPercent(relation?.confidence);
  if (strength === null || confidence === null) return "unscored";
  if (relation.formalEligible === false || relation.status === "suggestion") return "suggestion";
  if (relation.status === "verified") {
    return strength >= 60 && confidence >= 75 ? "verified" : "suggestion";
  }
  if (relation.status === "candidate") {
    return strength >= 40 && confidence >= 50 ? "candidate" : "suggestion";
  }
  if (strength >= 60 && confidence >= 75) return "verified";
  if (strength >= 40 && confidence >= 50) return "candidate";
  return "suggestion";
}

function relationRoutingWeight(relation) {
  const state = relationDisplayState(relation);
  if (state === "verified") return 1;
  if (state === "candidate") return 0.72;
  if (state === "suggestion") return 0.12;
  return 0.3;
}

function routingContext(papers, relations) {
  const tagsByPaper = new Map(papers.map((paper) => [paper.id, normalizedTags(paper)]));
  const relationWeights = new Map();
  const paperIds = new Set(papers.map((paper) => paper.id));
  for (const relation of Array.isArray(relations) ? relations : []) {
    if (!paperIds.has(relation.source) || !paperIds.has(relation.target)) continue;
    const key = [relation.source, relation.target].sort().join("\0");
    relationWeights.set(key, Math.max(relationWeights.get(key) ?? 0, relationRoutingWeight(relation)));
  }
  return { tagsByPaper, relationWeights };
}

// This score only routes paper stars into visual galaxies. It is never stored
// or presented as scientific relationship strength.
function routingAffinity(left, right, context) {
  if (left.id === right.id) return 1;
  const leftTags = context.tagsByPaper.get(left.id) ?? new Set();
  const rightTags = context.tagsByPaper.get(right.id) ?? new Set();
  const union = new Set([...leftTags, ...rightTags]);
  let overlap = 0;
  for (const tag of leftTags) if (rightTags.has(tag)) overlap += 1;
  const tagAffinity = union.size ? overlap / union.size : 0;
  const relationKey = [left.id, right.id].sort().join("\0");
  const relationAffinity = context.relationWeights.get(relationKey) ?? 0;
  return Math.min(1, tagAffinity * 0.62 + relationAffinity * 0.38);
}

export function targetGalaxyCount(paperCount) {
  if (!Number.isInteger(paperCount) || paperCount < 0) {
    throw new Error("paperCount must be a non-negative integer");
  }
  if (paperCount === 0) return 0;
  if (paperCount <= 3) return 1;
  return Math.min(MAX_GALAXIES_PER_NEBULA, Math.max(2, Math.ceil(paperCount / 5)));
}

function anchorRank(seed, categoryId, paperId) {
  return stableHierarchyHash(`${seed}\0${categoryId}\0anchor\0${paperId}`);
}

function chooseAnchors(categoryId, papers, count, context, seed) {
  const remaining = [...papers].sort((left, right) =>
    anchorRank(seed, categoryId, left.id) - anchorRank(seed, categoryId, right.id)
      || left.id.localeCompare(right.id));
  if (!remaining.length || count <= 0) return [];
  const anchors = [remaining.shift()];
  while (anchors.length < count && remaining.length) {
    remaining.sort((left, right) => {
      const leftDistance = 1 - Math.max(...anchors.map((anchor) => routingAffinity(left, anchor, context)));
      const rightDistance = 1 - Math.max(...anchors.map((anchor) => routingAffinity(right, anchor, context)));
      return rightDistance - leftDistance
        || anchorRank(seed, categoryId, left.id) - anchorRank(seed, categoryId, right.id)
        || left.id.localeCompare(right.id);
    });
    anchors.push(remaining.shift());
  }
  return anchors;
}

function bestGroup(paper, groups, context, seed, { preferSingleton = false } = {}) {
  return groups
    .map((group) => ({
      group,
      affinity: Math.max(...group.members.map((member) => routingAffinity(paper, member, context))),
    }))
    .sort((left, right) => {
      if (preferSingleton) {
        const singletonOrder = Number(left.group.members.length > 1) - Number(right.group.members.length > 1);
        if (singletonOrder) return singletonOrder;
      }
      return right.affinity - left.affinity
        || left.group.members.length - right.group.members.length
        || stableHierarchyHash(`${seed}\0${paper.id}\0${left.group.id}`)
          - stableHierarchyHash(`${seed}\0${paper.id}\0${right.group.id}`)
        || left.group.id.localeCompare(right.group.id);
    })[0]?.group;
}

function galaxyId(categoryId, seedPaperId) {
  return `galaxy-${stableToken(`${categoryId}\0${seedPaperId}`)}`;
}

function categoryOrigin(category, papers) {
  if (isFiniteVector3(category?.center)) return [...category.center];
  const positions = papers.map((paper) => paper.position).filter(isFiniteVector3);
  if (!positions.length) return [0, 0, 0];
  return [0, 1, 2].map((axis) =>
    positions.reduce((sum, position) => sum + position[axis], 0) / positions.length);
}

function positionCandidate(origin, categoryId, ringIndex, slotIndex, seed) {
  const capacity = GALAXY_RING_CAPACITIES[ringIndex];
  const radius = GALAXY_RING_RADII[ringIndex];
  const basePhase = stableFraction(`${seed}\0${categoryId}\0orbit-phase`) * Math.PI * 2;
  const stagger = ringIndex === 0 ? 0 : Math.PI / capacity;
  const angle = basePhase + stagger + slotIndex / capacity * Math.PI * 2;
  const depthPhase = stableFraction(`${seed}\0${categoryId}\0depth-phase`) * Math.PI * 2;
  const depth = Math.sin(angle * 2 + depthPhase) * GALAXY_RING_DEPTH[ringIndex];
  return [
    origin[0] + Math.cos(angle) * radius,
    origin[1] + Math.sin(angle) * radius * GALAXY_ORBIT_Y_SCALE,
    origin[2] + depth,
  ];
}

function squaredDistance(left, right) {
  return (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2;
}

export function blackHoleClearance(position, origin) {
  const deltaX = position[0] - origin[0];
  const deltaY = (position[1] - origin[1]) / GALAXY_ORBIT_Y_SCALE;
  return Math.hypot(deltaX, deltaY);
}

export function galaxyRingIndex(position, origin) {
  if (!isFiniteVector3(position) || !isFiniteVector3(origin)) return -1;
  const clearance = blackHoleClearance(position, origin);
  const nearest = GALAXY_RING_RADII
    .map((radius, ringIndex) => ({ ringIndex, difference: Math.abs(clearance - radius) }))
    .sort((left, right) => left.difference - right.difference || left.ringIndex - right.ringIndex)[0];
  return nearest && nearest.difference <= GALAXY_RING_RADIUS_TOLERANCE
    ? nearest.ringIndex
    : -1;
}

function nextGalaxyPosition(origin, categoryId, occupied, seed) {
  const minimumDistanceSquared = MIN_GALAXY_CENTER_SEPARATION ** 2;
  for (let ringIndex = 0; ringIndex < GALAXY_RING_CAPACITIES.length; ringIndex += 1) {
    const occupiedOnRing = occupied.filter((position) => galaxyRingIndex(position, origin) === ringIndex).length;
    if (occupiedOnRing >= GALAXY_RING_CAPACITIES[ringIndex]) continue;
    const candidates = Array.from(
      { length: GALAXY_RING_CAPACITIES[ringIndex] },
      (_, slotIndex) => ({
        position: positionCandidate(origin, categoryId, ringIndex, slotIndex, seed),
        slotIndex,
      }),
    ).filter(({ position }) =>
      !occupied.some((other) => squaredDistance(position, other) < 1e-10));
    if (!candidates.length) continue;
    const ranked = candidates
      .map(({ position, slotIndex }) => ({
        position,
        slotIndex,
        clearance: occupied.length
          ? Math.min(...occupied.map((other) => squaredDistance(position, other)))
          : Number.POSITIVE_INFINITY,
      }))
      .sort((left, right) => right.clearance - left.clearance || left.slotIndex - right.slotIndex);
    const collisionFree = ranked.find((candidate) => candidate.clearance >= minimumDistanceSquared);
    if (collisionFree) return collisionFree.position;
    throw new Error(`category ${categoryId} cannot fill orbit ring ${ringIndex} without a galaxy collision`);
  }
  throw new Error(`category ${categoryId} has no collision-free galaxy orbit slot`);
}

function assetOrder(seed) {
  return [...GALAXY_ASSET_IDS].sort((left, right) =>
    stableHierarchyHash(`${seed}\0global-galaxy-asset\0${left}`)
      - stableHierarchyHash(`${seed}\0global-galaxy-asset\0${right}`)
      || left.localeCompare(right));
}

function assignGalaxyAssets(galaxies, seed) {
  const orderedAssets = assetOrder(seed);
  const orderIndex = new Map(orderedAssets.map((assetId, index) => [assetId, index]));
  const existingCounts = new Map(orderedAssets.map((assetId) => [assetId, 0]));
  for (const galaxy of galaxies) {
    if (GALAXY_ASSET_IDS.includes(galaxy.assetId)) {
      existingCounts.set(galaxy.assetId, existingCounts.get(galaxy.assetId) + 1);
    }
  }
  const baseQuota = Math.floor(galaxies.length / orderedAssets.length);
  const remainder = galaxies.length % orderedAssets.length;
  const bonusAssets = new Set(
    [...orderedAssets]
      .sort((left, right) =>
        existingCounts.get(right) - existingCounts.get(left)
          || orderIndex.get(left) - orderIndex.get(right))
      .slice(0, remainder),
  );
  const quota = new Map(orderedAssets.map((assetId) => [
    assetId,
    baseQuota + (bonusAssets.has(assetId) ? 1 : 0),
  ]));
  const assignedCounts = new Map(orderedAssets.map((assetId) => [assetId, 0]));
  const assigned = new Map();

  // Preserve a valid previous choice whenever its balanced global quota still
  // has room. This keeps incremental Refresh stable without allowing early
  // artwork reuse to become permanent.
  for (const galaxy of galaxies) {
    if (!GALAXY_ASSET_IDS.includes(galaxy.assetId)) continue;
    if (assignedCounts.get(galaxy.assetId) >= quota.get(galaxy.assetId)) continue;
    assigned.set(galaxy.id, galaxy.assetId);
    assignedCounts.set(galaxy.assetId, assignedCounts.get(galaxy.assetId) + 1);
  }
  for (const galaxy of galaxies) {
    if (assigned.has(galaxy.id)) continue;
    const assetId = orderedAssets
      .filter((candidate) => assignedCounts.get(candidate) < quota.get(candidate))
      .sort((left, right) =>
        assignedCounts.get(left) - assignedCounts.get(right)
          || orderIndex.get(left) - orderIndex.get(right))[0];
    if (!assetId) throw new Error(`galaxy ${galaxy.id} has no balanced artwork assignment`);
    assigned.set(galaxy.id, assetId);
    assignedCounts.set(assetId, assignedCounts.get(assetId) + 1);
  }
  return galaxies.map((galaxy) => ({ ...galaxy, assetId: assigned.get(galaxy.id) }));
}

function titleCaseTag(tag) {
  const acronyms = new Map([
    ["f" + "dm", "F" + "DM"],
    ["u" + "ldm", "U" + "LDM"],
    ["s" + "f" + "dm", "S" + "F" + "DM"],
    ["sidm", "SIDM"],
    ["smbh", "SMBH"],
    ["gpp", "GPP"],
    ["gppe", "GPPE"],
    ["vlbi", "VLBI"],
    ["ggsl", "GGSL"],
    ["sp", "SP"],
    ["amr", "AMR"],
    ["bec", "BEC"],
  ]);
  return tag.split(/([\s/-]+)/).map((word) => {
    const lower = word.toLocaleLowerCase("en-US");
    if (acronyms.has(lower)) return acronyms.get(lower);
    if (!/[a-z]/i.test(word)) return word;
    return `${word.charAt(0).toLocaleUpperCase("en-US")}${word.slice(1)}`;
  }).join("");
}

function galaxyName(papers, fallbackIndex) {
  const counts = new Map();
  for (const paper of papers) {
    for (const rawTag of Array.isArray(paper.tags) ? paper.tags : []) {
      if (typeof rawTag !== "string") continue;
      const tag = normalizedTag(rawTag);
      if (!tag || GENERIC_TAGS.has(tag)) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0]));
  const first = ranked[0]?.[0];
  const second = ranked.find(([tag]) => {
    if (!first) return true;
    return !tag.includes(first) && !first.includes(tag);
  })?.[0];
  if (!first) return `Research Galaxy ${fallbackIndex + 1}`;
  return second ? `${titleCaseTag(first)} & ${titleCaseTag(second)}` : titleCaseTag(first);
}

function generatedGalaxy(category, seedPaper, origin, occupied, seed) {
  const id = galaxyId(category.id, seedPaper.id);
  return {
    id,
    categoryId: category.id,
    position: nextGalaxyPosition(origin, category.id, occupied, seed),
    seedPaperId: seedPaper.id,
  };
}

function freshGroups(category, papers, relations, seed) {
  const count = targetGalaxyCount(papers.length);
  const context = routingContext(papers, relations);
  const anchors = chooseAnchors(category.id, papers, count, context, seed);
  const origin = categoryOrigin(category, papers);
  const occupied = [];
  const groups = anchors.map((anchor) => {
    const record = generatedGalaxy(category, anchor, origin, occupied, seed);
    occupied.push(record.position);
    return { ...record, members: [anchor] };
  });
  const anchorIds = new Set(anchors.map((paper) => paper.id));
  const remaining = papers.filter((paper) => !anchorIds.has(paper.id));

  // Give every multi-galaxy group a companion before balancing the rest.
  for (const group of groups) {
    if (!remaining.length || groups.length === 1) break;
    remaining.sort((left, right) =>
      routingAffinity(right, group.members[0], context) - routingAffinity(left, group.members[0], context)
        || anchorRank(seed, category.id, left.id) - anchorRank(seed, category.id, right.id)
        || left.id.localeCompare(right.id));
    group.members.push(remaining.shift());
  }
  remaining.sort((left, right) => left.id.localeCompare(right.id));
  for (const paper of remaining) bestGroup(paper, groups, context, seed)?.members.push(paper);
  return groups;
}

function reusableGroups(previousGraph, category, papers) {
  if (!previousGraph || previousGraph.schemaVersion !== "3.0.0"
      || previousGraph.hierarchy?.algorithm !== GALAXY_HIERARCHY_ALGORITHM) return [];
  const nextPaperById = new Map(papers.map((paper) => [paper.id, paper]));
  const previousPapers = Array.isArray(previousGraph.papers) ? previousGraph.papers : [];
  const previousMembers = previousPapers.filter((paper) => paper.primaryCategory === category.id);
  if (previousMembers.some((paper) => !nextPaperById.has(paper.id))) return [];
  const previousAssignment = new Map(previousPapers.map((paper) => [paper.id, paper.galaxyId]));
  const origin = categoryOrigin(category, papers);
  const groups = [];
  for (const record of Array.isArray(previousGraph.galaxies) ? previousGraph.galaxies : []) {
    if (record?.categoryId !== category.id
        || typeof record.id !== "string"
        || typeof record.seedPaperId !== "string"
        || !nextPaperById.has(record.seedPaperId)
        || !isFiniteVector3(record.position)
        || blackHoleClearance(record.position, origin) < MIN_BLACK_HOLE_CLEARANCE
        || galaxyRingIndex(record.position, origin) < 0) continue;
    const members = papers.filter((paper) => previousAssignment.get(paper.id) === record.id);
    if (!members.some((paper) => paper.id === record.seedPaperId)) continue;
    groups.push({
      id: record.id,
      categoryId: record.categoryId,
      name: typeof record.name === "string" && record.name.trim() ? record.name : undefined,
      description: typeof record.description === "string" && record.description.trim()
        ? record.description
        : undefined,
      assetId: GALAXY_ASSET_IDS.includes(record.assetId) ? record.assetId : undefined,
      position: [...record.position],
      seedPaperId: record.seedPaperId,
      members,
    });
  }
  return groups.slice(0, MAX_GALAXIES_PER_NEBULA);
}

function incrementalGroups(previousGraph, category, papers, relations, seed) {
  const context = routingContext(papers, relations);
  const groups = reusableGroups(previousGraph, category, papers);
  if (!groups.length) return freshGroups(category, papers, relations, seed);
  const desired = Math.max(groups.length, targetGalaxyCount(papers.length));
  const assignedIds = new Set(groups.flatMap((group) => group.members.map((paper) => paper.id)));
  const unassigned = papers.filter((paper) => !assignedIds.has(paper.id));
  const origin = categoryOrigin(category, papers);
  const occupied = groups.map((group) => group.position);
  while (groups.length < Math.min(MAX_GALAXIES_PER_NEBULA, desired)) {
    let pool = unassigned;
    if (!pool.length) {
      const donor = [...groups]
        .filter((group) => group.members.length > 2)
        .sort((left, right) => right.members.length - left.members.length || left.id.localeCompare(right.id))[0];
      if (!donor) break;
      const movable = donor.members
        .filter((paper) => paper.id !== donor.seedPaperId)
        .sort((left, right) =>
          anchorRank(seed, category.id, left.id) - anchorRank(seed, category.id, right.id)
            || left.id.localeCompare(right.id))[0];
      donor.members = donor.members.filter((paper) => paper.id !== movable.id);
      unassigned.push(movable);
      pool = unassigned;
    }
    const anchors = groups
      .map((group) => papers.find((paper) => paper.id === group.seedPaperId))
      .filter(Boolean);
    pool.sort((left, right) => {
      const leftDistance = anchors.length ? 1 - Math.max(...anchors.map((anchor) => routingAffinity(left, anchor, context))) : 1;
      const rightDistance = anchors.length ? 1 - Math.max(...anchors.map((anchor) => routingAffinity(right, anchor, context))) : 1;
      return rightDistance - leftDistance
        || anchorRank(seed, category.id, left.id) - anchorRank(seed, category.id, right.id)
        || left.id.localeCompare(right.id);
    });
    const anchor = pool.shift();
    const record = generatedGalaxy(category, anchor, origin, occupied, seed);
    occupied.push(record.position);
    groups.push({ ...record, members: [anchor] });
  }

  unassigned.sort((left, right) => left.id.localeCompare(right.id));
  for (const paper of unassigned.splice(0)) {
    bestGroup(paper, groups, context, seed, { preferSingleton: true })?.members.push(paper);
  }
  for (const singleton of groups.filter((group) => group.members.length === 1)) {
    const donor = [...groups]
      .filter((group) => group.id !== singleton.id && group.members.length > 2)
      .sort((left, right) => right.members.length - left.members.length || left.id.localeCompare(right.id))[0];
    if (!donor) continue;
    const candidates = donor.members.filter((paper) => paper.id !== donor.seedPaperId);
    candidates.sort((left, right) =>
      routingAffinity(right, singleton.members[0], context) - routingAffinity(left, singleton.members[0], context)
        || left.id.localeCompare(right.id));
    const companion = candidates[0];
    if (!companion) continue;
    donor.members = donor.members.filter((paper) => paper.id !== companion.id);
    singleton.members.push(companion);
  }
  return groups;
}

function finalizeGroups(groups) {
  return groups
    .filter((group) => group.members.length)
    .slice(0, MAX_GALAXIES_PER_NEBULA)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((group, index) => {
      const members = [...group.members].sort((left, right) => left.id.localeCompare(right.id));
      const name = group.name || galaxyName(members, index);
      return {
        id: group.id,
        categoryId: group.categoryId,
        name,
        description: group.description
          || `${members.length} ${members.length === 1 ? "paper" : "papers"} organized by shared methods and scientific themes.`,
        position: [...group.position],
        assetId: group.assetId,
        seedPaperId: group.seedPaperId,
        paperIds: members.map((paper) => paper.id),
      };
    });
}

export function deriveGalaxyHierarchyRecords(graph, { previousGraph = graph } = {}) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    throw new Error("graph must be an object");
  }
  if (graph.schemaVersion !== "3.0.0") {
    return { galaxies: [], assignmentByPaperId: new Map(), seed: "" };
  }
  if (!Array.isArray(graph.categories) || !Array.isArray(graph.papers) || !Array.isArray(graph.relations)) {
    throw new Error("schema-v3 graph must contain categories, papers, and relations arrays");
  }
  const categoryIds = new Set(graph.categories.map((category) => category.id));
  for (const paper of graph.papers) {
    if (!categoryIds.has(paper.primaryCategory)) {
      throw new Error(`paper ${paper.id} has unknown primaryCategory ${paper.primaryCategory}`);
    }
  }
  const seed = graph.visuals?.galaxyAssignmentSeed
    ?? previousGraph?.visuals?.galaxyAssignmentSeed
    ?? `${graph.visuals?.nebulaAssignmentSeed ?? "liteverse-nebula-v1"}:galaxies-v1`;
  const papersByCategory = new Map(graph.categories.map((category) => [category.id, []]));
  for (const paper of graph.papers) papersByCategory.get(paper.primaryCategory).push(paper);
  const galaxies = [];
  const assignmentByPaperId = new Map();
  for (const category of graph.categories) {
    const papers = papersByCategory.get(category.id).sort((left, right) => left.id.localeCompare(right.id));
    if (!papers.length) continue;
    const paperIds = new Set(papers.map((paper) => paper.id));
    const relations = graph.relations.filter((relation) =>
      paperIds.has(relation.source) && paperIds.has(relation.target));
    const groups = incrementalGroups(previousGraph, category, papers, relations, seed);
    const records = finalizeGroups(groups);
    for (const record of records) {
      galaxies.push(record);
      for (const paperId of record.paperIds) {
        if (assignmentByPaperId.has(paperId)) {
          throw new Error(`paper ${paperId} was assigned to more than one galaxy`);
        }
        assignmentByPaperId.set(paperId, record.id);
      }
    }
  }
  if (assignmentByPaperId.size !== graph.papers.length) {
    const missing = graph.papers.find((paper) => !assignmentByPaperId.has(paper.id));
    throw new Error(`paper ${missing?.id ?? "<unknown>"} was not assigned to a galaxy`);
  }
  galaxies.sort((left, right) => left.id.localeCompare(right.id));
  return { galaxies: assignGalaxyAssets(galaxies, seed), assignmentByPaperId, seed };
}
