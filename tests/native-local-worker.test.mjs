import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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

function minimalPDF(text) {
  const escapedLines = text.split("\n").map((line) => (
    line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")
  ));
  const textCommands = escapedLines.map((line, index) => `${index ? "T*\n" : ""}(${line}) Tj`).join("\n");
  const stream = `BT\n/F1 12 Tf\n14 TL\n72 720 Td\n${textCommands}\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
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
  assert.match(source, /source\.arxivId/);
  assert.match(source, /catalogFingerprint does not match/);
  assert.match(source, /PDFDocument\(url:/);
  assert.match(source, /<!-- page:/);
  assert.match(source, /liteverse-review-packet-v1/);
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
  const pdf = minimalPDF([
    "1 Introduction",
    "We use a numerical simulation method to compute the deterministic routing fixture.",
    "We find that the controlled fixture produces a stable extracted result.",
    "However, this approximation is limited to a synthetic test document.",
    "E = m c^2",
  ].join("\n"));
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
      pdfPath: inputPDF,
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
  assert.equal(reviewPacket.schemaVersion, "liteverse-review-packet-v1");
  assert.equal(reviewPacket.sourceSha256, sha256(pdf));
  assert.equal(reviewPacket.itemRevision, firstJob.itemRevision);
  assert.equal(reviewPacket.pageCount, 1);
  assert.equal(reviewPacket.extractionStatus, "extracted");
  assert.equal(reviewPacket.status, "provisional");
  assert.equal(reviewPacket.purpose, "routing_only");
  assert.ok(reviewPacket.sectionHeadingCandidates.length >= 1);
  assert.ok(reviewPacket.equationLikeLineCandidates.length >= 1);
  assert.ok(reviewPacket.sentenceCandidates.methods.length >= 1);
  assert.ok(reviewPacket.sentenceCandidates.results.length >= 1);
  assert.ok(reviewPacket.sentenceCandidates.limitations.length >= 1);
  assert.ok(reviewPacket.sectionHeadingCandidates.length <= 32);
  assert.ok(reviewPacket.equationLikeLineCandidates.length <= 24);
  assert.ok(reviewPacket.sentenceCandidates.methods.length <= 16);
  assert.ok(reviewPacket.sentenceCandidates.results.length <= 16);
  assert.ok(reviewPacket.sentenceCandidates.limitations.length <= 16);
  for (const candidate of [
    ...reviewPacket.sectionHeadingCandidates,
    ...reviewPacket.equationLikeLineCandidates,
    ...reviewPacket.sentenceCandidates.methods,
    ...reviewPacket.sentenceCandidates.results,
    ...reviewPacket.sentenceCandidates.limitations,
  ]) {
    assert.equal(candidate.page, 1);
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
    source: { kind: "pdf", pdfPath: ocrPDFPath, title: "Scanned Source" },
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
});
