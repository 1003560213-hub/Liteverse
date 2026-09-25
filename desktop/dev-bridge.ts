/**
 * Development-only stand-in for the native macOS bridge. It serves a small,
 * entirely FICTIONAL library (invented titles, authors, identifiers, and text)
 * so the interface can be exercised with `npm run dev` in a browser. It is
 * never bundled into the packaged app: renderer.tsx imports it only when
 * `import.meta.env.DEV` is true.
 *
 * URL options: `?empty` starts with an empty library; `?papers=N` changes the
 * number of fictional papers (default 60).
 */

type Message = { action: string } & Record<string, unknown>;

const params = new URLSearchParams(window.location.search);
const EMPTY = params.has("empty");
const PAPER_COUNT = Math.max(4, Math.min(2000, Number(params.get("papers")) || 60));

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = mulberry32(20260925);
const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];

const THEMES = [
  {
    name: "Sediment Transport",
    words: ["bedload flux", "grain size", "shear stress", "ripple migration", "settling velocity"],
    methods: ["flume experiments", "a two-phase model", "particle tracking", "a stochastic transport model"],
  },
  {
    name: "Protein Folding Kinetics",
    words: ["folding rate", "transition state", "free-energy landscape", "contact order", "misfolded intermediate"],
    methods: ["molecular dynamics", "single-molecule spectroscopy", "a Markov state model", "coarse-grained simulation"],
  },
  {
    name: "Urban Heat Islands",
    words: ["surface temperature", "albedo", "canopy cover", "nocturnal cooling", "heat flux"],
    methods: ["satellite thermography", "a mesoscale weather model", "sensor networks", "regression kriging"],
  },
  {
    name: "Rotation Curves",
    words: ["rotation curve", "mass-to-light ratio", "disk scale length", "velocity dispersion", "halo profile"],
    methods: ["integral-field spectroscopy", "Jeans modelling", "a tilted-ring fit", "Bayesian inference"],
  },
] as const;

const SURNAMES = ["Arden", "Bellamy", "Castell", "Dorn", "Ellery", "Fenwick", "Galloway", "Hart", "Iverson", "Joss", "Kestrel", "Lindqvist", "Marlow", "Norcross", "Oakes", "Pryor", "Quint", "Rowan", "Sable", "Thorne"];

type FictionalPaper = {
  id: string;
  arxivId: string;
  title: string;
  authors: string[];
  year: number;
  theme: number;
  cites: number[];
};

function buildPapers(): FictionalPaper[] {
  const papers: FictionalPaper[] = [];
  for (let index = 0; index < PAPER_COUNT; index += 1) {
    const theme = index % THEMES.length;
    const t = THEMES[theme];
    const topic = pick(t.words);
    const other = pick(t.words);
    const title = pick([
      `On the ${topic} of ${other}s`,
      `${topic[0].toUpperCase()}${topic.slice(1)} and the ${other}`,
      `Constraints on the ${topic} from ${pick(t.methods)}`,
      `A note on ${topic} in the presence of ${other}`,
    ]);
    const year = 2012 + Math.floor((index / PAPER_COUNT) * 13);
    const cites: number[] = [];
    for (let attempt = 0; attempt < 5 && index > 0; attempt += 1) {
      const sameTheme = random() < 0.75;
      const candidate = Math.floor(random() * index);
      if (sameTheme && candidate % THEMES.length !== theme) continue;
      if (!cites.includes(candidate)) cites.push(candidate);
    }
    papers.push({
      id: `demo-paper-${String(index + 1).padStart(3, "0")}`,
      arxivId: `2${String(year).slice(2)}0${Math.floor(random() * 9)}.${String(10000 + index * 37).slice(0, 5)}`,
      title,
      authors: [pick(SURNAMES), pick(SURNAMES), pick(SURNAMES)].map((name, rank) => `${String.fromCharCode(65 + rank * 3)}. ${name}`),
      year,
      theme,
      cites,
    });
  }
  return papers;
}

const PAPERS = EMPTY ? [] : buildPapers();

