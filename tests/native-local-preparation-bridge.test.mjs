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
  assert.match(source, /source\[@"pdfPath"\] = registeredURL\.path/);
  assert.match(source, /source\[@"storageMode"\] = linkedSource \? @"linked" : @"managed"/);
  assert.match(source, /source\[@"arxivId"\] = arxivID/);
  assert.match(source, /@"preparation": \[self queuedPreparationWithJobID:jobID sourceRevision:1\]/);
  assert.match(source, /@"status": @"pending_codex"/);
  assert.match(source, /action isEqualToString:@"retryLocalPreparation"/);
  assert.match(source, /expectedRevision:payload\[@"expectedRevision"\]/);

  const finisher = source.match(/- \(void\)finishLocalPreparationForItemID:[\s\S]+?\n}\n\n- \(void\)runLocalPreparationForItem:/)?.[0] || "";
  assert.match(finisher, /matches != 1/);
  assert.match(finisher, /current\[@"revision"\]/);
  assert.match(finisher, /preparation\[@"sourceRevision"\]/);
  assert.match(finisher, /autoResolvedDuplicate/);
  assert.match(finisher, /updated\[@"status"\] = @"organized"/);
  assert.match(finisher, /updated\[@"disposition"\] = @"duplicate"/);
  assert.match(finisher, /updated\[@"duplicateOfPaperId"\]/);
  assert.match(finisher, /strict_identity_v1/);
  assert.match(finisher, /literature_duplicate_auto_resolved/);
  assert.match(finisher, /writeJSONObject:storedLibrary toURL:\[self libraryURL\]/);
  assert.match(finisher, /writeJSONObject:library toURL:\[self libraryURL\]/);
  assert.doesNotMatch(finisher, /currentGraphURL|usageCountsURL|researchInformationURL|projectResearchInformationURL/);
});

test("strict duplicate auto-resolution closes identifiers against the pinned catalog", async () => {
  const source = await readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8");
  const validator = source.match(/- \(NSDictionary \*\)validatedStrictDuplicateResolutionForManifest:[\s\S]+?\n}\n\n- \(BOOL\)localPreparationFileAtURL:/)?.[0] || "";
  const resultValidator = source.match(/- \(NSDictionary \*\)validatedLocalPreparationOutput:[\s\S]+?\n}\n\n- \(NSDictionary \*\)routingScreeningInputForManifest:/)?.[0] || "";

  assert.match(validator, /allowedKeys.*@"sha256", @"arxiv_id", @"doi"/s);
  assert.match(validator, /uniqueKeys\.count == 0 \|\| conflicts\.count > 0/);
  assert.match(validator, /papersIndexURL/);
  assert.match(validator, /targetCount != 1/);
  assert.match(validator, /targetSHA isEqualToString:sourceSHA/);
  assert.match(validator, /canonicalArxiv isEqualToString:incomingArxiv/);
  assert.match(validator, /canonicalDOI isEqualToString:incomingDOI/);
  assert.match(validator, /targetArxiv isEqualToString:incomingArxiv/);
  assert.match(validator, /targetDOI isEqualToString:incomingDOI/);
  assert.match(validator, /differing known.*DOI or arXiv identities require manual review/s);
  assert.match(resultValidator, /validatedStrictDuplicateResolutionForManifest:manifest/);
});

