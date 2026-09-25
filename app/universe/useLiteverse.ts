import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import emptyUniverseData from "../../data/empty-universe.json";
import {
  buildLibraryAnalysis,
  buildPaperBrief,
  type Brief as Tier0Brief,
  type LibraryAnalysis as Tier0Library,
} from "../../scripts/lib/liteverse-tier0.mjs";
import { installReceivers, post, requestId } from "./bridge";
import {
  mergeUsageCounts,
  normalizePendingRefresh,
  type NormalizedPendingRefresh,
  type PendingRefreshPayload,
  type UniverseGraph,
  type UsageCounts,
} from "./types";
import {
  EMPTY_WORKSPACE,
  normalizeWorkspaceState,
  type MemoryItem,
  type WorkspaceHealth,
  type WorkspaceState,
} from "./workspace";

export const FALLBACK_UNIVERSE = emptyUniverseData as unknown as UniverseGraph;

export type Annotation = {
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

export type KnowledgeCardPayload = {
  paperId: string;
  path: string;
  title?: string;
  sections: Array<{ id: string; title: string; content: string }>;
  evidence: Array<{ id: string; locator?: string; text: string }>;
  sourceSha256?: string;
  artifactSha256?: string;
  error?: string;
};

export type PowerState = {
  lowPowerMode: boolean;
  onBattery: boolean;
  thermalState: "nominal" | "fair" | "serious" | "critical";
  occluded: boolean;
};

export type IntelligenceStatus = {
  available: boolean;
  reason: string;
  model?: string;
};

export type IntelligenceDigest = {
  paperId: string;
  gist: string;
  keyPoints: Array<{ text: string; quoteIds: string[] }>;
  inputSha256: string;
  model: string;
  createdAt: string;
};

export type Tier0Source = {
  id: string;
  kind: "paper" | "item";
  title: string;
  authors: string[];
  year: number | null;
  arxivId?: string | null;
  doi?: string | null;
  fulltextSha256: string;
  fulltext: string;
};

type Tier0Payload = {
  briefs?: Record<string, Tier0Brief>;
  sources?: Tier0Source[];
  remaining?: number;
  removedIds?: string[];
};

export type Tier0State = {
  briefs: Map<string, Tier0Brief>;
  library: Tier0Library | null;
  pending: number;
  processing: boolean;
  error: string;
};

export type RefreshPhase = "idle" | "committing" | "revealing";

const DEFAULT_POWER: PowerState = {
  lowPowerMode: false,
  onBattery: false,
  thermalState: "nominal",
  occluded: false,
};

function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

export function useLiteverse(onCommand: (command: string) => void) {
  const [graph, setGraph] = useState<UniverseGraph>(FALLBACK_UNIVERSE);
  const [hasGraph, setHasGraph] = useState(false);
  const [runtimeError, setRuntimeError] = useState("");
  const [pendingRefresh, setPendingRefresh] = useState<NormalizedPendingRefresh | null>(null);
  const [refreshPhase, setRefreshPhase] = useState<RefreshPhase>("idle");
  const [refreshError, setRefreshError] = useState("");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationState, setAnnotationState] = useState<"idle" | "saving" | "saved">("idle");
  const [workspace, setWorkspace] = useState<WorkspaceState>(EMPTY_WORKSPACE);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [knowledgeCard, setKnowledgeCard] = useState<KnowledgeCardPayload | null>(null);
  const [power, setPower] = useState<PowerState>(DEFAULT_POWER);
  const [intelligence, setIntelligence] = useState<IntelligenceStatus>({ available: false, reason: "Checking Apple Intelligence…" });
  const [digests, setDigests] = useState<Map<string, IntelligenceDigest>>(new Map());
  const [digestQueue, setDigestQueue] = useState<string[]>([]);
  const [digestError, setDigestError] = useState("");
  const [tier0, setTier0] = useState<Tier0State>({ briefs: new Map(), library: null, pending: 0, processing: false, error: "" });

  const revisionRef = useRef<number | undefined>(FALLBACK_UNIVERSE.revision);
  const pendingRefreshRef = useRef<NormalizedPendingRefresh | null>(null);
  const annotationsRef = useRef<Annotation[]>([]);
  const briefsRef = useRef<Map<string, Tier0Brief>>(new Map());
  const tier0RunRef = useRef(0);
  const analysisTimerRef = useRef(0);
  const commandRef = useRef(onCommand);
  const activeDigestRef = useRef<{ requestId: string; paperId: string } | null>(null);

  useEffect(() => {
    commandRef.current = onCommand;
  }, [onCommand]);

  const scheduleAnalysis = useCallback(() => {
    window.clearTimeout(analysisTimerRef.current);
    analysisTimerRef.current = window.setTimeout(() => {
      try {
        const briefs = [...briefsRef.current.values()];
        const library = briefs.length ? buildLibraryAnalysis(briefs) : null;
        setTier0((current) => ({ ...current, library, error: "" }));
      } catch (analysisError) {
        setTier0((current) => ({ ...current, error: String((analysisError as Error).message || analysisError) }));
      }
    }, 120);
  }, []);

  const receiveTier0 = useCallback(async (payload: Tier0Payload) => {
    const run = ++tier0RunRef.current;
    const next = new Map(briefsRef.current);
    for (const [id, brief] of Object.entries(payload.briefs || {})) next.set(id, brief);
    for (const id of payload.removedIds || []) next.delete(id);
    briefsRef.current = next;
    const sources = payload.sources || [];
    setTier0((current) => ({
      ...current,
      briefs: new Map(next),
      pending: sources.length + (payload.remaining || 0),
      processing: sources.length > 0,
    }));
    if (sources.length === 0) {
      scheduleAnalysis();
      return;
    }
    const created: Record<string, Tier0Brief> = {};
    for (let index = 0; index < sources.length; index += 1) {
      if (run !== tier0RunRef.current) return;
      const source = sources[index];
      try {
        const brief = buildPaperBrief({
          paperId: source.id,
          title: source.title,
          authors: source.authors,
          year: source.year,
          arxivId: source.arxivId || null,
          doi: source.doi || null,
          fulltext: source.fulltext,
        });
        created[source.id] = brief;
        briefsRef.current.set(source.id, brief);
      } catch (briefError) {
        setTier0((current) => ({ ...current, error: `${source.title}: ${String((briefError as Error).message || briefError)}` }));
      }
      if (index % 4 === 3) {
        setTier0((current) => ({ ...current, briefs: new Map(briefsRef.current), pending: current.pending - 4 }));
        await yieldToBrowser();
      }
    }
    post("saveTier0", { briefs: created });
    setTier0((current) => ({
      ...current,
      briefs: new Map(briefsRef.current),
      pending: payload.remaining || 0,
      processing: Boolean(payload.remaining),
    }));
    scheduleAnalysis();
    if (payload.remaining) post("loadTier0", { continuation: true });
  }, [scheduleAnalysis]);

  const receiveGraph = useCallback((input: UniverseGraph | { graph: UniverseGraph; usageCounts?: UsageCounts }, usage?: UsageCounts) => {
    const envelope = input as { graph?: UniverseGraph; usageCounts?: UsageCounts };
    const nextGraph = envelope.graph || (input as UniverseGraph);
    const merged = mergeUsageCounts(nextGraph, usage || envelope.usageCounts);
    revisionRef.current = merged.revision;
    setGraph(merged);
    setHasGraph(true);
    setRuntimeError("");
  }, []);

  useEffect(() => {
    const cleanup = installReceivers({
      __liteverseReceiveUniverse: receiveGraph,
      __liteverseRefreshCommitted: ((input: UniverseGraph, usage?: UsageCounts) => {
        receiveGraph(input, usage);
        pendingRefreshRef.current = null;
        setPendingRefresh(null);
        setRefreshError("");
        setRefreshPhase("revealing");
        window.setTimeout(() => setRefreshPhase("idle"), 900);
        post("loadTier0", {});
      }) as never,
      __liteverseReceivePendingRefresh: ((payload: PendingRefreshPayload | null) => {
        const normalized = normalizePendingRefresh(payload);
        if (normalized && normalized.baseRevision !== revisionRef.current) {
          if (normalized.targetRevision === revisionRef.current) {
            post("commitRefresh", {
              refreshId: normalized.refreshId,
              baseRevision: normalized.baseRevision,
              snapshotSha256: normalized.snapshotSha256,
            });
            return;
          }
          setRefreshError("The graph revision changed. The staged update was preserved; curate it again before applying.");
        }
        pendingRefreshRef.current = normalized;
        setPendingRefresh(normalized);
      }) as never,
      __liteverseReceiveAnnotations: ((items: Annotation[]) => {
        annotationsRef.current = items;
        setAnnotations(items);
      }) as never,
      __liteverseAnnotationSaved: (() => {
        setAnnotationState("saved");
        window.setTimeout(() => setAnnotationState("idle"), 1400);
      }) as never,
      __liteverseReceiveWorkspace: ((raw: WorkspaceState) => {
        const next = normalizeWorkspaceState(raw);
        setWorkspace(next);
        setBusy(null);
        setError("");
        if (next.notice) setNotice(next.notice);
      }) as never,
      __liteverseReceiveWorkspaceHealth: ((health: WorkspaceHealth) => {
        setWorkspace((current) => ({ ...current, health }));
      }) as never,
      __liteverseWorkspaceExported: ((payload: { path: string }) => {
        setNotice(`Backup exported to ${payload.path}`);
      }) as never,
      __liteverseWorkspaceImported: ((payload: { recoveryPath?: string; path?: string; activated?: boolean }) => {
        setNotice(payload.activated
          ? "The backup was verified and is now the active workspace."
          : `Backup verified and stored in ${payload.recoveryPath || payload.path || "the recovery area"}.`);
      }) as never,
      __liteverseWorkspaceError: ((nativeError: { action?: string; message: string }) => {
        setBusy(null);
        const message = nativeError.message || "The local operation failed. Try again.";
        if (nativeError.action === "commitRefresh") {
          setRefreshError(message);
          setRefreshPhase("idle");
          return;
        }
        if (nativeError.action === "loadUniverse") {
          setHasGraph(false);
          setRuntimeError(message);
          return;
        }
        if (nativeError.action === "saveAnnotation") {
          setAnnotationState("idle");
          post("loadAnnotations", {});
        }
        if (nativeError.action === "loadKnowledgeCard") {
          setKnowledgeCard((current) => current ? { ...current, error: message } : null);
          return;
        }
        if (nativeError.action === "loadTier0" || nativeError.action === "saveTier0") {
          setTier0((current) => ({ ...current, processing: false, error: message }));
          return;
        }
        setError(message);
      }) as never,
      __liteverseReceiveKnowledgeCard: ((payload: KnowledgeCardPayload) => setKnowledgeCard(payload)) as never,
      __liteverseReceiveRegionDocument: ((payload: { projectId: string; memoryRevision: number; document: MemoryItem }) => {
        const memoryId = payload.document.memoryId || payload.document.id;
        if (!memoryId) return;
        setWorkspace((current) => {
          if (current.projects.activeProjectId !== payload.projectId) return current;
          const exists = current.projectMemory.items.some((item) => (item.memoryId || item.id) === memoryId);
          return {
            ...current,
            projectMemory: {
              revision: payload.memoryRevision,
              items: exists
                ? current.projectMemory.items.map((item) => (item.memoryId || item.id) === memoryId ? payload.document : item)
                : [...current.projectMemory.items, payload.document],
            },
          };
        });
      }) as never,
      __liteverseReceiveTier0: ((payload: Tier0Payload) => { void receiveTier0(payload); }) as never,
      __liteverseReceivePower: ((payload: Partial<PowerState>) => {
        setPower((current) => ({ ...current, ...payload }));
      }) as never,
      __liteverseCommand: ((command: string) => commandRef.current(command)) as never,
      __liteverseReceiveIntelligenceStatus: ((status: IntelligenceStatus) => setIntelligence(status)) as never,
      __liteverseReceiveIntelligenceDigests: ((items: IntelligenceDigest[]) => {
        setDigests((current) => {
          const next = new Map(current);
          for (const item of items || []) next.set(item.paperId, item);
          return next;
        });
      }) as never,
      __liteverseReceiveIntelligenceDigest: ((payload: { requestId: string; digest?: IntelligenceDigest; error?: string }) => {
        if (activeDigestRef.current?.requestId !== payload.requestId) return;
        const paperId = activeDigestRef.current.paperId;
        activeDigestRef.current = null;
        if (payload.digest) {
          setDigests((current) => new Map(current).set(payload.digest!.paperId, payload.digest!));
          setDigestError("");
        } else {
          setDigestError(payload.error || "Apple Intelligence could not summarize this paper.");
        }
        setDigestQueue((queue) => queue.filter((id) => id !== paperId));
      }) as never,
    });

    const attached = post("loadUniverse", {});
    if (attached) {
      post("observePendingRefresh", {});
      post("loadAnnotations", {});
      post("loadWorkspace", {});
      post("loadTier0", {});
      post("observePower", {});
      post("intelligenceStatus", {});
      post("loadIntelligenceDigests", {});
    } else {
      window.requestAnimationFrame(() => setHasGraph(true));
      setIntelligence({ available: false, reason: "Apple Intelligence is available in the Liteverse macOS app." });
    }
    return () => {
      cleanup();
      window.clearTimeout(analysisTimerRef.current);
    };
  }, [receiveGraph, receiveTier0]);

  // Summaries are generated one at a time; the on-device model processes a
  // single request per session and the queue stays cancellable.
  const briefs = tier0.briefs;
  useEffect(() => {
    if (activeDigestRef.current || digestQueue.length === 0) return;
    const paperId = digestQueue[0];
    const brief = briefs.get(paperId);
    if (!brief) {
      setDigestQueue((queue) => queue.slice(1));
      return;
    }
    const quotes = [
      ...(brief.abstract ? [{ id: `${paperId}:abstract`, kind: "abstract", text: brief.abstract.text.slice(0, 1400), page: brief.abstract.page }] : []),
      ...brief.keyPoints.map((point) => ({ id: point.id, kind: point.kind, text: point.text.slice(0, 420), page: point.page })),
    ];
    const id = requestId();
    activeDigestRef.current = { requestId: id, paperId };
    post("intelligenceDigest", { requestId: id, paperId, title: brief.title, quotes });
  }, [briefs, digestQueue]);

  const actions = useMemo(() => ({
    commitRefresh() {
      const pending = pendingRefreshRef.current;
      if (!pending) return;
      setRefreshPhase("committing");
      post("commitRefresh", {
        refreshId: pending.refreshId,
        baseRevision: pending.baseRevision,
        snapshotSha256: pending.snapshotSha256,
      });
    },
    importPDF() {
      setBusy("pdf");
      setNotice("");
      if (!post("pickLiteraturePDF")) setBusy(null);
    },
    linkFolder() {
      setBusy("folder");
      setNotice("");
      if (!post("pickLiteratureFolder")) setBusy(null);
    },
    connectZotero() {
      setBusy("folder");
      setNotice("");
      if (!post("pickZoteroLibrary")) setBusy(null);
    },
    addArxiv(value: string) {
      setBusy("arxiv");
      setNotice("");
      if (!post("saveArxiv", { value })) setBusy(null);
    },
    retryPreparation(itemId: string, expectedRevision: number) {
      post("retryLocalPreparation", { itemId, expectedRevision });
    },
    retryAllPreparation(items: Array<{ id: string; revision: number }>) {
      for (const item of items) post("retryLocalPreparation", { itemId: item.id, expectedRevision: item.revision });
      setNotice(`Retrying local preparation for ${items.length} ${items.length === 1 ? "paper" : "papers"}.`);
    },
    exportBackup(includePDFs: boolean) {
      post("exportWorkspace", { includePDFs });
    },
    importBackup() {
      post("importWorkspace");
    },
    selectProject(projectId: string) {
      post("setActiveProject", { projectId });
    },
    createProject(name: string) {
      if (name.trim()) post("createProject", { name: name.trim() });
    },
    saveProjectBrief(text: string, projectId: string, expectedRevision: number) {
      setBusy("brief");
      if (!post("saveResearchInformation", { text, projectId, expectedRevision })) setBusy(null);
    },
    saveNote(input: { projectId: string; memoryRevision: number; graphRevision: number; categoryId: string; title: string; content: string; format: "markdown" | "plain_text" }) {
      setBusy("note");
      post("saveRegionDocument", {
        projectId: input.projectId,
        expectedMemoryRevision: input.memoryRevision,
        expectedGraphRevision: input.graphRevision,
        categoryId: input.categoryId,
        kind: "note",
        format: input.format,
        title: input.title,
        content: input.content,
      });
    },
    importNote(input: { projectId: string; memoryRevision: number; graphRevision: number; categoryId: string }) {
      post("importRegionDocumentFile", {
        projectId: input.projectId,
        expectedMemoryRevision: input.memoryRevision,
        expectedGraphRevision: input.graphRevision,
        categoryId: input.categoryId,
        kind: "note",
      });
    },
    retireNote(input: { projectId: string; memoryRevision: number; graphRevision: number; categoryId: string; memoryId: string }) {
      post("retireRegionDocument", {
        projectId: input.projectId,
        expectedMemoryRevision: input.memoryRevision,
        expectedGraphRevision: input.graphRevision,
        categoryId: input.categoryId,
        memoryId: input.memoryId,
      });
    },
    saveAnnotation(annotation: Annotation) {
      const previous = annotationsRef.current;
      const next = previous.some((item) => item.id === annotation.id)
        ? previous.map((item) => item.id === annotation.id ? annotation : item)
        : [...previous, annotation];
      annotationsRef.current = next;
      setAnnotations(next);
      setAnnotationState("saving");
      if (!post("saveAnnotation", { annotation })) setAnnotationState("saved");
    },
    loadKnowledgeCard(paperId: string, path: string, expectedSha256?: string) {
      setKnowledgeCard({ paperId, path, sections: [], evidence: [] });
      post("loadKnowledgeCard", { paperId, path, expectedSha256 });
    },
    openFile(path: string) {
      post("open", { path });
    },
    openPDFAt(input: { paperId?: string; itemId?: string; path?: string; page: number; quote?: string }) {
      post("openPDFAtPage", input);
    },
    revealLibraryItem(id: string, arxiv: boolean) {
      post(arxiv ? "openExternalArxiv" : "openLibraryItem", { id });
    },
    summarize(paperIds: string[]) {
      setDigestError("");
      setDigestQueue((queue) => [...queue, ...paperIds.filter((id) => !queue.includes(id))]);
    },
    cancelSummaries() {
      setDigestQueue((queue) => queue.slice(0, activeDigestRef.current ? 1 : 0));
    },
    rebuildTier0() {
      briefsRef.current = new Map();
      setTier0({ briefs: new Map(), library: null, pending: 0, processing: true, error: "" });
      post("loadTier0", { rebuild: true });
    },
    clearMessages() {
      setNotice("");
      setError("");
    },
  }), []);

  return {
    graph,
    hasGraph,
    runtimeError,
    pendingRefresh,
    refreshPhase,
    refreshError,
    annotations,
    annotationState,
    workspace,
    notice,
    error,
    busy,
    knowledgeCard,
    power,
    intelligence,
    digests,
    digestQueue,
    digestError,
    tier0,
    actions,
  };
}

export type LiteverseState = ReturnType<typeof useLiteverse>;
