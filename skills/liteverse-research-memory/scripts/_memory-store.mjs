import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

export const SCHEMA_VERSION = 1;
export const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const HASH = /^[a-f0-9]{64}$/;
export const MEMORY_TYPES = new Set([
  "project_context",
  "goal",
  "convention",
  "decision",
  "assumption",
  "finding",
  "open_question",
  "exclusion",
  "next_step",
  "code",
  "experiment",
]);
export const MEMORY_STATES = new Set(["active", "superseded", "retired"]);
export const EVIDENCE_STATES = new Set([
  "user_declared",
  "provisional",
  "supported",
  "contradicted",
]);
export const PROVENANCE = new Set([
  "user",
  "paperEvidence",
  "computationArtifact",
  "aiInference",
]);

const EVENT_TYPES = new Set([
  "project_initialized",
  "project_metadata_updated",
  "memory_recorded",
  "memory_retired",
  "task_started",
  "task_completed",
  "handoff_built",
]);

export function fail(message) {
  throw new Error(message);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function resolveSupport(explicit) {
  return path.resolve(
    explicit
      ?? process.env.LITEVERSE_SUPPORT_DIR
      ?? path.join(homedir(), "Library", "Application Support", "Liteverse"),
  );
}

export function hashTaskId(rawTaskId) {
  const value = String(rawTaskId ?? "").trim();
  if (!value) fail("LITEVERSE_TASK_ID or CODEX_THREAD_ID is required; use --task-id only for controlled tests or recovery");
  return sha256(value);
}

export function resolveRawTaskId(explicit) {
  return explicit ?? process.env.LITEVERSE_TASK_ID ?? process.env.CODEX_THREAD_ID;
}

export function assertProjectId(projectId) {
  if (!PROJECT_ID.test(projectId ?? "")) {
    fail("project ID must contain lowercase letters, digits, and single hyphen separators only");
  }
  return projectId;
}

export function projectPaths(support, projectId) {
  assertProjectId(projectId);
  const root = path.join(support, "Projects", projectId);
  return {
    root,
    registry: path.join(support, "Projects", "projects.json"),
    project: path.join(root, "project.json"),
    ledger: path.join(root, "memory", "events.jsonl"),
    memory: path.join(root, "memory", "current.json"),
    tasks: path.join(root, "tasks.json"),
    taskRoot: path.join(root, "Tasks"),
  };
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

export async function readJsonStrict(filePath, { optional = false } = {}) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`${filePath} must contain a JSON object`);
    }
    return value;
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) fail(`invalid JSON in ${filePath}: ${error.message}`);
    throw error;
  }
}

export async function atomicWrite(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
}

