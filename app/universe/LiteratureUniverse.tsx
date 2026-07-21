"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import emptyUniverseData from "../../data/empty-universe.json";
import {
  SettingsDrawer,
  type ContextPack,
  type LibraryHealth,
  type LibraryItem,
  type LiteratureSearchPayload,
  type MemoryItem,
  type PartitionProposalSet,
  type SettingsTab,
  type WorkspaceHealth,
  type WorkspaceState,
} from "./SettingsDrawer";
import {
  isRelationScored,
  mergeUsageCounts,
  normalizePendingRefresh,
  normalizedPercent,
  paperCardPath,
  paperVerificationState,
  relationDisplayState,
  researchTextForSave,
  type Category,
  type NormalizedPendingRefresh,
  type Paper,
  type PaperIntegrityIssue,
  type PendingRefreshPayload,
  type Relation,
  type UniverseGraph,
  type UsageCounts,
} from "./types";
import { ZoomControl } from "./ZoomControl";
import {
  buildGalaxyHierarchy,
  memoriesByCategory,
  paperPositionInGalaxy,
  type Galaxy,
  type GalaxyRelationLane,
  type PersonalMemory,
} from "./hierarchy";
import { ScientificText } from "./ScientificText";
import {
  canActivateCanvasTarget,
  canvasBackAction,
  canvasViewLevel,
  cycleCanvasTarget,
  memoryOrbitAngle,
  sameCanvasTarget,
  type CanvasTarget,
} from "./canvas-navigation";

const FALLBACK_UNIVERSE = emptyUniverseData as unknown as UniverseGraph;
type Annotation = {
  id: string;
  paperId: string;
  paperTitle?: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  status: "pending" | "organized";
  revision: number;
  organizedAt?: string;
};
type DrawerTab = "summary" | "knowledge" | "notes" | "relations";
type KnowledgeCardSection = { id: string; title: string; content: string };
type KnowledgeCardEvidence = { id: string; locator?: string; text: string };
type KnowledgeCardPayload = {
  paperId: string;
  path: string;
  title?: string;
  sections: KnowledgeCardSection[];
  evidence: KnowledgeCardEvidence[];
  sourceSha256?: string;
  artifactSha256?: string;
  error?: string;
};
type SearchScope = "global" | "region";
type RelationLayerState = "verified" | "candidate" | "unscored";
type ProjectedStar = { id: string; x: number; y: number; radius: number };
type ProjectedGalaxy = { id: string; x: number; y: number; radius: number };
type ProjectedBlackHole = { categoryId: string; x: number; y: number; radius: number; enabled: boolean };
type ProjectedMemoryStar = { id: string; x: number; y: number; radius: number };
type ProjectedRegion = {
  id: string;
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  rotation: number;
};
type ProjectedRelation = {
  key: string;
  points: Array<{ x: number; y: number }>;
  hitWidth: number;
};
type RelationBundle = {
  key: string;
  source: string;
  target: string;
  relations: Relation[];
};
type GalaxyRelationBundle = {
  key: string;
  sourceGalaxyId: string;
  targetGalaxyId: string;
  lanes: GalaxyRelationLane[];
};
type HitTarget = CanvasTarget | null;
type CanvasKeyboardItem = {
  target: CanvasTarget;
  label: string;
};
type Vector3 = [number, number, number];
type CameraTransition = {
  fromCenter: Vector3;
  toCenter: Vector3;
  fromZoom: number;
  toZoom: number;
  startedAt: number;
};
type RefreshPhase = "idle" | "animating" | "committing" | "revealing";
type ActiveRefreshAnimation = {
  pending: NormalizedPendingRefresh;
  startedAt: number;
  staggerMs: number;
  waveDurationMs: number;
  reducedMotion: boolean;
  commitRequested: boolean;
};
type CommitReveal = {
  paperIds: Set<string>;
  relationIds: Set<string>;
  startedAt: number;
};

const DEFAULT_ROTATION = { x: -0.08, y: -0.22 } as const;
const DEFAULT_ZOOM = 1.08;
const REGION_FOCUS_ZOOM = 1.78;
const GALAXY_FOCUS_ZOOM = 2.62;
const BLACK_HOLE_FOCUS_ZOOM = 2.34;
const CAMERA_TRANSITION_MS = 620;
const INTERACTION_FPS = 30;
const IDLE_FPS = 12;
const BACKGROUND_FPS = 4;
const BENCHMARKED_PAPERS_PER_UNIVERSE = 1_000;
const ALL_NEBULA_MAX_RADIUS_RATIO = 0.155;
const ALL_NEBULA_MAX_RADIUS_PX = 154;
const ALL_NEBULA_MIN_RADIUS_PX = 52;
const FOCUSED_NEBULA_MAX_RADIUS_RATIO = 0.39;
const FOCUSED_NEBULA_MAX_RADIUS_PX = 360;
const NEBULA_VISUAL_BOUND_SCALE = 1.08;
const ALL_VIEW_AMBIENT_PAPERS_PER_NEBULA = 12;
const FOCUSED_AMBIENT_PAPERS_PER_NEBULA = 48;

type ScreenNebulaFrame = {
  center: { x: number; y: number };
  radius: number;
};

type NebulaClusterFrame = ScreenNebulaFrame & {
  rawRadius: number;
};

type ScreenSpatialPoint = {
  x: number;
  y: number;
};

type AmbientGalaxyGroup = {
  id: string;
  paperIds: readonly string[];
};

/**
 * Keeps every all-universe nebula inside a restrained screen-space footprint.
 * The default/reset camera layout has enough center separation for the minimum
 * radius and therefore guarantees a visible gap. An arbitrary 3D rotation can
 * project two world centers across one another; in that case both nebulae stay
 * usable at the minimum size and may overlap briefly instead of disappearing.
 * Only radii change: world identity, centers, depth, and hit order stay intact.
 */
export function constrainAllNebulaRadii<T extends ScreenNebulaFrame>(
  frames: readonly T[],
  viewportWidth: number,
  viewportHeight: number,
): Array<T & { radius: number }> {
  const viewportMinimum = Math.max(1, Math.min(viewportWidth, viewportHeight));
  const maximumRadius = Math.max(
    ALL_NEBULA_MIN_RADIUS_PX,
    Math.min(
      ALL_NEBULA_MAX_RADIUS_PX,
      viewportMinimum * ALL_NEBULA_MAX_RADIUS_RATIO,
    ),
  );
  const minimumRadius = ALL_NEBULA_MIN_RADIUS_PX;
  const visualGap = Math.min(18, Math.max(10, viewportMinimum * 0.016));
  const constrained: Array<T & { radius: number }> = frames.map((frame) => ({
    ...frame,
    radius: Math.max(minimumRadius, Math.min(frame.radius, maximumRadius)),
  }));

  for (let leftIndex = 0; leftIndex < constrained.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < constrained.length; rightIndex += 1) {
      const left = constrained[leftIndex];
      const right = constrained[rightIndex];
      const centerDistance = Math.hypot(
        right.center.x - left.center.x,
        right.center.y - left.center.y,
      );
      const maximumCombinedRadius = Math.max(
        0,
        (centerDistance - visualGap) / NEBULA_VISUAL_BOUND_SCALE,
      );
      const combinedRadius = left.radius + right.radius;
      if (combinedRadius <= maximumCombinedRadius || combinedRadius === 0) continue;
      const leftFlex = Math.max(0, left.radius - minimumRadius);
      const rightFlex = Math.max(0, right.radius - minimumRadius);
      const availableReduction = leftFlex + rightFlex;
      if (availableReduction === 0) continue;
      const requiredReduction = Math.min(
        combinedRadius - maximumCombinedRadius,
        availableReduction,
      );
      left.radius -= requiredReduction * (leftFlex / availableReduction);
      right.radius -= requiredReduction * (rightFlex / availableReduction);
    }
  }

  return constrained;
}

export function containPointInNebulaEllipse<T extends ScreenSpatialPoint>(
  point: T,
  frame: NebulaClusterFrame,
  radiusXRatio: number,
  radiusYRatio: number,
): T & { x: number; y: number } {
  const compression = Math.min(
    1,
    frame.radius / Math.max(1, frame.rawRadius),
  );
  let offsetX = (point.x - frame.center.x) * compression;
  let offsetY = (point.y - frame.center.y) * compression;
  const radiusX = Math.max(1, frame.radius * radiusXRatio);
  const radiusY = Math.max(1, frame.radius * radiusYRatio);
  const normalizedDistance = Math.hypot(offsetX / radiusX, offsetY / radiusY);
  if (normalizedDistance > 1) {
    offsetX /= normalizedDistance;
    offsetY /= normalizedDistance;
  }
  return {
    ...point,
    x: frame.center.x + offsetX,
    y: frame.center.y + offsetY,
  };
}

export function selectAmbientPaperIds(
  galaxies: readonly AmbientGalaxyGroup[],
  maximumCount: number,
) {
  if (maximumCount <= 0) return [];
  const selected = new Set<string>();
  const orderedGalaxies = [...galaxies].sort((left, right) =>
    left.id.localeCompare(right.id));
  for (const galaxy of orderedGalaxies) {
    const representative = [...galaxy.paperIds].sort(
      (left, right) =>
        stableHash(`${galaxy.id}:${left}:ambient-representative`) -
          stableHash(`${galaxy.id}:${right}:ambient-representative`) ||
        left.localeCompare(right),
    )[0];
    if (representative) selected.add(representative);
    if (selected.size >= maximumCount) return [...selected];
  }
  const remaining = orderedGalaxies
    .flatMap((galaxy) => galaxy.paperIds.map((paperId) => ({ galaxyId: galaxy.id, paperId })))
    .filter(({ paperId }) => !selected.has(paperId))
    .sort(
      (left, right) =>
        stableHash(`${left.galaxyId}:${left.paperId}:ambient-order`) -
          stableHash(`${right.galaxyId}:${right.paperId}:ambient-order`) ||
        left.paperId.localeCompare(right.paperId),
    );
  for (const { paperId } of remaining) {
    selected.add(paperId);
    if (selected.size >= maximumCount) break;
  }
  return [...selected];
}

function paperIntegrityIssue(
  paperId: string,
  health?: WorkspaceHealth,
): PaperIntegrityIssue | undefined {
  if (!health) return undefined;
  if (health.missingSourcePaperIds?.includes(paperId)) return "source_missing";
  if (health.hashMismatchPaperIds?.includes(paperId)) return "source_hash_mismatch";
  if (health.missingSourceHashPaperIds?.includes(paperId)) return "source_hash_missing";
  if (health.missingCardPaperIds?.includes(paperId)) return "card_missing";
  if (health.missingFulltextPaperIds?.includes(paperId)) return "fulltext_missing";
  return undefined;
}

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function resolveRegionNebulaAssignments(
  categories: readonly { id: string; nebulaAssetId?: string }[],
  assets: readonly { id: string; enabled: boolean }[],
  seed: string,
) {
  const enabledAssets = assets.filter((asset) => asset.enabled);
  const validIds = new Set(enabledAssets.map((asset) => asset.id));
  const assignments = new Map<string, string>();
  const usage = new Map(enabledAssets.map((asset) => [asset.id, 0]));

  for (const category of categories) {
    if (!category.nebulaAssetId || !validIds.has(category.nebulaAssetId)) continue;
    assignments.set(category.id, category.nebulaAssetId);
    if (usage.has(category.nebulaAssetId)) {
      usage.set(category.nebulaAssetId, (usage.get(category.nebulaAssetId) || 0) + 1);
    }
  }

  for (const category of categories) {
    if (assignments.has(category.id) || enabledAssets.length === 0) continue;
    const minimumUsage = Math.min(...usage.values());
    const candidates = enabledAssets
      .filter((asset) => usage.get(asset.id) === minimumUsage)
      .sort(
        (left, right) =>
          stableHash(`${seed}:${category.id}:${left.id}`) -
          stableHash(`${seed}:${category.id}:${right.id}`),
      );
    const selected = candidates[0];
    if (!selected) continue;
    assignments.set(category.id, selected.id);
    usage.set(selected.id, (usage.get(selected.id) || 0) + 1);
  }

  return assignments;
}

type LiteverseHostWindow = typeof window & {
  webkit?: {
    messageHandlers?: {
      liteverse?: { postMessage: (payload: unknown) => void };
    };
  };
  __liteverseReceiveAnnotations?: (items: Annotation[]) => void;
  __liteverseAnnotationSaved?: (id: string) => void;
  __liteverseReceiveWorkspace?: (workspace: WorkspaceState) => void;
  __liteverseReceiveWorkspaceHealth?: (health: WorkspaceHealth) => void;
  __liteverseWorkspaceExported?: (payload: { path: string }) => void;
  __liteverseWorkspaceImported?: (payload: { recoveryPath?: string; path?: string }) => void;
  __liteverseWorkspaceError?: (error: { action?: string; message: string }) => void;
  __liteverseReceiveKnowledgeCard?: (payload: KnowledgeCardPayload) => void;
  __liteverseReceiveLiteratureSearch?: (payload: LiteratureSearchPayload) => void;
  __liteverseReceiveLiteratureSearchError?: (payload: { requestId: string; message: string }) => void;
  __liteverseReceiveContextPreview?: (payload: ContextPack) => void;
  __liteverseReceiveContextPreviewError?: (payload: { requestId: string; message: string }) => void;
  __liteverseReceiveRegionDocument?: (payload: {
    projectId: string;
    memoryRevision: number;
    graphRevision: number;
    document: MemoryItem;
  }) => void;
  __liteverseReceiveUniverse?: (
    graph: UniverseGraph | { graph: UniverseGraph; usageCounts?: UsageCounts },
    usage?: UsageCounts,
  ) => void;
  __liteverseReceivePendingRefresh?: (payload: PendingRefreshPayload | null) => void;
  __liteverseRefreshCommitted?: (
    graph: UniverseGraph | { graph: UniverseGraph; usageCounts?: UsageCounts },
    usage?: UsageCounts,
  ) => void;
};

const EMPTY_WORKSPACE: WorkspaceState = {
  library: {
    schemaVersion: 1,
    nextNumber: 1,
    items: [],
  },
  researchInformation: {
    schemaVersion: 1,
    status: "empty",
    draft: { text: "", revision: 0, updatedAt: "" },
    formal: { text: "", sourceRevision: 0, organizedAt: "" },
  },
  projects: {
    schemaVersion: 1,
    activeProjectId: "project-default",
    items: [{ id: "project-default", name: "Default project" }],
  },
  projectMemory: { revision: 0, items: [] },
  tasks: [],
  contextPacks: [],
  contextPreview: null,
  artifacts: [],
  searchProjection: [],
  projectUseCounts: {},
  partitionProposals: null,
};

const relationLabels: Record<string, string> = {
  historical_predecessor: "Earlier work",
  method_context: "Method context",
  method_predecessor: "Method lineage",
  extends: "Extension",
  connects_initial_state_to_dynamics: "Initial state to dynamics",
  complements: "Complementary interpretation",
  supports: "Mutual support",
  cross_context_comparison: "Cross-context comparison",
  extends_to_self_interaction: "Extension to self-interaction",
  competing_growth_mechanism: "Competing mechanism",
  shared_merger_family: "Shared merger lineage",
  equilibrium_vs_remnant: "Equilibrium–remnant contrast",
};

function hexToRgba(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        lengthSquared,
    ),
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function relationStatusLabel(status: string) {
  if (status === "verified") return "Verified";
  if (status === "candidate") return "Candidate";
  if (status === "unscored" || status === "legacy_unscored") return "Unscored";
  if (status === "suggestion") return "Suggested";
  return "Project inference";
}

