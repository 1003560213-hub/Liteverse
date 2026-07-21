import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");

async function loadTypesModule() {
  const source = await readFile(path.join(root, "app", "universe", "types.ts"), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  }).outputText;
  const sandboxModule = { exports: {} };
  Function("exports", "module", javascript)(sandboxModule.exports, sandboxModule);
  return sandboxModule.exports;
}

async function loadNebulaVisualHelpers() {
  const source = await readFile(
    path.join(root, "app", "universe", "LiteratureUniverse.tsx"),
    "utf8",
  );
  const sourceFile = ts.createSourceFile(
    "LiteratureUniverse.tsx",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const dependencies = new Set([
    "ALL_NEBULA_MAX_RADIUS_RATIO",
    "ALL_NEBULA_MAX_RADIUS_PX",
    "ALL_NEBULA_MIN_RADIUS_PX",
    "NEBULA_VISUAL_BOUND_SCALE",
  ]);
  const helperNames = new Set([
    "stableHash",
    "constrainAllNebulaRadii",
    "containPointInNebulaEllipse",
    "selectAmbientPaperIds",
  ]);
  const relevantSource = sourceFile.statements
    .filter((statement) => {
      if (
        ts.isFunctionDeclaration(statement)
        && statement.name
        && helperNames.has(statement.name.text)
      ) return true;
      return ts.isVariableStatement(statement) && statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && dependencies.has(declaration.name.text),
      );
    })
    .map((statement) => statement.getText(sourceFile))
    .join("\n");
  const javascript = ts.transpileModule(relevantSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  }).outputText;
  const sandboxModule = { exports: {} };
  Function("exports", "module", javascript)(sandboxModule.exports, sandboxModule);
  return sandboxModule.exports;
}

test("runtime relation states respect Curator decisions and structured refresh diffs", async () => {
  const runtime = await loadTypesModule();
  assert.equal(runtime.relationDisplayState({
    strength: 100,
    confidence: 100,
    formalEligible: false,
    status: "suggestion",
  }), "suggestion");
  assert.equal(runtime.relationDisplayState({
    strength: 72,
    confidence: 68,
    formalEligible: true,
    status: "candidate",
  }), "candidate");
  assert.equal(runtime.relationDisplayState({ strength: null, confidence: null }), "unscored");

  const snapshot = {
    schemaVersion: "2.0.0",
    revision: 2,
    updated: "2026-07-13",
    visuals: { nebulaAssignmentSeed: "seed", nebulaAssets: [] },
    categories: [],
    papers: [],
    relations: [],
  };
  const pending = runtime.normalizePendingRefresh({
    refreshId: "refresh-2",
    baseRevision: 1,
    targetRevision: 2,
    snapshotSha256: "a".repeat(64),
    addedPaperIds: ["paper-new"],
    addedRelationIds: ["relation-new"],
    diff: { papers: { changed: ["paper-old"] } },
    manifest: {
      refreshId: "refresh-2",
      baseRevision: 1,
      targetRevision: 2,
      snapshotSha256: "a".repeat(64),
      papers: { added: ["paper-new"], changed: ["paper-old"] },
      relations: { added: ["relation-new"], changed: ["relation-old"] },
    },
    snapshot,
  });
  assert.deepEqual(pending.newPaperIds, ["paper-new"]);
  assert.deepEqual(pending.changedPaperIds, ["paper-old"]);
  assert.deepEqual(pending.newRelationIds, ["relation-new"]);
  assert.deepEqual(pending.changedRelationIds, ["relation-old"]);
});