function fulltextFor(paper: FictionalPaper) {
  const t = THEMES[paper.theme];
  const topic = pick(t.words);
  const method = pick(t.methods);
  const value = (1 + random() * 8).toFixed(1);
  const references = paper.cites.map((cited, index) => {
    const target = PAPERS[cited];
    return `[${index + 1}] ${target.authors[0]}, ${target.authors[1]}, ${target.year}, Fictional Journal ${40 + cited}, ${100 + cited}, arXiv:${target.arxivId}`;
  });
  const citeMarks = paper.cites.map((_, index) => `[${index + 1}]`).join(", ");
  return [
    "<!-- page: 1 -->",
    "",
    paper.title,
    paper.authors.join(", "),
    `arXiv:${paper.arxivId}v1 [demo.fiction] ${paper.year}`,
    "",
    "Abstract",
    `We study the ${topic} using ${method}. We find that the ${pick(t.words)} scales with the ${pick(t.words)} with an exponent of ${value} ± 0.3. Our results show that a simple model reproduces the numerical trend over two decades in scale.`,
    "",
    "1 Introduction",
    `Previous work established the basic picture of the ${topic} ${citeMarks ? citeMarks : ""}. In this paper we present a systematic treatment using ${method}. We assume that the system is isolated and that dissipation can be neglected.`,
    "",
    "<!-- page: 2 -->",
    "",
    "2 Methods",
    `We solve the governing equations with ${method} on a grid of 256^3 cells. The timestep is limited by a Courant condition with a safety factor of 0.25.`,
    "",
    "3 Results",
    `We find that the ${pick(t.words)} reaches a steady state after about ${value} dynamical times. Figure 2 shows that the ${topic} is insensitive to the initial conditions.`,
    "",
    "<!-- page: 3 -->",
    "",
    "4 Conclusions",
    `We have shown that ${method} captures the ${topic} to within ${Math.round(random() * 9 + 1)} per cent. A limitation of this work is that we neglect ${pick(t.words)} coupling, which should be tested in future work.`,
    "",
    "References",
    ...references,
  ].join("\n");
}

function sha(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(8);
}

const FULLTEXT = new Map(PAPERS.map((paper) => [paper.id, fulltextFor(paper)]));
const REVIEWED_COUNT = Math.floor(PAPERS.length * 0.55);

function graph() {
  const categories = THEMES.map((theme, index) => ({
    id: `demo-region-${index + 1}`,
    kind: "macro",
    name: theme.name,
    description: `Fictional demonstration region about ${theme.words[0]}.`,
    color: ["#8fb3ff", "#ffc98a", "#9ee0c8", "#d5a6ff"][index],
    center: [Math.cos((index / THEMES.length) * Math.PI * 2) * 7, (index % 2) * 1.2 - 0.6, Math.sin((index / THEMES.length) * Math.PI * 2) * 7],
    nebulaAssetId: `nebula-${index + 1}`,
  }));
  const reviewed = PAPERS.slice(0, REVIEWED_COUNT);
  return {
    schemaVersion: "3.0.0",
    revision: 12,
    title: "Liteverse demo",
    updated: "2026-09-01",
    visuals: { nebulaAssignmentSeed: "demo", nebulaAssets: [] },
    categories: EMPTY ? [] : categories,
    papers: reviewed.map((paper, index) => ({
      id: paper.id,
      citekey: `${paper.authors[0].split(" ")[1]}${paper.year}`,
      title: paper.title,
      shortTitle: paper.title.length > 60 ? `${paper.title.slice(0, 57)}…` : paper.title,
      authors: paper.authors.join(", "),
      year: paper.year,
      primaryCategory: categories[paper.theme].id,
      categoryIds: [categories[paper.theme].id],
      position: [0, 0, 0],
      verificationStatus: index % 3 === 0 ? "evidence_verified" : "card_draft",
      artifacts: { evidenceCount: index % 3 === 0 ? 4 : 0 },
      source: { kind: "arxiv", arxivId: paper.arxivId, sha256: sha(paper.id) },
      summary: `A fictional demonstration summary of "${paper.title}".`,
      projectRole: "",
      pdfPath: "",
      markdownPath: "",
      tags: [THEMES[paper.theme].words[index % 5]],
      useCount: Math.floor(random() * 12),
    })),
    relations: reviewed.flatMap((paper) => paper.cites
      .filter((cited) => cited < REVIEWED_COUNT)
      .slice(0, 1)
      .map((cited) => ({
        id: `demo-rel-${paper.id}-${cited}`,
        source: paper.id,
        target: PAPERS[cited].id,
        type: random() < 0.5 ? "extends" : "supports",
        label: "",
        note: "Fictional demonstration relation.",
        status: random() < 0.5 ? "verified" : "candidate",
        strength: 70,
        confidence: 80,
      }))),
  };
}

