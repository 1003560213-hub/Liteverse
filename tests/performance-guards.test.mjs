import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentPath = new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url);
const nativePath = new URL("../macos/LiteverseApp.m", import.meta.url);

test("catalog persistence cannot feed workspace health back into itself", async () => {
  const [component, nativeBridge] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(nativePath, "utf8"),
  ]);

  assert.match(component, /lastCatalogSyncFingerprintRef/);
  assert.match(component, /action: "syncCatalog", items: catalogSyncItems/);
  assert.doesNotMatch(component, /action: "syncCatalog", items: catalogLibraryItems/);
  assert.match(component, /if \(lastCatalogSyncFingerprintRef\.current === fingerprint\) return/);
  assert.match(nativeBridge, /if \(\[library isEqualToDictionary:storedLibrary\]\) return/);
});

test("workspace integrity scans are cached and allocation bounded", async () => {
  const nativeBridge = await readFile(nativePath, "utf8");

  assert.match(nativeBridge, /cachedSHA256ForFileAtURL/);
  assert.match(nativeBridge, /NSFileSize/);
  assert.match(nativeBridge, /NSFileModificationDate/);
  assert.match(nativeBridge, /NSFileSystemFileNumber/);
  assert.match(nativeBridge, /@autoreleasepool/);
  assert.match(nativeBridge, /_workspaceObservationGeneration/);
  assert.match(nativeBridge, /350 \* NSEC_PER_MSEC/);
  assert.match(nativeBridge, /if \(!missingPackagedAsset && !catalogVersionChanged\) return YES/);
});

test("cinematic renderer has explicit memory and frame budgets", async () => {
  const component = await readFile(componentPath, "utf8");

  assert.match(component, /assignedNebulaAssetIds/);
  assert.match(component, /if \(!assignedNebulaAssetIds\.has\(asset\.id\)\) continue/);
  assert.match(component, /Math\.sqrt\(4_500_000 \/ Math\.max\(1, width \* height\)\)/);
  assert.match(component, /const targetFps = reducedMotion/);
  assert.match(component, /activelyMoving[\s\S]*\? 30[\s\S]*: 24/);
  assert.match(component, /backdropCanvas\.width = 0/);
  assert.match(component, /regionNebulaSprites\.clear\(\)/);
});
