#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const rubric = Object.freeze({
  directDependency: new Set([0, 12, 24, 35]),
  coreQuestion: new Set([0, 8, 16, 25]),
  methodContinuity: new Set([0, 7, 14, 20]),
  resultRelationship: new Set([0, 7, 14, 20]),
});

function fail(message) {
  throw new Error(message);
}

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function usage() {
  console.log(`Usage: score-connection.mjs [--input relation.json] [--output scored.json]

Read JSON from --input or stdin. Each of the four components must contain an
allowed score and evidenceIds. Confidence components are 0..100. Output is
deterministic and contains separate strength, confidence, and publication state.`);
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function finitePercent(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    fail(`${label} must be a finite number from 0 through 100`);
  }
  return value;
}

function locatorValue(value, evidenceId, field) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      fail(`evidence ${evidenceId} ${field} must be a positive integer when numeric`);
    }
    return true;
  }
  if (typeof value !== "string" || !value.trim()) return false;
  const trimmed = value.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed) && (!Number.isInteger(Number(trimmed)) || Number(trimmed) <= 0)) {
    fail(`evidence ${evidenceId} ${field} must be a positive integer when numeric`);
  }
  return true;
}

function preciseLocator(evidence) {
  const locator = evidence.locator && typeof evidence.locator === "object"
    ? evidence.locator
    : evidence;
  const values = ["page", "section", "equation", "figure", "table"].map((field) =>
    locatorValue(locator[field], evidence.id, field));
  return values.some(Boolean);
}

function score(input) {
  object(input, "root");
  if (typeof input.source !== "string" || !input.source.trim()) fail("source must be a paper ID");
  if (typeof input.target !== "string" || !input.target.trim()) fail("target must be a paper ID");
  if (input.source === input.target) fail("source and target must be different papers");

  const components = object(input.components, "components");
  const evidence = Array.isArray(input.evidence) ? input.evidence : fail("evidence must be an array");
  const evidenceById = new Map();
  for (const [index, raw] of evidence.entries()) {
    const item = object(raw, `evidence[${index}]`);
    if (typeof item.id !== "string" || !item.id.trim()) fail(`evidence[${index}].id must be a string`);
    if (evidenceById.has(item.id)) fail(`duplicate evidence ID: ${item.id}`);
    if (![input.source, input.target].includes(item.paperId)) {
      fail(`evidence ${item.id} paperId must equal source or target`);
    }
    if (typeof item.paraphrase !== "string" || !item.paraphrase.trim()) {
      fail(`evidence ${item.id} requires a faithful paraphrase`);
    }
    preciseLocator(item);
    evidenceById.set(item.id, item);
  }

  const normalizedComponents = {};
  const referencedEvidence = new Set();
  let strength = 0;
  for (const [name, allowed] of Object.entries(rubric)) {
    const component = object(components[name], `components.${name}`);
    if (!allowed.has(component.score)) {
      fail(`components.${name}.score must be one of ${[...allowed].join(", ")}`);
    }
    const evidenceIds = component.evidenceIds ?? [];
    if (!Array.isArray(evidenceIds) || evidenceIds.some((id) => typeof id !== "string")) {
      fail(`components.${name}.evidenceIds must be an array of strings`);
    }
    if (component.score > 0 && evidenceIds.length === 0) {
      fail(`components.${name} has a nonzero score but no evidence IDs`);
    }
    const uniqueIds = [...new Set(evidenceIds)].sort();
    for (const id of uniqueIds) {
      if (!evidenceById.has(id)) fail(`components.${name} references unknown evidence ID ${id}`);
      referencedEvidence.add(id);
    }
    normalizedComponents[name] = { score: component.score, evidenceIds: uniqueIds };
    strength += component.score;
  }

  const confidenceInput = object(input.confidenceComponents ?? input.confidence, "confidenceComponents");
  const confidenceComponents = {
    sourceCoverage: finitePercent(confidenceInput.sourceCoverage, "confidenceComponents.sourceCoverage"),
    locatorPrecision: finitePercent(confidenceInput.locatorPrecision, "confidenceComponents.locatorPrecision"),
    crossConfirmation: finitePercent(confidenceInput.crossConfirmation, "confidenceComponents.crossConfirmation"),
  };
  const confidence = Math.round(
    confidenceComponents.sourceCoverage * 0.4
    + confidenceComponents.locatorPrecision * 0.35
    + confidenceComponents.crossConfirmation * 0.25,
  );

  const locatedPapers = new Set(
    [...referencedEvidence]
      .map((id) => evidenceById.get(id))
      .filter(preciseLocator)
      .map((item) => item.paperId),
  );
  const formalEligible = locatedPapers.has(input.source) && locatedPapers.has(input.target);
  let status = "suggestion";
  if (formalEligible && strength >= 60 && confidence >= 75) status = "verified";
  else if (formalEligible && strength >= 40 && confidence >= 50) status = "candidate";

  const reason = formalEligible
    ? status === "verified"
      ? "strength and confidence meet the verified threshold"
      : status === "candidate"
        ? "strength and confidence meet the candidate threshold"
        : "strength or confidence is below the display threshold"
    : "located original-source evidence is required from both papers";

  const passthrough = {};
  for (const name of ["id", "type", "relationType", "label", "note", "directional", "projectRelevance", "annotationProvenance"]) {
    if (input[name] !== undefined) passthrough[name] = input[name];
  }
  return {
    ...passthrough,
    source: input.source,
    target: input.target,
    rubric: "liteverse-relation-v1",
    components: normalizedComponents,
    strength,
    confidence,
    confidenceComponents,
    formalEligible,
    status,
    display: status === "verified" ? "solid" : status === "candidate" ? "dashed" : "hidden",
    decisionReason: reason,
    evidenceCount: evidence.length,
    evidence,
  };
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    usage();
    return;
  }
  const inputPath = argument("--input");
  const outputPath = argument("--output");
  const text = inputPath ? await readFile(inputPath, "utf8") : await stdinText();
  if (!text.trim()) fail("no input JSON supplied");
  let input;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail(`invalid input JSON: ${error.message}`);
  }
  const serialized = `${JSON.stringify(score(input), null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, "utf8");
  else process.stdout.write(serialized);
}

main().catch((error) => {
  console.error(`score-connection: ${error.message}`);
  process.exitCode = 2;
});
