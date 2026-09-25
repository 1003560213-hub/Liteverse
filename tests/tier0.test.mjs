import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  adjustedRandIndex,
  buildGalaxyPacket,
  buildLibraryAnalysis,
  buildPaperBrief,
  createSearchIndex,
  leiden,
  modularity,
  mulberry32,
  parseReferenceEntry,
  proposePartitions,
  sha256Hex,
  splitPages,
  TIER0_SCHEMA,
  validateGalaxyDigest,
} from "../scripts/lib/liteverse-tier0.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts", "liteverse-cli.mjs");
const nodeSha = (value) => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------
// Fictional fixtures. All prose below is invented for these tests.

const HANDCRAFTED = `---
paper_id: "wave-a"
---

<!-- page: 1 -->

arXiv:2101.01234v2 [cond-mat.soft] 3 Feb 2021
Damped Oscillations in a Fictional Granular Medium
A. Rivera, B. Okafor
Abstract
We study damped oscillations in a fictional granular medium using a simple lattice model. We find that the damping rate scales linearly with grain density, reaching 12.5 km/s at the highest density. Our results suggest that friction dominates over viscosity in this regime.
Keywords: granular media, damping
1 Introduction
Granular media show rich dynamics [1, 2]. Previous work measured oscillation decay in dense packings, e.g. in vibrated columns (see Fig. 3 of Ref. [3]).
The origin of the damping remains an open question. In this paper we investigate whether friction or viscosity controls the decay. We assume that grains are rigid spheres of radius 1 mm.

<!-- page: 2 -->

2 Methods
We use a lattice model with 10^4 grains and integrate the equations of motion with a time step of 0.5 ms. The temperature is held at 300 K. The compu-
tation follows the scheme of Moreau et al. and uses 3.5 per cent damping noise.
Fig. 1. Damping rate versus grain density for the fictional medium.
3 Results
We find that the damping rate increases linearly with density, with a slope of 2.3 ± 0.2 s−1. The measured quality factor is Q ≈ 45 at low density. This trend is consistent with a friction-dominated picture [3-5].
4 Conclusions
We have shown that friction dominates the damping of oscillations in the fictional medium. However, our lattice model neglects grain rotation, which may limit the accuracy at high density. Future work should test the model with irregular grains.

<!-- page: 3 -->

[No extractable text on this page.]

<!-- page: 4 -->

References
[1] A. Moreau, C. Lin, Phys. Rev. E 89, 012345 (2014).
[2] D. Patel, J. Stone, arXiv:1905.01234 (2019).
[3] K. Rivera, B. Okafor, J. Fict. Mech. 12, 101 (2020), doi:10.1234/fict.2020.001.
[4] L. Ahmed, Granular Matter 7, 33 (2011).
[5] M. Chen, astro-ph/0601001.
`;

const AUTHOR_YEAR = `<!-- page: 1 -->

Sediment Pulses in a Fictional Tidal Channel
C. Lindqvist
Abstract. We present a fictional survey of sediment pulses in a tidal channel. We find that pulse amplitude grows with shear stress by about 40 per cent. The survey does not resolve individual grains.
1 INTRODUCTION
Tidal channels move sediment in pulses (Smith & Jones 2010). Earlier surveys reported similar pulses (Smith et al. 2014a; Okoro 2012). Smith et al. (2014b) proposed a settling model.
2 RESULTS
We show that the pulses repeat every 6 hr with an amplitude of 3.2 kg per metre. Pulse spacing follows the tidal period, as argued by Okoro (2012).

<!-- page: 2 -->

REFERENCES
Okoro, P. 2012, MNRAS 437, 2652
Smith, A., Jones, B.,
Lee, C. 2010, ApJ, 788, 12
Smith, A., Tran, D., Novak, E. 2014a, Phys. Rev. D 95, 043541
Smith, A., Novak, E. 2014b, A&A, 594, A13, doi:10.5555/fict.9.
van der Berg, H. 2016, arXiv:1605.04321
`;

const TOPICS = [
  {
    key: "granular",
    title: ["Granular Packing", "Grain Friction", "Damping Rate", "Vibrated Columns"],
    system: "a vibrated granular packing",
    terms: ["granular packing", "grain friction", "damping rate", "lattice model", "vibrated column", "contact network"],
    unit: "mm",
  },
  {
    key: "sediment",
    title: ["Sediment Flux", "Tidal Channels", "Settling Velocity", "Shear Stress"],
    system: "a coastal tidal channel",
    terms: ["sediment flux", "tidal channel", "settling velocity", "shear stress", "bed roughness", "suspended load"],
    unit: "kg",
  },
  {
    key: "spikes",
    title: ["Spike Timing", "Synaptic Delay", "Firing Rate", "Cortical Columns"],
    system: "a model cortical column",
    terms: ["spike timing", "synaptic delay", "firing rate", "cortical column", "inhibitory feedback", "membrane potential"],
    unit: "ms",
  },
  {
    key: "phonons",
    title: ["Phonon Scattering", "Thermal Conductivity", "Alloy Disorder", "Heat Pulses"],
    system: "a disordered alloy lattice",
    terms: ["phonon scattering", "thermal conductivity", "alloy disorder", "heat pulse", "mean free path", "boundary resistance"],
    unit: "K",
  },
];
const SURNAMES = [
  "Alvarez", "Brandt", "Castellano", "Dubois", "Eriksen", "Fontaine", "Gallagher", "Haddad", "Ibarra", "Jansen",
  "Kowalski", "Laurent", "Moreno", "Nakamura", "Oyelaran", "Petrov", "Quintero", "Rasmussen", "Silva", "Takeda",
  "Ueda", "Varga", "Whitfield", "Xu", "Yilmaz", "Zamora", "Abara", "Bello", "Cruz", "Dahl",
];

function paperMeta(index, topicCount = TOPICS.length) {
  const topic = index % topicCount;
  const year = 2015 + (index % 11);
  const surname = SURNAMES[index % SURNAMES.length];
  const month = String((index % 12) + 1).padStart(2, "0");
  const arxivId = `${String(year % 100).padStart(2, "0")}${month}.${String(10000 + index).padStart(5, "0")}`;
  return {
    paperId: `paper-${String(index).padStart(4, "0")}`,
    topic,
    year,
    surname,
    authors: [`${String.fromCharCode(65 + (index % 26))}. ${surname}`, "Q. Fictional"],
    arxivId,
    doi: `10.5555/fict.${index}`,
    journal: { name: "J. Fict. Phys.", volume: String(10 + index), page: String(100 + index) },
  };
}