test("paper verification badges require a complete source and evidence closure", async () => {
  const runtime = await loadTypesModule();
  const basePaper = {
    id: "paper-1",
    citekey: "Paper2026",
    title: "Test",
    shortTitle: "Test",
    authors: "A. Author",
    year: 2026,
    primaryCategory: "region",
    categoryIds: ["region"],
    position: [0, 0, 0],
    summary: "Summary",
    projectRole: "Role",
    pdfPath: "/legacy/paper.pdf",
    markdownPath: "/legacy/card.md",
    tags: [],
  };

  assert.equal(runtime.paperVerificationState({ ...basePaper, verified: true }).tone, "draft");
  assert.equal(runtime.paperVerificationState({
    ...basePaper,
    verificationStatus: "evidence_verified",
    source: { kind: "pdf", pdfPath: "Library/PDFs/paper-1.pdf" },
    artifacts: { cardPath: "Knowledge/cards/paper-1.md", fulltextPath: "Knowledge/fulltext/paper-1.md", evidenceCount: 4 },
  }).tone, "draft");
  assert.deepEqual(runtime.paperVerificationState({
    ...basePaper,
    verificationStatus: "evidence_verified",
    source: { kind: "pdf", pdfPath: "Library/PDFs/paper-1.pdf", sha256: "a".repeat(64) },
    artifacts: { cardPath: "Knowledge/cards/paper-1.md", fulltextPath: "Knowledge/fulltext/paper-1.md", evidenceCount: 4 },
  }), {
    status: "evidence_verified",
    tone: "verified",
    label: "Evidence verified",
    detail: "4 source evidence items",
  });
  assert.deepEqual(runtime.paperVerificationState({
    ...basePaper,
    verificationStatus: "evidence_verified",
    source: { kind: "pdf", pdfPath: "Library/PDFs/paper-1.pdf", sha256: "a".repeat(64) },
    artifacts: { cardPath: "Knowledge/cards/paper-1.md", fulltextPath: "Knowledge/fulltext/paper-1.md", evidenceCount: 4 },
  }, "source_hash_mismatch"), {
    status: "needs_attention",
    tone: "attention",
    label: "Source hash mismatch",
    detail: "The managed PDF SHA-256 does not match the graph record",
  });
  assert.deepEqual(runtime.paperVerificationState({
    ...basePaper,
    verificationStatus: "evidence_verified",
    source: {
      kind: "pdf",
      storageMode: "linked",
      pdfPath: "/Volumes/LiteverseTestLiterature/paper-1.pdf",
      linkedRootPath: "/Volumes/LiteverseTestLiterature",
      relativePath: "paper-1.pdf",
      sha256: "a".repeat(64),
    },
    artifacts: { cardPath: "Knowledge/cards/paper-1.md", fulltextPath: "Knowledge/fulltext/paper-1.md", evidenceCount: 4 },
  }, "source_missing"), {
    status: "needs_attention",
    tone: "attention",
    label: "Source missing",
    detail: "The linked PDF source is unavailable",
  });
});

test("research memory rejects blank input without trimming meaningful whitespace", async () => {
  const runtime = await loadTypesModule();
  const rawText = "\n  First paragraph\n\tindented detail\n\n";

  assert.equal(runtime.researchTextForSave(rawText), rawText);
  assert.equal(runtime.researchTextForSave(" \n\t  "), undefined);
});

test("all-universe nebula artwork is restrained and pairwise non-overlapping", async () => {
  const { constrainAllNebulaRadii } = await loadNebulaVisualHelpers();
  const frames = [
    { id: "near", center: { x: 100, y: 220 }, radius: 420, depth: -1 },
    { id: "middle", center: { x: 290, y: 220 }, radius: 360, depth: 0 },
    { id: "far", center: { x: 480, y: 220 }, radius: 390, depth: 1 },
    { id: "lower", center: { x: 290, y: 410 }, radius: 380, depth: 2 },
  ];
  const viewportWidth = 1_100;
  const viewportHeight = 700;
  const constrained = constrainAllNebulaRadii(frames, viewportWidth, viewportHeight);
  const maximumRadius = Math.min(154, viewportHeight * 0.155);
  const visualGap = Math.min(18, Math.max(10, viewportHeight * 0.016));

  assert.deepEqual(
    constrained.map(({ id, center, depth }) => ({ id, center, depth })),
    frames.map(({ id, center, depth }) => ({ id, center, depth })),
    "screen-space constraints must not disturb world identity, position, or depth",
  );
  assert.ok(constrained.every((frame) => frame.radius <= maximumRadius));
  for (let leftIndex = 0; leftIndex < constrained.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < constrained.length; rightIndex += 1) {
      const left = constrained[leftIndex];
      const right = constrained[rightIndex];
      const distance = Math.hypot(
        right.center.x - left.center.x,
        right.center.y - left.center.y,
      );
      assert.ok(
        (left.radius + right.radius) * 1.08 + visualGap <= distance + 1e-9,
        `${left.id} and ${right.id} should keep a visible screen-space gap`,
      );
    }
  }
});

