import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const workerSourcePath = path.join(root, "macos", "LiteverseLocalWorker.swift");
const buildScriptPath = path.join(root, "scripts", "build-local-worker.sh");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function minimalPDFPages(pageTexts) {
  const streams = pageTexts.map((text) => {
    const escapedLines = text.split("\n").map((line) => (
      line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")
    ));
    const textCommands = escapedLines.map((line, index) => `${index ? "T*\n" : ""}(${line}) Tj`).join("\n");
    return `BT\n/F1 12 Tf\n14 TL\n72 720 Td\n${textCommands}\nET\n`;
  });
  const fontObjectNumber = 3 + (pageTexts.length * 2);
  const pageObjectNumbers = pageTexts.map((_, index) => 3 + (index * 2));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`,
  ];
  for (const [index, stream] of streams.entries()) {
    const contentObjectNumber = pageObjectNumbers[index] + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

function minimalPDF(text) {
  return minimalPDFPages([text]);
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function pathExists(value) {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

async function runWorker(worker, directory, job) {
  const requestPath = path.join(directory, `${job.jobId}.request.json`);
  await writeFile(requestPath, JSON.stringify(job));
  return execFileAsync(worker, ["--request", requestPath], { timeout: 30_000 });
}

test("local worker source and package integration enforce the native preparation boundary", async () => {
  const [source, buildScript, packageScript] = await Promise.all([
    readFile(workerSourcePath, "utf8"),
    readFile(buildScriptPath, "utf8"),
    readFile(path.join(root, "scripts", "build-macos-app.sh"), "utf8"),
  ]);

  assert.match(source, /liteverse-local-job-v1/);
  assert.match(source, /FileHandle\.standardInput\.readDataToEndOfFile/);
  assert.match(source, /source\.pdfPath/);
  assert.match(source, /source\.storageMode/);
  assert.match(source, /source\.linkedRootPath/);
  assert.match(source, /source\.relativePath/);
  assert.match(source, /Darwin\.lstat/);
  assert.match(source, /Darwin\.realpath/);
  assert.match(source, /linked PDF changed after folder registration/);
  assert.match(source, /source\.arxivId/);
  assert.match(source, /catalogFingerprint does not match/);
  assert.match(source, /PDFDocument\(url:/);
  assert.match(source, /<!-- page:/);
  assert.match(source, /liteverse-review-packet-v2/);
  assert.match(source, /"purpose": "routing_only"/);
  assert.match(source, /"verifiedClaims": false/);
  assert.match(source, /artifact\(role: "review_packet"/);
  assert.match(source, /manifest\["state"\] = extractionStatus == "needs_ocr" \? "needs_attention" : "ready"/);
  assert.match(source, /Darwin\.lockf/);
  assert.match(source, /Darwin\.fsync/);
  assert.match(source, /Darwin\.rename/);
  assert.doesNotMatch(source, /appendingPathComponent\("Graph/);
  assert.doesNotMatch(source, /appendingPathComponent\("Usage/);
  assert.doesNotMatch(source, /appendingPathComponent\("Projects/);
  assert.match(buildScript, /-framework Foundation/);
  assert.match(buildScript, /-framework PDFKit/);
  assert.match(buildScript, /-framework CryptoKit/);
  assert.match(buildScript, /codesign --force --sign/);
  assert.match(packageScript, /build-local-worker\.sh/);
  assert.match(packageScript, /MacOS\/LiteverseLocalWorker/);
});

test("native worker materializes a PDF atomically and detects a strict hash duplicate", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-native-worker-test-"));
  const worker = path.join(temporary, "LiteverseLocalWorker");
  try {
    await execFileAsync("/bin/zsh", [buildScriptPath, worker], { timeout: 180_000 });
  } catch (error) {
    const diagnostic = `${error.stderr ?? ""}\n${error.stdout ?? ""}`;
    if (/SDK is not supported by the compiler|redefinition of module 'SwiftBridging'/.test(diagnostic)) {
      t.skip("the installed swiftc and macOS SDK are from mismatched Command Line Tools releases");
      return;
    }
    throw error;
  }

  const support = path.join(temporary, "Support");
  const inputPDF = path.join(temporary, "input.pdf");
  const rankedSemanticCandidates = Array.from({ length: 20 }, (_, index) => (
    `We investigate whether model ${index} works; we assume it; however we find limits.`
  ));
  const rankedAnchorCandidates = Array.from({ length: 30 }, (_, index) => (
    `Figure ${index + 10} and Table ${index + 10} report routing values in [${index + 20}].`
  ));
  const rankedEquationCandidates = Array.from({ length: 30 }, (_, index) => `x${index} = y${index} + z${index}`);
  const rankedHeadingCandidates = Array.from({ length: 40 }, (_, index) => `${index + 3}.1 Synthetic Section ${index}`);
  const pdfPages = [
    [
      "1 Introduction",
      "We investigate whether this deterministic fixture can expose a stable research question?",
      "We assume that the synthetic source remains fixed while the extraction algorithm is evaluated.",
      "We use a numerical simulation method to compute the deterministic routing fixture.",
      "We find that the controlled fixture produces a stable extracted result.",
      "However, this approximation is limited to a synthetic test document.",
      "E = m c^2",
      "Figure 2 shows the stable routing result reported in [12].",
      "Table 1 summarizes the deterministic values used by the simulation method.",
    ].join("\n"),
    ...chunks(rankedSemanticCandidates, 8).map((lines) => lines.join("\n")),
    [
      "2 Methods",
      "We use a numerical simulation algorithm and dataset method to compute the full-document ranking sentinel.",
    ].join("\n"),
    ...chunks(rankedAnchorCandidates, 8).map((lines) => lines.join("\n")),
    ...rankedEquationCandidates,
    ...rankedHeadingCandidates,
  ];
  const pdf = minimalPDFPages(pdfPages);
  await mkdir(support, { recursive: true });
  await writeFile(inputPDF, pdf);

  const firstJob = {
    schemaVersion: "liteverse-local-job-v1",
    operation: "materialize",
    jobId: "local-pdf-one",
    itemId: "library-item-one",
    itemRevision: 1,
    catalogFingerprint: "absent",
    supportDir: support,
    source: {
      kind: "pdf",
      storageMode: "managed",
      pdfPath: inputPDF,
      expectedSha256: sha256(pdf),
      title: "Deterministic Local Extraction",
      authors: ["Liteverse Test"],
      doi: "10.1234/liteverse.worker",
    },
  };
  const firstRun = await runWorker(worker, temporary, firstJob);
  const firstResponse = JSON.parse(firstRun.stdout);
  assert.equal(firstResponse.state, "ready");
  const resultDirectory = path.join(support, "Work", "LocalPipeline", "local-pdf-one");
  const manifestBytes = await readFile(path.join(resultDirectory, "manifest.json"));
  assert.deepEqual(Buffer.from(firstRun.stdout), manifestBytes);
  const manifest = JSON.parse(manifestBytes);
  assert.deepEqual(firstResponse, manifest);
  assert.equal(manifest.schemaVersion, "liteverse-local-result-v1");
  assert.equal(manifest.state, "ready");
  assert.equal(manifest.sourceSha256, sha256(pdf));
  assert.equal(manifest.extractionStatus, "extracted");
  assert.equal(manifest.canonicalMetadata.title, firstJob.source.title);
  assert.deepEqual(manifest.canonicalMetadata.authors, firstJob.source.authors);
  assert.equal(manifest.canonicalMetadata.doi, firstJob.source.doi);
  assert.equal(manifest.canonicalMetadata.metadataStatus, "provisional");
  assert.equal(manifest.paper.verificationStatus, "card_draft");
  assert.deepEqual(manifest.outputs.map((entry) => entry.role).sort(), [
    "card",
    "fulltext",
    "pdf",
    "review_packet",
  ]);
  for (const output of manifest.outputs) {
    const bytes = await readFile(path.join(resultDirectory, output.path));
    assert.equal(output.sha256, sha256(bytes));
    assert.equal(output.size, bytes.byteLength);
  }
  const fulltext = await readFile(path.join(resultDirectory, "fulltext.md"), "utf8");
  const card = await readFile(path.join(resultDirectory, "card.md"), "utf8");
  assert.match(fulltext, /<!-- page: 1 -->/);
  assert.match(fulltext, /verification_status: "card_draft"/);
  assert.match(card, /## Evidence index/);
  const reviewPacket = JSON.parse(await readFile(path.join(resultDirectory, "review-packet.json"), "utf8"));
  assert.equal(reviewPacket.schemaVersion, "liteverse-review-packet-v2");
  assert.deepEqual(reviewPacket.compatibility, ["liteverse-review-packet-v1-fields"]);
  assert.equal(reviewPacket.sourceSha256, sha256(pdf));
  assert.equal(reviewPacket.itemRevision, firstJob.itemRevision);
  assert.equal(reviewPacket.pageCount, pdfPages.length);
  assert.equal(reviewPacket.extractionStatus, "extracted");
  assert.equal(reviewPacket.status, "provisional");
  assert.equal(reviewPacket.purpose, "routing_only");
  assert.equal(reviewPacket.ranking.scope, "full_document");
  assert.equal(reviewPacket.ranking.strategy, "deterministic_signal_score_v2");
  assert.equal(reviewPacket.pageExtractionQuality.length, pdfPages.length);
  for (const [index, quality] of reviewPacket.pageExtractionQuality.entries()) {
    assert.equal(quality.page, index + 1);
    assert.match(quality.pageTextSha256, /^[a-f0-9]{64}$/);
    assert.ok(["good", "usable", "sparse", "empty"].includes(quality.quality));
  }
  assert.ok(reviewPacket.sectionHeadingCandidates.length >= 1);
  assert.ok(reviewPacket.equationLikeLineCandidates.length >= 1);
  assert.equal(reviewPacket.anchors.figures.length, 16);
  assert.equal(reviewPacket.anchors.tables.length, 16);
  assert.equal(reviewPacket.anchors.citations.length, 24);
  assert.equal(reviewPacket.candidateSets.researchQuestions.length, 16);
  assert.ok(reviewPacket.sentenceCandidates.methods.length >= 1);
  assert.ok(reviewPacket.sentenceCandidates.results.length >= 1);
  assert.ok(reviewPacket.sentenceCandidates.limitations.length >= 1);
  assert.equal(reviewPacket.candidateSets.assumptions.length, 16);
  assert.deepEqual(reviewPacket.anchors.sections, reviewPacket.sectionHeadingCandidates);
  assert.deepEqual(reviewPacket.anchors.equations, reviewPacket.equationLikeLineCandidates);
  assert.deepEqual(reviewPacket.candidateSets.methods, reviewPacket.sentenceCandidates.methods);
  assert.deepEqual(reviewPacket.candidateSets.results, reviewPacket.sentenceCandidates.results);
  assert.deepEqual(reviewPacket.candidateSets.limitations, reviewPacket.sentenceCandidates.limitations);
  assert.equal(reviewPacket.sectionHeadingCandidates.length, 32);
  assert.equal(reviewPacket.equationLikeLineCandidates.length, 24);
  assert.ok(reviewPacket.anchors.figures.length <= 16);
  assert.ok(reviewPacket.anchors.tables.length <= 16);
  assert.ok(reviewPacket.anchors.citations.length <= 24);
  assert.ok(reviewPacket.candidateSets.researchQuestions.length <= 16);
  assert.equal(reviewPacket.sentenceCandidates.methods.length, 16);
  assert.equal(reviewPacket.sentenceCandidates.results.length, 16);
  assert.equal(reviewPacket.sentenceCandidates.limitations.length, 16);
  assert.ok(reviewPacket.candidateSets.assumptions.length <= 16);
  assert.ok(reviewPacket.candidateSets.methods.some((candidate) => (
    candidate.text.includes("full-document ranking")
  )), "full-document ranking must retain the late high-score method candidate");
  assert.ok(reviewPacket.candidateSets.methods.some((candidate) => candidate.section === "2 Methods"));
  assert.deepEqual(
    reviewPacket.candidateSets.methods.map((candidate) => candidate.routingScore),
    reviewPacket.candidateSets.methods.map((candidate) => candidate.routingScore).toSorted((a, b) => b - a),
  );
  const candidates = [
    ...reviewPacket.anchors.sections,
    ...reviewPacket.anchors.equations,
    ...reviewPacket.anchors.figures,
    ...reviewPacket.anchors.tables,
    ...reviewPacket.anchors.citations,
    ...reviewPacket.candidateSets.researchQuestions,
    ...reviewPacket.candidateSets.methods,
    ...reviewPacket.candidateSets.results,
    ...reviewPacket.candidateSets.limitations,
    ...reviewPacket.candidateSets.assumptions,
  ];
  assert.equal(new Set(candidates.map((candidate) => candidate.id)).size, candidates.length);
  const qualityByPage = new Map(reviewPacket.pageExtractionQuality.map((quality) => [quality.page, quality]));
  for (const candidate of candidates) {
    assert.ok(candidate.page >= 1 && candidate.page <= pdfPages.length);
    assert.match(candidate.id, /^rp2-(?:candidate|anchor)-[a-f0-9]{64}$/);
    assert.equal(candidate.id, candidate.anchorId ?? candidate.candidateId);
    assert.equal(candidate.sourceSha256, sha256(pdf));
    assert.equal(candidate.pageTextSha256, qualityByPage.get(candidate.page).pageTextSha256);
    assert.equal(candidate.characterRange.encoding, "utf16");
    assert.ok(candidate.characterRange.start >= 0);
    assert.ok(candidate.characterRange.end > candidate.characterRange.start);
    assert.ok(candidate.characterRange.end <= qualityByPage.get(candidate.page).characterCount);
    assert.equal(candidate.context.current, candidate.text);
    assert.ok(Object.hasOwn(candidate.context, "previous"));
    assert.ok(Object.hasOwn(candidate.context, "next"));
    assert.equal(candidate.verificationState, "unverified");
    assert.equal(candidate.status, "provisional");
    assert.equal(candidate.purpose, "routing_only");
  }
  assert.equal(reviewPacket.guardrails.verifiedClaims, false);
  assert.equal(reviewPacket.guardrails.relationStrength, false);
  assert.equal(reviewPacket.guardrails.classification, false);
  assert.equal(await pathExists(path.join(support, "Graph", "current.json")), false);
  assert.equal(await pathExists(path.join(support, "Usage")), false);
  assert.equal(await pathExists(path.join(support, "Projects")), false);
  assert.deepEqual(
    (await readdir(path.join(support, "Work", "LocalPipeline")))
      .filter((entry) => entry !== ".worker.lock")
      .sort(),
    ["local-pdf-one"],
  );

  const repeatJob = { ...firstJob, jobId: "local-pdf-repeat" };
  await runWorker(worker, temporary, repeatJob);
  const repeatPacket = JSON.parse(await readFile(path.join(
    support,
    "Work",
    "LocalPipeline",
    repeatJob.jobId,
    "review-packet.json",
  ), "utf8"));
  assert.deepEqual(repeatPacket.pageExtractionQuality, reviewPacket.pageExtractionQuality);
  assert.deepEqual(repeatPacket.candidateSets, reviewPacket.candidateSets);
  assert.deepEqual(repeatPacket.anchors, reviewPacket.anchors);

  const knowledge = path.join(support, "Knowledge");
  await mkdir(knowledge, { recursive: true });
  const catalog = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    papers: [{
      paperId: "existing-paper",
      title: firstJob.source.title,
      authors: firstJob.source.authors,
      source: { sha256: sha256(pdf), doi: firstJob.source.doi },
    }],
  }, null, 2)}\n`);
  await writeFile(path.join(knowledge, "papers.json"), catalog);
  const duplicateJob = {
    ...firstJob,
    jobId: "local-pdf-duplicate",
    itemId: "library-item-two",
    catalogFingerprint: sha256(catalog),
  };
  const duplicateRun = await runWorker(worker, temporary, duplicateJob);
  const duplicateResponse = JSON.parse(duplicateRun.stdout);
  assert.equal(duplicateResponse.state, "duplicate");
  const duplicateManifest = JSON.parse(await readFile(path.join(
    support,
    "Work",
    "LocalPipeline",
    duplicateJob.jobId,
    "manifest.json",
  ), "utf8"));
  assert.deepEqual(duplicateResponse, duplicateManifest);
  assert.equal(duplicateManifest.state, "duplicate");
  assert.equal(duplicateManifest.duplicateOf.paperId, "existing-paper");
  assert.deepEqual(duplicateManifest.deduplication.matchedBy.sort(), ["doi", "sha256"]);
  assert.deepEqual(duplicateManifest.outputs, []);

  const conflictingCatalog = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    papers: [{
      paperId: "existing-paper",
      title: firstJob.source.title,
      authors: firstJob.source.authors,
      source: { sha256: sha256(pdf), doi: "10.1234/a.different.paper" },
    }],
  }, null, 2)}\n`);
  await writeFile(path.join(knowledge, "papers.json"), conflictingCatalog);
  const conflictingDuplicateJob = {
    ...firstJob,
    jobId: "local-pdf-conflicting-duplicate",
    itemId: "library-item-conflicting-duplicate",
    catalogFingerprint: sha256(conflictingCatalog),
  };
  const conflictingDuplicateRun = await runWorker(worker, temporary, conflictingDuplicateJob);
  const conflictingDuplicateManifest = JSON.parse(conflictingDuplicateRun.stdout);
  assert.equal(conflictingDuplicateManifest.state, "needs_attention");
  assert.equal(
    conflictingDuplicateManifest.preparation.reason,
    "conflicting_duplicate_identifiers",
  );
  assert.deepEqual(conflictingDuplicateManifest.deduplication.matchedBy, ["sha256"]);
  assert.deepEqual(conflictingDuplicateManifest.deduplication.conflicts, [{
    paperId: "existing-paper",
    key: "doi",
    incoming: "10.1234/liteverse.worker",
    existing: "10.1234/a.different.paper",
  }]);
  assert.deepEqual(conflictingDuplicateManifest.outputs, []);

  const ocrSupport = path.join(temporary, "OCR Support");
  const ocrPDFPath = path.join(temporary, "scan.pdf");
  await mkdir(ocrSupport, { recursive: true });
  await writeFile(ocrPDFPath, minimalPDF(""));
  const ocrJob = {
    schemaVersion: "liteverse-local-job-v1",
    operation: "materialize",
    jobId: "local-pdf-scan",
    itemId: "library-item-scan",
    itemRevision: 1,
    catalogFingerprint: "absent",
    supportDir: ocrSupport,
    source: {
      kind: "pdf",
      storageMode: "managed",
      pdfPath: ocrPDFPath,
      expectedSha256: sha256(await readFile(ocrPDFPath)),
      title: "Scanned Source",
    },
  };
  const ocrRun = await runWorker(worker, temporary, ocrJob);
  const ocrManifest = JSON.parse(ocrRun.stdout);
  assert.equal(ocrManifest.state, "needs_attention");
  assert.equal(ocrManifest.extractionStatus, "needs_ocr");
  assert.equal(ocrManifest.paper.verificationStatus, "needs_ocr");
  assert.match(
    await readFile(path.join(ocrSupport, "Work", "LocalPipeline", ocrJob.jobId, "card.md"), "utf8"),
    /Do not complete this card from the filename or title alone/,
  );

  const linkedFixtureBase = await mkdtemp(path.join(root, ".linked-worker-test-"));
  t.after(() => rm(linkedFixtureBase, { recursive: true, force: true }));
  const linkedSupport = path.join(temporary, "Linked Support");
  const linkedRoot = path.join(linkedFixtureBase, "Linked Literature");
  const linkedRelative = path.join("topic", "linked-paper.pdf");
  const linkedPDFPath = path.join(linkedRoot, linkedRelative);
  const linkedPDF = minimalPDF([
    "1 Linked source",
    "We use a local linked source without duplicating the PDF bytes.",
    "We find that full text and routing outputs remain reproducible.",
  ].join("\n"));
  await mkdir(path.dirname(linkedPDFPath), { recursive: true });
  await mkdir(linkedSupport, { recursive: true });
  await writeFile(linkedPDFPath, linkedPDF);
  const linkedRootResolved = await realpath(linkedRoot);
  const linkedPDFResolved = path.join(linkedRootResolved, linkedRelative);
  const linkedJob = {
    schemaVersion: "liteverse-local-job-v1",
    operation: "materialize",
    jobId: "local-linked-one",
    itemId: "library-linked-one",
    itemRevision: 1,
    catalogFingerprint: "absent",
    supportDir: linkedSupport,
    source: {
      kind: "pdf",
      storageMode: "linked",
      pdfPath: linkedPDFResolved,
      linkedRootPath: linkedRootResolved,
      relativePath: linkedRelative,
      expectedSha256: sha256(linkedPDF),
      title: "Linked Local Literature",
    },
  };
  const linkedRun = await runWorker(worker, temporary, linkedJob);
  const linkedManifest = JSON.parse(linkedRun.stdout);
  const linkedResult = path.join(linkedSupport, "Work", "LocalPipeline", linkedJob.jobId);
  assert.equal(linkedManifest.state, "ready");
  assert.equal(linkedManifest.canonicalMetadata.storageMode, "linked");
  assert.equal(linkedManifest.paper.storageMode, "linked");
  assert.equal(linkedManifest.paper.pdfPath, linkedPDFResolved);
  assert.deepEqual(linkedManifest.outputs.map((entry) => entry.role).sort(), [
    "card",
    "fulltext",
    "review_packet",
  ]);
  assert.equal(await pathExists(path.join(linkedResult, "source.pdf")), false);
  assert.equal(Object.hasOwn(linkedManifest.suggestedDestinations, "source.pdf"), false);
  assert.match(await readFile(path.join(linkedResult, "card.md"), "utf8"), /source_storage_mode: "linked"/);
  assert.match(await readFile(path.join(linkedResult, "fulltext.md"), "utf8"), /source_pdf_path: ".*linked-paper\.pdf"/);

  const linkedOCRSupport = path.join(temporary, "Linked OCR Support");
  const linkedOCRRelative = path.join("topic", "scan.pdf");
  const linkedOCRPath = path.join(linkedRoot, linkedOCRRelative);
  const linkedOCRPDF = minimalPDF("");
  await mkdir(linkedOCRSupport, { recursive: true });
  await writeFile(linkedOCRPath, linkedOCRPDF);
  const linkedOCRRun = await runWorker(worker, temporary, {
    ...linkedJob,
    jobId: "local-linked-ocr",
    itemId: "library-linked-ocr",
    supportDir: linkedOCRSupport,
    source: {
      ...linkedJob.source,
      pdfPath: path.join(linkedRootResolved, linkedOCRRelative),
      relativePath: linkedOCRRelative,
      expectedSha256: sha256(linkedOCRPDF),
      title: "Linked Scan",
    },
  });
  const linkedOCRManifest = JSON.parse(linkedOCRRun.stdout);
  assert.equal(linkedOCRManifest.state, "needs_attention");
  assert.equal(linkedOCRManifest.extractionStatus, "needs_ocr");
  assert.equal(linkedOCRManifest.outputs.some((entry) => entry.role === "pdf" || entry.path === "source.pdf"), false);
  assert.equal(await pathExists(path.join(linkedOCRSupport, "Work", "LocalPipeline", "local-linked-ocr", "source.pdf")), false);

  await writeFile(linkedPDFPath, Buffer.concat([linkedPDF, Buffer.from("\nchanged\n")]));
  await assert.rejects(
    runWorker(worker, temporary, { ...linkedJob, jobId: "local-linked-changed" }),
    (error) => /linked PDF changed after folder registration/.test(error.stderr || ""),
  );

  const symlinkRoot = path.join(linkedFixtureBase, "Symlink Literature");
  const realTopic = path.join(linkedFixtureBase, "Real Topic");
  const symlinkPDF = path.join(realTopic, "paper.pdf");
  await mkdir(symlinkRoot, { recursive: true });
  await mkdir(realTopic, { recursive: true });
  await writeFile(symlinkPDF, linkedPDF);
  await symlink(realTopic, path.join(symlinkRoot, "topic"));
  const symlinkRootResolved = await realpath(symlinkRoot);
  await assert.rejects(
    runWorker(worker, temporary, {
      ...linkedJob,
      jobId: "local-linked-symlink",
      itemId: "library-linked-symlink",
      source: {
        ...linkedJob.source,
        pdfPath: path.join(symlinkRootResolved, "topic", "paper.pdf"),
        linkedRootPath: symlinkRootResolved,
        relativePath: path.join("topic", "paper.pdf"),
        expectedSha256: sha256(linkedPDF),
      },
    }),
    (error) => /may not traverse symbolic links/.test(error.stderr || ""),
  );
});
