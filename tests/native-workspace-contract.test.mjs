import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);
const cli = path.join(root, "scripts", "liteverse-cli.mjs");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function writeBackupFixture(backupPath, options = {}) {
  const {
    paper = true,
    includesPDFs = false,
    omitFulltext = false,
    omitPDF = false,
    extraFile = false,
    extraSymlink = false,
  } = options;
  const workspace = path.join(backupPath, "Workspace");
  await mkdir(workspace, { recursive: true });
  const cardPath = "Knowledge/cards/paper-1.md";
  const fulltextPath = "Knowledge/fulltext/paper-1.md";
  const pdfPath = "Library/PDFs/paper-1.pdf";
  const pdfText = "%PDF fixture\n";
  const graph = {
    schemaVersion: "3.0.0",
    revision: 1,
    categories: paper ? [{ id: "macro", kind: "macro", name: "Macro" }] : [],
    papers: paper ? [{
      id: "paper-1",
      title: "Paper 1",
      primaryCategory: "macro",
      categoryIds: ["macro"],
      markdownPath: cardPath,
      fulltextPath,
      pdfPath,
      source: { kind: "pdf", pdfPath, sha256: sha256(pdfText) },
      artifacts: { cardPath, fulltextPath },
      useCount: 0,
    }] : [],
    relations: [],
  };
  const payloads = new Map([["Graph/current.json", `${JSON.stringify(graph, null, 2)}\n`]]);
  if (paper) {
    payloads.set(cardPath, "---\npaper_id: paper-1\n---\n\n# Paper 1\n");
    if (!omitFulltext) payloads.set(fulltextPath, "---\npaper_id: paper-1\n---\n\n<!-- page: 1 -->\n");
    if (includesPDFs && !omitPDF) payloads.set(pdfPath, pdfText);
  }
  for (const [relativePath, text] of payloads) {
    const destination = path.join(workspace, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, text, "utf8");
  }
  const files = [...payloads].map(([relativePath, text]) => ({
    path: relativePath,
    sha256: sha256(text),
    size: Buffer.byteLength(text),
  }));
  await writeFile(path.join(backupPath, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    format: "liteverse-workspace-backup",
    createdAt: "2026-07-14T00:00:00Z",
    includesPDFs,
    graphSchemaVersion: "3.0.0",
    graphRevision: 1,
    files,
  }, null, 2)}\n`, "utf8");
  if (extraFile) {
    const unlisted = path.join(workspace, "Knowledge/cards/unlisted.md");
    await mkdir(path.dirname(unlisted), { recursive: true });
    await writeFile(unlisted, "not in manifest\n", "utf8");
  }
  if (extraSymlink) {
    const link = path.join(workspace, "Knowledge/cards/unlisted-link.md");
    await symlink("paper-1.md", link);
  }
}

test("native workspace bridge keeps sources managed and reports honest artifact health", async () => {
  const source = await readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8");

  assert.match(source, /managedPDFRelativePathForSourceURL/);
  assert.match(source, /Library\/PDFs/);
  assert.match(source, /sha256ForFileAtURL/);
  assert.match(source, /managed PDF copy does not match the source SHA-256/);
  assert.match(source, /verificationStatus/);
  assert.match(source, /evidence_verified/);
  assert.match(source, /\[paper removeObjectForKey:@"verified"\]/);
  assert.match(source, /missingSourcePaperIds/);
  assert.match(source, /missingSourceHashPaperIds/);
  assert.match(source, /hashMismatchPaperIds/);
  assert.match(source, /sourceHashMatches/);
  assert.match(source, /\[self cachedSHA256ForFileAtURL:\[self URLForWorkspaceRelativePath:pdfPath error:nil\] error:nil\]/);
  assert.match(source, /evidence_verified[^\n]+&& !hasIntegrityIssue && evidenceCount > 0/);
  assert.match(source, /missingCardPaperIds/);
  assert.match(source, /missingFulltextPaperIds/);
  assert.match(source, /readAnnotationsWithError/);
  assert.match(source, /refused to overwrite it with an empty array/);
  assert.match(source, /projectDataForID/);
  assert.match(source, /mismatched revision or ledgerHash/);
  assert.match(source, /indexedClaimFromStatement/);
  assert.match(source, /@"evidence": evidence/);
  assert.match(source, /knowledge-card hash does not match the graph-pinned revision/);
  assert.match(source, /memoryItem\[@"computationArtifact"\]/);
  assert.match(source, /SQLITE_OPEN_READONLY \| SQLITE_OPEN_FULLMUTEX/);
  assert.match(source, /catalogSha256/);
  assert.match(source, /index does not match the Knowledge\/papers\.json revision/);
  assert.match(source, /PRAGMA quick_check\(1\)/);
  assert.match(source, /queryContractVersion/);
  assert.match(source, /aliasContractSha256/);
  assert.match(source, /SELECT \(SELECT COUNT\(\*\) FROM papers\), \(SELECT COUNT\(\*\) FROM claims\)/);
  assert.match(source, /sendLiteratureSearchError/);
  assert.match(source, /DISPATCH_AUTORELEASE_FREQUENCY_WORK_ITEM/);
  assert.doesNotMatch(source, /NSData \*catalogData = \[NSData dataWithContentsOfURL:\[self papersIndexURL\]/);
  assert.match(source, /orderedClaimPaperIDs/);
  assert.match(source, /papersByID\.count < \(NSUInteger\)limit/);
  assert.match(source, /stagedPapers:snapshot\[@"papers"\]/);
  assert.match(source, /updated\[@"displayTitle"\] = paper\[@"title"\]/);
  assert.match(source, /storedByPaperID/);
  assert.match(source, /mergedOrganizedItem/);
  assert.doesNotMatch(source, /fileURLWithPath:\[localPath stringByStandardizingPath\]/);
});

test("native partition proposal projection is observed, fail-closed, and backup-complete", async () => {
  const source = await readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8");

  assert.match(source, /partitionProposalsURL/);
  assert.match(source, /Graph\/partition-proposals\.json/);
  assert.match(source, /liteverse-partition-proposals-v1/);
  assert.match(source, /awaiting_user/);
  assert.match(source, /BOOL selected = \[status isEqualToString:@"selected"\]/);
  assert.match(source, /\(!awaitingUser && !selected\)/);
  assert.match(source, /options\.count != 3/);
  assert.match(source, /regions\.count > 10/);
  assert.match(source, /metricRegionCount\.integerValue != \(NSInteger\)regions\.count/);
  assert.match(source, /summedPaperCount != metricPaperCount\.unsignedIntegerValue/);
  assert.match(source, /assignedPaperIDs\.count != metricPaperCount\.unsignedIntegerValue/);
  assert.match(source, /partitionProposals:validatedProposals/);
  assert.match(source, /closeTruthUnderRoot:\[self applicationSupportURL\]/);
  assert.match(source, /selectedOptionId/);
  assert.match(source, /decisionRecordPath/);
  assert.match(source, /decisionRecordSha256/);
  assert.match(source, /selectedSnapshotPath/);
  assert.match(source, /selectedSnapshotSha256/);
  assert.match(source, /matchingDecisionCount != 1/);
  assert.match(source, /selected partition snapshot hash does not match/);
  assert.match(source, /validatedProposals\[@"status"\][\s\S]*isEqualToString:@"awaiting_user"[\s\S]*partitionProposals = validatedProposals/);
  assert.match(source, /sendWorkspaceErrorForAction:@"loadPartitionProposals"/);
  assert.match(source, /\[strongSelf sendPendingRefresh\]/);
  assert.match(source, /\[self sendWorkspaceWithNotice:nil\]/);
  assert.match(source, /\[path hasPrefix:@"Planning\/"\]/);
  assert.match(source, /partitionProposalsIncluded/);
  assert.match(source, /partitionDecisionCount/);
  assert.match(source, /partition projection in the backup is invalid/);
  assert.doesNotMatch(source, /applyPartitionProposal|selectPartitionProposal/);
});

test("native JSONL audit append uses one O_APPEND write for payload and newline", async () => {
  const source = await readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8");
  const appendMethod = source.match(/- \(void\)appendJSONObject:[\s\S]+?\n}\n\n- \(NSArray \*\)readAnnotations/)?.[0] || "";

  assert.match(appendMethod, /NSMutableData \*eventLine/);
  assert.match(appendMethod, /O_WRONLY \| O_CREAT \| O_APPEND/);
  assert.match(appendMethod, /appendData:\[@"\\n" dataUsingEncoding:NSUTF8StringEncoding\]/);
  assert.equal((appendMethod.match(/\bwrite\(/g) || []).length, 1);
  assert.doesNotMatch(appendMethod, /seekToEndOfFile|writeData:/);
});

test("native backup import is hash checked and cannot overwrite the active workspace", async () => {
  const source = await readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8");

  assert.match(source, /liteverse-workspace-backup/);
  assert.match(source, /validateBackupAtURL/);
  assert.match(source, /backup file hash does not match/);
  assert.match(source, /activeWorkspaceUntouched/);
  assert.match(source, /workspaceRecoveryDirectoryURL/);
  assert.match(source, /__liteverseWorkspaceExported/);
  assert.match(source, /__liteverseWorkspaceImported/);
  assert.match(source, /loadWorkspaceHealth/);
  assert.match(source, /Curator or Refresh is updating the workspace/);
  assert.match(source, /backupComponentSummaryForFiles/);
  assert.match(source, /backup does not close over the knowledge-card or full-text files for paper %@/);
  assert.match(source, /backup Workspace contains a file not listed in the manifest/);
  assert.match(source, /backup Workspace contains a forbidden symbolic link/);
  assert.match(source, /copyVerifiedBackupManifest/);
  assert.match(source, /\[path hasPrefix:@"Projects\/"\]/);
  assert.match(source, /searchIndexExcluded/);
  assert.match(source, /containsObject:@"Cache"/);
  assert.match(source, /containsObject:@"Index"/);
  assert.doesNotMatch(source, /copyItemAtURL:sourceWorkspace toURL:recoveredWorkspace/);
});

test("native backup validator enforces graph artifact closure and exact Workspace contents", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "liteverse-native-backup-test-"));
  const validator = path.join(temporary, "native-backup-validator");
  try {
    await execFileAsync("/usr/bin/clang", [
      "-fobjc-arc",
      "-mmacosx-version-min=13.0",
      "-framework", "Cocoa",
      "-framework", "UniformTypeIdentifiers",
      "-framework", "WebKit",
      "-lsqlite3",
      path.join(root, "tests", "native-backup-validator.m"),
      "-o", validator,
    ]);

    const searchSupport = path.join(temporary, "search-support");
    const searchPDF = "%PDF-1.4\nLiteverse native search fixture\n%%EOF\n";
    const searchSourceSha = sha256(searchPDF);
    const searchCard = `---
