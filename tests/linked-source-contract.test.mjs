import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const curator = path.join(root, "skills", "liteverse-curator", "scripts");
const finalize = path.join(curator, "finalize-curated-snapshot.py");
const generateClaims = path.join(curator, "generate-claims.mjs");
const listQueue = path.join(curator, "list-queue.mjs");
const stageRefresh = path.join(curator, "stage-refresh.mjs");
const readPaper = path.join(root, "skills", "liteverse-retriever", "scripts", "read-paper.mjs");
const cli = path.join(root, "scripts", "liteverse-cli.mjs");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture() {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "liteverse-linked-source-")));
  const support = path.join(temporary, "support");
  const linkedRootPath = path.join(temporary, "literature");
  const pdfPath = path.join(linkedRootPath, "linked-paper.pdf");
  const pdf = Buffer.from("%PDF-1.4\nLiteverse linked source fixture\n%%EOF\n");
  const sourceSha256 = sha256(pdf);
  await mkdir(linkedRootPath, { recursive: true });
  await writeFile(pdfPath, pdf);

  const card = `---
paper_id: "linked-paper"
title: "Linked Literature Source"
authors: ["A. Researcher"]
year: 2026
source_type: "pdf"
source_storage_mode: "linked"
source_pdf_path: ${JSON.stringify(pdfPath)}
source_sha256: "${sourceSha256}"
arxiv_id: null
doi: null
extraction_status: "extracted"
verification_status: "evidence_verified"
metadata_status: "source_verified"
card_schema_version: "liteverse-card-v1"
evidence_count: 1
primary_category: "macro"
secondary_category: null
classification_status: "assigned"
tags: ["linked"]
---
# Linked Literature Source

## Research question
- What does a linked source establish? [E1]

## Methods
- The paper uses a deterministic fixture method. [E1]

## Equations and conventions
- The source fixes one test convention. [E1]

## Main results
- The linked PDF remains outside the managed vault. [E1]

## Limitations
- This is a contract fixture. [E1]

## Project role
- Validate linked-source provenance without copying PDF bytes. [E1]

## Evidence index
- E1 — PDF p. 1 — The fixture contains the linked-source statement.

## Annotation provenance
- None.
`;
  const fulltext = `---
paper_id: "linked-paper"
title: "Linked Literature Source"
source_type: "pdf"
source_storage_mode: "linked"
source_pdf_path: ${JSON.stringify(pdfPath)}
source_sha256: "${sourceSha256}"
extraction_status: "extracted"
verification_status: "card_draft"
metadata_status: "source_verified"
---
# Linked Literature Source

<!-- page: 1 -->

The linked source fixture remains outside the managed vault.
`;
  await Promise.all([
    mkdir(path.join(support, "Knowledge", "cards"), { recursive: true }),
    mkdir(path.join(support, "Knowledge", "fulltext"), { recursive: true }),
    mkdir(path.join(support, "Library", "PDFs"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(support, "Knowledge", "cards", "linked-paper.md"), card),
    writeFile(path.join(support, "Knowledge", "fulltext", "linked-paper.md"), fulltext),
  ]);

  const category = {
    id: "macro",
    kind: "macro",
    name: "Macro",
    description: "Existing macro region",
    color: "#66ccff",
    center: [0, 0, 0],
  };
  const paper = {
    id: "linked-paper",
    title: "Linked Literature Source",
    authors: "A. Researcher",
    year: 2026,
    primaryCategory: "macro",
    categoryIds: ["macro"],
    position: [0.1, 0.2, 0.3],
    summary: "Linked source fixture.",
    projectRole: "Validate linked source provenance.",
    tags: ["linked"],
    classificationStatus: "assigned",
    metadataStatus: "source_verified",
    verificationStatus: "evidence_verified",
    source: {
      kind: "pdf",
      storageMode: "linked",
      pdfPath,
      linkedRootPath,
      relativePath: "linked-paper.pdf",
      sha256: sourceSha256,
    },
    pdfPath,
    markdownPath: "Knowledge/cards/linked-paper.md",
    fulltextPath: "Knowledge/fulltext/linked-paper.md",
    artifacts: {
      cardPath: "Knowledge/cards/linked-paper.md",
      fulltextPath: "Knowledge/fulltext/linked-paper.md",
      extractionStatus: "extracted",
      cardSchemaVersion: "liteverse-card-v1",
      evidenceCount: 1,
    },
    useCount: 0,
  };
  const current = {
    schemaVersion: "3.0.0",
    revision: 1,
    title: "Liteverse",
    updated: "2026-07-19T00:00:00.000Z",
    categories: [category],
    papers: [],
    relations: [],
  };
  const snapshot = {
    ...current,
    revision: 2,
    updated: "2026-07-19T01:00:00.000Z",
    papers: [paper],
  };
  const snapshotPath = path.join(support, "Planning", "linked-snapshot.json");
  await Promise.all([
    writeJson(path.join(support, "Graph", "current.json"), current),
    writeJson(snapshotPath, snapshot),
    writeJson(path.join(support, "Knowledge", "papers.json"), {
      schemaVersion: 3,
      revision: 1,
      papers: [{
        paperId: paper.id,
        title: paper.title,
        authors: ["A. Researcher"],
        tags: paper.tags,
        verificationStatus: paper.verificationStatus,
        metadataStatus: paper.metadataStatus,
        cardPath: paper.markdownPath,
        fulltextPath: paper.fulltextPath,
        pdfPath,
        sha256: sourceSha256,
        source: paper.source,
        artifacts: paper.artifacts,
      }],
    }),
    writeJson(path.join(support, "library.json"), {
      schemaVersion: 1,
      nextNumber: 2,
      items: [{
        id: "linked-item",
        number: 1,
        sourceType: "pdf",
        displayTitle: paper.title,
        status: "pending_codex",
        revision: 1,
        localPath: pdfPath,
        source: paper.source,
      }],
    }),
  ]);
  return { temporary, support, linkedRootPath, pdfPath, sourceSha256, snapshotPath };
}