/**
 * Generate a fictional page-marked paper. Papers of the same topic cite each
 * other (earlier indexes) by arXiv ID, DOI, or author-year + journal, and share
 * a pool of fictional external references so bibliographic coupling works.
 */
function syntheticPaper(index, { pages = 6, topicCount = TOPICS.length, citeWindow = 6, stamp = true } = {}) {
  const meta = paperMeta(index, topicCount);
  const topic = TOPICS[meta.topic];
  const random = mulberry32(1000 + index);
  const pick = (values) => values[Math.floor(random() * values.length)];
  const term = () => pick(topic.terms);
  const references = [];
  const cited = [];
  for (let other = index - topicCount; other >= 0 && cited.length < citeWindow; other -= topicCount) cited.push(other);
  for (const other of cited) {
    const target = paperMeta(other, topicCount);
    const style = other % 3;
    if (style === 0) references.push(`${target.authors[0]}, Q. Fictional, arXiv:${target.arxivId} (${target.year}).`);
    else if (style === 1) references.push(`${target.authors[0]}, Q. Fictional, J. Fict. Rev. ${target.year - 1990}, 7 (${target.year}), doi:${target.doi}.`);
    else references.push(`${target.authors[0]}, Q. Fictional, ${target.journal.name} ${target.journal.volume}, ${target.journal.page} (${target.year}).`);
  }
  for (let shared = 0; shared < 8; shared += 1) {
    if (random() < 0.75) references.push(`R. Pool${topic.key}${shared}, Fict. Lett. ${40 + meta.topic * 10 + shared}, ${200 + shared} (199${shared}).`);
  }
  references.push(`S. Unique${index}, Fict. Notes ${500 + index}, 1 (1999).`);
  const cite = () => `[${1 + Math.floor(random() * references.length)}]`;
  const titleWords = [pick(topic.title), pick(topic.title)];
  const title = `${titleWords[0]} and ${titleWords[1]} in ${topic.system.replace(/^a /, "a Fictional ")} ${index}`;
  const paragraph = (count) => Array.from({ length: count }, () => {
    const choice = Math.floor(random() * 5);
    if (choice === 0) return `The ${term()} depends on the ${term()} through a nonlinear coupling ${cite()}.`;
    if (choice === 1) return `A second estimate of the ${term()} uses the ${term()} measured at ${Math.floor(random() * 90) + 10} ${topic.unit}.`;
    if (choice === 2) return `Previous studies of the ${term()} reported a weaker trend in ${topic.system} ${cite()}.`;
    if (choice === 3) return `This behaviour of the ${term()} is expected when the ${term()} is small.`;
    return `The ${term()} and the ${term()} were recorded together for every run.`;
  }).join(" ");
  const out = [];
  out.push(`<!-- page: 1 -->\n\n${stamp ? `arXiv:${meta.arxivId}v1 [fict.gen] 2 Mar ${meta.year}\n` : ""}${title}\n${meta.authors.join(", ")}\nAbstract\nWe investigate how the ${topic.terms[0]} controls the ${topic.terms[1]} in ${topic.system}. We find that the ${topic.terms[2]} increases by ${10 + (index % 40)} per cent when the ${topic.terms[3]} doubles. Our results show that the ${topic.terms[4]} sets the scale of the ${topic.terms[5]}.\nKeywords: ${topic.terms[0]}, ${topic.terms[1]}\n1 Introduction\n${paragraph(4)}\n\nIn this paper we examine whether the ${topic.terms[0]} depends on the ${topic.terms[3]}. We assume that the ${topic.terms[5]} is uniform across ${topic.system}.\n`);
  for (let page = 2; page < pages; page += 1) {
    let body = "";
    if (page === 2) body += `2 Methods\nWe use a ${topic.terms[3]} simulation with ${1000 + index} samples and a step of 0.${(index % 9) + 1} ${topic.unit}.\n`;
    body += `${paragraph(6)}\n\n${paragraph(6)}\n`;
    if (page === 3 || (pages <= 3 && page === 2)) body += `Fig. ${page}. The ${topic.terms[2]} versus the ${topic.terms[3]} for run ${index}.\n3 Results\nWe show that the ${topic.terms[2]} reaches ${(index % 7) + 2}.5 ${topic.unit} for the densest ${topic.terms[0]}.\n`;
    if (page === pages - 1) body += `4 Conclusions\nWe have demonstrated that the ${topic.terms[0]} controls the ${topic.terms[1]}. However, the ${topic.terms[3]} simulation neglects the ${topic.terms[5]}, which may limit the accuracy.\n`;
    out.push(`<!-- page: ${page} -->\n\n${body}`);
  }
  out.push(`<!-- page: ${pages} -->\n\nReferences\n${references.map((text, position) => `[${position + 1}] ${text}`).join("\n")}\n`);
  return {
    ...meta,
    title,
    fulltext: out.join("\n"),
  };
}

function briefFor(paper, { supplyIds = true } = {}) {
  return buildPaperBrief({
    paperId: paper.paperId,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    arxivId: supplyIds && paper.paperId.endsWith("0") ? paper.arxivId : null,
    doi: supplyIds ? paper.doi : null,
    journal: paper.journal,
    fulltext: paper.fulltext,
  });
}

function pageText(brief, fulltext, page) {
  return splitPages(fulltext).find((item) => item.page === page).text;
}

function assertVerbatim(brief, fulltext) {
  const pages = splitPages(fulltext);
  const byPage = new Map(pages.map((page) => [page.page, page]));
  for (const item of [...brief.keyPoints, ...brief.quantities, ...(brief.abstract ? [brief.abstract] : [])]) {
    const page = byPage.get(item.page);
    assert.equal(page.text.slice(item.start, item.end), item.text, `span ${item.id} is not verbatim`);
    assert.equal(item.pageSha256, page.sha256);
  }
  for (const item of brief.citationContexts) assert.equal(byPage.get(item.page).text.slice(item.start, item.end), item.text);
}

// ---------------------------------------------------------------------------
// Hashing and pages.

test("sha256Hex matches node:crypto across block boundaries and Unicode", () => {
  const cases = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "a".repeat(65), "x".repeat(1000),
    "Ω ≈ 10⁻²² eV · \u8cea\u91cf · 🌌", "\ud800 lone surrogate", "line\r\nbreak\u0000nul"];
  const random = mulberry32(7);
  cases.push(Array.from({ length: 5000 }, () => String.fromCharCode(32 + Math.floor(random() * 3000))).join(""));
  for (const value of cases) assert.equal(sha256Hex(value), nodeSha(Buffer.from(value, "utf8")), JSON.stringify(value.slice(0, 20)));
});

