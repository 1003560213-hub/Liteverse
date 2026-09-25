import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Script } from "node:vm";

const execFileAsync = promisify(execFile);

test("ships an empty distributable graph without a default taxonomy", async () => {
  const universe = JSON.parse(
    await readFile(new URL("../data/empty-universe.json", import.meta.url), "utf8"),
  );
  assert.equal(universe.title, "Liteverse");
  assert.deepEqual(universe.categories, []);
  assert.deepEqual(universe.papers, []);
  assert.deepEqual(universe.relations, []);
});
test("workspace queue preserves revision safety and publishes organized state", async () => {
  const supportDirectory = await mkdtemp(path.join(tmpdir(), "liteverse-workspace-test-"));
  const script = new URL("../scripts/codex-workspace-queue.mjs", import.meta.url);
  const timestamp = new Date().toISOString();
  const library = {
    schemaVersion: 1,
    nextNumber: 2,
    items: [{
      id: "lit-test",
      number: 1,
      sourceType: "arxiv",
      displayTitle: "arXiv 2401.01234 (title pending retrieval)",
      titleStatus: "pending",
      arxivId: "2401.01234",
      arxivUrl: "https://arxiv.org/abs/2401.01234",
      status: "pending_codex",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  };
  const research = {
    schemaVersion: 1,
    status: "pending_setup",
    draft: { text: "Test research context", revision: 1, updatedAt: timestamp },
    formal: { text: "", sourceRevision: 0, organizedAt: "" },
  };
  await writeFile(path.join(supportDirectory, "library.json"), JSON.stringify(library), "utf8");
  await writeFile(path.join(supportDirectory, "research-information.json"), JSON.stringify(research), "utf8");
  const env = { ...process.env, LITEVERSE_SUPPORT_DIR: supportDirectory };
  try {
    const listed = await execFileAsync(process.execPath, [script.pathname, "list", "--json"], { env });
    const queue = JSON.parse(listed.stdout);
    assert.equal(queue.pendingLiterature.length, 1);
    assert.equal(queue.pendingResearch.draft.revision, 1);

    await assert.rejects(
      execFileAsync(process.execPath, [script.pathname, "mark-literature", "lit-test", "--revision", "2", "--disposition", "no-link"], { env }),
      /Revision mismatch/,
    );
    const begun = await execFileAsync(process.execPath, [script.pathname, "begin-literature", "lit-test", "--revision", "1"], { env });
    const lock = JSON.parse(begun.stdout);
    assert.equal(lock.revision, 2);
    await execFileAsync(process.execPath, [script.pathname, "mark-literature", "lit-test", "--revision", "2", "--disposition", "no-link", "--title", "Verified title"], { env });
    const nextLibrary = JSON.parse(await readFile(path.join(supportDirectory, "library.json"), "utf8"));
    assert.equal(nextLibrary.items[0].status, "organized");
    assert.equal(nextLibrary.items[0].revision, 3);
    assert.equal(nextLibrary.items[0].displayTitle, "Verified title");

    const formalPath = path.join(supportDirectory, "formal.md");
    await writeFile(formalPath, "# Formal research memory\n", "utf8");
    await execFileAsync(process.execPath, [script.pathname, "publish-research", "--revision", "1", "--from", formalPath], { env });
    const nextResearch = JSON.parse(await readFile(path.join(supportDirectory, "research-information.json"), "utf8"));
    assert.equal(nextResearch.status, "organized");
    assert.equal(nextResearch.formal.sourceRevision, 1);
    await access(path.join(supportDirectory, "generated", "research-memory.md"));
  } finally {
    await rm(supportDirectory, { recursive: true, force: true });
  }
});
test("legacy annotation queue is read-only and cannot bypass Curator provenance", async () => {
  const supportDirectory = await mkdtemp(path.join(tmpdir(), "liteverse-note-test-"));
  const script = new URL("../scripts/codex-note-queue.mjs", import.meta.url);
  const annotationsPath = path.join(supportDirectory, "user-annotations.json");
  const annotation = {
    id: "annotation-test",
    paperId: "paper-alpha",
    paperTitle: "Adaptive Sampling for Climate Models",
    text: "A provisional user observation.",
    status: "pending",
    revision: 2,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(annotationsPath, JSON.stringify([annotation]), "utf8");
  const env = { ...process.env, LITEVERSE_SUPPORT_DIR: supportDirectory };
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [script.pathname, "mark", annotation.id, "--revision", "1"], { env }),
      /legacy mark command is read-only/,
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [script.pathname, "mark", annotation.id, "--revision", "2"],
        { env },
      ),
      /mark-annotation\.mjs.*--refresh-id.*--derived-file/,
    );
    const next = JSON.parse(await readFile(annotationsPath, "utf8"));
    assert.equal(next[0].status, "pending");
    assert.equal(next[0].revision, 2);
    await assert.rejects(access(path.join(supportDirectory, "codex-inbox.jsonl")), /ENOENT/);
    await assert.rejects(access(path.join(supportDirectory, "user-notes", "paper-alpha.md")), /ENOENT/);
  } finally {
    await rm(supportDirectory, { recursive: true, force: true });
  }
});
test("keeps paper usage Retriever-managed with a zero integer default", async () => {
  const [component, universeText] = await Promise.all([
    readFile(new URL("../app/universe/library-model.ts", import.meta.url), "utf8"),
    readFile(new URL("../data/empty-universe.json", import.meta.url), "utf8"),
  ]);
  const universe = JSON.parse(universeText);

  assert.deepEqual(universe.usagePolicy, {
    schemaVersion: 1,
    managedBy: "liteverse-retriever",
    manualUpdates: false,
    initialValue: 0,
    counter: "useCount",
    dedupeScope: "codex-task-paper",
    ledger: "Usage/events.jsonl",
    cache: "Usage/counts.json",
    visualNormalization: { type: "log1p", referenceCount: 32 },
    regionAggregation: "primary-category-mean",
  });
  assert.equal(universe.papers.length, 0);
  assert.ok(
    universe.papers.every(
      (paper) =>
        Number.isInteger(paper.useCount) && paper.useCount === 0,
    ),
  );
  assert.ok(
    universe.papers.every(
      (paper) =>
        !("temperature" in paper) &&
        !("baseHeat" in paper) &&
        !("lifetimeUses" in paper),
    ),
  );
  assert.match(component, /paper\.useCount/);
  assert.match(component, /Math\.log1p\(Math\.max\(0, count\)\) \/ Math\.log1p\(32\)/);
  assert.doesNotMatch(component, /recordUse/);
  assert.doesNotMatch(component, /liteverse-usage-events/);
  assert.doesNotMatch(component, /record use|quick read|formula verification|simulation decision/i);
});

