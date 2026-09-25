import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

// The UI models are TypeScript modules bundled by Vite in the app. Bundle the
// pure (DOM-free) ones with esbuild so their behaviour can be tested directly.
async function loadModels() {
  const directory = await mkdtemp(path.join(tmpdir(), "liteverse-ui-model-"));
  const entry = path.join(directory, "entry.ts");
  await writeFile(entry, [
    `export * from ${JSON.stringify(path.join(root, "app/universe/sky/model.ts"))};`,
    `export * from ${JSON.stringify(path.join(root, "app/universe/library-model.ts"))};`,
    `export { parsePointCloud, LVPC_HEADER_BYTES, LVPC_STRIDE } from ${JSON.stringify(path.join(root, "app/universe/sky/assets.ts"))};`,
    `export { buildGalaxyHierarchy } from ${JSON.stringify(path.join(root, "app/universe/hierarchy.ts"))};`,
  ].join("\n"));
  const outfile = path.join(directory, "models.mjs");
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile, logLevel: "silent" });
  const module = await import(pathToFileURL(outfile).href);
  await rm(directory, { recursive: true, force: true });
  return module;
}

const models = await loadModels();

function emptyGraph() {
  return JSON.parse(JSON.stringify({
    schemaVersion: "3.0.0",
    revision: 1,
    title: "Liteverse",
    updated: "2026-01-01",
    visuals: { nebulaAssignmentSeed: "test", nebulaAssets: [] },
    categories: [],
    papers: [],
    relations: [],
  }));
}

function graphWithRegion(paperCount) {
  const graph = emptyGraph();
  graph.categories = [{ id: "region-a", kind: "macro", name: "Region A", description: "", color: "#88aaff", center: [0, 0, 0] }];
  graph.papers = Array.from({ length: paperCount }, (_, index) => ({
    id: `paper-${index}`,
    citekey: `p${index}`,
    title: `Fictional paper ${index}`,
    shortTitle: `Fictional paper ${index}`,
    authors: "A. Author",
    year: 2010 + index,
    primaryCategory: "region-a",
    categoryIds: ["region-a"],
    position: [0, 0, 0],
    verificationStatus: index % 2 ? "evidence_verified" : "card_draft",
    summary: "",
    projectRole: "",
    pdfPath: "",
    markdownPath: "",
    tags: [index % 3 ? "alpha" : "beta"],
  }));
  return graph;
}

function metaFor(ids, overrides = {}) {
  return new Map(ids.map((id, index) => [id, {
    id,
    title: id,
    shortTitle: id,
    year: 2000 + index,
    tier: 1,
    heat: 0,
    centrality: overrides[id] || 0,
  }]));
}

test("reviewed and provisional regions never overlap and reviewed centres never move", () => {
  const graph = graphWithRegion(8);
  const hierarchy = models.buildGalaxyHierarchy(graph);
  const paperIds = graph.papers.map((paper) => paper.id);
  const incoming = ["item-1", "item-2", "item-3", "item-4", "item-5"];
  const input = {
    graph,
    hierarchy,
    provisional: {
      regions: [{ key: "c0", label: "Incoming cluster", paperIds: incoming }],
      galaxies: [{ key: "c0:f0", regionKey: "c0", label: "Incoming cluster", paperIds: incoming }],
    },
    paperMeta: metaFor([...paperIds, ...incoming]),
    citationEdges: [{ source: "item-1", target: "paper-0" }, { source: "item-2", target: "paper-0" }],
    relationLanes: [],
    noteCountByCategory: new Map(),
  };
  const withIncoming = models.buildSkyModel(input);
  const reviewedOnly = models.buildSkyModel({ ...input, provisional: { regions: [], galaxies: [] } });

  const reviewed = withIncoming.regionById.get("region-a");
  assert.deepEqual(reviewed.center, reviewedOnly.regionById.get("region-a").center);
  const provisional = withIncoming.regions.find((region) => region.provisional);
  assert.ok(provisional, "an automatic region is created for unreviewed papers");
  const gap = Math.hypot(...provisional.center.map((value, index) => value - reviewed.center[index]));
  assert.ok(gap > reviewed.radius + provisional.radius, "automatic regions sit outside reviewed regions");

  // Every paper is placed exactly once and inside its galaxy.
  assert.equal(withIncoming.stars.length, paperIds.length + incoming.length);
  for (const star of withIncoming.stars) {
    const galaxy = withIncoming.galaxyById.get(star.galaxyId);
    const distance = Math.hypot(...star.position.map((value, index) => value - galaxy.position[index]));
    assert.ok(distance <= galaxy.radius * 1.01, `${star.id} stays within its galaxy`);
    assert.ok(galaxy.radius <= 0.95);
  }

  // Citation flow between galaxies is aggregated into one bibliographic filament.
  const citation = withIncoming.filaments.filter((filament) => filament.kind === "citation");
  assert.equal(citation.length, 1);
  assert.equal(citation[0].weight, 2);
});

