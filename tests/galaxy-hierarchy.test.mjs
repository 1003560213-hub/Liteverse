import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  blackHoleClearance,
  GALAXY_ASSET_IDS,
  GALAXY_HIERARCHY_ALGORITHM,
  GALAXY_RING_CAPACITIES,
  GALAXY_RING_RADII,
  galaxyRingIndex,
  MAX_GALAXIES_PER_NEBULA,
  MIN_BLACK_HOLE_CLEARANCE,
  MIN_GALAXY_CENTER_SEPARATION,
  hierarchyAssignmentSha256,
  inspectGalaxyHierarchy,
  materializeGalaxyHierarchy,
  targetGalaxyCount,
} from "../scripts/lib/liteverse-galaxy-hierarchy.mjs";
import { deriveGalaxyHierarchyRecords } from "../scripts/lib/liteverse-galaxy-contract.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const stageRefresh = path.join(root, "skills", "liteverse-curator", "scripts", "stage-refresh.mjs");
const cli = path.join(root, "scripts", "liteverse-cli.mjs");

function paper(id, primaryCategory, index) {
  return {
    id,
    primaryCategory,
    categoryIds: [primaryCategory],
    position: [index * 0.01, index * -0.01, index % 3],
    tags: index % 2 ? ["soliton", "time evolution"] : ["lensing", "halo"],
    useCount: 0,
  };
}

function graph(counts = [12, 7]) {
  const categories = counts.map((_, index) => ({
    id: `nebula-${index + 1}`,
    kind: "macro",
    name: `Nebula ${index + 1}`,
    description: "A broad scientific region.",
    color: "#ffffff",
    center: [index * 5, index * 2, index * -1],
  }));
  const papers = categories.flatMap((category, categoryIndex) =>
    Array.from({ length: counts[categoryIndex] }, (_, index) =>
      paper(`paper-${categoryIndex + 1}-${String(index + 1).padStart(3, "0")}`, category.id, index)));
  const relations = papers.slice(1).map((target, index) => ({
    id: `relation-${index + 1}`,
    source: papers[index].id,
    target: target.id,
    status: index % 2 ? "candidate" : "verified",
  }));
  return {
    schemaVersion: "3.0.0",
    revision: 4,
    title: "Test",
    updated: "2026-07-20",
    visuals: { nebulaAssignmentSeed: "nebula-seed", nebulaAssets: [] },
    usagePolicy: { managedBy: "liteverse-retriever", ledger: "Usage/events.jsonl" },
    categories,
    papers,
    relations,
  };
}

test("galaxy materialization is deterministic, additive, and preserves scientific graph truth", async () => {
  const source = graph();
  const before = structuredClone(source);
  const first = materializeGalaxyHierarchy(source);
  const second = materializeGalaxyHierarchy(source);
  const idempotent = materializeGalaxyHierarchy(first);

  assert.deepEqual(source, before, "the pure materializer must not mutate its input");
  assert.deepEqual(second, first);
  assert.deepEqual(idempotent, first);
  assert.equal(first.schemaVersion, "3.0.0");
  assert.deepEqual(first.categories, source.categories);
  assert.deepEqual(first.relations, source.relations);
  assert.deepEqual(first.usagePolicy, source.usagePolicy);
  assert.equal(first.hierarchy.assignmentSha256, hierarchyAssignmentSha256(first));
  assert.equal(inspectGalaxyHierarchy(first).valid, true);
  assert.equal(first.galaxies.filter((galaxy) => galaxy.categoryId === "nebula-1").length, targetGalaxyCount(12));
  assert.equal(first.galaxies.filter((galaxy) => galaxy.categoryId === "nebula-2").length, targetGalaxyCount(7));
  assert.ok(first.galaxies.every((galaxy) => GALAXY_ASSET_IDS.includes(galaxy.assetId)));
  await Promise.all(GALAXY_ASSET_IDS.map((assetId) => access(path.join(root, "public", "galaxies", assetId))));
  assert.ok(first.papers.every((item) => typeof item.galaxyId === "string"));
  assert.equal(new Set(first.papers.map((item) => item.id)).size, first.papers.length);
  assert.equal(JSON.stringify(first).includes("routingAffinity"), false);
  assert.equal(JSON.stringify(first).includes("galaxyStrength"), false);
});

