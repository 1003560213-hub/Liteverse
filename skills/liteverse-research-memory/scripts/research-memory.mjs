#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import {
  EVIDENCE_STATES,
  MEMORY_STATES,
  MEMORY_TYPES,
  PROVENANCE,
  assertProjectId,
  hashTaskId,
  importResearchInformation,
  listProjectIds,
  memorySearchScore,
  mutateProject,
  parseJsonArrayFile,
  parseJsonObjectFile,
  projectProjection,
  projectionHealth,
  readLedger,
  relativeToSupport,
  resolveProjectId,
  resolveRawTaskId,
  resolveSupport,
  validateComputationArtifact,
  validateMemoryDraft,
  validatePaperEvidence,
  writeHandoffArtifacts,
} from "./_memory-store.mjs";

function parseArguments(argv) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h") {
      flags.set("--help", [true]);
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    let key = token;
    let value = true;
    if (equals >= 0) {
      key = token.slice(0, equals);
      value = token.slice(equals + 1);
    } else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) {
      value = argv[index + 1];
      index += 1;
    }
    const prior = flags.get(key) ?? [];
    prior.push(value);
    flags.set(key, prior);
  }
  return { positionals, flags };
}

function one(args, name) {
  const values = args.flags.get(name) ?? [];
  if (values.length > 1) throw new Error(`${name} may be provided only once`);
  return values[0];
}

function many(args, name) {
  return args.flags.get(name) ?? [];
}

function present(args, name) {
  return args.flags.has(name);
}

function textValue(value, name, { required = false } = {}) {
  if (value === true || value === undefined) {
    if (required) throw new Error(`${name} requires a value`);
    return undefined;
  }
  return String(value);
}

function integerValue(value, name) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function boundedInteger(value, name, fallback, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return parsed;
}

function emit(value, args, human) {
  if (present(args, "--json")) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(human(value));
  }
}

function usage() {
  console.log(`Usage: research-memory.mjs <command> [options]

Commands:
  status [--project ID] [--json]
  search --query TEXT [--project ID | --all-projects] [filters]
  project create-or-init --project ID [--name NAME] [--description TEXT]
      [--import-existing-research | --import-research-information FILE] [--activate]
  task begin --project ID --summary TEXT [--task-id ID]
  task complete --project ID --result-summary TEXT [--task-id ID]
      [--memory-id ID ...] [--outputs-file JSON]
  record memory --project ID --type TYPE --title TITLE --content TEXT
      --provenance PROVENANCE [--evidence-state STATE] [--state STATE]
      [--paper-evidence-file JSON] [--artifact-file JSON]
      [--supersedes ID ...] [--contradicts ID ...] [--memory-id ID]
  record memory --project ID --retire MEMORY-ID --reason TEXT
  handoff build --project ID [--task-id ID]

Common options:
  --support-dir DIR       Application Support root (or LITEVERSE_SUPPORT_DIR)
  --project ID           Project ID (or LITEVERSE_PROJECT_ID / active project)
  --expected-revision N  Optimistic concurrency guard for every mutation
  --task-id ID           Controlled test/recovery override only
  --json                 Machine-readable output

Task IDs resolve from LITEVERSE_TASK_ID, then CODEX_THREAD_ID, and are persisted only as SHA-256.
Paper evidence must come from Retriever and contain paperId, claimId, evidenceId, and artifactHash.`);
}

function common(args) {
  const support = resolveSupport(textValue(one(args, "--support-dir"), "--support-dir"));
  const expectedRevision = integerValue(textValue(one(args, "--expected-revision"), "--expected-revision"), "--expected-revision");
  return { support, expectedRevision };
}

