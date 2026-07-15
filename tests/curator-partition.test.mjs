import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assignCategoryNebulaAssets,
  assignDeterministicPartitionLayout,
  isFiniteVector3,
} from "../skills/liteverse-curator/scripts/partition-contract.mjs";
import {
  backgroundFootprintCost,
  DEFAULT_BACKGROUND_LAYOUT_PROFILE,
  DEFAULT_LAYOUT_CAMERA,
  projectDefaultLayoutCenter,
  summarizeProjectedNebulaOverlap,
} from "../skills/liteverse-curator/scripts/partition-layout-profile.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const scripts = path.join(root, "skills", "liteverse-curator", "scripts");
const propose = path.join(scripts, "propose-partitions.mjs");
const compose = path.join(scripts, "compose-partition-options.mjs");
const applyChoice = path.join(scripts, "apply-partition-choice.mjs");
const stage = path.join(scripts, "stage-refresh.mjs");

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function paper(id) {
  return {
    id,
    title: `Paper ${id}`,
    primaryCategory: "legacy-default",
    categoryIds: ["legacy-default"],
    classificationStatus: "classified",
    useCount: 0,
    artifacts: {
      integrity: {
        artifactRevision: 1,
        artifactSha256: hash(`artifact:${id}`),
      },
    },
  };
}

function category(id, members, allPaperIds, color) {
  return {
    id,
    kind: "macro",
    name: id.replaceAll("-", " "),
    description: `Broad scientific scope for ${id}.`,
    color,
    creationEvidence: {
      memberIds: [...members].sort(),
      existingRegionMatchScores: Object.fromEntries(
        members.map((paperId) => [paperId, { "legacy-default": 82 }]),
      ),
      clusterConsistency: 82,
      scopeDefinition: `Stable macro cluster ${id} across the locked corpus of ${allPaperIds.length} papers.`,
    },
  };
}

function option(optionId, strategy, groups, paperIds, colorOffset = 0) {
  const categories = groups.map((members, index) => category(
    `${optionId}-region-${index + 1}`,
    members,
    paperIds,
    `#${(0x2255aa + colorOffset + index * 0x111111).toString(16).slice(-6)}`,
  ));
  const groupByPaper = new Map();
  groups.forEach((members, index) => members.forEach((paperId) => groupByPaper.set(paperId, categories[index].id)));
  return {
    optionId,
    name: `Option ${optionId}`,
    strategy,
    summary: `A complete-corpus partition emphasizing ${strategy}.`,
    rationale: `Organize the complete corpus according to ${strategy}.`,
    tradeoffs: {
      strengths: [`Makes ${strategy} easy to navigate.`],
      limitations: [`De-emphasizes another valid scientific view while prioritizing ${strategy}.`],
    },
    categories,
    assignments: paperIds.map((paperId) => ({
      paperId,
      primaryCategory: groupByPaper.get(paperId),
      classificationStatus: "classified",
      rationale: `The verified card places ${paperId} in the ${strategy} cluster.`,
      evidenceIds: [`${paperId}:claim-1`],
    })),
  };
}

function optionInput(paperIds) {
  const firstHalf = paperIds.slice(0, 4);
  const secondHalf = paperIds.slice(4);
  const evens = paperIds.filter((_, index) => index % 2 === 0);
  const odds = paperIds.filter((_, index) => index % 2 === 1);
  return {
    searchSummary: "Searched all immutable cards and claims before comparing broad scientific partitions.",
    retrievalQueries: [{
      query: "research question method principal result",
      consideredPaperIds: paperIds,
      summary: "All eight papers were compared by research question, method, and result.",
    }],
    options: [
      option("one-scope", "one broad unifying scientific question", [paperIds], paperIds, 0),
      option("method-split", "two broad methodological families", [firstHalf, secondHalf], paperIds, 0x110000),
      option("result-split", "two broad result and observable families", [evens, odds], paperIds, 0x220000),
    ],
  };
}