test("linked PDFs finalize, pin immutable provenance, and stage without a managed copy", async () => {
  const value = await fixture();
  try {
    const queue = JSON.parse((await execFileAsync(process.execPath, [listQueue, "--json", "--support-dir", value.support])).stdout);
    assert.equal(queue.pendingLiterature[0].sourceStorageMode, "linked");
    assert.equal(queue.pendingLiterature[0].linkedPdfPath, value.pdfPath);
    assert.equal(Object.hasOwn(queue.pendingLiterature[0], "storedPdfPath"), false);

    await execFileAsync("python3", [finalize, "--support-dir", value.support, "--snapshot", value.snapshotPath]);
    await execFileAsync(process.execPath, [generateClaims, "--paper", "linked-paper", "--snapshot", value.snapshotPath, "--json", "--support-dir", value.support]);
    const snapshot = JSON.parse(await readFile(value.snapshotPath, "utf8"));
    assert.equal(snapshot.papers[0].source.storageMode, "linked");
    assert.equal(snapshot.papers[0].source.pdfPath, value.pdfPath);
    assert.equal(snapshot.papers[0].pdfPath, value.pdfPath);
    assert.equal(snapshot.papers[0].artifacts.integrity.sourceStorageMode, "linked");
    assert.equal(snapshot.papers[0].artifacts.integrity.sourcePath, value.pdfPath);
    const manifestPath = path.join(value.support, snapshot.papers[0].artifacts.integrity.manifestPath);
    const artifactManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(artifactManifest.sourceStorageMode, "linked");
    assert.equal(artifactManifest.sourcePath, value.pdfPath);
    await assert.rejects(readFile(path.join(value.support, "Library", "PDFs", "linked-paper.pdf")), /ENOENT/);

    await execFileAsync(process.execPath, [stageRefresh, "--snapshot", value.snapshotPath, "--refresh-id", "linked-source", "--support-dir", value.support]);
    const staged = JSON.parse(await readFile(path.join(value.support, "Graph", "staged", "linked-source", "snapshot.json"), "utf8"));
    assert.equal(staged.papers[0].source.storageMode, "linked");

    await writeFile(value.pdfPath, "%PDF-1.4\nchanged source\n%%EOF\n");
    await assert.rejects(
      execFileAsync(process.execPath, [stageRefresh, "--snapshot", value.snapshotPath, "--refresh-id", "linked-source-changed", "--support-dir", value.support]),
      /linked PDF SHA-256 does not match/,
    );
    await unlink(value.pdfPath);
    await assert.rejects(
      execFileAsync(process.execPath, [stageRefresh, "--snapshot", value.snapshotPath, "--refresh-id", "linked-source-missing", "--support-dir", value.support]),
      /linked PDF is unavailable/,
    );
  } finally {
    await rm(value.temporary, { recursive: true, force: true });
  }
});

