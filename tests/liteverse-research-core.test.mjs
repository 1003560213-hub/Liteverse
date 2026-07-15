import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts", "liteverse-cli.mjs");
const readPaper = path.join(root, "skills", "liteverse-retriever", "scripts", "read-paper.mjs");
const generateClaims = path.join(root, "skills", "liteverse-curator", "scripts", "generate-claims.mjs");

const sha = (value) => createHash("sha256").update(value).digest("hex");

async function json(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture() {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-research-core-"));
  const pdf = Buffer.from("%PDF-1.4\nLiteverse deterministic test source\n%%EOF\n");
  const sourceSha = sha(pdf);
  const card = `---
paper_id: "seed-paper"
title: "Adaptive Sampling for Climate Models"
authors: ["Researcher"]
source_sha256: "${sourceSha}"
verification_status: "evidence_verified"
tags: ["adaptive sampling", "climate"]
---

# Adaptive Sampling for Climate Models

## Research question

- How can adaptive sampling improve climate-model calibration? [E1]

## Methods

- Use an uncertainty-guided numerical sampling workflow. [E1]

## Main results

- Adaptive sampling reduces calibration cost while preserving accuracy. [E1]

## Limitations

- The evaluation covers one regional climate dataset. [E1]

## Evidence index

- E1 — PDF p. 1, Sec. I — Source evidence.

### Legacy card retained for evidence review

> The following pre-migration notes are provisional.
> secret-legacy-token must never be indexed.
`;
  const fulltext = `---\npaper_id: "seed-paper"\nsource_sha256: "${sourceSha}"\n---\n\n<!-- page: 1 -->\n\nSource evidence on gravitational condensation.\n\n<!-- page: 2 -->\n\nSecond page.\n`;
  await Promise.all([
    mkdir(path.join(support, "Knowledge", "cards"), { recursive: true }),
    mkdir(path.join(support, "Knowledge", "fulltext"), { recursive: true }),
    mkdir(path.join(support, "Library", "PDFs"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(support, "Knowledge", "cards", "seed-paper.md"), card),
    writeFile(path.join(support, "Knowledge", "fulltext", "seed-paper.md"), fulltext),
    writeFile(path.join(support, "Library", "PDFs", "seed-paper.pdf"), pdf),
    json(path.join(support, "Graph", "current.json"), {
      schemaVersion: "3.0.0",
      revision: 7,
      categories: [{ id: "macro", name: "Macro" }],
      papers: [{
        id: "seed-paper",
        title: "Adaptive Sampling for Climate Models",
        primaryCategory: "macro",
        categoryIds: ["macro"],
        verificationStatus: "evidence_verified",
        source: { pdfPath: "Library/PDFs/seed-paper.pdf", sha256: sourceSha },
        markdownPath: "Knowledge/cards/seed-paper.md",
        fulltextPath: "Knowledge/fulltext/seed-paper.md",
        artifacts: { cardPath: "Knowledge/cards/seed-paper.md", fulltextPath: "Knowledge/fulltext/seed-paper.md", evidenceCount: 1 },
      }],
      relations: [],
    }),
    json(path.join(support, "Knowledge", "papers.json"), {
      schemaVersion: 2,
      papers: [{
        paperId: "seed-paper",
        title: "Adaptive Sampling for Climate Models",
        authors: ["Researcher"],
        tags: ["adaptive sampling", "climate"],
        verificationStatus: "card_draft",
        primaryCategory: "macro",
        cardPath: "Knowledge/cards/seed-paper.md",
        fulltextPath: "Knowledge/fulltext/seed-paper.md",
        pdfPath: "Library/PDFs/seed-paper.pdf",
        sha256: sourceSha,
        source: { pdfPath: "Library/PDFs/seed-paper.pdf", sha256: sourceSha },
        artifacts: { cardPath: "Knowledge/cards/seed-paper.md", fulltextPath: "Knowledge/fulltext/seed-paper.md" },
      }],
    }),
    json(path.join(support, "Projects", "projects.json"), {
      schemaVersion: 1,
      activeProjectId: "project-alpha",
      items: [{ projectId: "project-alpha", name: "Alpha" }],
    }),
  ]);
  return { support, card };
}

test("Doctor repairs drift, creates immutable claims, and FTS excludes legacy provisional text", async () => {
  const { support } = await fixture();
  try {
    const before = JSON.parse((await execFileAsync(process.execPath, [cli, "doctor", "--quick", "--json", "--support-dir", support])).stdout);
    assert.equal(before.findings.some((item) => item.code === "projection.verification_status_drift"), true);
    const fixed = JSON.parse((await execFileAsync(process.execPath, [cli, "doctor", "--fix", "--json", "--support-dir", support])).stdout);
    assert.equal(fixed.counts.error, 0);
    assert.equal(fixed.artifactRevisionsCreated, 1);
    const index = JSON.parse(await readFile(path.join(support, "Knowledge", "papers.json"), "utf8"));
    assert.equal(index.papers[0].verificationStatus, "evidence_verified");
    assert.equal(index.papers[0].artifact.artifactRevision, 1);
    const claims = JSON.parse(await readFile(path.join(support, "Knowledge", "claims", "seed-paper.json"), "utf8"));
    assert.ok(claims.claims.length >= 4);
    assert.equal(JSON.stringify(claims).includes("secret-legacy-token"), false);
    const search = JSON.parse((await execFileAsync(process.execPath, [cli, "search", "--query", "adaptive sampling", "--json", "--support-dir", support])).stdout);
    assert.equal(search.results[0].paperId, "seed-paper");
    const legacy = JSON.parse((await execFileAsync(process.execPath, [cli, "search", "--query", "secret-legacy-token", "--json", "--support-dir", support])).stdout);
    assert.equal(legacy.count, 0);
    const searchDatabase = new DatabaseSync(path.join(support, "Cache", "Search", "liteverse.sqlite"), { readOnly: true });
    try {
      assert.equal(searchDatabase.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
      assert.equal(searchDatabase.prepare("SELECT count(*) AS count FROM papers").get().count, 1);
    } finally {
      searchDatabase.close();
    }
    const snapshotPath = path.join(support, "next.json");
    await writeFile(snapshotPath, await readFile(path.join(support, "Graph", "current.json")));
    await execFileAsync(process.execPath, [generateClaims, "--paper", "seed-paper", "--snapshot", snapshotPath, "--json", "--support-dir", support]);
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    assert.equal(snapshot.papers[0].artifacts.integrity.artifactRevision, 1);
    await assert.rejects(
      execFileAsync(process.execPath, [generateClaims, "--paper", "seed-paper", "--snapshot", path.join(support, "Graph", "current.json"), "--json", "--support-dir", support]),
      /never Graph\/current/,
    );
    await assert.rejects(readFile(path.join(support, "Usage", "events.jsonl")), /ENOENT/);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("Retriever verifies hashes before usage and records project/artifact/claim metadata", async () => {
  const { support, card } = await fixture();
  try {
    await execFileAsync(process.execPath, [cli, "doctor", "--fix", "--json", "--support-dir", support]);
    const claims = JSON.parse(await readFile(path.join(support, "Knowledge", "claims", "seed-paper.json"), "utf8"));
    const claim = claims.claims.find((item) => item.type === "result");
    const env = { ...process.env, LITEVERSE_TASK_ID: "natural-language-code-task" };
    const adopted = JSON.parse((await execFileAsync(process.execPath, [readPaper, "--paper", "seed-paper", "--claim", claim.claimId, "--page", "1", "--max-chars", "5000", "--json", "--support-dir", support], { env })).stdout);
    assert.equal(adopted.counted, true);
    assert.equal(adopted.projectId, "project-alpha");
    assert.deepEqual(adopted.selectedClaimIds, [claim.claimId]);
    const ledger = (await readFile(path.join(support, "Usage", "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(ledger[0].projectId, "project-alpha");
    assert.equal(ledger[0].artifactRevision, 1);
    assert.deepEqual(ledger[0].claimIds, [claim.claimId]);
    assert.equal(JSON.stringify(ledger).includes("natural-language-code-task"), false);

    await writeFile(path.join(support, "Knowledge", "cards", "seed-paper.md"), `${card}\nTampered.\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [readPaper, "--paper", "seed-paper", "--task-id", "second-task", "--json", "--support-dir", support]),
      /knowledge card hash mismatch/,
    );
    const after = (await readFile(path.join(support, "Usage", "events.jsonl"), "utf8")).trim().split("\n");
    assert.equal(after.length, 1);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("Context Pack is deterministic and locks graph, memory, claim, evidence, and budget metadata", async () => {
  const { support } = await fixture();
  try {
    await execFileAsync(process.execPath, [cli, "doctor", "--fix", "--json", "--support-dir", support]);
    const ledgerHash = "a".repeat(64);
    await Promise.all([
      json(path.join(support, "Projects", "project-alpha", "project.json"), { schemaVersion: 1, projectId: "project-alpha", name: "Alpha", revision: 3, ledgerHash }),
      json(path.join(support, "Projects", "project-alpha", "memory", "current.json"), {
        schemaVersion: 1,
        projectId: "project-alpha",
        revision: 3,
        ledgerHash,
        items: [{ memoryId: "convention-1", type: "convention", title: "Density convention", content: "Use mass density.", state: "active", evidenceState: "user_declared", provenance: "user", updatedRevision: 3 }],
      }),
    ]);
    const args = [cli, "context", "build", "--query", "adaptive sampling", "--task-id", "context-task", "--budget-chars", "5000", "--json", "--support-dir", support];
    const first = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    const firstBytes = await readFile(first.paths.json);
    const second = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    const secondBytes = await readFile(second.paths.json);
    assert.deepEqual(secondBytes, firstBytes);
    const pack = JSON.parse(firstBytes);
    assert.equal(pack.graphRevision, 7);
    assert.equal(pack.memoryRevision, 3);
    assert.equal(pack.query, "adaptive sampling");
    assert.equal(pack.budgetChars, 5000);
    assert.ok(pack.selectedClaims[0].claimId);
    assert.equal(pack.selectedClaims[0].artifactRevision, 1);
    assert.equal(pack.selectedClaims[0].contentHash.length, 64);
    assert.ok(pack.selectedClaims[0].whySelected);
    assert.ok(pack.selectedClaims[0].evidenceLocators.length);
    assert.ok(pack.selectedClaims[0].trust);
    assert.ok(Array.isArray(pack.limitations));
    assert.ok(Array.isArray(pack.conflicts));
    const markdown = await readFile(first.paths.markdown, "utf8");
    assert.match(markdown, /Graph revision: 7/);
    assert.match(markdown, /Density convention/);
    assert.deepEqual(first.selectedClaims, second.selectedClaims);
    assert.equal(first.usage[0].counted, true);
    assert.equal(second.usage[0].counted, false);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});
