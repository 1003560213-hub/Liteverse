"use client";

import { useEffect, useRef, useState } from "react";
import { ScientificText } from "./ScientificText";

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

export type LibraryHealth = {
  totalPapers: number;
  evidenceVerified: number;
  draftPapers: number;
  needsAttention: number;
  pendingCodex: number;
  readyToRefresh: number;
  pendingRelations: number;
  candidateRelations: number;
  verifiedRelations: number;
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

export type SearchProjectionItem = ContextClaim & {
  paperTitle?: string;
  keywords?: string[];
};

export type LiteratureSearchResult = {
  paperId: string;
  title: string;
  authors?: string[];
  tags?: string[];
  verificationStatus?: string;
  artifactRevision?: number;
  artifactSha256?: string;
  rank: number;
  snippet?: string;
  matchingClaims?: ContextClaim[];
  relationExpansion?: string[];
  inCurrentGraph?: boolean;
};

export type LiteratureSearchPayload = {
  schemaVersion: "liteverse-search-result-v1" | string;
  requestId: string;
  query: string;
  indexFingerprint: string;
  count: number;
  results: LiteratureSearchResult[];
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

export type SettingsTab = "literature" | "memory" | "context" | "artifacts" | "partitions";

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
  contextPreview?: ContextPack | null;
  artifacts: ResearchArtifact[];
  searchProjection: SearchProjectionItem[];
  projectUseCounts: Record<string, number>;
  partitionProposals: PartitionProposalSet | null;
  health?: WorkspaceHealth;
  notice?: string;
};

type SettingsDrawerProps = {
  open: boolean;
  workspace: WorkspaceState;
  researchDraft: string;
  busyAction: "pdf" | "folder" | "arxiv" | "research" | "memory-document" | null;
  notice: string;
  error: string;
  activeTab: SettingsTab;
  health: LibraryHealth;
  onClose: () => void;
  onTabChange: (tab: SettingsTab) => void;
  onSelectProject: (projectId: string) => void;
  onCreateProject: (name: string) => void;
  onPickPDF: () => void;
  onPickLiteratureFolder: () => void;
  onPickZoteroLibrary: () => void;
  onSaveArxiv: (value: string) => void;
  onResearchDraftChange: (value: string) => void;
  onSaveResearch: () => void;
  regions: Array<{ id: string; name: string }>;
  onSaveRegionDocument: (input: {
    categoryId: string;
    kind: "note" | "knowledge_card";
    format: "markdown" | "plain_text";
    title: string;
    content: string;
  }) => void;
  onImportRegionDocument: (input: {
    categoryId: string;
    kind: "note" | "knowledge_card";
  }) => void;
  localContextPreview: ContextPack | null;
  contextPreviewBusy: boolean;
  contextPreviewError: string;
  onBuildContextPreview: (query: string, budgetChars: number) => void;
  onQueueContext: (query: string, budgetChars: number) => void;
  literatureSearch: LiteratureSearchPayload | null;
  literatureSearchBusy: boolean;
  literatureSearchError: string;
  onSearchLiterature: (query: string) => void;
  onOpenSearchPaper: (paperId: string) => void;
  onOpenWorkspacePath: (path: string) => void;
  onOpenLibraryItem: (item: LibraryItem) => void;
  onRetryLocalPreparation: (item: LibraryItem) => void;
  onExportWorkspace: (includePDFs: boolean) => void;
  onImportWorkspace: () => void;
};

const statusLabels: Record<LibraryItem["status"], string> = {
  pending_codex: "Awaiting Codex",
  processing: "Codex is curating",
  ready_to_refresh: "Ready to refresh",
  organized: "Organized",
  needs_attention: "Review required",
};

const preparationLabels: Record<NonNullable<LibraryItem["preparation"]>["state"], string> = {
  queued: "Preparing locally",
  ready: "Locally prepared",
  needs_attention: "Preparation needs attention",
};

const ARXIV_PATTERN = /^(?:https:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)?(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?(?:\.pdf)?$/i;

function libraryCode(item: LibraryItem) {
  const prefix = item.catalogSource === "universe" ? "STAR" : "LIT";
  return `${prefix}-${String(item.number).padStart(4, "0")}`;
}

function updatedLabel(timestamp: string) {
  if (!timestamp) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function partitionRegionId(region: PartitionProposalRegion, index: number) {
  return region.regionId || region.id || `region-${index + 1}`;
}

function partitionRegionPaperCount(
  option: PartitionProposalOption,
  region: PartitionProposalRegion,
  index: number,
) {
  if (Number.isFinite(region.paperCount)) return Math.max(0, Number(region.paperCount));
  if (Array.isArray(region.paperIds)) return new Set(region.paperIds).size;
  const regionId = partitionRegionId(region, index);
  return new Set(
    option.assignments
      .filter((assignment) => (
        assignment.regionId === regionId
        || assignment.categoryId === regionId
        || assignment.primaryRegionId === regionId
        || assignment.primaryCategory === regionId
      ))
      .map((assignment) => assignment.paperId)
      .filter((paperId): paperId is string => Boolean(paperId)),
  ).size;
}

function partitionMetricLabel(value: unknown) {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function partitionChoiceText(
  proposal: PartitionProposalSet,
  option: PartitionProposalOption,
) {
  return `Use the Liteverse region proposal “${option.name}” in Codex (optionId: ${option.optionId}, proposalSetId: ${proposal.proposalSetId}, baseRevision: ${proposal.baseRevision}). Ask liteverse-curator to verify this proposal and prepare a staged Refresh. Do not modify Graph/current.json before that step.`;
}

export function SettingsDrawer({
  open,
  workspace,
  researchDraft,
  busyAction,
  notice,
  error,
  activeTab,
  health,
  onClose,
  onTabChange,
  onSelectProject,
  onCreateProject,
  onPickPDF,
  onPickLiteratureFolder,
  onPickZoteroLibrary,
  onSaveArxiv,
  onResearchDraftChange,
  onSaveResearch,
  regions,
  onSaveRegionDocument,
  onImportRegionDocument,
  localContextPreview,
  contextPreviewBusy,
  contextPreviewError,
  onBuildContextPreview,
  onQueueContext,
  literatureSearch,
  literatureSearchBusy,
  literatureSearchError,
  onSearchLiterature,
  onOpenSearchPaper,
  onOpenWorkspacePath,
  onOpenLibraryItem,
  onRetryLocalPreparation,
  onExportWorkspace,
  onImportWorkspace,
}: SettingsDrawerProps) {
  const [uploadSource, setUploadSource] = useState<"pdf" | "folder" | "arxiv">("pdf");
  const [arxivValue, setArxivValue] = useState("");
  const [arxivError, setArxivError] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryStatusFilter, setLibraryStatusFilter] = useState<"all" | LibraryItem["status"]>("all");
  const [includePDFsInBackup, setIncludePDFsInBackup] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [contextQuery, setContextQuery] = useState("");
  const [contextBudget, setContextBudget] = useState(12_000);
  const [selectedContextId, setSelectedContextId] = useState("");
  const [copiedPartitionOptionId, setCopiedPartitionOptionId] = useState("");
  const [regionDocumentCategoryId, setRegionDocumentCategoryId] = useState("");
  const [regionDocumentKind, setRegionDocumentKind] = useState<"note" | "knowledge_card">("note");
  const [regionDocumentFormat, setRegionDocumentFormat] = useState<"markdown" | "plain_text">("markdown");
  const [regionDocumentTitle, setRegionDocumentTitle] = useState("");
  const [regionDocumentContent, setRegionDocumentContent] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const regionDocumentByteLength = new TextEncoder().encode(regionDocumentContent).length;
  const effectiveRegionDocumentCategoryId = regions.some(
    (region) => region.id === regionDocumentCategoryId,
  ) ? regionDocumentCategoryId : regions[0]?.id || "";

  useEffect(() => {
    if (!open) return;
    titleRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const submitArxiv = () => {
    const value = arxivValue.trim();
    if (!ARXIV_PATTERN.test(value)) {
      setArxivError("Enter a valid arXiv ID or arxiv.org link.");
      return;
    }
    setArxivError("");
    onSaveArxiv(value);
    setArxivValue("");
  };

  const normalizedLibraryQuery = libraryQuery.trim().toLowerCase();
  const items = [...workspace.library.items]
    .filter((item) => {
      const statusMatch = libraryStatusFilter === "all" || item.status === libraryStatusFilter;
      const searchable = [
        item.displayTitle,
        item.citekey,
        item.graphPaperId,
        item.arxivId,
        item.arxivUrl,
        item.verificationLabel,
      ].filter(Boolean).join(" ").toLowerCase();
      return statusMatch && (!normalizedLibraryQuery || searchable.includes(normalizedLibraryQuery));
    })
    .sort((left, right) => {
      if (left.catalogSource !== right.catalogSource) {
        return left.catalogSource === "universe" ? -1 : 1;
      }
      return right.number - left.number;
    });
  const research = workspace.researchInformation;
  const activeProject = workspace.projects.items.find(
    (project) => project.id === workspace.projects.activeProjectId,
  );
  const visibleLocalContextPreview = localContextPreview?.projectId === workspace.projects.activeProjectId
    ? localContextPreview
    : null;
  const contextPacks = [
    ...(visibleLocalContextPreview ? [visibleLocalContextPreview] : []),
    ...workspace.contextPacks.filter(
      (pack) => pack.contextId !== visibleLocalContextPreview?.contextId,
    ),
  ].sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || ""));
  const selectedContext = contextPacks.find((pack) => pack.contextId === selectedContextId)
    || contextPacks[0];
  const selectedContextIsLocal = selectedContext?.contextKind === "local_preview"
    || selectedContext?.source === "local_preview"
    || selectedContext?.adopted === false
    || selectedContext?.adoptionState === "not_adopted";
  const partitionProposal = workspace.partitionProposals;
  const partitionProposalStale = Boolean(
    partitionProposal
    && (!workspace.health
      || String(workspace.health.revision) !== String(partitionProposal.baseRevision)),
  );
  const nativeHealth = workspace.health;
  const integrityIssueCount = nativeHealth
    ? new Set([
        ...(nativeHealth.missingSourcePaperIds || []),
        ...(nativeHealth.missingSourceHashPaperIds || []),
        ...(nativeHealth.hashMismatchPaperIds || []),
        ...(nativeHealth.missingCardPaperIds || []),
        ...(nativeHealth.missingFulltextPaperIds || []),
      ]).size
    : 0;
  const nextHealthAction = health.readyToRefresh > 0
    ? `${health.readyToRefresh} ${health.readyToRefresh === 1 ? "paper is" : "papers are"} ready to refresh.`
    : health.pendingCodex > 0
      ? `${health.pendingCodex} ${health.pendingCodex === 1 ? "paper is" : "papers are"} awaiting Codex curation.`
      : health.needsAttention > 0
        ? `${health.needsAttention} ${health.needsAttention === 1 ? "paper requires" : "papers require"} review.`
        : health.pendingRelations > 0
          ? `${health.pendingRelations} ${health.pendingRelations === 1 ? "relationship is" : "relationships are"} awaiting evidence scoring.`
          : "The library has no pending actions.";

  const copyPartitionChoice = async (option: PartitionProposalOption) => {
    if (!partitionProposal || partitionProposalStale) return;
    const text = partitionChoiceText(partitionProposal, option);
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      const temporary = document.createElement("textarea");
      temporary.value = text;
      temporary.readOnly = true;
      temporary.style.position = "fixed";
      temporary.style.opacity = "0";
      document.body.appendChild(temporary);
      temporary.select();
      copied = document.execCommand("copy");
      temporary.remove();
    }
    if (!copied) return;
    setCopiedPartitionOptionId(option.optionId);
    window.setTimeout(() => setCopiedPartitionOptionId(""), 1800);
  };

  return (
    <aside
      id="liteverse-settings"
      className={`settings-drawer glass-surface ${open ? "is-open" : ""}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby="settings-title"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="settings-heading">
        <span className="section-label">LIBRARY &amp; RESEARCH MEMORY</span>
        <h2 id="settings-title" ref={titleRef} tabIndex={-1}>Settings</h2>
        <p>Your source papers and research memory stay on this Mac.</p>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close settings">×</button>
        <div className="project-switcher">
          <label>
            <span>Active project</span>
            <select
              value={workspace.projects.activeProjectId}
              onChange={(event) => onSelectProject(event.target.value)}
              aria-label="Switch Liteverse project"
            >
              {workspace.projects.items.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <details>
            <summary>New</summary>
            <div>
              <input
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                placeholder="Project name"
                aria-label="New project name"
              />
              <button
                type="button"
                disabled={!newProjectName.trim()}
                onClick={() => {
                  onCreateProject(newProjectName.trim());
                  setNewProjectName("");
                }}
              >Create</button>
            </div>
          </details>
        </div>
      </div>

      <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
        <button
          type="button"
          id="settings-tab-literature"
          role="tab"
          aria-selected={activeTab === "literature"}
          aria-controls="settings-panel-literature"
          className={activeTab === "literature" ? "is-active" : ""}
          onClick={() => onTabChange("literature")}
        >
          Literature <i>{workspace.library.items.length}</i>
        </button>
        <button
          type="button"
          id="settings-tab-memory"
          role="tab"
          aria-selected={activeTab === "memory"}
          aria-controls="settings-panel-memory"
          className={activeTab === "memory" ? "is-active" : ""}
          onClick={() => onTabChange("memory")}
        >
          Memory <i>{workspace.projectMemory.items.length}</i>
        </button>
        <button
          type="button"
          id="settings-tab-context"
          role="tab"
          aria-selected={activeTab === "context"}
          aria-controls="settings-panel-context"
          className={activeTab === "context" ? "is-active" : ""}
          onClick={() => onTabChange("context")}
        >
          Context <i>{workspace.contextPacks.length + (visibleLocalContextPreview ? 1 : 0)}</i>
        </button>
        <button
          type="button"
          id="settings-tab-artifacts"
          role="tab"
          aria-selected={activeTab === "artifacts"}
          aria-controls="settings-panel-artifacts"
          className={activeTab === "artifacts" ? "is-active" : ""}
          onClick={() => onTabChange("artifacts")}
        >
          Artifacts <i>{workspace.artifacts.length}</i>
        </button>
        <button
          type="button"
          id="settings-tab-partitions"
          role="tab"
          aria-selected={activeTab === "partitions"}
          aria-controls="settings-panel-partitions"
          className={`${activeTab === "partitions" ? "is-active" : ""} ${partitionProposal ? "has-pending" : ""}`.trim()}
          onClick={() => onTabChange("partitions")}
        >
          Regions {partitionProposal && <em>Review</em>}
        </button>
      </nav>

      <div className="settings-scroll">
        {(notice || workspace.notice) && (
          <div className="workspace-notice" role="status">
            <i />{notice || workspace.notice}
          </div>
        )}
        {(error || arxivError) && (
          <div className="workspace-error" role="alert">{error || arxivError}</div>
        )}

        {activeTab === "literature" && (
          <div id="settings-panel-literature" className="settings-panel" role="tabpanel" aria-labelledby="settings-tab-literature">
            <section className="settings-card literature-upload-card">
              <div className="settings-section-heading">
                <span className="section-label">LITERATURE UPLOAD</span>
                <p>Import individual PDFs, link an existing local folder, or register an arXiv paper.</p>
              </div>

              <div className="upload-source-switch" role="tablist" aria-label="Upload source">
                <button
                  type="button"
                  id="upload-tab-pdf"
                  role="tab"
                  aria-selected={uploadSource === "pdf"}
                  aria-controls="upload-panel-pdf"
                  className={uploadSource === "pdf" ? "is-active" : ""}
                  onClick={() => setUploadSource("pdf")}
                >
                  PDF file
                </button>
                <button
                  type="button"
                  id="upload-tab-arxiv"
                  role="tab"
                  aria-selected={uploadSource === "arxiv"}
                  aria-controls="upload-panel-arxiv"
                  className={uploadSource === "arxiv" ? "is-active" : ""}
                  onClick={() => setUploadSource("arxiv")}
                >
                  arXiv link
                </button>
                <button
                  type="button"
                  id="upload-tab-folder"
                  role="tab"
                  aria-selected={uploadSource === "folder"}
                  aria-controls="upload-panel-folder"
                  className={uploadSource === "folder" ? "is-active" : ""}
                  onClick={() => setUploadSource("folder")}
                >
                  Local folder
                </button>
              </div>

              {uploadSource === "pdf" ? (
                <div id="upload-panel-pdf" className="upload-method upload-source-panel" role="tabpanel" aria-labelledby="upload-tab-pdf">
                  <div>
                    <span className="upload-icon">PDF</span>
                    <span><b>PDF file</b><small>The source is copied and prepared locally before scientific review.</small></span>
                  </div>
                  <button type="button" disabled={busyAction !== null} onClick={onPickPDF}>
                    {busyAction === "pdf" ? "Importing…" : "Choose PDF"}
                  </button>
                </div>
              ) : uploadSource === "folder" ? (
                <div id="upload-panel-folder" className="upload-method upload-source-panel" role="tabpanel" aria-labelledby="upload-tab-folder">
                  <div>
                    <span className="upload-icon is-folder">DIR</span>
                    <span>
                      <b>Address of your local literature</b>
                      <small>Ordinary PDFs are linked in place without duplicate copies. Connect Zotero to discover its stored PDF attachments read-only; external linked-file attachments remain unchanged.</small>
                    </span>
                  </div>
                  <div className="upload-folder-actions">
                    <button type="button" disabled={busyAction !== null} onClick={onPickLiteratureFolder}>
                      {busyAction === "folder" ? "Scanning…" : "Choose folder"}
                    </button>
                    <button type="button" disabled={busyAction !== null} onClick={onPickZoteroLibrary}>
                      {busyAction === "folder" ? "Please wait…" : "Connect Zotero"}
                    </button>
                  </div>
                </div>
              ) : (
                <label id="upload-panel-arxiv" className="arxiv-input upload-source-panel" role="tabpanel" aria-labelledby="upload-tab-arxiv">
                  <span>arXiv link</span>
                  <div>
                    <input
                      value={arxivValue}
                      onChange={(event) => {
                        setArxivValue(event.target.value);
                        setArxivError("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitArxiv();
                      }}
                      placeholder="https://arxiv.org/abs/2401.01234"
                      aria-label="arXiv link or identifier"
                    />
                    <button
                      type="button"
                      disabled={!arxivValue.trim() || busyAction !== null}
                      onClick={submitArxiv}
                    >
                      {busyAction === "arxiv" ? "Saving…" : "Save link"}
                    </button>
                  </div>
                  <small>The explicit paper is downloaded and prepared locally. Codex later verifies its scientific content and stellar connections.</small>
                </label>
              )}
            </section>

            <section className="library-section">
              <div className="settings-section-heading library-heading">
                <span className="section-label">LIBRARY</span>
                <small>{workspace.library.items.length} numbered {workspace.library.items.length === 1 ? "paper" : "papers"}</small>
              </div>
              <div className="library-health" aria-label="Library health">
                <div className="library-health-grid">
                  <span><b>{health.totalPapers}</b><small>Universe papers</small></span>
                  <span className="is-verified"><b>{health.evidenceVerified}</b><small>Verified</small></span>
                  <span className={health.needsAttention ? "is-attention" : ""}><b>{health.needsAttention}</b><small>Review needed</small></span>
                  <span><b>{health.pendingRelations}</b><small>Unscored links</small></span>
                </div>
                <p><i />{nextHealthAction}</p>
                <small>Candidate links {health.candidateRelations} · Verified links {health.verifiedRelations} · Draft cards {health.draftPapers}</small>
                {nativeHealth && (
                  <small className={integrityIssueCount ? "health-audit is-attention" : "health-audit"}>
                    Graph r{nativeHealth.revision} · schema {nativeHealth.graphSchemaVersion} · integrity issues {integrityIssueCount}
                    {(nativeHealth.hashMismatchPaperIds || []).length > 0 && ` · source hash mismatches ${nativeHealth.hashMismatchPaperIds.length}`}
                    {(nativeHealth.missingSourceHashPaperIds || []).length > 0 && ` · missing hashes ${nativeHealth.missingSourceHashPaperIds.length}`}
                  </small>
                )}
              </div>
              <div className="library-tools">
                <label>
                  <span aria-hidden="true">⌕</span>
                  <input
                    value={libraryQuery}
                    onChange={(event) => setLibraryQuery(event.target.value)}
                    placeholder="Search title, ID, or arXiv"
                    aria-label="Search library"
                  />
                  {libraryQuery && <button type="button" onClick={() => setLibraryQuery("")} aria-label="Clear library search">×</button>}
                </label>
                <select
                  value={libraryStatusFilter}
                  onChange={(event) => setLibraryStatusFilter(event.target.value as "all" | LibraryItem["status"])}
                  aria-label="Filter library by processing status"
                >
                  <option value="all">All statuses</option>
                  {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <p className="library-result-count">Showing {items.length} of {workspace.library.items.length}</p>
              <div className="library-list">
                {items.map((item) => (
                  <article key={item.id} className="library-item">
                    <div className="library-item-index">{libraryCode(item)}</div>
                    <div className="library-item-body">
                      <b>{item.displayTitle}</b>
                      <span>
                        {item.arxivUrl
                          ? item.arxivUrl
                          : item.catalogSource === "universe"
                            ? `${item.citekey || item.graphPaperId || "Organized paper"} · Local PDF`
                            : item.sourceType === "pdf"
                              ? item.source?.storageMode === "linked"
                                ? `Linked in place · ${item.source.relativePath || item.originalFilename || "local PDF"}`
                                : "arXiv ID pending"
                              : `arXiv ${item.arxivId || "awaiting lookup"}`}
                      </span>
                      <footer>
                        <small>{item.catalogSource === "universe" ? "Universe paper" : item.sourceType === "pdf" ? item.source?.storageMode === "linked" ? "Linked PDF" : "PDF" : "arXiv"}</small>
                        <small className={`library-status ${item.status}`}>{statusLabels[item.status]}</small>
                        {item.preparation && (
                          <small
                            className={`library-status ${item.preparation.state === "queued" ? "processing" : item.preparation.state === "ready" ? "ready_to_refresh" : "needs_attention"}`}
                            title={item.preparation.reason || `Local job ${item.preparation.jobId}`}
                          >
                            {preparationLabels[item.preparation.state]}
                            {item.preparation.resultState === "duplicate" ? " · duplicate" : ""}
                            {item.preparation.extractionStatus === "needs_ocr" ? " · OCR needed" : ""}
                          </small>
                        )}
                        {item.verificationLabel && (
                          <small className={`verification-chip ${item.verificationTone || "draft"}`} title={item.verificationDetail}>
                            {item.verificationLabel}
                          </small>
                        )}
                        <small>v{item.revision}</small>
                        {item.preparation?.state === "needs_attention" && item.catalogSource !== "universe" && (
                          <button
                            type="button"
                            className="library-preparation-retry"
                            onClick={() => onRetryLocalPreparation(item)}
                            title={item.preparation.reason || "Retry deterministic local preparation"}
                          >
                            Retry local preparation
                          </button>
                        )}
                      </footer>
                    </div>
                    <button
                      type="button"
                      className="library-open"
                      onClick={() => onOpenLibraryItem(item)}
                      aria-label={item.sourceType === "pdf" ? `Open the PDF for ${libraryCode(item)}` : `Open the arXiv page for ${libraryCode(item)} in a browser`}
                    >
                      ↗
                    </button>
                  </article>
                ))}
                {!workspace.library.items.length && (
                  <div className="settings-empty">
                    <span>✦</span>
                    <b>Your library is empty</b>
                    <p>Imported PDFs and arXiv entries receive stable identifiers here.</p>
                  </div>
                )}
                {workspace.library.items.length > 0 && !items.length && (
                  <div className="settings-empty is-compact">
                    <span>⌕</span>
                    <b>No matching papers</b>
                    <p>Clear the search or change the status filter and try again.</p>
                  </div>
                )}
              </div>
            </section>

            <section className="settings-card workspace-backup-card">
              <div className="settings-section-heading">
                <span className="section-label">BACKUP &amp; RECOVERY</span>
                <p>Export a verifiable local workspace. Imports restore into a separate area without overwriting the current universe.</p>
              </div>
              <label className="backup-pdf-option">
                <input
                  type="checkbox"
                  checked={includePDFsInBackup}
                  onChange={(event) => setIncludePDFsInBackup(event.target.checked)}
                />
                <span>
                  <b>Include source PDFs</b>
                  <small>When disabled, the graph, knowledge cards, full text, annotations, memory, and usage audit are still included.</small>
                </span>
              </label>
              <div className="workspace-backup-actions">
                <button type="button" onClick={() => onExportWorkspace(includePDFsInBackup)}>
                  Export workspace
                </button>
                <button type="button" className="is-secondary" onClick={onImportWorkspace}>
                  Verify and import backup
                </button>
              </div>
              <small className="settings-boundary">Managed directory: {workspace.health?.managedVaultPath || "Library/PDFs"}</small>
            </section>
          </div>
        )}

        {activeTab === "memory" && (
          <div id="settings-panel-memory" className="settings-panel" role="tabpanel" aria-labelledby="settings-tab-memory">
            <section className="settings-card research-card">
              <div className="settings-section-heading">
                <span className="section-label">RESEARCH INFORMATION · MEMORY CENTER · {activeProject?.name || "project-default"}</span>
                <p>Free-form text is preserved in full. The Research Memory Skill appends, verifies, and links structured memory and conflicts.</p>
              </div>
              <label className="research-editor">
                <textarea
                  value={researchDraft}
                  onChange={(event) => onResearchDraftChange(event.target.value)}
                  placeholder="For example: describe your current research goals, conventions, assumptions, open questions, and next steps…"
                  rows={12}
                  aria-describedby="research-editor-status"
                />
                <span id="research-editor-status">
                  No length limit · {researchDraft.length.toLocaleString("en-US")} characters · Memory revision {research.draft.revision}
                </span>
              </label>
              <button
                type="button"
                className="research-save"
                disabled={!researchDraft.trim() || busyAction !== null}
                onClick={onSaveResearch}
              >
                {busyAction === "research" ? "Saving…" : "Save research memory"}
              </button>
              <p className="settings-boundary">Saving updates this local research memory and preserves its revision history.</p>
            </section>

            <section className="settings-card region-document-card">
              <div className="settings-section-heading">
                <span className="section-label">NEBULA NOTES &amp; KNOWLEDGE CARDS</span>
                <p>Add personal knowledge to a nebula black hole. These documents become orbiting note stars and remain separate from paper evidence.</p>
              </div>
              {regions.length > 0 ? (
                <>
                  <div className="region-document-controls">
                    <label>
                      <span>Nebula</span>
                      <select
                        value={effectiveRegionDocumentCategoryId}
                        onChange={(event) => setRegionDocumentCategoryId(event.target.value)}
                      >
                        {regions.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>Document type</span>
                      <select
                        value={regionDocumentKind}
                        onChange={(event) => setRegionDocumentKind(event.target.value as "note" | "knowledge_card")}
                      >
                        <option value="note">Note</option>
                        <option value="knowledge_card">Knowledge Card</option>
                      </select>
                    </label>
                    <label>
                      <span>Text format</span>
                      <select
                        value={regionDocumentFormat}
                        onChange={(event) => setRegionDocumentFormat(event.target.value as "markdown" | "plain_text")}
                      >
                        <option value="markdown">Markdown</option>
                        <option value="plain_text">Plain text</option>
                      </select>
                    </label>
                  </div>
                  <label className="region-document-title">
                    <span>Title</span>
                    <input
                      value={regionDocumentTitle}
                      onChange={(event) => setRegionDocumentTitle(event.target.value)}
                      placeholder="For example: Core-radius convention used in this project"
                      maxLength={1_000}
                    />
                  </label>
                  <label className="region-document-editor">
                    <span>Content</span>
                    <textarea
                      value={regionDocumentContent}
                      onChange={(event) => setRegionDocumentContent(event.target.value)}
                      placeholder="Write or paste Markdown, equations, assumptions, or a personal knowledge card…"
                      rows={10}
                      spellCheck
                    />
                    <small className={regionDocumentByteLength > 1_048_576 ? "is-over-limit" : ""}>{regionDocumentByteLength.toLocaleString("en-US")} bytes · 1 MiB maximum</small>
                  </label>
                  <div className="region-document-actions">
                    <button
                      type="button"
                      disabled={!effectiveRegionDocumentCategoryId || !regionDocumentTitle.trim() || !regionDocumentContent.trim() || regionDocumentByteLength > 1_048_576 || busyAction !== null}
                      onClick={() => onSaveRegionDocument({
                        categoryId: effectiveRegionDocumentCategoryId,
                        kind: regionDocumentKind,
                        format: regionDocumentFormat,
                        title: regionDocumentTitle.trim(),
                        content: regionDocumentContent,
                      })}
                    >
                      {busyAction === "memory-document" ? "Saving…" : "Add to black hole"}
                    </button>
                    <button
                      type="button"
                      className="is-secondary"
                      disabled={!effectiveRegionDocumentCategoryId || busyAction !== null}
                      onClick={() => onImportRegionDocument({
                        categoryId: effectiveRegionDocumentCategoryId,
                        kind: regionDocumentKind,
                      })}
                    >
                      Import .md or .txt
                    </button>
                  </div>
                  <p className="settings-boundary">Imported files are read once and stored as project memory; only the basename and content hash are retained. User documents are never marked as scientifically verified paper evidence.</p>
                </>
              ) : (
                <div className="settings-empty is-compact">
                  <span>●</span><b>No nebula regions yet</b>
                  <p>Organize the first literature Refresh before assigning a personal document to a black hole.</p>
                </div>
              )}
            </section>

            <section className="memory-status-card settings-card">
              <div>
                <span className={`memory-state ${research.status}`} />
                <span>
                  <b>{research.formal.text ? "Curated memory available" : "Curated memory not yet available"}</b>
                  <small>
                    {research.status === "organized"
                      ? `Last saved ${updatedLabel(research.formal.organizedAt)}`
                      : research.formal.text
                        ? "Existing memory will be merged on the next save"
                        : "Save your first research note to establish project memory"}
                  </small>
                </span>
              </div>
              {research.formal.text && (
                <details>
                  <summary>View current curated memory</summary>
                  <ScientificText as="pre">{research.formal.text}</ScientificText>
                </details>
              )}
            </section>

            <section className="structured-memory-section">
              <div className="settings-section-heading library-heading">
                <span className="section-label">STRUCTURED MEMORY</span>
                <small>revision {workspace.projectMemory.revision}</small>
              </div>
              <div className="memory-card-list">
                {workspace.projectMemory.items.map((item) => {
                  const id = item.memoryId || item.id || `${item.type}-${item.updatedAt}`;
                  const provenance = Array.isArray(item.provenance)
                    ? item.provenance.join(" · ")
                    : item.provenance;
                  return (
                    <article key={id} className={`memory-card state-${item.state} evidence-${item.evidenceState}`}>
                      <header>
                        <span>{item.presentation?.kind === "knowledge_card" ? "knowledge card" : item.presentation?.kind || item.type}</span>
                        <i>{item.state}</i>
                        <i>{item.evidenceState}</i>
                      </header>
                      <b>{item.title || item.statement || item.content || "Untitled memory"}</b>
                      {item.title && <ScientificText as="p">{item.content || item.statement || ""}</ScientificText>}
                      <footer>
                        <small>{provenance || "unknown provenance"}</small>
                        <small>{updatedLabel(item.updatedAt || item.createdAt || "")}</small>
                      </footer>
                      {(item.supersedes?.length || item.contradicts?.length) ? (
                        <small className="memory-links">
                          {item.supersedes?.length ? `Supersedes ${item.supersedes.join(", ")}` : ""}
                          {item.supersedes?.length && item.contradicts?.length ? " · " : ""}
                          {item.contradicts?.length ? `Contradicts ${item.contradicts.join(", ")}` : ""}
                        </small>
                      ) : null}
                    </article>
                  );
                })}
                {!workspace.projectMemory.items.length && (
                  <div className="settings-empty is-compact">
                    <span>◇</span><b>No structured memory yet</b>
                    <p>Free-form memory is available immediately; liteverse-research-memory can organize it into traceable cards.</p>
                  </div>
                )}
              </div>
            </section>

            <section className="settings-card task-timeline-card">
              <div className="settings-section-heading">
                <span className="section-label">TASK TIMELINE</span>
                <p>Only hashed task identifiers are shown; original Codex task IDs are never stored.</p>
              </div>
              <div className="task-timeline">
                {workspace.tasks.slice(0, 20).map((task) => (
                  <article key={task.taskHash}>
                    <i className={`task-state ${task.status || "unknown"}`} />
                    <div>
                      <b>{task.summary || "Untitled research task"}</b>
                      <small>{task.taskHash.slice(0, 12)} · {task.status || "recorded"} · {updatedLabel(task.completedAt || task.startedAt || "")}</small>
                    </div>
                  </article>
                ))}
                {!workspace.tasks.length && <p className="empty-inline">No task history yet.</p>}
              </div>
            </section>
          </div>
        )}

        {activeTab === "context" && (
          <div id="settings-panel-context" className="settings-panel context-center" role="tabpanel" aria-labelledby="settings-tab-context">
            <section className="settings-card context-composer">
              <div className="settings-section-heading">
                <span className="section-label">AI CONTEXT CENTER</span>
                <p>Describe the task and set a character budget. The app builds a deterministic local preview without calling a model.</p>
              </div>
              <label>
                <span>Task</span>
                <textarea
                  value={contextQuery}
                  onChange={(event) => setContextQuery(event.target.value)}
                  rows={5}
                  placeholder="For example: use the Liteverse library to verify an initial-condition convention, then apply it to the simulation code."
                />
              </label>
              <label className="context-budget">
                <span>Context budget</span>
                <input
                  type="number"
                  min={2_000}
                  max={200_000}
                  step={1_000}
                  value={contextBudget}
                  onChange={(event) => setContextBudget(Math.max(2_000, Number(event.target.value) || 2_000))}
                />
                <small>{contextBudget.toLocaleString("en-US")} characters</small>
              </label>
              <div className="workspace-backup-actions context-composer-actions">
                <button
                  type="button"
                  aria-busy={contextPreviewBusy}
                  disabled={!contextQuery.trim() || contextPreviewBusy}
                  onClick={() => onBuildContextPreview(contextQuery.trim(), contextBudget)}
                >{contextPreviewBusy ? "Building local preview…" : "Build local preview"}</button>
                <button
                  type="button"
                  className="is-secondary"
                  disabled={!contextQuery.trim() || literatureSearchBusy}
                  onClick={() => onSearchLiterature(contextQuery.trim())}
                >{literatureSearchBusy ? "Searching with BM25…" : "Search local literature"}</button>
                <button
                  type="button"
                  className="is-secondary"
                  disabled={!contextQuery.trim() || contextPreviewBusy}
                  onClick={() => onQueueContext(contextQuery.trim(), contextBudget)}
                >Queue formal CLI build</button>
              </div>
              {contextPreviewError && <div className="workspace-error" role="alert">{contextPreviewError}</div>}
              <p className="settings-boundary">Local previews are deterministic and do not adopt evidence or update Usage. A queued formal build remains available to the Retriever and CLI.</p>
            </section>

            <section className="settings-card search-projection-card">
              <div className="settings-section-heading library-heading">
                <span className="section-label">LOCAL FTS5 / BM25 SEARCH</span>
                <small>{literatureSearchBusy ? "querying" : `${literatureSearch?.count || 0} papers`}</small>
              </div>
              <p className="settings-boundary">Uses the same SQLite index, terminology aliases, and verified relationship expansion as the Liteverse CLI. Search previews do not affect usage heat.</p>
              {literatureSearchError && <div className="workspace-error" role="alert">{literatureSearchError}</div>}
              <div className="claim-preview-list">
                {(literatureSearch?.results || []).map((paper) => (
                  <article key={paper.paperId} className="bm25-result-card">
                    <header>
                      <b>{paper.title}</b>
                      <span>{paper.inCurrentGraph === false ? "Awaiting refresh" : paper.verificationStatus || "indexed"}</span>
                    </header>
                    <p>{paper.snippet || paper.matchingClaims?.[0]?.text || "No excerpt was returned by the index."}</p>
                    {(paper.matchingClaims || []).slice(0, 3).map((claim) => (
                      <small key={claim.claimId || `${paper.paperId}-${claim.type}`}>
                        {claim.type || "claim"} · {claim.text || claim.statement || claim.claimId}
                      </small>
                    ))}
                    <footer>
                      <small>BM25 {Number.isFinite(paper.rank) ? paper.rank.toFixed(3) : "—"} · artifact r{paper.artifactRevision || "?"}</small>
                      <button
                        type="button"
                        disabled={paper.inCurrentGraph === false}
                        title={paper.inCurrentGraph === false ? "This paper has been curated. Refresh the universe before locating its star." : undefined}
                        onClick={() => onOpenSearchPaper(paper.paperId)}
                      >{paper.inCurrentGraph === false ? "Awaiting refresh" : "Locate star"}</button>
                    </footer>
                  </article>
                ))}
                {!literatureSearch && !literatureSearchBusy && !literatureSearchError && (
                  <div className="settings-empty is-compact"><span>⌕</span><b>Describe a task to search</b><p>The local index is queried only when needed; claims are not loaded into memory at startup.</p></div>
                )}
                {literatureSearch && !literatureSearch.results.length && <p className="empty-inline">No verified papers match this query.</p>}
              </div>
            </section>

            <section className="settings-card context-pack-browser">
              <div className="settings-section-heading">
                <span className="section-label">CONTEXT PACKS</span>
                <p>Formal packs pin exact graph and memory revisions. The latest local preview appears beside them without becoming adopted evidence.</p>
              </div>
              {contextPacks.length > 0 && (
                <select value={selectedContext?.contextId || ""} onChange={(event) => setSelectedContextId(event.target.value)}>
                  {contextPacks.map((pack) => (
                    <option key={pack.contextId} value={pack.contextId}>
                      {pack.contextKind === "local_preview" || pack.source === "local_preview" || pack.adopted === false || pack.adoptionState === "not_adopted"
                        ? `Local preview · not adopted — ${pack.query || pack.contextId}`
                        : `Formal CLI pack — ${pack.query || pack.contextId}`}
                    </option>
                  ))}
                </select>
              )}
              {selectedContext ? (
                <article className="context-pack-detail">
                  <header>
                    <div>
                      <span className={`context-pack-kind ${selectedContextIsLocal ? "is-local" : "is-formal"}`}>
                        {selectedContextIsLocal ? "Local preview · not adopted" : "Formal CLI pack"}
                      </span>
                      <b>{selectedContext.query || selectedContext.contextId}</b>
                    </div>
                    <small>Graph r{selectedContext.graphRevision ?? "?"} · Memory r{selectedContext.memoryRevision ?? "?"} · {selectedContext.budgetChars?.toLocaleString("en-US") || "?"} chars</small>
                  </header>
                  {selectedContextIsLocal && (
                    <p className="settings-boundary">Preview only. No paper was adopted and Usage was not changed.</p>
                  )}
                  <div className="context-pack-metrics">
                    <span><b>{selectedContext.selectedClaims?.length || 0}</b> claims</span>
                    <span><b>{selectedContext.projectMemory?.length || 0}</b> memories</span>
                    <span><b>{selectedContext.conflicts?.length || 0}</b> conflicts</span>
                    <span><b>{selectedContext.limitations?.length || 0}</b> limits</span>
                  </div>
                  <div className="claim-preview-list">
                    {(selectedContext.selectedClaims || []).slice(0, 20).map((claim, index) => (
                      <article key={claim.claimId || `${claim.paperId}-${index}`}>
                        <header><b>{claim.paperId || "paper"}</b><span>{claim.claimId || claim.evidenceId || "claim"}</span></header>
                        <p>{claim.statement || claim.text || claim.title}</p>
                        {(claim.artifactRevision || claim.artifactSha256) && (
                          <small>
                            Artifact {claim.artifactRevision ? `r${claim.artifactRevision}` : "revision unknown"}
                            {claim.artifactSha256 ? ` · ${claim.artifactSha256.slice(0, 12)}…` : ""}
                          </small>
                        )}
                        {(claim.whySelected || claim.reason) && <small>Selected because: {claim.whySelected || claim.reason}</small>}
                      </article>
                    ))}
                  </div>
                  <details><summary>Limitations and conflicts</summary><pre>{JSON.stringify({ limitations: selectedContext.limitations || [], conflicts: selectedContext.conflicts || [] }, null, 2)}</pre></details>
                  {!selectedContextIsLocal && (selectedContext.markdownPath || selectedContext.jsonPath) && (
                    <div className="workspace-backup-actions">
                      {selectedContext.markdownPath && <button type="button" onClick={() => onOpenWorkspacePath(selectedContext.markdownPath!)}>Open Markdown</button>}
                      {selectedContext.jsonPath && <button type="button" className="is-secondary" onClick={() => onOpenWorkspacePath(selectedContext.jsonPath!)}>Open JSON</button>}
                    </div>
                  )}
                </article>
              ) : (
                <div className="settings-empty is-compact"><span>✦</span><b>No context packs yet</b><p>Build a local preview now, or queue a formal Liteverse CLI pack for adopted evidence.</p></div>
              )}
            </section>
          </div>
        )}

        {activeTab === "artifacts" && (
          <div id="settings-panel-artifacts" className="settings-panel" role="tabpanel" aria-labelledby="settings-tab-artifacts">
            <section className="settings-card artifact-overview-card">
              <div className="settings-section-heading">
                <span className="section-label">CODE &amp; EXPERIMENT ARTIFACTS</span>
                <p>Stores paths, commits, hashes, commands, and summaries without copying large repositories or simulation data.</p>
              </div>
              <div className="artifact-list">
                {workspace.artifacts.map((artifact, index) => (
                  <article key={artifact.id || `${artifact.kind}-${index}`}>
                    <header><span>{artifact.kind}</span><i>{artifact.status || "recorded"}</i></header>
                    <b>{artifact.title || artifact.path || "Untitled artifact"}</b>
                    {artifact.summary && <p>{artifact.summary}</p>}
                    <dl>
                      {artifact.path && <><dt>path</dt><dd>{artifact.path}</dd></>}
                      {artifact.gitCommit && <><dt>commit</dt><dd>{artifact.gitCommit}</dd></>}
                      {artifact.hash && <><dt>hash</dt><dd>{artifact.hash}</dd></>}
                      {artifact.contentHash && <><dt>content hash</dt><dd>{artifact.contentHash}</dd></>}
                      {artifact.configHash && <><dt>config hash</dt><dd>{artifact.configHash}</dd></>}
                      {artifact.dataHash && <><dt>data hash</dt><dd>{artifact.dataHash}</dd></>}
                      {artifact.command && <><dt>command</dt><dd>{artifact.command}</dd></>}
                      {artifact.resultSummary && <><dt>result</dt><dd>{artifact.resultSummary}</dd></>}
                    </dl>
                  </article>
                ))}
                {!workspace.artifacts.length && (
                  <div className="settings-empty is-compact"><span>⌘</span><b>No code or experiment artifacts yet</b><p>The Research Memory Skill records reproducible summaries after Liteverse-backed research tasks.</p></div>
                )}
              </div>
            </section>
          </div>
        )}

        {activeTab === "partitions" && (
          <div id="settings-panel-partitions" className="settings-panel partition-proposal-panel" role="tabpanel" aria-labelledby="settings-tab-partitions">
            <section className="settings-card partition-proposal-overview">
              <div className="settings-section-heading">
                <span className="section-label">REGION PARTITION PROPOSALS</span>
                <p>Compare the three proposals prepared by Curator. The app does not select, apply, or modify the current graph.</p>
              </div>
              {partitionProposal ? (
                <>
                  <div className="partition-proposal-meta">
                    <span>Awaiting decision</span>
                    <code>{partitionProposal.proposalSetId}</code>
                    <small>
                      base Graph r{partitionProposal.baseRevision}
                      {partitionProposalStale
                        ? workspace.health
                          ? ` · current graph is r${workspace.health.revision}; proposal is stale`
                          : " · current revision not verified"
                        : " · matches the current graph revision"}
                    </small>
                    <small className="partition-proposal-search">Search scope: {partitionProposal.searchSummary}</small>
                    <small className="partition-proposal-truth">Source of truth: {partitionProposal.truthPath} · {partitionProposal.truthSha256.slice(0, 12)}…</small>
                  </div>
                  <div className="partition-proposal-list">
                    {partitionProposal.options.map((option) => (
                      <article key={option.optionId} className="partition-proposal-card">
                        <header>
                          <div>
                            <span>{option.optionId}</span>
                            <h3>{option.name}</h3>
                          </div>
                          <b>{option.regions.length} {option.regions.length === 1 ? "region" : "regions"}</b>
                        </header>
                        <p>{option.summary}</p>
                        <div className="partition-region-list" aria-label={`Regions in ${option.name}`}>
                          {option.regions.map((region, index) => (
                            <div key={partitionRegionId(region, index)}>
                              <span>{region.name}</span>
                              <b>{partitionRegionPaperCount(option, region, index)} papers</b>
                              {(region.summary || region.description) && <small>{region.summary || region.description}</small>}
                            </div>
                          ))}
                        </div>
                        <div className="partition-tradeoffs">
                          <section>
                            <h4>Strengths</h4>
                            <ul>{option.tradeoffs.strengths.map((item) => <li key={item}>{item}</li>)}</ul>
                          </section>
                          <section>
                            <h4>Limitations</h4>
                            <ul>{option.tradeoffs.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
                          </section>
                        </div>
                        <dl className="partition-metrics">
                          {Object.entries(option.metrics).map(([key, value]) => (
                            <div key={key}><dt>{key}</dt><dd>{partitionMetricLabel(value)}</dd></div>
                          ))}
                        </dl>
                        <button
                          type="button"
                          className="partition-copy-choice"
                          disabled={partitionProposalStale}
                          onClick={() => void copyPartitionChoice(option)}
                        >
                          {partitionProposalStale
                            ? "Ask Codex to regenerate three proposals"
                            : copiedPartitionOptionId === option.optionId
                            ? "Copied — paste into Codex"
                            : "Copy selection for Codex"}
                        </button>
                      </article>
                    ))}
                  </div>
                  <p className="settings-boundary partition-decision-boundary">
                    Paste the copied text into a Codex task to record the decision. Regions change only after Curator verifies the proposal and stages a Refresh. This view neither affects usage heat nor reads full text.
                  </p>
                </>
              ) : (
                <div className="settings-empty is-compact">
                  <span>◌</span><b>No region proposal awaiting review</b>
                  <p>The current graph remains unchanged. A review badge appears here after Curator generates three proposals.</p>
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      <footer className="settings-footer">
        <span>LOCAL-FIRST</span>
        <p>New papers are prepared locally, then remain pending until their scientific content is verified.</p>
      </footer>
    </aside>
  );
}
