import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const curator = path.join(root, "skills", "liteverse-curator", "scripts");

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function blankPdf(filePath) {
  await execFileAsync("python3", [
    "-c",
    "from pypdf import PdfWriter; import sys; w=PdfWriter(); w.add_blank_page(width=72,height=72); w.write(sys.argv[1])",
    filePath,
  ]);
}

test("managed-library migration is resumable, backup-safe, and never edits current graph", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-managed-migration-"));
  const source = path.join(support, "external-source.pdf");
  const migration = path.join(curator, "migrate-managed-library.py");
  try {
    await blankPdf(source);
    const current = {
      schemaVersion: "2.0.0",
      revision: 7,
      updated: "2026-07-14T00:00:00Z",
      categories: [{ id: "macro", name: "Macro" }],
      papers: [{
        id: "legacy-paper",
        title: "Legacy Paper",
        authors: "Researcher",
        primaryCategory: "macro",
        categoryIds: ["macro"],
        pdfPath: source,
        markdownPath: "Knowledge/cards/legacy-paper.md",
        fulltextPath: "Knowledge/fulltext/legacy-paper.md",
        verified: true,
        useCount: 0,
      }],
      relations: [],
    };
    await writeJson(path.join(support, "Graph", "current.json"), current);
    await mkdir(path.join(support, "Knowledge", "cards"), { recursive: true });
    await writeFile(
      path.join(support, "Knowledge", "cards", "legacy-paper.md"),
      "---\npaper_id: legacy-paper\n---\n\n# Legacy Paper\n\n## Legacy result\n\nProvisional old note.\n",
      "utf8",
    );
    const currentBefore = await readFile(path.join(support, "Graph", "current.json"));
    const args = [migration, "--support-dir", support, "--run-id", "test-run", "--apply"];
    await execFileAsync("python3", args);
    assert.deepEqual(await readFile(path.join(support, "Graph", "current.json")), currentBefore);

    const run = path.join(support, "Migrations", "test-run");
    const manifest = JSON.parse(await readFile(path.join(run, "manifest.json"), "utf8"));
    const snapshot = JSON.parse(await readFile(path.join(run, "snapshot.json"), "utf8"));
    assert.equal(manifest.state, "completed");
    assert.equal(manifest.papers[0].verificationStatus, "needs_ocr");
    assert.equal(snapshot.schemaVersion, "3.0.0");
    assert.equal(snapshot.revision, 8);
    assert.equal(snapshot.categories[0].kind, "macro");
    assert.equal(snapshot.papers[0].verificationStatus, "needs_ocr");
    assert.equal(snapshot.papers[0].source.pdfPath, "Library/PDFs/legacy-paper.pdf");
    assert.equal(snapshot.papers[0].source.sha256.length, 64);
    assert.equal(Object.hasOwn(snapshot.papers[0], "verified"), false);
    assert.match(await readFile(path.join(support, "Knowledge", "fulltext", "legacy-paper.md"), "utf8"), /<!-- page: 1 -->/);
    const card = await readFile(path.join(support, "Knowledge", "cards", "legacy-paper.md"), "utf8");
    assert.match(card, /## Evidence index/);
    assert.match(card, /Legacy card retained for evidence review/);
    assert.match(card, /metadata_status: "provisional"/);
    assert.match(card, /primary_category: "macro"/);
    await access(path.join(run, "backups", "Knowledge", "cards", "legacy-paper.md"));

    await execFileAsync("python3", args);
    assert.deepEqual(await readFile(path.join(support, "Graph", "current.json")), currentBefore);
    await writeFile(path.join(support, "Library", "PDFs", "legacy-paper.pdf"), "not the same PDF", "utf8");
    await assert.rejects(execFileAsync("python3", args), /managed PDF hash mismatch/);
    const failedManifest = JSON.parse(await readFile(path.join(run, "manifest.json"), "utf8"));
    assert.equal(failedManifest.state, "incomplete");
    await assert.rejects(access(path.join(run, "snapshot.json")));
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("schema-v3 staging allows one provisional system region and rejects false verification", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-system-staging-"));
  const stage = path.join(curator, "stage-refresh.mjs");
  const current = { schemaVersion: "3.0.0", revision: 1, categories: [], papers: [], relations: [] };
  const paper = {
    id: "new-paper",
    title: "New Paper",
    primaryCategory: "liteverse-staging",
    categoryIds: ["liteverse-staging"],
    classificationStatus: "provisional",
    pdfPath: "Library/PDFs/new-paper.pdf",
    markdownPath: "Knowledge/cards/new-paper.md",
    fulltextPath: "Knowledge/fulltext/new-paper.md",
    source: { kind: "pdf", pdfPath: "Library/PDFs/new-paper.pdf", sha256: "a".repeat(64) },
    artifacts: {
      cardPath: "Knowledge/cards/new-paper.md",
      fulltextPath: "Knowledge/fulltext/new-paper.md",
      extractionStatus: "extracted",
      cardSchemaVersion: "liteverse-card-v1",
      evidenceCount: 0,
    },
    verificationStatus: "card_draft",
    metadataStatus: "provisional",
    useCount: 0,
    position: [0, 0, 0],
  };
  try {
    await writeJson(path.join(support, "Graph", "current.json"), current);
    const snapshotPath = path.join(support, "next.json");
    await writeJson(snapshotPath, {
      ...current,
      revision: 2,
      categories: [{ id: "liteverse-staging", kind: "system", name: "Staging" }],
      papers: [paper],
    });
    await execFileAsync(process.execPath, [stage, "--support-dir", support, "--snapshot", snapshotPath, "--refresh-id", "system-staging"]);
    const manifest = JSON.parse(await readFile(path.join(support, "Graph", "staged", "system-staging", "manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.graphSchemaVersion, "3.0.0");

    await rm(path.join(support, "Graph", "pending-update.json"));
    await writeJson(snapshotPath, {
      ...current,
      revision: 2,
      categories: [{ id: "liteverse-staging", kind: "system", name: "Staging" }],
      papers: [{
        ...paper,
        verificationStatus: "evidence_verified",
        artifacts: { ...paper.artifacts, evidenceCount: 0 },
      }],
    });
    await assert.rejects(
      execFileAsync(process.execPath, [stage, "--support-dir", support, "--snapshot", snapshotPath, "--refresh-id", "false-verification"]),
      /cannot be evidence_verified/,
    );
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});