test("Doctor reports a missing linked source after restore without erasing its reference", async () => {
  const value = await fixture();
  try {
    await execFileAsync("python3", [finalize, "--support-dir", value.support, "--snapshot", value.snapshotPath]);
    await execFileAsync(process.execPath, [generateClaims, "--paper", "linked-paper", "--snapshot", value.snapshotPath, "--json", "--support-dir", value.support]);
    const snapshot = JSON.parse(await readFile(value.snapshotPath, "utf8"));
    await writeJson(path.join(value.support, "Graph", "current.json"), snapshot);
    await unlink(value.pdfPath);

    let report;
    try {
      await execFileAsync(process.execPath, [cli, "doctor", "--quick", "--json", "--support-dir", value.support]);
      assert.fail("Doctor must return a non-zero status for a missing linked source");
    } catch (error) {
      report = JSON.parse(error.stdout);
    }
    assert.equal(report.status, "error");
    assert.equal(report.findings.some((item) => item.code === "source.linked_missing"), true);
    assert.equal(report.findings.find((item) => item.code === "source.linked_missing").details.sourcePath, value.pdfPath);
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "doctor", "--fix", "--quick", "--json", "--support-dir", value.support]),
      /doctor refuses repair while source\/graph errors remain/,
    );
    const graph = JSON.parse(await readFile(path.join(value.support, "Graph", "current.json"), "utf8"));
    assert.equal(graph.papers[0].source.pdfPath, value.pdfPath);
  } finally {
    await rm(value.temporary, { recursive: true, force: true });
  }
});

test("Retriever revalidates a linked PDF before adoption and never counts changed bytes", async () => {
  const value = await fixture();
  try {
    await execFileAsync("python3", [finalize, "--support-dir", value.support, "--snapshot", value.snapshotPath]);
    await execFileAsync(process.execPath, [generateClaims, "--paper", "linked-paper", "--snapshot", value.snapshotPath, "--json", "--support-dir", value.support]);
    const first = JSON.parse((await execFileAsync(process.execPath, [
      readPaper,
      "--paper", "linked-paper",
      "--task-id", "linked-source-first",
      "--json",
      "--support-dir", value.support,
    ])).stdout);
    assert.equal(first.counted, true);
    const ledgerPath = path.join(value.support, "Usage", "events.jsonl");
    const ledgerBefore = await readFile(ledgerPath, "utf8");

    await writeFile(value.pdfPath, "%PDF-1.4\nchanged after curation\n%%EOF\n");
    await assert.rejects(
      execFileAsync(process.execPath, [
        readPaper,
        "--paper", "linked-paper",
        "--task-id", "linked-source-changed",
        "--json",
        "--support-dir", value.support,
      ]),
      /source PDF hash mismatch.*usage was not counted/,
    );
    assert.equal(await readFile(ledgerPath, "utf8"), ledgerBefore);
  } finally {
    await rm(value.temporary, { recursive: true, force: true });
  }
});

test("linked graph sources must use normalized absolute paths", async () => {
  const value = await fixture();
  try {
    const snapshot = JSON.parse(await readFile(value.snapshotPath, "utf8"));
    snapshot.papers[0].source.pdfPath = "relative/linked-paper.pdf";
    snapshot.papers[0].pdfPath = "relative/linked-paper.pdf";
    await writeJson(value.snapshotPath, snapshot);
    await assert.rejects(
      execFileAsync(process.execPath, [stageRefresh, "--snapshot", value.snapshotPath, "--refresh-id", "invalid-linked", "--support-dir", value.support]),
      /source\.pdfPath must be an absolute path/,
    );
  } finally {
    await rm(value.temporary, { recursive: true, force: true });
  }
});

