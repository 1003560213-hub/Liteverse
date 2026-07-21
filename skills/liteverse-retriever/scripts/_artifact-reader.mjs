import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function sha256File(filePath) {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function managed(support, configured, fallback) {
  const resolved = path.resolve(path.isAbsolute(configured || fallback) ? (configured || fallback) : path.join(support, configured || fallback));
  const relative = path.relative(support, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`managed path escapes support directory: ${configured}`);
  return resolved;
}

async function verifiedSource(support, paperId, paper, integrity) {
  const storageMode = paper?.source?.storageMode ?? paper?.storageMode ?? "managed";
  if (storageMode !== "managed" && storageMode !== "linked") {
    throw new Error(`paper ${paperId} has an invalid source storage mode; usage was not counted`);
  }
  let pdfPath;
  if (storageMode === "linked") {
    pdfPath = paper?.source?.pdfPath ?? paper?.pdfPath;
    const linkedRootPath = paper?.source?.linkedRootPath ?? paper?.linkedRootPath;
    const relativePath = paper?.source?.relativePath ?? paper?.relativePath;
    if (
      typeof pdfPath !== "string" || !path.isAbsolute(pdfPath) || path.resolve(pdfPath) !== pdfPath
      || typeof linkedRootPath !== "string" || !path.isAbsolute(linkedRootPath) || path.resolve(linkedRootPath) !== linkedRootPath
      || typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)
    ) {
      throw new Error(`paper ${paperId} has an unsafe linked source descriptor; usage was not counted`);
    }
    const parts = relativePath.split(/[\\/]+/);
    if (parts.some((part) => !part || part === "." || part === "..")
        || path.resolve(linkedRootPath, ...parts) !== pdfPath) {
      throw new Error(`paper ${paperId} linked source escapes its registered root; usage was not counted`);
    }
    const rootInfo = await lstat(linkedRootPath);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error(`paper ${paperId} linked root is not a real directory; usage was not counted`);
    }
    let cursor = linkedRootPath;
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      const info = await lstat(cursor);
      const final = index === parts.length - 1;
      if (info.isSymbolicLink() || (final ? !info.isFile() : !info.isDirectory())) {
        throw new Error(`paper ${paperId} linked source path is unsafe; usage was not counted`);
      }
    }
    const [realRoot, realPdf] = await Promise.all([realpath(linkedRootPath), realpath(pdfPath)]);
    if (realRoot !== linkedRootPath || realPdf !== pdfPath || !realPdf.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`paper ${paperId} linked source traverses a symbolic link; usage was not counted`);
    }
    if ((integrity?.sourceStorageMode ?? "managed") !== "linked" || integrity?.sourcePath !== pdfPath) {
      throw new Error(`paper ${paperId} linked source revision conflicts with its artifact; usage was not counted`);
    }
  } else {
    pdfPath = managed(support, paper?.source?.pdfPath ?? paper?.pdfPath, `Library/PDFs/${paperId}.pdf`);
    if ((integrity?.sourceStorageMode ?? "managed") !== "managed") {
      throw new Error(`paper ${paperId} source storage mode conflicts with its artifact; usage was not counted`);
    }
  }
  const expected = paper?.source?.sha256 ?? paper?.sha256 ?? integrity?.sourceSha256;
  if (!SHA256.test(expected ?? "") || (integrity?.sourceSha256 && integrity.sourceSha256 !== expected)) {
    throw new Error(`paper ${paperId} has no consistent source SHA-256; usage was not counted`);
  }
  if (await sha256File(pdfPath) !== expected) {
    throw new Error(`source PDF hash mismatch for ${paperId}; usage was not counted`);
  }
  return { storageMode, pdfPath, sourceSha256: expected };
}

async function optionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`invalid ${filePath}: ${error.message}`);
  }
}

export async function indexedPaper(support, paperId) {
  const index = await optionalJson(path.join(support, "Knowledge", "papers.json"));
  const paper = index?.papers?.find((item) => item.paperId === paperId) ?? null;
  return { index, paper };
}