test("3D camera crossings keep nebulae usable instead of collapsing them", async () => {
  const { constrainAllNebulaRadii } = await loadNebulaVisualHelpers();
  const constrained = constrainAllNebulaRadii([
    { id: "front", center: { x: 320, y: 240 }, radius: 260 },
    { id: "behind", center: { x: 321, y: 240 }, radius: 240 },
  ], 240, 180);

  assert.deepEqual(constrained.map((frame) => frame.radius), [52, 52]);
});

test("ambient selection is deterministic, bounded, and represents every galaxy", async () => {
  const { selectAmbientPaperIds } = await loadNebulaVisualHelpers();
  const galaxies = Array.from({ length: 12 }, (_, galaxyIndex) => ({
    id: `galaxy-${String(galaxyIndex).padStart(2, "0")}`,
    paperIds: Array.from(
      { length: 84 },
      (_, paperIndex) => `paper-${galaxyIndex}-${String(paperIndex).padStart(3, "0")}`,
    ),
  }));
  const allView = selectAmbientPaperIds(galaxies, 12);
  const focused = selectAmbientPaperIds(galaxies, 48);

  assert.deepEqual(selectAmbientPaperIds(galaxies, 12), allView);
  assert.equal(allView.length, 12);
  assert.equal(focused.length, 48);
  for (let galaxyIndex = 0; galaxyIndex < galaxies.length; galaxyIndex += 1) {
    assert.ok(
      allView.some((paperId) => paperId.startsWith(`paper-${galaxyIndex}-`)),
      `galaxy-${galaxyIndex} should retain one representative flash`,
    );
  }
});

test("compressed previews stay inside their displayed nebula ellipse", async () => {
  const { containPointInNebulaEllipse } = await loadNebulaVisualHelpers();
  const frame = {
    center: { x: 400, y: 300 },
    rawRadius: 420,
    radius: 96,
  };
  const point = containPointInNebulaEllipse(
    { x: 920, y: -120, depth: 2, perspective: 0.92 },
    frame,
    0.76,
    0.48,
  );
  const normalizedDistance = Math.hypot(
    (point.x - frame.center.x) / (frame.radius * 0.76),
    (point.y - frame.center.y) / (frame.radius * 0.48),
  );

  assert.ok(normalizedDistance <= 1 + 1e-12);
  assert.equal(point.depth, 2);
  assert.equal(point.perspective, 0.92);
});

