import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function method(source, start, end) {
  return source.match(new RegExp(`${start}[\\s\\S]+?${end}`))?.[0] || "";
}

test("Zotero intake is read-only, bounded, and discovers only stored PDF attachments", async () => {
  const source = await readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8");
  const discovery = method(
    source,
    "- \\(NSDictionary \\*\\)zoteroDiscoveryForSelectionURL:",
    "\\n}\\n\\n- \\(void\\)linkZoteroSelectionURL:",
  );

  assert.match(source, /action isEqualToString:@"pickZoteroLibrary"/);
  assert.match(source, /presentZoteroImporter/);
  assert.match(discovery, /SQLITE_OPEN_READONLY \| SQLITE_OPEN_FULLMUTEX/);
  assert.match(discovery, /sqlite3_db_readonly\(database, "main"\) != 1/);
  assert.match(discovery, /PRAGMA query_only=ON/);
  assert.match(discovery, /BEGIN DEFERRED TRANSACTION/);
  assert.match(discovery, /FROM itemAttachments ia/);
  assert.match(discovery, /FROM itemCreators ic/);
  assert.match(discovery, /JOIN creators c ON c\.creatorID = ic\.creatorID/);
  assert.match(discovery, /ORDER BY ic\.itemID, ic\.orderIndex/);
  assert.match(discovery, /lower\(fieldName\) = 'doi'/);
  assert.match(discovery, /hasRichCatalogMetadata = NO/);
  assert.match(discovery, /LEFT JOIN deletedItems deletedAttachment/);
  assert.match(discovery, /\[storedPath hasPrefix:@"storage:"\]/);
  assert.match(discovery, /LIMIT 10001/);
  assert.match(discovery, /descriptors\.count >= 10000/);
  assert.match(discovery, /authors\.count < 128/);
  assert.match(discovery, /linkedPDFURLForSource:source requireExisting:YES verifyHash:NO/);
  assert.doesNotMatch(discovery, /copyItemAtURL|writeJSONObject|INSERT|UPDATE|DELETE FROM/);
});

test("Zotero PDFs remain linked in place with stable item and attachment provenance", async () => {
  const source = await readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8");
  const linker = method(
    source,
    "- \\(void\\)linkZoteroSelectionURL:",
    "\\n}\\n\\n- \\(void\\)presentZoteroImporter",
  );
  const discovery = method(
    source,
    "- \\(NSDictionary \\*\\)zoteroDiscoveryForSelectionURL:",
    "\\n}\\n\\n- \\(void\\)linkZoteroSelectionURL:",
  );

  assert.match(linker, /@"storageMode": @"linked"/);
  assert.match(linker, /source\[@"provenance"\] = descriptor\[@"provenance"\]/);
  assert.match(discovery, /@"catalogMetadata": catalogMetadata/);
  assert.match(linker, /source\[@"catalogMetadata"\] = catalogMetadata/);
  assert.match(source, /registeredSource\[@"catalogMetadata"\]/);
  assert.match(source, /source\[@"authors"\] = catalogAuthors/);
  assert.match(source, /source\[@"doi"\] = catalogDOI/);
  assert.match(discovery, /@"catalog": @"zotero"/);
  assert.match(discovery, /@"itemKey": itemKey/);
  assert.match(discovery, /@"attachmentKey": attachmentKey/);
  assert.match(linker, /@"action": @"literature_zotero_pdf_linked"/);
  assert.match(linker, /queuedPreparationWithJobID:\[self localPreparationJobID\] sourceRevision:1/);
  assert.match(linker, /for \(NSDictionary \*item in createdItems\) \[self scheduleLocalPreparationForItem:item\]/);
  assert.match(linker, /without copying originals/);
  assert.match(linker, /@"screeningCandidates", @"screeningMethod", @"screeningAnchorIds"/);
  assert.match(linker, /@"duplicateOf", @"deduplication"/);
  assert.match(linker, /wasAutoResolvedDuplicate/);
  assert.match(linker, /@"disposition", @"duplicateOfPaperId", @"autoResolution", @"organizedAt"/);
  assert.doesNotMatch(linker, /managedPDFRelativePathForSourceURL|copyItemAtURL/);
});

test("Review Packet v2 drives a capped routing-only BM25 screen", async () => {
  const source = await readFile(path.join(root, "macos", "LiteverseApp.m"), "utf8");
  const screening = method(
    source,
    "- \\(NSDictionary \\*\\)routingScreeningInputForManifest:",
    "\\n}\\n\\n- \\(void\\)finishLocalPreparationForItemID:",
  );
  const finisher = method(
    source,
    "- \\(void\\)finishLocalPreparationForItemID:",
    "\\n}\\n\\n- \\(void\\)runLocalPreparationForItem:",
  );

  assert.match(source, /liteverse-review-packet-v2/);
  assert.match(source, /liteverse-review-packet-v1-fields/);
  assert.match(screening, /@\[ @"researchQuestions", @"methods", @"results" \]/);
  assert.match(screening, /@"fts5_bm25_review_packet_v2"/);
  assert.match(screening, /@"anchorIds": anchorIDs/);
  assert.match(finisher, /searchLiteratureAtIndexForQuery:screeningQuery limit:24/);
  assert.match(finisher, /nextPreparation\[@"screeningCandidates"\] = candidates/);
  assert.match(finisher, /nextPreparation\[@"screeningAnchorIds"\]/);
  assert.match(finisher, /nextPreparation\[@"screeningIndexFingerprint"\]/);
  assert.match(finisher, /route\[@"matchingClaims"\] = claimRoutes/);
  assert.match(finisher, /@"routingOnly": @YES/);
  assert.doesNotMatch(finisher, /relationStrength.*YES|writesGraph.*YES|writesUsage.*YES/);
});

test("Library UI exposes Zotero without changing the linked-source trust model", async () => {
  const [drawer, types, finalizer] = await Promise.all([
    readFile(path.join(root, "app", "universe", "SettingsDrawer.tsx"), "utf8"),
    readFile(path.join(root, "app", "universe", "types.ts"), "utf8"),
    readFile(path.join(root, "skills", "liteverse-curator", "scripts", "finalize-curated-snapshot.py"), "utf8"),
  ]);

  assert.match(drawer, /onPickZoteroLibrary: \(\) => void/);
  assert.match(drawer, /Connect Zotero/);
  assert.match(drawer, /onClick=\{onPickZoteroLibrary\}/);
  assert.match(drawer, /catalog: "zotero"/);
  assert.match(types, /catalog: "zotero"/);
  assert.match(types, /attachmentKey: string/);
  assert.match(finalizer, /paper\["source"\] = \{\s*\*\*source,/);
});
