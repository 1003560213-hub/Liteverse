/**
 * Workspace data exchanged with the native macOS shell. These types mirror the
 * JSON produced by macos/LiteverseApp.m; the UI never writes these files
 * directly.
 */

export type LibraryScreeningClaim = {
  claimId: string;
  text: string;
  routingOnly: true;
  type?: string;
  section?: string;
  verificationStatus?: string;
  artifactRevision?: number;
  artifactSha256?: string;
  rank?: number;
  evidence?: Array<Record<string, unknown>>;
};

export type LibraryScreeningCandidate = {
  paperId: string;
  rank: number;
  routingOnly?: true;
  title?: string;
  verificationStatus?: string;
  primaryCategory?: string;
  secondaryCategory?: string;
  artifactRevision?: number;
  artifactSha256?: string;
  snippet?: string;
  matchingClaims?: LibraryScreeningClaim[];
};

export type StrictDuplicateResolution = {
  schemaVersion: 1;
  method: "strict_identity_v1";
  sourceRevision: number;
  resolvedRevision: number;
  jobId: string;
  resultSha256: string;
  manifestPath: string;
  duplicateOfPaperId: string;
  matchedBy: string[];
  resolvedAt: string;
};

export type LibraryItem = {
  id: string;
  number: number;
  sourceType: "pdf" | "arxiv";
  displayTitle: string;
  titleStatus: "filename_guess" | "pending" | "codex_verified";
  originalFilename?: string;
  storedFilename?: string;
  arxivId?: string;
  arxivUrl?: string;
  status:
    | "pending_codex"
    | "processing"
    | "ready_to_refresh"
    | "organized"
    | "needs_attention";
  revision: number;
  verificationStatus?: string;
  preparation?: {
    schemaVersion: 1;
    state: "queued" | "ready" | "needs_attention";
    jobId: string;
    sourceRevision: number;
    resultSha256?: string | null;
    manifestPath?: string | null;
    reviewPacketPath?: string;
    resultState?: "ready" | "duplicate" | "needs_attention";
    extractionStatus?: "extracted" | "needs_ocr";
    screeningMethod?: "fts5_bm25_title_v1" | "fts5_bm25_review_packet_v2";
    screeningAnchorIds?: string[];
    screeningIndexFingerprint?: string;
    screeningCandidates?: LibraryScreeningCandidate[];
    duplicateOf?: { paperId: string };
    deduplication?: {
      method: "strict_identity_v1";
      matchedBy: string[];
      strictKeys: Record<string, string | null>;
    };
    reason?: string;
    queuedAt?: string;
    completedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
  organizedAt?: string;
  disposition?: "duplicate" | "no-link";
  duplicateOfPaperId?: string;
  autoResolution?: StrictDuplicateResolution;
  graphPaperId?: string;
  catalogSource?: "universe";
  localPath?: string;
  source?: {
    kind: "pdf" | "arxiv";
    storageMode?: "managed" | "linked";
    pdfPath?: string;
    linkedRootPath?: string;
    relativePath?: string;
    sha256?: string;
    catalogMetadata?: {
      title?: string;
      authors?: string[];
      doi?: string;
    };
    provenance?: {
      catalog: "zotero";
      itemKey: string;
      attachmentKey: string;
    };
  };
  citekey?: string;
  verificationLabel?: string;
  verificationTone?: "verified" | "progress" | "draft" | "attention";
  verificationDetail?: string;
};

export type WorkspaceHealth = {
  schemaVersion: number;
  checkedAt: string;
  graphSchemaVersion: string | number;
  revision: number;
  paperCount: number;
  relationCount: number;
  macroCategoryCount: number;
  systemCategoryCount: number;
  stagingPaperCount: number;
  verifiedPaperCount: number;
  pendingScoringRelationCount: number;
  missingSourcePaperIds: string[];
  missingSourceHashPaperIds: string[];
  hashMismatchPaperIds: string[];
  missingCardPaperIds: string[];
  missingFulltextPaperIds: string[];
  attentionPaperIds: string[];
  libraryStatusCounts: Record<string, number>;
  hasPendingRefresh: boolean;
  managedVaultPath: string;
};

export type ResearchInformation = {
  schemaVersion: number;
  status: "empty" | "pending_setup" | "pending_update" | "organized";
  draft: {
    text: string;
    revision: number;
    updatedAt: string;
  };
  formal: {
    text: string;
    sourceRevision: number;
    organizedAt: string;
  };
};

export type LiteverseProject = {
  id: string;
  name: string;
  description?: string;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryItem = {
  id?: string;
  memoryId?: string;
  type: string;
  title?: string;
  statement?: string;
  content?: string;
  state: "active" | "superseded" | "retired" | string;
  evidenceState: "user_declared" | "provisional" | "supported" | "contradicted" | string;
  provenance: string | string[];
  scope?: {
    kind?: string;
    categoryId?: string;
    categoryNameAtAssignment?: string;
    graphRevisionAtAssignment?: number;
  };
  presentation?: {
    documentId?: string;
    kind?: "note" | "knowledge_card" | string;
    format?: "markdown" | "plain_text" | string;
  };
  source?: {
    kind?: string;
    input?: string;
    fileName?: string;
    byteLength?: number;
    contentSha256?: string;
  };
  supersedes?: string[];
  contradicts?: string[];
  createdAt?: string;
  updatedAt?: string;
};

export type ProjectTask = {
  taskHash: string;
  status?: string;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
  outputs?: Array<string | Record<string, unknown>>;
  memoryIds?: string[];
};

export type ContextClaim = {
  claimId?: string;
  paperId?: string;
  title?: string;
  text?: string;
  statement?: string;
  type?: string;
  evidenceId?: string;
  locator?: string | Record<string, unknown>;
  reason?: string;
  whySelected?: string;
  evidenceLocators?: Array<Record<string, unknown>>;
  verificationStatus?: string;
  artifactRevision?: number;
  artifactSha256?: string;
  contentHash?: string;
  trust?: string;
};

export type ContextPack = {
  schemaVersion?: string | number;
  contextId: string;
  packId?: string;
  requestId?: string;
  contextKind?: "formal" | "local_preview";
  adopted?: boolean;
  cacheOnly?: boolean;
  cachePath?: string;
  projectId: string;
  taskHash?: string;
  createdAt?: string;
  graphRevision?: number;
  memoryRevision?: number;
  memoryLedgerHash?: string | null;
  indexFingerprint?: string;
  query?: string;
  budgetChars?: number;
  usedChars?: number;
  selectedClaims?: ContextClaim[];
  projectMemory?: MemoryItem[];
  conflicts?: Array<string | Record<string, unknown>>;
  limitations?: Array<string | Record<string, unknown>>;
  markdownPath?: string;
  jsonPath?: string;
  source?: "liteverse_cli" | "local_preview";
  adoptionState?: "adopted" | "not_adopted";
  usageRecorded?: boolean;
};

export type ResearchArtifact = {
  id?: string;
  kind: "code" | "experiment" | "result" | string;
  title?: string;
  summary?: string;
  path?: string;
  gitCommit?: string;
  hash?: string;
  contentHash?: string;
  configHash?: string;
  dataHash?: string;
  command?: string;
  resultSummary?: string;
  status?: string;
  createdAt?: string;
};

export type PartitionProposalRegion = {
  id?: string;
  regionId?: string;
  name: string;
  summary?: string;
  description?: string;
  paperCount?: number;
  paperIds?: string[];
};

export type PartitionProposalAssignment = {
  paperId?: string;
  regionId?: string;
  categoryId?: string;
  primaryRegionId?: string;
  primaryCategory?: string;
  secondaryCategory?: string;
};

export type PartitionProposalOption = {
  optionId: string;
  name: string;
  summary: string;
  tradeoffs: {
    strengths: string[];
    limitations: string[];
  };
  regions: PartitionProposalRegion[];
  assignments: PartitionProposalAssignment[];
  metrics: Record<string, unknown>;
};

export type PartitionProposalSet = {
  schemaVersion: "liteverse-partition-proposals-v1";
  proposalSetId: string;
  baseRevision: number | string;
  status: "awaiting_user";
  artifactFingerprint: string;
  searchSummary: string;
  truthPath: string;
  truthSha256: string;
  options: PartitionProposalOption[];
};

export type WorkspaceState = {
  library: {
    schemaVersion: number;
    nextNumber: number;
    items: LibraryItem[];
  };
  researchInformation: ResearchInformation;
  projects: {
    schemaVersion?: number;
    activeProjectId: string;
    items: LiteverseProject[];
  };
  projectMemory: {
    revision: number;
    items: MemoryItem[];
  };
  tasks: ProjectTask[];
  contextPacks: ContextPack[];
  artifacts: ResearchArtifact[];
  projectUseCounts: Record<string, number>;
  partitionProposals: PartitionProposalSet | null;
  health?: WorkspaceHealth;
  notice?: string;
};

export const EMPTY_WORKSPACE: WorkspaceState = {
  library: { schemaVersion: 1, nextNumber: 1, items: [] },
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
  artifacts: [],
  projectUseCounts: {},
  partitionProposals: null,
};

function normalizePartitionProposals(input: unknown): PartitionProposalSet | null {
  if (!input || typeof input !== "object") return null;
  const proposal = input as Partial<PartitionProposalSet>;
  if (
    proposal.schemaVersion !== "liteverse-partition-proposals-v1"
    || proposal.status !== "awaiting_user"
    || typeof proposal.proposalSetId !== "string"
    || !proposal.proposalSetId
    || typeof proposal.artifactFingerprint !== "string"
    || !/^[a-f0-9]{64}$/i.test(proposal.artifactFingerprint)
    || typeof proposal.truthSha256 !== "string"
    || !/^[a-f0-9]{64}$/i.test(proposal.truthSha256)
    || !Array.isArray(proposal.options)
    || proposal.options.length !== 3
  ) return null;
  const validOptions = proposal.options.every((option) => (
    option
    && typeof option.optionId === "string"
    && typeof option.name === "string"
    && Array.isArray(option.regions)
    && option.regions.length <= 10
    && Array.isArray(option.assignments)
  ));
  return validOptions ? proposal as PartitionProposalSet : null;
}

export function normalizeWorkspaceState(input: Partial<WorkspaceState> | null | undefined): WorkspaceState {
  const projects = input?.projects;
  const activeProjectId = projects?.activeProjectId || "project-default";
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
      draft: { ...EMPTY_WORKSPACE.researchInformation.draft, ...(input?.researchInformation?.draft || {}) },
      formal: { ...EMPTY_WORKSPACE.researchInformation.formal, ...(input?.researchInformation?.formal || {}) },
    },
    projects: { schemaVersion: projects?.schemaVersion || 1, activeProjectId, items: projectItems },
    projectMemory: {
      revision: input?.projectMemory?.revision || 0,
      items: Array.isArray(input?.projectMemory?.items) ? input.projectMemory.items : [],
    },
    tasks: Array.isArray(input?.tasks) ? input.tasks : [],
    contextPacks: Array.isArray(input?.contextPacks) ? input.contextPacks : [],
    artifacts: Array.isArray(input?.artifacts) ? input.artifacts : [],
    projectUseCounts: input?.projectUseCounts && typeof input.projectUseCounts === "object"
      ? input.projectUseCounts
      : {},
    partitionProposals: normalizePartitionProposals(input?.partitionProposals),
  };
}

export function projectBriefText(research: ResearchInformation) {
  return research.formal.text || research.draft.text || "";
}
