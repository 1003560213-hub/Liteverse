import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  artifactFields,
  atomicWriteJson,
  exists,
  parseCard,
  readJson,
  resolveManagedPath,
  resolveSourcePdfPath,
  sha256File,
  sha256Text,
  snapshotPaperArtifact,
  validateLinkedSourcePath,
} from "./liteverse-core.mjs";
import { ensureSearchIndex, rebuildSearchIndex } from "./liteverse-search.mjs";
import { inspectGalaxyHierarchy } from "./liteverse-galaxy-hierarchy.mjs";

function finding(severity, code, message, details = undefined) {
  return { severity, code, message, ...(details === undefined ? {} : { details }) };
}

function statusOfCard(card) {
  return card.verificationStatus ?? "card_draft";
}

async function inspect(support, { deep = true } = {}) {
  const findings = [];
  const graphPath = path.join(support, "Graph", "current.json");
  const indexPath = path.join(support, "Knowledge", "papers.json");
  const graph = await readJson(graphPath);
  const index = await readJson(indexPath);
  if (!Array.isArray(graph?.papers)) throw new Error(`Graph/current.json has no papers array: ${graphPath}`);
  if (!Array.isArray(index?.papers)) throw new Error(`Knowledge/papers.json has no papers array: ${indexPath}`);
  const galaxyHierarchy = inspectGalaxyHierarchy(graph);
  if (!galaxyHierarchy.present && graph.papers.length) {
    findings.push(finding(
      "warning",
      "hierarchy.missing",
      "Graph/current.json has no deterministic galaxy hierarchy; the next Curator Refresh will add it",
    ));
  } else {
    for (const item of galaxyHierarchy.issues) {
      findings.push(finding("error", item.code, item.message, item.details));
    }
  }
  const graphById = new Map(graph.papers.map((paper) => [paper.id, paper]));
  const indexById = new Map(index.papers.map((paper) => [paper.paperId, paper]));
  const records = [];
  for (const graphPaper of graph.papers) {
    const paperId = graphPaper.id;
    const indexed = indexById.get(paperId);
    if (!indexed) {
      findings.push(finding("error", "index.paper_missing", `${paperId} exists in Graph/current.json but not Knowledge/papers.json`));
      continue;
    }
    const cardPath = resolveManagedPath(support, indexed.cardPath ?? graphPaper.markdownPath, `Knowledge/cards/${paperId}.md`);
    const fulltextPath = resolveManagedPath(support, indexed.fulltextPath ?? graphPaper.fulltextPath, `Knowledge/fulltext/${paperId}.md`);
    const indexedSource = resolveSourcePdfPath(support, indexed, `Library/PDFs/${paperId}.pdf`);
    const graphSource = resolveSourcePdfPath(support, graphPaper, `Library/PDFs/${paperId}.pdf`);
    if (
      indexedSource.storageMode !== graphSource.storageMode
      || indexedSource.sourcePath !== graphSource.sourcePath
      || indexedSource.linkedRootPath !== graphSource.linkedRootPath
      || indexedSource.relativePath !== graphSource.relativePath
    ) {
      findings.push(finding(
        "error",
        "source.reference_drift",
        `${paperId}: Knowledge/papers.json and Graph/current.json reference different source PDFs`,
        { indexed: indexedSource, graph: graphSource },
      ));
    }
    const { pdfPath, storageMode, sourcePath } = indexedSource;
    let cardText;
    let fulltextText;
    try {
      [cardText, fulltextText] = await Promise.all([readFile(cardPath, "utf8"), readFile(fulltextPath, "utf8")]);
    } catch (error) {
      findings.push(finding("error", "artifact.file_missing", `${paperId}: ${error.message}`));
      continue;
    }
    const card = parseCard(cardText, paperId);
    const cardStatus = statusOfCard(card);
    const cardStorageMode = card.metadata.source_storage_mode ?? "managed";
    const cardSourcePath = card.metadata.source_pdf_path ?? (cardStorageMode === "managed" ? sourcePath : null);
    if (cardStorageMode !== storageMode || cardSourcePath !== sourcePath) {
      findings.push(finding(
        "error",
        "source.card_reference_drift",
        `${paperId}: card source reference does not match the indexed ${storageMode} PDF`,
        { cardStorageMode, cardSourcePath, indexedStorageMode: storageMode, indexedSourcePath: sourcePath },
      ));
    }
    if (indexed.verificationStatus !== cardStatus) {
      findings.push(finding("warning", "projection.verification_status_drift", `${paperId}: papers.json=${indexed.verificationStatus ?? "<missing>"}, card=${cardStatus}`));
    }
    if (graphPaper.verificationStatus !== cardStatus) {
      findings.push(finding("error", "graph.verification_status_drift", `${paperId}: Graph/current.json=${graphPaper.verificationStatus ?? "<missing>"}, card=${cardStatus}`));
    }
    const expectedSource = indexed.source?.sha256 ?? indexed.sha256 ?? graphPaper.source?.sha256 ?? card.sourceSha256;
    let actualSource = expectedSource;
    let sourceAvailable = false;
    if (storageMode === "linked") {
      try {
        await validateLinkedSourcePath(indexedSource);
        sourceAvailable = true;
      } catch (error) {
        actualSource = null;
        findings.push(finding(
          "error",
          error.code === "ENOENT" ? "source.linked_missing" : "source.linked_unsafe",
          `${paperId}: linked source PDF cannot be trusted at ${pdfPath}: ${error.message}`,
          { storageMode, sourcePath },
        ));
      }
    } else {
      sourceAvailable = await exists(pdfPath);
    }
    if (!sourceAvailable) {
      actualSource = null;
      if (storageMode !== "linked") {
        findings.push(finding(
          "error",
          "source.managed_missing",
          `${paperId}: managed source PDF is missing at ${pdfPath}`,
          { storageMode, sourcePath },
        ));
      }
    } else if (deep) {
      try {
        actualSource = await sha256File(pdfPath);
      } catch (error) {
        findings.push(finding("error", "source.unreadable", `${paperId}: ${error.message}`));
      }
      if (expectedSource && actualSource !== expectedSource) {
        findings.push(finding("error", "source.hash_mismatch", `${paperId}: canonical PDF SHA-256 does not match metadata`));
      }
    }
    const artifact = indexed.artifact ?? indexed.artifacts?.integrity;
    if (!artifact) {
      findings.push(finding("warning", "artifact.unpinned", `${paperId}: papers.json has no artifact revision/hash lock`));
    } else {
      if (artifact.cardSha256 !== sha256Text(cardText)) findings.push(finding("error", "artifact.card_hash_mismatch", `${paperId}: card changed after artifact pin`));
      if (artifact.fulltextSha256 !== sha256Text(fulltextText)) findings.push(finding("error", "artifact.fulltext_hash_mismatch", `${paperId}: full text changed after artifact pin`));
      if (artifact.sourceSha256 !== expectedSource) findings.push(finding("error", "artifact.source_revision_conflict", `${paperId}: artifact source hash conflicts with paper source hash`));
      const claimsPath = path.join(support, "Knowledge", "claims", `${paperId}.json`);
      try {
        const claimsText = await readFile(claimsPath, "utf8");
        const claims = JSON.parse(claimsText);
        if (sha256Text(claimsText) !== artifact.claimsSha256) findings.push(finding("error", "artifact.claims_hash_mismatch", `${paperId}: claims changed after artifact pin`));
        if (claims.artifactRevision !== artifact.artifactRevision || claims.artifactSha256 !== artifact.artifactSha256) {
          findings.push(finding("error", "artifact.claims_revision_conflict", `${paperId}: claims point to a different artifact revision`));
        }
      } catch (error) {
        findings.push(finding("error", "artifact.claims_unreadable", `${paperId}: ${error.message}`));
      }
    }
    if (!graphPaper.artifacts?.integrity?.artifactRevision) {
      // Graph/current is immutable. This is resolved by the next Curator staged refresh.
      records.push({ graphUnpinned: true });
    }
    records.push({
      paperId,
      indexed,
      graphPaper,
      card,
      cardText,
      fulltextText,
      pdfPath,
      storageMode,
      sourcePath,
      expectedSource,
      actualSource,
    });
  }
  const orphans = index.papers.filter((paper) => !graphById.has(paper.paperId)).map((paper) => paper.paperId);
  if (orphans.length) findings.push(finding("warning", "projection.orphan_papers", `${orphans.length} indexed papers are not in Graph/current.json`, orphans));
  const unpinnedCount = graph.papers.filter((paper) => !paper.artifacts?.integrity?.artifactRevision).length;
  if (unpinnedCount) {
    findings.push(finding("warning", "graph.artifacts_unpinned", `${unpinnedCount} graph papers need artifact revision locks in the next Curator staged Refresh`));
  }
  return {
    graph,
    index,
    graphPath,
    indexPath,
    records: records.filter((record) => record.paperId),
    galaxyHierarchy,
    findings,
  };
}

