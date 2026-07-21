export type Vector3 = [number, number, number];

export type NebulaAsset = {
  id: string;
  src: string;
  enabled: boolean;
};

export type GalaxyRecord = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  position: Vector3;
  assetId: string;
  seedPaperId: string;
};

export type Category = {
  id: string;
  kind?: "macro" | "system";
  name: string;
  description: string;
  color: string;
  center: Vector3;
  nebulaAssetId?: string;
  nebulaAssignmentOrder?: number;
};

export type PaperVerificationStatus =
  | "source_missing"
  | "imported"
  | "extracted"
  | "needs_ocr"
  | "card_draft"
  | "evidence_verified"
  | "needs_attention"
  | "legacy_summary"
  | string;

export type PaperVerificationSummary = {
  sourceSha256?: string;
  extractionStatus?: string;
  cardSchemaVersion?: string;
  evidenceCount?: number;
  verifiedAt?: string;
};

export type PaperIntegrityIssue =
  | "source_missing"
  | "source_hash_missing"
  | "source_hash_mismatch"
  | "card_missing"
  | "fulltext_missing";

export type PaperSource = {
  kind: "pdf" | "arxiv";
  storageMode?: "managed" | "linked";
  pdfPath?: string;
  linkedRootPath?: string;
  relativePath?: string;
  sha256?: string;
  arxivId?: string;
  doi?: string;
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

export type PaperArtifacts = {
  cardPath?: string;
  fulltextPath?: string;
  extractionStatus?: string;
  cardSchemaVersion?: string;
  evidenceCount?: number;
  integrity?: {
    artifactRevision?: number;
    artifactSha256?: string;
    cardSha256?: string;
    claimsSha256?: string;
    fulltextSha256?: string;
    immutableCardPath?: string;
    immutableClaimsPath?: string;
    immutableFulltextPath?: string;
    manifestPath?: string;
    sourceSha256?: string;
  };
};

export type Paper = {
  id: string;
  citekey: string;
  title: string;
  shortTitle: string;
  authors: string;
  year: number;
  primaryCategory: string;
  categoryIds: string[];
  galaxyId?: string;
  position: Vector3;
  useCount?: number;
  /** Legacy seed flag. It must never be treated as evidence verification. */
  verified?: boolean;
  verificationStatus?: PaperVerificationStatus;
  verificationSummary?: PaperVerificationSummary;
  source?: PaperSource;
  artifacts?: PaperArtifacts;
  summary: string;
  projectRole: string;
  pdfPath: string;
  markdownPath: string;
  fulltextPath?: string;
  tags: string[];
};

export type RelationStatus =
  | "verified"
  | "candidate"
  | "suggestion"
  | "legacy_unscored"
  | "project_inference"
  | string;

export type Relation = {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
  note: string;
  directional?: boolean;
  evidenceCount?: number;
  evidence?: string | RelationEvidence[];
  evidenceIds?: string[];
  status?: RelationStatus;
  scoringStatus?: string;
  strength?: number | null;
  confidence?: number | null;
  legacyConfidence?: number;
  legacyStatus?: string;
  relationVersion?: string;
  rubric?: string;
  formalEligible?: boolean;
};

export type RelationEvidence = {
  id: string;
  paperId: string;
  paraphrase: string;
  locator?: {
    page?: number | string;
    section?: number | string;
    equation?: number | string;
    figure?: number | string;
    table?: number | string;
  };
};

export type UniverseGraph = {
  schemaVersion: string | number;
  revision?: number;
  title?: string;
  updated: string;
  temperaturePolicy?: Record<string, unknown>;
  usagePolicy?: Record<string, unknown>;
  hierarchy?: {
    schemaVersion: "liteverse-hierarchy-v1" | string;
    algorithm: string;
    assignmentSha256?: string;
    relationProjection?: string;
  };
  visuals: {
    nebulaAssignmentVersion?: number;
    nebulaAssetCatalogVersion?: number;
    nebulaAssignmentSeed: string;
    nebulaAssets: NebulaAsset[];
    galaxyAssignmentSeed?: string;
  };
  categories: Category[];
  galaxies?: GalaxyRecord[];
  papers: Paper[];
  relations: Relation[];
};

export type UsageCounts = Record<string, number> | { counts?: Record<string, number> };

export type RefreshManifest = {
  refreshId: string;
  baseRevision: number;
  targetRevision?: number;
  snapshotSha256: string;
  newPaperIds?: string[];
  changedPaperIds?: string[];
  newRelationIds?: string[];
  changedRelationIds?: string[];
  addedPaperIds?: string[];
  addedRelationIds?: string[];
  papers?: RefreshDiff;
  relations?: RefreshDiff;
  categories?: RefreshDiff;
  animation?: {
    staggerMs?: number;
    waveDurationMs?: number;
  };
};

type RefreshDiff = {
  added?: string[];
  changed?: string[];
  removed?: string[];
};

export type PendingRefreshPayload = Partial<RefreshManifest> & {
  manifest?: Partial<RefreshManifest>;
  stagedSnapshot?: UniverseGraph;
  snapshot?: UniverseGraph;
};

export function visualHeat(useCount: number | undefined) {
  return Math.min(1, Math.log1p(Math.max(0, useCount || 0)) / Math.log1p(32));
}

export function paperCardPath(paper: Paper) {
  return paper.artifacts?.integrity?.immutableCardPath ||
    paper.artifacts?.cardPath ||
    paper.markdownPath;
}

export function paperFulltextPath(paper: Paper) {
  return paper.artifacts?.integrity?.immutableFulltextPath ||
    paper.artifacts?.fulltextPath ||
    paper.fulltextPath;
}

export function researchTextForSave(rawText: string) {
  return rawText.trim().length > 0 ? rawText : undefined;
}

export function paperVerificationState(paper: Paper, integrityIssue?: PaperIntegrityIssue) {
  const status = paper.verificationStatus || (paper.verified ? "legacy_summary" : "card_draft");
  const evidenceCount = Math.max(
    0,
    paper.artifacts?.evidenceCount || paper.verificationSummary?.evidenceCount || 0,
  );
  const sourceSha256 = paper.source?.sha256 || paper.verificationSummary?.sourceSha256;
  const fulltextPath = paperFulltextPath(paper);
  const cardPath = paperCardPath(paper);
  const sourceLabel = paper.source?.storageMode === "linked" ? "linked PDF" : "managed PDF";
  const hasVerificationClosure = Boolean(
    status === "evidence_verified" &&
    sourceSha256 &&
    fulltextPath &&
    cardPath &&
    evidenceCount > 0,
  );

  if (integrityIssue === "source_missing") {
    return { status: "needs_attention", tone: "attention" as const, label: "Source missing", detail: `The ${sourceLabel} source is unavailable` };
  }
  if (integrityIssue === "source_hash_missing") {
    return { status: "needs_attention", tone: "attention" as const, label: "Source hash missing", detail: `The graph has no SHA-256 for the ${sourceLabel}` };
  }
  if (integrityIssue === "source_hash_mismatch") {
    return { status: "needs_attention", tone: "attention" as const, label: "Source hash mismatch", detail: `The ${sourceLabel} SHA-256 does not match the graph record` };
  }
  if (integrityIssue === "card_missing") {
    return { status: "needs_attention", tone: "attention" as const, label: "Knowledge card missing", detail: "The knowledge card referenced by the graph is unavailable" };
  }
  if (integrityIssue === "fulltext_missing") {
    return { status: "needs_attention", tone: "attention" as const, label: "Full text missing", detail: "The full-text Markdown referenced by the graph is unavailable" };
  }

  if (hasVerificationClosure) {
    return {
      status,
      tone: "verified" as const,
      label: "Evidence verified",
      detail: `${evidenceCount} source evidence ${evidenceCount === 1 ? "item" : "items"}`,
    };
  }
  if (status === "source_missing") {
    return { status, tone: "attention" as const, label: "Source missing", detail: "Restore the source PDF" };
  }
  if (status === "needs_ocr") {
    return { status, tone: "attention" as const, label: "OCR required", detail: "Full text has not been extracted reliably" };
  }
  if (status === "needs_attention") {
    return { status, tone: "attention" as const, label: "Review required", detail: "Source or evidence issues need attention" };
  }
  if (status === "extracted") {
    return { status, tone: "progress" as const, label: "Full text extracted", detail: "Knowledge-card evidence awaits curation" };
  }
  if (status === "imported") {
    return { status, tone: "progress" as const, label: "Source imported", detail: "Awaiting full-text extraction" };
  }
  return {
    status,
    tone: "draft" as const,
    label: status === "legacy_summary" ? "Legacy summary" : "Knowledge-card draft",
    detail: "Source evidence has not yet been fully verified",
  };
}

export function normalizedPercent(value: number | null | undefined) {
  if (value === undefined || value === null || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value <= 1 ? value * 100 : value));
}