async function statusCommand(args) {
  const { support } = common(args);
  const explicitProject = textValue(one(args, "--project"), "--project");
  const projectIds = explicitProject ? [assertProjectId(explicitProject)] : await listProjectIds(support);
  const projects = [];
  for (const projectId of projectIds) {
    const ledger = await readLedger(support, projectId);
    if (!ledger.state.metadata) {
      projects.push({ projectId, initialized: false, revision: 0, ledgerHash: ledger.ledgerHash });
      continue;
    }
    const health = await projectionHealth(ledger);
    const memories = [...ledger.state.memories.values()];
    const tasks = [...ledger.state.tasks.values()];
    projects.push({
      ...projectProjection(ledger.state, ledger.ledgerHash),
      initialized: true,
      memoryCount: memories.length,
      activeMemoryCount: memories.filter((item) => item.state === "active").length,
      unresolvedConflictCount: memories.filter((item) => item.contradicts.length > 0 || item.contradictedBy.length > 0).length,
      activeTaskCount: tasks.filter((task) => task.status === "active").length,
      completedTaskCount: tasks.filter((task) => task.status === "completed").length,
      handoffCount: ledger.state.handoffs.length,
      projectionHealth: health,
    });
  }
  const value = { schemaVersion: 1, supportDirectory: support, projectCount: projects.length, projects };
  emit(value, args, (result) => {
    if (result.projects.length === 0) return `No Liteverse projects in ${result.supportDirectory}`;
    return result.projects.map((project) => {
      if (!project.initialized) return `${project.projectId}: uninitialized`;
      const healthy = Object.values(project.projectionHealth).every((entry) => entry.ok);
      return `${project.projectId} r${project.revision}: ${project.activeMemoryCount}/${project.memoryCount} active memories, ${project.activeTaskCount} active tasks, projections ${healthy ? "healthy" : "STALE"}`;
    }).join("\n");
  });
}

function queryTerms(query) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  const terms = normalized.split(/[\s,;，；]+/u).filter(Boolean);
  return [...new Set([normalized, ...terms])];
}

async function searchCommand(args) {
  const { support } = common(args);
  const query = textValue(one(args, "--query"), "--query", { required: true });
  const allProjects = present(args, "--all-projects");
  const explicitProject = textValue(one(args, "--project"), "--project");
  if (allProjects && explicitProject) throw new Error("choose either --project or --all-projects");
  const projectIds = allProjects
    ? await listProjectIds(support)
    : [await resolveProjectId(support, explicitProject)];
  const stateFilter = textValue(one(args, "--state"), "--state") ?? "active";
  const typeFilter = textValue(one(args, "--type"), "--type");
  const evidenceFilter = textValue(one(args, "--evidence-state"), "--evidence-state");
  const provenanceFilter = textValue(one(args, "--provenance"), "--provenance");
  if (stateFilter !== "all" && !MEMORY_STATES.has(stateFilter)) throw new Error(`unsupported --state ${stateFilter}`);
  if (typeFilter && !MEMORY_TYPES.has(typeFilter)) throw new Error(`unsupported --type ${typeFilter}`);
  if (evidenceFilter && !EVIDENCE_STATES.has(evidenceFilter)) throw new Error(`unsupported --evidence-state ${evidenceFilter}`);
  if (provenanceFilter && !PROVENANCE.has(provenanceFilter)) throw new Error(`unsupported --provenance ${provenanceFilter}`);
  const limit = boundedInteger(textValue(one(args, "--limit"), "--limit"), "--limit", 20, 200);
  const terms = queryTerms(query);
  const results = [];
  for (const projectId of projectIds) {
    const ledger = await readLedger(support, projectId);
    for (const item of ledger.state.memories.values()) {
      if (stateFilter !== "all" && item.state !== stateFilter) continue;
      if (typeFilter && item.type !== typeFilter) continue;
      if (evidenceFilter && item.evidenceState !== evidenceFilter) continue;
      if (provenanceFilter && item.provenance !== provenanceFilter) continue;
      const score = memorySearchScore(item, terms);
      if (score <= 0) continue;
      results.push({
        projectId,
        revision: ledger.state.revision,
        score,
        memoryId: item.memoryId,
        type: item.type,
        title: item.title,
        content: item.content,
        state: item.state,
        evidenceState: item.evidenceState,
        provenance: item.provenance,
        paperEvidence: item.paperEvidence,
        computationArtifact: item.computationArtifact,
        supersedes: item.supersedes,
        contradicts: item.contradicts,
        contradictedBy: item.contradictedBy,
      });
    }
  }
  results.sort((left, right) => right.score - left.score || right.revision - left.revision || left.memoryId.localeCompare(right.memoryId));
  const value = { schemaVersion: 1, query, projectIds, resultCount: Math.min(results.length, limit), results: results.slice(0, limit) };
  emit(value, args, (result) => result.results.length === 0
    ? "No project memory matched."
    : result.results.map((item) => `[${item.projectId}] ${item.memoryId} - ${item.title} (${item.evidenceState}/${item.provenance})\n${item.content}`).join("\n\n"));
}