test("annotations are the user's own notes and stay on the native audit trail", async () => {
  const [inspector, state, nativeBridge, agentInstructions] = await Promise.all([
    readFile(new URL("../app/universe/Inspector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/universe/useLiteverse.ts", import.meta.url), "utf8"),
    readFile(new URL("../macos/LiteverseApp.m", import.meta.url), "utf8"),
    readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
  ]);
  assert.match(inspector, /Your observation, question, or interpretation/);
  assert.match(inspector, /state\.actions\.saveAnnotation\(annotation\)/);
  assert.match(inspector, /revision: \(existing\?\.revision \|\| 0\) \+ 1/);
  assert.match(state, /post\("saveAnnotation", \{ annotation \}\)/);
  assert.match(nativeBridge, /loadAnnotations/);
  assert.match(nativeBridge, /codex-inbox\.jsonl/);
  assert.match(nativeBridge, /user-notes/);
  assert.match(nativeBridge, /Annotation %@ changed revision/);
  assert.match(agentInstructions, /codex-note-queue\.mjs list/);
  assert.match(agentInstructions, /Do not mark a note organized merely because it was read/);
});

test("reviewed updates are applied through the hash-checked native commit", async () => {
  const [state, shell, nativeBridge] = await Promise.all([
    readFile(new URL("../app/universe/useLiteverse.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url), "utf8"),
    readFile(new URL("../macos/LiteverseApp.m", import.meta.url), "utf8"),
  ]);
  assert.match(state, /__liteverseReceiveUniverse/);
  assert.match(state, /__liteverseReceivePendingRefresh/);
  assert.match(state, /__liteverseRefreshCommitted/);
  assert.match(state, /post\("commitRefresh", \{\s*refreshId: pending\.refreshId,\s*baseRevision: pending\.baseRevision,\s*snapshotSha256: pending\.snapshotSha256/);
  assert.match(shell, /Apply reviewed update/);
  assert.match(nativeBridge, /pending-update\.json/);
  assert.match(nativeBridge, /snapshotSha256/);
  assert.match(nativeBridge, /CC_SHA256/);
  assert.match(nativeBridge, /ready_to_refresh/);
  assert.match(nativeBridge, /graph_refresh_committed/);
});

test("the interface keeps tiers honest and removed features gone", async () => {
  const sources = await Promise.all([
    "LiteratureUniverse.tsx", "Inspector.tsx", "Desk.tsx", "SettingsSheet.tsx", "CommandPalette.tsx", "library-model.ts",
  ].map((name) => readFile(new URL(`../app/universe/${name}`, import.meta.url), "utf8")));
  const all = sources.join("\n");
  const [shell, inspector, desk, settings] = sources;
  assert.match(all, /0: "Extracted",\s*1: "Reviewed",\s*2: "Verified"/);
  assert.match(inspector, /Apple Intelligence · on-device draft/);
  assert.match(inspector, /Not evidence; check the quoted pages\./);
  assert.match(inspector, /They are not reviewed claims\./);
  assert.match(inspector, /Citations are bibliographic facts; closeness is a similarity score\. Neither states agreement\./);
  assert.match(desk, /Cells are verbatim extracted sentences\./);
  assert.match(settings, /never become evidence, and never change reviewed cards or Usage/);
  assert.match(shell, /No AI is required for this first pass\./);
  // Removed in 0.6: Codex copy buttons, the dead context queue, duplicate search engines.
  assert.doesNotMatch(all, /Copy selection for Codex|Queue formal CLI build|searchLiterature|buildContextPreview|syncCatalog/);
});

test("includes a complete generated macOS app bundle when packaging has run", async (context) => {
  try {
    await access(new URL("../Liteverse.app/Contents/MacOS/Liteverse", import.meta.url));
  } catch (error) {
    if (error?.code === "ENOENT") {
      context.skip("Run npm run desktop:package before validating the generated app bundle.");
      return;
    }
    throw error;
  }
  await access(new URL("../Liteverse.app/Contents/Resources/web/liteverse-brand.png", import.meta.url));
  await access(new URL("../Liteverse.app/Contents/Resources/web/universe/assets.js", import.meta.url));
  await access(new URL("../Liteverse.app/Contents/Resources/web/universe/manifest.json", import.meta.url));
  await access(new URL("../Liteverse.app/Contents/MacOS/LiteverseLocalWorker", import.meta.url));
  const desktopHtml = await readFile(
    new URL("../Liteverse.app/Contents/Resources/web/index.html", import.meta.url),
    "utf8",
  );
  assert.match(desktopHtml, /<style>/);
  assert.match(desktopHtml, /<script>/);
  assert.doesNotMatch(desktopHtml, /<script type="module">/);
  assert.doesNotMatch(desktopHtml, /src="\.\/assets\//);
  const inlineScript = desktopHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript, "desktop bundle should contain an inline script");
  assert.doesNotMatch(inlineScript, /<!doctype html>/i);
  assert.doesNotThrow(
    () => new Script(inlineScript, { filename: "liteverse-inline.js" }),
    "the packaged inline script should remain valid JavaScript",
  );
  assert.doesNotMatch(inlineScript, /dev-bridge|FICTIONAL library/, "the development bridge must never ship");
  const infoPlist = await readFile(new URL("../Liteverse.app/Contents/Info.plist", import.meta.url), "utf8");
  assert.match(infoPlist, /<key>CFBundleIconFile<\/key>\s*<string>Liteverse\.icns<\/string>/);
  await access(new URL("../Liteverse.app/Contents/Resources/Liteverse.icns", import.meta.url));
  const seedUniverse = JSON.parse(await readFile(
    new URL("../Liteverse.app/Contents/Resources/seed-universe.json", import.meta.url),
    "utf8",
  ));
  assert.equal(seedUniverse.papers.length, 0);
  assert.deepEqual(await readdir(new URL("../Liteverse.app/Contents/Resources/seed-papers/", import.meta.url)), []);
  await access(new URL("../Liteverse.app/Contents/Resources/CodexSkills/liteverse-curator/SKILL.md", import.meta.url));
  await access(new URL("../Liteverse.app/Contents/Resources/CodexSkills/liteverse-retriever/SKILL.md", import.meta.url));
  await access(new URL("../Liteverse.app/Contents/Resources/install-codex-skills.sh", import.meta.url));
});

test("commits the native WKWebView first frame synchronously", async () => {
  const renderer = await readFile(new URL("../desktop/renderer.tsx", import.meta.url), "utf8");
  assert.match(renderer, /flushSync/);
  assert.match(renderer, /applicationRoot\.render/);
  assert.match(renderer, /import\.meta\.env\.DEV && !host\.webkit/);
});
