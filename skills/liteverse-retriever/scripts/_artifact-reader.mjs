import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function managed(support, configured, fallback) {
  const resolved = path.resolve(path.isAbsolute(configured || fallback) ? (configured || fallback) : path.join(support, configured || fallback));
  const relative = path.relative(support, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`managed path escapes support directory: ${configured}`);
  return resolved;
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
  return { paper, integrity, cardPath, fulltextPath, card, fulltext: fulltextContent, claims: claimDocument };
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
