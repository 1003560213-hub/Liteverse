import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "skills", "liteverse-curator", "scripts", "finalize-curated-snapshot.py");

function fixtureCard(id, hash) {
  return `---
paper_id: "${id}"
title: "Verified ${id}"
authors: ["Ada Author", "Ben Builder"]
metadata_status: "source_verified"
source_type: "pdf"
source_sha256: "${hash}"
arxiv_id: null
doi: null
pdf_path: "Library/PDFs/${id}.pdf"
fulltext_path: "Knowledge/fulltext/${id}.md"
extraction_status: "extracted"
verification_status: "evidence_verified"
card_schema_version: "liteverse-card-v1"
evidence_count: 1
primary_category: "theory"
secondary_category: null
classification_status: "classified"
tags: ["fixture"]
---

# Verified ${id}

## Research question

- Which question is tested? [E1]

## Methods

- A reproducible method is used. [E1]

## Equations and conventions

- The convention is explicit. [E1]

## Main results

- The main result is supported. [E1]

## Limitations

- The stated scope is narrow. [E1]

## Project role

- Use this as the verified baseline. [E1]

## Evidence index

- E1 — PDF p. 1, abstract — The source states the fixture claim.

## Annotation provenance

- Integrated annotations: none.
`;
}

function fixtureFulltext(id, hash, withPageMarker = true) {
  return `---
paper_id: "${id}"
title: "Old ${id}"
authors: ["et al."]
metadata_status: "provisional"
source_type: "pdf"
source_sha256: "${hash}"
arxiv_id: null
doi: null
extraction_status: "extracted"
verification_status: "card_draft"
---

# Old ${id}

${withPageMarker ? "<!-- page: 1 -->" : "<!-- page: unknown -->"}

Extracted fixture.
`;
}

async function createFinalizationFixture({ paperCount = 1, transformCard, pageMarkers = [] } = {}) {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-finalize-guard-"));
  await Promise.all([
    mkdir(path.join(support, "Library", "PDFs"), { recursive: true }),
    mkdir(path.join(support, "Knowledge", "cards"), { recursive: true }),
    mkdir(path.join(support, "Knowledge", "fulltext"), { recursive: true }),
    mkdir(path.join(support, "Migrations", "run"), { recursive: true }),
  ]);
  const papers = [];
  for (let index = 0; index < paperCount; index += 1) {
    const id = `paper-${index + 1}`;
    const pdf = Buffer.from(`%PDF-1.4\ncurated fixture ${id}\n%%EOF\n`);
    const hash = createHash("sha256").update(pdf).digest("hex");
    const card = transformCard ? transformCard(fixtureCard(id, hash), index, id) : fixtureCard(id, hash);
    await Promise.all([
      writeFile(path.join(support, "Library", "PDFs", `${id}.pdf`), pdf),
      writeFile(path.join(support, "Knowledge", "cards", `${id}.md`), card),
      writeFile(
        path.join(support, "Knowledge", "fulltext", `${id}.md`),
        fixtureFulltext(id, hash, pageMarkers[index] !== false),
      ),
    ]);
    papers.push({
      id,
      title: `Old ${id}`,
      authors: "et al.",
      primaryCategory: "theory",
      categoryIds: ["theory"],
      pdfPath: `Library/PDFs/${id}.pdf`,
      markdownPath: `Knowledge/cards/${id}.md`,
      fulltextPath: `Knowledge/fulltext/${id}.md`,
      source: { kind: "pdf", pdfPath: `Library/PDFs/${id}.pdf`, sha256: hash },
      artifacts: {
        cardPath: `Knowledge/cards/${id}.md`,
        fulltextPath: `Knowledge/fulltext/${id}.md`,
        evidenceCount: 0,
      },
    });
  }
  const snapshotPath = path.join(support, "Migrations", "run", "snapshot.json");
  await writeFile(snapshotPath, `${JSON.stringify({
    schemaVersion: "3.0.0",
    revision: 2,
    updated: "2026-01-01",
    visuals: {},
    categories: [],
    relations: [],
    papers,
  })}\n`);
  return { support, snapshotPath };
}

