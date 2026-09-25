export const TIER0_SCHEMA: "liteverse-tier0-brief-v1";
export const TIER0_LIBRARY_SCHEMA: "liteverse-tier0-library-v1";
export const TIER0_PARTITIONS_SCHEMA: "liteverse-tier0-partitions-v1";
export const GALAXY_PACKET_SCHEMA: "liteverse-galaxy-packet-v1";
export const GALAXY_DIGEST_SCHEMA: "liteverse-galaxy-digest-v1";
export const TIER0_BUILDER_VERSION: number;
export const TIER0_CLUSTER_ALGORITHM: "leiden-modularity-v1";
export const DEFAULT_SIMILARITY_WEIGHTS: Readonly<SimilarityWeights>;
export const RELATION_TYPES: readonly Tier1RelationType[];
export const MATRIX_FIELDS: readonly MatrixField[];
export const KEY_POINT_KINDS: readonly KeyPointKind[];

export type KeyPointKind = "question" | "method" | "result" | "limitation" | "assumption";
export type BriefQuality = "good" | "sparse" | "needs_ocr";
export type Tier1RelationType =
  | "extends"
  | "uses_method_of"
  | "contradicts"
  | "supports"
  | "reproduces"
  | "same_system_different_regime"
  | "compares";
export type MatrixField = "question" | "system" | "method" | "assumption" | "result" | "regime";

export type SimilarityWeights = { coupling: number; cocitation: number; text: number };

export type Page = { page: number; text: string; sha256: string; empty: boolean };

export type JournalRef = { name: string; volume: string; page: string };

export type TextSpan = {
  id: string;
  text: string;
  page: number;
  start: number;
  end: number;
  pageSha256: string;
};

export type KeyPoint = TextSpan & {
  kind: KeyPointKind;
  score: number;
  signals: string[];
};

export type Quantity = TextSpan & {
  value: number | null;
  unit: string | null;
  relation?: string;
  upper?: number | null;
  uncertainty?: number | null;
};

export type Reference = {
  index: number;
  label: string | null;
  text: string;
  arxivId: string | null;
  doi: string | null;
  year: number | null;
  yearSuffix: string | null;
  firstAuthor: string | null;
  journal: JournalRef | null;
};

export type ParsedReference = Omit<Reference, "index" | "label">;

export type CitationContext = { refIndex: number; text: string; page: number; start: number; end: number };

export type Keyphrase = { phrase: string; weight: number; count?: number };

export type Brief = {
  schemaVersion: "liteverse-tier0-brief-v1";
  builderVersion: number;
  tier: 0;
  status: "extracted_unreviewed";
  paperId: string;
  title: string;
  metadata: {
    authors: string[];
    year: number | null;
    arxivId: string | null;
    doi: string | null;
    journal: JournalRef | null;
  };
  fulltextSha256: string;
  pageCount: number;
  emptyPages: number[];
  quality: BriefQuality;
  identity: { arxivIds: string[]; dois: string[]; year: number | null };
  abstract: TextSpan | null;
  sections: Array<{ title: string; page: number }>;
  keyPoints: KeyPoint[];
  quantities: Quantity[];
  keyphrases: Keyphrase[];
  referenceStyle: "numeric" | "author-year" | "unknown" | "none";
  references: Reference[];
  citationContexts: CitationContext[];
  /** Added by the CLI cache writer. */
  origin?: "adopted" | "prepared";
  provenance?: Record<string, unknown>;
  inputFingerprint?: string;
};

export type BriefInput = {
  paperId: string;
  title?: string;
  authors?: string[] | string;
  year?: number | null;
  arxivId?: string | null;
  doi?: string | null;
  journal?: JournalRef | null;
  fulltext: string;
};

export type CitationEdge = {
  source: string;
  target: string;
  match: "exact" | "probable";
  via: "arxiv" | "doi" | "journal" | "author-year";
  refIndex: number;
  contexts: Array<{ text: string; page: number; start: number; end: number }>;
};

export type Neighbor = { id: string; weight: number; coupling: number; cocitation: number; text: number };

/** [partnerId, coupling, cocitation, text] */
export type SimilarityCandidate = [string, number, number, number];

export type ClusterLevel = {
  assignment: Record<string, number>;
  count: number;
  labels: string[];
  sizes: number[];
  /** Mean pairwise adjusted Rand index across seeds. */
  stability: number;
  stabilityMethod: string;
  /** Per-cluster mean best-match Jaccard against the other seeds. */
  clusterStability: number[];
  clusterStabilityMethod: string;
  /** Fine level only: coarse cluster index of each fine cluster. */
  parent?: number[];
};

export type LibraryAnalysis = {
  schemaVersion: "liteverse-tier0-library-v1";
  builderVersion: number;
  tier: 0;
  paperIds: string[];
  papers: Record<string, { title: string; year: number | null; quality: BriefQuality; fulltextSha256: string }>;
  citationEdges: CitationEdge[];
  inDegree: Record<string, number>;
  keyphrases: Record<string, Array<{ phrase: string; weight: number }>>;
  weights: SimilarityWeights;
  neighbors: Record<string, Neighbor[]>;
  similarityCandidates: Record<string, SimilarityCandidate[]>;
  clusters: {
    algorithm: "leiden-modularity-v1";
    weights: SimilarityWeights;
    resolution: number;
    seed: number;
    coarse: ClusterLevel;
    fine: ClusterLevel & { parent: number[] };
  };
  /** Keys are "coarse-<index>" and "fine-<index>". */
  readingPaths: Record<string, string[]>;
  /** Added by the CLI cache writer. */
  sources?: Record<string, { origin: "adopted" | "prepared"; provenance?: Record<string, unknown> }>;
  skipped?: Array<{ id: string; origin: string; reason: string }>;
  superseded?: Array<{ id: string; paperId: string; reason: string }>;
  inputFingerprint?: string;
};