async function projectCommand(args) {
  const { support, expectedRevision } = common(args);
  const projectId = assertProjectId(textValue(one(args, "--project"), "--project", { required: true }));
  const explicitName = textValue(one(args, "--name"), "--name");
  const explicitDescription = textValue(one(args, "--description"), "--description");
  const importExisting = present(args, "--import-existing-research");
  const importFile = textValue(one(args, "--import-research-information"), "--import-research-information");
  if (importExisting && importFile) throw new Error("choose one research-information import option");
  const imported = (importExisting || importFile)
    ? await importResearchInformation(importFile ?? path.join(support, "research-information.json"))
    : null;
  const result = await mutateProject(
    support,
    projectId,
    { expectedRevision, activate: present(args, "--activate") },
    async (state) => {
      const payloads = [];
      if (!state.metadata) {
        payloads.push({
          type: "project_initialized",
          name: explicitName ?? projectId,
          description: explicitDescription ?? "",
        });
      } else {
        const update = { type: "project_metadata_updated" };
        if (explicitName !== undefined && explicitName !== state.metadata.name) update.name = explicitName;
        if (explicitDescription !== undefined && explicitDescription !== state.metadata.description) update.description = explicitDescription;
        if (Object.keys(update).length > 1) payloads.push(update);
      }
      if (imported) {
        const alreadyImported = [...state.memories.values()].some(
          (item) => item.source?.kind === "legacy_research_information" && item.source.sourceHash === imported.sourceHash,
        );
        if (!alreadyImported) {
          payloads.push({
            type: "memory_recorded",
            memory: validateMemoryDraft({
              memoryId: `mem-imported-${imported.sourceHash.slice(0, 20)}`,
              type: "project_context",
              title: "Imported Research Information",
              content: imported.text,
              state: "active",
              evidenceState: "user_declared",
              provenance: "user",
              source: {
                kind: "legacy_research_information",
                sourceHash: imported.sourceHash,
                sourceRevision: imported.sourceRevision,
              },
            }),
          });
        }
      }
      return payloads;
    },
  );
  const value = {
    project: projectProjection(result.state, result.ledgerHash),
    appendedEvents: result.appendedEvents?.map((event) => ({ eventId: event.eventId, type: event.type, revision: event.revision })) ?? [],
    importedResearchInformation: imported ? { sourceHash: imported.sourceHash, sourceRevision: imported.sourceRevision } : null,
    activeProjectId: result.registry.activeProjectId,
  };
  emit(value, args, (output) => `${output.project.projectId} ready at revision ${output.project.revision}; ${output.appendedEvents.length} event(s) appended`);
}

function taskHashFromArgs(args) {
  const explicit = textValue(one(args, "--task-id"), "--task-id");
  return hashTaskId(resolveRawTaskId(explicit));
}

