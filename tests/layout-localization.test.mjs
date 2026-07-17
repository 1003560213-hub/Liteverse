import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildLocalizedLayout } from "../skills/liteverse-curator/scripts/prepare-layout-localization.mjs";
import { summarizeProjectedNebulaOverlap } from "../skills/liteverse-curator/scripts/partition-layout-profile.mjs";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function paper(id, primaryCategory) {
  return {
    id,
    title: `Paper ${id}`,
    primaryCategory,
    categoryIds: [primaryCategory],
    summary: "\u4e2d\u6587\u6458\u8981",
    projectRole: "\u5206\u7c7b\uff1a\u4e3b\u533a\u57df\u3002",
    tags: ["\u521d\u6001"],
    artifacts: {
      integrity: {
        artifactRevision: 1,
        artifactSha256: hash(`artifact:${id}`),
      },
    },
  };
}

test("interface localization translates visible graph fields and forces a deterministic 3D relayout", () => {
  const categoryIds = ["region-a", "region-b"];
  const papers = categoryIds.flatMap((categoryId) => Array.from(
    { length: 4 },
    (_, index) => paper(`${categoryId}-paper-${index + 1}`, categoryId),
  ));
  const current = {
    schemaVersion: "3.0.0",
    revision: 4,
    title: "\u4e2d\u6587\u6587\u732e\u5b87\u5b99",
    updated: "2026-07-14T00:00:00.000Z",
    visuals: { nebulaAssignmentSeed: "test-seed", nebulaAssets: [] },
    categories: categoryIds.map((id, index) => ({
      id,
      kind: "macro",
      name: `\u533a\u57df ${index + 1}`,
      description: "\u4e2d\u6587\u63cf\u8ff0",
      color: index ? "#41F0A8" : "#54D7FF",
      center: index ? [0.15, 0.1, 0.05] : [0, 0, 0],
      creationEvidence: {
        memberIds: papers.filter((item) => item.primaryCategory === id).map((item) => item.id),
        existingRegionMatchScores: {},
        clusterConsistency: 80,
        scopeDefinition: "\u4e2d\u6587\u8303\u56f4",
      },
    })),
    papers,
    relations: [{
      id: "relation-a-b",
      source: papers[0].id,
      target: papers[4].id,
      type: "methodological",
      label: "\u65b9\u6cd5\u7ee7\u627f",
      status: "candidate",
      strength: 55,
      confidence: 70,
    }],
  };
  const translations = {
    schemaVersion: "liteverse-interface-localization-v1",
    locale: "en",
    baseRevision: 4,
    title: "English Literature Universe",
    categories: Object.fromEntries(categoryIds.map((id, index) => [id, {
      name: `Region ${index + 1}`,
      description: `English description ${index + 1}`,
      scopeDefinition: `English scope ${index + 1}`,
    }])),
    papers: Object.fromEntries(papers.map((item) => [item.id, {
      summary: `English summary for ${item.id}.`,
      projectRole: `Primary region: ${item.primaryCategory}.`,
      tags: ["initial conditions"],
    }])),
    relations: { "relation-a-b": { label: "Method inheritance" } },
  };
  const options = {
    decisionTime: "2026-07-15T10:00:00.000Z",
    confirmationNote: "User requested an English private interface and background-aware relayout.",
    sourceGraphSha256: hash("current graph"),
  };
  const first = buildLocalizedLayout(current, translations, options);
  const repeated = buildLocalizedLayout(current, translations, options);
  assert.deepEqual(repeated, first);
  assert.equal(first.revision, 5);
  assert.equal(first.title, "English Literature Universe");
  assert.equal(first.visuals.interfaceLocale, "en");
  assert.equal(first.visuals.partitionLayoutAlgorithm, "background-aware-v1");
  assert.equal(first.relations[0].label, "Method inheritance");
  assert.ok(!/[\u3400-\u9fff\uf900-\ufaff]/u.test(JSON.stringify({
    title: first.title,
    categories: first.categories,
    papers: first.papers.map(({ summary, projectRole, tags }) => ({ summary, projectRole, tags })),
    relations: first.relations.map(({ label }) => ({ label })),
  })));
  assert.notDeepEqual(first.categories.map((category) => category.center), current.categories.map((category) => category.center));
  assert.ok(first.categories.some((category) => Math.abs(category.center[2]) > 0.05));
  assert.equal(summarizeProjectedNebulaOverlap(first.categories.map((category) => category.center)).overlapCount, 0);
  assert.deepEqual(
    first.papers.map((item) => item.artifacts.integrity),
    current.papers.map((item) => item.artifacts.integrity),
  );
  assert.deepEqual(
    first.papers.map(({ id, primaryCategory, categoryIds }) => ({ id, primaryCategory, categoryIds })),
    current.papers.map(({ id, primaryCategory, categoryIds }) => ({ id, primaryCategory, categoryIds })),
  );
});
