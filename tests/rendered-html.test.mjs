import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Script } from "node:vm";

const execFileAsync = promisify(execFile);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the universe-first Liteverse shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Liteverse<\/title>/i);
  assert.match(html, /Liteverse/);
  assert.match(html, /liteverse-brand\.png/);
  assert.match(html, /liteverse-nebula\.png/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/);
});

test("keeps papers and curved relation beams independently clickable", async () => {
  const component = await readFile(
    new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, /projectedStarsRef/);
  assert.match(component, /projectedRelationsRef/);
  assert.match(component, /distanceToSegment/);
  assert.match(component, /target\?\.kind === "paper"/);
  assert.match(component, /target\?\.kind === "relation"/);
  assert.match(component, /setSelectedRelationKey\(target\.key\)/);
});

test("exposes honest evidence states, global search, relation layers, and empty onboarding", async () => {
  const [component, settings, types, styles] = await Promise.all([
    readFile(new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/universe/SettingsDrawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/universe/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /useState<SearchScope>\("global"\)/);
  assert.match(component, /selectSearchResult/);
  assert.match(component, /action: "searchLiterature"/);
  assert.match(component, /__liteverseReceiveLiteratureSearch/);
  assert.match(component, /__liteverseReceiveLiteratureSearchError/);
  assert.match(component, /10_000/);
  assert.match(component, /relationship-layers/);
  assert.match(component, /Unscored faint lines/);
  assert.match(component, /empty-universe-onboarding/);
  assert.match(component, /paperVerificationState\([\s\S]*selectedPaper[\s\S]*paperIntegrityIssue\(selectedPaper\.id, workspace\.health\)/);
  assert.doesNotMatch(component, /● Verified item/);
  assert.match(settings, /library-health/);
  assert.match(settings, /Search title, ID, or arXiv/);
  assert.match(settings, /LOCAL FTS5 \/ BM25 SEARCH/);
  assert.match(settings, /Search local literature/);
  assert.match(settings, /Awaiting refresh/);
  assert.match(types, /status === "evidence_verified"/);
  assert.match(styles, /\.relation-layer\.unscored > i/);
});

test("focuses clickable nebula regions and labels their primary papers", async () => {
  const [component, universeText] = await Promise.all([
    readFile(new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url), "utf8"),
    readFile(new URL("../data/universe.json", import.meta.url), "utf8"),
  ]);
  const universe = JSON.parse(universeText);

  assert.match(component, /projectedRegionsRef/);
  assert.match(component, /kind: "category"/);
  assert.match(component, /focusCategory\(target\.id\)/);
  assert.match(component, /cameraCenterRef/);
  assert.match(component, /cameraTransitionRef/);
  assert.match(component, /CAMERA_TRANSITION_MS/);
  assert.match(component, /REGION_FOCUS_ZOOM/);
  assert.match(
    component,
    /categoryFilter !== "all" && paper\.primaryCategory === categoryFilter/,
  );
  assert.match(component, /regionLabelCandidates/);
  assert.match(component, /verticalOffsets/);
  assert.match(component, /occupied\.some\(\(existing\) => overlaps/);
  assert.match(component, /label\.paper\.shortTitle/);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /Exit region/);

  const starPriority = component.indexOf("if (nearestStar)");
  const relationPriority = component.indexOf("if (nearestRelation)");
  const regionPriority = component.indexOf("let nearestRegion");
  assert.ok(starPriority >= 0 && starPriority < relationPriority);
  assert.ok(relationPriority < regionPriority);

  for (const category of universe.categories) {
    assert.ok(
      universe.papers.some((paper) => paper.primaryCategory === category.id),
      `${category.id} should contain at least one primary paper`,
    );
  }
});

test("uses cinematic particle rendering without visible corner instructions", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /dynamicStars/);
  assert.match(component, /categoryParticles/);
  assert.match(component, /nebulaTextures/);
  assert.match(component, /suppliedStarSprite/);
  assert.match(component, /liteverse-star-source\.png/);
  assert.match(component, /liteverse-nebula\.png/);
  assert.match(component, /photonCount/);
  assert.match(component, /4_500_000/);
  assert.doesNotMatch(component, /rotationRef\.current\.y \+= 0\.000095/);
  assert.doesNotMatch(component, /motionTime \* 0\.000004/);
  assert.doesNotMatch(component, /motionTime \* 0\.000006/);
  assert.match(component, /camera remains fixed unless the user explicitly drags/i);
  assert.doesNotMatch(component, /className="universe-instruction"/);
  assert.doesNotMatch(component, /className="liteverse-footer"/);
  assert.match(styles, /Cinematic 4K interface pass/);
  assert.match(styles, /font-size: 14px/);
  assert.match(
    styles,
    /\.nebula-backdrop\s*\{[^}]*filter: brightness\(0\.47\)[^}]*\}/s,
  );
  assert.doesNotMatch(
    styles,
    /\.nebula-backdrop\s*\{[^}]*filter:[^;}]*blur\(/s,
  );
});