test("splitPages reads markers, empty placeholders, and marker-less text", () => {
  const pages = splitPages("---\npaper_id: x\n---\n<!-- page: 1 -->\n\n  First page.  \n\n<!-- page: 2 -->\n\n[No extractable text on this page.]\n\n<!--page:3-->\nThird\n");
  assert.deepEqual(pages.map((page) => [page.page, page.text, page.empty]), [[1, "First page.", false], [2, "", true], [3, "Third", false]]);
  assert.equal(pages[0].sha256, nodeSha("First page."));
  const plain = splitPages("---\ntitle: t\n---\nJust text\n");
  assert.deepEqual(plain.map((page) => [page.page, page.text]), [[1, "Just text"]]);
});

// ---------------------------------------------------------------------------
// Paper brief.

test("buildPaperBrief extracts verbatim, hash-pinned key points, quantities, identity, and references", () => {
  const brief = buildPaperBrief({ paperId: "wave-a", title: "Damped Oscillations in a Fictional Granular Medium", authors: ["A. Rivera", "B. Okafor"], fulltext: HANDCRAFTED });
  assert.equal(brief.schemaVersion, TIER0_SCHEMA);
  assert.equal(brief.fulltextSha256, nodeSha(HANDCRAFTED));
  assert.equal(brief.pageCount, 4);
  assert.deepEqual(brief.emptyPages, [3]);
  assert.deepEqual(brief.identity.arxivIds, ["2101.01234"]);
  assert.equal(brief.identity.year, 2021);
  assert.match(brief.abstract.text, /^We study damped oscillations/);
  assert.match(brief.abstract.text, /in this regime\.$/);
  assert.deepEqual(brief.sections.map((section) => section.title), ["Abstract", "1 Introduction", "2 Methods", "3 Results", "4 Conclusions", "References"]);

  assert.ok(brief.keyPoints.length >= 3 && brief.keyPoints.length <= 8);
  assert.ok(brief.keyPoints.some((point) => point.kind === "result"));
  assert.ok(brief.keyPoints.some((point) => point.kind === "limitation"));
  for (const point of brief.keyPoints) {
    assert.match(point.id, /^q-[a-f0-9]{16}$/);
    assert.equal(point.id, `q-${nodeSha(`wave-a|${point.page}|${point.start}|${point.end}`).slice(0, 16)}`);
    assert.equal(pageText(brief, HANDCRAFTED, point.page).slice(point.start, point.end), point.text);
  }
  const cited = brief.keyPoints.find((point) => point.text.includes("[3-5]"));
  assert.ok(!cited || cited.signals.includes("citation_marker"));
  assertVerbatim(brief, HANDCRAFTED);

  const quantity = (unit) => brief.quantities.find((item) => item.unit === unit);
  assert.equal(quantity("km/s").value, 12.5);
  assert.equal(quantity("K").value, 300);
  assert.equal(quantity("ms").value, 0.5);
  assert.equal(quantity("s^-1").value, 2.3);
  assert.equal(quantity("s^-1").uncertainty, 0.2);
  assert.equal(quantity("%").value, 3.5);
  assert.ok(brief.quantities.some((item) => item.relation === "≈" && item.value === 45));
  assert.ok(brief.quantities.length <= 12);

  assert.equal(brief.referenceStyle, "numeric");
  assert.equal(brief.references.length, 5);
  assert.deepEqual(brief.references[0].journal, { name: "Phys. Rev. E", volume: "89", page: "012345" });
  assert.equal(brief.references[0].firstAuthor, "Moreau");
  assert.equal(brief.references[0].year, 2014);
  assert.equal(brief.references[1].arxivId, "1905.01234");
  assert.equal(brief.references[2].doi, "10.1234/fict.2020.001");
  assert.equal(brief.references[4].arxivId, "astro-ph/0601001");
  const contextRefs = (needle) => brief.citationContexts.filter((context) => context.text.includes(needle)).map((context) => context.refIndex);
  assert.deepEqual(contextRefs("rich dynamics"), [1, 2]);
  assert.deepEqual(contextRefs("friction-dominated"), [3, 4, 5]);
  assert.deepEqual(contextRefs("vibrated columns"), [3]);
});

test("sentence splitting keeps abbreviations, decimals, and hyphenated line breaks inside one verbatim span", () => {
  const brief = buildPaperBrief({ paperId: "wave-a", fulltext: HANDCRAFTED });
  const page2 = pageText(brief, HANDCRAFTED, 2);
  const quantity = brief.quantities.find((item) => item.unit === "%");
  assert.equal(quantity.text, "The compu-\ntation follows the scheme of Moreau et al. and uses 3.5 per cent damping noise.");
  assert.equal(page2.slice(quantity.start, quantity.end), quantity.text);
  const caption = brief.keyPoints.find((point) => point.text.startsWith("Fig. 1."));
  if (caption) assert.equal(caption.text, "Fig. 1. Damping rate versus grain density for the fictional medium.");
  const context = brief.citationContexts.find((item) => item.refIndex === 3 && item.page === 1);
  assert.equal(context.text, "Previous work measured oscillation decay in dense packings, e.g. in vibrated columns (see Fig. 3 of Ref. [3]).");
});

test("author-year references segment hanging entries and resolve in-text markers", () => {
  const brief = buildPaperBrief({ paperId: "tide-b", title: "Sediment Pulses in a Fictional Tidal Channel", authors: ["C. Lindqvist"], fulltext: AUTHOR_YEAR });
  assert.equal(brief.referenceStyle, "author-year");
  assert.deepEqual(brief.references.map((entry) => entry.firstAuthor), ["Okoro", "Smith", "Smith", "Smith", "van der Berg"]);
  assert.deepEqual(brief.references.map((entry) => `${entry.year}${entry.yearSuffix ?? ""}`), ["2012", "2010", "2014a", "2014b", "2016"]);
  assert.deepEqual(brief.references[0].journal, { name: "MNRAS", volume: "437", page: "2652" });
  assert.deepEqual(brief.references[1].journal, { name: "ApJ", volume: "788", page: "12" });
  assert.deepEqual(brief.references[2].journal, { name: "Phys. Rev. D", volume: "95", page: "043541" });
  assert.deepEqual(brief.references[3].journal, { name: "A&A", volume: "594", page: "A13" });
  assert.equal(brief.references[3].doi, "10.5555/fict.9");
  assert.equal(brief.references[4].arxivId, "1605.04321");
  const refsFor = (needle) => brief.citationContexts.filter((context) => context.text.includes(needle)).map((context) => context.refIndex);
  assert.deepEqual(refsFor("move sediment in pulses"), [2]);
  assert.deepEqual(refsFor("Earlier surveys"), [1, 3]);
  assert.deepEqual(refsFor("proposed a settling model"), [4]);
  assert.deepEqual(refsFor("tidal period"), [1]);
  const tons = brief.quantities.find((item) => item.unit === "kg");
  assert.equal(tons.value, 3.2);
  assert.equal(brief.quantities.find((item) => item.unit === "%").value, 40);
  assert.ok(brief.keyPoints.some((point) => point.kind === "result"));
  assertVerbatim(brief, AUTHOR_YEAR);
});

