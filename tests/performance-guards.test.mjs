import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentPath = new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url);
const nativePath = new URL("../macos/LiteverseApp.m", import.meta.url);
const packageScriptPath = new URL("../scripts/build-macos-app.sh", import.meta.url);

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
  const [component, packageScript] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(packageScriptPath, "utf8"),
  ]);

  assert.match(component, /assignedNebulaAssetIds/);
  assert.match(component, /if \(!assignedNebulaAssetIds\.has\(asset\.id\)\) continue/);
  assert.match(component, /Math\.sqrt\(4_500_000 \/ Math\.max\(1, width \* height\)\)/);
  assert.match(component, /const INTERACTION_FPS = 30/);
  assert.match(component, /const IDLE_FPS = 12/);
  assert.match(component, /const BACKGROUND_FPS = 4/);
  assert.match(component, /const targetFps = windowFocused/);
  assert.match(component, /activelyMoving[\s\S]*\? reducedMotion[\s\S]*\? IDLE_FPS[\s\S]*: INTERACTION_FPS[\s\S]*: reducedMotion[\s\S]*\? BACKGROUND_FPS[\s\S]*: IDLE_FPS[\s\S]*: BACKGROUND_FPS/);
  assert.match(component, /if \(document\.hidden\) \{[\s\S]*frame = 0/);
  assert.match(component, /categoryFilterRef\.current/);
  assert.match(component, /backdropCanvas\.width = 0/);
  assert.match(component, /regionNebulaSprites\.clear\(\)/);
  assert.match(component, /const maximumDimension = 420/);
  assert.match(component, /for \(const assetId of new Set[\s\S]*await loadGalaxySprite\(assetId\)/);
  assert.match(component, /liteverse-black-hole-transparent\.png/);
  assert.match(component, /const ALL_VIEW_AMBIENT_PAPERS_PER_NEBULA = 12/);
  assert.match(component, /const FOCUSED_AMBIENT_PAPERS_PER_NEBULA = 48/);
  assert.match(component, /ambientPaperSelections = new Map/);
  assert.match(
    component,
    /const galaxyPositions = new Map\([\s\S]*containPointInNebulaEllipse\(rawPoint, categoryFrame, 0\.58, 0\.34\)/,
  );
  assert.match(component, /const source = galaxyPositions\.get\(sourceGalaxy\.id\)!/);
  assert.match(component, /const target = galaxyPositions\.get\(targetGalaxy\.id\)!/);
  const ambientStart = component.indexOf("const showAmbientPaperFlashes =");
  const ambientEnd = component.indexOf("projectedGalaxiesRef.current", ambientStart);
  assert.ok(ambientStart >= 0 && ambientEnd > ambientStart);
  const ambientSection = component.slice(ambientStart, ambientEnd);
  assert.match(ambientSection, /for \(const paperId of ambientPaperIds\)/);
  assert.doesNotMatch(ambientSection, /for \(const paper of renderUniverse\.papers\)/);
  assert.match(ambientSection, /containPointInNebulaEllipse/);
  assert.doesNotMatch(component, /getImageData\(/);
  assert.match(packageScript, /for GALAXY_ASSET in .*web\/galaxies.*\.png/);
  assert.match(packageScript, /sips -Z 768 .*liteverse-black-hole-transparent\.png/);
});
