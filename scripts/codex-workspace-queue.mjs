import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const supportDirectory = process.env.LITEVERSE_SUPPORT_DIR || path.join(
  homedir(),
  "Library",
  "Application Support",
  "Liteverse",
);
const libraryPath = path.join(supportDirectory, "library.json");
const researchPath = path.join(supportDirectory, "research-information.json");
const inboxPath = path.join(supportDirectory, "workspace-inbox.jsonl");
const generatedDirectory = path.join(supportDirectory, "generated");

const emptyLibrary = { schemaVersion: 1, nextNumber: 1, items: [] };
const emptyResearch = {
  schemaVersion: 1,
  status: "empty",
  draft: { text: "", revision: 0, updatedAt: "" },
  formal: { text: "", sourceRevision: 0, organizedAt: "" },
};

async function readJsonOrDefault(filePath, fallback) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("root must be a JSON object");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    throw new Error(`Liteverse queue refused to read invalid ${path.basename(filePath)}: ${error.message}`);
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function appendEvent(action, payload) {
  await mkdir(supportDirectory, { recursive: true });
  await appendFile(
    inboxPath,
    `${JSON.stringify({
      eventId: crypto.randomUUID(),
      action,
      timestamp: new Date().toISOString(),
      ...payload,
    })}\n`,
    "utf8",
  );
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(flag) {
  const value = argumentValue(flag);
  if (!value) throw new Error(`Missing required argument ${flag}`);
  return value;
}

function numericRevision(flag = "--revision") {
  const raw = requiredArgument(flag);
  const revision = Number(raw);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return revision;
}

function libraryCode(number) {
  return `LIT-${String(number).padStart(4, "0")}`;
}

async function listQueue(asJson) {
  const [library, researchInformation] = await Promise.all([
    readJsonOrDefault(libraryPath, emptyLibrary),
    readJsonOrDefault(researchPath, emptyResearch),
  ]);
  const pendingLiterature = (library.items || []).filter(
    (item) => ["pending_codex", "processing", "needs_attention"].includes(item.status),
  );
  const readyToRefresh = (library.items || []).filter(
    (item) => item.status === "ready_to_refresh",
  );
  const pendingResearch = ["pending_setup", "pending_update"].includes(
    researchInformation.status,
  )
    ? researchInformation
    : null;
  if (asJson) {
    console.log(JSON.stringify({ pendingLiterature, readyToRefresh, pendingResearch }, null, 2));
    return;
  }
  if (!pendingLiterature.length && !readyToRefresh.length && !pendingResearch) {
    console.log("Liteverse workspace: no pending literature or research information.");
    return;
  }
  if (pendingResearch) {
    console.log(
      `Research information: ${pendingResearch.status}, draft revision ${pendingResearch.draft.revision}`,
    );
    console.log(pendingResearch.draft.text);
  }
  for (const item of pendingLiterature) {
    console.log(
      `${libraryCode(item.number)} ${item.id} [${item.status}] revision ${item.revision}: ${item.displayTitle}`,
    );
    if (item.arxivUrl) console.log(`  arXiv: ${item.arxivUrl}`);
    if (item.storedFilename) {
      console.log(`  PDF: ${path.join(supportDirectory, "Library", "PDFs", item.storedFilename)}`);
    }
  }
  for (const item of readyToRefresh) {
    console.log(
      `${libraryCode(item.number)} ${item.id} [ready_to_refresh] revision ${item.revision}: ${item.displayTitle}`,
    );
  }
}

async function inspectItem(itemId) {
  const library = await readJsonOrDefault(libraryPath, emptyLibrary);
  const item = (library.items || []).find((entry) => entry.id === itemId);
  if (!item) throw new Error(`Unknown literature item: ${itemId}`);
  console.log(JSON.stringify(item, null, 2));
}

async function markLiterature(itemId) {
  const expectedRevision = numericRevision();
  const disposition = requiredArgument("--disposition");
  const allowedDispositions = new Set(["added", "merged", "duplicate", "no-link"]);
  if (!allowedDispositions.has(disposition)) {
    throw new Error("--disposition must be added, merged, duplicate, or no-link");
  }
  const library = await readJsonOrDefault(libraryPath, emptyLibrary);
  const index = (library.items || []).findIndex((entry) => entry.id === itemId);
  if (index < 0) throw new Error(`Unknown literature item: ${itemId}`);
  const current = library.items[index];
  if (current.revision !== expectedRevision) {
    throw new Error(
      `Revision mismatch for ${itemId}: expected ${expectedRevision}, current ${current.revision}. Re-run list before publishing.`,
    );
  }
  const title = argumentValue("--title");
  const arxivUrl = argumentValue("--arxiv-url");
  const paperId = argumentValue("--paper-id");
  const refreshId = argumentValue("--refresh-id");
  if (arxivUrl && !/^https:\/\/(?:www\.)?arxiv\.org\/abs\//i.test(arxivUrl)) {
    throw new Error("--arxiv-url must be a canonical https://arxiv.org/abs/... URL");
  }
  if (["added", "merged"].includes(disposition) && !paperId) {
    throw new Error("--paper-id is required when the item was added or merged into the graph");
  }
  if (["added", "merged"].includes(disposition) && !refreshId) {
    throw new Error("--refresh-id is required when a graph change is waiting for App Refresh");
  }
  const organizedAt = new Date().toISOString();
  const waitsForRefresh = ["added", "merged"].includes(disposition);
  const next = {
    ...current,
    ...(title ? { displayTitle: title, titleStatus: "codex_verified" } : {}),
    ...(arxivUrl ? { arxivUrl } : {}),
    ...(paperId ? { graphPaperId: paperId } : {}),
    status: waitsForRefresh ? "ready_to_refresh" : "organized",
    disposition,
    ...(refreshId ? { refreshId } : {}),
    revision: current.revision + 1,
    updatedAt: organizedAt,
    ...(waitsForRefresh ? { readyToRefreshAt: organizedAt } : { organizedAt }),
  };
  library.items[index] = next;
  await writeJson(libraryPath, library);
  await appendEvent(waitsForRefresh ? "literature_ready_to_refresh" : "literature_organized_by_codex", {
    itemId,
    sourceRevision: expectedRevision,
    disposition,
    graphPaperId: paperId || null,
    refreshId: refreshId || null,
  });
  console.log(
    waitsForRefresh
      ? `Liteverse workspace: ${libraryCode(next.number)} (${itemId}) is ready to refresh.`
      : `Liteverse workspace: organized ${libraryCode(next.number)} (${itemId}).`,
  );
}

async function beginLiterature(itemId) {
  const expectedRevision = numericRevision();
  const library = await readJsonOrDefault(libraryPath, emptyLibrary);
  const index = (library.items || []).findIndex((entry) => entry.id === itemId);
  if (index < 0) throw new Error(`Unknown literature item: ${itemId}`);
  const current = library.items[index];
  if (current.revision !== expectedRevision) {
    throw new Error(
      `Revision mismatch for ${itemId}: expected ${expectedRevision}, current ${current.revision}.`,
    );
  }
  if (!["pending_codex", "needs_attention"].includes(current.status)) {
    throw new Error(`${itemId} cannot enter processing from status ${current.status}`);
  }
  const processingToken = crypto.randomUUID();
  const updatedAt = new Date().toISOString();
  const next = {
    ...current,
    status: "processing",
    revision: current.revision + 1,
    processingToken,
    processingStartedAt: updatedAt,
    updatedAt,
  };
  library.items[index] = next;
  await writeJson(libraryPath, library);
  await appendEvent("literature_processing_started", {
    itemId,
    sourceRevision: expectedRevision,
    processingRevision: next.revision,
    processingToken,
  });
  console.log(JSON.stringify({ itemId, revision: next.revision, processingToken }, null, 2));
}

async function markNeedsAttention(itemId) {
  const expectedRevision = numericRevision();
  const reason = requiredArgument("--reason");
  const library = await readJsonOrDefault(libraryPath, emptyLibrary);
  const index = (library.items || []).findIndex((entry) => entry.id === itemId);
  if (index < 0) throw new Error(`Unknown literature item: ${itemId}`);
  const current = library.items[index];
  if (current.revision !== expectedRevision) {
    throw new Error(
      `Revision mismatch for ${itemId}: expected ${expectedRevision}, current ${current.revision}.`,
    );
  }
  const updatedAt = new Date().toISOString();
  library.items[index] = {
    ...current,
    status: "needs_attention",
    attentionReason: reason,
    revision: current.revision + 1,
    updatedAt,
  };
  await writeJson(libraryPath, library);
  await appendEvent("literature_needs_attention", {
    itemId,
    sourceRevision: expectedRevision,
    reason,
  });
  console.log(`Liteverse workspace: ${itemId} now needs attention.`);
}

async function publishResearch() {
  const expectedRevision = numericRevision();
  const sourceFile = path.resolve(requiredArgument("--from"));
  const formalText = (await readFile(sourceFile, "utf8")).trim();
  if (!formalText) throw new Error("The formal research memory file is empty");
  const research = await readJsonOrDefault(researchPath, emptyResearch);
  if (research.draft.revision !== expectedRevision) {
    throw new Error(
      `Research revision mismatch: expected ${expectedRevision}, current ${research.draft.revision}. Re-run list before publishing.`,
    );
  }
  const organizedAt = new Date().toISOString();
  const next = {
    ...research,
    status: "organized",
    formal: {
      text: formalText,
      sourceRevision: expectedRevision,
      organizedAt,
    },
  };
  await writeJson(researchPath, next);
  await mkdir(generatedDirectory, { recursive: true });
  await writeFile(
    path.join(generatedDirectory, "research-memory.md"),
    `${formalText}\n`,
    "utf8",
  );
  await appendEvent("research_information_organized_by_codex", {
    sourceRevision: expectedRevision,
    sourceFile,
  });
  console.log(`Liteverse workspace: published research information revision ${expectedRevision}.`);
}

function printUsage() {
  console.error(`Usage:
  node scripts/codex-workspace-queue.mjs list [--json]
  node scripts/codex-workspace-queue.mjs inspect <item-id>
  node scripts/codex-workspace-queue.mjs begin-literature <item-id> --revision <n>
  node scripts/codex-workspace-queue.mjs mark-literature <item-id> --revision <n> --disposition <added|merged|duplicate|no-link> [--paper-id <id>] [--refresh-id <id>] [--title <title>] [--arxiv-url <url>]
  node scripts/codex-workspace-queue.mjs needs-attention <item-id> --revision <n> --reason <text>
  node scripts/codex-workspace-queue.mjs publish-research --revision <n> --from <markdown-file>`);
}

try {
  const command = process.argv[2] || "list";
  if (command === "list") await listQueue(process.argv.includes("--json"));
  else if (command === "inspect") await inspectItem(requiredArgumentAt(3));
  else if (command === "begin-literature") await beginLiterature(requiredArgumentAt(3));
  else if (command === "mark-literature") await markLiterature(requiredArgumentAt(3));
  else if (command === "needs-attention") await markNeedsAttention(requiredArgumentAt(3));
  else if (command === "publish-research") await publishResearch();
  else {
    printUsage();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function requiredArgumentAt(index) {
  const value = process.argv[index];
  if (!value || value.startsWith("--")) {
    printUsage();
    throw new Error(`Missing positional argument at index ${index - 2}`);
  }
  return value;
}