test("parseReferenceEntry extracts identifiers and journal triples", () => {
  const numeric = parseReferenceEntry("B. Novak and C. Idris, Phys. Rev. Lett. 119, 031301 (2017), arXiv:1703.00001v3.");
  assert.equal(numeric.firstAuthor, "Novak");
  assert.equal(numeric.year, 2017);
  assert.equal(numeric.arxivId, "1703.00001");
  assert.deepEqual(numeric.journal, { name: "Phys. Rev. Lett.", volume: "119", page: "031301" });
  const withDoi = parseReferenceEntry("Idris, C. 2019, Nature 525, 73, https://doi.org/10.9999/fict-525.(73)).");
  assert.equal(withDoi.doi, "10.9999/fict-525.(73)");
  assert.equal(withDoi.year, 2019);
  const legacy = parseReferenceEntry("Okafor, D. 2006, hep-th/0601123v2");
  assert.equal(legacy.arxivId, "hep-th/0601123");
  assert.equal(legacy.year, 2006);
  assert.equal(parseReferenceEntry("Reyes 1999, private communication").journal, null);
});

test("quality flags and deterministic output", () => {
  const sparse = buildPaperBrief({ paperId: "blank", fulltext: "<!-- page: 1 -->\n\n[No extractable text on this page.]\n\n<!-- page: 2 -->\n\nShort.\n" });
  assert.equal(sparse.quality, "needs_ocr");
  assert.deepEqual(sparse.keyPoints, []);
  const paper = syntheticPaper(3, { pages: 8 });
  assert.deepEqual(briefFor(paper), briefFor(paper));
  assert.equal(briefFor(paper).quality, "good");
});

// ---------------------------------------------------------------------------
// Library analysis.

function smallLibrary(count = 16, options = {}) {
  const papers = Array.from({ length: count }, (_, index) => syntheticPaper(index, { pages: 5, topicCount: 2, ...options }));
  const briefs = papers.map((paper) => briefFor(paper));
  return { papers, briefs };
}

test("library analysis resolves exact and probable citation edges without ambiguity", () => {
  const { papers, briefs } = smallLibrary(16);
  const library = buildLibraryAnalysis(briefs);
  assert.equal(library.schemaVersion, "liteverse-tier0-library-v1");
  const edge = (source, target) => library.citationEdges.find((item) => item.source === papers[source].paperId && item.target === papers[target].paperId);
  // Paper 6 cites 4 (style 1: DOI), 2 (style 2: author-year + journal), 0 (style 0: arXiv).
  assert.equal(edge(6, 0).match, "exact");
  assert.equal(edge(6, 0).via, "arxiv");
  assert.equal(edge(6, 4).via, "doi");
  assert.equal(edge(6, 2).match, "probable");
  assert.equal(edge(6, 2).via, "journal");
  assert.ok(edge(6, 0).contexts.length === 0 || edge(6, 0).contexts.every((context) => typeof context.text === "string"));
  for (const item of library.citationEdges) {
    assert.notEqual(item.source, item.target);
    assert.equal(papers[Number(item.source.slice(6))].topic, papers[Number(item.target.slice(6))].topic);
  }
  assert.ok(library.inDegree[papers[0].paperId] >= 3);

  // Ambiguous author-year: two library papers with the same surname and year yield no edge.
  const ambiguous = [
    buildPaperBrief({ paperId: "amb-a", title: "First Fictional Note", authors: ["J. Tanaka"], year: 2015, fulltext: "<!-- page: 1 -->\n\nAbstract\nWe describe a fictional note about waves in a tank of water and sand.\n" }),
    buildPaperBrief({ paperId: "amb-b", title: "Second Fictional Note", authors: ["K. Tanaka"], year: 2015, fulltext: "<!-- page: 1 -->\n\nAbstract\nWe describe another fictional note about ripples in a channel of water and sand.\n" }),
    buildPaperBrief({ paperId: "amb-c", title: "Citing Note", authors: ["L. Otieno"], year: 2018, fulltext: "<!-- page: 1 -->\n\nAbstract\nWe cite an earlier fictional note about waves [1].\n\nReferences\n[1] J. Tanaka, Fict. Water Lett. 3, 4 (2015).\n[2] M. Other, Fict. Notes 9, 1 (2001).\n" }),
  ];
  const ambiguousLibrary = buildLibraryAnalysis(ambiguous);
  assert.equal(ambiguousLibrary.citationEdges.length, 0);
});

test("library analysis builds neighbours, TF-IDF keyphrases, clusters, and reading paths deterministically", () => {
  const { papers, briefs } = smallLibrary(16);
  const library = buildLibraryAnalysis(briefs);
  assert.deepEqual(buildLibraryAnalysis([...briefs].reverse()), library);
  for (const id of library.paperIds) {
    const neighbors = library.neighbors[id];
    assert.ok(neighbors.length <= 10);
    for (let index = 1; index < neighbors.length; index += 1) assert.ok(neighbors[index - 1].weight >= neighbors[index].weight);
    for (const neighbor of neighbors) {
      assert.ok(Math.abs(neighbor.weight - (0.45 * neighbor.coupling + 0.2 * neighbor.cocitation + 0.35 * neighbor.text)) < 1e-3);
    }
    assert.ok(library.keyphrases[id].length > 0 && library.keyphrases[id].length <= 12);
  }
  const topNeighbor = library.neighbors[papers[5].paperId][0].id;
  assert.equal(papers[Number(topNeighbor.slice(6))].topic, papers[5].topic);

  const { coarse, fine } = library.clusters;
  assert.equal(library.clusters.algorithm, "leiden-modularity-v1");
  assert.equal(coarse.count, 2);
  assert.ok(coarse.sizes.every((size) => size >= 4));
  for (const paper of papers) {
    for (const other of papers) {
      if (paper.topic === other.topic) assert.equal(coarse.assignment[paper.paperId], coarse.assignment[other.paperId]);
      else assert.notEqual(coarse.assignment[paper.paperId], coarse.assignment[other.paperId]);
    }
  }
  assert.ok(coarse.stability >= -1 && coarse.stability <= 1);
  assert.equal(coarse.clusterStability.length, coarse.count);
  assert.equal(coarse.labels.length, 2);
  assert.ok(coarse.labels.every((label) => label.split(" · ").length >= 1));
  for (let cluster = 0; cluster < coarse.count; cluster += 1) {
    assert.ok(fine.parent.filter((parent) => parent === cluster).length <= 12);
  }
  for (const id of library.paperIds) assert.equal(fine.parent[fine.assignment[id]], coarse.assignment[id]);

  // Reading path: every in-cluster cited paper appears before the citing paper.
  for (const [key, ids] of Object.entries(library.readingPaths)) {
    const position = new Map(ids.map((id, index) => [id, index]));
    assert.equal(new Set(ids).size, ids.length, key);
    for (const edge of library.citationEdges) {
      if (position.has(edge.source) && position.has(edge.target)) assert.ok(position.get(edge.target) < position.get(edge.source), `${key}: ${edge.target} before ${edge.source}`);
    }
  }
});