function normalizeArxivInput(value: string) {
  return value
    .trim()
    .replace(/^https:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/[?#].*$/, "");
}

function editableResearchText(research: WorkspaceState["researchInformation"]) {
  if (research.status === "organized" && research.formal.text) {
    return research.formal.text;
  }
  return research.draft.text || research.formal.text || "";
}

function normalizePartitionProposals(input: unknown): PartitionProposalSet | null {
  if (!input || typeof input !== "object") return null;
  const proposal = input as Partial<PartitionProposalSet>;
  if (
    proposal.schemaVersion !== "liteverse-partition-proposals-v1"
    || proposal.status !== "awaiting_user"
    || typeof proposal.proposalSetId !== "string"
    || !proposal.proposalSetId
    || (typeof proposal.baseRevision !== "number" && typeof proposal.baseRevision !== "string")
    || typeof proposal.artifactFingerprint !== "string"
    || !/^[a-f0-9]{64}$/i.test(proposal.artifactFingerprint)
    || typeof proposal.searchSummary !== "string"
    || !proposal.searchSummary
    || typeof proposal.truthPath !== "string"
    || !proposal.truthPath.startsWith("Planning/partition-proposals/")
    || typeof proposal.truthSha256 !== "string"
    || !/^[a-f0-9]{64}$/i.test(proposal.truthSha256)
    || !Array.isArray(proposal.options)
    || proposal.options.length !== 3
  ) return null;
  const validOptions = proposal.options.every((option) => (
    option
    && typeof option.optionId === "string"
    && Boolean(option.optionId)
    && typeof option.name === "string"
    && Boolean(option.name)
    && typeof option.summary === "string"
    && option.tradeoffs
    && Array.isArray(option.tradeoffs.strengths)
    && Array.isArray(option.tradeoffs.limitations)
    && Array.isArray(option.regions)
    && option.regions.length <= 10
    && Array.isArray(option.assignments)
    && option.metrics !== null
    && typeof option.metrics === "object"
    && !Array.isArray(option.metrics)
  ));
  return validOptions ? proposal as PartitionProposalSet : null;
}

function normalizeContextPreview(input: unknown): ContextPack | null {
  if (!input || typeof input !== "object") return null;
  const preview = input as Partial<ContextPack>;
  if (
    preview.schemaVersion !== "liteverse-context-preview-v1"
    || preview.contextKind !== "local_preview"
    || preview.adopted !== false
    || preview.usageRecorded !== false
    || preview.cacheOnly !== true
    || typeof preview.contextId !== "string"
    || !preview.contextId
    || typeof preview.requestId !== "string"
    || !preview.requestId
    || typeof preview.projectId !== "string"
    || !preview.projectId
    || typeof preview.query !== "string"
    || !preview.query
    || typeof preview.cachePath !== "string"
    || !preview.cachePath
    || !Array.isArray(preview.selectedClaims)
    || !Array.isArray(preview.projectMemory)
    || !Array.isArray(preview.conflicts)
    || !Array.isArray(preview.limitations)
  ) return null;
  return {
    ...preview,
    source: "local_preview",
    adoptionState: "not_adopted",
  } as ContextPack;
}

function normalizeWorkspaceState(input: Partial<WorkspaceState> | null | undefined): WorkspaceState {
  const projects = input?.projects;
  const activeProjectId = projects?.activeProjectId || "project-default";
  const contextPreview = normalizeContextPreview(input?.contextPreview);
  const projectItems = Array.isArray(projects?.items) && projects.items.length > 0
    ? projects.items
    : [{ id: activeProjectId, name: activeProjectId === "project-default" ? "Default project" : activeProjectId }];
  return {
    ...EMPTY_WORKSPACE,
    ...input,
    library: {
      ...EMPTY_WORKSPACE.library,
      ...(input?.library || {}),
      items: Array.isArray(input?.library?.items) ? input.library.items : [],
    },
    researchInformation: {
      ...EMPTY_WORKSPACE.researchInformation,
      ...(input?.researchInformation || {}),
      draft: {
        ...EMPTY_WORKSPACE.researchInformation.draft,
        ...(input?.researchInformation?.draft || {}),
      },
      formal: {
        ...EMPTY_WORKSPACE.researchInformation.formal,
        ...(input?.researchInformation?.formal || {}),
      },
    },
    projects: {
      schemaVersion: projects?.schemaVersion || 1,
      activeProjectId,
      items: projectItems,
    },
    projectMemory: {
      revision: input?.projectMemory?.revision || 0,
      items: Array.isArray(input?.projectMemory?.items) ? input.projectMemory.items : [],
    },
    tasks: Array.isArray(input?.tasks) ? input.tasks : [],
    contextPacks: Array.isArray(input?.contextPacks) ? input.contextPacks : [],
    contextPreview: contextPreview?.projectId === activeProjectId ? contextPreview : null,
    artifacts: Array.isArray(input?.artifacts) ? input.artifacts : [],
    searchProjection: Array.isArray(input?.searchProjection) ? input.searchProjection : [],
    projectUseCounts: input?.projectUseCounts && typeof input.projectUseCounts === "object"
      ? input.projectUseCounts
      : {},
    partitionProposals: normalizePartitionProposals(input?.partitionProposals),
  };
}

function dateLabel(timestamp: string) {
  const value = new Date(timestamp);
  if (!timestamp || Number.isNaN(value.getTime())) return "Time unknown";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function graphUpdatedTimestamp(updated: string) {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(updated)
    ? `${updated}T00:00:00+08:00`
    : updated;
  return Number.isNaN(new Date(normalized).getTime()) ? "" : normalized;
}

function relationEvidenceText(relation: Relation) {
  if (typeof relation.evidence === "string") return relation.evidence;
  if (!Array.isArray(relation.evidence) || relation.evidence.length === 0) {
    return "No source locator is available, so this relationship cannot be promoted to verified status.";
  }
  return relation.evidence
    .map((evidence) => {
      const locator = evidence.locator || {};
      const location = Object.entries(locator)
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([kind, value]) => `${kind} ${value}`)
        .join(" · ");
      return `[${evidence.id}] ${evidence.paperId}${location ? ` · ${location}` : ""} — ${evidence.paraphrase}`;
    })
    .join("\n");
}

function getNativeBridge() {
  if (typeof window === "undefined") return undefined;
  return (window as LiteverseHostWindow).webkit?.messageHandlers?.liteverse;
}

export function LiteratureUniverse() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const projectedStarsRef = useRef<ProjectedStar[]>([]);
  const projectedGalaxiesRef = useRef<ProjectedGalaxy[]>([]);
  const projectedBlackHolesRef = useRef<ProjectedBlackHole[]>([]);
  const projectedMemoryStarsRef = useRef<ProjectedMemoryStar[]>([]);
  const projectedRegionsRef = useRef<ProjectedRegion[]>([]);
  const projectedRelationsRef = useRef<ProjectedRelation[]>([]);
  const selectedPaperRef = useRef<string | null>(null);
  const selectedGalaxyRef = useRef<string | null>(null);
  const notesCategoryRef = useRef<string | null>(null);
  const selectedMemoryRef = useRef<string | null>(null);
  const selectedRelationRef = useRef<string | null>(null);
  const hoveredRef = useRef<HitTarget>(null);
  const universeRef = useRef<UniverseGraph>(FALLBACK_UNIVERSE);
  const visibleRef = useRef<Set<string>>(new Set());
  const heatRef = useRef<Record<string, number>>({});
  const categoryFilterRef = useRef("all");
  const galaxyRelationBundlesRef = useRef<GalaxyRelationBundle[]>([]);
  const projectMemoryRef = useRef<PersonalMemory[]>([]);
  const rotationRef = useRef<{ x: number; y: number }>({ ...DEFAULT_ROTATION });
  const zoomRef = useRef(DEFAULT_ZOOM);
  const cameraCenterRef = useRef<Vector3>([0, 0, 0]);
  const cameraTransitionRef = useRef<CameraTransition | null>(null);
  const pointerRef = useRef({ down: false, x: 0, y: 0, startX: 0, startY: 0, moved: false });
  const pendingPointerHitRef = useRef<{
    clientX: number;
    clientY: number;
    canvas: HTMLCanvasElement;
  } | null>(null);
  const pointerHitFrameRef = useRef(0);
  const requestRefreshCommitRef = useRef<(() => void) | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const researchDraftDirtyRef = useRef(false);
  const pendingWorkspaceActionRef = useRef<"pdf" | "folder" | "arxiv" | "research" | "memory-document" | null>(null);
  const refreshAnimationRef = useRef<ActiveRefreshAnimation | null>(null);
  const commitRevealRef = useRef<CommitReveal | null>(null);
  const universeRevisionRef = useRef<number | undefined>(FALLBACK_UNIVERSE.revision);
  const pendingRefreshIdRef = useRef<string | null>(null);
  const recoveryCommitRef = useRef<string | null>(null);
  const refreshErrorIdRef = useRef<string | null>(null);
  const lastCatalogSyncFingerprintRef = useRef<string | null>(null);
  const pendingAnnotationSaveRef = useRef<{
    previous: Annotation[];
    draft: string;
    editingId: string | null;
  } | null>(null);

  const [universe, setUniverse] = useState<UniverseGraph>(FALLBACK_UNIVERSE);
  const [pendingRefresh, setPendingRefresh] = useState<NormalizedPendingRefresh | null>(null);
  const [refreshPhase, setRefreshPhase] = useState<RefreshPhase>("idle");
  const [refreshError, setRefreshError] = useState("");
  const [runtimeError, setRuntimeError] = useState("");
  const [hasAuthoritativeGraph, setHasAuthoritativeGraph] = useState(false);
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);
  const [selectedGalaxyId, setSelectedGalaxyId] = useState<string | null>(null);
  const [notesCategoryId, setNotesCategoryId] = useState<string | null>(null);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [selectedRelationKey, setSelectedRelationKey] = useState<string | null>(null);
  const [hovered, setHovered] = useState<HitTarget>(null);
  const [keyboardFocus, setKeyboardFocus] = useState<HitTarget>(null);
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState<SearchScope>("global");
  const [relationLayers, setRelationLayers] = useState<Record<RelationLayerState, boolean>>({
    verified: true,
    candidate: true,
    unscored: true,
  });
  const [minimumRelationStrength, setMinimumRelationStrength] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("summary");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [annotationSaveState, setAnnotationSaveState] = useState<
    "idle" | "saving" | "saved"
  >("idle");
  const [annotationError, setAnnotationError] = useState("");
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_ZOOM);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequestedTab, setSettingsRequestedTab] = useState<SettingsTab>("literature");
  const [workspace, setWorkspace] = useState<WorkspaceState>(EMPTY_WORKSPACE);
  const [researchDraft, setResearchDraft] = useState("");
  const [workspaceBusyAction, setWorkspaceBusyAction] = useState<
    "pdf" | "folder" | "arxiv" | "research" | "memory-document" | null
  >(null);
  const [workspaceNotice, setWorkspaceNotice] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [heatScope, setHeatScope] = useState<"project" | "global">("project");
  const [knowledgeCard, setKnowledgeCard] = useState<KnowledgeCardPayload | null>(null);
  const [knowledgeCardLoading, setKnowledgeCardLoading] = useState(false);
  const [literatureSearch, setLiteratureSearch] = useState<LiteratureSearchPayload | null>(null);
  const [literatureSearchBusy, setLiteratureSearchBusy] = useState(false);
  const [literatureSearchError, setLiteratureSearchError] = useState("");
  const literatureSearchRequestRef = useRef<string | null>(null);
  const literatureSearchTimeoutRef = useRef<number | null>(null);
  const [localContextPreview, setLocalContextPreview] = useState<ContextPack | null>(null);
  const [contextPreviewBusy, setContextPreviewBusy] = useState(false);
  const [contextPreviewError, setContextPreviewError] = useState("");
  const contextPreviewRequestRef = useRef<string | null>(null);
  const contextPreviewProjectRef = useRef<string | null>(null);
  const contextPreviewTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const hostWindow = window as LiteverseHostWindow;
    const fallbackFrames: number[] = [];
    let externalStateTimer: number | undefined;
    let externalStatePollCount = 0;
    const receiveGraph = (
      input: UniverseGraph | { graph: UniverseGraph; usageCounts?: UsageCounts },
      usage?: UsageCounts,
    ) => {
      const envelope = input as { graph?: UniverseGraph; usageCounts?: UsageCounts };
      const nextGraph = envelope.graph || (input as UniverseGraph);
      const merged = mergeUsageCounts(nextGraph, usage || envelope.usageCounts);
      universeRevisionRef.current = merged.revision;
      setUniverse(merged);
      setHasAuthoritativeGraph(true);
      setRuntimeError("");
      setSelectedPaperId((selected) =>
        selected && merged.papers.some((paper) => paper.id === selected)
          ? selected
          : null,
      );
      const nextHierarchy = buildGalaxyHierarchy(merged);
      setSelectedGalaxyId((selected) =>
        selected && nextHierarchy.galaxyById.has(selected) ? selected : null,
      );
      setNotesCategoryId((selected) =>
        selected && merged.categories.some((category) => category.id === selected)
          ? selected
          : null,
      );
      setSelectedRelationKey((selected) => {
        if (!selected) return null;
        return nextHierarchy.relationLanes.some((lane) => lane.key === selected)
          ? selected
          : null;
      });
      setCategoryFilter((selected) =>
        selected === "all" || merged.categories.some((category) => category.id === selected)
          ? selected
          : "all",
      );
    };
    hostWindow.__liteverseReceiveUniverse = receiveGraph;
    hostWindow.__liteverseReceivePendingRefresh = (payload) => {
      const normalized = normalizePendingRefresh(payload);
      const currentRevision = universeRevisionRef.current ?? normalized?.baseRevision;
      if (normalized && normalized.baseRevision !== currentRevision) {
        if (normalized.targetRevision === currentRevision) {
          pendingRefreshIdRef.current = normalized.refreshId;
          setPendingRefresh(normalized);
          setRefreshPhase("committing");
          if (recoveryCommitRef.current !== normalized.refreshId) {
            recoveryCommitRef.current = normalized.refreshId;
            getNativeBridge()?.postMessage({
              action: "commitRefresh",
              refreshId: normalized.refreshId,
              baseRevision: normalized.baseRevision,
              snapshotSha256: normalized.snapshotSha256,
            });
          }
          return;
        }
        setRefreshError("The graph revision changed. The Refresh batch was preserved; curate it again before retrying.");
        refreshErrorIdRef.current = normalized.refreshId;
      }
      if (
        normalized &&
        refreshErrorIdRef.current &&
        refreshErrorIdRef.current !== normalized.refreshId
      ) {
        setRefreshError("");
        refreshErrorIdRef.current = null;
      }
      pendingRefreshIdRef.current = normalized?.refreshId || null;
      setPendingRefresh(normalized);
    };
    hostWindow.__liteverseRefreshCommitted = (input, usage) => {
      const active = refreshAnimationRef.current;
      receiveGraph(input, usage);
      if (active) {
        commitRevealRef.current = {
          paperIds: new Set(active.pending.newPaperIds),
          relationIds: new Set(active.pending.newRelationIds),
          startedAt: performance.now(),
        };
      }
      refreshAnimationRef.current = null;
      pendingRefreshIdRef.current = null;
      recoveryCommitRef.current = null;
      setPendingRefresh(null);
      setRefreshError("");
      refreshErrorIdRef.current = null;
      setRefreshPhase("revealing");
      window.setTimeout(() => {
        commitRevealRef.current = null;
        setRefreshPhase("idle");
      }, 950);
    };
    hostWindow.__liteverseReceiveAnnotations = (items) => {
      setAnnotations(items);
      window.localStorage.setItem("liteverse-annotations-cache", JSON.stringify(items));
    };
    hostWindow.__liteverseAnnotationSaved = () => {
      pendingAnnotationSaveRef.current = null;
      setAnnotationError("");
      setAnnotationSaveState("saved");
      window.setTimeout(() => setAnnotationSaveState("idle"), 1600);
    };
    hostWindow.__liteverseReceiveWorkspace = (rawWorkspace) => {
      const nextWorkspace = normalizeWorkspaceState(rawWorkspace);
      const pendingAction = pendingWorkspaceActionRef.current;
      setWorkspace(nextWorkspace);
      if (nextWorkspace.contextPreview) {
        setLocalContextPreview((current) => {
          if (
            current
            && current.projectId === nextWorkspace.contextPreview?.projectId
            && (current.createdAt || "") > (nextWorkspace.contextPreview?.createdAt || "")
          ) return current;
          return nextWorkspace.contextPreview || null;
        });
      }
      setWorkspaceBusyAction(null);
      pendingWorkspaceActionRef.current = null;
      setWorkspaceError("");
      setWorkspaceNotice(nextWorkspace.notice || "");
      if (!researchDraftDirtyRef.current || pendingAction === "research") {
        setResearchDraft(editableResearchText(nextWorkspace.researchInformation));
      }
      if (pendingAction === "research") researchDraftDirtyRef.current = false;
      window.localStorage.setItem(
        "liteverse-workspace-cache",
        JSON.stringify({ ...nextWorkspace, notice: undefined }),
      );
    };
    hostWindow.__liteverseReceiveKnowledgeCard = (payload) => {
      setKnowledgeCard(payload);
      setKnowledgeCardLoading(false);
    };
    hostWindow.__liteverseReceiveRegionDocument = (payload) => {
      const memoryId = payload.document.memoryId || payload.document.id;
      if (!memoryId) return;
      setWorkspace((current) => {
        if (current.projects.activeProjectId !== payload.projectId) return current;
        const existing = current.projectMemory.items.some(
          (item) => (item.memoryId || item.id) === memoryId,
        );
        return {
          ...current,
          projectMemory: {
            revision: payload.memoryRevision,
            items: existing
              ? current.projectMemory.items.map((item) =>
                  (item.memoryId || item.id) === memoryId ? payload.document : item)
              : [...current.projectMemory.items, payload.document],
          },
        };
      });
      setSelectedMemoryId(memoryId);
    };
    hostWindow.__liteverseReceiveLiteratureSearch = (payload) => {
      if (payload.requestId !== literatureSearchRequestRef.current) return;
      if (literatureSearchTimeoutRef.current !== null) {
        window.clearTimeout(literatureSearchTimeoutRef.current);
        literatureSearchTimeoutRef.current = null;
      }
      setLiteratureSearch(payload);
      setLiteratureSearchBusy(false);
      setLiteratureSearchError("");
    };
    hostWindow.__liteverseReceiveLiteratureSearchError = (payload) => {
      if (payload.requestId !== literatureSearchRequestRef.current) return;
      if (literatureSearchTimeoutRef.current !== null) {
        window.clearTimeout(literatureSearchTimeoutRef.current);
        literatureSearchTimeoutRef.current = null;
      }
      setLiteratureSearchBusy(false);
      setLiteratureSearchError(payload.message || "The local literature index is unavailable. Run `liteverse index rebuild` and try again.");
    };
    hostWindow.__liteverseReceiveContextPreview = (payload) => {
      if (payload.requestId !== contextPreviewRequestRef.current) return;
      const expectedProjectId = contextPreviewProjectRef.current;
      if (contextPreviewTimeoutRef.current !== null) {
        window.clearTimeout(contextPreviewTimeoutRef.current);
        contextPreviewTimeoutRef.current = null;
      }
      contextPreviewRequestRef.current = null;
      contextPreviewProjectRef.current = null;
      const preview = normalizeContextPreview(payload);
      if (!preview || preview.projectId !== expectedProjectId) {
        setContextPreviewBusy(false);
        setContextPreviewError("The local preview response was incomplete and was not displayed.");
        return;
      }
      setLocalContextPreview(preview);
      setWorkspace((current) => ({ ...current, contextPreview: preview }));
      setContextPreviewBusy(false);
      setContextPreviewError("");
    };
    hostWindow.__liteverseReceiveContextPreviewError = (payload) => {
      if (payload.requestId !== contextPreviewRequestRef.current) return;
      if (contextPreviewTimeoutRef.current !== null) {
        window.clearTimeout(contextPreviewTimeoutRef.current);
        contextPreviewTimeoutRef.current = null;
      }
      contextPreviewRequestRef.current = null;
      contextPreviewProjectRef.current = null;
      setContextPreviewBusy(false);
      setContextPreviewError(payload.message || "The local context preview could not be built.");
    };
    hostWindow.__liteverseReceiveWorkspaceHealth = (health) => {
      setWorkspace((current) => ({ ...current, health }));
    };
    hostWindow.__liteverseWorkspaceExported = (payload) => {
      setWorkspaceError("");
      setWorkspaceNotice(`Workspace backup exported: ${payload.path}`);
    };
    hostWindow.__liteverseWorkspaceImported = (payload) => {
      setWorkspaceError("");
      setWorkspaceNotice(`Backup verified and imported into the recovery area: ${payload.recoveryPath || payload.path || "Recovered"}`);
    };
    hostWindow.__liteverseWorkspaceError = (nativeError) => {
      if (nativeError.action === "buildContextPreview") {
        if (contextPreviewTimeoutRef.current !== null) {
          window.clearTimeout(contextPreviewTimeoutRef.current);
          contextPreviewTimeoutRef.current = null;
        }
        contextPreviewRequestRef.current = null;
        contextPreviewProjectRef.current = null;
        setContextPreviewBusy(false);
        setContextPreviewError(nativeError.message || "The local context preview could not be built.");
        return;
      }
      pendingWorkspaceActionRef.current = null;
      setWorkspaceBusyAction(null);
      setWorkspaceError(nativeError.message || "The local data operation failed. Try again shortly.");
      if (nativeError.action === "loadUniverse") {
        setHasAuthoritativeGraph(false);
        setRuntimeError(nativeError.message || "The runtime graph could not be read. Library writes have been stopped.");
      }
      if (nativeError.action === "saveAnnotation") {
        const pendingSave = pendingAnnotationSaveRef.current;
        if (pendingSave) {
          setAnnotations(pendingSave.previous);
          setAnnotationDraft(pendingSave.draft);
          setEditingAnnotationId(pendingSave.editingId);
          window.localStorage.setItem(
            "liteverse-annotations-cache",
            JSON.stringify(pendingSave.previous),
          );
        }
        pendingAnnotationSaveRef.current = null;
        setAnnotationSaveState("idle");
        setAnnotationError(nativeError.message || "This annotation changed since it was opened. Review it and save again.");
        getNativeBridge()?.postMessage({ action: "loadAnnotations" });
      }
      if (nativeError.action === "loadKnowledgeCard") {
        setKnowledgeCardLoading(false);
        setKnowledgeCard((current) => ({
          paperId: current?.paperId || selectedPaperRef.current || "unknown",
          path: current?.path || "",
          sections: [],
          evidence: [],
          error: nativeError.message || "The knowledge card could not be read.",
        }));
      }
      if (nativeError.action === "commitRefresh") {
        refreshAnimationRef.current = null;
        recoveryCommitRef.current = null;
        setRefreshError(nativeError.message || "Graph validation failed. Please try again.");
        refreshErrorIdRef.current = pendingRefreshIdRef.current;
        setRefreshPhase("idle");
      }
    };

    const bridge = getNativeBridge();
    if (bridge) {
      bridge.postMessage({ action: "loadUniverse" });
      bridge.postMessage({ action: "observePendingRefresh" });
      bridge.postMessage({ action: "loadAnnotations" });
      bridge.postMessage({ action: "loadWorkspace" });
      externalStateTimer = window.setInterval(() => {
        externalStatePollCount += 1;
        // Retry both observers explicitly: vnode setup can fail on some file
        // systems, while these idempotent reads keep Refresh and integrity
        // state live without re-registering React callbacks.
        bridge.postMessage({ action: "observePendingRefresh" });
        bridge.postMessage({ action: "loadWorkspaceHealth" });
        bridge.postMessage({ action: "loadAnnotations" });
        if (externalStatePollCount % 2 === 0) {
          bridge.postMessage({ action: "loadWorkspace" });
        }
        // Usage is injected by loadUniverse. Refresh it less frequently than
        // health so an unchanged graph does not cause a visible state loop.
        if (externalStatePollCount % 4 === 0) {
          bridge.postMessage({ action: "loadUniverse" });
        }
      }, 30_000);
    } else {
      fallbackFrames.push(window.requestAnimationFrame(() => {
        setHasAuthoritativeGraph(true);
      }));
      const cached = window.localStorage.getItem("liteverse-annotations-cache");
      if (cached) {
        try {
          const restoredAnnotations: Annotation[] = JSON.parse(cached);
          fallbackFrames.push(window.requestAnimationFrame(() => {
            setAnnotations(restoredAnnotations);
          }));
        } catch {
          window.localStorage.removeItem("liteverse-annotations-cache");
        }
      }
      const cachedWorkspace = window.localStorage.getItem("liteverse-workspace-cache");
      if (cachedWorkspace) {
        try {
          const restoredWorkspace = normalizeWorkspaceState(JSON.parse(cachedWorkspace));
          fallbackFrames.push(window.requestAnimationFrame(() => {
            setWorkspace(restoredWorkspace);
            setLocalContextPreview(restoredWorkspace.contextPreview || null);
            setResearchDraft(
              editableResearchText(restoredWorkspace.researchInformation),
            );
          }));
        } catch {
          window.localStorage.removeItem("liteverse-workspace-cache");
        }
      }
    }

    return () => {
      fallbackFrames.forEach((frame) => window.cancelAnimationFrame(frame));
      if (externalStateTimer !== undefined) window.clearInterval(externalStateTimer);
      delete hostWindow.__liteverseReceiveAnnotations;
      delete hostWindow.__liteverseAnnotationSaved;
      delete hostWindow.__liteverseReceiveWorkspace;
      delete hostWindow.__liteverseReceiveWorkspaceHealth;
      delete hostWindow.__liteverseWorkspaceExported;
      delete hostWindow.__liteverseWorkspaceImported;
      delete hostWindow.__liteverseWorkspaceError;
      delete hostWindow.__liteverseReceiveKnowledgeCard;
      delete hostWindow.__liteverseReceiveLiteratureSearch;
      delete hostWindow.__liteverseReceiveLiteratureSearchError;
      delete hostWindow.__liteverseReceiveContextPreview;
      delete hostWindow.__liteverseReceiveContextPreviewError;
      delete hostWindow.__liteverseReceiveRegionDocument;
      delete hostWindow.__liteverseReceiveUniverse;
      delete hostWindow.__liteverseReceivePendingRefresh;
      delete hostWindow.__liteverseRefreshCommitted;
      if (literatureSearchTimeoutRef.current !== null) {
        window.clearTimeout(literatureSearchTimeoutRef.current);
        literatureSearchTimeoutRef.current = null;
      }
      if (contextPreviewTimeoutRef.current !== null) {
        window.clearTimeout(contextPreviewTimeoutRef.current);
        contextPreviewTimeoutRef.current = null;
      }
      contextPreviewRequestRef.current = null;
      contextPreviewProjectRef.current = null;
    };
  }, []);

  const categoryById = useMemo(
    () => new Map(universe.categories.map((category) => [category.id, category])),
    [universe.categories],
  );
  const macroCategories = useMemo(
    () => universe.categories.filter((category) => category.kind !== "system"),
    [universe.categories],
  );
  const paperById = useMemo(
    () => new Map(universe.papers.map((paper) => [paper.id, paper])),
    [universe.papers],
  );
  const galaxyHierarchy = useMemo(() => buildGalaxyHierarchy(universe), [universe]);
  const selectedGalaxy = selectedGalaxyId
    ? galaxyHierarchy.galaxyById.get(selectedGalaxyId) || null
    : null;
  const projectMemoriesByCategory = useMemo(
    () => memoriesByCategory(
      workspace.projectMemory.items as PersonalMemory[],
      macroCategories,
      universe.papers,
    ),
    [macroCategories, universe.papers, workspace.projectMemory.items],
  );
  const selectedMemory = selectedMemoryId
    ? (workspace.projectMemory.items as PersonalMemory[]).find(
        (item) => (item.memoryId || item.id) === selectedMemoryId,
      ) || null
    : null;
  const viewLevel = canvasViewLevel({
    categoryFilter,
    selectedGalaxyId,
    notesCategoryId,
  });

  const visibleLiteratureSearch = useMemo<LiteratureSearchPayload | null>(() => {
    if (!literatureSearch) return null;
    return {
      ...literatureSearch,
      results: literatureSearch.results.map((paper) => ({
        ...paper,
        inCurrentGraph: paperById.has(paper.paperId),
      })),
    };
  }, [literatureSearch, paperById]);
  const getCategory = useCallback(
    (id: string) => categoryById.get(id) || universe.categories[0]!,
    [categoryById, universe.categories],
  );
  const getPaper = useCallback(
    (id: string) => paperById.get(id) || universe.papers[0]!,
    [paperById, universe.papers],
  );
  const renderResourceFingerprint = useMemo(
    () => JSON.stringify({
      categories: universe.categories.map((category) => ({
        id: category.id,
        name: category.name,
        color: category.color,
        center: category.center,
        nebulaAssetId: category.nebulaAssetId,
      })),
      papers: universe.papers.map((paper) => ({
        id: paper.id,
        shortTitle: paper.shortTitle,
        primaryCategory: paper.primaryCategory,
        categoryIds: paper.categoryIds,
        position: paper.position,
        galaxyId: paper.galaxyId,
      })),
      galaxies: universe.galaxies,
      hierarchy: universe.hierarchy,
      visuals: universe.visuals,
      projectMemory: workspace.projectMemory.items.map((item) => ({
        id: item.memoryId || item.id,
        state: item.state,
        updatedAt: item.updatedAt,
        categoryId: (item as PersonalMemory).scope?.categoryId ||
          (item as PersonalMemory).scope?.regionId ||
          (item as PersonalMemory).source?.categoryId ||
          (item as PersonalMemory).source?.regionId,
      })),
    }),
    [universe.categories, universe.galaxies, universe.hierarchy, universe.papers, universe.visuals, workspace.projectMemory.items],
  );

  const heatByPaper = useMemo(
    () =>
      Object.fromEntries(
        universe.papers.map((paper) => [
          paper.id,
          Math.min(
            1,
            Math.log1p(Math.max(
              0,
              heatScope === "project"
                ? workspace.projectUseCounts[paper.id] || 0
                : paper.useCount || 0,
            )) / Math.log1p(32),
          ),
        ]),
      ),
    [heatScope, universe.papers, workspace.projectUseCounts],
  );

  const catalogLibraryItems = useMemo<LibraryItem[]>(
    () => {
      const graphTimestamp = graphUpdatedTimestamp(universe.updated);
      return universe.papers.map((paper, index) => {
        const verification = paperVerificationState(
          paper,
          paperIntegrityIssue(paper.id, workspace.health),
        );
        return {
          id: `catalog-${paper.id}`,
          number: index + 1,
          sourceType: "pdf",
          displayTitle: paper.title,
          titleStatus: verification.tone === "verified" ? "codex_verified" : "filename_guess",
          status: verification.tone === "attention" ? "needs_attention" : "organized",
          revision: universe.revision || 1,
          createdAt: graphTimestamp,
          updatedAt: graphTimestamp,
          organizedAt: graphTimestamp,
          graphPaperId: paper.id,
          catalogSource: "universe",
          localPath: paper.source?.pdfPath || paper.pdfPath,
          citekey: paper.citekey,
          verificationLabel: verification.label,
          verificationTone: verification.tone,
          verificationDetail: verification.detail,
        };
      });
    },
    [universe.papers, universe.revision, universe.updated, workspace.health],
  );

  // Keep the native catalog synchronization independent from presentation-only
  // health data. Workspace health includes a fresh checkedAt timestamp, so
  // using catalogLibraryItems directly here used to create a feedback loop:
  // native workspace update -> new health object -> syncCatalog -> file write
  // -> native workspace update. Besides the frontend fingerprint guard below,
  // the native bridge also treats an identical catalog as a no-op.
  const catalogSyncItems = useMemo(
    () => {
      const graphTimestamp = graphUpdatedTimestamp(universe.updated);
      return universe.papers.map((paper, index) => ({
        id: `catalog-${paper.id}`,
        number: index + 1,
        sourceType: paper.source?.kind || "pdf",
        displayTitle: paper.title,
        titleStatus:
          paper.verificationStatus === "evidence_verified"
            ? "codex_verified"
            : "filename_guess",
        status:
          paper.verificationStatus === "needs_attention"
            ? "needs_attention"
            : "organized",
        revision: universe.revision || 1,
        createdAt: graphTimestamp,
        updatedAt: graphTimestamp,
        organizedAt: graphTimestamp,
        graphPaperId: paper.id,
        catalogSource: "universe",
        localPath: paper.source?.pdfPath || paper.pdfPath,
        citekey: paper.citekey,
        verificationStatus: paper.verificationStatus || "card_draft",
        source: paper.source || {
          kind: "pdf",
          pdfPath: paper.pdfPath,
        },
        artifacts: paper.artifacts || {
          cardPath: paper.markdownPath,
          fulltextPath: paper.fulltextPath,
        },
      }));
    },
    [universe.papers, universe.revision, universe.updated],
  );

  const settingsWorkspace = useMemo<WorkspaceState>(() => {
    const catalogPaperIds = new Set(
      catalogLibraryItems.map((item) => item.graphPaperId),
    );
    return {
      ...workspace,
      library: {
        ...workspace.library,
        items: [
          ...catalogLibraryItems,
          ...workspace.library.items.filter(
            (item) =>
              item.catalogSource !== "universe" ||
              item.status !== "organized" ||
              !item.graphPaperId ||
              !catalogPaperIds.has(item.graphPaperId),
          ),
        ],
      },
    };
  }, [catalogLibraryItems, workspace]);

  useEffect(() => {
    const bridge = getNativeBridge();
    if (!bridge || !hasAuthoritativeGraph) return;
    const fingerprint = JSON.stringify(catalogSyncItems);
    if (lastCatalogSyncFingerprintRef.current === fingerprint) return;
    lastCatalogSyncFingerprintRef.current = fingerprint;
    bridge.postMessage({ action: "syncCatalog", items: catalogSyncItems });
  }, [catalogSyncItems, hasAuthoritativeGraph]);

  const relationBundles = useMemo(() => {
    const groups = new Map<string, RelationBundle>();
    for (const relation of universe.relations) {
      const displayState = relationDisplayState(relation);
      const strength = normalizedPercent(relation.strength) || 0;
      if (
        displayState === "suggestion" ||
        !relationLayers[displayState] ||
        (displayState !== "unscored" && strength < minimumRelationStrength) ||
        !paperById.has(relation.source) ||
        !paperById.has(relation.target)
      ) {
        continue;
      }
      const key = [relation.source, relation.target].sort().join("--");
      const current = groups.get(key);
      if (current) current.relations.push(relation);
      else {
        groups.set(key, {
          key,
          source: relation.source,
          target: relation.target,
          relations: [relation],
        });
      }
    }
    return [...groups.values()];
  }, [
    minimumRelationStrength,
    paperById,
    relationLayers,
    universe.relations,
  ]);

  const galaxyRelationBundles = useMemo(() => {
    const groups = new Map<string, GalaxyRelationBundle>();
    for (const lane of galaxyHierarchy.relationLanes) {
      const displayState = relationDisplayState(lane.relation);
      const strength = normalizedPercent(lane.relation.strength) || 0;
      if (
        displayState === "suggestion" ||
        !relationLayers[displayState] ||
        (displayState !== "unscored" && strength < minimumRelationStrength)
      ) continue;
      const current = groups.get(lane.key);
      if (current) current.lanes.push(lane);
      else groups.set(lane.key, {
        key: lane.key,
        sourceGalaxyId: lane.sourceGalaxyId,
        targetGalaxyId: lane.targetGalaxyId,
        lanes: [lane],
      });
    }
    return [...groups.values()];
  }, [
    galaxyHierarchy.relationLanes,
    minimumRelationStrength,
    relationLayers,
  ]);

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return universe.papers.filter((paper) => {
      const categoryMatch =
        searchScope === "global" ||
        categoryFilter === "all" ||
        paper.primaryCategory === categoryFilter;
      const searchable = [
        paper.title,
        paper.shortTitle,
        paper.authors,
        paper.summary,
        paper.projectRole,
        ...paper.tags,
      ]
        .join(" ")
        .toLowerCase();
      return categoryMatch && (!normalized || searchable.includes(normalized));
    });
  }, [categoryFilter, query, searchScope, universe.papers]);

  const visiblePapers = useMemo(() => {
    if (!selectedGalaxy) return [];
    const galaxyPaperIds = new Set(selectedGalaxy.paperIds);
    const normalized = query.trim().toLowerCase();
    return universe.papers.filter((paper) => {
      if (!galaxyPaperIds.has(paper.id)) return false;
      if (!normalized || searchScope === "global") return true;
      const searchable = [
        paper.title,
        paper.shortTitle,
        paper.authors,
        paper.summary,
        paper.projectRole,
        ...paper.tags,
      ].join(" ").toLowerCase();
      return searchable.includes(normalized);
    });
  }, [query, searchScope, selectedGalaxy, universe.papers]);

  const libraryHealth = useMemo<LibraryHealth>(() => {
    const verificationStates = universe.papers.map((paper) => paperVerificationState(
      paper,
      paperIntegrityIssue(paper.id, workspace.health),
    ));
    const relationStates = universe.relations.map(relationDisplayState);
    const pendingLibrary = workspace.library.items.filter(
      (item) => item.catalogSource !== "universe",
    );
    return {
      totalPapers: universe.papers.length,
      evidenceVerified: verificationStates.filter((state) => state.tone === "verified").length,
      draftPapers: verificationStates.filter((state) => state.tone === "draft" || state.tone === "progress").length,
      needsAttention: verificationStates.filter((state) => state.tone === "attention").length,
      pendingCodex: pendingLibrary.filter((item) => item.status === "pending_codex" || item.status === "processing").length,
      readyToRefresh: pendingLibrary.filter((item) => item.status === "ready_to_refresh").length,
      pendingRelations: relationStates.filter((state) => state === "unscored").length,
      candidateRelations: relationStates.filter((state) => state === "candidate").length,
      verifiedRelations: relationStates.filter((state) => state === "verified").length,
    };
  }, [universe.papers, universe.relations, workspace.health, workspace.library.items]);

  const selectedPaper = selectedPaperId ? paperById.get(selectedPaperId) || null : null;
  const selectedPaperVerification = selectedPaper
    ? paperVerificationState(
        selectedPaper,
        paperIntegrityIssue(selectedPaper.id, workspace.health),
      )
    : null;
  const selectedPaperCategory = selectedPaper
    ? categoryById.get(selectedPaper.primaryCategory) || null
    : null;
  const selectedPaperUseCount = selectedPaper
    ? heatScope === "project"
      ? workspace.projectUseCounts[selectedPaper.id] || 0
      : selectedPaper.useCount || 0
    : 0;
  const selectedBundle = selectedRelationKey
    ? galaxyRelationBundles.find((bundle) => bundle.key === selectedRelationKey) || null
    : null;
  const selectedSourceGalaxy = selectedBundle
    ? galaxyHierarchy.galaxyById.get(selectedBundle.sourceGalaxyId) || null
    : null;
  const selectedTargetGalaxy = selectedBundle
    ? galaxyHierarchy.galaxyById.get(selectedBundle.targetGalaxyId) || null
    : null;
  const selectedPaperAnnotations = selectedPaper
    ? annotations
        .filter((annotation) => annotation.paperId === selectedPaper.id)
        .sort(
          (left, right) =>
            new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
        )
    : [];
  const selectedPaperRelationBundles = selectedPaper
    ? relationBundles.filter(
        (bundle) =>
          bundle.source === selectedPaper.id || bundle.target === selectedPaper.id,
      )
    : [];
  const visibleRelationRecordCount = galaxyRelationBundles.reduce(
    (sum, bundle) => sum + bundle.lanes.length,
    0,
  );
  const sceneObjectCount = viewLevel === "notes"
    ? (projectMemoriesByCategory.get(notesCategoryId || "") || []).length
    : viewLevel === "papers"
      ? visiblePapers.length
      : viewLevel === "galaxies"
        ? (galaxyHierarchy.galaxiesByCategoryId.get(categoryFilter) || []).length
        : galaxyHierarchy.galaxies.length;
  const sceneObjectNoun = viewLevel === "notes"
    ? sceneObjectCount === 1 ? "note star" : "note stars"
    : viewLevel === "papers"
      ? sceneObjectCount === 1 ? "paper star" : "paper stars"
      : sceneObjectCount === 1 ? "galaxy" : "galaxies";
  const noteCountByCategory = useMemo(
    () => new Map(
      macroCategories.map((category) => [
        category.id,
        (projectMemoriesByCategory.get(category.id) || []).length,
      ]),
    ),
    [macroCategories, projectMemoriesByCategory],
  );
  const canvasKeyboardItems = useMemo<CanvasKeyboardItem[]>(() => {
    const relationItems = galaxyRelationBundles
      .filter((bundle) => {
        if (viewLevel === "universe") return true;
        if (viewLevel !== "galaxies") return false;
        const source = galaxyHierarchy.galaxyById.get(bundle.sourceGalaxyId);
        const target = galaxyHierarchy.galaxyById.get(bundle.targetGalaxyId);
        return source?.categoryId === categoryFilter && target?.categoryId === categoryFilter;
      })
      .map((bundle) => {
        const source = galaxyHierarchy.galaxyById.get(bundle.sourceGalaxyId);
        const target = galaxyHierarchy.galaxyById.get(bundle.targetGalaxyId);
        const count = bundle.lanes.length;
        return {
          target: { kind: "relation", key: bundle.key } as CanvasTarget,
          label: `Galaxy relationship from ${source?.name || "unknown galaxy"} to ${target?.name || "unknown galaxy"}, ${count} ${count === 1 ? "lane" : "lanes"}. Press Enter for details.`,
        };
      });

    if (viewLevel === "universe") {
      const nebulaItems = macroCategories.map((category) => {
        const count = (galaxyHierarchy.galaxiesByCategoryId.get(category.id) || []).length;
        return {
          target: { kind: "category", id: category.id } as CanvasTarget,
          label: `Nebula ${category.name}, ${count} ${count === 1 ? "galaxy" : "galaxies"}. Press Enter to explore.`,
        };
      });
      return [...nebulaItems, ...relationItems];
    }

    if (viewLevel === "galaxies") {
      const galaxies = galaxyHierarchy.galaxiesByCategoryId.get(categoryFilter) || [];
      const galaxyItems = galaxies.map((galaxy) => ({
        target: { kind: "galaxy", id: galaxy.id } as CanvasTarget,
        label: `Galaxy ${galaxy.name}, ${galaxy.paperIds.length} ${galaxy.paperIds.length === 1 ? "paper" : "papers"}. Press Enter to explore.`,
      }));
      const noteCount = noteCountByCategory.get(categoryFilter) || 0;
      const categoryName = categoryById.get(categoryFilter)?.name || "This nebula";
      const blackHoleItem: CanvasKeyboardItem = {
        target: { kind: "black-hole", categoryId: categoryFilter },
        label: noteCount > 0
          ? `${categoryName} knowledge black hole, ${noteCount} ${noteCount === 1 ? "Note or Knowledge Card" : "Notes and Knowledge Cards"}. Press Enter to explore.`
          : `${categoryName} knowledge black hole. No Notes. Unavailable.`,
      };
      return [...galaxyItems, blackHoleItem, ...relationItems];
    }

    if (viewLevel === "papers") {
      return visiblePapers.map((paper) => ({
        target: { kind: "paper", id: paper.id } as CanvasTarget,
        label: `Paper star, ${paper.shortTitle}. Press Enter for details.`,
      }));
    }

    return (projectMemoriesByCategory.get(notesCategoryId || "") || []).map((memory) => ({
      target: { kind: "memory", id: memory.memoryId || memory.id || "" } as CanvasTarget,
      label: `${memory.presentation?.kind === "knowledge_card" ? "Knowledge Card" : "Note"} star, ${memory.presentation?.title || memory.title || memory.statement || "Untitled personal knowledge"}. Press Enter for details.`,
    }));
  }, [
    categoryById,
    categoryFilter,
    galaxyHierarchy.galaxiesByCategoryId,
    galaxyHierarchy.galaxyById,
    galaxyRelationBundles,
    macroCategories,
    noteCountByCategory,
    notesCategoryId,
    projectMemoriesByCategory,
    viewLevel,
    visiblePapers,
  ]);
  const pendingNewPaperCount = useMemo(() => {
    if (!pendingRefresh) return 0;
    if (pendingRefresh.newPaperIds.length > 0) return pendingRefresh.newPaperIds.length;
    const existing = new Set(universe.papers.map((paper) => paper.id));
    return pendingRefresh.stagedSnapshot.papers.filter((paper) => !existing.has(paper.id))
      .length;
  }, [pendingRefresh, universe.papers]);
  const pendingChangeCount = pendingRefresh
    ? pendingRefresh.changedPaperIds.length +
      pendingRefresh.newRelationIds.length +
      pendingRefresh.changedRelationIds.length
    : 0;
  const pendingBadgeCount = pendingNewPaperCount || Math.max(1, pendingChangeCount);
  const pendingRefreshSummary = pendingNewPaperCount > 0
    ? `${pendingNewPaperCount} new ${pendingNewPaperCount === 1 ? "paper" : "papers"} · Create stellar connections`
    : `${Math.max(1, pendingChangeCount)} graph ${Math.max(1, pendingChangeCount) === 1 ? "update" : "updates"} · Verify and apply`;

  useEffect(() => {
    selectedPaperRef.current = selectedPaperId;
  }, [selectedPaperId]);
  useEffect(() => {
    selectedGalaxyRef.current = selectedGalaxyId;
  }, [selectedGalaxyId]);
  useEffect(() => {
    notesCategoryRef.current = notesCategoryId;
  }, [notesCategoryId]);
  useEffect(() => {
    selectedMemoryRef.current = selectedMemoryId;
  }, [selectedMemoryId]);
  useEffect(() => {
    universeRef.current = universe;
  }, [universe]);
  useEffect(() => {
    selectedRelationRef.current = selectedRelationKey;
  }, [selectedRelationKey]);
  useEffect(() => {
    hoveredRef.current = hovered;
  }, [hovered]);
  useEffect(() => {
    visibleRef.current = new Set(visiblePapers.map((paper) => paper.id));
  }, [visiblePapers]);
  useEffect(() => {
    heatRef.current = heatByPaper;
  }, [heatByPaper]);
  useEffect(() => {
    categoryFilterRef.current = categoryFilter;
  }, [categoryFilter]);
  useEffect(() => {
    galaxyRelationBundlesRef.current = galaxyRelationBundles;
  }, [galaxyRelationBundles]);
  useEffect(() => {
    projectMemoryRef.current = workspace.projectMemory.items as PersonalMemory[];
  }, [workspace.projectMemory.items]);
  useEffect(
    () => () => {
      if (pointerHitFrameRef.current) {
        window.cancelAnimationFrame(pointerHitFrameRef.current);
      }
    },
    [],
  );

  const startCameraTransition = useCallback(
    (toCenter: Vector3, toZoom: number, immediate = false) => {
      if (immediate) {
        cameraCenterRef.current = [...toCenter];
        zoomRef.current = toZoom;
        cameraTransitionRef.current = null;
        setZoomLevel(toZoom);
        return;
      }
      cameraTransitionRef.current = {
        fromCenter: [...cameraCenterRef.current],
        toCenter,
        fromZoom: zoomRef.current,
        toZoom,
        startedAt: performance.now(),
      };
      setZoomLevel(toZoom);
    },
    [],
  );

  const clearCanvasKeyboardFocus = useCallback(() => {
    setKeyboardFocus(null);
    hoveredRef.current = null;
    setHovered(null);
  }, []);

  const focusCategory = useCallback(
    (categoryId: string, immediate = false) => {
      const category = getCategory(categoryId);
      if (!category) return;
      startCameraTransition(
        [category.center[0], category.center[1], category.center[2]],
        REGION_FOCUS_ZOOM,
        immediate,
      );
      setCategoryFilter(categoryId);
      setQuery("");
      setSettingsOpen(false);
      setSelectedPaperId(null);
      setSelectedGalaxyId(null);
      setNotesCategoryId(null);
      setSelectedMemoryId(null);
      setSelectedRelationKey(null);
      clearCanvasKeyboardFocus();
    },
    [clearCanvasKeyboardFocus, getCategory, startCameraTransition],
  );

  const showAllUniverse = useCallback((immediate = false) => {
    startCameraTransition([0, 0, 0], DEFAULT_ZOOM, immediate);
    setCategoryFilter("all");
    setQuery("");
    setSelectedPaperId(null);
    setSelectedGalaxyId(null);
    setNotesCategoryId(null);
    setSelectedMemoryId(null);
    setSelectedRelationKey(null);
    clearCanvasKeyboardFocus();
  }, [clearCanvasKeyboardFocus, startCameraTransition]);

  const focusGalaxy = useCallback(
    (galaxyId: string, immediate = false) => {
      const galaxy = galaxyHierarchy.galaxyById.get(galaxyId);
      if (!galaxy) return;
      startCameraTransition(galaxy.position, GALAXY_FOCUS_ZOOM, immediate);
      setCategoryFilter(galaxy.categoryId);
      setSelectedGalaxyId(galaxy.id);
      setNotesCategoryId(null);
      setSelectedMemoryId(null);
      setSelectedPaperId(null);
      setSelectedRelationKey(null);
      setQuery("");
      setSettingsOpen(false);
      clearCanvasKeyboardFocus();
    },
    [clearCanvasKeyboardFocus, galaxyHierarchy.galaxyById, startCameraTransition],
  );

  const focusNotes = useCallback(
    (categoryId: string, immediate = false) => {
      const category = categoryById.get(categoryId);
      const items = projectMemoriesByCategory.get(categoryId) || [];
      if (!category || items.length === 0) return;
      startCameraTransition(category.center, BLACK_HOLE_FOCUS_ZOOM, immediate);
      setCategoryFilter(categoryId);
      setSelectedGalaxyId(null);
      setNotesCategoryId(categoryId);
      setSelectedMemoryId(null);
      setSelectedPaperId(null);
      setSelectedRelationKey(null);
      setQuery("");
      setSettingsOpen(false);
      clearCanvasKeyboardFocus();
    },
    [categoryById, clearCanvasKeyboardFocus, projectMemoriesByCategory, startCameraTransition],
  );

  const returnToNebula = useCallback((immediate = false) => {
    if (categoryFilter === "all") return;
    focusCategory(categoryFilter, immediate);
  }, [categoryFilter, focusCategory]);

  const goBack = useCallback((immediate = false) => {
    const action = canvasBackAction({
      categoryFilter,
      selectedGalaxyId,
      notesCategoryId,
      selectedPaperId,
      selectedMemoryId,
      selectedRelationKey,
    });
    if (action === "close-memory") setSelectedMemoryId(null);
    else if (action === "close-paper") setSelectedPaperId(null);
    else if (action === "close-relation") setSelectedRelationKey(null);
    else if (action === "show-nebula") returnToNebula(immediate);
    else if (action === "show-universe") showAllUniverse(immediate);
  }, [
    categoryFilter,
    notesCategoryId,
    returnToNebula,
    selectedGalaxyId,
    selectedMemoryId,
    selectedPaperId,
    selectedRelationKey,
    showAllUniverse,
  ]);

  const resetUniverseView = useCallback(() => {
    rotationRef.current = { ...DEFAULT_ROTATION };
    showAllUniverse();
  }, [showAllUniverse]);

  const requestRefreshCommit = useCallback(() => {
    const active = refreshAnimationRef.current;
    if (!active || active.commitRequested) return;
    active.commitRequested = true;
    setRefreshPhase("committing");
    const bridge = getNativeBridge();
    if (bridge) {
      bridge.postMessage({
        action: "commitRefresh",
        refreshId: active.pending.refreshId,
        baseRevision: active.pending.baseRevision,
        snapshotSha256: active.pending.snapshotSha256,
      });
      return;
    }

    const nextGraph = active.pending.stagedSnapshot;
    commitRevealRef.current = {
      paperIds: new Set(active.pending.newPaperIds),
      relationIds: new Set(active.pending.newRelationIds),
      startedAt: performance.now(),
    };
    setUniverse(nextGraph);
    refreshAnimationRef.current = null;
    setPendingRefresh(null);
    setRefreshPhase("revealing");
    window.setTimeout(() => {
      commitRevealRef.current = null;
      setRefreshPhase("idle");
    }, 950);
  }, []);

  useEffect(() => {
    requestRefreshCommitRef.current = requestRefreshCommit;
  }, [requestRefreshCommit]);

  const startPendingRefresh = useCallback(() => {
    if (!pendingRefresh || refreshAnimationRef.current || refreshPhase !== "idle") {
      return;
    }
    const currentIds = new Set(universe.papers.map((paper) => paper.id));
    const currentRelationIds = new Set(universe.relations.map((relation) => relation.id));
    const normalized: NormalizedPendingRefresh = {
      ...pendingRefresh,
      newPaperIds:
        pendingRefresh.newPaperIds.length > 0
          ? pendingRefresh.newPaperIds
          : pendingRefresh.stagedSnapshot.papers
              .filter((paper) => !currentIds.has(paper.id))
              .map((paper) => paper.id),
      newRelationIds:
        pendingRefresh.newRelationIds.length > 0
          ? pendingRefresh.newRelationIds
          : pendingRefresh.stagedSnapshot.relations
              .filter((relation) => !currentRelationIds.has(relation.id))
              .map((relation) => relation.id),
    };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rotationRef.current = { ...DEFAULT_ROTATION };
    cameraCenterRef.current = [0, 0, 0];
    cameraTransitionRef.current = null;
    zoomRef.current = DEFAULT_ZOOM;
    setZoomLevel(DEFAULT_ZOOM);
    setCategoryFilter("all");
    setQuery("");
    setSelectedPaperId(null);
    setSelectedGalaxyId(null);
    setNotesCategoryId(null);
    setSelectedMemoryId(null);
    setSelectedRelationKey(null);
    setSettingsOpen(false);
    setRefreshError("");
    refreshErrorIdRef.current = null;
    refreshAnimationRef.current = {
      pending: normalized,
      startedAt: performance.now() + (reducedMotion ? 30 : 140),
      staggerMs: reducedMotion ? 0 : normalized.animation?.staggerMs ?? 500,
      waveDurationMs: reducedMotion
        ? 420
        : normalized.animation?.waveDurationMs ?? 2400,
      reducedMotion,
      commitRequested: false,
    };
    setRefreshPhase("animating");
  }, [pendingRefresh, refreshPhase, universe.papers, universe.relations]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const renderUniverse = universeRef.current;
    const renderCategoriesById = new Map(
      renderUniverse.categories.map((category) => [category.id, category]),
    );
    const renderHierarchy = buildGalaxyHierarchy(renderUniverse);
    const renderGalaxiesById = renderHierarchy.galaxyById;
    const renderPapersById = new Map(
      renderUniverse.papers.map((paper) => [paper.id, paper]),
    );
    const renderMemoriesByCategory = memoriesByCategory(
      projectMemoryRef.current,
      renderUniverse.categories,
      renderUniverse.papers,
    );
    const getRenderCategory = (id: string) =>
      renderCategoriesById.get(id) || renderUniverse.categories[0]!;
    const getRenderGalaxy = (id: string) => renderGalaxiesById.get(id);

    let frame = 0;
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const seeded = (index: number, salt = 0) => {
      const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
      return value - Math.floor(value);
    };
    const backdropCanvas = document.createElement("canvas");
    const backdropContext = backdropCanvas.getContext("2d");
    const dynamicStars = Array.from({ length: 90 }, (_, index) => ({
      x: seeded(index, 1),
      y: seeded(index, 2),
      depth: 0.2 + seeded(index, 3) * 0.8,
      size: 0.35 + seeded(index, 4) * 1.65,
      alpha: 0.1 + seeded(index, 5) * 0.34,
      phase: seeded(index, 6) * Math.PI * 2,
      speed: 0.35 + seeded(index, 7) * 1.4,
      flare: seeded(index, 8) > 0.94,
      warm: seeded(index, 9) > 0.86,
    }));
    const driftingDust = Array.from({ length: 130 }, (_, index) => ({
      x: seeded(index, 11),
      y: seeded(index, 12),
      depth: 0.2 + seeded(index, 13) * 0.8,
      size: 0.35 + seeded(index, 14) * 1.25,
      alpha: 0.035 + seeded(index, 15) * 0.11,
      phase: seeded(index, 16) * Math.PI * 2,
    }));
    const categoryMembers = new Map(
      renderUniverse.categories.map((category) => [
        category.id,
        renderUniverse.papers.filter((paper) => paper.categoryIds.includes(category.id)),
      ]),
    );
    const primaryCategoryMembers = new Map(
      renderUniverse.categories.map((category) => [
        category.id,
        renderUniverse.papers.filter(
          (paper) => paper.primaryCategory === category.id,
        ),
      ]),
    );
    const paperFlashProfiles = new Map(
      renderUniverse.papers.map((paper) => {
        const seed = stableHash(`${paper.id}:nebula-flash`);
        return [
          paper.id,
          {
            phase: ((seed % 3_600) / 3_600) * Math.PI * 2,
            speed: 0.58 + ((seed >>> 8) % 620) / 1_000,
            flare: (seed >>> 17) % 5 === 0,
          },
        ] as const;
      }),
    );
    const ambientPaperSelections = new Map(
      renderUniverse.categories.map((category) => {
        const galaxies = renderHierarchy.galaxiesByCategoryId.get(category.id) || [];
        return [
          category.id,
          {
            allView: selectAmbientPaperIds(
              galaxies,
              ALL_VIEW_AMBIENT_PAPERS_PER_NEBULA,
            ),
            focused: selectAmbientPaperIds(
              galaxies,
              FOCUSED_AMBIENT_PAPERS_PER_NEBULA,
            ),
          },
        ] as const;
      }),
    );
    const categoryParticles = new Map(
      renderUniverse.categories.map((category) => [
        category.id,
        Array.from({ length: 84 }, (_, index) => {
          const seedIndex = (stableHash(category.id) % 10_000) * 211 + index;
          const radial = Math.pow(seeded(seedIndex, 21), 0.58);
          return {
            radial,
            angle:
              seeded(seedIndex, 22) * Math.PI * 2 + radial * 5.6 +
              (index % 2 ? Math.PI : 0),
            vertical: (seeded(seedIndex, 23) - 0.5) * 0.28,
            depth: (seeded(seedIndex, 24) - 0.5) * 0.55,
            size: 0.55 + seeded(seedIndex, 25) * 2.1,
            alpha: 0.16 + seeded(seedIndex, 26) * 0.48,
            phase: seeded(seedIndex, 27) * Math.PI * 2,
            speed: 0.45 + seeded(seedIndex, 28) * 1.15,
          };
        }),
      ]),
    );

    const createStarSprite = (color: string) => {
      const sprite = document.createElement("canvas");
      sprite.width = 128;
      sprite.height = 128;
      const spriteContext = sprite.getContext("2d")!;
      const glow = spriteContext.createRadialGradient(64, 64, 0, 64, 64, 58);
      glow.addColorStop(0, "rgba(255,255,255,1)");
      glow.addColorStop(0.055, "rgba(255,255,255,.98)");
      glow.addColorStop(0.15, hexToRgba(color, 0.92));
      glow.addColorStop(0.48, hexToRgba(color, 0.22));
      glow.addColorStop(1, hexToRgba(color, 0));
      spriteContext.fillStyle = glow;
      spriteContext.fillRect(0, 0, 128, 128);
      spriteContext.strokeStyle = hexToRgba(color, 0.56);
      spriteContext.lineWidth = 1;
      spriteContext.beginPath();
      spriteContext.moveTo(7, 64);
      spriteContext.lineTo(121, 64);
      spriteContext.moveTo(64, 24);
      spriteContext.lineTo(64, 104);
      spriteContext.stroke();
      return sprite;
    };

    const starSprites = new Map(
      renderUniverse.categories.map((category) => [
        category.id,
        createStarSprite(category.color),
      ]),
    );
    const suppliedStarSprite = document.createElement("canvas");
    suppliedStarSprite.width = 256;
    suppliedStarSprite.height = 256;
    const suppliedStarContext = suppliedStarSprite.getContext("2d")!;
    let suppliedStarReady = false;
    const suppliedStarSource = new Image();
    suppliedStarSource.decoding = "async";
    suppliedStarSource.onload = () => {
      suppliedStarContext.clearRect(0, 0, 256, 256);
      // Packaged builds contain a pre-cropped 256px asset. Development can
      // still use the original reference sheet without maintaining two source
      // artworks in the repository.
      if (suppliedStarSource.naturalWidth <= 512 && suppliedStarSource.naturalHeight <= 512) {
        suppliedStarContext.drawImage(suppliedStarSource, 0, 0, 256, 256);
      } else {
        suppliedStarContext.drawImage(
          suppliedStarSource,
          630,
          120,
          355,
          355,
          0,
          0,
          256,
          256,
        );
      }
      suppliedStarReady = true;
    };
    suppliedStarSource.src = "./liteverse-star-source.png";

    const galaxySprites = new Map<string, HTMLCanvasElement>();
    const galaxySources: HTMLImageElement[] = [];
    let disposed = false;
    const loadGalaxySprite = (assetId: string) => new Promise<void>((resolve) => {
      const source = new Image();
      source.decoding = "async";
      galaxySources.push(source);
      const release = () => {
        source.onload = null;
        source.onerror = null;
        source.removeAttribute("src");
        resolve();
      };
      source.onerror = release;
      source.onload = () => {
        if (!disposed) {
          const maximumDimension = 420;
          const scale = Math.min(1, maximumDimension / Math.max(source.naturalWidth, source.naturalHeight));
          const sprite = document.createElement("canvas");
          sprite.width = Math.max(1, Math.round(source.naturalWidth * scale));
          sprite.height = Math.max(1, Math.round(source.naturalHeight * scale));
          const spriteContext = sprite.getContext("2d")!;
          spriteContext.filter = "saturate(.92) brightness(.94) contrast(1.04)";
          spriteContext.drawImage(source, 0, 0, sprite.width, sprite.height);
          spriteContext.filter = "none";
          galaxySprites.set(assetId, sprite);
        }
        release();
      };
      source.src = `./galaxies/${assetId}`;
    });
    // Decode one galaxy at a time. A private universe can use all ten source
    // images, and parallel decoding briefly retained every full-size bitmap.
    void (async () => {
      for (const assetId of new Set(renderHierarchy.galaxies.map((galaxy) => galaxy.assetId))) {
        if (disposed) break;
        await loadGalaxySprite(assetId);
      }
    })();

    const blackHoleSprite = document.createElement("canvas");
    let blackHoleReady = false;
    const blackHoleSource = new Image();
    blackHoleSource.decoding = "async";
    blackHoleSource.onload = () => {
      const maximumDimension = 720;
      const scale = Math.min(1, maximumDimension / Math.max(blackHoleSource.naturalWidth, blackHoleSource.naturalHeight));
      blackHoleSprite.width = Math.max(1, Math.round(blackHoleSource.naturalWidth * scale));
      blackHoleSprite.height = Math.max(1, Math.round(blackHoleSource.naturalHeight * scale));
      const spriteContext = blackHoleSprite.getContext("2d")!;
      spriteContext.drawImage(blackHoleSource, 0, 0, blackHoleSprite.width, blackHoleSprite.height);
      blackHoleReady = true;
      blackHoleSource.onload = null;
      blackHoleSource.removeAttribute("src");
    };
    blackHoleSource.src = "./liteverse-black-hole-transparent.png";

    const createNebulaTexture = (category: Category) => {
      const texture = document.createElement("canvas");
      texture.width = 720;
      texture.height = 460;
      const textureContext = texture.getContext("2d")!;
      const categorySeed = stableHash(category.id) % 10_000;
      textureContext.globalCompositeOperation = "screen";
      for (let layer = 0; layer < 7; layer += 1) {
        const cx = 360 + (seeded(categorySeed * 19 + layer, 31) - 0.5) * 210;
        const cy = 230 + (seeded(categorySeed * 23 + layer, 32) - 0.5) * 125;
        const radius = 82 + seeded(categorySeed * 29 + layer, 33) * 155;
        const cloud = textureContext.createRadialGradient(cx, cy, 0, cx, cy, radius);
        cloud.addColorStop(0, hexToRgba(category.color, 0.1 + layer * 0.012));
        cloud.addColorStop(0.42, hexToRgba(category.color, 0.04));
        cloud.addColorStop(1, hexToRgba(category.color, 0));
        textureContext.fillStyle = cloud;
        textureContext.beginPath();
        textureContext.ellipse(cx, cy, radius, radius * 0.52, layer * 0.37, 0, Math.PI * 2);
        textureContext.fill();
      }
      for (let index = 0; index < 520; index += 1) {
        const seedIndex = categorySeed * 1000 + index;
        const radial = Math.pow(seeded(seedIndex, 34), 0.52);
        const angle = seeded(seedIndex, 35) * Math.PI * 2 + radial * 5.7;
        const x = 360 + Math.cos(angle) * radial * 315;
        const y = 230 + Math.sin(angle) * radial * 150 + (seeded(seedIndex, 36) - 0.5) * 28;
        const size = 0.35 + seeded(seedIndex, 37) * 1.8;
        textureContext.fillStyle = hexToRgba(
          category.color,
          0.06 + seeded(seedIndex, 38) * 0.24,
        );
        textureContext.beginPath();
        textureContext.arc(x, y, size, 0, Math.PI * 2);
        textureContext.fill();
      }
      return texture;
    };

    const nebulaTextures = new Map(
      renderUniverse.categories.map((category) => [
        category.id,
        createNebulaTexture(category),
      ]),
    );

    const categoryNebulaAssignments = resolveRegionNebulaAssignments(
      renderUniverse.categories,
      renderUniverse.visuals.nebulaAssets,
      renderUniverse.visuals.nebulaAssignmentSeed,
    );
    const regionNebulaSprites = new Map<string, HTMLCanvasElement>();
    const regionNebulaSources: HTMLImageElement[] = [];

    const createRegionNebulaSprite = (source: HTMLImageElement) => {
      const maximumDimension = 768;
      const scale = Math.min(
        1,
        maximumDimension / Math.max(source.naturalWidth, source.naturalHeight),
      );
      const sprite = document.createElement("canvas");
      sprite.width = Math.max(1, Math.round(source.naturalWidth * scale));
      sprite.height = Math.max(1, Math.round(source.naturalHeight * scale));
      const spriteContext = sprite.getContext("2d")!;
      spriteContext.filter = "brightness(.82) saturate(1.08) contrast(1.06)";
      spriteContext.drawImage(source, 0, 0, sprite.width, sprite.height);
      spriteContext.filter = "none";

      // Feather only the perimeter once. The image remains crisp in the middle,
      // while its rectangular edge disappears into the 3D particle cloud.
      spriteContext.globalCompositeOperation = "destination-in";
      spriteContext.save();
      const normalizedHeight = sprite.height / sprite.width;
      spriteContext.scale(1, normalizedHeight);
      const mask = spriteContext.createRadialGradient(
        sprite.width * 0.5,
        sprite.width * 0.5,
        sprite.width * 0.12,
        sprite.width * 0.5,
        sprite.width * 0.5,
        sprite.width * 0.52,
      );
      mask.addColorStop(0, "rgba(255,255,255,1)");
      mask.addColorStop(0.76, "rgba(255,255,255,.98)");
      mask.addColorStop(0.91, "rgba(255,255,255,.42)");
      mask.addColorStop(1, "rgba(255,255,255,0)");
      spriteContext.fillStyle = mask;
      spriteContext.fillRect(0, 0, sprite.width, sprite.width);
      spriteContext.restore();
      spriteContext.globalCompositeOperation = "source-over";
      return sprite;
    };

    const assignedNebulaAssetIds = new Set(categoryNebulaAssignments.values());
    for (const asset of renderUniverse.visuals.nebulaAssets) {
      // Ten artwork choices remain available to future regions, but only the
      // assets visible in the current graph need to be decoded into memory.
      if (!assignedNebulaAssetIds.has(asset.id)) continue;
      const source = new Image();
      source.decoding = "async";
      source.onload = () => {
        regionNebulaSprites.set(asset.id, createRegionNebulaSprite(source));
        source.onload = null;
        source.removeAttribute("src");
      };
      source.src = asset.src;
      regionNebulaSources.push(source);
    }

    const drawBackdrop = () => {
      if (!backdropContext) return;
      backdropCanvas.width = Math.round(width * pixelRatio);
      backdropCanvas.height = Math.round(height * pixelRatio);
      backdropContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      backdropContext.clearRect(0, 0, width, height);
      const background = backdropContext.createRadialGradient(
        width * 0.5,
        height * 0.43,
        0,
        width * 0.5,
        height * 0.43,
        Math.max(width, height) * 0.82,
      );
      background.addColorStop(0, "rgba(12,25,58,.5)");
      background.addColorStop(0.35, "rgba(5,14,36,.54)");
      background.addColorStop(0.72, "rgba(1,6,18,.62)");
      background.addColorStop(1, "rgba(0,1,7,.7)");
      backdropContext.fillStyle = background;
      backdropContext.fillRect(0, 0, width, height);

      backdropContext.save();
      backdropContext.globalCompositeOperation = "screen";
      const cloudSpecs = [
        [0.13, 0.18, 0.42, "rgba(28,90,255,.12)"],
        [0.76, 0.23, 0.5, "rgba(74,55,255,.09)"],
        [0.88, 0.82, 0.46, "rgba(19,123,255,.095)"],
        [0.3, 0.9, 0.4, "rgba(100,37,255,.07)"],
      ] as const;
      for (const [x, y, scale, color] of cloudSpecs) {
        const radius = Math.max(width, height) * scale;
        const cloud = backdropContext.createRadialGradient(
          width * x,
          height * y,
          0,
          width * x,
          height * y,
          radius,
        );
        cloud.addColorStop(0, color);
        cloud.addColorStop(0.45, color.replace(/\.[0-9]+\)$/, ".035)"));
        cloud.addColorStop(1, "rgba(0,0,0,0)");
        backdropContext.fillStyle = cloud;
        backdropContext.fillRect(0, 0, width, height);
      }
      backdropContext.restore();

      for (let index = 0; index < 380; index += 1) {
        const x = seeded(index, 41) * width;
        const y = seeded(index, 42) * height;
        const size = 0.18 + Math.pow(seeded(index, 43), 4) * 1.35;
        const alpha = 0.055 + seeded(index, 44) * 0.25;
        backdropContext.fillStyle =
          seeded(index, 45) > 0.88
            ? `rgba(150,195,255,${alpha})`
            : `rgba(225,237,255,${alpha})`;
        backdropContext.beginPath();
        backdropContext.arc(x, y, size, 0, Math.PI * 2);
        backdropContext.fill();
        if (size > 1.15) {
          backdropContext.strokeStyle = `rgba(155,211,255,${alpha * 0.42})`;
          backdropContext.lineWidth = 0.45;
          backdropContext.beginPath();
          backdropContext.moveTo(x - size * 4.2, y);
          backdropContext.lineTo(x + size * 4.2, y);
          backdropContext.moveTo(x, y - size * 2.9);
          backdropContext.lineTo(x, y + size * 2.9);
          backdropContext.stroke();
        }
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      pixelRatio = Math.max(
        1,
        Math.min(
          window.devicePixelRatio || 1,
          1.5,
          Math.sqrt(4_500_000 / Math.max(1, width * height)),
        ),
      );
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      drawBackdrop();
    };

    const project = (position: readonly number[]) => {
      const x0 = position[0] - cameraCenterRef.current[0];
      const y0 = position[1] - cameraCenterRef.current[1];
      const z0 = position[2] - cameraCenterRef.current[2];
      const { x: angleX, y: angleY } = rotationRef.current;
      const cosY = Math.cos(angleY);
      const sinY = Math.sin(angleY);
      const x1 = x0 * cosY - z0 * sinY;
      const z1 = x0 * sinY + z0 * cosY;
      const cosX = Math.cos(angleX);
      const sinX = Math.sin(angleX);
      const y1 = y0 * cosX - z1 * sinX;
      const z2 = y0 * sinX + z1 * cosX;
      const perspective = 10 / (10 + z2);
      const scale = Math.min(width, height) * 0.115 * zoomRef.current;
      return {
        x: width * 0.5 + x1 * scale * perspective,
        y: height * 0.51 - y1 * scale * perspective,
        depth: z2,
        perspective,
      };
    };

    let lastRenderedAt = Number.NEGATIVE_INFINITY;
    let windowFocused = document.hasFocus();
    const render = (time: number) => {
      if (document.hidden) {
        frame = 0;
        return;
      }
      const activelyMoving = Boolean(
        pointerRef.current.down ||
        cameraTransitionRef.current ||
        refreshAnimationRef.current ||
        commitRevealRef.current,
      );
      // The universe is intentionally calm while idle. Interaction gets a
      // responsive 30 fps budget, while a background window drops to 4 fps.
      // Hidden windows are stopped entirely by the visibility handler below.
      const targetFps = windowFocused
        ? activelyMoving
          ? reducedMotion
            ? IDLE_FPS
            : INTERACTION_FPS
          : reducedMotion
            ? BACKGROUND_FPS
            : IDLE_FPS
        : BACKGROUND_FPS;
      if (time - lastRenderedAt < 1000 / targetFps) {
        frame = window.requestAnimationFrame(render);
        return;
      }
      lastRenderedAt = time;
      const cameraTransition = cameraTransitionRef.current;
      if (cameraTransition) {
        const progress = reducedMotion
          ? 1
          : Math.min(
              1,
              Math.max(
                0,
                (time - cameraTransition.startedAt) / CAMERA_TRANSITION_MS,
              ),
            );
        const eased =
          progress < 0.5
            ? 4 * progress * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        cameraCenterRef.current = cameraTransition.fromCenter.map(
          (value, index) =>
            value +
            (cameraTransition.toCenter[index] - value) * eased,
        ) as Vector3;
        zoomRef.current =
          cameraTransition.fromZoom +
          (cameraTransition.toZoom - cameraTransition.fromZoom) * eased;
        if (progress === 1) cameraTransitionRef.current = null;
      }
      const motionTime = reducedMotion ? 0 : time;
      context.clearRect(0, 0, width, height);
      context.drawImage(backdropCanvas, 0, 0, width, height);

      context.save();
      context.globalCompositeOperation = "screen";
      const cameraDeltaX = rotationRef.current.y - DEFAULT_ROTATION.y;
      const cameraDeltaY = rotationRef.current.x - DEFAULT_ROTATION.x;
      for (const star of dynamicStars) {
        const parallaxX = cameraDeltaX * star.depth * 46;
        const parallaxY = cameraDeltaY * star.depth * 30;
        const x = ((star.x * width + parallaxX) % width + width) % width;
        const y = ((star.y * height + parallaxY) % height + height) % height;
        const pulse = 0.7 + Math.sin(motionTime * 0.00065 * star.speed + star.phase) * 0.3;
        const alpha = star.alpha * pulse;
        context.fillStyle = star.warm
          ? `rgba(255,224,190,${alpha})`
          : `rgba(184,220,255,${alpha})`;
        context.beginPath();
        context.arc(x, y, star.size * (0.8 + star.depth * 0.45), 0, Math.PI * 2);
        context.fill();
        if (star.flare) {
          context.strokeStyle = star.warm
            ? `rgba(255,218,180,${alpha * 0.42})`
            : `rgba(132,204,255,${alpha * 0.46})`;
          context.lineWidth = 0.55;
          context.beginPath();
          context.moveTo(x - star.size * 5.5, y);
          context.lineTo(x + star.size * 5.5, y);
          context.moveTo(x, y - star.size * 3.4);
          context.lineTo(x, y + star.size * 3.4);
          context.stroke();
        }
      }

      for (const particle of driftingDust) {
        // Keep background dust alive without accumulating a one-way screen drift.
        const drift =
          Math.sin(motionTime * 0.00009 + particle.phase) *
          0.0055 *
          particle.depth;
        const x =
          ((particle.x + drift + cameraDeltaX * particle.depth * 0.012) % 1 + 1) %
          1;
        const y =
          particle.y +
          Math.sin(motionTime * 0.00018 + particle.phase) * 0.008 * particle.depth;
        context.fillStyle = `rgba(83,142,255,${particle.alpha})`;
        context.beginPath();
        context.arc(x * width, y * height, particle.size, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();

      const worldScale = Math.min(width, height) * 0.115 * zoomRef.current;
      const rawCategoryFrames = renderUniverse.categories
        .filter(
          (category) =>
            categoryFilterRef.current === "all" ||
            category.id === categoryFilterRef.current,
        )
        .map((category) => {
          const center = project(category.center);
          const members = categoryMembers.get(category.id)!;
          const primaryMembers = primaryCategoryMembers.get(category.id)!;
          const extentMembers = primaryMembers.length > 0 ? primaryMembers : members;
          const galaxyMembers = renderHierarchy.galaxiesByCategoryId.get(category.id) || [];
          const worldExtent = Math.max(
            1.55,
            ...(galaxyMembers.length > 0
              ? galaxyMembers.map(
                (galaxy) =>
                  Math.hypot(
                    galaxy.position[0] - category.center[0],
                    galaxy.position[1] - category.center[1],
                    galaxy.position[2] - category.center[2],
                  ) + 1.05,
              )
              : extentMembers.map(
                (paper) =>
                Math.hypot(
                  paper.position[0] - category.center[0],
                  paper.position[1] - category.center[1],
                  paper.position[2] - category.center[2],
                ) + 0.48,
              )),
          );
          const heatMembers = primaryMembers.length > 0 ? primaryMembers : members;
          const heat =
            heatMembers.reduce(
              (sum, paper) => sum + (heatRef.current[paper.id] || 0),
              0,
            ) / Math.max(1, heatMembers.length);
          const rawRadius =
            worldExtent *
            worldScale *
            center.perspective *
            (1 + Math.min(0.07, heat * 0.035));
          return {
            category,
            center,
            heat,
            rotation:
              ((stableHash(`${category.id}:roll`) % 1_000) / 1_000 - 0.5) *
              0.18,
            rawRadius,
            radius: rawRadius,
          };
        })
        .sort((left, right) => right.center.depth - left.center.depth);
      const categoryFrames = categoryFilterRef.current === "all"
        ? constrainAllNebulaRadii(rawCategoryFrames, width, height)
        : rawCategoryFrames.map((frame) => ({
            ...frame,
            radius: Math.min(
              frame.radius,
              FOCUSED_NEBULA_MAX_RADIUS_PX,
              Math.min(width, height) * FOCUSED_NEBULA_MAX_RADIUS_RATIO,
            ),
          }));
      const categoryFrameById = new Map(
        categoryFrames.map((frame) => [frame.category.id, frame]),
      );

      const projectedRegions: ProjectedRegion[] = [];
      for (const { category, center, heat, radius, rotation } of categoryFrames) {
        if (
          center.x + radius < 0 ||
          center.x - radius > width ||
          center.y + radius < 0 ||
          center.y - radius > height
        ) {
          continue;
        }

        projectedRegions.push({
          id: category.id,
          x: center.x,
          y: center.y,
          radiusX: Math.max(58, radius * 1.04),
          radiusY: Math.max(42, radius * 0.7),
          rotation,
        });
        const hoveredCategory =
          hoveredRef.current?.kind === "category" &&
          hoveredRef.current.id === category.id;

        const direction = stableHash(`${category.id}:direction`) % 2 ? -1 : 1;
        const particleLayoutScale = Math.min(
          1,
          radius /
            Math.max(1, worldScale * center.perspective * 1.66),
        );
        const particleFrames = categoryParticles.get(category.id)!.map((particle) => {
          const angle =
            particle.angle +
            motionTime * 0.000018 * particle.speed * direction;
          const turbulence = Math.sin(motionTime * 0.00031 + particle.phase) * 0.055;
          const localX = Math.cos(angle) * particle.radial * 1.55;
          const localY =
            Math.sin(angle) * particle.radial * 0.72 +
            particle.vertical + turbulence;
          const localZ =
            particle.depth + Math.sin(angle * 1.7 + particle.phase) * 0.18;
          const point = project([
            category.center[0] + localX * particleLayoutScale,
            category.center[1] + localY * particleLayoutScale,
            category.center[2] + localZ * particleLayoutScale,
          ]);
          const pulse =
            0.55 +
            Math.sin(motionTime * 0.00075 * particle.speed + particle.phase) * 0.28;
          return { particle, point, pulse };
        });

        const drawParticleLayer = (isNearLayer: boolean) => {
          context.save();
          context.globalCompositeOperation = "lighter";
          for (const frameParticle of particleFrames) {
            const isNear = frameParticle.point.depth < center.depth;
            if (isNear !== isNearLayer) continue;
            context.fillStyle = hexToRgba(
              category.color,
              frameParticle.particle.alpha *
                Math.max(0.24, frameParticle.pulse) *
                (isNearLayer ? 1 : 0.52),
            );
            context.beginPath();
            context.arc(
              frameParticle.point.x,
              frameParticle.point.y,
              frameParticle.particle.size * frameParticle.point.perspective,
              0,
              Math.PI * 2,
            );
            context.fill();
          }
          context.restore();
        };

        context.save();
        context.translate(center.x, center.y);
        context.rotate(rotation);
        context.globalAlpha = 0.2 + Math.min(0.08, heat * 0.04);
        context.globalCompositeOperation = "screen";
        context.drawImage(
          nebulaTextures.get(category.id)!,
          -radius,
          -radius * 0.65,
          radius * 2,
          radius * 1.3,
        );
        context.restore();

        drawParticleLayer(false);

        const assetId = categoryNebulaAssignments.get(category.id);
        const regionNebula = assetId ? regionNebulaSprites.get(assetId) : undefined;
        if (regionNebula) {
          const maximumDimension = radius * 2.12;
          const aspect = regionNebula.width / regionNebula.height;
          const drawWidth = aspect >= 1 ? maximumDimension : maximumDimension * aspect;
          const drawHeight = aspect >= 1 ? maximumDimension / aspect : maximumDimension;
          context.save();
          context.translate(center.x, center.y);
          context.rotate(rotation);
          context.globalCompositeOperation = "screen";
          context.globalAlpha = 0.43 + Math.min(0.08, heat * 0.045);
          context.drawImage(
            regionNebula,
            -drawWidth * 0.5,
            -drawHeight * 0.5,
            drawWidth,
            drawHeight,
          );
          context.restore();
        }

        drawParticleLayer(true);

        if (hoveredCategory) {
          context.save();
          context.translate(center.x, center.y);
          context.rotate(rotation);
          context.strokeStyle = hexToRgba(category.color, 0.78);
          context.lineWidth = 1.25;
          context.shadowColor = hexToRgba(category.color, 0.9);
          context.shadowBlur = 18;
          context.setLineDash([5, 7]);
          context.beginPath();
          context.ellipse(
            0,
            0,
            radius * 1.03,
            radius * 0.69,
            0,
            0,
            Math.PI * 2,
          );
          context.stroke();
          context.restore();
        }

        context.save();
        const categoryLabel = category.name;
        context.font = "600 15px -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
        const categoryLabelAccentWidth = 18;
        const categoryLabelWidth = context.measureText(categoryLabel).width + categoryLabelAccentWidth;
        // Keep region names below the header/search controls and inside the
        // viewport. Large nebula sprites can otherwise place the label behind
        // the chrome even while the region itself remains visible.
        const categoryLabelX = Math.max(
          20,
          Math.min(width - categoryLabelWidth - 20, center.x - radius * 0.52),
        );
        const categoryLabelY = Math.max(
          176,
          Math.min(height - 36, center.y - radius * 0.43),
        );
        context.globalCompositeOperation = "source-over";
        context.fillStyle = "rgba(245, 245, 247, 0.92)";
        context.shadowColor = "rgba(0, 0, 0, 0.68)";
        context.shadowBlur = 4;
        context.shadowOffsetY = 1;
        context.fillText(
          categoryLabel,
          categoryLabelX + categoryLabelAccentWidth,
          categoryLabelY,
        );
        context.shadowBlur = 0;
        context.shadowOffsetY = 0;
        context.fillStyle = hexToRgba(category.color, 0.78);
        context.beginPath();
        context.arc(categoryLabelX + 4, categoryLabelY - 5, 2.8, 0, Math.PI * 2);
        context.fill();
        context.restore();
      }
      projectedRegionsRef.current = projectedRegions;

      const positions = new Map<string, ReturnType<typeof project>>();
      for (const paper of renderUniverse.papers) {
        const galaxy = renderHierarchy.galaxyByPaperId.get(paper.id);
        const members = galaxy?.paperIds || [];
        const memberIndex = Math.max(0, members.indexOf(paper.id));
        positions.set(
          paper.id,
          project(galaxy
            ? paperPositionInGalaxy(paper, galaxy, memberIndex, members.length)
            : paper.position),
        );
      }

      const activeRefresh = refreshAnimationRef.current;
      const refreshShakeOffsets = new Map<string, { x: number; y: number }>();
      const refreshGhosts: Array<{
        paper: Paper;
        point: ReturnType<typeof project>;
        elapsed: number;
        progress: number;
        index: number;
      }> = [];
      if (activeRefresh) {
        const stagedPapers = new Map(
          activeRefresh.pending.stagedSnapshot.papers.map((paper) => [paper.id, paper]),
        );
        const stagedPositions = new Map(
          activeRefresh.pending.stagedSnapshot.papers.map((paper) => [
            paper.id,
            project(paper.position),
          ]),
        );
        const newPaperIds = activeRefresh.pending.newPaperIds.filter((id) =>
          stagedPapers.has(id),
        );
        const maximumWaveRadius = Math.hypot(width, height) * 1.08;

        newPaperIds.forEach((paperId, index) => {
          const paper = stagedPapers.get(paperId)!;
          const point = stagedPositions.get(paperId)!;
          const elapsed = time - activeRefresh.startedAt - index * activeRefresh.staggerMs;
          if (elapsed < 0) return;
          refreshGhosts.push({
            paper,
            point,
            elapsed,
            progress: Math.min(1, elapsed / activeRefresh.waveDurationMs),
            index,
          });
        });

        if (!activeRefresh.reducedMotion && newPaperIds.length > 0) {
          const newPaperSet = new Set(newPaperIds);
          const firstImpactByTarget = new Map<string, number>();
          for (const relation of activeRefresh.pending.stagedSnapshot.relations) {
            let sourceId: string | null = null;
            let targetId: string | null = null;
            if (newPaperSet.has(relation.source)) {
              sourceId = relation.source;
              targetId = relation.target;
            } else if (newPaperSet.has(relation.target)) {
              sourceId = relation.target;
              targetId = relation.source;
            }
            if (!sourceId || !targetId || sourceId === targetId) continue;
            const sourceIndex = newPaperIds.indexOf(sourceId);
            const sourcePoint = stagedPositions.get(sourceId);
            const targetPoint = stagedPositions.get(targetId);
            if (sourceIndex < 0 || !sourcePoint || !targetPoint) continue;
            const distance = Math.hypot(
              targetPoint.x - sourcePoint.x,
              targetPoint.y - sourcePoint.y,
            );
            const impactAt =
              activeRefresh.startedAt +
              sourceIndex * activeRefresh.staggerMs +
              Math.min(0.88, distance / maximumWaveRadius) *
                activeRefresh.waveDurationMs;
            const currentImpact = firstImpactByTarget.get(targetId);
            if (currentImpact === undefined || impactAt < currentImpact) {
              firstImpactByTarget.set(targetId, impactAt);
            }
          }
          for (const [paperId, impactAt] of firstImpactByTarget) {
            const impactElapsed = time - impactAt;
            if (impactElapsed < 0 || impactElapsed > 360) continue;
            const decay = 1 - impactElapsed / 360;
            const phase = impactElapsed * 0.09;
            const axis = stableHash(`${paperId}:supernova-axis`) % 360;
            const radians = (axis * Math.PI) / 180;
            const amplitude = Math.sin(phase) * 7.5 * decay;
            refreshShakeOffsets.set(paperId, {
              x: Math.cos(radians) * amplitude,
              y: Math.sin(radians) * amplitude,
            });
          }
        }

        const lastBurstAt =
          Math.max(0, newPaperIds.length - 1) * activeRefresh.staggerMs;
        const totalDuration =
          lastBurstAt +
          (newPaperIds.length > 0 ? activeRefresh.waveDurationMs : 520);
        if (time - activeRefresh.startedAt >= totalDuration) {
          requestRefreshCommitRef.current?.();
        }
      }

      const galaxyPositions = new Map(
        renderHierarchy.galaxies.map((galaxy) => {
          const rawPoint = project(galaxy.position);
          const categoryFrame = categoryFrameById.get(galaxy.categoryId);
          const point = categoryFilterRef.current === "all" && categoryFrame
            ? containPointInNebulaEllipse(rawPoint, categoryFrame, 0.58, 0.34)
            : rawPoint;
          return [galaxy.id, point] as const;
        }),
      );
      const projectedRelations: ProjectedRelation[] = [];
      const showGalaxyNetwork = !selectedGalaxyRef.current && !notesCategoryRef.current;
      if (showGalaxyNetwork) {
        for (const [bundleIndex, bundle] of galaxyRelationBundlesRef.current.entries()) {
          const sourceGalaxy = getRenderGalaxy(bundle.sourceGalaxyId);
          const targetGalaxy = getRenderGalaxy(bundle.targetGalaxyId);
          if (!sourceGalaxy || !targetGalaxy) continue;
          const focusedCategory = categoryFilterRef.current;
          if (focusedCategory !== "all" &&
              (sourceGalaxy.categoryId !== focusedCategory || targetGalaxy.categoryId !== focusedCategory)) continue;
          const source = galaxyPositions.get(sourceGalaxy.id)!;
          const target = galaxyPositions.get(targetGalaxy.id)!;
          const deltaX = target.x - source.x;
          const deltaY = target.y - source.y;
          const distance = Math.max(1, Math.hypot(deltaX, deltaY));
          const normalX = -deltaY / distance;
          const normalY = deltaX / distance;
          const selected = selectedRelationRef.current === bundle.key;
          const hoveredRelation = hoveredRef.current?.kind === "relation" && hoveredRef.current.key === bundle.key;
          const focused = selected || hoveredRelation;
          for (const lane of bundle.lanes) {
            const laneOffset = (lane.laneIndex - (lane.laneCount - 1) / 2) * 7;
            const start = { x: source.x + normalX * laneOffset, y: source.y + normalY * laneOffset };
            const end = { x: target.x + normalX * laneOffset, y: target.y + normalY * laneOffset };
            const control = {
              x: (start.x + end.x) / 2 + normalX * (20 + laneOffset * 0.24),
              y: (start.y + end.y) / 2 + normalY * (20 + laneOffset * 0.24),
            };
            const state = relationDisplayState(lane.relation);
            const unscored = state === "unscored";
            const sourceColor = getRenderCategory(sourceGalaxy.categoryId).color;
            const targetColor = getRenderCategory(targetGalaxy.categoryId).color;
            const gradient = context.createLinearGradient(start.x, start.y, end.x, end.y);
            gradient.addColorStop(0, hexToRgba(sourceColor, unscored ? 0.2 : focused ? 0.94 : 0.58));
            gradient.addColorStop(1, hexToRgba(targetColor, unscored ? 0.2 : focused ? 0.94 : 0.58));
            const strength = (normalizedPercent(lane.relation.strength) || 28) / 100;
            const lineWidth = unscored ? 0.62 : 0.9 + strength * 0.85 + (focused ? 0.55 : 0);
            const reveal = commitRevealRef.current;
            const revealAlpha = reveal?.relationIds.has(lane.relation.id)
              ? Math.min(1, Math.max(0, (time - reveal.startedAt) / 780))
              : 1;
            context.save();
            context.lineCap = "round";
            context.strokeStyle = gradient;
            context.globalAlpha = revealAlpha * (unscored ? 0.42 : focused ? 0.98 : 0.76);
            context.lineWidth = lineWidth;
            context.setLineDash(state === "verified" ? [] : state === "candidate" ? [7, 8] : [2, 8]);
            context.beginPath();
            context.moveTo(start.x, start.y);
            context.quadraticCurveTo(control.x, control.y, end.x, end.y);
            context.stroke();
            if (focused && !reducedMotion) {
              const photonT = ((motionTime * 0.00008 + bundleIndex * 0.137 + lane.laneIndex * 0.081) % 1 + 1) % 1;
              const inverse = 1 - photonT;
              context.setLineDash([]);
              context.fillStyle = "rgba(245,250,255,.82)";
              context.beginPath();
              context.arc(
                inverse * inverse * start.x + 2 * inverse * photonT * control.x + photonT * photonT * end.x,
                inverse * inverse * start.y + 2 * inverse * photonT * control.y + photonT * photonT * end.y,
                1.15,
                0,
                Math.PI * 2,
              );
              context.fill();
            }
            context.restore();
            const points = Array.from({ length: 25 }, (_, index) => {
              const t = index / 24;
              const inverse = 1 - t;
              return {
                x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
                y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
              };
            });
            projectedRelations.push({ key: bundle.key, points, hitWidth: Math.max(7, lineWidth + 4) });
          }
        }
      }
      projectedRelationsRef.current = projectedRelations;

      const projectedGalaxies: ProjectedGalaxy[] = [];
      const projectedBlackHoles: ProjectedBlackHole[] = [];
      const projectedMemoryStars: ProjectedMemoryStar[] = [];
      const activeGalaxyId = selectedGalaxyRef.current;
      const activeNotesCategoryId = notesCategoryRef.current;
      const drawGalaxy = (galaxy: Galaxy, point: ReturnType<typeof project>, radius: number, alpha: number) => {
        const sprite = galaxySprites.get(galaxy.assetId);
        if (!sprite) return;
        const aspect = sprite.width / sprite.height;
        const drawWidth = aspect >= 1 ? radius * 2 : radius * 2 * aspect;
        const drawHeight = aspect >= 1 ? radius * 2 / aspect : radius * 2;
        context.save();
        context.globalCompositeOperation = "screen";
        context.globalAlpha = alpha;
        context.translate(point.x, point.y);
        context.rotate(((stableHash(`${galaxy.id}:visual-roll`) % 1000) / 1000 - 0.5) * 0.28);
        context.drawImage(sprite, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
        context.restore();
      };

      if (!activeNotesCategoryId) {
        const visibleGalaxies = renderHierarchy.galaxies
          .filter((galaxy) => categoryFilterRef.current === "all" || galaxy.categoryId === categoryFilterRef.current)
          .sort((left, right) => galaxyPositions.get(right.id)!.depth - galaxyPositions.get(left.id)!.depth);
        for (const galaxy of visibleGalaxies) {
          const point = galaxyPositions.get(galaxy.id)!;
          const isActive = activeGalaxyId === galaxy.id;
          if (activeGalaxyId && !isActive) continue;
          const inNebulaView = categoryFilterRef.current !== "all" && !activeGalaxyId;
          const hoveredGalaxy = hoveredRef.current?.kind === "galaxy" && hoveredRef.current.id === galaxy.id;
          const allViewFrame = categoryFrameById.get(galaxy.categoryId);
          const allViewBaseRadius = allViewFrame
            ? Math.max(9, Math.min(18, allViewFrame.radius * 0.16))
            : 12;
          const radius =
            (activeGalaxyId ? 150 : inNebulaView ? 58 : allViewBaseRadius) * point.perspective +
            Math.min(
              inNebulaView ? 18 : 4,
              Math.sqrt(galaxy.paperIds.length) * (inNebulaView ? 3.2 : 0.72),
            );
          drawGalaxy(galaxy, point, radius, activeGalaxyId ? 0.28 : hoveredGalaxy ? 0.98 : inNebulaView ? 0.86 : 0.58);
          if (!activeGalaxyId && inNebulaView) {
            context.save();
            context.textAlign = "center";
            context.font = "650 14px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
            context.fillStyle = hoveredGalaxy ? "rgba(255,255,255,.98)" : "rgba(245,245,247,.9)";
            context.shadowColor = "rgba(0,0,0,.9)";
            context.shadowBlur = 8;
            context.fillText(galaxy.name, point.x, point.y + radius * 0.62 + 18, 210);
            context.font = "500 11px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
            context.fillStyle = "rgba(235,235,245,.62)";
            context.fillText(`${galaxy.paperIds.length} ${galaxy.paperIds.length === 1 ? "paper" : "papers"}`, point.x, point.y + radius * 0.62 + 35);
            context.restore();
            projectedGalaxies.push({ id: galaxy.id, x: point.x, y: point.y, radius: Math.max(34, radius * 0.72) });
          }
        }

        if (categoryFilterRef.current !== "all" && !activeGalaxyId) {
          const category = getRenderCategory(categoryFilterRef.current);
          const point = project(category.center);
          const memoryItems = renderMemoriesByCategory.get(category.id) || [];
          const enabled = memoryItems.length > 0;
          const radius = 72 * point.perspective;
          if (blackHoleReady) {
            context.save();
            context.globalCompositeOperation = "screen";
            context.globalAlpha = enabled ? 0.94 : 0.48;
            context.drawImage(blackHoleSprite, point.x - radius * 1.55, point.y - radius * 0.87, radius * 3.1, radius * 1.74);
            context.restore();
          } else {
            const fallback = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
            fallback.addColorStop(0, "rgba(0,0,0,1)");
            fallback.addColorStop(0.36, "rgba(0,0,0,.98)");
            fallback.addColorStop(0.48, "rgba(255,145,66,.78)");
            fallback.addColorStop(0.68, "rgba(63,108,255,.26)");
            fallback.addColorStop(1, "rgba(0,0,0,0)");
            context.fillStyle = fallback;
            context.beginPath();
            context.arc(point.x, point.y, radius, 0, Math.PI * 2);
            context.fill();
          }
          context.save();
          context.textAlign = "center";
          context.font = "650 13px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
          context.fillStyle = enabled ? "rgba(245,245,247,.92)" : "rgba(235,235,245,.48)";
          context.shadowColor = "rgba(0,0,0,.9)";
          context.shadowBlur = 7;
          context.fillText(enabled ? `${memoryItems.length} Notes & Cards` : "No Notes", point.x, point.y + radius * 0.62 + 18);
          context.restore();
          projectedBlackHoles.push({ categoryId: category.id, x: point.x, y: point.y, radius: Math.max(34, radius * 0.7), enabled });
        }
      } else {
        const category = getRenderCategory(activeNotesCategoryId);
        const center = project(category.center);
        const memoryItems = renderMemoriesByCategory.get(category.id) || [];
        const blackHoleRadius = 110 * center.perspective;
        if (blackHoleReady) {
          context.save();
          context.globalCompositeOperation = "screen";
          context.globalAlpha = 0.96;
          context.drawImage(
            blackHoleSprite,
            center.x - blackHoleRadius * 1.65,
            center.y - blackHoleRadius * 0.93,
            blackHoleRadius * 3.3,
            blackHoleRadius * 1.86,
          );
          context.restore();
        }
        memoryItems.forEach((memory, index) => {
          const memoryId = memory.memoryId || memory.id || `memory-${index}`;
          const ring = index % 4;
          const orbitRadiusX = 132 + ring * 42;
          const orbitRadiusY = orbitRadiusX * (0.34 + ring * 0.025);
          const phase = (stableHash(`${memoryId}:orbit`) % 360) / 360 * Math.PI * 2;
          const direction = stableHash(`${memoryId}:direction`) % 2 ? 1 : -1;
          const angle = memoryOrbitAngle(phase, direction, time, ring, reducedMotion);
          if (index < 4) {
            context.save();
            context.strokeStyle = hexToRgba(category.color, 0.16);
            context.lineWidth = 0.7;
            context.setLineDash([3, 8]);
            context.beginPath();
            context.ellipse(center.x, center.y, orbitRadiusX, orbitRadiusY, ring * 0.12, 0, Math.PI * 2);
            context.stroke();
            context.restore();
          }
          const x = center.x + Math.cos(angle) * orbitRadiusX;
          const y = center.y + Math.sin(angle) * orbitRadiusY;
          const hoveredMemory = hoveredRef.current?.kind === "memory" && hoveredRef.current.id === memoryId;
          const selectedMemory = selectedMemoryRef.current === memoryId;
          const radius = hoveredMemory || selectedMemory ? 8.5 : 6.2;
          const glow = context.createRadialGradient(x, y, 0, x, y, radius * 4.2);
          glow.addColorStop(0, "rgba(255,255,255,.98)");
          glow.addColorStop(0.18, hexToRgba(category.color, 0.86));
          glow.addColorStop(1, hexToRgba(category.color, 0));
          context.save();
          context.globalCompositeOperation = "screen";
          context.fillStyle = glow;
          context.beginPath();
          context.arc(x, y, radius * 4.2, 0, Math.PI * 2);
          context.fill();
          context.restore();
          context.fillStyle = "rgba(255,255,255,.98)";
          context.beginPath();
          context.arc(x, y, 2.1, 0, Math.PI * 2);
          context.fill();
          if (hoveredMemory || selectedMemory) {
            context.save();
            context.font = "650 13px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
            context.fillStyle = "rgba(245,245,247,.96)";
            context.shadowColor = "rgba(0,0,0,.9)";
            context.shadowBlur = 8;
            context.fillText(memory.title || memory.statement || memory.type, x + 14, y + 4, 240);
            context.restore();
          }
          projectedMemoryStars.push({ id: memoryId, x, y, radius: 18 });
        });
      }

      // Paper stars remain a quiet visual cue before a galaxy is opened. They
      // are deliberately not added to projectedStars: the hierarchy stays
      // intact, so clicking here still selects a nebula or galaxy rather than
      // skipping directly to a paper.
      const showAmbientPaperFlashes = !activeGalaxyId && !activeNotesCategoryId;
      if (showAmbientPaperFlashes) {
        const focusedCategoryId = categoryFilterRef.current;
        const universeView = focusedCategoryId === "all";
        const ambientPaperIds = universeView
          ? renderUniverse.categories.flatMap(
              (category) => ambientPaperSelections.get(category.id)?.allView || [],
            )
          : ambientPaperSelections.get(focusedCategoryId)?.focused || [];
        context.save();
        context.globalCompositeOperation = "screen";
        for (const paperId of ambientPaperIds) {
          const paper = renderPapersById.get(paperId);
          if (!paper) continue;
          const rawPoint = positions.get(paper.id);
          const profile = paperFlashProfiles.get(paper.id);
          const categoryFrame = categoryFrameById.get(paper.primaryCategory);
          const point = rawPoint && categoryFrame
            ? containPointInNebulaEllipse(
                rawPoint,
                categoryFrame,
                universeView ? 0.76 : 0.82,
                universeView ? 0.48 : 0.52,
              )
            : rawPoint;
          if (!point || !profile || point.x < -20 || point.x > width + 20 || point.y < -20 || point.y > height + 20) {
            continue;
          }
          const category = getRenderCategory(paper.primaryCategory);
          const flashPeak = reducedMotion
            ? 0.58
            : Math.pow(
                (Math.sin(motionTime * 0.00105 * profile.speed + profile.phase) + 1) * 0.5,
                5,
              );
          const pulse = reducedMotion ? 0.68 : 0.44 + flashPeak * 0.56;
          const glowRadius =
            (universeView ? 8.2 : 11.5) *
            Math.max(0.72, point.perspective) *
            (0.9 + pulse * 0.18);
          context.globalAlpha = (universeView ? 0.34 : 0.5) * pulse;
          context.drawImage(
            starSprites.get(category.id)!,
            point.x - glowRadius,
            point.y - glowRadius,
            glowRadius * 2,
            glowRadius * 2,
          );
          context.globalAlpha = (universeView ? 0.72 : 0.88) * pulse;
          context.fillStyle = "rgba(249,252,255,.98)";
          context.beginPath();
          context.arc(
            point.x,
            point.y,
            Math.max(0.7, (universeView ? 0.9 : 1.15) * point.perspective),
            0,
            Math.PI * 2,
          );
          context.fill();
          if (profile.flare && (reducedMotion || flashPeak > 0.72)) {
            const flareRadius = glowRadius * (universeView ? 0.72 : 0.9);
            context.globalAlpha = reducedMotion ? 0.22 : 0.24 + flashPeak * 0.38;
            context.strokeStyle = hexToRgba(category.color, 0.86);
            context.lineWidth = 0.55;
            context.beginPath();
            context.moveTo(point.x - flareRadius, point.y);
            context.lineTo(point.x + flareRadius, point.y);
            context.moveTo(point.x, point.y - flareRadius * 0.62);
            context.lineTo(point.x, point.y + flareRadius * 0.62);
            context.stroke();
          }
        }
        context.restore();
      }
      projectedGalaxiesRef.current = projectedGalaxies;
      projectedBlackHolesRef.current = projectedBlackHoles;
      projectedMemoryStarsRef.current = projectedMemoryStars;

      const projectedStars: ProjectedStar[] = [];
      const regionLabelCandidates: Array<{
        paper: Paper;
        category: Category;
        point: ReturnType<typeof project>;
        radius: number;
        emphasized: boolean;
      }> = [];
      const depthSorted = [...renderUniverse.papers].sort(
        (left, right) => positions.get(right.id)!.depth - positions.get(left.id)!.depth,
      );
      for (const paper of depthSorted) {
        if (!visibleRef.current.has(paper.id)) continue;
        const basePoint = positions.get(paper.id)!;
        const shake = refreshShakeOffsets.get(paper.id);
        const point = shake
          ? { ...basePoint, x: basePoint.x + shake.x, y: basePoint.y + shake.y }
          : basePoint;
        const heat = heatRef.current[paper.id] ?? 0;
        const selected = selectedPaperRef.current === paper.id;
        const hoveredPaper =
          hoveredRef.current?.kind === "paper" && hoveredRef.current.id === paper.id;
        const category = getRenderCategory(paper.primaryCategory);
        const showRegionLabel =
          categoryFilterRef.current !== "all" &&
          paper.primaryCategory === categoryFilterRef.current;
        const radius =
          (4.5 + heat * 4.2 + (selected || hoveredPaper ? 2.2 : 0)) *
          point.perspective;
        const glowRadius = radius * (3.6 + heat * 0.95);
        const reveal = commitRevealRef.current;
        const starRevealAlpha =
          reveal?.paperIds.has(paper.id)
            ? Math.min(1, Math.max(0, (time - reveal.startedAt) / 720))
            : 1;
        context.save();
        context.globalCompositeOperation = "screen";
        context.globalAlpha = (selected || hoveredPaper ? 0.62 : 0.4) * starRevealAlpha;
        context.drawImage(
          starSprites.get(category.id)!,
          point.x - glowRadius,
          point.y - glowRadius,
          glowRadius * 2,
          glowRadius * 2,
        );
        if (suppliedStarReady) {
          const cinematicRadius = glowRadius * (selected || hoveredPaper ? 1.16 : 1.04);
          context.globalAlpha = (selected || hoveredPaper ? 1 : 0.92) * starRevealAlpha;
          context.drawImage(
            suppliedStarSprite,
            point.x - cinematicRadius,
            point.y - cinematicRadius,
            cinematicRadius * 2,
            cinematicRadius * 2,
          );
        }
        context.restore();
        context.fillStyle = selected || hoveredPaper
          ? `rgba(255,255,255,${starRevealAlpha})`
          : `rgba(244,249,255,${0.96 * starRevealAlpha})`;
        context.beginPath();
        context.arc(point.x, point.y, Math.max(1.45, radius * 0.38), 0, Math.PI * 2);
        context.fill();

        if (selected || hoveredPaper) {
          const ringPulse = Math.sin(motionTime * 0.003) * 1.6;
          context.strokeStyle = hexToRgba(category.color, 0.92);
          context.lineWidth = 1.15;
          context.shadowColor = hexToRgba(category.color, 0.9);
          context.shadowBlur = 12;
          context.beginPath();
          context.arc(
            point.x,
            point.y,
            radius + 8 + ringPulse,
            0,
            Math.PI * 2,
          );
          context.stroke();
          context.globalAlpha = 0.42;
          context.beginPath();
          context.arc(point.x, point.y, radius + 14 - ringPulse * 0.35, 0, Math.PI * 2);
          context.stroke();
          context.globalAlpha = 1;
          if (!showRegionLabel) {
            context.shadowBlur = 8;
            context.font = "650 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
            context.fillStyle = "rgba(244,248,255,.96)";
            context.fillText(paper.shortTitle, point.x + radius + 13, point.y + 5);
          }
          context.shadowBlur = 0;
        }
        if (showRegionLabel) {
          regionLabelCandidates.push({
            paper,
            category,
            point,
            radius,
            emphasized: selected || hoveredPaper,
          });
        }
        projectedStars.push({
          id: paper.id,
          x: point.x,
          y: point.y,
          radius: Math.max(17, radius + 9),
        });
      }

      for (const ghost of refreshGhosts) {
        const category =
          activeRefresh?.pending.stagedSnapshot.categories.find(
            (item) => item.id === ghost.paper.primaryCategory,
          ) || getRenderCategory(ghost.paper.primaryCategory);
        if (!category) continue;
        const shake = refreshShakeOffsets.get(ghost.paper.id);
        const point = shake
          ? { ...ghost.point, x: ghost.point.x + shake.x, y: ghost.point.y + shake.y }
          : ghost.point;
        const reduced = activeRefresh?.reducedMotion;
        const entrance = Math.min(1, ghost.elapsed / (reduced ? 320 : 440));
        const easedEntrance = 1 - Math.pow(1 - entrance, 3);
        const waveFade = Math.pow(Math.max(0, 1 - ghost.progress), 1.35);
        const maximumWaveRadius = Math.hypot(width, height) * 1.08;

        if (!reduced && ghost.progress < 1) {
          context.save();
          context.globalCompositeOperation = "screen";
          const waveRadius = maximumWaveRadius * ghost.progress;
          const waveGradient = context.createRadialGradient(
            point.x,
            point.y,
            Math.max(0, waveRadius - 18),
            point.x,
            point.y,
            waveRadius + 18,
          );
          waveGradient.addColorStop(0, hexToRgba(category.color, 0));
          waveGradient.addColorStop(0.46, hexToRgba(category.color, 0.12 * waveFade));
          waveGradient.addColorStop(0.5, `rgba(239,250,255,${0.9 * waveFade})`);
          waveGradient.addColorStop(0.55, hexToRgba(category.color, 0.28 * waveFade));
          waveGradient.addColorStop(1, hexToRgba(category.color, 0));
          context.fillStyle = waveGradient;
          context.beginPath();
          context.arc(point.x, point.y, waveRadius + 20, 0, Math.PI * 2);
          context.fill();
          context.strokeStyle = hexToRgba(category.color, 0.76 * waveFade);
          context.lineWidth = 1.2 + waveFade * 1.8;
          context.shadowColor = hexToRgba(category.color, 0.9);
          context.shadowBlur = 18;
          context.beginPath();
          context.arc(point.x, point.y, waveRadius, 0, Math.PI * 2);
          context.stroke();
          context.restore();
        }

        if (!reduced && ghost.elapsed < 620) {
          const burstProgress = Math.min(1, ghost.elapsed / 620);
          const sparkFade = Math.pow(1 - burstProgress, 1.6);
          context.save();
          context.translate(point.x, point.y);
          context.globalCompositeOperation = "lighter";
          context.strokeStyle = `rgba(236,249,255,${0.82 * sparkFade})`;
          context.shadowColor = category.color;
          context.shadowBlur = 13;
          for (let sparkIndex = 0; sparkIndex < 24; sparkIndex += 1) {
            const seed = stableHash(`${ghost.paper.id}:spark:${sparkIndex}`);
            const angle =
              (sparkIndex / 24) * Math.PI * 2 + ((seed % 1_000) / 1_000 - 0.5) * 0.24;
            const length =
              (18 + (seed % 29)) * (0.25 + burstProgress * 1.25);
            const inner = 5 + (seed % 7) * burstProgress;
            context.lineWidth = 0.55 + (seed % 5) * 0.16;
            context.beginPath();
            context.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
            context.lineTo(Math.cos(angle) * length, Math.sin(angle) * length);
            context.stroke();
          }
          context.restore();
        }

        const ghostRadius = (15 + easedEntrance * 13) * point.perspective;
        const ghostGlow = context.createRadialGradient(
          point.x,
          point.y,
          0,
          point.x,
          point.y,
          ghostRadius,
        );
        ghostGlow.addColorStop(0, `rgba(255,255,255,${0.98 * easedEntrance})`);
        ghostGlow.addColorStop(0.12, hexToRgba(category.color, 0.95 * easedEntrance));
        ghostGlow.addColorStop(0.48, hexToRgba(category.color, 0.36 * easedEntrance));
        ghostGlow.addColorStop(1, hexToRgba(category.color, 0));
        context.save();
        context.globalCompositeOperation = "lighter";
        context.fillStyle = ghostGlow;
        context.shadowColor = category.color;
        context.shadowBlur = reduced ? 12 : 24;
        context.beginPath();
        context.arc(point.x, point.y, ghostRadius, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = `rgba(255,255,255,${easedEntrance})`;
        context.beginPath();
        context.arc(point.x, point.y, Math.max(1.8, 3.2 * point.perspective), 0, Math.PI * 2);
        context.fill();
        context.restore();
      }
      projectedStarsRef.current = projectedStars;

      if (regionLabelCandidates.length > 0) {
        const occupied: Array<{ x: number; y: number; width: number; height: number }> = [];
        const labelHeight = 28;
        const viewportPadding = 16;
        const minimumY = 84;
        const maximumY = height - viewportPadding - labelHeight;
        const overlaps = (
          candidate: { x: number; y: number; width: number; height: number },
          existing: { x: number; y: number; width: number; height: number },
        ) =>
          !(
            candidate.x + candidate.width + 7 < existing.x ||
            existing.x + existing.width + 7 < candidate.x ||
            candidate.y + candidate.height + 6 < existing.y ||
            existing.y + existing.height + 6 < candidate.y
          );
        const clampPlacement = (x: number, y: number, labelWidth: number) => ({
          x: Math.max(
            viewportPadding,
            Math.min(width - viewportPadding - labelWidth, x),
          ),
          y: Math.max(minimumY, Math.min(maximumY, y)),
          width: labelWidth,
          height: labelHeight,
        });
        const roundedRectangle = (
          x: number,
          y: number,
          rectangleWidth: number,
          rectangleHeight: number,
          radius: number,
        ) => {
          context.beginPath();
          context.moveTo(x + radius, y);
          context.lineTo(x + rectangleWidth - radius, y);
          context.quadraticCurveTo(x + rectangleWidth, y, x + rectangleWidth, y + radius);
          context.lineTo(x + rectangleWidth, y + rectangleHeight - radius);
          context.quadraticCurveTo(
            x + rectangleWidth,
            y + rectangleHeight,
            x + rectangleWidth - radius,
            y + rectangleHeight,
          );
          context.lineTo(x + radius, y + rectangleHeight);
          context.quadraticCurveTo(x, y + rectangleHeight, x, y + rectangleHeight - radius);
          context.lineTo(x, y + radius);
          context.quadraticCurveTo(x, y, x + radius, y);
          context.closePath();
        };

        context.save();
        context.font = "650 13px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
        for (const label of [...regionLabelCandidates].sort(
          (left, right) => left.point.y - right.point.y,
        )) {
          const labelWidth = Math.min(
            190,
            Math.max(88, context.measureText(label.paper.shortTitle).width + 34),
          );
          const rightFirst = stableHash(`${label.paper.id}:label-side`) % 2 === 0;
          const sideOrder = rightFirst ? [1, -1] : [-1, 1];
          const verticalOffsets = [0, -31, 31, -62, 62, -93, 93];
          const placements: Array<{ x: number; y: number; width: number; height: number }> = [];
          for (const side of sideOrder) {
            for (const offset of verticalOffsets) {
              placements.push(
                clampPlacement(
                  side > 0
                    ? label.point.x + label.radius + 18
                    : label.point.x - label.radius - labelWidth - 18,
                  label.point.y - labelHeight * 0.5 + offset,
                  labelWidth,
                ),
              );
            }
          }
          placements.push(
            clampPlacement(
              label.point.x - labelWidth * 0.5,
              label.point.y - label.radius - labelHeight - 18,
              labelWidth,
            ),
            clampPlacement(
              label.point.x - labelWidth * 0.5,
              label.point.y + label.radius + 18,
              labelWidth,
            ),
          );
          let placement = placements.find(
            (candidate) => !occupied.some((existing) => overlaps(candidate, existing)),
          );
          if (!placement) {
            for (
              let laneY = minimumY;
              laneY <= maximumY && !placement;
              laneY += labelHeight + 8
            ) {
              for (const side of sideOrder) {
                const lane = clampPlacement(
                  side > 0
                    ? label.point.x + label.radius + 18
                    : label.point.x - label.radius - labelWidth - 18,
                  laneY,
                  labelWidth,
                );
                if (!occupied.some((existing) => overlaps(lane, existing))) {
                  placement = lane;
                  break;
                }
              }
            }
          }
          placement ||= placements[0];
          occupied.push(placement);

          const centerX = placement.x + placement.width * 0.5;
          const centerY = placement.y + placement.height * 0.5;
          const deltaX = centerX - label.point.x;
          const deltaY = centerY - label.point.y;
          const horizontalConnector = Math.abs(deltaX) >= Math.abs(deltaY);
          const connectorX = horizontalConnector
            ? deltaX > 0
              ? placement.x
              : placement.x + placement.width
            : Math.max(
                placement.x + 8,
                Math.min(placement.x + placement.width - 8, label.point.x),
              );
          const connectorY = horizontalConnector
            ? Math.max(
                placement.y + 6,
                Math.min(placement.y + placement.height - 6, label.point.y),
              )
            : deltaY > 0
              ? placement.y
              : placement.y + placement.height;

          context.strokeStyle = hexToRgba(
            label.category.color,
            label.emphasized ? 0.9 : 0.5,
          );
          context.lineWidth = label.emphasized ? 1.2 : 0.8;
          context.shadowColor = hexToRgba(label.category.color, 0.72);
          context.shadowBlur = label.emphasized ? 12 : 6;
          context.beginPath();
          context.moveTo(label.point.x, label.point.y);
          context.lineTo(connectorX, connectorY);
          context.stroke();

          roundedRectangle(
            placement.x,
            placement.y,
            placement.width,
            placement.height,
            8,
          );
          context.fillStyle = label.emphasized
            ? "rgba(9,17,36,.94)"
            : "rgba(5,11,25,.84)";
          context.fill();
          context.strokeStyle = hexToRgba(
            label.category.color,
            label.emphasized ? 0.88 : 0.48,
          );
          context.lineWidth = label.emphasized ? 1.15 : 0.75;
          context.stroke();

          context.shadowBlur = label.emphasized ? 8 : 3;
          context.fillStyle = hexToRgba(label.category.color, 0.95);
          context.beginPath();
          context.arc(placement.x + 12, centerY, 2.25, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = "rgba(244,249,255,.96)";
          context.fillText(
            label.paper.shortTitle,
            placement.x + 21,
            placement.y + 18.5,
            placement.width - 28,
          );
        }
        context.restore();
      }

      // The camera remains fixed unless the user explicitly drags the universe.
      frame = window.requestAnimationFrame(render);
    };

    resize();
    const handleVisibilityChange = () => {
      if (document.hidden) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      } else if (frame === 0) {
        frame = window.requestAnimationFrame(render);
      }
    };
    const handleFocus = () => {
      windowFocused = true;
      lastRenderedAt = Number.NEGATIVE_INFINITY;
      if (frame === 0) frame = window.requestAnimationFrame(render);
    };
    const handleBlur = () => {
      windowFocused = false;
    };
    window.addEventListener("resize", resize);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    frame = window.requestAnimationFrame(render);
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      suppliedStarSource.onload = null;
      suppliedStarSource.removeAttribute("src");
      blackHoleSource.onload = null;
      blackHoleSource.removeAttribute("src");
      for (const source of galaxySources) {
        source.onload = null;
        source.removeAttribute("src");
      }
      for (const source of regionNebulaSources) {
        source.onload = null;
        source.removeAttribute("src");
      }
      window.cancelAnimationFrame(frame);
      // Explicitly release offscreen bitmap backing stores. The render effect
      // can be rebuilt after a region/filter change, and waiting for a later GC
      // cycle would otherwise create large temporary memory spikes.
      backdropCanvas.width = 0;
      backdropCanvas.height = 0;
      suppliedStarSprite.width = 0;
      suppliedStarSprite.height = 0;
      blackHoleSprite.width = 0;
      blackHoleSprite.height = 0;
      for (const sprite of galaxySprites.values()) {
        sprite.width = 0;
        sprite.height = 0;
      }
      galaxySprites.clear();
      for (const sprite of starSprites.values()) {
        sprite.width = 0;
        sprite.height = 0;
      }
      for (const texture of nebulaTextures.values()) {
        texture.width = 0;
        texture.height = 0;
      }
      for (const sprite of regionNebulaSprites.values()) {
        sprite.width = 0;
        sprite.height = 0;
      }
      regionNebulaSprites.clear();
    };
  }, [renderResourceFingerprint]);

  const findTarget = useCallback((clientX: number, clientY: number): HitTarget => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const point = { x: clientX - rect.left, y: clientY - rect.top };

    let nearestStar: { id: string; distance: number } | null = null;
    for (const star of projectedStarsRef.current) {
      const distance = Math.hypot(star.x - point.x, star.y - point.y);
      if (distance <= star.radius && (!nearestStar || distance < nearestStar.distance)) {
        nearestStar = { id: star.id, distance };
      }
    }
    if (nearestStar) return { kind: "paper", id: nearestStar.id };

    let nearestMemory: { id: string; distance: number } | null = null;
    for (const memory of projectedMemoryStarsRef.current) {
      const distance = Math.hypot(memory.x - point.x, memory.y - point.y);
      if (distance <= memory.radius && (!nearestMemory || distance < nearestMemory.distance)) {
        nearestMemory = { id: memory.id, distance };
      }
    }
    if (nearestMemory) return { kind: "memory", id: nearestMemory.id };

    let nearestGalaxy: { id: string; distance: number } | null = null;
    for (const galaxy of projectedGalaxiesRef.current) {
      const distance = Math.hypot(galaxy.x - point.x, galaxy.y - point.y);
      if (distance <= galaxy.radius && (!nearestGalaxy || distance < nearestGalaxy.distance)) {
        nearestGalaxy = { id: galaxy.id, distance };
      }
    }
    if (nearestGalaxy) return { kind: "galaxy", id: nearestGalaxy.id };

    let nearestBlackHole: { categoryId: string; distance: number } | null = null;
    for (const blackHole of projectedBlackHolesRef.current) {
      if (!blackHole.enabled) continue;
      const distance = Math.hypot(blackHole.x - point.x, blackHole.y - point.y);
      if (distance <= blackHole.radius && (!nearestBlackHole || distance < nearestBlackHole.distance)) {
        nearestBlackHole = { categoryId: blackHole.categoryId, distance };
      }
    }
    if (nearestBlackHole) {
      return { kind: "black-hole", categoryId: nearestBlackHole.categoryId };
    }

    let nearestRelation: { key: string; distance: number } | null = null;
    for (const relation of projectedRelationsRef.current) {
      let minimum = Number.POSITIVE_INFINITY;
      for (let index = 1; index < relation.points.length; index += 1) {
        minimum = Math.min(
          minimum,
          distanceToSegment(point, relation.points[index - 1], relation.points[index]),
        );
      }
      if (
        minimum <= relation.hitWidth &&
        (!nearestRelation || minimum < nearestRelation.distance)
      ) {
        nearestRelation = { key: relation.key, distance: minimum };
      }
    }
    if (nearestRelation) return { kind: "relation", key: nearestRelation.key };

    let nearestRegion: { id: string; distance: number } | null = null;
    for (const region of projectedRegionsRef.current) {
      const dx = point.x - region.x;
      const dy = point.y - region.y;
      const cos = Math.cos(region.rotation);
      const sin = Math.sin(region.rotation);
      const localX = dx * cos + dy * sin;
      const localY = -dx * sin + dy * cos;
      const normalizedDistance = Math.hypot(
        localX / region.radiusX,
        localY / region.radiusY,
      );
      if (
        normalizedDistance <= 1 &&
        (!nearestRegion || normalizedDistance < nearestRegion.distance)
      ) {
        nearestRegion = { id: region.id, distance: normalizedDistance };
      }
    }
    return nearestRegion ? { kind: "category", id: nearestRegion.id } : null;
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    setKeyboardFocus(null);
    pendingPointerHitRef.current = null;
    if (pointerHitFrameRef.current) {
      window.cancelAnimationFrame(pointerHitFrameRef.current);
      pointerHitFrameRef.current = 0;
    }
    // The render loop continuously stores the visible interpolated camera.
    // Cancelling here preserves that exact frame instead of snapping to the
    // transition target before a drag begins.
    cameraTransitionRef.current = null;
    pointerRef.current = {
      down: true,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current.down) {
      const dx = event.clientX - pointerRef.current.x;
      const dy = event.clientY - pointerRef.current.y;
      if (Math.hypot(
        event.clientX - pointerRef.current.startX,
        event.clientY - pointerRef.current.startY,
      ) > 8) pointerRef.current.moved = true;
      rotationRef.current.y += dx * 0.006;
      rotationRef.current.x = Math.max(
        -0.72,
        Math.min(0.72, rotationRef.current.x + dy * 0.004),
      );
      pointerRef.current.x = event.clientX;
      pointerRef.current.y = event.clientY;
      return;
    }
    pendingPointerHitRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      canvas: event.currentTarget,
    };
    if (pointerHitFrameRef.current) return;
    pointerHitFrameRef.current = window.requestAnimationFrame(() => {
      pointerHitFrameRef.current = 0;
      const pending = pendingPointerHitRef.current;
      pendingPointerHitRef.current = null;
      if (!pending) return;
      const target = findTarget(pending.clientX, pending.clientY);
      if (!sameCanvasTarget(hoveredRef.current, target)) {
        setKeyboardFocus(null);
        hoveredRef.current = target;
        setHovered(target);
      }
      pending.canvas.dataset.interactive = target ? "true" : "false";
    });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const moved = pointerRef.current.moved;
    pointerRef.current.down = false;
    if (moved) return;
    const target = findTarget(event.clientX, event.clientY);
    if (target?.kind === "paper") {
      selectPaper(target.id);
    } else if (target?.kind === "memory") {
      selectMemoryDocument(target.id);
    } else if (target?.kind === "galaxy") {
      focusGalaxy(target.id);
    } else if (target?.kind === "black-hole") {
      focusNotes(target.categoryId);
    } else if (target?.kind === "relation") {
      setSettingsOpen(false);
      setSelectedRelationKey(target.key);
      setSelectedPaperId(null);
    } else if (target?.kind === "category") {
      focusCategory(target.id);
    } else {
      setSelectedPaperId(null);
      setSelectedRelationKey(null);
    }
  };

  const setUniverseZoom = (value: number) => {
    cameraTransitionRef.current = null;
    const bounded = Math.max(0.68, Math.min(3.2, value));
    zoomRef.current = bounded;
    setZoomLevel(bounded);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    setUniverseZoom(zoomRef.current - event.deltaY * 0.0008);
  };

  const selectPaper = (id: string) => {
    const galaxy = galaxyHierarchy.galaxyByPaperId.get(id);
    if (galaxy && selectedGalaxyId !== galaxy.id) focusGalaxy(galaxy.id);
    const bridge = getNativeBridge();
    bridge?.postMessage({ action: "loadAnnotations" });
    bridge?.postMessage({ action: "loadUniverse" });
    setSettingsOpen(false);
    setSelectedPaperId(id);
    setSelectedMemoryId(null);
    setSelectedRelationKey(null);
    setQuery("");
    setDrawerTab("summary");
    setEditingAnnotationId(null);
    setAnnotationDraft("");
  };

  const selectMemoryDocument = (id: string) => {
    const memory = (workspace.projectMemory.items as PersonalMemory[]).find(
      (item) => (item.memoryId || item.id) === id,
    );
    if (!memory) return;
    setSettingsOpen(false);
    setSelectedMemoryId(id);
    setSelectedPaperId(null);
    setSelectedRelationKey(null);
    const categoryId = memory.scope?.categoryId || memory.scope?.regionId ||
      memory.source?.categoryId || memory.source?.regionId || notesCategoryId;
    const bridge = getNativeBridge();
    if (bridge && categoryId) {
      bridge.postMessage({
        action: "loadRegionDocument",
        projectId: workspace.projects.activeProjectId,
        expectedMemoryRevision: workspace.projectMemory.revision,
        expectedGraphRevision: universe.revision ?? 0,
        categoryId,
        memoryId: id,
      });
    }
  };

  const focusCanvasKeyboardTarget = (target: CanvasTarget | null) => {
    if (!target) return;
    const index = canvasKeyboardItems.findIndex((item) => sameCanvasTarget(item.target, target));
    if (index < 0) return;
    setKeyboardFocus(target);
    hoveredRef.current = target;
    setHovered(target);
    setKeyboardAnnouncement(
      `${canvasKeyboardItems[index].label} Item ${index + 1} of ${canvasKeyboardItems.length}.`,
    );
  };

  const activateCanvasKeyboardTarget = (target: CanvasTarget) => {
    const item = canvasKeyboardItems.find((candidate) => sameCanvasTarget(candidate.target, target));
    if (!canActivateCanvasTarget(target, noteCountByCategory)) {
      setKeyboardAnnouncement(`${item?.label || "Knowledge black hole."} It cannot be opened.`);
      return;
    }
    if (target.kind === "paper") selectPaper(target.id);
    else if (target.kind === "memory") selectMemoryDocument(target.id);
    else if (target.kind === "galaxy") focusGalaxy(target.id);
    else if (target.kind === "black-hole") focusNotes(target.categoryId);
    else if (target.kind === "relation") {
      setSettingsOpen(false);
      setSelectedRelationKey(target.key);
      setSelectedPaperId(null);
    } else focusCategory(target.id);
    setKeyboardAnnouncement(`Opened ${item?.label || "the focused universe item"}`);
  };

  const handleCanvasKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const key = event.key;
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(key)) {
      event.preventDefault();
      if (canvasKeyboardItems.length === 0) {
        setKeyboardAnnouncement("No interactive items are available in this view.");
        return;
      }
      let target: CanvasTarget | null;
      if (key === "Home") target = canvasKeyboardItems[0].target;
      else if (key === "End") target = canvasKeyboardItems[canvasKeyboardItems.length - 1].target;
      else target = cycleCanvasTarget(
        canvasKeyboardItems.map((item) => item.target),
        keyboardFocus,
        key === "ArrowRight" || key === "ArrowDown" ? 1 : -1,
      );
      focusCanvasKeyboardTarget(target);
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (keyboardFocus) activateCanvasKeyboardTarget(keyboardFocus);
      else if (canvasKeyboardItems[0]) focusCanvasKeyboardTarget(canvasKeyboardItems[0].target);
      return;
    }
    if (key === "Escape") {
      const action = canvasBackAction({
        categoryFilter,
        selectedGalaxyId,
        notesCategoryId,
        selectedPaperId,
        selectedMemoryId,
        selectedRelationKey,
      });
      if (action === "none") return;
      event.preventDefault();
      setKeyboardFocus(null);
      hoveredRef.current = null;
      setHovered(null);
      goBack(true);
      setKeyboardAnnouncement("Moved back one level.");
    }
  };

  const selectSearchResult = (id: string) => {
    const paper = paperById.get(id);
    if (!paper) {
      setLiteratureSearchError("This paper is indexed but not yet in the current universe. Refresh before locating it.");
      return;
    }
    selectPaper(id);
  };

  const copyText = async (value: string, kind: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1400);
  };

  const openLocalFile = (path: string) => {
    const handler = getNativeBridge();
    if (handler) handler.postMessage({ action: "open", path });
    else void copyText(path, "path");
  };

  const saveAnnotation = () => {
    if (!selectedPaper || !annotationDraft.trim()) return;
    const originalDraft = annotationDraft;
    const originalEditingId = editingAnnotationId;
    const now = new Date().toISOString();
    const existing = editingAnnotationId
      ? annotations.find((annotation) => annotation.id === editingAnnotationId)
      : undefined;
    const annotation: Annotation = {
      id:
        existing?.id ||
        `${selectedPaper.id}-${now.replace(/\D/g, "")}-${annotations.length.toString(36)}`,
      paperId: selectedPaper.id,
      paperTitle: selectedPaper.title,
      text: annotationDraft.trim(),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      status: "pending",
      revision: (existing?.revision || 0) + 1,
    };
    const next = existing
      ? annotations.map((item) => (item.id === annotation.id ? annotation : item))
      : [...annotations, annotation];
    pendingAnnotationSaveRef.current = {
      previous: annotations,
      draft: originalDraft,
      editingId: originalEditingId,
    };
    setAnnotationError("");
    setAnnotations(next);
    window.localStorage.setItem("liteverse-annotations-cache", JSON.stringify(next));
    setAnnotationDraft("");
    setEditingAnnotationId(null);
    setAnnotationSaveState("saving");

    const bridge = getNativeBridge();
    if (bridge) {
      bridge.postMessage({ action: "saveAnnotation", annotation });
    } else {
      pendingAnnotationSaveRef.current = null;
      setAnnotationSaveState("saved");
      window.setTimeout(() => setAnnotationSaveState("idle"), 1600);
    }
  };

  const editAnnotation = (annotation: Annotation) => {
    setEditingAnnotationId(annotation.id);
    setAnnotationDraft(annotation.text);
    setDrawerTab("notes");
  };

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    window.requestAnimationFrame(() => settingsButtonRef.current?.focus());
  }, []);

  const openSettings = (requestedTab: SettingsTab = "literature") => {
    getNativeBridge()?.postMessage({ action: "loadWorkspace" });
    getNativeBridge()?.postMessage({ action: "loadWorkspaceHealth" });
    setSelectedPaperId(null);
    setSelectedRelationKey(null);
    setWorkspaceError("");
    setWorkspaceNotice("");
    setSettingsRequestedTab(requestedTab);
    setSettingsOpen(true);
  };

  const persistFallbackWorkspace = (nextWorkspace: WorkspaceState) => {
    setWorkspace(nextWorkspace);
    window.localStorage.setItem(
      "liteverse-workspace-cache",
      JSON.stringify(nextWorkspace),
    );
  };

  const pickLiteraturePDF = () => {
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (!bridge) {
      setWorkspaceError("PDF import is available in the Liteverse macOS app.");
      return;
    }
    pendingWorkspaceActionRef.current = "pdf";
    setWorkspaceBusyAction("pdf");
    bridge.postMessage({ action: "pickLiteraturePDF" });
  };

  const pickLiteratureFolder = () => {
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (!bridge) {
      setWorkspaceError("Linked-folder import is available in the Liteverse macOS app.");
      return;
    }
    pendingWorkspaceActionRef.current = "folder";
    setWorkspaceBusyAction("folder");
    bridge.postMessage({ action: "pickLiteratureFolder" });
  };

  const pickZoteroLibrary = () => {
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (!bridge) {
      setWorkspaceError("Zotero connection is available in the Liteverse macOS app.");
      return;
    }
    pendingWorkspaceActionRef.current = "folder";
    setWorkspaceBusyAction("folder");
    bridge.postMessage({ action: "pickZoteroLibrary" });
  };

  const saveArxivEntry = (rawValue: string) => {
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (bridge) {
      pendingWorkspaceActionRef.current = "arxiv";
      setWorkspaceBusyAction("arxiv");
      bridge.postMessage({ action: "saveArxiv", value: rawValue });
      return;
    }

    const arxivId = normalizeArxivInput(rawValue);
    const existing = workspace.library.items.find((item) => item.arxivId === arxivId);
    if (existing) {
      setWorkspaceNotice(`${existing.displayTitle} is already in the library.`);
      return;
    }
    const now = new Date().toISOString();
    const number = workspace.library.nextNumber;
    const item: LibraryItem = {
      id: `lit-${crypto.randomUUID()}`,
      number,
      sourceType: "arxiv",
      displayTitle: `arXiv ${arxivId} (title awaiting lookup)`,
      titleStatus: "pending",
      arxivId,
      arxivUrl: `https://arxiv.org/abs/${arxivId}`,
      status: "pending_codex",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    persistFallbackWorkspace({
      ...workspace,
      library: {
        ...workspace.library,
        nextNumber: number + 1,
        items: [...workspace.library.items, item],
      },
    });
    setWorkspaceNotice("The arXiv link was saved in this browser and is awaiting Codex curation.");
  };

  const updateResearchDraft = (value: string) => {
    researchDraftDirtyRef.current = true;
    setResearchDraft(value);
  };

  const saveResearchInformation = () => {
    const text = researchTextForSave(researchDraft);
    if (text === undefined) return;
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (bridge) {
      pendingWorkspaceActionRef.current = "research";
      setWorkspaceBusyAction("research");
      bridge.postMessage({
        action: "saveResearchInformation",
        text,
        projectId: workspace.projects.activeProjectId,
        expectedRevision: workspace.researchInformation.draft.revision,
      });
      return;
    }

    const now = new Date().toISOString();
    const research = workspace.researchInformation;
    const revision = research.draft.revision + 1;
    const cachedHistory = window.localStorage.getItem("liteverse-research-history");
    let history: Array<{ revision: number; text: string; updatedAt: string }> = [];
    if (cachedHistory) {
      try {
        history = JSON.parse(cachedHistory);
      } catch {
        window.localStorage.removeItem("liteverse-research-history");
      }
    }
    window.localStorage.setItem(
      "liteverse-research-history",
      JSON.stringify([...history, { revision, text, updatedAt: now }]),
    );
    const nextWorkspace: WorkspaceState = {
      ...workspace,
      researchInformation: {
        ...research,
        status: "organized",
        draft: {
          text,
          revision,
          updatedAt: now,
        },
        formal: {
          text,
          sourceRevision: revision,
          organizedAt: now,
        },
      },
    };
    researchDraftDirtyRef.current = false;
    persistFallbackWorkspace(nextWorkspace);
    setWorkspaceNotice("Research memory was updated and saved on this device.");
  };

  const saveRegionDocument = (input: {
    categoryId: string;
    kind: "note" | "knowledge_card";
    format: "markdown" | "plain_text";
    title: string;
    content: string;
  }) => {
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (!bridge) {
      setWorkspaceError("Nebula Notes and Knowledge Cards are available in the Liteverse macOS app.");
      return;
    }
    pendingWorkspaceActionRef.current = "memory-document";
    setWorkspaceBusyAction("memory-document");
    bridge.postMessage({
      action: "saveRegionDocument",
      projectId: workspace.projects.activeProjectId,
      expectedMemoryRevision: workspace.projectMemory.revision,
      expectedGraphRevision: universe.revision ?? 0,
      categoryId: input.categoryId,
      kind: input.kind,
      format: input.format,
      title: input.title,
      content: input.content,
    });
  };

  const importRegionDocument = (input: {
    categoryId: string;
    kind: "note" | "knowledge_card";
  }) => {
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (!bridge) {
      setWorkspaceError("Local .md and .txt import is available in the Liteverse macOS app.");
      return;
    }
    pendingWorkspaceActionRef.current = "memory-document";
    setWorkspaceBusyAction("memory-document");
    bridge.postMessage({
      action: "importRegionDocumentFile",
      projectId: workspace.projects.activeProjectId,
      expectedMemoryRevision: workspace.projectMemory.revision,
      expectedGraphRevision: universe.revision ?? 0,
      categoryId: input.categoryId,
      kind: input.kind,
    });
  };

  const selectProject = (projectId: string) => {
    if (!projectId || projectId === workspace.projects.activeProjectId) return;
    contextPreviewRequestRef.current = null;
    contextPreviewProjectRef.current = null;
    if (contextPreviewTimeoutRef.current !== null) {
      window.clearTimeout(contextPreviewTimeoutRef.current);
      contextPreviewTimeoutRef.current = null;
    }
    setLocalContextPreview(null);
    setContextPreviewBusy(false);
    setContextPreviewError("");
    researchDraftDirtyRef.current = false;
    setResearchDraft("");
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (bridge) {
      bridge.postMessage({ action: "setActiveProject", projectId });
      return;
    }
    const next = normalizeWorkspaceState({
      ...workspace,
      projects: { ...workspace.projects, activeProjectId: projectId },
      projectMemory: { revision: 0, items: [] },
      tasks: [],
      contextPacks: [],
      artifacts: [],
      projectUseCounts: {},
    });
    researchDraftDirtyRef.current = false;
    setResearchDraft("");
    persistFallbackWorkspace(next);
  };

  const createProject = (name: string) => {
    const normalizedName = name.trim();
    if (!normalizedName) return;
    contextPreviewRequestRef.current = null;
    contextPreviewProjectRef.current = null;
    if (contextPreviewTimeoutRef.current !== null) {
      window.clearTimeout(contextPreviewTimeoutRef.current);
      contextPreviewTimeoutRef.current = null;
    }
    setLocalContextPreview(null);
    setContextPreviewBusy(false);
    setContextPreviewError("");
    researchDraftDirtyRef.current = false;
    setResearchDraft("");
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (bridge) {
      bridge.postMessage({ action: "createProject", name: normalizedName });
      return;
    }
    const now = new Date().toISOString();
    const id = `project-${crypto.randomUUID().slice(0, 8)}`;
    persistFallbackWorkspace(normalizeWorkspaceState({
      ...workspace,
      projects: {
        ...workspace.projects,
        activeProjectId: id,
        items: [...workspace.projects.items, { id, name: normalizedName, createdAt: now, updatedAt: now }],
      },
      projectMemory: { revision: 0, items: [] },
      tasks: [],
      contextPacks: [],
      artifacts: [],
      projectUseCounts: {},
    }));
    setResearchDraft("");
  };

  const buildContextPreview = (contextQuery: string, budgetChars: number) => {
    const queryText = contextQuery.trim();
    if (!queryText) return;
    const bridge = getNativeBridge();
    if (!bridge) {
      contextPreviewRequestRef.current = null;
      contextPreviewProjectRef.current = null;
      setContextPreviewBusy(false);
      setContextPreviewError("Local Context Preview is available in the Liteverse macOS app.");
      return;
    }
    const requestId = crypto.randomUUID();
    if (contextPreviewTimeoutRef.current !== null) {
      window.clearTimeout(contextPreviewTimeoutRef.current);
    }
    contextPreviewRequestRef.current = requestId;
    contextPreviewProjectRef.current = workspace.projects.activeProjectId;
    setContextPreviewError("");
    setContextPreviewBusy(true);
    contextPreviewTimeoutRef.current = window.setTimeout(() => {
      if (contextPreviewRequestRef.current !== requestId) return;
      contextPreviewTimeoutRef.current = null;
      contextPreviewRequestRef.current = null;
      contextPreviewProjectRef.current = null;
      setContextPreviewBusy(false);
      setContextPreviewError("Local Context Preview timed out after 10 seconds. No evidence was adopted and Usage was not changed.");
    }, 10_000);
    bridge.postMessage({
      action: "buildContextPreview",
      requestId,
      projectId: workspace.projects.activeProjectId,
      query: queryText,
      budgetChars,
    });
  };

  const queueContextRequest = (contextQuery: string, budgetChars: number) => {
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (!bridge) {
      setWorkspaceNotice("The context request remains in this view. Use the Liteverse macOS app to save it to the CLI queue.");
      return;
    }
    bridge.postMessage({
      action: "saveContextRequest",
      projectId: workspace.projects.activeProjectId,
      query: contextQuery,
      budgetChars,
    });
  };

  const searchLiteratureIndex = (searchQuery: string) => {
    const queryText = searchQuery.trim();
    if (!queryText) return;
    const bridge = getNativeBridge();
    if (!bridge) {
      setLiteratureSearch(null);
      setLiteratureSearchBusy(false);
      setLiteratureSearchError("Unified FTS5/BM25 search is available in the Liteverse macOS app.");
      return;
    }
    const requestId = crypto.randomUUID();
    if (literatureSearchTimeoutRef.current !== null) {
      window.clearTimeout(literatureSearchTimeoutRef.current);
    }
    literatureSearchRequestRef.current = requestId;
    setLiteratureSearch(null);
    setLiteratureSearchError("");
    setLiteratureSearchBusy(true);
    literatureSearchTimeoutRef.current = window.setTimeout(() => {
      if (literatureSearchRequestRef.current !== requestId) return;
      literatureSearchTimeoutRef.current = null;
      setLiteratureSearchBusy(false);
      setLiteratureSearchError("Local search timed out after 10 seconds. The index was not modified; retry or run `liteverse doctor`.");
    }, 10_000);
    bridge.postMessage({
      action: "searchLiterature",
      requestId,
      query: queryText,
      limit: 12,
    });
  };

  const loadKnowledgeCard = (paper: Paper) => {
    setKnowledgeCard(null);
    setKnowledgeCardLoading(true);
    const bridge = getNativeBridge();
    if (!bridge) {
      setKnowledgeCardLoading(false);
      return;
    }
    bridge.postMessage({
      action: "loadKnowledgeCard",
      paperId: paper.id,
      path: paperCardPath(paper),
      expectedSha256: paper.artifacts?.integrity?.cardSha256,
    });
  };

  const openLibraryItem = (item: LibraryItem) => {
    if (item.catalogSource === "universe" && item.localPath) {
      openLocalFile(item.localPath);
      return;
    }
    const bridge = getNativeBridge();
    if (bridge) {
      bridge.postMessage({
        action: item.sourceType === "pdf" ? "openLibraryItem" : "openExternalArxiv",
        id: item.id,
      });
    } else if (item.arxivUrl) {
      window.open(item.arxivUrl, "_blank", "noopener,noreferrer");
    }
  };

  const retryLocalPreparation = (item: LibraryItem) => {
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (!bridge) {
      setWorkspaceError("Local preparation retry is available in the Liteverse macOS app.");
      return;
    }
    bridge.postMessage({
      action: "retryLocalPreparation",
      itemId: item.id,
      expectedRevision: item.revision,
    });
    setWorkspaceNotice(`Retrying deterministic local preparation for ${item.displayTitle}…`);
  };

  const exportWorkspace = (includePDFs: boolean) => {
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (!bridge) {
      setWorkspaceError("Workspace export is available in the Liteverse macOS app.");
      return;
    }
    bridge.postMessage({ action: "exportWorkspace", includePDFs });
  };

  const importWorkspace = () => {
    setWorkspaceError("");
    setWorkspaceNotice("");
    const bridge = getNativeBridge();
    if (!bridge) {
      setWorkspaceError("Backup recovery is available in the Liteverse macOS app.");
      return;
    }
    bridge.postMessage({ action: "importWorkspace" });
  };

  return (
    <main
      className={`universe-shell ${settingsOpen ? "has-settings-open" : ""} ${
        selectedPaper ? "has-paper-open" : ""
      } ${selectedBundle ? "has-relation-open" : ""} ${
        selectedMemory ? "has-memory-open" : ""
      } ${
        refreshPhase !== "idle" ? `is-refresh-${refreshPhase}` : ""
      }`}
    >
      {/* The supplied nebula remains an exact local asset; blur is applied at runtime. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="nebula-backdrop" src="./liteverse-nebula.png" alt="" aria-hidden="true" />
      <canvas
        ref={canvasRef}
        className="universe-canvas"
        role="application"
        aria-roledescription="interactive literature map"
        aria-describedby="universe-keyboard-help"
        aria-keyshortcuts="ArrowRight ArrowLeft ArrowDown ArrowUp Home End Enter Space Escape"
        aria-label={
          viewLevel === "universe"
            ? "Liteverse 3D literature universe. Select a nebula to enter its galaxy network."
            : viewLevel === "galaxies"
              ? `${getCategory(categoryFilter)?.name || "Literature"} galaxy network. Select a galaxy for its paper stars, or its black hole for Notes and Knowledge Cards.`
              : viewLevel === "papers"
                ? `${selectedGalaxy?.name || "Research galaxy"}, showing ${visiblePapers.length} paper ${visiblePapers.length === 1 ? "star" : "stars"}.`
                : `${getCategory(notesCategoryId || categoryFilter)?.name || "Literature"} personal knowledge orbit, showing ${sceneObjectCount} ${sceneObjectNoun}.`
        }
        tabIndex={0}
        onFocus={() => {
          if (!keyboardAnnouncement) {
            setKeyboardAnnouncement("Interactive literature map. Use arrow keys to move through visible items, Enter or Space to open, and Escape to go back.");
          }
        }}
        onBlur={() => {
          setKeyboardFocus(null);
          if (keyboardFocus && sameCanvasTarget(hoveredRef.current, keyboardFocus)) {
            hoveredRef.current = null;
            setHovered(null);
          }
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          pointerRef.current.down = false;
        }}
        onPointerLeave={(event) => {
          pendingPointerHitRef.current = null;
          if (pointerHitFrameRef.current) {
            window.cancelAnimationFrame(pointerHitFrameRef.current);
            pointerHitFrameRef.current = 0;
          }
          hoveredRef.current = keyboardFocus;
          setHovered(keyboardFocus);
          event.currentTarget.dataset.interactive = keyboardFocus ? "true" : "false";
        }}
        onWheel={handleWheel}
        onKeyDown={handleCanvasKeyDown}
      />
      <p id="universe-keyboard-help" className="sr-status">
        Use the arrow keys to cycle through visible nebulae, galaxies, knowledge black holes,
        galaxy relationship lanes, paper stars, or note stars. Press Enter or Space to open
        the focused item, Home or End to jump, and Escape to go back.
      </p>

      {runtimeError && (
        <div className="runtime-error glass-surface" role="alert">
          <span>{runtimeError}</span>
          <button type="button" onClick={() => setRuntimeError("")} aria-label="Dismiss error">×</button>
        </div>
      )}

      <header className="liteverse-header">
        <div className="liteverse-brand">
          {/* The same local asset is shared with the native macOS icon. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-mark" src="./liteverse-brand.png" alt="" />
          <span>
            <h1>Liteverse</h1>
            <select
              value={workspace.projects.activeProjectId}
              onChange={(event) => selectProject(event.target.value)}
              aria-label="Active research project"
            >
              {workspace.projects.items.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </span>
        </div>

        <nav className="nebula-switcher" aria-label="Nebula regions">
          <button
            type="button"
            className={categoryFilter === "all" ? "is-active" : ""}
            onClick={() => showAllUniverse()}
          >
            All regions
          </button>
          {macroCategories.map((category) => (
            <button
              key={category.id}
              type="button"
              className={categoryFilter === category.id ? "is-active" : ""}
              style={{ "--nebula-color": category.color } as React.CSSProperties}
              onClick={() => focusCategory(category.id)}
            >
              <i />{category.name}
            </button>
          ))}
        </nav>

        <div className="header-status">
          <span className="heat-scope-switch" aria-label="Usage heat scope">
            <button type="button" className={heatScope === "project" ? "is-active" : ""} onClick={() => setHeatScope("project")}>Project heat</button>
            <button type="button" className={heatScope === "global" ? "is-active" : ""} onClick={() => setHeatScope("global")}>Global heat</button>
          </span>
          <span><i /> {sceneObjectCount} {sceneObjectNoun}</span>
          <button
            type="button"
            onClick={viewLevel === "universe" ? resetUniverseView : () => goBack()}
          >
            {viewLevel === "universe" ? "Reset view" : "Back"}
          </button>
        </div>
      </header>

      {viewLevel !== "universe" && (
        <nav className="universe-breadcrumb glass-surface" aria-label="Universe location">
          <button type="button" className="breadcrumb-back" onClick={() => goBack()} aria-label="Go back one level">←</button>
          <button type="button" onClick={() => showAllUniverse()}>Universe</button>
          <span aria-hidden="true">›</span>
          <button
            type="button"
            aria-current={viewLevel === "galaxies" ? "page" : undefined}
            onClick={() => focusCategory(categoryFilter)}
          >
            {getCategory(categoryFilter)?.name || "Nebula"}
          </button>
          {selectedGalaxy && (
            <>
              <span aria-hidden="true">›</span>
              <span aria-current="page">{selectedGalaxy.name}</span>
            </>
          )}
          {viewLevel === "notes" && (
            <>
              <span aria-hidden="true">›</span>
              <span aria-current="page">Notes &amp; Knowledge Cards</span>
            </>
          )}
        </nav>
      )}

      <div className={`search-orbit ${query ? "is-searching" : ""}`}>
        <span>⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search papers, methods, or concepts"
          aria-label="Search literature"
        />
        {categoryFilter !== "all" && (
          <button
            type="button"
            className="search-scope"
            onClick={() => setSearchScope((scope) => scope === "global" ? "region" : "global")}
            aria-label={`Search scope: ${searchScope === "global" ? "all regions" : "current region"}. Activate to switch.`}
          >
            {searchScope === "global" ? "All" : "Region"}
          </button>
        )}
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
            ×
          </button>
        )}
        {query && (
          <div className="search-results glass-surface">
            <div className="search-result-scope">
              {searchScope === "global" || categoryFilter === "all" ? "All regions" : getCategory(categoryFilter)?.name}
              <span>{searchResults.length} {searchResults.length === 1 ? "result" : "results"}</span>
            </div>
            {searchResults.map((paper) => (
              <button type="button" key={paper.id} onClick={() => selectSearchResult(paper.id)}>
                <i style={{ background: getCategory(paper.primaryCategory)?.color || "#7bcfff" }} />
                <span>
                  <b>{paper.shortTitle}</b>
                  <small>{getCategory(paper.primaryCategory)?.name || "Staging region"} · {paper.tags.slice(0, 2).join(" · ")}</small>
                </span>
              </button>
            ))}
            {!searchResults.length && <p>No matching paper stars</p>}
          </div>
        )}
      </div>

      {hasAuthoritativeGraph && universe.papers.length === 0 && !settingsOpen && (
        <section className="empty-universe-onboarding glass-surface" aria-labelledby="empty-universe-title">
          <span className="onboarding-orbit" aria-hidden="true"><i /></span>
          <span className="section-label">WELCOME TO LITEVERSE</span>
          <h2 id="empty-universe-title">Build your first literature universe</h2>
          <p>Begin with your research direction, then import a PDF or arXiv entry. After Codex curation and evidence verification, papers become stars, nebulae, and relationship beams.</p>
          <div>
            <button type="button" onClick={() => openSettings("memory")}>Add research context</button>
            <button type="button" className="is-primary" onClick={() => openSettings("literature")}>Import your first paper</button>
          </div>
          <small>After searching the full library, Codex proposes three broad region schemes. Until one is selected, papers remain in staging and the current graph stays unchanged.</small>
          <small className="onboarding-capacity-note" role="note">
            <span>Built to grow</span>
            One universe can grow from a few foundational papers to hundreds. Search and context workflows are benchmark-tested with up to {BENCHMARKED_PAPERS_PER_UNIVERSE.toLocaleString("en-US")} papers.
          </small>
        </section>
      )}

      {universe.papers.length > 0 && viewLevel !== "papers" && viewLevel !== "notes" && (
        <details className="relationship-layers glass-surface">
          <summary>
            <span><i />Galaxy relationship lanes</span>
            <small>{visibleRelationRecordCount} visible</small>
          </summary>
          <div className="relationship-layer-panel">
            <label className="relation-layer verified">
              <input type="checkbox" checked={relationLayers.verified} onChange={(event) => setRelationLayers((layers) => ({ ...layers, verified: event.target.checked }))} />
              <i />Verified solid lines
            </label>
            <label className="relation-layer candidate">
              <input type="checkbox" checked={relationLayers.candidate} onChange={(event) => setRelationLayers((layers) => ({ ...layers, candidate: event.target.checked }))} />
              <i />Candidate dashed lines
            </label>
            <label className="relation-layer unscored">
              <input type="checkbox" checked={relationLayers.unscored} onChange={(event) => setRelationLayers((layers) => ({ ...layers, unscored: event.target.checked }))} />
              <i />Unscored faint lines
            </label>
            <label className="relation-strength-filter">
              <span>Minimum strength <output>{minimumRelationStrength}%</output></span>
              <input type="range" min="0" max="80" step="10" value={minimumRelationStrength} onChange={(event) => setMinimumRelationStrength(Number(event.target.value))} />
            </label>
            <p>Each lane is one paper-level relationship projected between galaxies. Unscored lanes are not verified source evidence.</p>
          </div>
        </details>
      )}

      {pendingRefresh && (
        <button
          type="button"
          className={`refresh-universe glass-surface ${
            refreshPhase !== "idle" ? "is-running" : ""
          } ${
            refreshError ? "has-error" : ""
          }`}
          onClick={startPendingRefresh}
          disabled={refreshPhase !== "idle"}
          aria-label={pendingNewPaperCount > 0
            ? `Refresh the literature universe and add ${pendingNewPaperCount} new ${pendingNewPaperCount === 1 ? "paper" : "papers"}`
            : `Refresh the literature universe and apply ${Math.max(1, pendingChangeCount)} graph ${Math.max(1, pendingChangeCount) === 1 ? "update" : "updates"}`}
        >
          <span className="refresh-supernova" aria-hidden="true"><i /></span>
          <span>
            <b>{refreshError ? "Refresh failed · Retry" : refreshPhase === "idle" ? "Refresh Universe" : refreshPhase === "committing" ? "Verifying graph" : "Supernova wave expanding"}</b>
            <small>{refreshError || pendingRefreshSummary}</small>
          </span>
          <em>{pendingBadgeCount}</em>
        </button>
      )}

      <button
        ref={settingsButtonRef}
        type="button"
        className={`settings-toggle glass-surface ${settingsOpen ? "is-active" : ""} ${workspace.partitionProposals ? "has-partition-proposal" : ""}`}
        onClick={settingsOpen ? closeSettings : () => openSettings()}
        aria-label={settingsOpen
          ? "Close settings"
          : workspace.partitionProposals
            ? "Open settings; a region proposal awaits review"
            : "Open settings"}
        aria-expanded={settingsOpen}
        aria-controls="liteverse-settings"
      >
        <span aria-hidden="true">⚙︎</span>
        {workspace.partitionProposals && <i aria-hidden="true">Review</i>}
      </button>

      <ZoomControl value={zoomLevel} shifted={false} onChange={setUniverseZoom} />

      <SettingsDrawer
        key={settingsWorkspace.projects.activeProjectId}
        open={settingsOpen}
        workspace={settingsWorkspace}
        researchDraft={researchDraft}
        busyAction={workspaceBusyAction}
        notice={workspaceNotice}
        error={workspaceError}
        activeTab={settingsRequestedTab}
        health={libraryHealth}
        onClose={closeSettings}
        onTabChange={setSettingsRequestedTab}
        onSelectProject={selectProject}
        onCreateProject={createProject}
        onPickPDF={pickLiteraturePDF}
        onPickLiteratureFolder={pickLiteratureFolder}
        onPickZoteroLibrary={pickZoteroLibrary}
        onSaveArxiv={saveArxivEntry}
        onResearchDraftChange={updateResearchDraft}
        onSaveResearch={saveResearchInformation}
        regions={macroCategories.map((category) => ({ id: category.id, name: category.name }))}
        onSaveRegionDocument={saveRegionDocument}
        onImportRegionDocument={importRegionDocument}
        localContextPreview={localContextPreview}
        contextPreviewBusy={contextPreviewBusy}
        contextPreviewError={contextPreviewError}
        onBuildContextPreview={buildContextPreview}
        onQueueContext={queueContextRequest}
        literatureSearch={visibleLiteratureSearch}
        literatureSearchBusy={literatureSearchBusy}
        literatureSearchError={literatureSearchError}
        onSearchLiterature={searchLiteratureIndex}
        onOpenSearchPaper={selectSearchResult}
        onOpenWorkspacePath={openLocalFile}
        onOpenLibraryItem={openLibraryItem}
        onRetryLocalPreparation={retryLocalPreparation}
        onExportWorkspace={exportWorkspace}
        onImportWorkspace={importWorkspace}
      />

      <aside
        className={`paper-drawer glass-surface ${selectedPaper ? "is-open" : ""}`}
        role="dialog"
        aria-label="Paper details"
        aria-hidden={!selectedPaper}
        inert={!selectedPaper}
      >
        {selectedPaper && selectedPaperCategory && selectedPaperVerification && (
          <>
            <div className="drawer-glow" style={{ background: selectedPaperCategory.color }} />
            <button className="drawer-close" type="button" onClick={() => setSelectedPaperId(null)} aria-label="Close paper details">×</button>
            <div className="drawer-scroll">
              <div className="drawer-kicker">
                <span>{selectedPaper.year}</span>
                <span>{selectedPaper.citekey}</span>
                <span
                  className={`verification-state ${selectedPaperVerification.tone}`}
                  title={selectedPaperVerification.detail}
                >
                  ● {selectedPaperVerification.label}
                </span>
              </div>
              <h2>{selectedPaper.title}</h2>
              <p className="drawer-authors">{selectedPaper.authors}</p>

              <nav className="drawer-tabs" role="tablist" aria-label="Paper detail sections">
                <button type="button" id="paper-tab-summary" role="tab" aria-selected={drawerTab === "summary"} aria-controls="paper-panel-summary" className={drawerTab === "summary" ? "is-active" : ""} onClick={() => setDrawerTab("summary")}><span>Summary</span></button>
                <button
                  type="button"
                  id="paper-tab-knowledge"
                  role="tab"
                  aria-selected={drawerTab === "knowledge"}
                  aria-controls="paper-panel-knowledge"
                  className={drawerTab === "knowledge" ? "is-active" : ""}
                  onClick={() => {
                    setDrawerTab("knowledge");
                    if (!knowledgeCard || knowledgeCard.paperId !== selectedPaper.id) loadKnowledgeCard(selectedPaper);
                  }}
                ><span>Knowledge card</span></button>
                <button type="button" id="paper-tab-notes" role="tab" aria-selected={drawerTab === "notes"} aria-controls="paper-panel-notes" className={drawerTab === "notes" ? "is-active" : ""} onClick={() => setDrawerTab("notes")}><span>Notes</span>{selectedPaperAnnotations.filter((item) => item.status === "pending").length > 0 && <i>{selectedPaperAnnotations.filter((item) => item.status === "pending").length}</i>}</button>
                <button type="button" id="paper-tab-relations" role="tab" aria-selected={drawerTab === "relations"} aria-controls="paper-panel-relations" className={drawerTab === "relations" ? "is-active" : ""} onClick={() => setDrawerTab("relations")}><span>Relationships</span><i>{selectedPaperRelationBundles.length}</i></button>
              </nav>

              {drawerTab === "summary" && (
                <div id="paper-panel-summary" className="drawer-tab-content" role="tabpanel" aria-labelledby="paper-tab-summary">
                  <div className="paper-temperature">
                    <div className="paper-temperature-value" aria-label={`${selectedPaperUseCount} evidence uses`} style={{ "--paper-color": selectedPaperCategory.color } as React.CSSProperties}>
                      {selectedPaperUseCount}
                    </div>
                    <span><b>{heatScope === "project" ? "Project heat" : "Global heat"} · Evidence uses</b><small>Halo brightness {Math.round((heatByPaper[selectedPaper.id] ?? 0) * 100)}% · Skill-managed · Read-only</small></span>
                  </div>

                  <section>
                    <span className="section-label">PAPER SUMMARY</span>
                    <ScientificText as="p">{selectedPaper.summary}</ScientificText>
                  </section>
                  <section className={`paper-verification-card ${selectedPaperVerification.tone}`}>
                    <span className="section-label">EVIDENCE STATUS</span>
                    <p><b>{selectedPaperVerification.label}</b>{selectedPaperVerification.detail}</p>
                    {selectedPaperVerification.tone !== "verified" && (
                      <small>This summary supports navigation, but it is not a verified paper conclusion until full text and evidence locators are complete.</small>
                    )}
                  </section>
                  <section>
                    <span className="section-label">ROLE IN THIS PROJECT</span>
                    <ScientificText as="p">{selectedPaper.projectRole}</ScientificText>
                  </section>

                  <div className="tag-cloud">
                    {selectedPaper.tags.map((tag) => <span key={tag}>{tag}</span>)}
                  </div>

                  <div className="drawer-actions">
                    <button
                      type="button"
                      disabled={!(selectedPaper.source?.pdfPath || selectedPaper.pdfPath)}
                      onClick={() => openLocalFile(selectedPaper.source?.pdfPath || selectedPaper.pdfPath)}
                    >Open PDF</button>
                    <button
                      type="button"
                      disabled={!paperCardPath(selectedPaper)}
                      onClick={() => openLocalFile(paperCardPath(selectedPaper))}
                    >Open Markdown</button>
                    <button
                      type="button"
                      disabled={!(selectedPaper.source?.pdfPath || selectedPaper.pdfPath)}
                      onClick={() => copyText(selectedPaper.source?.pdfPath || selectedPaper.pdfPath, "pdf")}
                    >{copied === "pdf" ? "Path copied" : "Copy PDF path"}</button>
                  </div>

                </div>
              )}

              {drawerTab === "knowledge" && (
                <div id="paper-panel-knowledge" className="drawer-tab-content knowledge-card-reader" role="tabpanel" aria-labelledby="paper-tab-knowledge">
                  <div className="annotation-intro">
                    <span className="section-label">KNOWLEDGE CARD</span>
                    <p>Read the curated knowledge card by section. Evidence locators take you back to the PDF for verification; they do not replace the source.</p>
                  </div>
                  {knowledgeCardLoading && <div className="knowledge-loading">Loading local knowledge card…</div>}
                  {!knowledgeCardLoading && knowledgeCard?.paperId === selectedPaper.id && knowledgeCard.error && (
                    <div className="annotation-error" role="alert">{knowledgeCard.error}</div>
                  )}
                  {!knowledgeCardLoading && knowledgeCard?.paperId === selectedPaper.id && !knowledgeCard.error && (
                    <>
                      <div className="knowledge-artifact-meta">
                        <span>{knowledgeCard.path}</span>
                        {knowledgeCard.artifactSha256 && <small>artifact {knowledgeCard.artifactSha256.slice(0, 12)}</small>}
                        {knowledgeCard.sourceSha256 && <small>source {knowledgeCard.sourceSha256.slice(0, 12)}</small>}
                      </div>
                      <div className="knowledge-sections">
                        {knowledgeCard.sections.map((section) => (
                          <details key={section.id} open={knowledgeCard.sections.length <= 4}>
                            <summary>{section.title}</summary>
                            <ScientificText as="pre">{section.content}</ScientificText>
                          </details>
                        ))}
                      </div>
                      <section className="knowledge-evidence-list">
                        <span className="section-label">EVIDENCE LOCATORS</span>
                        {knowledgeCard.evidence.map((evidence) => (
                          <article key={evidence.id}>
                            <header><b>{evidence.id}</b><small>{evidence.locator || "No locator"}</small></header>
                            <ScientificText as="p">{evidence.text}</ScientificText>
                          </article>
                        ))}
                        {!knowledgeCard.evidence.length && <p className="empty-inline">No evidence locators are recorded in this knowledge card.</p>}
                      </section>
                      <div className="drawer-actions knowledge-actions">
                        <button type="button" onClick={() => openLocalFile(knowledgeCard.path)}>Open knowledge card</button>
                        <button type="button" disabled={!(selectedPaper.source?.pdfPath || selectedPaper.pdfPath)} onClick={() => openLocalFile(selectedPaper.source?.pdfPath || selectedPaper.pdfPath)}>Open PDF to verify</button>
                      </div>
                    </>
                  )}
                  {!knowledgeCardLoading && (!knowledgeCard || knowledgeCard.paperId !== selectedPaper.id) && (
                    <div className="settings-empty is-compact"><span>◇</span><b>Knowledge card unavailable</b><p>This paper may still be in curation or may need to be opened in the macOS app.</p></div>
                  )}
                </div>
              )}

              {drawerTab === "notes" && (
                <div id="paper-panel-notes" className="drawer-tab-content annotation-workspace" role="tabpanel" aria-labelledby="paper-tab-notes">
                  <div className="annotation-intro">
                    <span className="section-label">MANUAL NOTE</span>
                    <p>Record observations, questions, or equation notes directly. Saved notes enter the Codex curation queue and are never promoted to paper conclusions before verification.</p>
                  </div>
                  <label className="annotation-editor">
                    <textarea
                      value={annotationDraft}
                      onChange={(event) => setAnnotationDraft(event.target.value)}
                      placeholder="For example: this relationship may be more specific than ‘earlier work’; verify the direct citation in Section 2…"
                      rows={7}
                      autoFocus
                    />
                    <span>{annotationDraft.length} characters</span>
                  </label>
                  <div className="annotation-editor-actions">
                    {editingAnnotationId && (
                      <button type="button" className="quiet" onClick={() => { setEditingAnnotationId(null); setAnnotationDraft(""); }}>Cancel editing</button>
                    )}
                    <button type="button" className="save-note" disabled={!annotationDraft.trim() || annotationSaveState === "saving"} onClick={saveAnnotation}>
                      {annotationSaveState === "saving" ? "Saving…" : annotationSaveState === "saved" ? "Added to curation queue" : editingAnnotationId ? "Save changes" : "Add note"}
                    </button>
                  </div>
                  {annotationError && (
                    <p className="annotation-error" role="alert">{annotationError}</p>
                  )}

                  <div className="annotation-history">
                    <div className="annotation-history-title">
                      <span className="section-label">NOTE HISTORY</span>
                      <small>{selectedPaperAnnotations.length} {selectedPaperAnnotations.length === 1 ? "note" : "notes"}</small>
                    </div>
                    {selectedPaperAnnotations.map((annotation) => (
                      <article key={annotation.id} className={editingAnnotationId === annotation.id ? "is-editing" : ""}>
                        <div className="annotation-meta">
                          <span className={`annotation-state ${annotation.status}`} />
                          <b>{annotation.status === "pending" ? "Awaiting Codex curation" : "Curated"}</b>
                          <small>v{annotation.revision} · {dateLabel(annotation.updatedAt)}</small>
                        </div>
                        <ScientificText as="p">{annotation.text}</ScientificText>
                        <button type="button" onClick={() => editAnnotation(annotation)}>Edit this note</button>
                      </article>
                    ))}
                    {!selectedPaperAnnotations.length && <div className="annotation-empty">No notes yet.</div>}
                  </div>
                </div>
              )}

              {drawerTab === "relations" && (
                <div id="paper-panel-relations" className="drawer-tab-content paper-relations-list" role="tabpanel" aria-labelledby="paper-tab-relations">
                  <div className="annotation-intro">
                    <span className="section-label">CONNECTED PAPERS</span>
                    <p>Select a connected paper to enter its galaxy and open that paper star.</p>
                  </div>
                  {selectedPaperRelationBundles.map((bundle) => {
                    const otherId = bundle.source === selectedPaper.id ? bundle.target : bundle.source;
                    const pendingScore = bundle.relations.every(
                      (relation) => !isRelationScored(relation),
                    );
                    return (
                      <button
                        type="button"
                        key={bundle.key}
                        onClick={() => selectPaper(otherId)}
                      >
                        <span className="relation-list-beam" />
                        <span><b>{getPaper(otherId).shortTitle}</b><small>{bundle.relations.map((relation) => relationLabels[relation.type] || relation.label).join(" · ")}{pendingScore ? " · Unscored" : ""}</small></span>
                        <i>{bundle.relations.length}</i>
                      </button>
                    );
                  })}
                  {!selectedPaperRelationBundles.length && <div className="annotation-empty">No relationships recorded yet.</div>}
                </div>
              )}
            </div>
          </>
        )}
      </aside>

      <aside
        className={`relation-drawer glass-surface ${selectedBundle ? "is-open" : ""}`}
        role="dialog"
        aria-label="Galaxy relationship details"
        aria-hidden={!selectedBundle}
        inert={!selectedBundle}
      >
        {selectedBundle && selectedSourceGalaxy && selectedTargetGalaxy && (
          <>
            <button className="drawer-close" type="button" onClick={() => setSelectedRelationKey(null)} aria-label="Close relationship details">×</button>
            <div className="relation-heading">
              <span className="section-label">GALAXY RELATION LANES</span>
              <div className="relation-pair">
                <button type="button" onClick={() => focusGalaxy(selectedSourceGalaxy.id)}>{selectedSourceGalaxy.name}</button>
                <span>↔</span>
                <button type="button" onClick={() => focusGalaxy(selectedTargetGalaxy.id)}>{selectedTargetGalaxy.name}</button>
              </div>
              <p>{selectedBundle.lanes.length} independent paper-level {selectedBundle.lanes.length === 1 ? "relationship is" : "relationships are"} projected as parallel galaxy lanes.</p>
            </div>
            <div className="relation-details">
              {selectedBundle.lanes.map(({ relation }) => {
                const displayState = relationDisplayState(relation);
                const strength = normalizedPercent(relation.strength);
                const confidence = normalizedPercent(relation.confidence);
                return (
                  <article key={relation.id} className={`relation-score-${displayState}`}>
                    <div className="relation-meta">
                      <span className={`relation-status ${displayState}`} />
                      <b>{getPaper(relation.source).shortTitle} ↔ {getPaper(relation.target).shortTitle}</b>
                      <small>
                        {displayState === "unscored"
                          ? "Unscored · legacy confidence is archival only"
                          : `${relationStatusLabel(displayState)} · ${relationLabels[relation.type] || relation.label} · Strength ${Math.round(strength || 0)}%`}
                      </small>
                      {displayState !== "unscored" && (
                        <em className={`confidence-badge ${displayState}`}>
                          Confidence {Math.round(confidence || 0)}%
                        </em>
                      )}
                    </div>
                    <ScientificText as="p">{relation.note}</ScientificText>
                    <footer>
                      <span>Evidence</span>
                      <ScientificText as="p" className="relation-evidence-text">{relationEvidenceText(relation)}</ScientificText>
                    </footer>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </aside>

      <aside
        className={`memory-drawer glass-surface ${selectedMemory ? "is-open" : ""}`}
        role="dialog"
        aria-label="Personal knowledge details"
        aria-hidden={!selectedMemory}
        inert={!selectedMemory}
      >
        {selectedMemory && (
          <>
            <button className="drawer-close" type="button" onClick={() => setSelectedMemoryId(null)} aria-label="Close personal knowledge details">×</button>
            <div className="drawer-scroll">
              <div className="drawer-kicker">
                <span>{selectedMemory.presentation?.kind === "knowledge_card" ? "Knowledge Card" : "Note"}</span>
                <span>{selectedMemory.evidenceState.replaceAll("_", " ")}</span>
                <span>{selectedMemory.state}</span>
              </div>
              <h2>{selectedMemory.presentation?.title || selectedMemory.title || selectedMemory.statement || "Untitled research note"}</h2>
              <p className="drawer-authors">
                {Array.isArray(selectedMemory.provenance)
                  ? selectedMemory.provenance.join(" · ")
                  : selectedMemory.provenance}
                {selectedMemory.updatedAt || selectedMemory.createdAt
                  ? ` · ${dateLabel(selectedMemory.updatedAt || selectedMemory.createdAt || "")}`
                  : ""}
              </p>
              <section className="memory-document-content">
                <span className="section-label">PERSONAL KNOWLEDGE</span>
                <ScientificText as="div">
                  {selectedMemory.content || selectedMemory.statement || "No note content is available."}
                </ScientificText>
              </section>
              <section className="memory-provenance-card">
                <span className="section-label">STATUS</span>
                <p>Personal notes and cards remain project memory. They are not promoted to paper evidence unless separately verified against a source.</p>
              </section>
            </div>
          </>
        )}
      </aside>

      <div className="sr-status" role="status" aria-live="polite" aria-atomic="true">
        {keyboardAnnouncement}
      </div>
      <div className="sr-status" role="status" aria-live="polite" aria-atomic="true">
        {selectedPaper
          ? `Selected ${selectedPaper.shortTitle}`
          : selectedMemory
            ? `Selected ${selectedMemory.title || selectedMemory.statement || "personal knowledge"}`
            : selectedBundle
              ? "Galaxy relationship lanes selected"
              : ""}
      </div>
    </main>
  );
}