export async function withMemoryLock(support, callback) {
  const lockPath = path.join(support, ".locks", "research-memory.lock");
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
      if (Date.now() >= deadline) fail(`timed out waiting for research-memory lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function requireString(value, label, max = 100_000) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  if (value.length > max) fail(`${label} exceeds ${max} characters`);
  return value;
}

function stringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail(`${label} must be an ISO timestamp`);
}

export function validatePaperEvidence(value) {
  if (!Array.isArray(value)) fail("paperEvidence must be a JSON array");
  return value.map((reference, index) => {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
      fail(`paperEvidence[${index}] must be an object`);
    }
    const paperId = requireString(reference.paperId, `paperEvidence[${index}].paperId`, 256);
    const claimId = requireString(reference.claimId, `paperEvidence[${index}].claimId`, 256);
    const evidenceId = requireString(reference.evidenceId, `paperEvidence[${index}].evidenceId`, 256);
    const artifactHash = requireString(reference.artifactHash, `paperEvidence[${index}].artifactHash`, 64);
    if (!HASH.test(artifactHash)) fail(`paperEvidence[${index}].artifactHash must be a lowercase SHA-256`);
    const result = { paperId, claimId, evidenceId, artifactHash };
    if (reference.artifactRevision !== undefined) {
      if (!Number.isInteger(reference.artifactRevision) || reference.artifactRevision < 1) {
        fail(`paperEvidence[${index}].artifactRevision must be a positive integer`);
      }
      result.artifactRevision = reference.artifactRevision;
    }
    if (reference.locator !== undefined) {
      result.locator = requireString(reference.locator, `paperEvidence[${index}].locator`, 1_000);
    }
    return result;
  });
}

export function validateComputationArtifact(value, expectedKind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("computationArtifact must be a JSON object");
  }
  const allowed = new Set([
    "kind", "path", "gitCommit", "contentHash", "configHash", "dataHash", "command", "resultSummary",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`computationArtifact.${key} is not allowed; store metadata, never code or data content`);
  }
  const kind = value.kind ?? expectedKind;
  if (!new Set(["code", "experiment"]).has(kind)) fail("computationArtifact.kind must be code or experiment");
  if (expectedKind && kind !== expectedKind) fail(`computationArtifact.kind must match memory type ${expectedKind}`);
  const result = {
    kind,
    path: requireString(value.path, "computationArtifact.path", 4_096),
    resultSummary: requireString(value.resultSummary, "computationArtifact.resultSummary", 20_000),
  };
  if (value.gitCommit !== undefined) {
    result.gitCommit = requireString(value.gitCommit, "computationArtifact.gitCommit", 64);
    if (!/^[a-f0-9]{7,64}$/i.test(result.gitCommit)) fail("computationArtifact.gitCommit must be a Git commit hash");
  }
  for (const key of ["contentHash", "configHash", "dataHash"]) {
    if (value[key] !== undefined) {
      result[key] = requireString(value[key], `computationArtifact.${key}`, 64).toLowerCase();
      if (!HASH.test(result[key])) fail(`computationArtifact.${key} must be a SHA-256`);
    }
  }
  if (value.command !== undefined) result.command = requireString(value.command, "computationArtifact.command", 20_000);
  if (!result.gitCommit && !result.contentHash && !result.configHash && !result.dataHash) {
    fail("computationArtifact requires a gitCommit or at least one SHA-256 hash");
  }
  return result;
}

export function validateMemoryDraft(draft) {
  const type = draft.type;
  const state = draft.state ?? "active";
  const provenance = draft.provenance;
  const evidenceState = draft.evidenceState
    ?? (provenance === "user" ? "user_declared" : "provisional");
  if (!MEMORY_TYPES.has(type)) fail(`unsupported memory type: ${type}`);
  if (!MEMORY_STATES.has(state)) fail(`unsupported memory state: ${state}`);
  if (state === "superseded") fail("a new memory cannot start superseded; use supersedes to derive that state on an older item");
  if (!PROVENANCE.has(provenance)) fail(`unsupported memory provenance: ${provenance}`);
  if (!EVIDENCE_STATES.has(evidenceState)) fail(`unsupported evidence state: ${evidenceState}`);
  const paperEvidence = validatePaperEvidence(draft.paperEvidence ?? []);
  const computationArtifact = draft.computationArtifact === undefined || draft.computationArtifact === null
    ? null
    : validateComputationArtifact(draft.computationArtifact, new Set(["code", "experiment"]).has(type) ? type : undefined);
  if (provenance === "paperEvidence" && paperEvidence.length === 0) {
    fail("paperEvidence provenance requires Retriever-supplied paperEvidence references");
  }
  if (provenance === "computationArtifact" && !computationArtifact) {
    fail("computationArtifact provenance requires reproducible artifact metadata");
  }
  if (provenance === "aiInference" && evidenceState !== "provisional") {
    fail("AI inferences must remain provisional");
  }
  if (new Set(["code", "experiment"]).has(type) && provenance !== "computationArtifact") {
    fail(`${type} memory must use computationArtifact provenance`);
  }
  if (new Set(["supported", "contradicted"]).has(evidenceState)
      && paperEvidence.length === 0 && !computationArtifact) {
    fail(`${evidenceState} memory requires exact paper evidence or a reproducible computation artifact`);
  }
  if (new Set(["supported", "contradicted"]).has(evidenceState)
      && provenance === "user") {
    fail(`${evidenceState} memory cannot use user provenance; use paperEvidence or computationArtifact`);
  }
  if (new Set(["code", "experiment"]).has(type) && !computationArtifact) {
    fail(`${type} memory requires computationArtifact metadata`);
  }
  const memoryId = draft.memoryId ?? `mem-${randomUUID().replaceAll("-", "")}`;
  if (!/^mem-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(memoryId)) fail("memoryId must start with mem- and use lowercase slug characters");
  const supersedes = stringArray(draft.supersedes, "supersedes");
  if (state !== "active" && supersedes.length > 0) fail("only an active new memory may supersede older memory");
  const content = requireString(draft.content, "memory content", new Set(["code", "experiment"]).has(type) ? 20_000 : 1_000_000);
  return {
    memoryId,
    type,
    title: requireString(draft.title, "memory title", 1_000),
    content,
    state,
    evidenceState,
    provenance,
    supersedes,
    contradicts: stringArray(draft.contradicts, "contradicts"),
    paperEvidence,
    computationArtifact,
    taskHash: draft.taskHash ?? null,
    source: draft.source ?? null,
  };
}

function validateBaseEvent(event, expectedProjectId, expectedRevision, seenIds) {
  if (!event || typeof event !== "object" || Array.isArray(event)) fail("ledger event must be an object");
  if (event.schemaVersion !== SCHEMA_VERSION) fail(`unsupported research-memory event schema ${event.schemaVersion}`);
  if (!EVENT_TYPES.has(event.type)) fail(`unsupported research-memory event type ${event.type}`);
  if (event.projectId !== expectedProjectId) fail(`ledger contains an event for another project: ${event.projectId}`);
  if (event.revision !== expectedRevision) fail(`ledger revision gap: expected ${expectedRevision}, found ${event.revision}`);
  requireString(event.eventId, "eventId", 128);
  if (seenIds.has(event.eventId)) fail(`duplicate eventId ${event.eventId}`);
  seenIds.add(event.eventId);
  assertIsoTimestamp(event.timestamp, "event timestamp");
}

function initialState(projectId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    revision: 0,
    metadata: null,
    memories: new Map(),
    tasks: new Map(),
    handoffs: [],
    updatedAt: null,
  };
}

export function applyEvents(projectId, events) {
  const state = initialState(projectId);
  const seenIds = new Set();
  for (const event of events) {
    validateBaseEvent(event, projectId, state.revision + 1, seenIds);
    if (event.type !== "project_initialized" && !state.metadata) fail("first project event must initialize the project");
    switch (event.type) {
      case "project_initialized": {
        if (state.metadata) fail("project may only be initialized once");
        state.metadata = {
          name: requireString(event.name, "project name", 1_000),
          description: typeof event.description === "string" ? event.description : "",
          createdAt: event.timestamp,
        };
        break;
      }
      case "project_metadata_updated": {
        if (event.name !== undefined) state.metadata.name = requireString(event.name, "project name", 1_000);
        if (event.description !== undefined) {
          if (typeof event.description !== "string") fail("project description must be a string");
          state.metadata.description = event.description;
        }
        break;
      }
      case "memory_recorded": {
        if (!event.memory?.memoryId) fail("memory_recorded event must contain a stable memoryId");
        const draft = validateMemoryDraft(event.memory);
        if (state.memories.has(draft.memoryId)) fail(`memory already exists: ${draft.memoryId}`);
        for (const targetId of [...draft.supersedes, ...draft.contradicts]) {
          if (!state.memories.has(targetId)) fail(`memory relationship target does not exist: ${targetId}`);
          if (targetId === draft.memoryId) fail("memory cannot relate to itself");
        }
        const item = {
          ...draft,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          createdRevision: event.revision,
          updatedRevision: event.revision,
          supersededBy: null,
          contradictedBy: [],
        };
        if (item.taskHash !== null) {
          if (!HASH.test(item.taskHash ?? "")) fail("memory taskHash must be a SHA-256");
          if (!state.tasks.has(item.taskHash)) fail(`memory references unknown task: ${item.taskHash}`);
        }
        state.memories.set(item.memoryId, item);
        for (const targetId of item.supersedes) {
          const target = state.memories.get(targetId);
          if (target.state !== "active") fail(`only active memory can be superseded: ${targetId}`);
          target.state = "superseded";
          target.supersededBy = item.memoryId;
          target.updatedAt = event.timestamp;
          target.updatedRevision = event.revision;
        }
        for (const targetId of item.contradicts) {
          const target = state.memories.get(targetId);
          target.contradictedBy = [...new Set([...target.contradictedBy, item.memoryId])];
          target.updatedAt = event.timestamp;
          target.updatedRevision = event.revision;
        }
        break;
      }
      case "memory_retired": {
        const memoryId = requireString(event.memoryId, "memoryId", 256);
        const target = state.memories.get(memoryId);
        if (!target) fail(`cannot retire unknown memory: ${memoryId}`);
        if (target.state !== "active") fail(`only active memory can be retired: ${memoryId}`);
        target.state = "retired";
        target.retirementReason = requireString(event.reason, "retirement reason", 20_000);
        target.updatedAt = event.timestamp;
        target.updatedRevision = event.revision;
        break;
      }
      case "task_started": {
        if (!HASH.test(event.taskHash ?? "")) fail("task_started requires a hashed task ID");
        if (state.tasks.has(event.taskHash)) fail(`task already exists: ${event.taskHash}`);
        state.tasks.set(event.taskHash, {
          taskHash: event.taskHash,
          status: "active",
          summary: requireString(event.summary, "task summary", 20_000),
          startedAt: event.timestamp,
          startedRevision: event.revision,
          completedAt: null,
          completedRevision: null,
          resultSummary: null,
          memoryIds: [],
          outputs: [],
        });
        break;
      }
      case "task_completed": {
        if (!HASH.test(event.taskHash ?? "")) fail("task_completed requires a hashed task ID");
        const task = state.tasks.get(event.taskHash);
        if (!task) fail(`cannot complete an unknown task: ${event.taskHash}`);
        if (task.status !== "active") fail(`task is already completed: ${event.taskHash}`);
        const memoryIds = stringArray(event.memoryIds, "task memoryIds");
        for (const memoryId of memoryIds) {
          if (!state.memories.has(memoryId)) fail(`task references unknown memory: ${memoryId}`);
        }
        const outputs = event.outputs ?? [];
        if (!Array.isArray(outputs)) fail("task outputs must be an array");
        task.status = "completed";
        task.completedAt = event.timestamp;
        task.completedRevision = event.revision;
        task.resultSummary = requireString(event.resultSummary, "task result summary", 100_000);
        task.memoryIds = memoryIds;
        task.outputs = outputs.map((output) => validateComputationArtifact(output));
        break;
      }
      case "handoff_built": {
        if (!HASH.test(event.taskHash ?? "")) fail("handoff_built requires a hashed task ID");
        if (!state.tasks.has(event.taskHash)) fail(`handoff references unknown task: ${event.taskHash}`);
        requireString(event.handoffId, "handoffId", 256);
        requireString(event.jsonPath, "handoff jsonPath", 4_096);
        requireString(event.markdownPath, "handoff markdownPath", 4_096);
        if (!HASH.test(event.jsonHash ?? "") || !HASH.test(event.markdownHash ?? "")) {
          fail("handoff hashes must be SHA-256 values");
        }
        state.handoffs.push({
          handoffId: event.handoffId,
          taskHash: event.taskHash,
          createdAt: event.timestamp,
          revision: event.revision,
          sourceRevision: event.sourceRevision,
          jsonPath: event.jsonPath,
          jsonHash: event.jsonHash,
          markdownPath: event.markdownPath,
          markdownHash: event.markdownHash,
        });
        break;
      }
      default:
        fail(`unhandled event type ${event.type}`);
    }
    state.revision = event.revision;
    state.updatedAt = event.timestamp;
  }
  return state;
}

export async function readLedger(support, projectId) {
  const paths = projectPaths(support, projectId);
  let text = "";
  try {
    text = await readFile(paths.ledger, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const events = [];
  if (text) {
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) fail(`blank line in append-only ledger at ${paths.ledger}:${index + 1}`);
      try {
        events.push(JSON.parse(line));
      } catch (error) {
        fail(`invalid append-only ledger at ${paths.ledger}:${index + 1}: ${error.message}`);
      }
    }
  }
  const state = applyEvents(projectId, events);
  return { paths, text, events, state, ledgerHash: sha256(text) };
}

function publicMemory(item) {
  return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null));
}

export function projectProjection(state, ledgerHash) {
  if (!state.metadata) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: state.projectId,
    name: state.metadata.name,
    description: state.metadata.description,
    createdAt: state.metadata.createdAt,
    updatedAt: state.updatedAt,
    revision: state.revision,
    ledgerHash,
  };
}

export function memoryProjection(state, ledgerHash) {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: state.projectId,
    revision: state.revision,
    ledgerHash,
    generatedAt: state.updatedAt,
    items: [...state.memories.values()]
      .sort((left, right) => left.createdRevision - right.createdRevision)
      .map(publicMemory),
  };
}

export function tasksProjection(state, ledgerHash) {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: state.projectId,
    revision: state.revision,
    ledgerHash,
    generatedAt: state.updatedAt,
    tasks: [...state.tasks.values()].sort((left, right) => left.startedRevision - right.startedRevision),
    handoffs: state.handoffs,
  };
}

async function writeProjectProjections(support, state, ledgerHash) {
  const paths = projectPaths(support, state.projectId);
  await atomicWrite(paths.project, `${JSON.stringify(projectProjection(state, ledgerHash), null, 2)}\n`);
  await atomicWrite(paths.memory, `${JSON.stringify(memoryProjection(state, ledgerHash), null, 2)}\n`);
  await atomicWrite(paths.tasks, `${JSON.stringify(tasksProjection(state, ledgerHash), null, 2)}\n`);
  for (const task of state.tasks.values()) {
    const taskPath = path.join(paths.taskRoot, task.taskHash, "task.json");
    await atomicWrite(taskPath, `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      projectId: state.projectId,
      revision: state.revision,
      ledgerHash,
      task,
      handoffs: state.handoffs.filter((handoff) => handoff.taskHash === task.taskHash),
    }, null, 2)}\n`);
  }
}

export async function listProjectIds(support) {
  const projectsRoot = path.join(support, "Projects");
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && PROJECT_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function rebuildRegistry(support, preferredActiveProjectId) {
  const registryPath = path.join(support, "Projects", "projects.json");
  const prior = await readJsonStrict(registryPath, { optional: true });
  const items = [];
  for (const projectId of await listProjectIds(support)) {
    const ledger = await readLedger(support, projectId);
    if (ledger.state.metadata) items.push(projectProjection(ledger.state, ledger.ledgerHash));
  }
  let activeProjectId = preferredActiveProjectId ?? prior?.activeProjectId ?? null;
  if (!items.some((item) => item.projectId === activeProjectId)) activeProjectId = items[0]?.projectId ?? null;
  const registry = {
    schemaVersion: SCHEMA_VERSION,
    activeProjectId,
    generatedAt: new Date().toISOString(),
    items,
  };
  await atomicWrite(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return registry;
}

async function appendEvents(ledger, payloads) {
  if (payloads.length === 0) return ledger;
  const timestamp = new Date().toISOString();
  const events = payloads.map((payload, index) => ({
    schemaVersion: SCHEMA_VERSION,
    eventId: randomUUID(),
    timestamp,
    projectId: ledger.state.projectId,
    revision: ledger.state.revision + index + 1,
    ...payload,
  }));
  const nextEvents = [...ledger.events, ...events];
  const nextState = applyEvents(ledger.state.projectId, nextEvents);
  const prefix = ledger.text && !ledger.text.endsWith("\n") ? "\n" : "";
  const delta = `${prefix}${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await mkdir(path.dirname(ledger.paths.ledger), { recursive: true });
  const handle = await open(ledger.paths.ledger, "a", 0o600);
  try {
    await handle.write(delta, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const nextText = `${ledger.text}${delta}`;
  return {
    ...ledger,
    text: nextText,
    events: nextEvents,
    state: nextState,
    ledgerHash: sha256(nextText),
    appendedEvents: events,
  };
}

export async function mutateProject(
  support,
  projectId,
  { expectedRevision, activate = false } = {},
  buildPayloads,
) {
  assertProjectId(projectId);
  return withMemoryLock(support, async () => {
    let ledger = await readLedger(support, projectId);
    if (expectedRevision !== undefined && ledger.state.revision !== expectedRevision) {
      fail(`revision conflict for ${projectId}: expected ${expectedRevision}, current ${ledger.state.revision}`);
    }
    const payloads = await buildPayloads(ledger.state);
    if (!Array.isArray(payloads)) fail("internal error: mutation builder must return an event array");
    ledger = await appendEvents(ledger, payloads);
    if (ledger.state.metadata) await writeProjectProjections(support, ledger.state, ledger.ledgerHash);
    const registry = await rebuildRegistry(support, activate ? projectId : undefined);
    return { ...ledger, registry };
  });
}

export async function resolveProjectId(support, explicit) {
  if (explicit) return assertProjectId(explicit);
  if (process.env.LITEVERSE_PROJECT_ID) return assertProjectId(process.env.LITEVERSE_PROJECT_ID);
  const registryPath = path.join(support, "Projects", "projects.json");
  const registry = await readJsonStrict(registryPath, { optional: true });
  if (registry?.activeProjectId) return assertProjectId(registry.activeProjectId);
  const projectIds = await listProjectIds(support);
  if (projectIds.length === 1) return projectIds[0];
  if (projectIds.length === 0) fail("no Liteverse project exists; run project create-or-init first");
  fail("multiple projects exist and none is active; pass --project or set LITEVERSE_PROJECT_ID");
}

export async function projectionHealth(ledger) {
  const expected = { revision: ledger.state.revision, ledgerHash: ledger.ledgerHash };
  const results = {};
  for (const [key, filePath] of [["project", ledger.paths.project], ["memory", ledger.paths.memory], ["tasks", ledger.paths.tasks]]) {
    try {
      const value = await readJsonStrict(filePath);
      results[key] = {
        ok: value.revision === expected.revision && value.ledgerHash === expected.ledgerHash,
        revision: value.revision ?? null,
        ledgerHash: value.ledgerHash ?? null,
      };
    } catch (error) {
      results[key] = { ok: false, error: error.message };
    }
  }
  return results;
}

export async function parseJsonArrayFile(filePath, label) {
  if (!filePath) return [];
  let value;
  try {
    value = JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    fail(`cannot read ${label} JSON file ${filePath}: ${error.message}`);
  }
  if (!Array.isArray(value)) fail(`${label} JSON file must contain an array`);
  return value;
}

export async function parseJsonObjectFile(filePath, label) {
  if (!filePath) return null;
  let value;
  try {
    value = JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    fail(`cannot read ${label} JSON file ${filePath}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} JSON file must contain an object`);
  return value;
}

export async function importResearchInformation(filePath) {
  let text;
  let sourceRevision = null;
  const absolutePath = path.resolve(filePath);
  try {
    const raw = await readFile(absolutePath, "utf8");
    if (absolutePath.toLowerCase().endsWith(".json")) {
      const value = JSON.parse(raw);
      text = value?.formal?.text ?? value?.draft?.text;
      sourceRevision = value?.formal?.sourceRevision ?? value?.draft?.revision ?? null;
      if (typeof text !== "string") fail("research-information JSON has no formal.text or draft.text");
    } else {
      text = raw;
    }
  } catch (error) {
    fail(`cannot import research information from ${absolutePath}: ${error.message}`);
  }
  return { absolutePath, text, sourceRevision, sourceHash: sha256(text) };
}

export function memorySearchScore(item, queryTerms) {
  if (queryTerms.length === 0) return 1;
  const fields = [item.title, item.content, item.type, item.evidenceState, item.provenance]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (item.title.toLocaleLowerCase().includes(term)) score += 6;
    if (item.type.toLocaleLowerCase().includes(term)) score += 3;
    const occurrences = fields.split(term).length - 1;
    score += Math.min(occurrences, 8);
  }
  return score;
}

export function relativeToSupport(support, filePath) {
  const relative = path.relative(support, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("path must remain inside Liteverse support directory");
  return relative.split(path.sep).join("/");
}

export async function writeHandoffArtifacts(support, state, taskHash, nextRevision) {
  const task = state.tasks.get(taskHash);
  if (!task) fail(`cannot build handoff for unknown task: ${taskHash}`);
  const sourceRevision = state.revision;
  const handoffId = `handoff-${sha256(`${state.projectId}:${taskHash}:${nextRevision}`).slice(0, 20)}`;
  const activeMemories = [...state.memories.values()]
    .filter((item) => item.state === "active")
    .sort((left, right) => left.createdRevision - right.createdRevision)
    .map(publicMemory);
  const unresolvedConflicts = activeMemories
    .filter((item) => item.contradicts.length > 0 || item.contradictedBy.length > 0)
    .map((item) => ({ memoryId: item.memoryId, contradicts: item.contradicts, contradictedBy: item.contradictedBy }));
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    handoffId,
    projectId: state.projectId,
    taskHash,
    sourceRevision,
    task,
    project: {
      name: state.metadata.name,
      description: state.metadata.description,
    },
    activeMemories,
    unresolvedConflicts,
    openQuestions: activeMemories.filter((item) => item.type === "open_question"),
    nextSteps: activeMemories.filter((item) => item.type === "next_step"),
  };
  const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
  const markdownLines = [
    `# Liteverse task handoff: ${state.metadata.name}`,
    "",
    `- Project: \`${state.projectId}\``,
    `- Task hash: \`${taskHash}\``,
    `- Source revision: ${sourceRevision}`,
    `- Task status: ${task.status}`,
    "",
    "## Task",
    "",
    task.summary,
  ];
  if (task.resultSummary) markdownLines.push("", "## Result", "", task.resultSummary);
  markdownLines.push("", "## Active project memory", "");
  for (const item of activeMemories) {
    markdownLines.push(
      `### ${item.title}`,
      "",
      `- ID: \`${item.memoryId}\``,
      `- Type: \`${item.type}\``,
      `- Evidence: \`${item.evidenceState}\` via \`${item.provenance}\``,
      "",
      item.content,
      "",
    );
  }
  if (unresolvedConflicts.length > 0) {
    markdownLines.push("## Unresolved conflicts", "");
    for (const conflict of unresolvedConflicts) {
      markdownLines.push(`- \`${conflict.memoryId}\`: contradicts [${conflict.contradicts.join(", ")}], contradicted by [${conflict.contradictedBy.join(", ")}]`);
    }
    markdownLines.push("");
  }
  const markdownText = `${markdownLines.join("\n").trimEnd()}\n`;
  const root = path.join(
    projectPaths(support, state.projectId).taskRoot,
    taskHash,
    "handoffs",
  );
  const jsonPath = path.join(root, `${handoffId}.json`);
  const markdownPath = path.join(root, `${handoffId}.md`);
  await atomicWrite(jsonPath, jsonText);
  await atomicWrite(markdownPath, markdownText);
  return {
    handoffId,
    sourceRevision,
    jsonPath,
    jsonHash: sha256(jsonText),
    markdownPath,
    markdownHash: sha256(markdownText),
    payload,
  };
}