async function taskBeginCommand(args) {
  const { support, expectedRevision } = common(args);
  const projectId = await resolveProjectId(support, textValue(one(args, "--project"), "--project"));
  const taskHash = taskHashFromArgs(args);
  const summary = textValue(one(args, "--summary"), "--summary", { required: true });
  const result = await mutateProject(support, projectId, { expectedRevision }, async (state) => {
    if (!state.metadata) throw new Error(`project is not initialized: ${projectId}`);
    const existing = state.tasks.get(taskHash);
    if (existing) {
      if (existing.summary !== summary) throw new Error("task already exists with a different summary");
      return [];
    }
    return [{ type: "task_started", taskHash, summary }];
  });
  const task = result.state.tasks.get(taskHash);
  const value = {
    projectId,
    revision: result.state.revision,
    task,
    started: (result.appendedEvents?.length ?? 0) > 0,
  };
  emit(value, args, (output) => `${output.started ? "Started" : "Reused"} task ${output.task.taskHash} in ${output.projectId} at revision ${output.revision}`);
}

async function taskCompleteCommand(args) {
  const { support, expectedRevision } = common(args);
  const projectId = await resolveProjectId(support, textValue(one(args, "--project"), "--project"));
  const taskHash = taskHashFromArgs(args);
  const resultSummary = textValue(one(args, "--result-summary"), "--result-summary", { required: true });
  const memoryIds = many(args, "--memory-id").map((value) => textValue(value, "--memory-id", { required: true }));
  const rawOutputs = await parseJsonArrayFile(textValue(one(args, "--outputs-file"), "--outputs-file"), "outputs");
  const outputs = rawOutputs.map((output) => validateComputationArtifact(output));
  const result = await mutateProject(support, projectId, { expectedRevision }, async (state) => {
    const task = state.tasks.get(taskHash);
    if (!task) throw new Error(`cannot complete unknown task ${taskHash}`);
    if (task.status === "completed") {
      const same = task.resultSummary === resultSummary
        && JSON.stringify(task.memoryIds) === JSON.stringify(memoryIds)
        && JSON.stringify(task.outputs) === JSON.stringify(outputs);
      if (!same) throw new Error("task is already completed with different immutable result metadata");
      return [];
    }
    return [{ type: "task_completed", taskHash, resultSummary, memoryIds, outputs }];
  });
  const task = result.state.tasks.get(taskHash);
  const value = {
    projectId,
    revision: result.state.revision,
    task,
    completed: (result.appendedEvents?.length ?? 0) > 0,
  };
  emit(value, args, (output) => `${output.completed ? "Completed" : "Reused completed"} task ${output.task.taskHash} at revision ${output.revision}`);
}

