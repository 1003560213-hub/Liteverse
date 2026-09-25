import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentPath = new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url);
const nativePath = new URL("../macos/LiteverseApp.m", import.meta.url);
const packageScriptPath = new URL("../scripts/build-macos-app.sh", import.meta.url);
const scenePath = new URL("../app/universe/sky/SkyScene.ts", import.meta.url);
const shadersPath = new URL("../app/universe/sky/shaders.ts", import.meta.url);
const stylesPath = new URL("../app/globals.css", import.meta.url);

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

test("the 3D renderer draws on demand and scales down on battery and heat", async () => {
  const [scene, shaders, shell, packageScript] = await Promise.all([
    readFile(scenePath, "utf8"),
    readFile(shadersPath, "utf8"),
    readFile(componentPath, "utf8"),
    readFile(packageScriptPath, "utf8"),
  ]);
  // No perpetual animation loop: frames are requested only on change, during
  // a transition, or by a capped ambient interval.
  assert.match(scene, /invalidate\(\) \{\s*if \(this\.disposed \|\| this\.frameRequested\) return;/);
  assert.match(scene, /if \(animating\) this\.invalidate\(\);/);
  assert.doesNotMatch(scene, /requestAnimationFrame\(this\.frame\);\s*\n\s*this\.renderer\.render/);
  assert.match(scene, /efficient: \{ pixelRatio: 1, pointsPerPixel2: 0\.5, minPoints: 900, ambientFps: 0 \}/);
  assert.match(scene, /if \(this\.ambient && fps > 0 && !this\.disposed\)/);
  // Level of detail: galaxies off screen are skipped and point budgets follow
  // projected area.
  assert.match(scene, /renderable\.group\.visible = onScreen;/);
  assert.match(scene, /pixels \* pixels \* settings\.pointsPerPixel2/);
  // Surface brightness is conserved across distance and level of detail.
  assert.match(scene, /SURFACE_BRIGHTNESS \* area\) \/ Math\.max\(1, count\)/);
  assert.match(shaders, /uAlphaScale \* relative \* relative \/ footprint/);
  // Power state drives quality and ambient motion.
  assert.match(shell, /power\.lowPowerMode \|\| power\.onBattery \|\| power\.thermalState === "serious"/);
  assert.match(shell, /ambientPreference && !constrained && !power\.occluded && documentVisible/);
  // No stacked blur over the live scene; no PNG sticker artwork is packaged.
  assert.doesNotMatch(await readFile(stylesPath, "utf8"), /backdrop-filter/);
  assert.doesNotMatch(packageScript, /galaxies\/\*\.png|nebula-regions/);
});
