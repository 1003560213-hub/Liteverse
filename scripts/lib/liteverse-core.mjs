import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

export const PAPER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const VERIFIED_STATUSES = new Set(["evidence_verified", "needs_attention"]);

export function resolveSupport(explicit) {
  return path.resolve(
    explicit
      ?? process.env.LITEVERSE_SUPPORT_DIR
      ?? path.join(homedir(), "Library", "Application Support", "Liteverse"),
  );
}

export async function resolveProjectId(support, explicit) {
  const configured = explicit ?? process.env.LITEVERSE_PROJECT_ID;
  if (configured !== undefined) {
    if (!PROJECT_ID.test(configured)) throw new Error("project must be a lowercase Liteverse project ID");
    return configured;
  }
  const registry = await readJson(path.join(support, "Projects", "projects.json"), { optional: true });
  if (!registry) return "project-default";
  const active = registry.activeProjectId;
  if (!PROJECT_ID.test(active ?? "")) {
    throw new Error("Projects/projects.json has no valid activeProjectId");
  }
  if (Array.isArray(registry.items)) {
    const registered = registry.items.some((item) => (item?.projectId ?? item?.id) === active);
    if (!registered) throw new Error("Projects/projects.json activeProjectId is not registered");
  }
  return active;
}

export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function sha256File(filePath) {
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

export async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(filePath, { optional = false } = {}) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON at ${filePath}: ${error.message}`);
  }
}

export async function atomicWrite(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
}

export async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function resolveManagedPath(support, configured, fallback) {
  const candidate = configured || fallback;
  const resolved = path.resolve(path.isAbsolute(candidate) ? candidate : path.join(support, candidate));
  const relative = path.relative(support, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`managed path escapes the Liteverse support directory: ${candidate}`);
  }
  return resolved;
}

export function relativeManagedPath(support, absolute) {
  const relative = path.relative(support, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path is not inside Liteverse support: ${absolute}`);
  }
  return relative.split(path.sep).join("/");
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || value.startsWith("[")) {
    try {
      return JSON.parse(value);
    } catch {
      return value.replace(/^['"]|['"]$/g, "");
    }
  }
  return value.replace(/^['"]|['"]$/g, "");
}

export function parseFrontmatter(text) {
  const metadata = {};
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return { metadata, body: text, raw: "" };
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (field) metadata[field[1]] = parseScalar(field[2]);
  }
  return { metadata, body: text.slice(match[0].length), raw: match[0] };
}

export function stripLegacyProvisional(text) {
  const lines = text.split("\n");
  const retained = [];
  let removed = 0;
  let dropping = false;
  for (const line of lines) {
    if (/^#{1,6}\s+.*(?:legacy|provisional).*$/i.test(line.trim())) {
      dropping = true;
      removed += 1;
      continue;
    }
    if (dropping && /^#{1,6}\s+/.test(line) && !/(?:legacy|provisional)/i.test(line)) {
      dropping = false;
    }
    if (dropping) {
      removed += 1;
      continue;
    }
    retained.push(line);
  }
  return { text: retained.join("\n").trim(), removedLines: removed };
}

const SECTION_TYPES = new Map([
  ["research question", "research_question"],
  ["methods", "method"],
  ["equations and conventions", "equation_or_convention"],
  ["main results", "result"],
  ["limitations", "limitation"],
  ["project role", "project_role"],
]);

function slug(value) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

function parseEvidenceIndex(body) {
  const section = body.match(/^##\s+Evidence index\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/mi)?.[1] ?? "";
  const result = new Map();
  for (const line of section.split("\n")) {
    const match = line.match(/^\s*-\s*(E\d+)\s+[—–-]\s+(.+?)\s+[—–-]\s+(.+)\s*$/);
    if (!match) continue;
    result.set(match[1], {
      evidenceId: match[1],
      locator: match[2].trim(),
      paraphrase: match[3].trim(),
    });
  }
  return result;
}

function sectionBullets(body) {
  const sections = [];
  const regex = /^##\s+(.+?)\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm;
  for (const match of body.matchAll(regex)) {
    const heading = match[1].trim();
    const type = SECTION_TYPES.get(heading.toLocaleLowerCase("en-US"));
    if (!type) continue;
    const bullets = [];
    let current = null;
    for (const line of match[2].split("\n")) {
      const bullet = line.match(/^\s*-\s+(.+)$/);
      if (bullet) {
        if (current) bullets.push(current.trim());
        current = bullet[1];
      } else if (current && line.trim() && !/^<!--/.test(line.trim())) {
        current += ` ${line.trim()}`;
      }
    }
    if (current) bullets.push(current.trim());
    sections.push({ heading, type, bullets });
  }
  return sections;
}

export function parseCard(text, fallbackPaperId = null) {
  const { metadata, body: unfiltered } = parseFrontmatter(text);
  const { text: body, removedLines } = stripLegacyProvisional(unfiltered);
  const paperId = metadata.paper_id ?? metadata.paperId ?? fallbackPaperId;
  if (!paperId || !PAPER_ID.test(paperId)) throw new Error(`invalid or missing paper_id: ${paperId ?? "<missing>"}`);
  const evidence = parseEvidenceIndex(body);
  const title = metadata.title ?? body.match(/^#\s+(.+)$/m)?.[1] ?? paperId;
  return {
    paperId,
    title,
    authors: metadata.authors ?? metadata.author ?? [],
    tags: metadata.tags ?? [],
    verificationStatus: metadata.verification_status ?? metadata.verificationStatus ?? "card_draft",
    sourceSha256: metadata.source_sha256 ?? metadata.sha256 ?? null,
    fulltextPath: metadata.fulltext_path ?? metadata.fulltextPath ?? null,
    metadata,
    body,
    evidence,
    sections: sectionBullets(body),
    removedLegacyLines: removedLines,
  };
}

export function buildClaims(card, artifact) {
  const claims = [];
  for (const section of card.sections) {
    for (const statement of section.bullets) {
      const evidenceIds = [...new Set([...statement.matchAll(/\[(E\d+)\]/g)].map((match) => match[1]))];
      const text = statement.replace(/(?:\s*\[E\d+\])+\s*$/g, "").trim();
      if (!text || /\bTODO\b/i.test(text)) continue;
      const material = [card.paperId, section.type, text.normalize("NFKC"), ...evidenceIds].join("\u001f");
      const claimId = `${card.paperId}-${slug(section.type)}-${sha256Text(material).slice(0, 16)}`;
      claims.push({
        claimId,
        paperId: card.paperId,
        type: section.type,
        section: section.heading,
        text,
        conditions: [],
        unitsOrConventions: section.type === "equation_or_convention" ? [text] : [],
        evidenceIds,
        evidence: evidenceIds.map((id) => card.evidence.get(id)).filter(Boolean),
        verificationStatus: card.verificationStatus,
        artifactRevision: artifact.artifactRevision,
        artifactSha256: artifact.artifactSha256,
      });
    }
  }
  return {
    schemaVersion: "liteverse-claims-v1",
    paperId: card.paperId,
    title: card.title,
    verificationStatus: card.verificationStatus,
    artifactRevision: artifact.artifactRevision,
    artifactSha256: artifact.artifactSha256,
    sourceSha256: artifact.sourceSha256,
    claims,
  };
}

function artifactFingerprint(cardSha256, fulltextSha256, sourceSha256) {
  return sha256Text(`liteverse-artifact-v1\u001f${cardSha256}\u001f${fulltextSha256}\u001f${sourceSha256}`);
}

export async function snapshotPaperArtifact(support, entry, { verifyPdf = true } = {}) {
  const paperId = entry.paperId ?? entry.id;
  if (!PAPER_ID.test(paperId ?? "")) throw new Error(`invalid paper ID in index: ${paperId}`);
  const cardPath = resolveManagedPath(
    support,
    entry.cardPath ?? entry.artifacts?.cardPath ?? entry.markdownPath,
    `Knowledge/cards/${paperId}.md`,
  );
  const fulltextPath = resolveManagedPath(
    support,
    entry.fulltextPath ?? entry.artifacts?.fulltextPath,
    `Knowledge/fulltext/${paperId}.md`,
  );
  const pdfPath = resolveManagedPath(
    support,
    entry.pdfPath ?? entry.source?.pdfPath,
    `Library/PDFs/${paperId}.pdf`,
  );
  const [cardText, fulltextText] = await Promise.all([
    readFile(cardPath, "utf8"),
    readFile(fulltextPath, "utf8"),
  ]);
  const card = parseCard(cardText, paperId);
  if (card.paperId !== paperId) throw new Error(`card paper_id ${card.paperId} does not match index ID ${paperId}`);
  const cardSha256 = sha256Text(cardText);
  const fulltextSha256 = sha256Text(fulltextText);
  const expectedSource = entry.source?.sha256 ?? entry.sha256 ?? card.sourceSha256;
  if (!SHA256.test(expectedSource ?? "")) throw new Error(`missing source SHA-256 for ${paperId}`);
  const sourceSha256 = verifyPdf ? await sha256File(pdfPath) : expectedSource;
  if (sourceSha256 !== expectedSource) throw new Error(`source PDF hash mismatch for ${paperId}`);
  if (card.sourceSha256 && card.sourceSha256 !== sourceSha256) {
    throw new Error(`card source_sha256 mismatch for ${paperId}`);
  }
  const artifactSha256 = artifactFingerprint(cardSha256, fulltextSha256, sourceSha256);
  const artifactRoot = path.join(support, "Knowledge", "artifacts", paperId);
  const currentPath = path.join(artifactRoot, "current.json");
  const current = await readJson(currentPath, { optional: true });
  if (current?.artifactSha256 === artifactSha256) {
    const claims = buildClaims(card, current);
    const claimsText = `${JSON.stringify(claims, null, 2)}\n`;
    if (current.claimsSha256 === sha256Text(claimsText)) {
      await atomicWrite(path.join(support, "Knowledge", "claims", `${paperId}.json`), claimsText);
      return { ...current, card, cardText, fulltextText, claims, changed: false };
    }
  }
  let artifactRevision = Number.isInteger(current?.artifactRevision) ? current.artifactRevision + 1 : 1;
  const revisionsRoot = path.join(artifactRoot, "revisions");
  await mkdir(revisionsRoot, { recursive: true });
  let revisionRoot;
  while (true) {
    revisionRoot = path.join(revisionsRoot, String(artifactRevision).padStart(6, "0"));
    try {
      await mkdir(revisionRoot);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      artifactRevision += 1;
    }
  }
  const artifact = {
    schemaVersion: "liteverse-artifact-v1",
    paperId,
    artifactRevision,
    artifactSha256,
    sourceSha256,
    cardSha256,
    fulltextSha256,
    canonicalCardPath: relativeManagedPath(support, cardPath),
    canonicalFulltextPath: relativeManagedPath(support, fulltextPath),
    sourcePath: relativeManagedPath(support, pdfPath),
    immutableCardPath: relativeManagedPath(support, path.join(revisionRoot, "card.md")),
    immutableFulltextPath: relativeManagedPath(support, path.join(revisionRoot, "fulltext.md")),
    immutableClaimsPath: relativeManagedPath(support, path.join(revisionRoot, "claims.json")),
    manifestPath: relativeManagedPath(support, path.join(revisionRoot, "manifest.json")),
    verificationStatus: card.verificationStatus,
  };
  const claims = buildClaims(card, artifact);
  const claimsText = `${JSON.stringify(claims, null, 2)}\n`;
  artifact.claimsSha256 = sha256Text(claimsText);
  artifact.claimCount = claims.claims.length;
  await Promise.all([
    copyFile(cardPath, path.join(revisionRoot, "card.md")),
    copyFile(fulltextPath, path.join(revisionRoot, "fulltext.md")),
    atomicWrite(path.join(revisionRoot, "claims.json"), claimsText),
  ]);
  await atomicWriteJson(path.join(revisionRoot, "manifest.json"), artifact);
  await atomicWrite(path.join(support, "Knowledge", "claims", `${paperId}.json`), claimsText);
  await atomicWriteJson(currentPath, artifact);
  return { ...artifact, card, cardText, fulltextText, claims, changed: true };
}

export function artifactFields(artifact) {
  return {
    artifactRevision: artifact.artifactRevision,
    artifactSha256: artifact.artifactSha256,
    sourceSha256: artifact.sourceSha256,
    cardSha256: artifact.cardSha256,
    fulltextSha256: artifact.fulltextSha256,
    claimsSha256: artifact.claimsSha256,
    claimCount: artifact.claimCount,
    manifestPath: artifact.manifestPath,
    immutableCardPath: artifact.immutableCardPath,
    immutableFulltextPath: artifact.immutableFulltextPath,
    immutableClaimsPath: artifact.immutableClaimsPath,
  };
}

export async function verifyPaperArtifact(support, entry, { requireFulltext = false, requireClaims = false } = {}) {
  const paperId = entry.paperId ?? entry.id;
  const artifact = entry.artifact ?? entry.artifacts?.integrity ?? entry.integrity;
  if (!artifact || !Number.isInteger(artifact.artifactRevision) || !SHA256.test(artifact.artifactSha256 ?? "")) {
    throw new Error(`paper ${paperId} has no pinned artifact revision; run liteverse doctor --fix before adoption`);
  }
  const cardPath = resolveManagedPath(support, entry.cardPath ?? entry.artifacts?.cardPath, `Knowledge/cards/${paperId}.md`);
  const cardText = await readFile(cardPath, "utf8");
  const cardSha256 = sha256Text(cardText);
  if (cardSha256 !== artifact.cardSha256) throw new Error(`knowledge card hash mismatch for ${paperId}`);
  let fulltextPath = null;
  let fulltextText = null;
  if (requireFulltext) {
    fulltextPath = resolveManagedPath(support, entry.fulltextPath ?? entry.artifacts?.fulltextPath, `Knowledge/fulltext/${paperId}.md`);
    fulltextText = await readFile(fulltextPath, "utf8");
    if (sha256Text(fulltextText) !== artifact.fulltextSha256) throw new Error(`full-text hash mismatch for ${paperId}`);
  }
  let claims = null;
  let claimsPath = null;
  if (requireClaims) {
    claimsPath = resolveManagedPath(support, `Knowledge/claims/${paperId}.json`, `Knowledge/claims/${paperId}.json`);
    const claimsText = await readFile(claimsPath, "utf8");
    if (sha256Text(claimsText) !== artifact.claimsSha256) throw new Error(`claims hash mismatch for ${paperId}`);
    claims = JSON.parse(claimsText);
    if (claims.artifactSha256 !== artifact.artifactSha256 || claims.artifactRevision !== artifact.artifactRevision) {
      throw new Error(`claims artifact revision conflict for ${paperId}`);
    }
  }
  return {
    paperId,
    artifact,
    cardPath,
    cardText,
    card: parseCard(cardText, paperId),
    fulltextPath,
    fulltextText,
    claimsPath,
    claims,
  };
}

export function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[ψΨ]/g, " psi ")
    .replace(/[ρΡ]/g, " rho ")
    .replace(/[γΓ]/g, " gamma ")
    .replace(/[λΛ]/g, " lambda ")
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cjkBigrams(value) {
  const result = [];
  for (const run of String(value).match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    const chars = [...run];
    for (let index = 0; index < chars.length - 1; index += 1) result.push(`${chars[index]}${chars[index + 1]}`);
  }
  return result;
}

export const SEARCH_ALIAS_ENTRIES = [
  ["doi", "digital object identifier"],
  ["pmid", "pubmed identifier"],
  ["orcid", "open researcher contributor id"],
  ["supp", "supplement supplementary material"],
  ["preprint", "manuscript arxiv"],
];

export function expandSearchText(value) {
  const normalized = normalizeSearchText(value);
  const additions = cjkBigrams(normalized);
  for (const [key, aliases] of SEARCH_ALIAS_ENTRIES) {
    if (new RegExp(`(?:^|\\s)${key}(?:$|\\s)`, "i").test(normalized) || normalizeSearchText(aliases).split(" ").some((token) => normalized.includes(token))) {
      additions.push(key, normalizeSearchText(aliases));
    }
  }
  return `${normalized} ${additions.join(" ")}`.trim();
}

export function extractFulltextPages(fulltext, selectors) {
  const wanted = new Set();
  for (const selector of selectors) {
    const match = String(selector).match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error(`invalid page selector: ${selector}`);
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end - start > 100) throw new Error(`invalid page range: ${selector}`);
    for (let page = start; page <= end; page += 1) wanted.add(page);
  }
  const parts = fulltext.split(/(?=<!-- page:\s*\d+\s*-->)/g);
  return parts.filter((part) => {
    const page = Number(part.match(/^<!-- page:\s*(\d+)\s*-->/)?.[1]);
    return wanted.has(page);
  }).join("\n").trim();
}

export function selectCardSections(cardText, selectors) {
  if (!selectors.length) return cardText;
  const { raw, body } = parseFrontmatter(cardText);
  const wanted = new Set(selectors.map((value) => slug(value)));
  const title = body.match(/^#\s+.+$/m)?.[0] ?? "";
  const sections = [];
  for (const match of body.matchAll(/^##\s+(.+?)\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm)) {
    if (wanted.has(slug(match[1]))) sections.push(`## ${match[1]}${match[2]}`.trim());
  }
  if (!sections.length) throw new Error(`none of the requested card sections exist: ${selectors.join(", ")}`);
  return `${raw}${title}\n\n${sections.join("\n\n")}\n`;
}

export function truncateText(text, maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("maxChars must be a positive integer");
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars - 22)).trimEnd()}\n\n[Liteverse truncated]`, truncated: true };
}
