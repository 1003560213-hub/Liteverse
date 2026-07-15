import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { buildContextPack } from "../scripts/lib/liteverse-context.mjs";
import { rebuildSearchIndex, searchLiteverse } from "../scripts/lib/liteverse-search.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const percentile95 = (values) => [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1];

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function inBatches(values, size, callback) {
  for (let index = 0; index < values.length; index += size) {
    await Promise.all(values.slice(index, index + size).map(callback));
  }
}

test("1,000-card warm BM25 search p95 and Context Pack assembly stay within targets", { timeout: 30_000 }, async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-1000-benchmark-"));
  const papers = [];
  const graphPapers = [];
  const count = 1000;
  try {
    await Promise.all([
      mkdir(path.join(support, "Knowledge", "cards"), { recursive: true }),
      mkdir(path.join(support, "Knowledge", "claims"), { recursive: true }),
    ]);
    await inBatches(Array.from({ length: count }, (_, index) => index), 80, async (index) => {
      const paperId = `synthetic-${String(index).padStart(4, "0")}`;
      const sourceSha256 = sha(`source-${paperId}`);
      const card = `---\npaper_id: "${paperId}"\ntitle: "Synthetic adaptive sampling study ${index}"\nauthors: ["Researcher ${index % 23}"]\nsource_sha256: "${sourceSha256}"\nverification_status: "evidence_verified"\ntags: ["adaptive sampling", "benchmark-${index % 17}"]\n---\n\n# Synthetic ${index}\n\n## Main results\n\n- Adaptive sampling improves climate surrogate calibration in benchmark ${index}. [E1]\n\n## Limitations\n\n- The study uses a synthetic regional dataset ${index}. [E1]\n\n## Evidence index\n\n- E1 — PDF p. 1, Sec. I — Synthetic benchmark evidence.\n\n### Legacy provisional material\n\n> legacy-secret-${index}\n`;
      const fulltext = `<!-- page: 1 -->\nSynthetic evidence ${index}.\n`;
      const cardSha256 = sha(card);
      const fulltextSha256 = sha(fulltext);
      const artifactSha256 = sha(`liteverse-artifact-v1\u001f${cardSha256}\u001f${fulltextSha256}\u001f${sourceSha256}`);
      const resultClaim = {
        claimId: `${paperId}-result`,
        paperId,
        type: "result",
        section: "Main results",
        text: `Adaptive sampling improves climate surrogate calibration in benchmark ${index}.`,
        evidenceIds: ["E1"],
        evidence: [{ evidenceId: "E1", locator: "PDF p. 1, Sec. I", paraphrase: "Synthetic benchmark evidence." }],
        verificationStatus: "evidence_verified",
        artifactRevision: 1,
        artifactSha256,
      };
      const limitationClaim = {
        ...resultClaim,
        claimId: `${paperId}-limitation`,
        type: "limitation",
        section: "Limitations",
        text: `Synthetic periodic box limitation ${index}.`,
      };
      const claimDocument = {
        schemaVersion: "liteverse-claims-v1",
        paperId,
        title: `Synthetic gravitational condensation study ${index}`,
        verificationStatus: "evidence_verified",
        artifactRevision: 1,
        artifactSha256,
        sourceSha256,
        claims: [resultClaim, limitationClaim],
      };
      const claimsText = `${JSON.stringify(claimDocument, null, 2)}\n`;
      const artifactRoot = `Knowledge/artifacts/${paperId}/revisions/000001`;
      const integrity = {
        artifactRevision: 1,
        artifactSha256,
        sourceSha256,
        cardSha256,
        fulltextSha256,
        claimsSha256: sha(claimsText),
        claimCount: 2,
        immutableCardPath: `${artifactRoot}/card.md`,
        immutableClaimsPath: `${artifactRoot}/claims.json`,
        immutableFulltextPath: `${artifactRoot}/fulltext.md`,
      };
      papers[index] = {
        paperId,
        title: `Synthetic gravitational condensation study ${index}`,
        authors: [`Researcher ${index % 23}`],
        tags: ["adaptive sampling", `benchmark-${index % 17}`],
        verificationStatus: "evidence_verified",
        primaryCategory: "macro",
        cardPath: `Knowledge/cards/${paperId}.md`,
        fulltextPath: `Knowledge/fulltext/${paperId}.md`,
        source: { pdfPath: `Library/PDFs/${paperId}.pdf`, sha256: sourceSha256 },
        artifact: integrity,
        artifacts: { cardPath: `Knowledge/cards/${paperId}.md`, fulltextPath: `Knowledge/fulltext/${paperId}.md`, integrity },
      };
      graphPapers[index] = { id: paperId, title: papers[index].title, primaryCategory: "macro", categoryIds: ["macro"], verificationStatus: "evidence_verified" };
      await Promise.all([
        mkdir(path.join(support, artifactRoot), { recursive: true }),
        writeFile(path.join(support, "Knowledge", "cards", `${paperId}.md`), card),
        writeFile(path.join(support, "Knowledge", "claims", `${paperId}.json`), claimsText),
      ]);
      await Promise.all([
        writeFile(path.join(support, artifactRoot, "card.md"), card),
        writeFile(path.join(support, artifactRoot, "claims.json"), claimsText),
      ]);
    });
    const ledgerHash = "b".repeat(64);
    await Promise.all([
      writeJson(path.join(support, "Knowledge", "papers.json"), { schemaVersion: 3, revision: 1, papers }),
      writeJson(path.join(support, "Graph", "current.json"), { schemaVersion: "3.0.0", revision: 1, categories: [{ id: "macro", name: "Macro" }], papers: graphPapers, relations: [] }),
      writeJson(path.join(support, "Projects", "benchmark", "project.json"), { schemaVersion: 1, projectId: "benchmark", revision: 1, ledgerHash }),
      writeJson(path.join(support, "Projects", "benchmark", "memory", "current.json"), { schemaVersion: 1, projectId: "benchmark", revision: 1, ledgerHash, items: [] }),
    ]);
    await rebuildSearchIndex(support);
    const timings = [];
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const started = performance.now();
      const result = await searchLiteverse(support, `gravitational condensation benchmark-${iteration % 17}`, { limit: 10 });
      timings.push(performance.now() - started);
      assert.equal(result.results.length, 10);
    }
    const p95 = percentile95(timings);
    const contextStarted = performance.now();
    const context = await buildContextPack(support, {
      query: "adaptive sampling climate surrogate",
      projectId: "benchmark",
      taskId: "benchmark-task",
      budgetChars: 12000,
      limit: 5,
    });
    const contextMs = performance.now() - contextStarted;
    const multiplier = process.env.CI ? 4 : 1;
    assert.ok(p95 <= 500 * multiplier, `warm search p95 ${p95.toFixed(1)}ms exceeds target`);
    assert.ok(contextMs <= 2000 * multiplier, `context build ${contextMs.toFixed(1)}ms exceeds target`);
    assert.ok(context.pack.selectedClaims.length > 0);
    console.log(`Liteverse benchmark: 1000 cards, warm search p95=${p95.toFixed(1)}ms, context=${contextMs.toFixed(1)}ms`);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});