export function isRelationScored(relation: Relation) {
  return Number.isFinite(relation.strength) && normalizedPercent(relation.confidence) !== undefined;
}

export function relationDisplayState(relation: Relation) {
  if (!isRelationScored(relation)) return "unscored" as const;
  const strength = normalizedPercent(relation.strength) || 0;
  const confidence = normalizedPercent(relation.confidence) || 0;
  if (relation.formalEligible === false || relation.status === "suggestion") {
    return "suggestion" as const;
  }
  if (relation.status === "verified") {
    return strength >= 60 && confidence >= 75 ? "verified" as const : "suggestion" as const;
  }
  if (relation.status === "candidate") {
    return strength >= 40 && confidence >= 50 ? "candidate" as const : "suggestion" as const;
  }
  if (strength >= 60 && confidence >= 75) return "verified" as const;
  if (strength >= 40 && confidence >= 50) return "candidate" as const;
  return "suggestion" as const;
}

export function mergeUsageCounts(graph: UniverseGraph, input?: UsageCounts) {
  if (!input) return graph;
  const wrappedCounts = (input as { counts?: unknown }).counts;
  const counts: Record<string, number> =
    wrappedCounts && typeof wrappedCounts === "object" && !Array.isArray(wrappedCounts)
      ? wrappedCounts as Record<string, number>
      : input as Record<string, number>;
  return {
    ...graph,
    papers: graph.papers.map((paper) => ({
      ...paper,
      useCount: Math.max(0, Math.trunc(counts[paper.id] ?? paper.useCount ?? 0)),
    })),
  };
}

