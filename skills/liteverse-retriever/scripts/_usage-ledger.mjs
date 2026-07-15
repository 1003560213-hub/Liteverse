import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  truncate,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export function hashTask(taskId) {
  return createHash("sha256").update(taskId, "utf8").digest("hex");
}

function eventKey(event) {
  if (typeof event.paperId !== "string" || !event.paperId) throw new Error("usage event lacks paperId");
  if (typeof event.taskHash !== "string" || !/^[a-f0-9]{64}$/.test(event.taskHash)) {
    throw new Error("usage event has invalid taskHash");
  }
  const projectId = typeof event.projectId === "string" && event.projectId ? event.projectId : null;
  const key = projectId
    ? `${event.taskHash}:${projectId}:${event.paperId}`
    : `${event.taskHash}:${event.paperId}`;
  if (event.key !== undefined && event.key !== key) throw new Error("usage event key does not match taskHash and paperId");
  return key;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
}

export async function withUsageLock(support, callback) {
  const lockPath = path.join(support, ".locks", "usage.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      await mkdir(lockPath);
      await atomicWrite(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      );
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const details = await stat(lockPath);
        if (Date.now() - details.mtimeMs > 60_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for usage lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function readLedger(support) {
  const ledgerPath = path.join(support, "Usage", "events.jsonl");
  if (!(await exists(ledgerPath))) {
    return {
      ledgerPath,
      events: [],
      ignoredPartialTail: false,
      unterminatedValidTail: false,
      validPrefixBytes: 0,
    };
  }
  const text = await readFile(ledgerPath, "utf8");
  const hasTerminatingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (hasTerminatingNewline) lines.pop();
  const events = [];
  let ignoredPartialTail = false;
  let unterminatedValidTail = false;
  let validPrefixBytes = Buffer.byteLength(text, "utf8");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("event must be an object");
      eventKey(event);
      events.push(event);
    } catch (error) {
      if (!hasTerminatingNewline && index === lines.length - 1) {
        ignoredPartialTail = true;
        const prefix = lines.slice(0, index).join("\n");
        validPrefixBytes = Buffer.byteLength(prefix ? `${prefix}\n` : "", "utf8");
        continue;
      }
      throw new Error(`invalid usage ledger line ${index + 1}: ${error.message}`);
    }
  }
  if (!hasTerminatingNewline && !ignoredPartialTail && lines.length > 0 && lines.at(-1).trim()) {
    unterminatedValidTail = true;
  }
  return { ledgerPath, events, ignoredPartialTail, unterminatedValidTail, validPrefixBytes };
}

export function summarizeEvents(events) {
  const seen = new Set();
  const counts = {};
  const projectCounts = {};
  let duplicates = 0;
  for (const event of events) {
    const key = eventKey(event);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    counts[event.paperId] = (counts[event.paperId] ?? 0) + 1;
    if (event.projectId) {
      projectCounts[event.projectId] ??= {};
      projectCounts[event.projectId][event.paperId] = (projectCounts[event.projectId][event.paperId] ?? 0) + 1;
    }
  }
  return {
    seen,
    counts: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))),
    projectCounts: Object.fromEntries(
      Object.entries(projectCounts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([projectId, values]) => [projectId, Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)))]),
    ),
    duplicates,
  };
}

export async function writeCounts(support, summary, sourceEventCount) {
  const countsPath = path.join(support, "Usage", "counts.json");
  const value = {
    schemaVersion: 2,
    rebuiltAt: new Date().toISOString(),
    uniqueEventCount: summary.seen.size,
    sourceEventCount,
    ignoredDuplicateEvents: summary.duplicates,
    counts: summary.counts,
    projectCounts: summary.projectCounts,
  };
  await atomicWrite(countsPath, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

export async function recordUsage(support, taskId, paperId, metadata = {}) {
  return withUsageLock(support, async () => {
    const ledger = await readLedger(support);
    const taskHash = hashTask(taskId);
    const projectId = metadata.projectId ?? "project-default";
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId)) throw new Error(`invalid usage projectId: ${projectId}`);
    const key = `${taskHash}:${projectId}:${paperId}`;
    const summary = summarizeEvents(ledger.events);
    let counted = false;
    if (!summary.seen.has(key)) {
      const event = {
        schemaVersion: 2,
        eventId: createHash("sha256").update(`liteverse-use-v2:${key}`).digest("hex"),
        type: "paper_adopted",
        timestamp: new Date().toISOString(),
        taskHash,
        projectId,
        paperId,
        key,
        ...(Number.isInteger(metadata.artifactRevision) ? { artifactRevision: metadata.artifactRevision } : {}),
        ...(typeof metadata.artifactSha256 === "string" ? { artifactSha256: metadata.artifactSha256 } : {}),
        ...(Array.isArray(metadata.claimIds) ? { claimIds: [...new Set(metadata.claimIds)].sort() } : {}),
        ...(Array.isArray(metadata.evidenceIds) ? { evidenceIds: [...new Set(metadata.evidenceIds)].sort() } : {}),
      };
      await mkdir(path.dirname(ledger.ledgerPath), { recursive: true });
      if (ledger.ignoredPartialTail) {
        await truncate(ledger.ledgerPath, ledger.validPrefixBytes);
      } else if (ledger.unterminatedValidTail) {
        const terminator = await open(ledger.ledgerPath, "a", 0o600);
        try {
          await terminator.write("\n", null, "utf8");
          await terminator.sync();
        } finally {
          await terminator.close();
        }
      }
      const handle = await open(ledger.ledgerPath, "a", 0o600);
      try {
        await handle.write(`${JSON.stringify(event)}\n`, null, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      ledger.events.push(event);
      counted = true;
    }
    const finalSummary = summarizeEvents(ledger.events);
    const cache = await writeCounts(support, finalSummary, ledger.events.length);
    return {
      counted,
      useCount: cache.counts[paperId] ?? 0,
      taskHash,
      projectId,
      ignoredPartialTail: ledger.ignoredPartialTail,
    };
  });
}

export async function rebuildCounts(support, write = true) {
  return withUsageLock(support, async () => {
    const ledger = await readLedger(support);
    const summary = summarizeEvents(ledger.events);
    const cache = write
      ? await writeCounts(support, summary, ledger.events.length)
      : {
          schemaVersion: 2,
          uniqueEventCount: summary.seen.size,
          sourceEventCount: ledger.events.length,
          ignoredDuplicateEvents: summary.duplicates,
          counts: summary.counts,
          projectCounts: summary.projectCounts,
        };
    return { cache, ignoredPartialTail: ledger.ignoredPartialTail };
  });
}