test("finalization closes card/fulltext/snapshot metadata without touching current graph", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-finalize-"));
  try {
    await Promise.all([
      mkdir(path.join(support, "Library", "PDFs"), { recursive: true }),
      mkdir(path.join(support, "Knowledge", "cards"), { recursive: true }),
      mkdir(path.join(support, "Knowledge", "fulltext"), { recursive: true }),
      mkdir(path.join(support, "Graph"), { recursive: true }),
      mkdir(path.join(support, "Migrations", "run"), { recursive: true }),
    ]);
    const pdf = Buffer.from("%PDF-1.4\ncurated fixture\n%%EOF\n");
    const hash = createHash("sha256").update(pdf).digest("hex");
    await writeFile(path.join(support, "Library", "PDFs", "paper-1.pdf"), pdf);
    const card = `---
paper_id: "paper-1"
title: "Verified title"
authors: ["Ada Author", "Ben Builder"]
metadata_status: "source_verified"
source_type: "pdf"
source_sha256: "${hash}"
arxiv_id: "2601.00001"
doi: null
pdf_path: "Library/PDFs/paper-1.pdf"
fulltext_path: "Knowledge/fulltext/paper-1.md"
extraction_status: "extracted"
verification_status: "evidence_verified"
card_schema_version: "liteverse-card-v1"
evidence_count: 1
primary_category: "theory"
secondary_category: null
classification_status: "classified"
tags: ["fixture"]
---

# Verified title

## Research question

- Which question is tested? [E1]

## Methods

- A reproducible method is used. [E1]

## Equations and conventions

- The convention is explicit. [E1]

## Main results

- The main result is supported. [E1]

## Limitations

- The stated scope is narrow. [E1]

## Project role

- Use this as the verified baseline. [E1]

## Evidence index

- E1 — PDF p. 1, abstract — The source states the fixture claim.

## Annotation provenance

- Integrated annotations: none.
`;
    const fulltext = `---
paper_id: "paper-1"
title: "Old title"
authors: ["et al."]
metadata_status: "provisional"
source_type: "pdf"
source_sha256: "${hash}"
arxiv_id: null
doi: null
extraction_status: "extracted"
verification_status: "card_draft"
---

# Old title

<!-- page: 1 -->

Extracted fixture.
`;
    await Promise.all([
      writeFile(path.join(support, "Knowledge", "cards", "paper-1.md"), card),
      writeFile(path.join(support, "Knowledge", "fulltext", "paper-1.md"), fulltext),
    ]);
    const current = { schemaVersion: "2.0.0", revision: 1, sentinel: true };
    const snapshot = {
      schemaVersion: "3.0.0",
      revision: 2,
      updated: "2026-01-01",
      visuals: {},
      categories: [],
      relations: [],
      papers: [{
        id: "paper-1",
        title: "Old title",
        authors: "et al.",
        primaryCategory: "theory",
        categoryIds: ["theory"],
        pdfPath: "Library/PDFs/paper-1.pdf",
        markdownPath: "Knowledge/cards/paper-1.md",
        fulltextPath: "Knowledge/fulltext/paper-1.md",
        source: { kind: "pdf", pdfPath: "Library/PDFs/paper-1.pdf", sha256: hash },
        artifacts: {
          cardPath: "Knowledge/cards/paper-1.md",
          fulltextPath: "Knowledge/fulltext/paper-1.md",
          evidenceCount: 0,
        },
      }],
    };
    const currentPath = path.join(support, "Graph", "current.json");
    const snapshotPath = path.join(support, "Migrations", "run", "snapshot.json");
    await Promise.all([
      writeFile(currentPath, `${JSON.stringify(current)}\n`),
      writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`),
    ]);

    await execFileAsync("python3", [script, "--support-dir", support, "--snapshot", snapshotPath]);
    const [nextSnapshotText, nextFulltext, currentText] = await Promise.all([
      readFile(snapshotPath, "utf8"),
      readFile(path.join(support, "Knowledge", "fulltext", "paper-1.md"), "utf8"),
      readFile(currentPath, "utf8"),
    ]);
    const nextPaper = JSON.parse(nextSnapshotText).papers[0];
    assert.equal(nextPaper.title, "Verified title");
    assert.equal(nextPaper.authors, "Ada Author, Ben Builder");
    assert.equal(nextPaper.verificationStatus, "evidence_verified");
    assert.equal(nextPaper.artifacts.evidenceCount, 1);
    assert.match(nextPaper.summary, /Which question is tested/);
    assert.match(nextPaper.projectRole, /verified baseline/);
    assert.match(nextFulltext, /metadata_status: "source_verified"/);
    assert.match(nextFulltext, /verification_status: "evidence_verified"/);
    assert.match(nextFulltext, /^# Verified title$/m);
    assert.equal(currentText, `${JSON.stringify(current)}\n`);

    await assert.rejects(
      execFileAsync("python3", [script, "--support-dir", support, "--snapshot", currentPath]),
      /refusing to modify Graph\/current\.json/,
    );
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("finalization rejects vague locators and missing or unknown evidence references", async () => {
  const cases = [
    {
      name: "vague locator",
      transform: (card) => card.replace("PDF p. 1, abstract", "original source"),
      message: /lacks an explicit page\/section\/equation\/figure\/table locator/,
    },
    {
      name: "missing reference",
      transform: (card) => card.replace("Which question is tested? [E1]", "Which question is tested?"),
      message: /scientific bullet has no evidence reference/,
    },
    {
      name: "unknown reference",
      transform: (card) => card.replace("Which question is tested? [E1]", "Which question is tested? [E2]"),
      message: /scientific bullet references unknown evidence.*E2/,
    },
  ];
  for (const fixtureCase of cases) {
    const { support, snapshotPath } = await createFinalizationFixture({ transformCard: fixtureCase.transform });
    try {
      await assert.rejects(
        execFileAsync("python3", [script, "--support-dir", support, "--snapshot", snapshotPath]),
        fixtureCase.message,
        fixtureCase.name,
      );
    } finally {
      await rm(support, { recursive: true, force: true });
    }
  }
});

test("finalization validates every paper before writing any fulltext", async () => {
  const { support, snapshotPath } = await createFinalizationFixture({
    paperCount: 2,
    pageMarkers: [true, false],
  });
  try {
    const firstFulltext = path.join(support, "Knowledge", "fulltext", "paper-1.md");
    const before = await readFile(firstFulltext);
    await assert.rejects(
      execFileAsync("python3", [script, "--support-dir", support, "--snapshot", snapshotPath]),
      /verified card fulltext has no positive page marker: paper-2/,
    );
    assert.deepEqual(await readFile(firstFulltext), before);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("finalization structurally rejects current, staged, and history graph targets outside support", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-finalize-path-guard-"));
  const support = path.join(temporary, "unrelated-support");
  const targets = [
    [path.join(temporary, "Graph", "current.json"), /Graph\/current\.json/],
    [path.join(temporary, "Graph", "staged", "refresh", "snapshot.json"), /immutable Graph\/staged artifact/],
    [path.join(temporary, "Graph", "history", "revision.json"), /immutable Graph\/history artifact/],
  ];
  try {
    for (const [target, message] of targets) {
      await assert.rejects(
        execFileAsync("python3", [script, "--support-dir", support, "--snapshot", target]),
        message,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