export function normalizePendingRefresh(payload: PendingRefreshPayload | null) {
  if (!payload) return null;
  const manifest = payload.manifest || {};
  const stagedSnapshot = payload.stagedSnapshot || payload.snapshot;
  const refreshId = payload.refreshId || manifest.refreshId;
  const baseRevision = payload.baseRevision ?? manifest.baseRevision;
  const snapshotSha256 = payload.snapshotSha256 || manifest.snapshotSha256;
  if (!refreshId || baseRevision === undefined || !snapshotSha256 || !stagedSnapshot) {
    return null;
  }
  return {
    refreshId,
    baseRevision,
    targetRevision: payload.targetRevision ?? manifest.targetRevision,
    snapshotSha256,
    stagedSnapshot,
    newPaperIds:
      payload.newPaperIds || payload.addedPaperIds || manifest.newPaperIds ||
      manifest.addedPaperIds || manifest.papers?.added || [],
    changedPaperIds:
      payload.changedPaperIds || manifest.changedPaperIds || manifest.papers?.changed || [],
    newRelationIds:
      payload.newRelationIds || payload.addedRelationIds || manifest.newRelationIds ||
      manifest.addedRelationIds || manifest.relations?.added || [],
    changedRelationIds:
      payload.changedRelationIds || manifest.changedRelationIds || manifest.relations?.changed || [],
    animation: payload.animation || manifest.animation,
  };
}

export type NormalizedPendingRefresh = NonNullable<ReturnType<typeof normalizePendingRefresh>>;