test("native bridge links local literature folders without duplicating source PDFs", async () => {
  const source = await readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8");
  const scanner = source.match(/- \(NSArray<NSDictionary \*> \*\)linkedPDFDescriptorsUnderRootURL:[\s\S]+?\n}\n\n- \(void\)linkLiteratureFolderURL:/)?.[0] || "";
  const linker = source.match(/- \(void\)linkLiteratureFolderURL:[\s\S]+?\n}\n\n- \(void\)presentLiteratureFolderImporter/)?.[0] || "";
  const syncCatalog = source.match(/- \(void\)syncCatalogItems:[\s\S]+?\n}\n\n- \(BOOL\)isLowercaseSHA256/)?.[0] || "";

  assert.match(source, /action isEqualToString:@"pickLiteratureFolder"/);
  assert.match(source, /presentLiteratureFolderImporter/);
  assert.match(scanner, /NSDirectoryEnumerationSkipsHiddenFiles/);
  assert.match(scanner, /NSDirectoryEnumerationSkipsPackageDescendants/);
  assert.match(scanner, /NSURLIsSymbolicLinkKey/);
  assert.match(scanner, /URLByResolvingSymlinksInPath/);
  assert.match(linker, /@"storageMode": @"linked"/);
  assert.match(linker, /@"linkedRootPath": descriptor\[@"linkedRootPath"\]/);
  assert.match(linker, /@"relativePath": descriptor\[@"relativePath"\]/);
  assert.match(linker, /@"action": @"literature_pdf_linked"/);
  assert.match(linker, /without copying the source files/);
  assert.match(linker, /knownPaths\[descriptor\[@"pdfPath"\]\]/);
  assert.match(linker, /changedCount \+= 1/);
  assert.match(linker, /kept the original reference and hash/);
  assert.match(linker, /@"action": @"literature_pdf_link_changed"/);
  assert.match(linker, /@"observedSha256": change\[@"observedSha256"\]/);
  assert.match(linker, /@"screeningCandidates", @"screeningMethod", @"screeningAnchorIds"/);
  assert.match(linker, /@"duplicateOf", @"deduplication"/);
  assert.match(linker, /wasAutoResolvedDuplicate/);
  assert.match(linker, /@"disposition", @"duplicateOfPaperId", @"autoResolution", @"organizedAt"/);
  assert.doesNotMatch(linker, /source\[@"sha256"\] = sourceHash/);
  assert.doesNotMatch(linker, /managedPDFRelativePathForSourceURL|copyItemAtURL/);
  assert.match(syncCatalog, /BOOL linkedSource = \[self isLinkedPDFSource:rawSource\]/);
  assert.match(syncCatalog, /cachedSHA256ForFileAtURL:existingURL/);
  assert.doesNotMatch(syncCatalog, /sha256ForFileAtURL:existingURL/);
  assert.doesNotMatch(syncCatalog, /managedPDFRelativePathForSourceURL/);
});

test("linked-source native contracts fail closed across preparation, open, refresh, and backup", async () => {
  const source = await readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8");
  const linkedValidator = source.match(/- \(NSURL \*\)linkedPDFURLForSource:[\s\S]+?\n}\n\n- \(NSURL \*\)managedPDFURLForSource/)?.[0] || "";
  const resultValidator = source.match(/- \(NSDictionary \*\)validatedLocalPreparationOutput:[\s\S]+?\n}\n\n- \(void\)finishLocalPreparationForItemID:/)?.[0] || "";

  assert.match(linkedValidator, /linkedRootPath/);
  assert.match(linkedValidator, /relativePath/);
  assert.match(linkedValidator, /URLByResolvingSymlinksInPath/);
  assert.match(linkedValidator, /rootIsSymbolicLink/);
  assert.match(linkedValidator, /fileIsSymbolicLink/);
  assert.match(linkedValidator, /linked PDF changed after it was registered/);
  assert.match(resultValidator, /linkedReady && \(\[roles containsObject:@"pdf"\]/);
  assert.match(resultValidator, /suggestedDestinations\[@"source\.pdf"\]/);
  assert.match(source, /validateLinkedSourcesInGraph:snapshot error:&error/);
  assert.match(source, /registeredLinkedPDFURLForPath/);
  assert.match(source, /backup contains an invalid linked PDF reference/);
  assert.match(source, /Linked PDFs intentionally remain outside the backup/);
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
  assert.match(source, /nextPreparation\[@"screeningIndexFingerprint"\]/);
  assert.match(source, /@"paperId": paperID/);
  assert.match(source, /@"routingOnly": @YES/);
  assert.match(source, /route\[@"matchingClaims"\] = claimRoutes/);
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