test("uses persistent unused-first nebula assignments and packaged region art", async () => {
  const [component, nativeBridge, universeText] = await Promise.all([
    readFile(new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url), "utf8"),
    readFile(new URL("../macos/LiteverseApp.m", import.meta.url), "utf8"),
    readFile(new URL("../data/universe.json", import.meta.url), "utf8"),
  ]);
  const universe = JSON.parse(universeText);
  const orderedCategories = [...universe.categories].sort(
    (left, right) => left.nebulaAssignmentOrder - right.nebulaAssignmentOrder,
  );
  const uniquePrefixLength = Math.min(
    universe.visuals.nebulaAssets.filter((asset) => asset.enabled).length,
    orderedCategories.length,
  );
  assert.equal(
    new Set(
      orderedCategories
        .slice(0, uniquePrefixLength)
        .map((category) => category.nebulaAssetId),
    ).size,
    uniquePrefixLength,
  );
  await Promise.all(
    universe.visuals.nebulaAssets.map((asset) =>
      access(new URL(`../public/${asset.src.replace(/^\.\//, "")}`, import.meta.url)),
    ),
  );
  assert.match(component, /resolveRegionNebulaAssignments/);
  assert.match(component, /regionNebulaSprites/);
  assert.match(component, /createRegionNebulaSprite/);
  assert.match(component, /worldScale.*zoomRef\.current/);
  assert.match(component, /destination-in/);
  assert.match(component, /cameraDeltaX.*DEFAULT_ROTATION\.y/);
  assert.match(nativeBridge, /NSMidX\(visibleFrame\)/);
  assert.doesNotMatch(nativeBridge, /\[self\.window center\]/);
});