test("App fallback and staged materialization share IDs, groups, names, positions, and assets", async () => {
  const source = graph([17, 8]);
  const fallback = deriveGalaxyHierarchyRecords(source, { previousGraph: source });
  const staged = materializeGalaxyHierarchy(source);
  const stagedGalaxies = staged.galaxies.map((galaxy) => ({
    ...galaxy,
    paperIds: staged.papers
      .filter((item) => item.galaxyId === galaxy.id)
      .map((item) => item.id)
      .sort(),
  }));
  assert.deepEqual(stagedGalaxies, fallback.galaxies);
  assert.deepEqual(
    staged.papers.map((item) => [item.id, item.galaxyId]).sort(),
    [...fallback.assignmentByPaperId].sort(),
  );

  const runtimeSource = await readFile(path.join(root, "app", "universe", "hierarchy.ts"), "utf8");
  assert.match(runtimeSource, /deriveGalaxyHierarchyRecords\(graph, \{ previousGraph: graph \}\)/);
  assert.doesNotMatch(runtimeSource, /function clusterCategory/);
});

test("galaxy layout fills concentric 3D rings and exhausts artwork globally before reuse", () => {
  const staged = materializeGalaxyHierarchy(graph([60, 12]));
  const categoryById = new Map(staged.categories.map((category) => [category.id, category]));
  for (const galaxy of staged.galaxies) {
    const origin = categoryById.get(galaxy.categoryId).center;
    assert.ok(
      blackHoleClearance(galaxy.position, origin) >= MIN_BLACK_HOLE_CLEARANCE,
      `${galaxy.id} must leave the central black-hole space clear`,
    );
    assert.ok(galaxyRingIndex(galaxy.position, origin) >= 0,
      `${galaxy.id} must use a declared concentric-ring radius`);
  }
  for (const category of staged.categories) {
    const siblings = staged.galaxies.filter((galaxy) => galaxy.categoryId === category.id);
    const ringCounts = GALAXY_RING_CAPACITIES.map(() => 0);
    for (const galaxy of siblings) ringCounts[galaxyRingIndex(galaxy.position, category.center)] += 1;
    assert.equal(ringCounts[0], Math.min(siblings.length, GALAXY_RING_CAPACITIES[0]));
    assert.equal(ringCounts[1], Math.max(0, siblings.length - GALAXY_RING_CAPACITIES[0]));
    for (let left = 0; left < siblings.length; left += 1) {
      for (let right = left + 1; right < siblings.length; right += 1) {
        assert.ok(
          Math.hypot(...siblings[left].position.map((value, axis) => value - siblings[right].position[axis]))
            >= MIN_GALAXY_CENTER_SEPARATION,
          `${siblings[left].id} and ${siblings[right].id} must not collide`,
        );
      }
    }
  }
  assert.ok(staged.galaxies.some((galaxy) => galaxy.position[2] !== categoryById.get(galaxy.categoryId).center[2]));
  const usage = new Map(GALAXY_ASSET_IDS.map((assetId) => [assetId, 0]));
  for (const galaxy of staged.galaxies) usage.set(galaxy.assetId, usage.get(galaxy.assetId) + 1);
  assert.equal([...usage.values()].filter(Boolean).length, GALAXY_ASSET_IDS.length);
  assert.ok(Math.max(...usage.values()) - Math.min(...usage.values()) <= 1);
  assert.equal(inspectGalaxyHierarchy(staged).valid, true);
});