test("reading paths break citation cycles deterministically", () => {
  const brief = (paperId, year, target) => buildPaperBrief({
    paperId,
    title: `Cycle ${paperId}`,
    authors: [`A. ${paperId === "cyc-a" ? "Aalto" : "Borg"}`],
    year,
    fulltext: `<!-- page: 1 -->\n\nAbstract\nWe describe fictional cycle member ${paperId} with loops of wire.\n\nReferences\n[1] A. ${target}, Fict. Loops 1, 2 (${year === 2010 ? 2011 : 2010}).\n[2] Z. Filler, Fict. Wire 3, 4 (1990).\n`,
  });
  const library = buildLibraryAnalysis([brief("cyc-a", 2010, "Borg"), brief("cyc-b", 2011, "Aalto")]);
  assert.equal(library.citationEdges.length, 2);
  assert.deepEqual(library.readingPaths["coarse-0"], ["cyc-a", "cyc-b"]);
});

// ---------------------------------------------------------------------------
// Leiden.

function plantedGraph(groups, size, { inner = 1, outer = 0.05, seed = 3 } = {}) {
  const random = mulberry32(seed);
  const n = groups * size;
  const adjacency = Array.from({ length: n }, () => []);
  const strength = new Float64Array(n);
  let total = 0;
  const add = (from, to, weight) => {
    adjacency[from].push([to, weight]);
    adjacency[to].push([from, weight]);
    strength[from] += weight;
    strength[to] += weight;
    total += 2 * weight;
  };
  for (let from = 0; from < n; from += 1) {
    for (let to = from + 1; to < n; to += 1) {
      const same = Math.floor(from / size) === Math.floor(to / size);
      if (same && random() < 0.8) add(from, to, inner);
      else if (!same && random() < 0.03) add(from, to, outer);
    }
  }
  return { n, adjacency, strength, selfLoop: new Float64Array(n), total };
}

