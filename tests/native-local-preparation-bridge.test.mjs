import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("native bridge queues the bundled helper without changing scientific truth", async () => {
  const source = await readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8");

  assert.match(source, /dispatch_queue_t _localPreparationQueue/);
  assert.match(source, /dispatch_queue_create\("com\.liteverse\.local-preparation"/);
  assert.match(source, /LiteverseLocalWorker/);
  assert.match(source, /NSTask \*task/);
  assert.match(source, /NSPipe \*stdinPipe/);
  assert.match(source, /NSPipe \*stdoutPipe/);
  assert.match(source, /liteverse-local-job-v1/);
  assert.match(source, /catalogFingerprint/);
  assert.match(source, /source\[@"pdfPath"\] = resolvedManagedURL\.path/);
  assert.match(source, /source\[@"arxivId"\] = arxivID/);
  assert.match(source, /@"preparation": \[self queuedPreparationWithJobID:jobID sourceRevision:1\]/);
  assert.match(source, /@"status": @"pending_codex"/);
  assert.match(source, /action isEqualToString:@"retryLocalPreparation"/);
  assert.match(source, /expectedRevision:payload\[@"expectedRevision"\]/);

  const finisher = source.match(/- \(void\)finishLocalPreparationForItemID:[\s\S]+?\n}\n\n- \(void\)runLocalPreparationForItem:/)?.[0] || "";
  assert.match(finisher, /matches != 1/);
  assert.match(finisher, /current\[@"revision"\]/);
  assert.match(finisher, /preparation\[@"sourceRevision"\]/);
  assert.match(finisher, /updated\[@"status"\] = ready \? @"pending_codex" : @"needs_attention"/);
  assert.match(finisher, /writeJSONObject:library toURL:\[self libraryURL\]/);
  assert.doesNotMatch(finisher, /currentGraphURL|usageCountsURL|researchInformationURL|projectResearchInformationURL/);
});

test("native bridge validates the immutable result before adopting one item revision", async () => {
  const source = await readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8");
  const validator = source.match(/- \(NSDictionary \*\)validatedLocalPreparationOutput:[\s\S]+?\n}\n\n- \(void\)finishLocalPreparationForItemID:/)?.[0] || "";

  assert.match(validator, /liteverse-local-result-v1/);
  assert.match(validator, /liteverse-local-job-v1/);
  assert.match(validator, /itemRevision/);
  assert.match(validator, /catalogFingerprint/);
  assert.match(validator, /isConfinedToRoot/);
  assert.match(source, /NSURLIsSymbolicLinkKey/);
  assert.match(validator, /NSFileSize/);
  assert.match(validator, /sha256ForFileAtURL/);
  assert.match(validator, /@"review_packet": @\(kReviewPacketLimit\)/);
  assert.match(validator, /storedManifest isEqualToData:stdoutData/);
  assert.match(validator, /writesGraphCurrent/);
  assert.match(validator, /writesUsage/);
  assert.match(validator, /writesResearchMemory/);
  assert.match(source, /Knowledge\/papers\.json changed while local preparation was running/);
  assert.match(source, /nextPreparation\[@"reviewPacketPath"\]/);
  assert.match(source, /searchLiteratureAtIndexForQuery:canonicalTitle limit:12/);
  assert.match(source, /nextPreparation\[@"screeningCandidates"\] = candidates/);
  assert.match(source, /@"paperId": paperID, @"rank": rank/);
});

test("Library UI exposes preparation state and revision-pinned retry in English", async () => {
  const [drawer, universe, styles] = await Promise.all([
    readFile(path.join(root, "app", "universe", "SettingsDrawer.tsx"), "utf8"),
    readFile(path.join(root, "app", "universe", "LiteratureUniverse.tsx"), "utf8"),
    readFile(path.join(root, "app", "globals.css"), "utf8"),
  ]);

  assert.match(drawer, /state: "queued" \| "ready" \| "needs_attention"/);
  assert.match(drawer, /Preparing locally/);
  assert.match(drawer, /Locally prepared/);
  assert.match(drawer, /Preparation needs attention/);
  assert.match(drawer, /Retry local preparation/);
  assert.match(universe, /action: "retryLocalPreparation"/);
  assert.match(universe, /expectedRevision: item\.revision/);
  assert.match(styles, /\.library-preparation-retry/);
  assert.match(styles, /min-height: 36px/);
});