test("provides a persistent settings workspace and synchronized zoom control", async () => {
  const [component, settings, zoom, styles, nativeBridge, agentInstructions] = await Promise.all([
    readFile(new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/universe/SettingsDrawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/universe/ZoomControl.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../macos/LiteverseApp.m", import.meta.url), "utf8"),
    readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
  ]);
  assert.match(component, /loadWorkspace/);
  assert.match(component, /pickLiteraturePDF/);
  assert.match(component, /saveArxiv/);
  assert.match(component, /saveResearchInformation/);
  assert.match(component, /researchTextForSave\(researchDraft\)/);
  assert.doesNotMatch(component, /const text = researchDraft\.trim\(\)/);
  assert.match(component, /catalogLibraryItems/);
  assert.match(component, /settingsWorkspace/);
  assert.match(component, /action: "syncCatalog"/);
  assert.match(component, /editableResearchText/);
  assert.match(component, /action: "setActiveProject"/);
  assert.match(component, /action: "createProject"/);
  assert.match(component, /action: "saveContextRequest"/);
  assert.match(component, /action: "loadKnowledgeCard"/);
  assert.match(component, /heatScope === "project"/);
  assert.match(component, /setZoomLevel/);
  assert.match(settings, /LITERATURE UPLOAD/);
  assert.match(settings, /RESEARCH INFORMATION/);
  assert.match(settings, /AI CONTEXT CENTER/);
  assert.match(settings, /STRUCTURED MEMORY/);
  assert.match(settings, /CODE &amp; EXPERIMENT ARTIFACTS/);
  assert.match(settings, /artifact\.contentHash/);
  assert.match(settings, /artifact\.configHash/);
  assert.match(settings, /artifact\.dataHash/);
  assert.match(settings, /artifact\.resultSummary/);
  assert.match(settings, /TASK TIMELINE/);
  assert.match(settings, /catalogSource === "universe" \? "STAR" : "LIT"/);
  assert.match(settings, /upload-source-switch/);
  assert.match(settings, /uploadSource === "pdf" \?/);
  assert.match(settings, /Save research memory/);
  assert.match(settings, /No length limit/);
  assert.match(settings, /aria-describedby="research-editor-status"/);
  assert.doesNotMatch(settings, /maxLength/);
  assert.match(settings, /Awaiting Codex/);
  assert.match(zoom, /type="range"/);
  assert.match(zoom, /min="0\.68"/);
  assert.match(zoom, /max="1\.9"/);
  assert.match(styles, /\.settings-drawer/);
  assert.match(styles, /\.zoom-control/);
  assert.match(styles, /\.nebula-backdrop/);
  assert.match(nativeBridge, /NSOpenPanel/);
  assert.match(nativeBridge, /allowedContentTypes = @\[ UTTypePDF \]/);
  assert.match(nativeBridge, /library\.json/);
  assert.match(nativeBridge, /research-information\.json/);
  assert.match(nativeBridge, /syncCatalogItems/);
  assert.match(nativeBridge, /research-history/);
  assert.match(nativeBridge, /research_memory_updated_directly/);
  assert.match(nativeBridge, /Projects\/projects\.json/);
  assert.match(nativeBridge, /context-packs/);
  assert.match(nativeBridge, /Knowledge\/claims/);
  assert.match(nativeBridge, /projectUseCounts/);
  assert.match(nativeBridge, /NSString \*text = rawText;/);
  assert.match(nativeBridge, /NSString \*markdown = text;/);
  assert.match(nativeBridge, /configureApplicationMenus/);
  assert.match(nativeBridge, /@selector\(cut:\)/);
  assert.match(nativeBridge, /@selector\(copy:\)/);
  assert.match(nativeBridge, /@selector\(paste:\)/);
  assert.match(nativeBridge, /@selector\(selectAll:\)/);
  assert.match(nativeBridge, /workspace-inbox\.jsonl/);
  assert.match(nativeBridge, /Library\/PDFs/);
  assert.match(nativeBridge, /URLForWorkspaceRelativePath:localPath/);
  assert.doesNotMatch(nativeBridge, /fileURLWithPath:\[localPath stringByStandardizingPath\]/);
  assert.match(nativeBridge, /message\.frameInfo\.isMainFrame/);
  assert.match(agentInstructions, /codex-workspace-queue\.mjs list/);
  assert.match(agentInstructions, /never invent a connection/);
});

test("shows three fail-closed partition proposals without applying a graph choice", async () => {
  const [component, settings, styles, nativeBridge] = await Promise.all([
    readFile(new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/universe/SettingsDrawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../macos/LiteverseApp.m", import.meta.url), "utf8"),
  ]);

  assert.match(settings, /"liteverse-partition-proposals-v1"/);
  assert.match(settings, /status: "awaiting_user"/);
  assert.match(settings, /Regions \{partitionProposal && <em>Review<\/em>\}/);
  assert.match(settings, /partitionProposal\.options\.map/);
  assert.match(settings, /option\.tradeoffs\.strengths/);
  assert.match(settings, /option\.tradeoffs\.limitations/);
  assert.match(settings, /Object\.entries\(option\.metrics\)/);
  assert.match(settings, /Copy selection for Codex/);
  assert.match(settings, /Ask Codex to regenerate three proposals/);
  assert.match(settings, /The app does not select, apply, or modify the current graph/);
  assert.match(component, /normalizePartitionProposals/);
  assert.match(component, /proposal\.options\.length !== 3/);
  assert.match(component, /option\.regions\.length <= 10/);
  assert.match(component, /has-partition-proposal/);
  assert.match(component, /Codex proposes three broad region schemes/);
  assert.match(component, /papers remain in staging and the current graph stays unchanged/);
  assert.match(styles, /\.partition-proposal-card/);
  assert.match(nativeBridge, /validatedPartitionProposalsAtURL/);
  assert.match(nativeBridge, /options\.count != 3/);
  assert.match(nativeBridge, /regions\.count > 10/);
  assert.match(nativeBridge, /sendWorkspaceErrorForAction:@"loadPartitionProposals"/);
  assert.doesNotMatch(component, /applyPartitionProposal|selectPartitionProposal/);
  assert.doesNotMatch(settings, /onApplyPartition|onSelectPartition/);
});

test("ships an empty public graph without a default taxonomy", async () => {
  const universe = JSON.parse(
    await readFile(new URL("../data/universe.json", import.meta.url), "utf8"),
  );
  assert.equal(universe.title, "Liteverse");
  assert.deepEqual(universe.categories, []);
  assert.deepEqual(universe.papers, []);
  assert.deepEqual(universe.relations, []);
});

test("keeps paper usage Retriever-managed with a zero integer default", async () => {
  const [component, universeText] = await Promise.all([
    readFile(new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url), "utf8"),
    readFile(new URL("../data/universe.json", import.meta.url), "utf8"),
  ]);
  const universe = JSON.parse(universeText);

  assert.deepEqual(universe.usagePolicy, {
    schemaVersion: 1,
    managedBy: "liteverse-retriever",
    manualUpdates: false,
    initialValue: 0,
    counter: "useCount",
    dedupeScope: "codex-task-paper",
    ledger: "Usage/events.jsonl",
    cache: "Usage/counts.json",
    visualNormalization: { type: "log1p", referenceCount: 32 },
    regionAggregation: "primary-category-mean",
  });
  assert.equal(universe.papers.length, 0);
  assert.ok(
    universe.papers.every(
      (paper) =>
        Number.isInteger(paper.useCount) && paper.useCount === 0,
    ),
  );
  assert.ok(
    universe.papers.every(
      (paper) =>
        !("temperature" in paper) &&
        !("baseHeat" in paper) &&
        !("lifetimeUses" in paper),
    ),
  );
  assert.match(component, /paper\.useCount/);
  assert.match(component, /Math\.log1p/);
  assert.match(component, /Managed by a Codex Skill · Read-only here/);
  assert.doesNotMatch(component, /recordUse/);
  assert.doesNotMatch(component, /liteverse-usage-events/);
  assert.doesNotMatch(component, /record use|quick read|formula verification|simulation decision/i);
});

test("workspace queue preserves revision safety and publishes organized state", async () => {
  const supportDirectory = await mkdtemp(path.join(tmpdir(), "liteverse-workspace-test-"));
  const script = new URL("../scripts/codex-workspace-queue.mjs", import.meta.url);
  const timestamp = new Date().toISOString();
  const library = {
    schemaVersion: 1,
    nextNumber: 2,
    items: [{
      id: "lit-test",
      number: 1,
      sourceType: "arxiv",
      displayTitle: "arXiv 2401.01234 (title pending retrieval)",
      titleStatus: "pending",
      arxivId: "2401.01234",
      arxivUrl: "https://arxiv.org/abs/2401.01234",
      status: "pending_codex",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  };
  const research = {
    schemaVersion: 1,
    status: "pending_setup",
    draft: { text: "Test research context", revision: 1, updatedAt: timestamp },
    formal: { text: "", sourceRevision: 0, organizedAt: "" },
  };
  await writeFile(path.join(supportDirectory, "library.json"), JSON.stringify(library), "utf8");
  await writeFile(path.join(supportDirectory, "research-information.json"), JSON.stringify(research), "utf8");
  const env = { ...process.env, LITEVERSE_SUPPORT_DIR: supportDirectory };
  try {
    const listed = await execFileAsync(process.execPath, [script.pathname, "list", "--json"], { env });
    const queue = JSON.parse(listed.stdout);
    assert.equal(queue.pendingLiterature.length, 1);
    assert.equal(queue.pendingResearch.draft.revision, 1);

    await assert.rejects(
      execFileAsync(process.execPath, [script.pathname, "mark-literature", "lit-test", "--revision", "2", "--disposition", "no-link"], { env }),
      /Revision mismatch/,
    );
    const begun = await execFileAsync(process.execPath, [script.pathname, "begin-literature", "lit-test", "--revision", "1"], { env });
    const lock = JSON.parse(begun.stdout);
    assert.equal(lock.revision, 2);
    await execFileAsync(process.execPath, [script.pathname, "mark-literature", "lit-test", "--revision", "2", "--disposition", "no-link", "--title", "Verified title"], { env });
    const nextLibrary = JSON.parse(await readFile(path.join(supportDirectory, "library.json"), "utf8"));
    assert.equal(nextLibrary.items[0].status, "organized");
    assert.equal(nextLibrary.items[0].revision, 3);
    assert.equal(nextLibrary.items[0].displayTitle, "Verified title");

    const formalPath = path.join(supportDirectory, "formal.md");
    await writeFile(formalPath, "# Formal research memory\n", "utf8");
    await execFileAsync(process.execPath, [script.pathname, "publish-research", "--revision", "1", "--from", formalPath], { env });
    const nextResearch = JSON.parse(await readFile(path.join(supportDirectory, "research-information.json"), "utf8"));
    assert.equal(nextResearch.status, "organized");
    assert.equal(nextResearch.formal.sourceRevision, 1);
    await access(path.join(supportDirectory, "generated", "research-memory.md"));
  } finally {
    await rm(supportDirectory, { recursive: true, force: true });
  }
});

test("legacy annotation queue is read-only and cannot bypass Curator provenance", async () => {
  const supportDirectory = await mkdtemp(path.join(tmpdir(), "liteverse-note-test-"));
  const script = new URL("../scripts/codex-note-queue.mjs", import.meta.url);
  const annotationsPath = path.join(supportDirectory, "user-annotations.json");
  const annotation = {
    id: "annotation-test",
    paperId: "paper-alpha",
    paperTitle: "Adaptive Sampling for Climate Models",
    text: "A provisional user observation.",
    status: "pending",
    revision: 2,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(annotationsPath, JSON.stringify([annotation]), "utf8");
  const env = { ...process.env, LITEVERSE_SUPPORT_DIR: supportDirectory };
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [script.pathname, "mark", annotation.id, "--revision", "1"], { env }),
      /legacy mark command is read-only/,
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [script.pathname, "mark", annotation.id, "--revision", "2"],
        { env },
      ),
      /mark-annotation\.mjs.*--refresh-id.*--derived-file/,
    );
    const next = JSON.parse(await readFile(annotationsPath, "utf8"));
    assert.equal(next[0].status, "pending");
    assert.equal(next[0].revision, 2);
    await assert.rejects(access(path.join(supportDirectory, "codex-inbox.jsonl")), /ENOENT/);
    await assert.rejects(access(path.join(supportDirectory, "user-notes", "paper-alpha.md")), /ENOENT/);
  } finally {
    await rm(supportDirectory, { recursive: true, force: true });
  }
});