async function recordMemoryCommand(args) {
  const { support, expectedRevision } = common(args);
  const projectId = await resolveProjectId(support, textValue(one(args, "--project"), "--project"));
  const retireId = textValue(one(args, "--retire"), "--retire");
  if (retireId) {
    const reason = textValue(one(args, "--reason"), "--reason", { required: true });
    const result = await mutateProject(support, projectId, { expectedRevision }, async (state) => {
      const target = state.memories.get(retireId);
      if (!target) throw new Error(`unknown memory: ${retireId}`);
      if (target.state === "retired") return [];
      if (target.state !== "active") throw new Error(`only active memory can be retired: ${retireId}`);
      return [{ type: "memory_retired", memoryId: retireId, reason }];
    });
    const value = { projectId, revision: result.state.revision, memory: result.state.memories.get(retireId), retired: (result.appendedEvents?.length ?? 0) > 0 };
    emit(value, args, (output) => `${output.memory.memoryId} ${output.retired ? "retired" : "was already retired"} at revision ${output.revision}`);
    return;
  }
  const paperEvidenceRaw = await parseJsonArrayFile(
    textValue(one(args, "--paper-evidence-file"), "--paper-evidence-file"),
    "paper evidence",
  );
  const artifactRaw = await parseJsonObjectFile(textValue(one(args, "--artifact-file"), "--artifact-file"), "artifact");
  const rawTaskId = resolveRawTaskId(textValue(one(args, "--task-id"), "--task-id"));
  const draft = validateMemoryDraft({
    memoryId: textValue(one(args, "--memory-id"), "--memory-id"),
    type: textValue(one(args, "--type"), "--type", { required: true }),
    title: textValue(one(args, "--title"), "--title", { required: true }),
    content: textValue(one(args, "--content"), "--content", { required: true }),
    state: textValue(one(args, "--state"), "--state") ?? "active",
    evidenceState: textValue(one(args, "--evidence-state"), "--evidence-state"),
    provenance: textValue(one(args, "--provenance"), "--provenance", { required: true }),
    supersedes: many(args, "--supersedes").map((value) => textValue(value, "--supersedes", { required: true })),
    contradicts: many(args, "--contradicts").map((value) => textValue(value, "--contradicts", { required: true })),
    paperEvidence: validatePaperEvidence(paperEvidenceRaw),
    computationArtifact: artifactRaw,
    taskHash: rawTaskId ? hashTaskId(rawTaskId) : null,
  });
  const result = await mutateProject(support, projectId, { expectedRevision }, async (state) => {
    if (!state.metadata) throw new Error(`project is not initialized: ${projectId}`);
    if (draft.taskHash && !state.tasks.has(draft.taskHash)) {
      throw new Error("memory taskHash does not match a begun project task; run task begin first");
    }
    if (state.memories.has(draft.memoryId)) throw new Error(`memory ID already exists: ${draft.memoryId}`);
    return [{ type: "memory_recorded", memory: draft }];
  });
  const memory = result.state.memories.get(draft.memoryId);
  const value = { projectId, revision: result.state.revision, memory };
  emit(value, args, (output) => `${output.memory.memoryId} recorded at revision ${output.revision} (${output.memory.evidenceState}/${output.memory.provenance})`);
}

async function handoffBuildCommand(args) {
  const { support, expectedRevision } = common(args);
  const projectId = await resolveProjectId(support, textValue(one(args, "--project"), "--project"));
  const taskHash = taskHashFromArgs(args);
  let artifact;
  const result = await mutateProject(support, projectId, { expectedRevision }, async (state) => {
    artifact = await writeHandoffArtifacts(support, state, taskHash, state.revision + 1);
    return [{
      type: "handoff_built",
      taskHash,
      handoffId: artifact.handoffId,
      sourceRevision: artifact.sourceRevision,
      jsonPath: relativeToSupport(support, artifact.jsonPath),
      jsonHash: artifact.jsonHash,
      markdownPath: relativeToSupport(support, artifact.markdownPath),
      markdownHash: artifact.markdownHash,
    }];
  });
  const value = {
    projectId,
    revision: result.state.revision,
    taskHash,
    handoffId: artifact.handoffId,
    sourceRevision: artifact.sourceRevision,
    jsonPath: artifact.jsonPath,
    jsonHash: artifact.jsonHash,
    markdownPath: artifact.markdownPath,
    markdownHash: artifact.markdownHash,
  };
  emit(value, args, (output) => `${output.handoffId} built from revision ${output.sourceRevision}\n${output.markdownPath}\n${output.jsonPath}`);
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (present(args, "--help") || present(args, "-h") || args.positionals.length === 0) {
    usage();
    return;
  }
  const [first, second] = args.positionals;
  if (first === "status" && second === undefined) return statusCommand(args);
  if (first === "search" && second === undefined) return searchCommand(args);
  if (first === "project" && second === "create-or-init") return projectCommand(args);
  if (first === "task" && second === "begin") return taskBeginCommand(args);
  if (first === "task" && second === "complete") return taskCompleteCommand(args);
  if ((first === "record" && second === "memory") || (first === "memory" && second === "record")) return recordMemoryCommand(args);
  if ((first === "handoff" && second === "build") || (first === "build" && second === "handoff")) return handoffBuildCommand(args);
  throw new Error(`unknown research-memory command: ${args.positionals.join(" ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(`research-memory: ${error.message}`);
    process.exitCode = 2;
  });
}
