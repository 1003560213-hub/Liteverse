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
});

test("research memory rejects blank input without trimming meaningful whitespace", async () => {
  const runtime = await loadTypesModule();
  const rawText = "\n  First paragraph\n\tindented detail\n\n";

  assert.equal(runtime.researchTextForSave(rawText), rawText);
  assert.equal(runtime.researchTextForSave(" \n\t  "), undefined);
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
  assert.match(nativeBridge, /NSString \*markdown = text;/);
  assert.doesNotMatch(nativeBridge, /NSString \*text = \[rawText stringByTrimmingCharactersInSet:/);
});