paper_id: "native-search-paper"
title: "Adaptive Sampling Native Search"
authors: ["Liteverse Test"]
source_sha256: "${searchSourceSha}"
verification_status: "evidence_verified"
tags: ["adaptive sampling", "calibration"]
---

# Adaptive Sampling Native Search

## Research question

- How does adaptive sampling improve calibration? [E1]

## Methods

- Uncertainty-guided numerical sampling. [E1]

## Main results

- The fixture remains deterministic. [E1]

## Limitations

- Test-only evidence. [E1]

## Evidence index

- E1 — PDF p. 1, Sec. I — Deterministic source evidence.
`;
    const searchFulltext = `---\npaper_id: "native-search-paper"\nsource_sha256: "${searchSourceSha}"\n---\n\n<!-- page: 1 -->\n\nDeterministic source evidence.\n`;
    const searchPaper = {
      id: "native-search-paper",
      title: "Adaptive Sampling Native Search",
      primaryCategory: "macro",
      categoryIds: ["macro"],
      verificationStatus: "evidence_verified",
      source: { kind: "pdf", pdfPath: "Library/PDFs/native-search-paper.pdf", sha256: searchSourceSha },
      markdownPath: "Knowledge/cards/native-search-paper.md",
      fulltextPath: "Knowledge/fulltext/native-search-paper.md",
      artifacts: {
        cardPath: "Knowledge/cards/native-search-paper.md",
        fulltextPath: "Knowledge/fulltext/native-search-paper.md",
        evidenceCount: 1,
      },
    };
    const searchFiles = new Map([
      ["Library/PDFs/native-search-paper.pdf", searchPDF],
      ["Knowledge/cards/native-search-paper.md", searchCard],
      ["Knowledge/fulltext/native-search-paper.md", searchFulltext],
      ["Graph/current.json", `${JSON.stringify({ schemaVersion: "3.0.0", revision: 1, categories: [{ id: "macro", kind: "macro", name: "Macro" }], papers: [searchPaper], relations: [] }, null, 2)}\n`],
      ["Knowledge/papers.json", `${JSON.stringify({ schemaVersion: 2, revision: 1, papers: [{ paperId: searchPaper.id, ...searchPaper }] }, null, 2)}\n`],
    ]);
    for (const [relativePath, contents] of searchFiles) {
      const destination = path.join(searchSupport, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, contents, "utf8");
    }
    await execFileAsync(process.execPath, [cli, "doctor", "--fix", "--json", "--support-dir", searchSupport]);
    await execFileAsync(process.execPath, [cli, "index", "rebuild", "--json", "--support-dir", searchSupport]);
    const nativeSearch = JSON.parse((await execFileAsync(validator, ["search", searchSupport, "adaptive sampling"])).stdout);
    const cliSearch = JSON.parse((await execFileAsync(process.execPath, [cli, "search", "--query", "adaptive sampling", "--limit", "10", "--json", "--support-dir", searchSupport])).stdout);
    assert.deepEqual(
      nativeSearch.results.map((item) => item.paperId),
      cliSearch.results.map((item) => item.paperId),
    );
    const repairedIndex = JSON.parse(await readFile(path.join(searchSupport, "Knowledge", "papers.json"), "utf8"));
    const immutableClaims = repairedIndex.papers[0].artifact.immutableClaimsPath;
    await writeFile(path.join(searchSupport, immutableClaims), "tampered claims\n", "utf8");
    await assert.rejects(
      execFileAsync(validator, ["search", searchSupport, "adaptive"]),
      /mismatched claims artifact hash/,
    );

    const partitionSupport = path.join(temporary, "partition-support");
    const proposalSetId = "native-selected-proposal";
    const truthPath = `Planning/partition-proposals/${proposalSetId}.json`;
    const truthText = `${JSON.stringify({ schemaVersion: "liteverse-partition-proposal-v1", proposalSetId }, null, 2)}\n`;
    const truthSha256 = sha256(truthText);
    const decisionId = "partition-decision-native-test";
    const selectedOptionId = "option-b";
    const decisionRecordPath = "Planning/partition-decisions.jsonl";
    const decisionRecord = {
      schemaVersion: "liteverse-partition-decision-v1",
      kind: "partition_decision",
      decisionId,
      proposalSetId,
      optionId: selectedOptionId,
      baseRevision: 1,
      proposalTruthPath: truthPath,
      proposalSha256: truthSha256,
    };
    const decisionRecordText = `${JSON.stringify(decisionRecord)}\n`;
    const decisionRecordSha256 = sha256(decisionRecordText);
    const selectedSnapshotPath = `Planning/partition-snapshots/${decisionId}.json`;
    const selectedSnapshot = {
      schemaVersion: "3.0.0",
      revision: 2,
      categories: [],
      papers: [],
      relations: [],
      partitionDecision: {
        decisionId,
        proposalSetId,
        optionId: selectedOptionId,
        baseRevision: 1,
        decisionRecordPath,
        recordSha256: decisionRecordSha256,
      },
    };
    const selectedSnapshotText = `${JSON.stringify(selectedSnapshot, null, 2)}\n`;
    const partitionOption = (optionId) => ({
      optionId,
      name: `Native ${optionId}`,
      summary: `Deterministic ${optionId} partition.`,
      tradeoffs: { strengths: ["broad"], limitations: ["test fixture"] },
      regions: [{ id: `${optionId}-region`, name: `${optionId} region`, paperCount: 1 }],
      assignments: [{ paperId: "paper-1", primaryCategory: `${optionId}-region` }],
      metrics: { paperCount: 1, regionCount: 1, minRegionSize: 1, maxRegionSize: 1 },
    });
    const selectedProjection = {
      schemaVersion: "liteverse-partition-proposals-v1",
      status: "selected",
      proposalSetId,
      baseRevision: 1,
      artifactFingerprint: "a".repeat(64),
      searchSummary: "Native selected lifecycle fixture.",
      truthPath,
      truthSha256,
      options: [partitionOption("option-a"), partitionOption(selectedOptionId), partitionOption("option-c")],
      selectedOptionId,
      decisionId,
      decisionRecordPath,
      decisionRecordSha256,
      selectedSnapshotPath,
      selectedSnapshotSha256: sha256(selectedSnapshotText),
    };
    const partitionFiles = new Map([
      [truthPath, truthText],
      [decisionRecordPath, decisionRecordText],
      [selectedSnapshotPath, selectedSnapshotText],
      ["Graph/partition-proposals.json", `${JSON.stringify(selectedProjection, null, 2)}\n`],
    ]);
    for (const [relativePath, contents] of partitionFiles) {
      const destination = path.join(partitionSupport, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, contents, "utf8");
    }
    const selectedLifecycle = JSON.parse(
      (await execFileAsync(validator, ["partition", partitionSupport])).stdout,
    );
    assert.deepEqual(selectedLifecycle, { status: "selected", pending: false });

    const awaitingProjection = { ...selectedProjection, status: "awaiting_user" };
    for (const field of [
      "selectedOptionId",
      "decisionId",
      "decisionRecordPath",
      "decisionRecordSha256",
      "selectedSnapshotPath",
      "selectedSnapshotSha256",
    ]) delete awaitingProjection[field];
    await writeFile(
      path.join(partitionSupport, "Graph/partition-proposals.json"),
      `${JSON.stringify(awaitingProjection, null, 2)}\n`,
      "utf8",
    );
    const awaitingLifecycle = JSON.parse(
      (await execFileAsync(validator, ["partition", partitionSupport])).stdout,
    );
    assert.deepEqual(awaitingLifecycle, { status: "awaiting_user", pending: true });

    await writeFile(
      path.join(partitionSupport, "Graph/partition-proposals.json"),
      `${JSON.stringify({ ...selectedProjection, decisionRecordSha256: "b".repeat(64) }, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      execFileAsync(validator, ["partition", partitionSupport]),
      /decision record is missing, duplicated, hash-mismatched, or pointer-inconsistent/,
    );

    const empty = path.join(temporary, "empty.liteverse-backup");
    await writeBackupFixture(empty, { paper: false });
    await execFileAsync(validator, [empty]);

    const withoutPDFs = path.join(temporary, "without-pdfs.liteverse-backup");
    await writeBackupFixture(withoutPDFs);
    await execFileAsync(validator, [withoutPDFs]);

    const withPDFs = path.join(temporary, "with-pdfs.liteverse-backup");
    await writeBackupFixture(withPDFs, { includesPDFs: true });
    await execFileAsync(validator, [withPDFs]);

    const tampered = path.join(temporary, "tampered.liteverse-backup");
    await writeBackupFixture(tampered);
    await writeFile(path.join(tampered, "Workspace", "Knowledge/cards/paper-1.md"), "tampered\n", "utf8");
    await assert.rejects(execFileAsync(validator, [tampered]), /hash does not match/);

    const missingFulltext = path.join(temporary, "missing-fulltext.liteverse-backup");
    await writeBackupFixture(missingFulltext, { omitFulltext: true });
    await assert.rejects(execFileAsync(validator, [missingFulltext]), /knowledge-card or full-text files/);

    const missingPDF = path.join(temporary, "missing-pdf.liteverse-backup");
    await writeBackupFixture(missingPDF, { includesPDFs: true, omitPDF: true });
    await assert.rejects(execFileAsync(validator, [missingPDF]), /does not close over the managed PDF for paper/);

    const unlisted = path.join(temporary, "unlisted.liteverse-backup");
    await writeBackupFixture(unlisted, { extraFile: true });
    await assert.rejects(execFileAsync(validator, [unlisted]), /file not listed in the manifest/);

    const symlinked = path.join(temporary, "symlinked.liteverse-backup");
    await writeBackupFixture(symlinked, { extraSymlink: true });
    await assert.rejects(execFileAsync(validator, [symlinked]), /forbidden symbolic link/);

    const recoverySupport = path.join(temporary, "recovery-support");
    const imported = await execFileAsync(validator, ["import", withoutPDFs, recoverySupport]);
    const recoveredWorkspace = path.join(imported.stdout.trim(), "Workspace");
    const recoveredEntries = await readdir(recoveredWorkspace, { recursive: true });
    const recoveredFiles = [];
    for (const relativePath of recoveredEntries) {
      if ((await stat(path.join(recoveredWorkspace, relativePath))).isFile()) recoveredFiles.push(relativePath);
    }
    assert.deepEqual(recoveredFiles.sort(), [
      "Graph/current.json",
      "Knowledge/cards/paper-1.md",
      "Knowledge/fulltext/paper-1.md",
    ]);

    const exportSupport = path.join(temporary, "export-support");
    const exportGraph = {
      schemaVersion: "3.0.0",
      revision: 1,
      categories: [],
      papers: [],
      relations: [],
    };
    await mkdir(path.join(exportSupport, "Graph"), { recursive: true });
    await writeFile(path.join(exportSupport, "Graph/current.json"), `${JSON.stringify(exportGraph)}\n`, "utf8");
    const stageLock = path.join(exportSupport, ".locks/stage-refresh.lock");
    await mkdir(stageLock, { recursive: true });
    const blockedDestination = path.join(temporary, "blocked-export.liteverse-backup");
    await assert.rejects(
      execFileAsync(validator, ["export", exportSupport, blockedDestination, "0"]),
      /Curator or Refresh is updating the workspace/,
    );
    await rm(stageLock, { recursive: true, force: true });
    const existingDestination = path.join(temporary, "existing-export.liteverse-backup");
    await mkdir(existingDestination);
    await assert.rejects(
      execFileAsync(validator, ["export", exportSupport, existingDestination, "0"]),
      /backup destination already exists/,
    );
    await assert.rejects(access(stageLock));
    const exportedDestination = path.join(temporary, "exported.liteverse-backup");
    await execFileAsync(validator, ["export", exportSupport, exportedDestination, "0"]);
    await assert.rejects(access(stageLock));
    const exportedManifest = JSON.parse(await readFile(path.join(exportedDestination, "manifest.json"), "utf8"));
    assert.equal(exportedManifest.componentSummary.graph.currentIncluded, true);
    assert.equal(exportedManifest.componentSummary.managedPDFs.fileCount, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("public desktop package starts from an empty schema-v3 graph", async () => {
  const [buildScript, emptyGraph] = await Promise.all([
    readFile(path.join(root, "scripts", "build-macos-app.sh"), "utf8"),
    readFile(path.join(root, "data", "empty-universe.json"), "utf8").then(JSON.parse),
  ]);

  assert.equal(emptyGraph.schemaVersion, "3.0.0");
  assert.deepEqual(emptyGraph.papers, []);
  assert.deepEqual(emptyGraph.relations, []);
  assert.match(buildScript, /data\/empty-universe\.json/);
  assert.doesNotMatch(buildScript, /\/usr\/bin\/ditto "\$ROOT\/data\/papers"/);
});