function workspace() {
  return {
    library: {
      schemaVersion: 1,
      nextNumber: PAPERS.length + 1,
      items: PAPERS.slice(REVIEWED_COUNT).map((paper, index) => ({
        id: paper.id,
        number: index + 1,
        sourceType: "arxiv",
        displayTitle: paper.title,
        titleStatus: "pending",
        arxivId: paper.arxivId,
        status: "pending_codex",
        revision: 2,
        createdAt: "2026-09-20T10:00:00Z",
        updatedAt: "2026-09-20T10:00:00Z",
        preparation: { schemaVersion: 1, state: index === 3 ? "needs_attention" : "ready", jobId: `job-${index}`, sourceRevision: 1, extractionStatus: "extracted", reason: index === 3 ? "Scanned PDF: text recognition found too little text." : undefined },
        source: { kind: "arxiv", catalogMetadata: { title: paper.title, authors: paper.authors } },
      })),
    },
    researchInformation: {
      schemaVersion: 1,
      status: "organized",
      draft: { text: "Fictional project brief for the demo library.", revision: 1, updatedAt: "2026-09-01T00:00:00Z" },
      formal: { text: "Fictional project brief for the demo library.", sourceRevision: 1, organizedAt: "2026-09-01T00:00:00Z" },
    },
    projects: { schemaVersion: 1, activeProjectId: "project-default", items: [{ id: "project-default", name: "Demo project" }] },
    projectMemory: {
      revision: 3,
      items: EMPTY ? [] : [{
        memoryId: "demo-note-1",
        type: "app_region_document",
        title: "Convention for units",
        content: "Fictional note: lengths in kiloparsecs, masses in solar masses.",
        state: "active",
        evidenceState: "user_declared",
        provenance: "user",
        scope: { kind: "nebula_region", categoryId: "demo-region-1" },
        presentation: { kind: "note", format: "markdown", title: "Convention for units" },
        createdAt: "2026-09-02T00:00:00Z",
      }],
    },
    tasks: [],
    contextPacks: [],
    artifacts: [],
    projectUseCounts: {},
    partitionProposals: null,
  };
}

const savedBriefs: Record<string, unknown> = {};

function call(name: string, ...args: unknown[]) {
  window.setTimeout(() => {
    const receiver = (window as unknown as Record<string, ((...values: unknown[]) => void) | undefined>)[name];
    receiver?.(...args);
  }, 30);
}

function handle(message: Message) {
  switch (message.action) {
    case "loadUniverse":
      call("__liteverseReceiveUniverse", { graph: graph() });
      break;
    case "loadWorkspace":
      call("__liteverseReceiveWorkspace", workspace());
      break;
    case "observePendingRefresh":
      call("__liteverseReceivePendingRefresh", null);
      break;
    case "loadAnnotations":
      call("__liteverseReceiveAnnotations", []);
      break;
    case "loadTier0": {
      const missing = PAPERS.filter((paper) => !savedBriefs[paper.id]);
      const batch = missing.slice(0, 80);
      call("__liteverseReceiveTier0", {
        briefs: message.rebuild ? {} : savedBriefs,
        sources: batch.map((paper) => ({
          id: paper.id,
          kind: PAPERS.indexOf(paper) < REVIEWED_COUNT ? "paper" : "item",
          title: paper.title,
          authors: paper.authors,
          year: paper.year,
          arxivId: paper.arxivId,
          doi: null,
          fulltextSha256: sha(FULLTEXT.get(paper.id) || ""),
          fulltext: FULLTEXT.get(paper.id) || "",
        })),
        remaining: missing.length - batch.length,
      });
      break;
    }
    case "saveTier0":
      Object.assign(savedBriefs, message.briefs as Record<string, unknown>);
      break;
    case "observePower":
      call("__liteverseReceivePower", { lowPowerMode: false, onBattery: false, thermalState: "nominal", occluded: false });
      break;
    case "intelligenceStatus":
      call("__liteverseReceiveIntelligenceStatus", { available: true, reason: "", model: "Demo stand-in (not Apple Intelligence)" });
      break;
    case "loadIntelligenceDigests":
      call("__liteverseReceiveIntelligenceDigests", []);
      break;
    case "intelligenceDigest": {
      const quotes = (message.quotes as Array<{ id: string; text: string }>) || [];
      window.setTimeout(() => call("__liteverseReceiveIntelligenceDigest", {
        requestId: message.requestId,
        digest: {
          paperId: message.paperId,
          gist: `Demo summary: ${quotes[0]?.text.slice(0, 160) || "No key points."}`,
          keyPoints: quotes.slice(1, 3).map((quote) => ({ text: quote.text.slice(0, 120), quoteIds: [quote.id] })),
          inputSha256: sha(JSON.stringify(quotes)),
          model: "demo",
          createdAt: new Date().toISOString(),
        },
      }), 400);
      break;
    }
    default:
      console.info("[dev bridge] unhandled action", message.action);
  }
}

(window as unknown as { webkit: unknown }).webkit = {
  messageHandlers: {
    liteverse: { postMessage: (message: Message) => handle(message) },
  },
};

export {};