test("provides editable annotations backed by the native Codex queue", async () => {
  const [component, nativeBridge, agentInstructions] = await Promise.all([
    readFile(new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url), "utf8"),
    readFile(new URL("../macos/LiteverseApp.m", import.meta.url), "utf8"),
    readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
  ]);
  assert.match(component, /Summary/);
  assert.match(component, /MANUAL NOTE/);
  assert.match(component, /saveAnnotation/);
  assert.match(component, /Edit this note/);
  assert.match(nativeBridge, /loadAnnotations/);
  assert.match(nativeBridge, /codex-inbox\.jsonl/);
  assert.match(nativeBridge, /user-notes/);
  assert.match(nativeBridge, /NSApplicationSupportDirectory/);
  assert.match(nativeBridge, /Annotation %@ changed revision/);
  assert.doesNotMatch(nativeBridge, /projectRootURL/);
  assert.match(agentInstructions, /codex-note-queue\.mjs list/);
  assert.match(agentInstructions, /Do not mark a note organized merely because it was read/);
});

test("loads and atomically commits runtime graph refreshes", async () => {
  const [component, styles, nativeBridge] = await Promise.all([
    readFile(new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../macos/LiteverseApp.m", import.meta.url), "utf8"),
  ]);
  assert.match(component, /__liteverseReceiveUniverse/);
  assert.match(component, /__liteverseReceivePendingRefresh/);
  assert.match(component, /__liteverseRefreshCommitted/);
  assert.match(component, /action: "loadUniverse"/);
  assert.match(component, /action: "observePendingRefresh"/);
  assert.match(component, /action: "loadWorkspaceHealth"/);
  assert.match(component, /externalStatePollCount % 4 === 0/);
  assert.match(component, /action: "commitRefresh"/);
  assert.match(component, /staggerMs: reducedMotion \? 0/);
  assert.match(component, /waveDurationMs/);
  assert.match(component, /refreshShakeOffsets/);
  assert.match(component, /Refresh Universe/);
  assert.match(styles, /\.refresh-universe/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);

  assert.match(nativeBridge, /Graph/);
  assert.match(nativeBridge, /current\.json/);
  assert.match(nativeBridge, /pending-update\.json/);
  assert.match(nativeBridge, /snapshotSha256/);
  assert.match(nativeBridge, /CC_SHA256/);
  assert.match(nativeBridge, /ready_to_refresh/);
  assert.match(nativeBridge, /graph_refresh_committed/);
});

test("includes a complete generated macOS app bundle when packaging has run", async (context) => {
  try {
    await access(new URL("../Liteverse.app/Contents/MacOS/Liteverse", import.meta.url));
  } catch (error) {
    if (error?.code === "ENOENT") {
      context.skip("Run npm run desktop:package before validating the generated app bundle.");
      return;
    }
    throw error;
  }
  await access(
    new URL("../Liteverse.app/Contents/Resources/web/liteverse-brand.png", import.meta.url),
  );
  await access(
    new URL("../Liteverse.app/Contents/Resources/web/liteverse-nebula.png", import.meta.url),
  );
  await access(
    new URL("../Liteverse.app/Contents/Resources/web/liteverse-star-source.png", import.meta.url),
  );
  const desktopHtml = await readFile(
    new URL("../Liteverse.app/Contents/Resources/web/index.html", import.meta.url),
    "utf8",
  );
  assert.match(desktopHtml, /<style>/);
  assert.match(desktopHtml, /<script>/);
  assert.doesNotMatch(desktopHtml, /<script type="module">/);
  assert.doesNotMatch(desktopHtml, /src="\.\/assets\//);
  const inlineScript = desktopHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript, "desktop bundle should contain an inline script");
  assert.doesNotMatch(inlineScript, /<!doctype html>/i);
  assert.doesNotThrow(
    () => new Script(inlineScript, { filename: "liteverse-inline.js" }),
    "the packaged inline script should remain valid JavaScript",
  );
  const infoPlist = await readFile(
    new URL("../Liteverse.app/Contents/Info.plist", import.meta.url),
    "utf8",
  );
  assert.match(infoPlist, /<key>CFBundleIconFile<\/key>\s*<string>Liteverse\.icns<\/string>/);
  await access(new URL("../Liteverse.app/Contents/Resources/Liteverse.icns", import.meta.url));
  const seedUniverse = JSON.parse(await readFile(
    new URL("../Liteverse.app/Contents/Resources/seed-universe.json", import.meta.url),
    "utf8",
  ));
  assert.equal(seedUniverse.papers.length, 0);
  assert.deepEqual(
    await readdir(new URL("../Liteverse.app/Contents/Resources/seed-papers/", import.meta.url)),
    [],
  );
  await access(new URL("../Liteverse.app/Contents/Resources/CodexSkills/liteverse-curator/SKILL.md", import.meta.url));
  await access(new URL("../Liteverse.app/Contents/Resources/CodexSkills/liteverse-retriever/SKILL.md", import.meta.url));
  await access(new URL("../Liteverse.app/Contents/Resources/install-codex-skills.sh", import.meta.url));
});

test("commits the native WKWebView first frame synchronously", async () => {
  const renderer = await readFile(
    new URL("../desktop/renderer.tsx", import.meta.url),
    "utf8",
  );
  assert.match(renderer, /flushSync/);
  assert.match(renderer, /applicationRoot\.render/);
});