test("incremental materialization retains existing galaxy identities and adds a stable group", () => {
  const initialSource = graph([10]);
  const initial = materializeGalaxyHierarchy(initialSource);
  assert.equal(initial.galaxies.length, 2);
  const extra = paper("paper-1-011", "nebula-1", 11);
  const nextSource = {
    ...initialSource,
    revision: 5,
    papers: [...initialSource.papers, extra],
  };
  const next = materializeGalaxyHierarchy(nextSource, { previousGraph: initial });
  assert.equal(next.galaxies.length, 3);
  const nextById = new Map(next.galaxies.map((galaxy) => [galaxy.id, galaxy]));
  for (const previous of initial.galaxies) {
    const retained = nextById.get(previous.id);
    assert.ok(retained, `expected ${previous.id} to remain`);
    assert.deepEqual(retained.position, previous.position);
    assert.equal(retained.assetId, previous.assetId);
    assert.equal(retained.seedPaperId, previous.seedPaperId);
  }
  const added = next.galaxies.find((galaxy) => !initial.galaxies.some((item) => item.id === galaxy.id));
  assert.ok(added);
  assert.ok(!initial.galaxies.some((galaxy) => galaxy.assetId === added.assetId));
  assert.equal(inspectGalaxyHierarchy(next).valid, true);
});

test("incremental growth fills the inner ring before extending to the outer ring", () => {
  const initialSource = graph([20]);
  const initial = materializeGalaxyHierarchy(initialSource);
  assert.equal(initial.galaxies.length, GALAXY_RING_CAPACITIES[0]);
  assert.ok(initial.galaxies.every((galaxy) =>
    galaxyRingIndex(galaxy.position, initial.categories[0].center) === 0));
  const nextSource = {
    ...initialSource,
    revision: 5,
    papers: [...initialSource.papers, paper("paper-1-021", "nebula-1", 21)],
  };
  const next = materializeGalaxyHierarchy(nextSource, { previousGraph: initial });
  const outer = next.galaxies.filter((galaxy) =>
    galaxyRingIndex(galaxy.position, next.categories[0].center) === 1);
  assert.equal(outer.length, 1);
  for (const galaxy of initial.galaxies) {
    assert.deepEqual(next.galaxies.find((item) => item.id === galaxy.id)?.position, galaxy.position);
  }
});

test("artwork allocation is unused-first and incrementally stable across nebula boundaries", () => {
  const initialSource = graph([20, 20, 10]);
  const initial = materializeGalaxyHierarchy(initialSource);
  assert.equal(initial.galaxies.length, GALAXY_ASSET_IDS.length);
  assert.equal(new Set(initial.galaxies.map((galaxy) => galaxy.assetId)).size, GALAXY_ASSET_IDS.length);
  const additionalPapers = Array.from({ length: 5 }, (_, offset) =>
    paper(`paper-3-${String(11 + offset).padStart(3, "0")}`, "nebula-3", 11 + offset));
  const nextSource = {
    ...initialSource,
    revision: 5,
    papers: [...initialSource.papers, ...additionalPapers],
  };
  const next = materializeGalaxyHierarchy(nextSource, { previousGraph: initial });
  const nextById = new Map(next.galaxies.map((galaxy) => [galaxy.id, galaxy]));
  for (const previous of initial.galaxies) {
    assert.equal(nextById.get(previous.id)?.assetId, previous.assetId);
  }
  const counts = new Map(GALAXY_ASSET_IDS.map((assetId) => [assetId, 0]));
  for (const galaxy of next.galaxies) counts.set(galaxy.assetId, counts.get(galaxy.assetId) + 1);
  assert.equal([...counts.values()].filter(Boolean).length, GALAXY_ASSET_IDS.length);
  assert.ok(Math.max(...counts.values()) - Math.min(...counts.values()) <= 1);
  assert.equal(inspectGalaxyHierarchy(next).valid, true);
});

