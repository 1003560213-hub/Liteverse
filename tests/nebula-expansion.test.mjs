import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  mergeNebulaAssetCatalog,
  resolveNebulaAssetAssignments,
} from "../scripts/lib/nebula-catalog.mjs";

const execFileAsync = promisify(execFile);

test("packages ten unique region nebula assets and permits up to ten regions", async () => {
  const [universeText, validator, styles, nativeBridge] = await Promise.all([
    readFile(new URL("../data/universe.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/validate-universe.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../macos/LiteverseApp.m", import.meta.url), "utf8"),
  ]);
  const universe = JSON.parse(universeText);
  assert.equal(universe.visuals.nebulaAssetCatalogVersion, 2);
  assert.equal(universe.visuals.nebulaAssets.length, 10);
  assert.equal(
    new Set(universe.visuals.nebulaAssets.map((asset) => asset.id)).size,
    10,
  );
  assert.deepEqual(
    universe.visuals.nebulaAssets.slice(5).map((asset) => asset.src),
    [
      "./nebula-regions/nebula6.png",
      "./nebula-regions/nebula7.png",
      "./nebula-regions/nebula8.png",
      "./nebula-regions/nebula9.png",
      "./nebula-regions/nebula10.png",
    ],
  );
  await Promise.all(
    universe.visuals.nebulaAssets.map((asset) =>
      access(new URL(`../public/${asset.src.slice(2)}`, import.meta.url)),
    ),
  );
  assert.match(validator, /macroCategories\.length > 10/);
  assert.match(validator, /1-10/);
  assert.match(styles, /\.nebula-switcher\s*\{[^}]*overflow-x: auto/s);
  assert.match(styles, /\.nebula-switcher button\s*\{[^}]*flex: 0 0 auto/s);
  assert.match(nativeBridge, /synchronizePackagedNebulaAssetCatalogIfSafe/);
  assert.match(nativeBridge, /fileExistsAtPath:\[self pendingRefreshURL\]\.path/);
  assert.match(nativeBridge, /\.locks\/stage-refresh\.lock/);
  assert.match(nativeBridge, /createDirectoryAtURL:lockURL/);
});

test("unused-first assignment gives ten regions ten distinct packaged nebulae", () => {
  const assets = Array.from({ length: 10 }, (_, index) => ({
    id: `asset-${index + 1}`,
    enabled: true,
  }));
  const categories = Array.from({ length: 10 }, (_, index) => ({
    id: `region-${index + 1}`,
  }));
  const assignments = resolveNebulaAssetAssignments(categories, assets, "test-seed");
  assert.equal(assignments.size, 10);
  assert.equal(new Set(assignments.values()).size, 10);
  assert.deepEqual(
    [...resolveNebulaAssetAssignments(categories, assets, "test-seed")],
    [...assignments],
  );
});

test("catalog merge preserves graph revision and is idempotent", () => {
  const current = {
    revision: 7,
    visuals: {
      nebulaAssignmentSeed: "seed",
      nebulaAssets: [{ id: "asset-1", src: "./one.png", enabled: true }],
    },
  };
  const packaged = {
    visuals: {
      nebulaAssignmentSeed: "seed",
      nebulaAssetCatalogVersion: 2,
      nebulaAssets: [
        { id: "asset-1", src: "./one.png", enabled: true },
        { id: "asset-2", src: "./two.png", enabled: true },
      ],
    },
  };
  const first = mergeNebulaAssetCatalog(current, packaged);
  assert.equal(first.changed, true);
  assert.deepEqual(first.addedAssetIds, ["asset-2"]);
  assert.equal(first.graph.revision, 7);
  assert.equal(first.graph.visuals.nebulaAssets.length, 2);
  const second = mergeNebulaAssetCatalog(first.graph, packaged);
  assert.equal(second.changed, false);
  assert.equal(second.graph, first.graph);
});

test("runtime catalog sync defers while a Refresh is pending", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-nebula-sync-"));
  const graphDirectory = path.join(support, "Graph");
  await mkdir(graphDirectory, { recursive: true });
  const currentPath = path.join(graphDirectory, "current.json");
  const current = {
    revision: 11,
    visuals: {
      nebulaAssignmentSeed: "liteverse-nebula-v1",
      nebulaAssets: [{ id: "nebular-1", src: "./nebula-regions/nebular1.png", enabled: true }],
    },
  };
  await writeFile(currentPath, `${JSON.stringify(current)}\n`, "utf8");
  await writeFile(path.join(graphDirectory, "pending-update.json"), "{}\n", "utf8");
  try {
    const result = await execFileAsync(
      process.execPath,
      [new URL("../scripts/sync-runtime-nebula-assets.mjs", import.meta.url).pathname],
      { env: { ...process.env, LITEVERSE_SUPPORT_DIR: support } },
    );
    assert.match(result.stdout, /safely deferred/);
    assert.deepEqual(JSON.parse(await readFile(currentPath, "utf8")), current);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("runtime catalog sync shares Curator's atomic stage-refresh lock", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-nebula-lock-"));
  const graphDirectory = path.join(support, "Graph");
  const lockPath = path.join(support, ".locks", "stage-refresh.lock");
  await mkdir(graphDirectory, { recursive: true });
  await mkdir(lockPath, { recursive: true });
  const currentPath = path.join(graphDirectory, "current.json");
  const current = {
    revision: 21,
    visuals: {
      nebulaAssignmentSeed: "liteverse-nebula-v1",
      nebulaAssets: [{ id: "nebular-1", src: "./nebula-regions/nebular1.png", enabled: true }],
    },
  };
  await writeFile(currentPath, `${JSON.stringify(current)}\n`, "utf8");
  try {
    const result = await execFileAsync(
      process.execPath,
      [new URL("../scripts/sync-runtime-nebula-assets.mjs", import.meta.url).pathname],
      { env: { ...process.env, LITEVERSE_SUPPORT_DIR: support } },
    );
    assert.match(result.stdout, /stage-refresh lock is active/);
    assert.deepEqual(JSON.parse(await readFile(currentPath, "utf8")), current);
    await access(lockPath);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});

test("runtime catalog sync atomically upgrades an existing graph", async () => {
  const support = await mkdtemp(path.join(tmpdir(), "liteverse-nebula-sync-"));
  const graphDirectory = path.join(support, "Graph");
  await mkdir(graphDirectory, { recursive: true });
  const currentPath = path.join(graphDirectory, "current.json");
  const current = {
    revision: 12,
    visuals: {
      nebulaAssignmentSeed: "liteverse-nebula-v1",
      nebulaAssets: [{ id: "nebular-1", src: "./nebula-regions/nebular1.png", enabled: true }],
    },
  };
  await writeFile(currentPath, `${JSON.stringify(current)}\n`, "utf8");
  try {
    await execFileAsync(
      process.execPath,
      [new URL("../scripts/sync-runtime-nebula-assets.mjs", import.meta.url).pathname],
      { env: { ...process.env, LITEVERSE_SUPPORT_DIR: support } },
    );
    const migrated = JSON.parse(await readFile(currentPath, "utf8"));
    assert.equal(migrated.revision, 12);
    assert.equal(migrated.visuals.nebulaAssetCatalogVersion, 2);
    assert.equal(migrated.visuals.nebulaAssets.length, 10);
  } finally {
    await rm(support, { recursive: true, force: true });
  }
});