test("Curator proposes exactly three locked partitions, records one explicit choice, and stages category replacement", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-partition-test-"));
  const env = { ...process.env, LITEVERSE_SUPPORT_DIR: support };
  const paperIds = Array.from({ length: 8 }, (_, index) => `paper-${index + 1}`);
  const current = {
    schemaVersion: "2.0.0",
    revision: 1,
    updated: "2026-07-14T00:00:00.000Z",
    categories: [{
      id: "legacy-default",
      kind: "macro",
      name: "Legacy default",
      description: "Historical default category that is not automatically retained.",
      color: "#334455",
      nebulaAssetId: "asset-1",
      nebulaAssignmentOrder: 4,
    }],
    visuals: {
      nebulaAssignmentSeed: "partition-test-seed",
      nebulaAssets: [
        { id: "asset-1", src: "./one.png", enabled: true },
        { id: "asset-2", src: "./two.png", enabled: true },
        { id: "asset-3", src: "./three.png", enabled: true },
      ],
    },
    papers: paperIds.map(paper),
    relations: [],
  };
  current.papers[0].projectRole = "Primary region: `legacy-default`; secondary region: `old-secondary`. Preserve this research-use sentence exactly.";
  current.papers[1].projectRole = "Primary region: `legacy-default`. Preserve this research-use sentence.";
  current.papers[2].projectRole = "Free research note about the classification of primary instabilities; keep this untouched.";
  current.papers[3].projectRole = "Use this paper as a dynamical baseline. Classification: primary `legacy-default`, because it studies evolution; secondary `old-secondary` for its setup implications.";
  current.papers[4].projectRole = "It is a baseline inherited by later models. Classification: primary `legacy-default`; secondary `old-secondary`.";
  current.papers[5].projectRole = "Provides a concise bridge from theory to observable quantities. Classification: primary `legacy-default`; no secondary region.";
  const source = { ...current, revision: 2, updated: "2026-07-14T01:00:00.000Z" };
  const sourcePath = path.join(support, "Planning", "source.json");
  const optionsPath = path.join(support, "Planning", "options.json");
  const proposalPath = path.join(support, "Planning", "partition-proposals", "partition-test.json");
  const chosenPath = path.join(support, "Planning", "partition-snapshots", "chosen.json");
  try {
    await writeJson(path.join(support, "Graph", "current.json"), current);
    await writeJson(sourcePath, source);
    const partitionOptions = optionInput(paperIds);
    partitionOptions.options[1].assignments.find((assignment) => assignment.paperId === "paper-4").secondaryCategory = "method-split-region-2";
    partitionOptions.options[1].assignments.find((assignment) => assignment.paperId === "paper-5").secondaryCategory = "method-split-region-1";
    await writeJson(optionsPath, partitionOptions);
    const currentBefore = await readFile(path.join(support, "Graph", "current.json"));
    const proposed = JSON.parse((await execFileAsync(process.execPath, [
      propose,
      "--snapshot", sourcePath,
      "--options", optionsPath,
      "--proposal-id", "partition-test",
      "--output", proposalPath,
    ], { env })).stdout);
    assert.equal(proposed.status, "awaiting_user_partition_choice");
    assert.deepEqual(proposed.optionIds, ["one-scope", "method-split", "result-split"]);
    const proposal = JSON.parse(await readFile(proposalPath, "utf8"));
    assert.equal(proposal.options.length, 3);
    assert.equal(proposal.materialDifferences.length, 3);
    const proposalProjection = JSON.parse(await readFile(path.join(support, "Graph", "partition-proposals.json"), "utf8"));
    assert.equal(proposalProjection.schemaVersion, "liteverse-partition-proposals-v1");
    assert.equal(proposalProjection.status, "awaiting_user");
    assert.equal(proposalProjection.proposalSetId, "partition-test");
    assert.equal(proposalProjection.truthPath, "Planning/partition-proposals/partition-test.json");
    assert.equal(proposalProjection.options[1].regions.length, 2);
    assert.deepEqual(proposalProjection.options[1].metrics, {
      paperCount: 8,
      regionCount: 2,
      minRegionSize: 4,
      maxRegionSize: 4,
    });
    assert.deepEqual(await readFile(path.join(support, "Graph", "current.json")), currentBefore);
    await assert.rejects(access(path.join(support, "Graph", "pending-update.json")));
    await assert.rejects(access(path.join(support, "Graph", "staged")));

    await assert.rejects(
      execFileAsync(process.execPath, [
        applyChoice,
        "--proposal", proposalPath,
        "--snapshot", sourcePath,
        "--option-id", "method-split",
        "--confirmation-note", "User selected method-split.",
        "--decided-at", "2026-07-14T02:00:00Z",
        "--output", chosenPath,
      ], { env }),
      /confirmed-by-user/,
    );
    await execFileAsync(process.execPath, [
      applyChoice,
      "--proposal", proposalPath,
      "--snapshot", sourcePath,
      "--option-id", "method-split",
      "--confirmed-by-user",
      "--confirmation-note", "User selected method-split.",
      "--decided-at", "2026-07-14T02:00:00Z",
      "--output", chosenPath,
    ], { env });
    const chosen = JSON.parse(await readFile(chosenPath, "utf8"));
    assert.equal(chosen.categories.length, 2);
    assert.ok(chosen.categories.every((item) => item.id.startsWith("method-split-")));
    assert.deepEqual(chosen.categories.map((item) => item.nebulaAssignmentOrder), [5, 6]);
    assert.deepEqual(new Set(chosen.categories.map((item) => item.nebulaAssetId)), new Set(["asset-2", "asset-3"]));
    assert.ok(chosen.categories.every((item) => isFiniteVector3(item.center)));
    assert.equal(chosen.papers.length, 8);
    assert.ok(chosen.papers.every((item) => item.categoryIds.length >= 1 && item.categoryIds.length <= 2));
    assert.ok(chosen.papers.every((item) => isFiniteVector3(item.position)));
    assert.equal(
      chosen.papers[0].projectRole,
      "Primary region: `method split region 1`. Preserve this research-use sentence exactly.",
    );
    assert.equal(
      chosen.papers[1].projectRole,
      "Primary region: `method split region 1`. Preserve this research-use sentence.",
    );
    assert.equal(chosen.papers[2].projectRole, current.papers[2].projectRole);
    assert.equal(
      chosen.papers[3].projectRole,
      "Use this paper as a dynamical baseline. Classification: primary `method split region 1`; secondary `method split region 2`.",
    );
    assert.equal(
      chosen.papers[4].projectRole,
      "It is a baseline inherited by later models. Classification: primary `method split region 2`; secondary `method split region 1`.",
    );
    assert.equal(
      chosen.papers[5].projectRole,
      "Provides a concise bridge from theory to observable quantities. Classification: primary `method split region 2`; no secondary region.",
    );
    assert.equal(chosen.partitionDecision.optionId, "method-split");
    const selectedProjection = JSON.parse(await readFile(path.join(support, "Graph", "partition-proposals.json"), "utf8"));
    assert.equal(selectedProjection.status, "selected");
    assert.equal(selectedProjection.selectedOptionId, "method-split");
    const decisions = (await readFile(path.join(support, "Planning", "partition-decisions.jsonl"), "utf8")).trim().split("\n");
    assert.equal(decisions.length, 1);
    assert.equal(JSON.parse(decisions[0]).optionId, "method-split");
    assert.deepEqual(await readFile(path.join(support, "Graph", "current.json")), currentBefore);

    await writeJson(chosenPath, {
      ...chosen,
      categories: chosen.categories.map((category) => {
        const damaged = { ...category };
        delete damaged.nebulaAssetId;
        delete damaged.nebulaAssignmentOrder;
        return damaged;
      }),
    });
    const rebuilt = JSON.parse((await execFileAsync(process.execPath, [
      applyChoice,
      "--proposal", proposalPath,
      "--snapshot", sourcePath,
      "--option-id", "method-split",
      "--rebuild-selected",
      "--output", chosenPath,
    ], { env })).stdout);
    assert.equal(rebuilt.status, "partition_choice_rebuilt_unstaged");
    const repairedChoice = JSON.parse(await readFile(chosenPath, "utf8"));
    assert.deepEqual(repairedChoice.categories.map((item) => item.nebulaAssignmentOrder), [5, 6]);
    assert.equal(
      (await readFile(path.join(support, "Planning", "partition-decisions.jsonl"), "utf8")).trim().split("\n").length,
      1,
    );

    const missingCenterPath = path.join(support, "Planning", "partition-snapshots", "missing-center.json");
    const missingCenter = structuredClone(repairedChoice);
    delete missingCenter.categories[0].center;
    await writeJson(missingCenterPath, missingCenter);
    await assert.rejects(
      execFileAsync(process.execPath, [stage, "--snapshot", missingCenterPath, "--refresh-id", "missing-center-partition"], { env }),
      /center must be a finite three-number vector/,
    );
    const missingPositionPath = path.join(support, "Planning", "partition-snapshots", "missing-position.json");
    const missingPosition = structuredClone(repairedChoice);
    delete missingPosition.papers[0].position;
    await writeJson(missingPositionPath, missingPosition);
    await assert.rejects(
      execFileAsync(process.execPath, [stage, "--snapshot", missingPositionPath, "--refresh-id", "missing-position-partition"], { env }),
      /position must be a finite three-number vector/,
    );

    const nebulaTamperedPath = path.join(support, "Planning", "partition-snapshots", "nebula-tampered.json");
    await writeJson(nebulaTamperedPath, {
      ...repairedChoice,
      categories: repairedChoice.categories.map((category, index) => index === 0
        ? { ...category, nebulaAssetId: "asset-1" }
        : category),
    });
    await assert.rejects(
      execFileAsync(process.execPath, [
        stage,
        "--snapshot", nebulaTamperedPath,
        "--refresh-id", "tampered-nebula-partition",
      ], { env }),
      /non-deterministic nebula assignment/,
    );
    await assert.rejects(access(path.join(support, "Graph", "pending-update.json")));

    const tamperedPath = path.join(support, "Planning", "partition-snapshots", "tampered.json");
    await writeJson(tamperedPath, {
      ...chosen,
      partitionDecision: { ...chosen.partitionDecision, optionId: "result-split" },
    });
    await assert.rejects(
      execFileAsync(process.execPath, [stage, "--snapshot", tamperedPath, "--refresh-id", "tampered-partition"], { env }),
      /pointer optionId does not match/,
    );
    await assert.rejects(access(path.join(support, "Graph", "pending-update.json")));

    const staged = JSON.parse((await execFileAsync(process.execPath, [
      stage,
      "--snapshot", chosenPath,
      "--refresh-id", "partition-replacement",
    ], { env })).stdout);
    assert.deepEqual(staged.manifest.categories.removed, ["legacy-default"]);
    assert.equal(staged.manifest.partitionDecision.optionId, "method-split");
    assert.deepEqual(staged.manifest.papers.removed, []);
    assert.deepEqual(staged.manifest.relations.removed, []);
    assert.deepEqual(await readFile(path.join(support, "Graph", "current.json")), currentBefore);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("partition choice nebula assignment preserves reused regions and deterministically balances exhausted assets", () => {
  const assets = Array.from({ length: 4 }, (_, index) => ({
    id: `asset-${index + 1}`,
    src: `./${index + 1}.png`,
    enabled: true,
  }));
  const current = {
    visuals: { nebulaAssignmentSeed: "stable-seed", nebulaAssets: assets },
    categories: [
      { id: "reuse", kind: "macro", nebulaAssetId: "asset-1", nebulaAssignmentOrder: 2 },
      { id: "retire", kind: "macro", nebulaAssetId: "asset-2", nebulaAssignmentOrder: 5 },
    ],
  };
  const selected = [
    { id: "reuse", kind: "macro", nebulaAssetId: "bogus", nebulaAssignmentOrder: 99 },
    { id: "new-one", kind: "macro" },
    { id: "new-two", kind: "macro" },
  ];
  const first = assignCategoryNebulaAssets(current, current, selected);
  const repeated = assignCategoryNebulaAssets(current, current, selected);
  assert.deepEqual(repeated, first);
  assert.deepEqual(
    first.categories[0],
    { id: "reuse", kind: "macro", nebulaAssetId: "asset-1", nebulaAssignmentOrder: 2 },
  );
  assert.deepEqual(first.categories.slice(1).map((category) => category.nebulaAssignmentOrder), [6, 7]);
  assert.deepEqual(
    new Set(first.categories.slice(1).map((category) => category.nebulaAssetId)),
    new Set(["asset-3", "asset-4"]),
  );

  const exhaustedCurrent = {
    ...current,
    visuals: { ...current.visuals, nebulaAssets: assets.slice(0, 2) },
  };
  const exhausted = assignCategoryNebulaAssets(exhaustedCurrent, exhaustedCurrent, [
    { id: "new-a", kind: "macro" },
    { id: "new-b", kind: "macro" },
    { id: "new-c", kind: "macro" },
  ]);
  assert.deepEqual(exhausted.categories.map((category) => category.nebulaAssignmentOrder), [6, 7, 8]);
  assert.equal(new Set(exhausted.categories.slice(0, 2).map((category) => category.nebulaAssetId)).size, 2);
  assert.ok(exhausted.categories.every((category) => ["asset-1", "asset-2"].includes(category.nebulaAssetId)));
  assert.deepEqual(
    assignCategoryNebulaAssets(exhaustedCurrent, exhaustedCurrent, [
      { id: "new-a", kind: "macro" },
      { id: "new-b", kind: "macro" },
      { id: "new-c", kind: "macro" },
    ]),
    exhausted,
  );
});

test("deterministic partition layout supports every region count through ten within the existing universe view", () => {
  for (const regionCount of Array.from({ length: 10 }, (_, index) => index + 1)) {
    const categories = Array.from({ length: regionCount }, (_, index) => ({
      id: `region-${index + 1}`,
      kind: "macro",
      name: `Region ${index + 1}`,
    }));
    const papers = categories.flatMap((category) => Array.from({ length: 4 }, (_, index) => ({
      id: `${category.id}-paper-${index + 1}`,
      primaryCategory: category.id,
      categoryIds: [category.id],
    })));
    const source = { categories: [], papers: [] };
    const current = { categories: [], papers: [] };
    const first = assignDeterministicPartitionLayout(source, current, categories, papers, `layout-${regionCount}`);
    const repeated = assignDeterministicPartitionLayout(source, current, categories, papers, `layout-${regionCount}`);
    assert.deepEqual(repeated, first);
    assert.ok(first.categories.every((category) => isFiniteVector3(category.center)));
    assert.equal(new Set(first.categories.map((category) => category.center.join(","))).size, regionCount);
    assert.ok(first.categories.every((category) => (
      Math.abs(category.center[0]) <= 3.8
      && Math.abs(category.center[1]) <= 2.55
      && Math.abs(category.center[2]) <= 0.95
    )));
    assert.ok(first.papers.every((paper) => isFiniteVector3(paper.position)));
    assert.equal(new Set(first.papers.map((paper) => paper.position.join(","))).size, first.papers.length);
    const centers = new Map(first.categories.map((category) => [category.id, category.center]));
    assert.ok(first.papers.every((paper) => {
      const center = centers.get(paper.primaryCategory);
      return Math.hypot(
        paper.position[0] - center[0],
        paper.position[1] - center[1],
        paper.position[2] - center[2],
      ) <= 1.16;
    }));
    if (regionCount > 1) {
      const depth = first.categories.map((category) => category.center[2]);
      assert.ok(Math.max(...depth) - Math.min(...depth) > 0.2, "layout must retain meaningful 3D depth");
    }
  }

  const reusedCurrent = {
    categories: [{ id: "stable", kind: "macro", center: [1.25, -0.75, 0.2] }],
    papers: Array.from({ length: 4 }, (_, index) => ({ id: `stable-${index}`, primaryCategory: "stable" })),
  };
  const reused = assignDeterministicPartitionLayout(
    reusedCurrent,
    reusedCurrent,
    [{ id: "stable", kind: "macro", name: "Stable" }],
    reusedCurrent.papers,
    "stable-layout",
  );
  assert.deepEqual(reused.categories[0].center, [1.25, -0.75, 0.2]);
});

test("background-aware region placement prefers blank image footprints and reduces projected overlap", async () => {
  assert.equal(DEFAULT_BACKGROUND_LAYOUT_PROFILE.cells.length, 24 * 15);
  assert.equal(DEFAULT_BACKGROUND_LAYOUT_PROFILE.sourceWidth, 1448);
  assert.equal(DEFAULT_BACKGROUND_LAYOUT_PROFILE.sourceHeight, 1086);
  assert.equal(DEFAULT_BACKGROUND_LAYOUT_PROFILE.objectFit, "cover");
  assert.equal(DEFAULT_BACKGROUND_LAYOUT_PROFILE.objectPosition, "center");
  assert.equal(
    hash(await readFile(path.join(root, "public", "liteverse-nebula.png"))),
    DEFAULT_BACKGROUND_LAYOUT_PROFILE.sourceSha256,
    "the occupancy profile must stay pinned to the packaged default background",
  );

  const makeLayout = (regionCount) => {
    const categories = Array.from({ length: regionCount }, (_, index) => ({
      id: `background-region-${index + 1}`,
      kind: "macro",
      name: `Background region ${index + 1}`,
    }));
    const papers = categories.flatMap((category) => Array.from({ length: 4 }, (_, index) => ({
      id: `${category.id}-paper-${index + 1}`,
      primaryCategory: category.id,
      categoryIds: [category.id],
    })));
    return assignDeterministicPartitionLayout(
      { categories: [], papers: [] },
      { categories: [], papers: [] },
      categories,
      papers,
      `layout-${regionCount}`,
    );
  };

  const single = makeLayout(1);
  const blankCost = backgroundFootprintCost(single.categories[0].center);
  const brightCenterCost = backgroundFootprintCost([0, 0, 0]);
  assert.ok(blankCost.cost < brightCenterCost.cost - 0.2, "one region should avoid the bright default-background core");
  assert.equal(blankCost.edgePenalty, 0, "blank-area preference must not hide the nebula under window chrome");

  const five = makeLayout(5);
  const fiveOverlap = summarizeProjectedNebulaOverlap(five.categories.map((category) => category.center));
  assert.equal(fiveOverlap.overlapCount, 0, "available blank footprints should be used before projected overlap");

  const ten = makeLayout(10);
  const tenCenters = ten.categories.map((category) => category.center);
  const tenOverlap = summarizeProjectedNebulaOverlap(tenCenters);
  assert.ok(tenOverlap.overlapCount > 0, "crowded layouts may still overlap instead of failing");
  const legacyTenCenters = [
    [-1.636213, 1.647537, 0.598698], [1.655728, -1.46554, -0.658073],
    [-0.456795, -1.977538, 0.588802], [-3.353753, -0.580249, -0.390885],
    [3.470932, 0.576347, 0.321615], [0.25077, 1.805393, -0.667969],
    [-3.125559, -0.611995, 0.489844], [0.382466, -0.041066, 0.945052],
    [1.037921, 2.442624, 0.084115], [-0.638558, -0.134158, -0.935156],
  ];
  const legacyOverlap = summarizeProjectedNebulaOverlap(legacyTenCenters);
  assert.ok(tenOverlap.totalPenetration < legacyOverlap.totalPenetration * 0.5);
  assert.ok(tenOverlap.maximumPenetration < legacyOverlap.maximumPenetration);
  const depth = tenCenters.map((center) => center[2]);
  assert.ok(Math.max(...depth) - Math.min(...depth) > 0.8, "blank-first placement must remain three-dimensional");
});

test("stable existing centers remain obstacles and camera rotation still changes their 3D projection", () => {
  const stableCenter = [3.702999, 0.545826, -0.064323];
  const current = {
    categories: [{ id: "stable", kind: "macro", center: stableCenter }],
    papers: Array.from({ length: 4 }, (_, index) => ({ id: `stable-paper-${index}`, primaryCategory: "stable" })),
  };
  const papers = [
    ...current.papers,
    ...Array.from({ length: 4 }, (_, index) => ({ id: `new-paper-${index}`, primaryCategory: "new-region" })),
  ];
  const result = assignDeterministicPartitionLayout(
    current,
    current,
    [
      { id: "stable", kind: "macro", name: "Stable" },
      { id: "new-region", kind: "macro", name: "New region" },
    ],
    papers,
    "stable-obstacle-layout",
  );
  assert.deepEqual(result.categories[0].center, stableCenter);
  const overlap = summarizeProjectedNebulaOverlap(result.categories.map((category) => category.center));
  assert.equal(overlap.overlapCount, 0);

  const defaultProjection = projectDefaultLayoutCenter(result.categories[1].center);
  const rotatedProjection = projectDefaultLayoutCenter(
    result.categories[1].center,
    DEFAULT_BACKGROUND_LAYOUT_PROFILE,
    { ...DEFAULT_LAYOUT_CAMERA, rotationY: DEFAULT_LAYOUT_CAMERA.rotationY + 0.65 },
  );
  assert.notEqual(defaultProjection.x, rotatedProjection.x);
  assert.notEqual(defaultProjection.depth, rotatedProjection.depth);
});

test("Curator contract documents explicit delegated partition selection without treating silence as consent", async () => {
  const [skill, taxonomy, graphContract] = await Promise.all([
    readFile(path.join(root, "skills", "liteverse-curator", "SKILL.md"), "utf8"),
    readFile(path.join(root, "skills", "liteverse-curator", "references", "taxonomy.md"), "utf8"),
    readFile(path.join(root, "skills", "liteverse-curator", "references", "graph-contract.md"), "utf8"),
  ]);
  for (const text of [skill, taxonomy, graphContract]) {
    assert.match(text, /delegated choice/);
    assert.match(text, /--confirmed-by-user/);
  }
  assert.match(skill, /Never infer a choice from silence/);
  assert.match(taxonomy, /Silence, timeout/);
});

test("partition proposal fails closed for fewer or non-distinct options and stale artifacts", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-partition-invalid-test-"));
  const env = { ...process.env, LITEVERSE_SUPPORT_DIR: support };
  const paperIds = Array.from({ length: 8 }, (_, index) => `paper-${index + 1}`);
  const current = {
    schemaVersion: "2.0.0",
    revision: 1,
    categories: [{
      id: "legacy-default",
      kind: "macro",
      name: "Legacy default",
      description: "Historical default category that is not automatically retained.",
      color: "#334455",
    }],
    papers: paperIds.map(paper),
    relations: [],
  };
  const sourcePath = path.join(support, "source.json");
  const optionsPath = path.join(support, "options.json");
  const proposalPath = path.join(support, "Planning", "partition-proposals", "invalid-test.json");
  try {
    await writeJson(path.join(support, "Graph", "current.json"), current);
    await writeJson(sourcePath, { ...current, revision: 2 });
    const input = optionInput(paperIds);
    await writeJson(optionsPath, { ...input, options: input.options.slice(0, 2) });
    await assert.rejects(
      execFileAsync(process.execPath, [propose, "--snapshot", sourcePath, "--options", optionsPath], { env }),
      /exactly three options/,
    );
    await writeJson(optionsPath, {
      ...input,
      options: [
        input.options[0],
        { ...input.options[0], optionId: "copy-two", strategy: "copied second strategy" },
        { ...input.options[0], optionId: "copy-three", strategy: "copied third strategy" },
      ],
    });
    await assert.rejects(
      execFileAsync(process.execPath, [propose, "--snapshot", sourcePath, "--options", optionsPath], { env }),
      /not materially distinct/,
    );

    await writeJson(optionsPath, input);
    await execFileAsync(process.execPath, [
      propose,
      "--snapshot", sourcePath,
      "--options", optionsPath,
      "--output", proposalPath,
    ], { env });
    const changedCurrent = structuredClone(current);
    changedCurrent.papers[0].artifacts.integrity.artifactSha256 = hash("changed artifact");
    await writeJson(path.join(support, "Graph", "current.json"), changedCurrent);
    await assert.rejects(
      execFileAsync(process.execPath, [
        applyChoice,
        "--proposal", proposalPath,
        "--snapshot", sourcePath,
        "--option-id", "method-split",
        "--confirmed-by-user",
        "--confirmation-note", "User selected method-split.",
        "--decided-at", "2026-07-14T02:00:00Z",
      ], { env }),
      /artifact fingerprint is stale/,
    );
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("compact partition helper expands pinned verified claims and transparent old-region score heuristics", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-partition-compose-test-"));
  const env = { ...process.env, LITEVERSE_SUPPORT_DIR: support };
  const paperIds = Array.from({ length: 8 }, (_, index) => `paper-${index + 1}`);
  const papers = [];
  try {
    for (const [index, paperId] of paperIds.entries()) {
      const item = paper(paperId);
      item.primaryCategory = index < 4 ? "old-a" : "old-b";
      item.categoryIds = [item.primaryCategory];
      if (paperId === "paper-1") {
        item.secondaryCategory = "old-b";
        item.categoryIds.push("old-b");
      }
      const claims = {
        schemaVersion: "liteverse-claims-v1",
        paperId,
        artifactSha256: item.artifacts.integrity.artifactSha256,
        verificationStatus: paperId === "paper-8" ? "needs_attention" : "evidence_verified",
        claims: paperId === "paper-8"
          ? [{
            claimId: `${paperId}-attention`,
            verificationStatus: "needs_attention",
            evidenceIds: ["E1"],
            evidence: [{ evidenceId: "E1", locator: "PDF p. 1" }],
          }]
          : [
            { claimId: `${paperId}-draft`, verificationStatus: "needs_attention", evidenceIds: ["E0"] },
            { claimId: `${paperId}-verified`, verificationStatus: "evidence_verified" },
          ],
      };
      if (paperId === "paper-8") item.verificationStatus = "needs_attention";
      const claimsText = `${JSON.stringify(claims, null, 2)}\n`;
      const claimsPath = `Knowledge/artifacts/${paperId}/revisions/000001/claims.json`;
      item.artifacts.integrity.claimsSha256 = hash(claimsText);
      item.artifacts.integrity.immutableClaimsPath = claimsPath;
      await mkdir(path.dirname(path.join(support, claimsPath)), { recursive: true });
      await writeFile(path.join(support, claimsPath), claimsText, "utf8");
      papers.push(item);
    }
    const current = {
      schemaVersion: "2.0.0",
      revision: 1,
      categories: [
        { id: "old-a", name: "Old A", description: "First old macro scope.", color: "#112233" },
        { id: "old-b", name: "Old B", description: "Second old macro scope.", color: "#334455" },
      ],
      papers,
      relations: [],
    };
    const snapshotPath = path.join(support, "Planning", "source.json");
    const planPath = path.join(support, "Planning", "compact-plan.json");
    const optionsPath = path.join(support, "Planning", "partition-inputs", "expanded.json");
    const proposalPath = path.join(support, "Planning", "partition-proposals", "composed.json");
    await writeJson(path.join(support, "Graph", "current.json"), current);
    await writeJson(snapshotPath, { ...current, revision: 2 });
    const groups = [
      [paperIds],
      [paperIds.slice(0, 4), paperIds.slice(4)],
      [paperIds.filter((_, index) => index % 2 === 0), paperIds.filter((_, index) => index % 2 === 1)],
    ];
    await writeJson(planPath, {
      searchSummary: "Compared the verified claims of the complete locked corpus.",
      retrievalQuery: "verified research question method result claims",
      options: groups.map((optionGroups, optionIndex) => ({
        optionId: `compact-${optionIndex + 1}`,
        name: `Compact option ${optionIndex + 1}`,
        strategy: `scientific strategy ${optionIndex + 1}`,
        summary: `Summary for compact option ${optionIndex + 1}.`,
        tradeoffs: {
          strengths: [`Strength ${optionIndex + 1}.`],
          limitations: [`Limitation ${optionIndex + 1}.`],
        },
        regions: optionGroups.map((members, regionIndex) => ({
          id: `compact-${optionIndex + 1}-region-${regionIndex + 1}`,
          name: `Region ${optionIndex + 1}.${regionIndex + 1}`,
          description: "A broad stable scientific region.",
          paperIds: members,
          clusterConsistency: 80 + optionIndex,
          scopeDefinition: "A broad corpus-level scope backed by verified claims.",
          color: `#${(0x336699 + optionIndex * 0x110000 + regionIndex * 0x001111).toString(16).slice(-6)}`,
        })),
      })),
    });
    const composed = JSON.parse((await execFileAsync(process.execPath, [
      compose,
      "--snapshot", snapshotPath,
      "--plan", planPath,
      "--output", optionsPath,
    ], { env })).stdout);
    assert.equal(composed.paperCount, 8);
    const expanded = JSON.parse(await readFile(optionsPath, "utf8"));
    assert.equal(expanded.options[0].assignments[0].evidenceIds[0], "paper-1-verified");
    const provisionalAssignment = expanded.options[0].assignments.find((assignment) => assignment.paperId === "paper-8");
    assert.equal(provisionalAssignment.evidenceIds[0], "paper-8-attention");
    assert.equal(provisionalAssignment.classificationStatus, "provisional");
    assert.match(provisionalAssignment.rationale, /Provisional classification anchor.*original-source review/);
    assert.deepEqual(expanded.metadata.anchorCounts, { evidenceVerified: 7, provisionalNeedsAttention: 1 });
    assert.deepEqual(expanded.metadata.provisionalNeedsAttentionPaperIds, ["paper-8"]);
    const scores = expanded.options[0].categories[0].creationEvidence.existingRegionMatchScores["paper-1"];
    assert.deepEqual(scores, { "old-a": 82, "old-b": 66 });
    assert.match(expanded.searchSummary, /primary=82.*secondary=66.*other=18/);
    await execFileAsync(process.execPath, [
      propose,
      "--snapshot", snapshotPath,
      "--options", optionsPath,
      "--proposal-id", "composed",
      "--output", proposalPath,
    ], { env });
    const truth = JSON.parse(await readFile(proposalPath, "utf8"));
    assert.equal(truth.metadata.composer, "liteverse-compose-partition-options-v1");

    const ineligibleClaims = {
      schemaVersion: "liteverse-claims-v1",
      paperId: "paper-8",
      artifactSha256: papers[7].artifacts.integrity.artifactSha256,
      verificationStatus: "needs_attention",
      claims: [{ claimId: "paper-8-attention", verificationStatus: "needs_attention", evidenceIds: [], evidence: [] }],
    };
    const ineligibleText = `${JSON.stringify(ineligibleClaims, null, 2)}\n`;
    await writeFile(path.join(support, papers[7].artifacts.integrity.immutableClaimsPath), ineligibleText, "utf8");
    const noEvidenceSnapshot = structuredClone({ ...current, revision: 2 });
    noEvidenceSnapshot.papers[7].artifacts.integrity.claimsSha256 = hash(ineligibleText);
    await writeJson(snapshotPath, noEvidenceSnapshot);
    await assert.rejects(
      execFileAsync(process.execPath, [compose, "--snapshot", snapshotPath, "--plan", planPath, "--output", optionsPath], { env }),
      /no evidence_verified claim or eligible needs_attention provisional anchor/,
    );

    const evidenceClaims = {
      ...ineligibleClaims,
      claims: [{
        claimId: "paper-8-attention",
        verificationStatus: "needs_attention",
        evidenceIds: ["E1"],
      }],
    };
    const evidenceText = `${JSON.stringify(evidenceClaims, null, 2)}\n`;
    await writeFile(path.join(support, papers[7].artifacts.integrity.immutableClaimsPath), evidenceText, "utf8");
    const wrongPaperStateSnapshot = structuredClone(noEvidenceSnapshot);
    wrongPaperStateSnapshot.papers[7].verificationStatus = "card_draft";
    wrongPaperStateSnapshot.papers[7].artifacts.integrity.claimsSha256 = hash(evidenceText);
    await writeJson(snapshotPath, wrongPaperStateSnapshot);
    await assert.rejects(
      execFileAsync(process.execPath, [compose, "--snapshot", snapshotPath, "--plan", planPath, "--output", optionsPath], { env }),
      /no evidence_verified claim or eligible needs_attention provisional anchor/,
    );
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});