test("v1 positions are deterministically migrated in memory instead of being retained", () => {
  const v2 = materializeGalaxyHierarchy(graph([20]));
  const legacy = structuredClone(v2);
  legacy.hierarchy.algorithm = "deterministic-galaxy-routing-v1";
  legacy.galaxies.forEach((galaxy, index) => {
    galaxy.position = [10 + index, -10 - index, index];
  });
  legacy.hierarchy.assignmentSha256 = hierarchyAssignmentSha256(legacy);
  const migrated = materializeGalaxyHierarchy(legacy);
  assert.equal(migrated.hierarchy.algorithm, GALAXY_HIERARCHY_ALGORITHM);
  assert.notDeepEqual(migrated.galaxies.map((galaxy) => galaxy.position), legacy.galaxies.map((galaxy) => galaxy.position));
  assert.equal(inspectGalaxyHierarchy(migrated).valid, true);
});

test("large nebulae never exceed twelve galaxies", () => {
  const large = materializeGalaxyHierarchy(graph([1_000]));
  assert.equal(targetGalaxyCount(1_000), MAX_GALAXIES_PER_NEBULA);
  assert.equal(large.galaxies.length, MAX_GALAXIES_PER_NEBULA);
  assert.equal(inspectGalaxyHierarchy(large).valid, true);
});

test("hierarchy validation rejects a paper routed outside its primary nebula", () => {
  const valid = materializeGalaxyHierarchy(graph([4, 4]));
  const foreignGalaxy = valid.galaxies.find((galaxy) => galaxy.categoryId === "nebula-2");
  const invalid = structuredClone(valid);
  invalid.papers.find((item) => item.primaryCategory === "nebula-1").galaxyId = foreignGalaxy.id;
  invalid.hierarchy.assignmentSha256 = hierarchyAssignmentSha256(invalid);
  const inspection = inspectGalaxyHierarchy(invalid);
  assert.equal(inspection.valid, false);
  assert.ok(inspection.issues.some((item) => item.code === "hierarchy.cross_nebula"));
});

test("hierarchy validation rejects black-hole intrusion and premature asset reuse", () => {
  const valid = materializeGalaxyHierarchy(graph([12]));
  const intruding = structuredClone(valid);
  intruding.galaxies[0].position = [...intruding.categories[0].center];
  intruding.hierarchy.assignmentSha256 = hierarchyAssignmentSha256(intruding);
  assert.ok(inspectGalaxyHierarchy(intruding).issues.some((item) =>
    item.code === "hierarchy.black_hole_clearance"));

  const repeated = structuredClone(valid);
  repeated.galaxies[1].assetId = repeated.galaxies[0].assetId;
  repeated.hierarchy.assignmentSha256 = hierarchyAssignmentSha256(repeated);
  assert.ok(inspectGalaxyHierarchy(repeated).issues.some((item) =>
    item.code === "hierarchy.asset_reuse_order"));
});

test("hierarchy validation rejects outer-first placement and galaxy collisions", () => {
  const valid = materializeGalaxyHierarchy(graph([20]));
  const category = valid.categories[0];
  const invalidOrder = structuredClone(valid);
  const inner = invalidOrder.galaxies[0];
  const angle = Math.atan2(
    (inner.position[1] - category.center[1]) / 0.72,
    inner.position[0] - category.center[0],
  );
  inner.position = [
    category.center[0] + Math.cos(angle) * GALAXY_RING_RADII[1],
    category.center[1] + Math.sin(angle) * GALAXY_RING_RADII[1] * 0.72,
    inner.position[2],
  ];
  invalidOrder.hierarchy.assignmentSha256 = hierarchyAssignmentSha256(invalidOrder);
  assert.ok(inspectGalaxyHierarchy(invalidOrder).issues.some((item) =>
    item.code === "hierarchy.galaxy_orbit_order"));

  const colliding = structuredClone(valid);
  colliding.galaxies[1].position = [...colliding.galaxies[0].position];
  colliding.hierarchy.assignmentSha256 = hierarchyAssignmentSha256(colliding);
  assert.ok(inspectGalaxyHierarchy(colliding).issues.some((item) =>
    item.code === "hierarchy.galaxy_collision"));
});