test("foundational papers sit closest to the galaxy centre", () => {
  const radius = 0.8;
  const inner = models.starOffsetInGalaxy(radius, 0, 10, 0.5, "a");
  const outer = models.starOffsetInGalaxy(radius, 9, 10, 0.5, "b");
  assert.ok(Math.hypot(inner[0], inner[2]) < Math.hypot(outer[0], outer[2]));
  assert.ok(Math.hypot(...outer) <= radius);
});

test("legacy two-dimensional asset ids map onto the ten Blender archetypes", () => {
  assert.equal(models.archetypeForAsset("01-grand-design-spiral-blue-gold.png", "x"), 0);
  assert.equal(models.archetypeForAsset("10-seyfert-spiral-violet-copper.png", "x"), 9);
  const fallback = models.archetypeForAsset(undefined, "galaxy-key");
  assert.ok(fallback >= 0 && fallback < 10);
  assert.equal(models.archetypeForAsset(undefined, "galaxy-key"), fallback, "deterministic");
});

test("incoming items exclude organized, duplicate, unprepared, and already-graphed papers", () => {
  const graph = graphWithRegion(1);
  const base = { number: 1, sourceType: "pdf", displayTitle: "t", titleStatus: "pending", revision: 2, createdAt: "", updatedAt: "" };
  const ready = { schemaVersion: 1, state: "ready", jobId: "j", sourceRevision: 1 };
  const workspace = {
    library: {
      schemaVersion: 1,
      nextNumber: 6,
      items: [
        { ...base, id: "keep", status: "pending_codex", preparation: ready },
        { ...base, id: "organized", status: "organized", preparation: ready },
        { ...base, id: "duplicate", status: "pending_codex", disposition: "duplicate", preparation: ready },
        { ...base, id: "queued", status: "pending_codex", preparation: { ...ready, state: "queued" } },
        { ...base, id: "graphed", status: "ready_to_refresh", graphPaperId: "paper-0", preparation: ready },
      ],
    },
  };
  assert.deepEqual(models.incomingItems(workspace, graph).map((item) => item.id), ["keep"]);
});

test("provisional layout assigns every unreviewed paper exactly once with at most twelve galaxies per region", () => {
  const ids = Array.from({ length: 40 }, (_, index) => `item-${index}`);
  const entries = ids.map((id) => ({ id, kind: "item", tier: 0 }));
  const library = {
    clusters: {
      coarse: { assignment: Object.fromEntries(ids.map((id, index) => [id, index % 2])), labels: ["Left", "Right"] },
      fine: { assignment: Object.fromEntries(ids.map((id, index) => [id, index % 20])), labels: [] },
    },
  };
  const layout = models.provisionalLayoutFor(entries, library, null);
  const placed = layout.galaxies.flatMap((galaxy) => galaxy.paperIds);
  assert.equal(placed.length, ids.length);
  assert.equal(new Set(placed).size, ids.length);
  for (const region of layout.regions) {
    assert.ok(layout.galaxies.filter((galaxy) => galaxy.regionKey === region.key).length <= 12);
  }
  // Unclustered papers are still shown, never dropped.
  const partial = models.provisionalLayoutFor(entries, null, null);
  assert.equal(partial.galaxies.flatMap((galaxy) => galaxy.paperIds).length, ids.length);
});

test("reading paths put cited papers before the papers that cite them, even with cycles", () => {
  const entries = new Map(["a", "b", "c", "d"].map((id, index) => [id, { id, year: 2020 - index, centrality: 0 }]));
  const order = models.readingPath(["a", "b", "c", "d"], [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "c", target: "b" },
  ], entries);
  assert.equal(new Set(order).size, 4);
  assert.ok(order.indexOf("b") < order.indexOf("a"));
});

test("evidence tiers never promote a reviewed card to verified", () => {
  assert.equal(models.tierForPaper({ verificationStatus: "evidence_verified" }), 2);
  assert.equal(models.tierForPaper({ verificationStatus: "card_draft" }), 1);
  assert.equal(models.tierForPaper({ verificationStatus: "needs_attention" }), 1);
  assert.equal(models.heatFor(0), 0);
  assert.equal(models.heatFor(32), 1);
});

test("the point-cloud loader validates the packaged Blender assets", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "public/universe/manifest.json"), "utf8"));
  for (const entry of [...manifest.galaxies, manifest.deepField]) {
    const bytes = await readFile(path.join(root, "public/universe", entry.file));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const cloud = models.parsePointCloud(entry.file, buffer);
    assert.equal(cloud.count, entry.pointCount);
    assert.ok(cloud.radius > 0);
  }
  const truncated = new ArrayBuffer(16);
  assert.throws(() => models.parsePointCloud("bad", truncated), /truncated/);
  const wrongMagic = new ArrayBuffer(models.LVPC_HEADER_BYTES);
  assert.throws(() => models.parsePointCloud("bad", wrongMagic), /not an LVPC/);
});