test("Leiden recovers planted communities, keeps them connected, and is seed-deterministic", () => {
  const graph = plantedGraph(4, 12);
  const truth = Array.from({ length: graph.n }, (_, node) => Math.floor(node / 12));
  const found = leiden(graph, { seed: 11 });
  assert.equal(adjustedRandIndex(truth, [...found]), 1);
  assert.deepEqual([...leiden(graph, { seed: 11 })], [...found]);
  assert.ok(modularity(graph, found) > 0.6);
  // Every community is connected.
  for (const community of new Set(found)) {
    const members = [...found.keys()].filter((node) => found[node] === community);
    const seen = new Set([members[0]]);
    const stack = [members[0]];
    while (stack.length) {
      for (const [neighbor] of graph.adjacency[stack.pop()]) {
        if (found[neighbor] === community && !seen.has(neighbor)) {
          seen.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    assert.equal(seen.size, members.length);
  }
  // Two disconnected cliques joined only by label cannot share a community.
  const split = leiden({ n: 4, adjacency: [[[1, 1]], [[0, 1]], [[3, 1]], [[2, 1]]], strength: new Float64Array([1, 1, 1, 1]), selfLoop: new Float64Array(4), total: 4 });
  assert.equal(new Set(split).size, 2);
});

test("adjustedRandIndex matches known values", () => {
  assert.equal(adjustedRandIndex([0, 0, 1, 1], [5, 5, 7, 7]), 1);
  assert.ok(Math.abs(adjustedRandIndex([0, 0, 0, 1, 1, 1], [0, 0, 1, 1, 2, 2]) - 0.24242424) < 1e-6);
});

// ---------------------------------------------------------------------------
// Partitions.

test("proposePartitions returns three fully assigned, rule-abiding options", () => {
  const { briefs } = smallLibrary(24, {});
  const library = buildLibraryAnalysis(briefs);
  const proposal = proposePartitions(library);
  assert.equal(proposal.options.length, 3);
  assert.deepEqual(proposal.options.map((option) => option.id), ["citation-structure", "content", "hybrid-broader"]);
  for (const option of proposal.options) {
    const all = option.regions.flatMap((region) => region.paperIds);
    assert.equal(all.length, library.paperIds.length);
    assert.deepEqual([...all].sort(), library.paperIds);
    assert.ok(option.regions.length >= 1 && option.regions.length <= 10);
    for (const region of option.regions) {
      assert.ok(region.paperIds.length >= 4);
      assert.ok(region.consistency >= 0 && region.consistency <= 100);
      assert.ok(region.label.length > 0);
    }
  }
  assert.equal(proposal.differences.length, 3);
  assert.equal(proposal.materiallyDistinct, proposal.differences.every((item) => item.fraction >= 0.15));
  if (!proposal.materiallyDistinct) assert.ok(proposal.notes.some((note) => /differ on only/.test(note)));

  const tiny = proposePartitions(buildLibraryAnalysis(briefs.slice(0, 3)));
  for (const option of tiny.options) assert.equal(option.regions.length, 1);
  assert.equal(tiny.materiallyDistinct, false);
  assert.ok(tiny.notes.some((note) => /single region/.test(note)));
});

// ---------------------------------------------------------------------------
// Search.

test("createSearchIndex ranks with BM25, folds Greek letters and diacritics, and returns a matched quote", () => {
  const { briefs } = smallLibrary(8);
  const greek = buildPaperBrief({
    paperId: "greek-paper",
    title: "Ultralight Fields with m22 ≈ 1 and a Fictional α Parameter",
    authors: ["Zoë Müller"],
    fulltext: "<!-- page: 1 -->\n\nAbstract\nWe find that the fictional α parameter sets the core size of the halo for m22 near unity. We present a toy estimate.\n",
  });
  const index = createSearchIndex([...briefs, greek], [{ id: "note-1", title: "User note", text: "Remember to compare sediment flux with bed roughness." }]);
  assert.equal(index.search("alpha parameter core")[0].id, "greek-paper");
  assert.equal(index.search("α parameter")[0].id, "greek-paper");
  assert.equal(index.search("m22")[0].id, "greek-paper");
  assert.equal(index.search("muller")[0].id, "greek-paper");
  const top = index.search("alpha core size")[0];
  assert.match(top.matchedQuote.text, /core size/);
  assert.ok(index.search("bed roughness note").some((result) => result.id === "note-1"));
  assert.ok(index.search("sediment flux").length > 0);
  assert.deepEqual(index.search("zzzz-no-match"), []);
  assert.equal(index.search("granular packing", { limit: 2 }).length, 2);
});

// ---------------------------------------------------------------------------
// Galaxy packets and digests.

function galaxyFixture(maxChars = 36000) {
  const { papers, briefs } = smallLibrary(8);
  const library = buildLibraryAnalysis(briefs);
  const members = papers.filter((paper) => paper.topic === 0).map((paper) => paper.paperId);
  const packet = buildGalaxyPacket({ galaxyId: "galaxy-test", galaxyTitle: "Granular test", paperIds: members, briefs, library, maxChars });
  return { papers, briefs, library, members, packet };
}

function goodDigest(packet) {
  const [first, second] = packet.papers;
  const context = packet.citationContexts.find((item) => item.source === second.paperId && item.target === first.paperId);
  return {
    schemaVersion: "liteverse-galaxy-digest-v1",
    galaxyId: packet.galaxyId,
    packetSha256: packet.packetSha256,
    papers: packet.papers.map((paper) => ({ paperId: paper.paperId, gist: `Fictional gist for ${paper.paperId}.`, gistQuoteIds: [paper.quotes[0].id] })),
    matrix: [{ paperId: first.paperId, question: { text: "How packing controls friction.", quoteIds: [first.quotes[0].id] }, system: null, method: null, assumption: null, result: null, regime: null }],
    relations: [{
      source: second.paperId,
      target: first.paperId,
      type: "extends",
      sourceQuoteIds: [context ? context.quoteId : second.quotes[0].id],
      targetQuoteIds: [first.quotes[1].id],
      note: "Fictional relation.",
    }],
    flags: [{ type: "other", paperIds: [first.paperId], note: "Fixture flag." }],
  };
}

test("buildGalaxyPacket includes quotes, citation contexts, candidate pairs, and a content hash", () => {
  const { packet, members } = galaxyFixture();
  assert.equal(packet.schemaVersion, "liteverse-galaxy-packet-v1");
  assert.deepEqual(packet.papers.map((paper) => paper.paperId), [...members].sort());
  assert.ok(packet.papers.every((paper) => paper.quotes[0].kind === "abstract"));
  assert.ok(packet.citationContexts.length > 0);
  assert.ok(packet.citationContexts.every((context) => /^q-[a-f0-9]{16}$/.test(context.quoteId) && members.includes(context.source) && members.includes(context.target)));
  assert.ok(packet.candidatePairs.length > 0);
  assert.match(packet.packetSha256, /^[a-f0-9]{64}$/);
  assert.equal(packet.truncated, false);
  assert.ok(JSON.stringify(packet).length <= 36000);
  assert.ok(packet.papers.every((paper) => paper.quotes.every((quote) => !("score" in quote))));

  const small = galaxyFixture(6000).packet;
  assert.equal(small.truncated, true);
  assert.ok(JSON.stringify(small).length <= 6000);
});

test("validateGalaxyDigest accepts quote-grounded digests and rejects precise violations", () => {
  const { packet } = galaxyFixture();
  const good = validateGalaxyDigest(packet, goodDigest(packet));
  assert.deepEqual(good.errors, []);
  assert.equal(good.ok, true);
  assert.ok(good.digest.relations.every((relation) => relation.status === "candidate"));

  const [first, second] = packet.papers;
  const cases = [
    [(digest) => { digest.packetSha256 = "0".repeat(64); }, /packetSha256: expected/],
    [(digest) => { digest.papers[0].gistQuoteIds = ["q-0000000000000000"]; }, /papers\[0\]\.gistQuoteIds\[0\]: quote q-0000000000000000 does not exist/],
    [(digest) => { digest.papers[0].gistQuoteIds = [second.quotes[0].id]; }, new RegExp(`papers\\[0\\]\\.gistQuoteIds\\[0\\]: quote ${second.quotes[0].id} belongs to ${second.paperId}, not ${first.paperId}`)],
    [(digest) => { digest.papers[0].gist = "x".repeat(401); }, /gist: 401 characters exceeds 400/],
    [(digest) => { digest.papers[0].gist = "  "; }, /gist: must be a non-empty string/],
    [(digest) => { digest.relations[0].target = digest.relations[0].source; }, /a relation must link two different papers/],
    [(digest) => { digest.relations[0].type = "agrees"; }, /relations\[0\]\.type/],
    [(digest) => { digest.relations[0].targetQuoteIds = []; }, /targetQuoteIds: must be a non-empty array/],
    [(digest) => { digest.relations[0].targetQuoteIds = [second.quotes[0].id]; }, /targetQuoteIds\[0\]: quote .* not /],
    [(digest) => { digest.relations[0].source = "paper-9999"; }, /relations\[0\]\.source: paper "paper-9999" is not in this packet/],
    [(digest) => { digest.matrix[0].method = { text: "Uses a lattice.", quoteIds: [second.quotes[0].id] }; }, /matrix\[0\]\.method\.quoteIds\[0\]/],
    [(digest) => { digest.schemaVersion = "v0"; }, /schemaVersion: expected/],
  ];
  for (const [mutate, pattern] of cases) {
    const digest = goodDigest(packet);
    mutate(digest);
    const result = validateGalaxyDigest(packet, digest);
    assert.equal(result.ok, false);
    assert.equal(result.digest, null);
    assert.ok(result.errors.some((error) => pattern.test(error)), `${pattern} not in ${result.errors.join(" | ")}`);
  }
  const tampered = structuredClone(packet);
  tampered.papers[0].quotes[0].text = "Invented text.";
  assert.ok(validateGalaxyDigest(tampered, goodDigest(packet)).errors.some((error) => /packet was modified/.test(error)));
});

// ---------------------------------------------------------------------------
// Performance guard.

test("400 synthetic 15-page papers: briefs and library analysis finish quickly", (t) => {
  const started = performance.now();
  const papers = Array.from({ length: 400 }, (_, index) => syntheticPaper(index, { pages: 15 }));
  const generated = performance.now();
  const briefs = papers.map((paper) => briefFor(paper));
  const briefed = performance.now();
  const library = buildLibraryAnalysis(briefs);
  const analysed = performance.now();
  const proposal = proposePartitions(library);
  const partitioned = performance.now();
  const index = createSearchIndex(briefs);
  index.search("phonon scattering heat pulse");
  const searched = performance.now();
  const characters = papers.reduce((sum, paper) => sum + paper.fulltext.length, 0);
  t.diagnostic(`generated ${papers.length} papers (${(characters / 1e6).toFixed(1)} M chars) in ${(generated - started).toFixed(0)} ms`);
  t.diagnostic(`briefs ${(briefed - generated).toFixed(0)} ms (${((briefed - generated) / papers.length).toFixed(1)} ms/paper)`);
  t.diagnostic(`library analysis ${(analysed - briefed).toFixed(0)} ms; ${library.citationEdges.length} citation edges; ${library.clusters.coarse.count} regions; ${library.clusters.fine.count} galaxies; stability ${library.clusters.coarse.stability}`);
  t.diagnostic(`partitions ${(partitioned - analysed).toFixed(0)} ms; search index ${(searched - partitioned).toFixed(0)} ms`);
  assert.ok(analysed - generated < 60_000);
  assert.equal(library.paperIds.length, 400);
  assert.ok(library.clusters.coarse.count >= 1 && library.clusters.coarse.count <= 10);
  assert.ok(library.clusters.coarse.sizes.every((size) => size >= 4));
  assert.equal(proposal.options.length, 3);
  for (const brief of briefs.slice(0, 20)) assertVerbatim(brief, papers[Number(brief.paperId.slice(6))].fulltext);
});

// ---------------------------------------------------------------------------
// CLI.

async function json(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function treeDigest(directory) {
  const entries = [];
  async function walk(current) {
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const item of items.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) await walk(full);
      else entries.push(`${path.relative(directory, full)}:${nodeSha(await readFile(full))}`);
    }
  }
  await walk(directory);
  return entries;
}

async function cliFixture() {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-tier0-"));
  const papers = [0, 2, 4].map((index) => syntheticPaper(index, { pages: 5, topicCount: 2 }));
  const graphPapers = [];
  const indexPapers = [];
  for (const paper of papers) {
    const pdf = Buffer.from(`%PDF-1.4\nfictional ${paper.paperId}\n%%EOF\n`);
    const sourceSha = nodeSha(pdf);
    const card = `---\npaper_id: "${paper.paperId}"\ntitle: "${paper.title}"\nauthors: ["${paper.authors[0]}"]\nsource_sha256: "${sourceSha}"\nverification_status: "card_draft"\ntags: []\n---\n\n# ${paper.title}\n\n## Main results\n\n- A fictional result. [E1]\n\n## Evidence index\n\n- E1 — PDF p. 1 — Fictional evidence.\n`;
    await mkdir(path.join(support, "Knowledge", "cards"), { recursive: true });
    await mkdir(path.join(support, "Knowledge", "fulltext"), { recursive: true });
    await mkdir(path.join(support, "Library", "PDFs"), { recursive: true });
    await writeFile(path.join(support, "Knowledge", "cards", `${paper.paperId}.md`), card);
    await writeFile(path.join(support, "Knowledge", "fulltext", `${paper.paperId}.md`), paper.fulltext);
    await writeFile(path.join(support, "Library", "PDFs", `${paper.paperId}.pdf`), pdf);
    const entry = {
      paperId: paper.paperId,
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      tags: [],
      verificationStatus: "card_draft",
      cardPath: `Knowledge/cards/${paper.paperId}.md`,
      fulltextPath: `Knowledge/fulltext/${paper.paperId}.md`,
      source: { pdfPath: `Library/PDFs/${paper.paperId}.pdf`, sha256: sourceSha },
      artifacts: { cardPath: `Knowledge/cards/${paper.paperId}.md`, fulltextPath: `Knowledge/fulltext/${paper.paperId}.md` },
    };
    indexPapers.push(entry);
    graphPapers.push({ id: paper.paperId, title: paper.title, primaryCategory: "macro", categoryIds: ["macro"], verificationStatus: "card_draft", source: entry.source });
  }
  await json(path.join(support, "Knowledge", "papers.json"), { schemaVersion: 2, papers: indexPapers });
  const graph = {
    schemaVersion: "3.0.0",
    revision: 3,
    categories: [{ id: "macro", name: "Macro" }],
    papers: graphPapers,
    relations: [],
  };
  await json(path.join(support, "Graph", "current.json"), graph);
  await json(path.join(support, "Projects", "projects.json"), { schemaVersion: 1, activeProjectId: "project-default", items: [{ projectId: "project-default", name: "Default" }] });

  // One prepared (not yet adopted) library item with a hash-pinned fulltext output.
  const prepared = syntheticPaper(6, { pages: 4, topicCount: 2 });
  const jobId = "job-tier0";
  const job = path.join(support, "Work", "LocalPipeline", jobId);
  await mkdir(job, { recursive: true });
  const fulltextBytes = Buffer.from(prepared.fulltext, "utf8");
  await writeFile(path.join(job, "fulltext.md"), fulltextBytes);
  const manifest = {
    schemaVersion: "liteverse-local-result-v1",
    jobId,
    itemId: "item-tier0",
    itemRevision: 1,
    catalogFingerprint: "absent",
    state: "ready",
    sourceSha256: "b".repeat(64),
    extractionStatus: "extracted",
    canonicalMetadata: { title: prepared.title, authors: prepared.authors, storageMode: "managed" },
    paper: { paperId: "prepared-paper" },
    outputs: [{ role: "fulltext", path: "fulltext.md", sha256: nodeSha(fulltextBytes), size: fulltextBytes.byteLength }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(job, "manifest.json"), manifestBytes);
  await json(path.join(support, "library.json"), {
    schemaVersion: 1,
    items: [
      {
        id: "item-tier0",
        displayTitle: prepared.title,
        status: "pending_codex",
        revision: 2,
        preparation: { schemaVersion: 1, state: "ready", jobId, sourceRevision: 1, resultSha256: nodeSha(manifestBytes), manifestPath: `Work/LocalPipeline/${jobId}/manifest.json` },
      },
      { id: "item-queued", status: "pending_codex", revision: 1, preparation: { schemaVersion: 1, state: "queued" } },
    ],
  });
  // Pin artifacts exactly as the rest of Liteverse does, then add a galaxy.
  await execFileAsync(process.execPath, [cli, "doctor", "--fix", "--json", "--support-dir", support]);
  await json(path.join(support, "Graph", "current.json"), {
    ...graph,
    galaxies: [{ id: "galaxy-alpha", categoryId: "macro", name: "Alpha galaxy", description: "", position: [0, 0, 0], assetId: "a", seedPaperId: papers[0].paperId }],
    papers: graphPapers.map((paper) => ({ ...paper, galaxyId: "galaxy-alpha" })),
  });
  return { support, papers, prepared };
}

test("CLI tier0 build writes only rebuildable cache files and verifies hashes", async () => {
  const { support, papers } = await cliFixture();
  try {
    const protectedRoots = ["Graph", "Knowledge", "Usage", "Projects", "Library", "Work"];
    const before = await Promise.all(protectedRoots.map((name) => treeDigest(path.join(support, name))));
    const libraryBefore = await readFile(path.join(support, "library.json"), "utf8");
    const { stdout } = await execFileAsync(process.execPath, [cli, "tier0", "build", "--json", "--support-dir", support]);
    const result = JSON.parse(stdout);
    assert.equal(result.adopted, 3);
    assert.equal(result.prepared, 1);
    assert.deepEqual(result.skipped, []);
    const after = await Promise.all(protectedRoots.map((name) => treeDigest(path.join(support, name))));
    assert.deepEqual(after, before);
    assert.equal(await readFile(path.join(support, "library.json"), "utf8"), libraryBefore);
    const briefs = (await readdir(path.join(support, "Cache", "Tier0", "briefs"))).sort();
    assert.deepEqual(briefs, [...papers.map((paper) => `${paper.paperId}.json`), "item-tier0.json"].sort());
    const brief = JSON.parse(await readFile(path.join(support, "Cache", "Tier0", "briefs", `${papers[0].paperId}.json`), "utf8"));
    assert.equal(brief.fulltextSha256, nodeSha(papers[0].fulltext));
    assert.equal(brief.origin, "adopted");
    const preparedBrief = JSON.parse(await readFile(path.join(support, "Cache", "Tier0", "briefs", "item-tier0.json"), "utf8"));
    assert.equal(preparedBrief.origin, "prepared");
    const library = JSON.parse(await readFile(path.join(support, "Cache", "Tier0", "library.json"), "utf8"));
    assert.equal(library.paperIds.length, 4);
    assert.ok(library.citationEdges.some((edge) => edge.source === "item-tier0"));

    const again = JSON.parse((await execFileAsync(process.execPath, [cli, "tier0", "build", "--json", "--support-dir", support])).stdout);
    assert.equal(again.reused, 4);

    // A tampered prepared output and a tampered adopted full text are skipped, not trusted.
    await writeFile(path.join(support, "Work", "LocalPipeline", "job-tier0", "fulltext.md"), "tampered");
    await writeFile(path.join(support, "Knowledge", "fulltext", `${papers[1].paperId}.md`), "tampered");
    const tampered = JSON.parse((await execFileAsync(process.execPath, [cli, "tier0", "build", "--json", "--support-dir", support])).stdout);
    assert.equal(tampered.briefCount, 2);
    assert.deepEqual(tampered.skipped.map((item) => item.id).sort(), [papers[1].paperId, "item-tier0"].sort());
    assert.ok(tampered.skipped.some((item) => /full-text hash mismatch/.test(item.reason)));
    assert.ok(tampered.skipped.some((item) => /fulltext output hash mismatch/.test(item.reason)));
    await assert.rejects(stat(path.join(support, "Cache", "Tier0", "briefs", "item-tier0.json")), /ENOENT/);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("CLI digest packet and apply validate and store AI digests immutably", async () => {
  const { support, papers } = await cliFixture();
  try {
    await execFileAsync(process.execPath, [cli, "tier0", "build", "--json", "--support-dir", support]);
    const { stdout } = await execFileAsync(process.execPath, [cli, "digest", "packet", "--galaxy", "galaxy-alpha", "--max-chars", "20000", "--support-dir", support]);
    const packet = JSON.parse(stdout);
    assert.equal(packet.galaxyId, "galaxy-alpha");
    assert.equal(packet.galaxyTitle, "Alpha galaxy");
    assert.deepEqual(packet.papers.map((paper) => paper.paperId), papers.map((paper) => paper.paperId).sort());
    const packetPath = path.join(support, "packet.json");
    await writeFile(packetPath, stdout);

    const graphBefore = await treeDigest(path.join(support, "Graph"));
    const digestPath = path.join(support, "digest.json");
    const bad = goodDigest(packet);
    bad.relations[0].targetQuoteIds = ["q-ffffffffffffffff"];
    await writeFile(digestPath, JSON.stringify(bad));
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "digest", "apply", "--galaxy", "galaxy-alpha", "--packet", packetPath, "--digest", digestPath, "--support-dir", support]),
      /relations\[0\]\.targetQuoteIds\[0\]: quote q-ffffffffffffffff does not exist/,
    );
    await assert.rejects(stat(path.join(support, "Knowledge", "digests")), /ENOENT/);

    await writeFile(digestPath, JSON.stringify(goodDigest(packet)));
    const applied = JSON.parse((await execFileAsync(process.execPath, [cli, "digest", "apply", "--galaxy", "galaxy-alpha", "--packet", packetPath, "--digest", digestPath, "--json", "--support-dir", support])).stdout);
    const digestFile = path.join(support, "Knowledge", "digests", "galaxy-alpha", `${applied.digestSha256}.json`);
    const stored = await readFile(digestFile, "utf8");
    assert.equal(nodeSha(stored), applied.digestSha256);
    const record = JSON.parse(stored);
    assert.ok(record.relations.every((relation) => relation.status === "candidate"));
    const pointer = JSON.parse(await readFile(path.join(support, "Knowledge", "digests", "galaxy-alpha", "current.json"), "utf8"));
    assert.equal(pointer.digestSha256, applied.digestSha256);
    assert.equal(pointer.packetSha256, packet.packetSha256);
    assert.match(pointer.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(await treeDigest(path.join(support, "Graph")), graphBefore);
    await assert.rejects(stat(path.join(support, "Usage")), /ENOENT/);

    await assert.rejects(
      execFileAsync(process.execPath, [cli, "digest", "apply", "--galaxy", "galaxy-other", "--packet", packetPath, "--digest", digestPath, "--support-dir", support]),
      /packet galaxyId galaxy-alpha does not match --galaxy galaxy-other/,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "digest", "packet", "--galaxy", "galaxy-missing", "--support-dir", support]),
      /galaxy galaxy-missing is not in Graph\/current.json/,
    );
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});