export type LibraryOptions = {
  weights?: Partial<SimilarityWeights>;
  k?: number;
  seed?: number;
  resolution?: number;
  stabilitySeeds?: number;
};

export type PartitionOption = {
  id: "citation-structure" | "content" | "hybrid-broader";
  name: string;
  principle: string;
  weights: SimilarityWeights;
  resolution: number;
  algorithm: "leiden-modularity-v1";
  regions: Array<{ key: string; label: string; paperIds: string[]; consistency: number }>;
  counts: { papers: number; regions: number; regionSizes: number[] };
  assignment: Record<string, number>;
};

export type PartitionProposal = {
  schemaVersion: "liteverse-tier0-partitions-v1";
  options: PartitionOption[];
  differences: Array<{ left: string; right: string; fraction: number }>;
  materiallyDistinct: boolean;
  notes: string[];
};

export type SearchResult = {
  id: string;
  score: number;
  title: string;
  matchedQuote?: { id: string; kind: KeyPointKind; text: string; page: number };
};

export type SearchIndex = {
  size: number;
  search(query: string, options?: { limit?: number }): SearchResult[];
};

export type PacketQuote = { id: string; kind: KeyPointKind | "abstract"; text: string; page: number };

export type GalaxyPacket = {
  schemaVersion: "liteverse-galaxy-packet-v1";
  tier: 1;
  galaxyId: string;
  galaxyTitle: string;
  graphRevision: number | null;
  maxChars: number;
  truncated: boolean;
  papers: Array<{
    paperId: string;
    title: string;
    year: number | null;
    quality: BriefQuality;
    quotes: PacketQuote[];
    quantities: Array<{ id: string; text: string; value: number | null; unit: string | null; page: number }>;
  }>;
  citationContexts: Array<{ source: string; target: string; match: "exact" | "probable"; quoteId: string; text: string; page: number }>;
  candidatePairs: Array<{ source: string; target: string; reason: string }>;
  relationTypes: Tier1RelationType[];
  instructions: string;
  answerSchema: Record<string, unknown>;
  packetSha256: string;
};

export type DigestCell = { text: string; quoteIds: string[] } | null;

export type GalaxyDigest = {
  schemaVersion: "liteverse-galaxy-digest-v1";
  tier: 1;
  galaxyId: string;
  packetSha256: string;
  papers: Array<{ paperId: string; gist: string; gistQuoteIds: string[] }>;
  matrix: Array<{ paperId: string } & Record<MatrixField, DigestCell>>;
  relations: Array<{
    source: string;
    target: string;
    type: Tier1RelationType;
    sourceQuoteIds: string[];
    targetQuoteIds: string[];
    note: string;
    status: "candidate";
  }>;
  flags: Array<{ type: "duplicate" | "erratum" | "extraction_problem" | "out_of_scope" | "other"; paperIds: string[]; note: string }>;
};

export type Graph = {
  n: number;
  adjacency: Array<Array<[number, number]>>;
  strength: Float64Array;
  selfLoop: Float64Array;
  total: number;
};

export function sha256Bytes(bytes: Uint8Array): string;
export function sha256Hex(value: string): string;
export function canonicalJson(value: unknown): string;
export function mulberry32(seed: number): () => number;
export function normalizeTokenText(value: string): string;
export function tokenize(value: string): string[];
export function surnameKey(author: string): string;
export function sectionKind(title: string): string;
export function findArxivIds(text: string): string[];
export function findDois(text: string): string[];
export function parseReferenceEntry(raw: string): ParsedReference;
export function splitPages(fulltext: string): Page[];
export function buildPaperBrief(input: BriefInput): Brief;
export function buildLibraryAnalysis(briefs: readonly Brief[], options?: LibraryOptions): LibraryAnalysis;
export function proposePartitions(library: LibraryAnalysis, options?: { seed?: number; k?: number }): PartitionProposal;
export function createSearchIndex(
  briefs: readonly Brief[],
  extraDocs?: ReadonlyArray<{ id: string; title?: string; text?: string }>,
): SearchIndex;
export function buildGalaxyPacket(input: {
  galaxyId: string;
  galaxyTitle?: string;
  paperIds: string[];
  briefs: readonly Brief[] | Record<string, Brief> | Map<string, Brief>;
  library?: LibraryAnalysis | null;
  maxChars?: number;
  graphRevision?: number | null;
}): GalaxyPacket;
export function validateGalaxyDigest(
  packet: GalaxyPacket,
  digest: unknown,
): { ok: boolean; errors: string[]; warnings: string[]; digest: GalaxyDigest | null };
export function leiden(
  graph: Graph,
  options?: { resolution?: number; seed?: number; theta?: number; maxLevels?: number },
): Int32Array;
export function modularity(graph: Graph, assignment: ArrayLike<number>, resolution?: number): number;
export function adjustedRandIndex(left: ArrayLike<number>, right: ArrayLike<number>): number;