test("paper-star flashes stay visual-only until a galaxy is selected", async () => {
  const component = await readFile(
    path.join(root, "app", "universe", "LiteratureUniverse.tsx"),
    "utf8",
  );
  const start = component.indexOf("const showAmbientPaperFlashes =");
  const end = component.indexOf("projectedGalaxiesRef.current", start);
  assert.ok(start >= 0 && end > start);
  const ambientSection = component.slice(start, end);

  assert.match(ambientSection, /!activeGalaxyId && !activeNotesCategoryId/);
  assert.match(ambientSection, /paperFlashProfiles\.get\(paper\.id\)/);
  assert.match(ambientSection, /Math\.pow\([\s\S]*Math\.sin/);
  assert.match(ambientSection, /reducedMotion\s*\?\s*0\.58/);
  assert.match(ambientSection, /context\.drawImage\([\s\S]*starSprites\.get/);
  assert.doesNotMatch(ambientSection, /projectedStars(?:Ref)?/);
});

test("local context previews are request-scoped, non-adopting, and cache-opaque", async () => {
  const [component, settings] = await Promise.all([
    readFile(path.join(root, "app", "universe", "LiteratureUniverse.tsx"), "utf8"),
    readFile(path.join(root, "app", "universe", "SettingsDrawer.tsx"), "utf8"),
  ]);
  const buildStart = component.indexOf("const buildContextPreview =");
  const buildEnd = component.indexOf("const queueContextRequest =", buildStart);
  assert.ok(buildStart >= 0 && buildEnd > buildStart);
  const buildSource = component.slice(buildStart, buildEnd);

  assert.match(buildSource, /action: "buildContextPreview"/);
  assert.match(buildSource, /requestId/);
  assert.match(buildSource, /projectId: workspace\.projects\.activeProjectId/);
  assert.match(buildSource, /budgetChars/);
  assert.doesNotMatch(buildSource, /recordUsage|saveUsage|paperAdopted/);
  assert.match(component, /payload\.requestId !== contextPreviewRequestRef\.current/);
  assert.match(component, /const contextPreview = normalizeContextPreview\(input\?\.contextPreview\)/);
  assert.match(component, /contextPreview: contextPreview\?\.projectId === activeProjectId \? contextPreview : null/);
  assert.match(component, /delete hostWindow\.__liteverseReceiveContextPreview/);
  assert.match(component, /delete hostWindow\.__liteverseReceiveContextPreviewError/);
  assert.match(settings, /selectedContextIsLocal/);
  assert.match(settings, /!selectedContextIsLocal && \(selectedContext\.markdownPath \|\| selectedContext\.jsonPath\)/);
  assert.doesNotMatch(settings, /onOpenWorkspacePath\(selectedContext\.cachePath/);
});

test("source contains crash-safe annotation and native graph guards", async () => {
  const [component, nativeBridge] = await Promise.all([
    readFile(path.join(root, "app", "universe", "LiteratureUniverse.tsx"), "utf8"),
    readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8"),
  ]);
  assert.match(component, /function dateLabel\(/);
  assert.match(component, /function graphUpdatedTimestamp\(/);
  assert.match(component, /delete hostWindow\.__liteverseReceiveWorkspaceHealth/);
  assert.match(component, /delete hostWindow\.__liteverseWorkspaceExported/);
  assert.match(component, /delete hostWindow\.__liteverseWorkspaceImported/);
  assert.match(component, /relationEvidenceText\(relation\)/);
  assert.match(component, /pendingAnnotationSaveRef/);
  assert.match(component, /nativeError\.action === "saveAnnotation"/);
  assert.match(component, /setHasAuthoritativeGraph\(true\)/);
  assert.match(component, /!bridge \|\| !hasAuthoritativeGraph/);
  assert.match(component, /normalized\.targetRevision === currentRevision/);
  assert.match(component, /action: "observePendingRefresh"/);
  assert.match(component, /action: "loadWorkspaceHealth"/);
  assert.match(component, /externalStatePollCount % 4 === 0/);
  assert.match(component, /paperIntegrityIssue\(selectedPaper\.id, workspace\.health\)/);
  assert.match(component, /researchTextForSave\(researchDraft\)/);
  assert.doesNotMatch(component, /const text = researchDraft\.trim\(\)/);

  assert.match(nativeBridge, /Library item %@ changed revision/);
  assert.match(nativeBridge, /isAlreadyOrganized/);
  assert.match(nativeBridge, /Knowledge\/cards\//);
  assert.match(nativeBridge, /DISPATCH_VNODE_RENAME \| DISPATCH_VNODE_DELETE/);
  assert.match(nativeBridge, /applicationWillTerminate/);
  assert.match(nativeBridge, /NSString \*trimmedText = \[rawText stringByTrimmingCharactersInSet:/);
  assert.match(nativeBridge, /NSString \*text = rawText;/);
  assert.match(nativeBridge, /\[text writeToURL:markdownURL atomically:YES/);
  assert.match(nativeBridge, /append-only project memory ledger/);
  assert.doesNotMatch(nativeBridge, /NSString \*text = \[rawText stringByTrimmingCharactersInSet:/);
});