test("stage-refresh materializes an empty additive hierarchy without writing Graph/current", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-galaxy-stage-"));
  try {
    const seed = JSON.parse(await readFile(path.join(root, "data", "empty-universe.json"), "utf8"));
    const currentPath = path.join(support, "Graph", "current.json");
    const snapshotPath = path.join(support, "next.json");
    await mkdir(path.dirname(currentPath), { recursive: true });
    await writeFile(currentPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
    await writeFile(snapshotPath, `${JSON.stringify({ ...seed, revision: 2 }, null, 2)}\n`, "utf8");
    await execFileAsync(process.execPath, [
      stageRefresh,
      "--support-dir", support,
      "--snapshot", snapshotPath,
      "--refresh-id", "galaxy-empty",
    ]);
    const currentAfter = JSON.parse(await readFile(currentPath, "utf8"));
    const staged = JSON.parse(await readFile(path.join(support, "Graph", "staged", "galaxy-empty", "snapshot.json"), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(support, "Graph", "staged", "galaxy-empty", "manifest.json"), "utf8"));
    assert.deepEqual(currentAfter, seed);
    assert.deepEqual(staged.galaxies, []);
    assert.equal(staged.hierarchy.schemaVersion, "liteverse-hierarchy-v1");
    assert.equal(inspectGalaxyHierarchy(staged).valid, true);
    assert.deepEqual(manifest.galaxies, { added: [], changed: [], removed: [] });
    assert.equal(manifest.hierarchy.assignmentSha256, staged.hierarchy.assignmentSha256);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("the installed Curator resolves the hierarchy module from the bundled local CLI", async () => {
  const installation = await mkdtemp(path.join(tmpdir(), "liteverse-galaxy-install-"));
  try {
    const skillRoot = path.join(installation, "skills", "liteverse-curator");
    const cliLib = path.join(installation, "liteverse-cli", "lib");
    await cp(path.join(root, "skills", "liteverse-curator"), skillRoot, { recursive: true });
    await mkdir(cliLib, { recursive: true });
    await cp(
      path.join(root, "scripts", "lib", "liteverse-galaxy-hierarchy.mjs"),
      path.join(cliLib, "liteverse-galaxy-hierarchy.mjs"),
    );
    await cp(
      path.join(root, "scripts", "lib", "liteverse-galaxy-contract.mjs"),
      path.join(cliLib, "liteverse-galaxy-contract.mjs"),
    );
    const result = await execFileAsync(process.execPath, [path.join(skillRoot, "scripts", "stage-refresh.mjs"), "--help"]);
    assert.match(result.stdout, /stage-refresh\.mjs --snapshot/);
  } finally {
    await rm(installation, { recursive: true, force: true });
  }
});

test("Doctor reports malformed current hierarchy without attempting to rewrite it", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-galaxy-doctor-"));
  try {
    const malformed = materializeGalaxyHierarchy(graph([4]));
    malformed.galaxies[0].position = [0, Number.NaN, 0];
    await mkdir(path.join(support, "Graph"), { recursive: true });
    await mkdir(path.join(support, "Knowledge"), { recursive: true });
    await writeFile(path.join(support, "Graph", "current.json"), `${JSON.stringify(malformed, null, 2)}\n`, "utf8");
    await writeFile(path.join(support, "Knowledge", "papers.json"), `${JSON.stringify({ schemaVersion: 3, revision: 1, papers: [] }, null, 2)}\n`, "utf8");
    let result;
    try {
      result = await execFileAsync(process.execPath, [
        cli,
        "doctor",
        "--quick",
        "--json",
        "--support-dir", support,
      ]);
    } catch (error) {
      result = error;
    }
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "error");
    assert.ok(report.findings.some((item) => item.code === "hierarchy.galaxy_position"));
    const currentAfter = JSON.parse(await readFile(path.join(support, "Graph", "current.json"), "utf8"));
    assert.equal(currentAfter.galaxies[0].position[1], null);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});