export async function readVerifiedArtifact(support, paperId, { fulltext = false, claims = false } = {}) {
  const { index, paper } = await indexedPaper(support, paperId);
  const cardPath = managed(support, paper?.cardPath ?? paper?.artifacts?.cardPath, `Knowledge/cards/${paperId}.md`);
  const fulltextPath = managed(support, paper?.fulltextPath ?? paper?.artifacts?.fulltextPath, `Knowledge/fulltext/${paperId}.md`);
  const card = await readFile(cardPath, "utf8");
  const integrity = paper?.artifact ?? paper?.artifacts?.integrity;
  // A missing index is retained only for isolated legacy tests. A managed index must be pinned.
  if (index && (!integrity || !Number.isInteger(integrity.artifactRevision) || !SHA256.test(integrity.artifactSha256 ?? ""))) {
    throw new Error(`paper ${paperId} has no pinned artifact revision; run liteverse doctor --fix before adoption`);
  }
  let source = null;
  if (index) {
    try {
      source = await verifiedSource(support, paperId, paper, integrity);
    } catch (error) {
      if (error.message?.includes("usage was not counted")) throw error;
      throw new Error(`source verification failed for ${paperId}: ${error.message}; usage was not counted`);
    }
  }
  if (integrity?.cardSha256 && sha256(card) !== integrity.cardSha256) {
    throw new Error(`knowledge card hash mismatch for ${paperId}; usage was not counted`);
  }
  let fulltextContent = null;
  if (fulltext) {
    fulltextContent = await readFile(fulltextPath, "utf8");
    if (integrity?.fulltextSha256 && sha256(fulltextContent) !== integrity.fulltextSha256) {
      throw new Error(`full-text hash mismatch for ${paperId}; usage was not counted`);
    }
  }
  let claimDocument = null;
  if (claims) {
    const claimsPath = managed(support, `Knowledge/claims/${paperId}.json`, `Knowledge/claims/${paperId}.json`);
    const claimsText = await readFile(claimsPath, "utf8");
    if (integrity?.claimsSha256 && sha256(claimsText) !== integrity.claimsSha256) {
      throw new Error(`claims hash mismatch for ${paperId}; usage was not counted`);
    }
    claimDocument = JSON.parse(claimsText);
    if (integrity && (claimDocument.artifactRevision !== integrity.artifactRevision || claimDocument.artifactSha256 !== integrity.artifactSha256)) {
      throw new Error(`claims artifact revision conflict for ${paperId}; usage was not counted`);
    }
  }
  return { paper, integrity, source, cardPath, fulltextPath, card, fulltext: fulltextContent, claims: claimDocument };
}

function slug(value) {
  return value.normalize("NFKD").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
}

export function selectSections(card, selectors) {
  if (!selectors.length) return card;
  const frontmatter = card.match(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/)?.[0] ?? "";
  const body = card.slice(frontmatter.length);
  const title = body.match(/^#\s+.+$/m)?.[0] ?? "";
  const wanted = new Set(selectors.map(slug));
  const sections = [...body.matchAll(/^##\s+(.+?)\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm)]
    .filter((match) => wanted.has(slug(match[1])))
    .map((match) => `## ${match[1]}${match[2]}`.trim());
  if (!sections.length) throw new Error(`none of the requested sections exist: ${selectors.join(", ")}`);
  return `${frontmatter}${title}\n\n${sections.join("\n\n")}\n`;
}

export function selectPages(fulltext, selectors) {
  if (!selectors.length) return fulltext;
  const wanted = new Set();
  for (const selector of selectors) {
    const match = selector.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error(`invalid page selector: ${selector}`);
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end - start > 100) throw new Error(`invalid page range: ${selector}`);
    for (let value = start; value <= end; value += 1) wanted.add(value);
  }
  return fulltext.split(/(?=<!-- page:\s*\d+\s*-->)/g).filter((part) => wanted.has(Number(part.match(/^<!-- page:\s*(\d+)\s*-->/)?.[1]))).join("\n").trim();
}

export function selectedClaims(document, claimIds, evidenceIds) {
  if (!document) return [];
  const wantedClaims = new Set(claimIds);
  const wantedEvidence = new Set(evidenceIds);
  if (!wantedClaims.size && !wantedEvidence.size) return [];
  const claims = (document.claims ?? []).filter((claim) =>
    wantedClaims.has(claim.claimId) || (claim.evidenceIds ?? []).some((id) => wantedEvidence.has(id))
  );
  const missingClaims = [...wantedClaims].filter((id) => !claims.some((claim) => claim.claimId === id));
  const foundEvidence = new Set(claims.flatMap((claim) => claim.evidenceIds ?? []));
  const missingEvidence = [...wantedEvidence].filter((id) => !foundEvidence.has(id));
  if (missingClaims.length || missingEvidence.length) {
    throw new Error(`unknown claim/evidence selectors: ${[...missingClaims, ...missingEvidence].join(", ")}`);
  }
  return claims;
}

export function bounded(text, maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("--max-chars must be a positive integer");
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars - 22)).trimEnd()}\n\n[Liteverse truncated]`, truncated: true };
}
