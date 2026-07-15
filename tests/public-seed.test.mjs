import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the distributable app starts from a private empty workspace", async () => {
  const seedText = await readFile(
    new URL("../data/empty-universe.json", import.meta.url),
    "utf8",
  );
  const seed = JSON.parse(seedText);

  assert.equal(seed.schemaVersion, "3.0.0");
  assert.deepEqual(seed.categories, []);
  assert.deepEqual(seed.papers, []);
  assert.deepEqual(seed.relations, []);
  assert.equal(seed.visuals.nebulaAssets.filter((asset) => asset.enabled).length, 10);
  assert.doesNotMatch(seedText, /\/Users\//);
});

test("macOS packaging embeds the empty seed and excludes private paper cards", async () => {
  const buildScript = await readFile(
    new URL("../scripts/build-macos-app.sh", import.meta.url),
    "utf8",
  );

  assert.match(buildScript, /data\/empty-universe\.json/);
  assert.match(buildScript, /Resources\/CodexSkills/);
  assert.match(buildScript, /Resources\/LiteverseCLI/);
  assert.match(buildScript, /liteverse-cli\.mjs/);
  assert.match(buildScript, /install-codex-skills\.sh/);
  assert.match(buildScript, /--exclude '__pycache__'/);
  assert.doesNotMatch(buildScript, /ditto[^\n]+data\/papers/);
});

test("the explicit installer is scoped to the three Liteverse Skills and local CLI", async () => {
  const installer = await readFile(
    new URL("../scripts/install-codex-skills.sh", import.meta.url),
    "utf8",
  );
  assert.match(installer, /liteverse-curator liteverse-retriever liteverse-research-memory/);
  assert.match(installer, /liteverse-cli/);
  assert.match(installer, /CODEX_ROOT\/bin\/liteverse/);
  assert.match(installer, /CODEX_HOME/);
  assert.match(installer, /--exclude '__pycache__'/);
  assert.doesNotMatch(installer, /data\/papers|Application Support\/Liteverse/);
});

test("backup and workspace-health native actions are wired into the settings UI", async () => {
  const [universeSource, settingsSource, nativeSource] = await Promise.all([
    readFile(new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/universe/SettingsDrawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../macos/LiteverseApp.m", import.meta.url), "utf8"),
  ]);

  assert.match(universeSource, /action: "loadWorkspaceHealth"/);
  assert.match(universeSource, /action: "exportWorkspace", includePDFs/);
  assert.match(universeSource, /action: "importWorkspace"/);
  assert.match(settingsSource, /BACKUP &amp; RECOVERY/);
  assert.match(settingsSource, /Include source PDFs/);
  assert.match(nativeSource, /__liteverseWorkspaceExported/);
  assert.match(nativeSource, /__liteverseWorkspaceImported/);
});