function summarize(findings) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const item of findings) counts[item.severity] = (counts[item.severity] ?? 0) + 1;
  return counts;
}

export async function doctorLiteverse(support, { fix = false, deep = true, rebuildIndex = true } = {}) {
  const before = await inspect(support, { deep });
  let updatedPapers = 0;
  let artifactRevisionsCreated = 0;
  let search = null;
  if (fix) {
    const fatal = before.findings.filter((item) => item.severity === "error" && !item.code.startsWith("artifact.claims_") && !item.code.startsWith("artifact.card_") && !item.code.startsWith("artifact.fulltext_") && !item.code.startsWith("artifact.source_revision_"));
    if (fatal.length) {
      const codes = [...new Set(fatal.map((item) => item.code))].join(", ");
      throw new Error(`doctor refuses repair while source/graph errors remain: ${codes}`);
    }
    const papers = [];
    for (const indexed of before.index.papers) {
      const record = before.records.find((item) => item.paperId === indexed.paperId);
      if (!record) {
        papers.push(indexed);
        continue;
      }
      const artifact = await snapshotPaperArtifact(support, indexed, { verifyPdf: deep });
      if (artifact.changed) artifactRevisionsCreated += 1;
      const next = {
        ...indexed,
        verificationStatus: record.card.verificationStatus,
        metadataStatus: record.card.metadata.metadata_status ?? indexed.metadataStatus,
        cardSchemaVersion: record.card.metadata.card_schema_version ?? indexed.cardSchemaVersion ?? "liteverse-card-v1",
        evidenceCount: record.card.evidence.size,
        artifacts: {
          ...(indexed.artifacts ?? {}),
          integrity: artifactFields(artifact),
        },
        artifact: artifactFields(artifact),
      };
      if (JSON.stringify(next) !== JSON.stringify(indexed)) updatedPapers += 1;
      papers.push(next);
    }
    const projectionNeedsWrite = updatedPapers > 0
      || Number(before.index.schemaVersion) < 3
      || !Number.isInteger(before.index.revision);
    const nextIndex = {
      ...before.index,
      schemaVersion: Math.max(Number(before.index.schemaVersion) || 0, 3),
      revision: projectionNeedsWrite ? (Number(before.index.revision) || 0) + 1 : before.index.revision,
      generatedAt: projectionNeedsWrite ? new Date().toISOString() : before.index.generatedAt,
      papers,
    };
    if (projectionNeedsWrite) await atomicWriteJson(before.indexPath, nextIndex);
    if (rebuildIndex) search = projectionNeedsWrite
      ? await rebuildSearchIndex(support)
      : await ensureSearchIndex(support);
  }
  const after = fix ? await inspect(support, { deep: false }) : before;
  return {
    schemaVersion: "liteverse-doctor-v1",
    support,
    status: summarize(after.findings).error ? "error" : summarize(after.findings).warning ? "warning" : "healthy",
    graphRevision: after.graph.revision ?? null,
    paperCount: after.graph.papers.length,
    galaxyCount: after.galaxyHierarchy.galaxyCount,
    hierarchyPresent: after.galaxyHierarchy.present,
    fixed: fix,
    updatedPapers,
    artifactRevisionsCreated,
    searchIndex: search,
    counts: summarize(after.findings),
    findings: after.findings,
  };
}