test("linked staging rejects a symlinked PDF or directory below the selected root", async () => {
  const fileFixture = await fixture();
  try {
    const externalTarget = path.join(fileFixture.temporary, "outside-paper.pdf");
    await writeFile(externalTarget, "%PDF-1.4\noutside\n%%EOF\n");
    await unlink(fileFixture.pdfPath);
    await symlink(externalTarget, fileFixture.pdfPath);
    const snapshot = JSON.parse(await readFile(fileFixture.snapshotPath, "utf8"));
    snapshot.papers[0].source.sha256 = sha256(await readFile(externalTarget));
    await writeJson(fileFixture.snapshotPath, snapshot);
    await assert.rejects(
      execFileAsync(process.execPath, [stageRefresh, "--snapshot", fileFixture.snapshotPath, "--refresh-id", "symlink-file", "--support-dir", fileFixture.support]),
      /contains a symbolic link/,
    );
  } finally {
    await rm(fileFixture.temporary, { recursive: true, force: true });
  }

  const directoryFixture = await fixture();
  try {
    const outsideDirectory = path.join(directoryFixture.temporary, "outside-directory");
    const outsidePdf = path.join(outsideDirectory, "nested.pdf");
    const linkedDirectory = path.join(directoryFixture.linkedRootPath, "linked-directory");
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(outsidePdf, "%PDF-1.4\noutside directory\n%%EOF\n");
    await symlink(outsideDirectory, linkedDirectory);
    const snapshot = JSON.parse(await readFile(directoryFixture.snapshotPath, "utf8"));
    const linkedPdf = path.join(linkedDirectory, "nested.pdf");
    snapshot.papers[0].source.pdfPath = linkedPdf;
    snapshot.papers[0].source.relativePath = "linked-directory/nested.pdf";
    snapshot.papers[0].source.sha256 = sha256(await readFile(outsidePdf));
    snapshot.papers[0].pdfPath = linkedPdf;
    await writeJson(directoryFixture.snapshotPath, snapshot);
    await assert.rejects(
      execFileAsync(process.execPath, [stageRefresh, "--snapshot", directoryFixture.snapshotPath, "--refresh-id", "symlink-directory", "--support-dir", directoryFixture.support]),
      /contains a symbolic link/,
    );
  } finally {
    await rm(directoryFixture.temporary, { recursive: true, force: true });
  }
});

test("Curator finalization and immutable artifact creation reject linked symlinks", async () => {
  const value = await fixture();
  try {
    const externalTarget = path.join(value.temporary, "outside-same-bytes.pdf");
    const originalBytes = await readFile(value.pdfPath);
    await writeFile(externalTarget, originalBytes);
    await unlink(value.pdfPath);
    await symlink(externalTarget, value.pdfPath);
    await assert.rejects(
      execFileAsync("python3", [finalize, "--support-dir", value.support, "--snapshot", value.snapshotPath]),
      /contains a symbolic link/,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [generateClaims, "--paper", "linked-paper", "--json", "--support-dir", value.support]),
      /contains a symbolic link/,
    );
  } finally {
    await rm(value.temporary, { recursive: true, force: true });
  }
});

test("linked validation rejects a selected root reached through a symlinked ancestor", async () => {
  const value = await fixture();
  try {
    const actualParent = path.join(value.temporary, "actual-parent");
    const actualRoot = path.join(actualParent, "literature");
    const actualPdf = path.join(actualRoot, "ancestor-linked.pdf");
    const aliasParent = path.join(value.temporary, "alias-parent");
    await mkdir(actualRoot, { recursive: true });
    await writeFile(actualPdf, "%PDF-1.4\nancestor symlink\n%%EOF\n");
    await symlink(actualParent, aliasParent);
    const aliasRoot = path.join(aliasParent, "literature");
    const aliasPdf = path.join(aliasRoot, "ancestor-linked.pdf");
    const snapshot = JSON.parse(await readFile(value.snapshotPath, "utf8"));
    snapshot.papers[0].source.pdfPath = aliasPdf;
    snapshot.papers[0].source.linkedRootPath = aliasRoot;
    snapshot.papers[0].source.relativePath = "ancestor-linked.pdf";
    snapshot.papers[0].source.sha256 = sha256(await readFile(actualPdf));
    snapshot.papers[0].pdfPath = aliasPdf;
    await writeJson(value.snapshotPath, snapshot);

    await assert.rejects(
      execFileAsync(process.execPath, [stageRefresh, "--snapshot", value.snapshotPath, "--refresh-id", "ancestor-symlink", "--support-dir", value.support]),
      /traverses a symbolic-link ancestor/,
    );
    await assert.rejects(
      execFileAsync("python3", [finalize, "--support-dir", value.support, "--snapshot", value.snapshotPath]),
      /traverses a symbolic-link ancestor/,
    );
    const core = await import(path.join(root, "scripts", "lib", "liteverse-core.mjs"));
    const reference = core.resolveSourcePdfPath(value.support, snapshot.papers[0], "Library/PDFs/linked-paper.pdf");
    await assert.rejects(core.validateLinkedSourcePath(reference), /traverses a symbolic-link ancestor/);
  } finally {
    await rm(value.temporary, { recursive: true, force: true });
  }
});
