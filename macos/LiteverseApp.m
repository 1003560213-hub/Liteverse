#import <Cocoa/Cocoa.h>
#import <CommonCrypto/CommonDigest.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <WebKit/WebKit.h>
#import <fcntl.h>
#import <sqlite3.h>
#import <unistd.h>

@interface LiteverseAppDelegate : NSObject <NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate> {
  dispatch_queue_t _persistenceQueue;
  dispatch_source_t _pendingRefreshSource;
  dispatch_source_t _workspaceSource;
  NSUInteger _workspaceObservationGeneration;
  NSMutableDictionary<NSString *, NSDictionary *> *_sourceHashCache;
}
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSURL *webDirectoryURL;
- (NSDictionary *)readDictionaryAtURL:(NSURL *)url
                         defaultValue:(NSDictionary *)defaultValue
                                error:(NSError **)error;
- (BOOL)writeJSONObject:(id)object toURL:(NSURL *)url error:(NSError **)error;
- (NSDictionary *)validateBackupAtURL:(NSURL *)backupURL error:(NSError **)error;
- (NSDictionary *)searchLiteratureAtIndexForQuery:(NSString *)query
                                             limit:(NSInteger)limit
                                             error:(NSError **)error;
@end

@implementation LiteverseAppDelegate

- (void)configureApplicationMenus {
  NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@""];

  NSMenuItem *applicationMenuItem = [[NSMenuItem alloc] initWithTitle:@""
                                                               action:nil
                                                        keyEquivalent:@""];
  [mainMenu addItem:applicationMenuItem];
  NSMenu *applicationMenu = [[NSMenu alloc] initWithTitle:@"Liteverse"];
  [applicationMenu addItemWithTitle:@"About Liteverse"
                             action:@selector(orderFrontStandardAboutPanel:)
                      keyEquivalent:@""];
  [applicationMenu addItem:NSMenuItem.separatorItem];
  [applicationMenu addItemWithTitle:@"Quit Liteverse"
                             action:@selector(terminate:)
                      keyEquivalent:@"q"];
  applicationMenuItem.submenu = applicationMenu;

  // WKWebView forwards these standard editing selectors through the macOS
  // responder chain. Without an Edit menu, keyboard shortcuts such as Cmd+V
  // never reach a focused textarea in this programmatic AppKit shell.
  NSMenuItem *editMenuItem = [[NSMenuItem alloc] initWithTitle:@""
                                                        action:nil
                                                 keyEquivalent:@""];
  [mainMenu addItem:editMenuItem];
  NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
  [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
  NSMenuItem *redoItem = [editMenu addItemWithTitle:@"Redo"
                                             action:@selector(redo:)
                                      keyEquivalent:@"z"];
  redoItem.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
  [editMenu addItem:NSMenuItem.separatorItem];
  [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
  [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
  [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
  [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
  editMenuItem.submenu = editMenu;

  NSApp.mainMenu = mainMenu;
}

- (NSError *)storageError:(NSString *)message code:(NSInteger)code {
  return [NSError errorWithDomain:@"com.liteverse.storage"
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message ?: @"Liteverse storage error"}];
}

- (NSString *)isoTimestamp {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  return [formatter stringFromDate:NSDate.date];
}

- (NSURL *)applicationSupportURL {
  NSURL *baseURL = [[[NSFileManager defaultManager]
      URLsForDirectory:NSApplicationSupportDirectory
             inDomains:NSUserDomainMask] firstObject];
  NSURL *directory = [baseURL URLByAppendingPathComponent:@"Liteverse" isDirectory:YES];
  if (![[NSFileManager defaultManager] fileExistsAtPath:directory.path]) {
    [[NSFileManager defaultManager] createDirectoryAtURL:directory
                             withIntermediateDirectories:YES
                                              attributes:nil
                                                   error:nil];
  }
  return directory;
}

- (NSURL *)annotationsURL {
  return [[self applicationSupportURL] URLByAppendingPathComponent:@"user-annotations.json"];
}

- (NSURL *)libraryURL {
  return [[self applicationSupportURL] URLByAppendingPathComponent:@"library.json"];
}

- (NSURL *)researchInformationURL {
  return [[self applicationSupportURL] URLByAppendingPathComponent:@"research-information.json"];
}

- (NSURL *)workspaceInboxURL {
  return [[self applicationSupportURL] URLByAppendingPathComponent:@"workspace-inbox.jsonl"];
}

- (NSURL *)workspaceMetadataURL {
  return [[self applicationSupportURL] URLByAppendingPathComponent:@"workspace.json"];
}

- (NSURL *)workspaceRecoveryDirectoryURL {
  return [[self applicationSupportURL] URLByAppendingPathComponent:@"Recovered" isDirectory:YES];
}

- (NSURL *)pdfDirectoryURL {
  NSURL *directory = [[self applicationSupportURL] URLByAppendingPathComponent:@"Library/PDFs" isDirectory:YES];
  if (![[NSFileManager defaultManager] fileExistsAtPath:directory.path]) {
    [[NSFileManager defaultManager] createDirectoryAtURL:directory
                             withIntermediateDirectories:YES
                                              attributes:nil
                                                   error:nil];
  }
  return directory;
}

- (NSURL *)graphDirectoryURL {
  return [[self applicationSupportURL] URLByAppendingPathComponent:@"Graph" isDirectory:YES];
}

- (NSURL *)currentGraphURL {
  return [[self graphDirectoryURL] URLByAppendingPathComponent:@"current.json"];
}

- (NSURL *)partitionProposalsURL {
  return [[self graphDirectoryURL] URLByAppendingPathComponent:@"partition-proposals.json"];
}

- (NSURL *)pendingRefreshURL {
  return [[self graphDirectoryURL] URLByAppendingPathComponent:@"pending-update.json"];
}

- (NSURL *)stagedGraphDirectoryURL {
  return [[self graphDirectoryURL] URLByAppendingPathComponent:@"staged" isDirectory:YES];
}

- (NSURL *)graphHistoryDirectoryURL {
  return [[self graphDirectoryURL] URLByAppendingPathComponent:@"history" isDirectory:YES];
}

- (NSURL *)stageRefreshLockURL {
  return [[self applicationSupportURL]
      URLByAppendingPathComponent:@".locks/stage-refresh.lock" isDirectory:YES];
}

- (NSURL *)usageDirectoryURL {
  return [[self applicationSupportURL] URLByAppendingPathComponent:@"Usage" isDirectory:YES];
}

- (NSURL *)usageCountsURL {
  return [[self usageDirectoryURL] URLByAppendingPathComponent:@"counts.json"];
}

- (NSURL *)knowledgeCardsDirectoryURL {
  return [[self applicationSupportURL] URLByAppendingPathComponent:@"Knowledge/cards" isDirectory:YES];
}

- (NSURL *)searchIndexURL {
  return [[self applicationSupportURL]
      URLByAppendingPathComponent:@"Cache/Search/liteverse.sqlite"];
}

- (NSURL *)papersIndexURL {
  return [[self applicationSupportURL] URLByAppendingPathComponent:@"Knowledge/papers.json"];
}

- (NSURL *)projectsDirectoryURL {
  return [[self applicationSupportURL] URLByAppendingPathComponent:@"Projects" isDirectory:YES];
}

- (NSURL *)projectsRegistryURL {
  return [[self projectsDirectoryURL] URLByAppendingPathComponent:@"projects.json"];
}

- (NSURL *)activeProjectURL {
  return [[self projectsDirectoryURL] URLByAppendingPathComponent:@"active.json"];
}

- (BOOL)isSafeProjectID:(NSString *)projectID {
  if (![projectID isKindOfClass:NSString.class] || projectID.length == 0 || projectID.length > 120) return NO;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
      @"abcdefghijklmnopqrstuvwxyz0123456789._-"];
  return [projectID rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound &&
      ![projectID isEqualToString:@"."] && ![projectID isEqualToString:@".."];
}

- (NSURL *)projectDirectoryURLForID:(NSString *)projectID error:(NSError **)error {
  if (![self isSafeProjectID:projectID]) {
    if (error) *error = [self storageError:@"The project ID is invalid." code:530];
    return nil;
  }
  return [[self projectsDirectoryURL] URLByAppendingPathComponent:projectID isDirectory:YES];
}

- (NSURL *)projectResearchInformationURLForID:(NSString *)projectID error:(NSError **)error {
  return [[self projectDirectoryURLForID:projectID error:error]
      URLByAppendingPathComponent:@"research-information.json"];
}

- (BOOL)isSafeWorkspaceRelativePath:(NSString *)path {
  if (![path isKindOfClass:NSString.class] || path.length == 0 || path.length > 4096 || path.isAbsolutePath) {
    return NO;
  }
  NSString *standardized = path.stringByStandardizingPath;
  if ([standardized isEqualToString:@"."] ||
      [standardized isEqualToString:@".."] ||
      [standardized hasPrefix:@"../"] ||
      [standardized containsString:@"/../"] ||
      [standardized hasPrefix:@"~/"] ||
      [standardized rangeOfString:@"\0"].location != NSNotFound) {
    return NO;
  }
  return YES;
}

- (NSURL *)URLForWorkspaceRelativePath:(NSString *)path error:(NSError **)error {
  if (![self isSafeWorkspaceRelativePath:path]) {
    if (error) *error = [self storageError:@"The workspace path is invalid or attempts to escape the Liteverse data directory." code:501];
    return nil;
  }
  NSURL *root = [self applicationSupportURL].URLByStandardizingPath;
  NSURL *candidate = [root URLByAppendingPathComponent:path].URLByStandardizingPath;
  NSString *rootPath = [root.path stringByAppendingString:@"/"];
  if (![candidate.path hasPrefix:rootPath]) {
    if (error) *error = [self storageError:@"The workspace path escapes the Liteverse data directory." code:502];
    return nil;
  }
  return candidate;
}

- (NSString *)sha256ForFileAtURL:(NSURL *)url error:(NSError **)error {
  NSFileHandle *handle = [NSFileHandle fileHandleForReadingFromURL:url error:error];
  if (!handle) return nil;
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  @try {
    while (YES) {
      __block BOOL reachedEnd = NO;
      @autoreleasepool {
        NSData *chunk = [handle readDataOfLength:1024 * 1024];
        if (chunk.length == 0) {
          reachedEnd = YES;
        } else {
          CC_SHA256_Update(&context, chunk.bytes, (CC_LONG)chunk.length);
        }
      }
      if (reachedEnd) break;
    }
  } @catch (NSException *exception) {
    if (error) *error = [self storageError:
        [NSString stringWithFormat:@"Failed to read %@: %@", url.lastPathComponent, exception.reason ?: @"Unknown error"]
                                      code:503];
    [handle closeFile];
    return nil;
  }
  [handle closeFile];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    [hex appendFormat:@"%02x", digest[index]];
  }
  return hex;
}

- (NSString *)cachedSHA256ForFileAtURL:(NSURL *)url error:(NSError **)error {
  NSDictionary *attributes = [NSFileManager.defaultManager
      attributesOfItemAtPath:url.path error:error];
  if (!attributes) return nil;
  NSNumber *size = attributes[NSFileSize] ?: @0;
  NSNumber *inode = attributes[NSFileSystemFileNumber] ?: @0;
  NSDate *modified = attributes[NSFileModificationDate] ?: NSDate.distantPast;
  NSString *signature = [NSString stringWithFormat:@"%@:%@:%0.6f",
      size, inode, modified.timeIntervalSinceReferenceDate];
  NSDictionary *cached = _sourceHashCache[url.path];
  if ([cached[@"signature"] isEqualToString:signature] &&
      [cached[@"hash"] isKindOfClass:NSString.class]) {
    return cached[@"hash"];
  }
  NSString *hash = [self sha256ForFileAtURL:url error:error];
  if (hash.length == CC_SHA256_DIGEST_LENGTH * 2) {
    if (!_sourceHashCache) _sourceHashCache = [NSMutableDictionary dictionary];
    _sourceHashCache[url.path] = @{ @"signature": signature, @"hash": hash };
  }
  return hash;
}

- (BOOL)seedKnowledgeCardsIfNeeded:(NSError **)error {
  NSURL *destinationDirectory = [self knowledgeCardsDirectoryURL];
  if (![NSFileManager.defaultManager createDirectoryAtURL:destinationDirectory
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:error]) {
    return NO;
  }
  // Avoid touching the application bundle when every card referenced by the
  // current graph is already installed. This matters for development builds
  // kept inside ~/Desktop, where macOS otherwise asks for Desktop-folder
  // access on every newly signed build.
  NSError *graphError = nil;
  NSDictionary *currentGraph = [self readDictionaryAtURL:[self currentGraphURL]
                                              defaultValue:nil
                                                     error:&graphError];
  NSArray *papers = [currentGraph[@"papers"] isKindOfClass:NSArray.class]
      ? currentGraph[@"papers"] : @[];
  // A clean public workspace is intentionally empty. Never copy the private
  // seed card catalog into it merely because the cards directory is empty.
  if (papers.count == 0) return YES;
  BOOL foundCardReference = NO;
  BOOL everyCardPresent = papers.count > 0;
  for (id rawPaper in papers) {
    if (![rawPaper isKindOfClass:NSDictionary.class]) continue;
    NSDictionary *paper = rawPaper;
    NSString *relativePath = [paper[@"markdownPath"] isKindOfClass:NSString.class]
        ? paper[@"markdownPath"] : paper[@"knowledgePath"];
    if (![relativePath isKindOfClass:NSString.class] ||
        ![relativePath hasPrefix:@"Knowledge/cards/"] ||
        [relativePath containsString:@".."] ||
        ![relativePath.pathExtension.lowercaseString isEqualToString:@"md"]) {
      everyCardPresent = NO;
      continue;
    }
    foundCardReference = YES;
    NSURL *installedURL = [[self applicationSupportURL]
        URLByAppendingPathComponent:relativePath];
    if (![NSFileManager.defaultManager fileExistsAtPath:installedURL.path]) {
      everyCardPresent = NO;
    }
  }
  if (foundCardReference && everyCardPresent) return YES;

  // URLForResource does not reliably return copied folder references in an
  // ad-hoc signed bundle, so resolve the packaged directory from resourceURL.
  NSURL *sourceDirectory = [NSBundle.mainBundle.resourceURL
      URLByAppendingPathComponent:@"seed-papers" isDirectory:YES];
  BOOL sourceIsDirectory = NO;
  if (!sourceDirectory ||
      ![NSFileManager.defaultManager fileExistsAtPath:sourceDirectory.path
                                           isDirectory:&sourceIsDirectory] ||
      !sourceIsDirectory) {
    if (error) *error = [self storageError:@"The app bundle is missing seed-papers and cannot initialize knowledge cards." code:400];
    return NO;
  }
  NSArray<NSURL *> *sourceFiles = [NSFileManager.defaultManager
      contentsOfDirectoryAtURL:sourceDirectory
    includingPropertiesForKeys:nil
                       options:NSDirectoryEnumerationSkipsHiddenFiles
                         error:error];
  if (!sourceFiles) return NO;
  for (NSURL *sourceURL in sourceFiles) {
    if (![sourceURL.pathExtension.lowercaseString isEqualToString:@"md"]) continue;
    NSURL *destinationURL = [destinationDirectory URLByAppendingPathComponent:sourceURL.lastPathComponent];
    if ([NSFileManager.defaultManager fileExistsAtPath:destinationURL.path]) continue;
    if (![NSFileManager.defaultManager copyItemAtURL:sourceURL toURL:destinationURL error:error]) return NO;
  }
  return YES;
}

- (NSDictionary *)defaultWorkspaceMetadata {
  return @{
    @"schemaVersion": @1,
    @"workspaceId": [NSString stringWithFormat:@"workspace-%@", NSUUID.UUID.UUIDString.lowercaseString],
    @"name": @"My Liteverse",
    @"createdAt": [self isoTimestamp],
    @"migrationVersion": @3,
    @"onboarding": @{ @"completed": @NO }
  };
}

- (NSDictionary *)emptyUniverseFromPackagedSeed:(NSError **)error {
  NSDictionary *seed = @{};
  NSURL *seedURL = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"seed-universe.json"];
  if ([NSFileManager.defaultManager fileExistsAtPath:seedURL.path]) {
    seed = [self readDictionaryAtURL:seedURL defaultValue:@{} error:error];
    if (!seed) return nil;
  }
  NSDictionary *visuals = [seed[@"visuals"] isKindOfClass:NSDictionary.class]
      ? seed[@"visuals"]
      : @{ @"nebulaAssignmentSeed": @"liteverse-v3", @"nebulaAssets": @[] };
  return @{
    @"schemaVersion": @"3.0.0",
    @"revision": @1,
    @"title": @"Liteverse",
    @"updated": [self isoTimestamp],
    @"usagePolicy": @{
      @"managedBy": @"liteverse-retriever",
      @"manualUpdates": @NO,
      @"initialValue": @0,
      @"counter": @"useCount",
      @"dedupeScope": @"codex-task-paper",
      @"ledger": @"Usage/events.jsonl",
      @"cache": @"Usage/counts.json",
      @"visualNormalization": @{ @"type": @"log1p", @"referenceCount": @32 },
      @"regionAggregation": @"primary-category-mean"
    },
    @"visuals": visuals,
    @"categories": @[@{
      @"id": @"liteverse-staging",
      @"kind": @"system",
      @"name": @"Uncharted Region",
      @"description": @"Temporary space for papers that do not yet belong to a stable macro taxonomy.",
      @"color": @"#8ca8c8",
      @"center": @[@0, @0, @0]
    }],
    @"papers": @[],
    @"relations": @[]
  };
}

- (NSString *)safeFilenameComponentForPaperID:(NSString *)paperID {
  NSString *candidate = [paperID isKindOfClass:NSString.class] ? paperID : @"paper";
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
      @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"];
  NSMutableString *safe = [NSMutableString stringWithCapacity:candidate.length];
  for (NSUInteger index = 0; index < candidate.length; index += 1) {
    unichar character = [candidate characterAtIndex:index];
    [safe appendString:[allowed characterIsMember:character]
        ? [NSString stringWithCharacters:&character length:1] : @"_"];
  }
  return safe.length > 0 ? safe : @"paper";
}

- (NSString *)managedPDFRelativePathForSourceURL:(NSURL *)sourceURL
                                         paperID:(NSString *)paperID
                                          sha256:(NSString **)sha256
                                           error:(NSError **)error {
  if (![NSFileManager.defaultManager fileExistsAtPath:sourceURL.path]) {
    if (error) *error = [self storageError:
        [NSString stringWithFormat:@"The source PDF does not exist: %@", sourceURL.lastPathComponent ?: @"unknown.pdf"]
                                      code:504];
    return nil;
  }
  NSString *sourceHash = [self sha256ForFileAtURL:sourceURL error:error];
  if (sourceHash.length != 64) return nil;
  NSString *safeID = [self safeFilenameComponentForPaperID:paperID];
  NSString *filename = [safeID stringByAppendingPathExtension:@"pdf"];
  NSURL *destinationURL = [[self pdfDirectoryURL] URLByAppendingPathComponent:filename];
  if ([NSFileManager.defaultManager fileExistsAtPath:destinationURL.path]) {
    NSString *destinationHash = [self sha256ForFileAtURL:destinationURL error:error];
    if (!destinationHash) return nil;
    if (![destinationHash isEqualToString:sourceHash]) {
      filename = [NSString stringWithFormat:@"%@-%@.pdf", safeID, [sourceHash substringToIndex:12]];
      destinationURL = [[self pdfDirectoryURL] URLByAppendingPathComponent:filename];
    }
  }
  if (![NSFileManager.defaultManager fileExistsAtPath:destinationURL.path]) {
    NSURL *temporaryURL = [[self pdfDirectoryURL] URLByAppendingPathComponent:
        [NSString stringWithFormat:@".%@.%@.tmp", filename, NSUUID.UUID.UUIDString.lowercaseString]];
    if (![NSFileManager.defaultManager copyItemAtURL:sourceURL toURL:temporaryURL error:error]) return nil;
    NSString *temporaryHash = [self sha256ForFileAtURL:temporaryURL error:error];
    if (![temporaryHash isEqualToString:sourceHash]) {
      [NSFileManager.defaultManager removeItemAtURL:temporaryURL error:nil];
      if (error) *error = [self storageError:@"The managed PDF copy does not match the source SHA-256." code:505];
      return nil;
    }
    if (![NSFileManager.defaultManager moveItemAtURL:temporaryURL toURL:destinationURL error:error]) {
      [NSFileManager.defaultManager removeItemAtURL:temporaryURL error:nil];
      return nil;
    }
  }
  if (sha256) *sha256 = sourceHash;
  return [@"Library/PDFs" stringByAppendingPathComponent:filename];
}

- (BOOL)migrateLegacyGraphSourcesIfSafe:(NSError **)error {
  NSFileManager *manager = NSFileManager.defaultManager;
  NSURL *currentURL = [self currentGraphURL];
  if (![manager fileExistsAtPath:currentURL.path] ||
      [manager fileExistsAtPath:[self pendingRefreshURL].path]) {
    return YES;
  }
  NSDictionary *graph = [self readDictionaryAtURL:currentURL defaultValue:nil error:error];
  if (!graph) return NO;
  NSArray *sourcePapers = [graph[@"papers"] isKindOfClass:NSArray.class] ? graph[@"papers"] : @[];
  NSMutableArray *papers = [NSMutableArray arrayWithCapacity:sourcePapers.count];
  BOOL changed = NO;
  NSMutableArray *unmanagedPaperIDs = [NSMutableArray array];
  BOOL schemaV3 = [[[graph[@"schemaVersion"] description] lowercaseString] hasPrefix:@"3."];

  NSSet *validStatuses = [NSSet setWithArray:@[
    @"imported", @"extracted", @"needs_ocr", @"card_draft",
    @"evidence_verified", @"needs_attention", @"source_missing"
  ]];
  for (id rawPaper in sourcePapers) {
    if (![rawPaper isKindOfClass:NSDictionary.class]) continue;
    NSDictionary *paper = rawPaper;
    NSMutableDictionary *normalized = [paper mutableCopy];
    NSMutableDictionary *source = [paper[@"source"] isKindOfClass:NSDictionary.class]
        ? [paper[@"source"] mutableCopy] : [NSMutableDictionary dictionary];
    NSString *paperID = [paper[@"id"] isKindOfClass:NSString.class] ? paper[@"id"] : @"paper";
    NSString *rawPDFPath = [source[@"pdfPath"] isKindOfClass:NSString.class]
        ? source[@"pdfPath"]
        : ([paper[@"pdfPath"] isKindOfClass:NSString.class] ? paper[@"pdfPath"] : nil);
    NSString *managedPath = nil;
    NSString *pdfHash = [source[@"sha256"] isKindOfClass:NSString.class] ? source[@"sha256"] : nil;
    if ([rawPDFPath isKindOfClass:NSString.class] && rawPDFPath.length > 0) {
      if (!rawPDFPath.isAbsolutePath && [self isSafeWorkspaceRelativePath:rawPDFPath] &&
          [rawPDFPath.stringByStandardizingPath hasPrefix:@"Library/PDFs/"]) {
        managedPath = rawPDFPath.stringByStandardizingPath;
        NSURL *managedURL = [self URLForWorkspaceRelativePath:managedPath error:nil];
        if (pdfHash.length != 64 && [manager fileExistsAtPath:managedURL.path]) {
          pdfHash = [self sha256ForFileAtURL:managedURL error:nil];
        }
      } else if (rawPDFPath.isAbsolutePath && [manager fileExistsAtPath:rawPDFPath]) {
        NSError *copyError = nil;
        managedPath = [self managedPDFRelativePathForSourceURL:[NSURL fileURLWithPath:rawPDFPath]
                                                       paperID:paperID
                                                        sha256:&pdfHash
                                                         error:&copyError];
        if (!managedPath) {
          [unmanagedPaperIDs addObject:paperID];
        }
      } else {
        [unmanagedPaperIDs addObject:paperID];
      }
    }
    if (managedPath.length > 0) {
      source[@"kind"] = source[@"kind"] ?: @"pdf";
      source[@"pdfPath"] = managedPath;
      if (pdfHash.length == 64) source[@"sha256"] = pdfHash;
      normalized[@"pdfPath"] = managedPath; // transitional v2 reader compatibility
    }

    NSMutableDictionary *artifacts = [paper[@"artifacts"] isKindOfClass:NSDictionary.class]
        ? [paper[@"artifacts"] mutableCopy] : [NSMutableDictionary dictionary];
    NSString *cardPath = [artifacts[@"cardPath"] isKindOfClass:NSString.class]
        ? artifacts[@"cardPath"]
        : ([paper[@"markdownPath"] isKindOfClass:NSString.class] ? paper[@"markdownPath"] : nil);
    NSString *fulltextPath = [artifacts[@"fulltextPath"] isKindOfClass:NSString.class]
        ? artifacts[@"fulltextPath"]
        : ([paper[@"fulltextPath"] isKindOfClass:NSString.class] ? paper[@"fulltextPath"] : nil);
    BOOL cardExists = cardPath.length > 0 && [self isSafeWorkspaceRelativePath:cardPath] &&
        [manager fileExistsAtPath:[self URLForWorkspaceRelativePath:cardPath error:nil].path];
    BOOL fulltextExists = fulltextPath.length > 0 && [self isSafeWorkspaceRelativePath:fulltextPath] &&
        [manager fileExistsAtPath:[self URLForWorkspaceRelativePath:fulltextPath error:nil].path];
    if (cardPath.length > 0) artifacts[@"cardPath"] = cardPath;
    if (fulltextPath.length > 0) artifacts[@"fulltextPath"] = fulltextPath;
    artifacts[@"cardSchemaVersion"] = artifacts[@"cardSchemaVersion"] ?: @"liteverse-card-v1";
    artifacts[@"evidenceCount"] = [artifacts[@"evidenceCount"] isKindOfClass:NSNumber.class]
        ? artifacts[@"evidenceCount"] : @0;
    if (![artifacts[@"extractionStatus"] isKindOfClass:NSString.class]) {
      artifacts[@"extractionStatus"] = fulltextExists ? @"extracted" : @"pending";
    }

    BOOL sourceExists = managedPath.length > 0 &&
        [manager fileExistsAtPath:[self URLForWorkspaceRelativePath:managedPath error:nil].path];
    NSString *verificationStatus = [paper[@"verificationStatus"] isKindOfClass:NSString.class]
        ? paper[@"verificationStatus"] : nil;
    if (![validStatuses containsObject:verificationStatus]) {
      verificationStatus = sourceExists
          ? (fulltextExists ? (cardExists ? @"card_draft" : @"extracted") : @"imported")
          : @"source_missing";
    }
    if ([verificationStatus isEqualToString:@"evidence_verified"] &&
        (!cardExists || !fulltextExists || [artifacts[@"evidenceCount"] integerValue] < 1)) {
      verificationStatus = sourceExists ? @"needs_attention" : @"source_missing";
    }
    normalized[@"source"] = source;
    normalized[@"artifacts"] = artifacts;
    normalized[@"verificationStatus"] = verificationStatus;
    if (schemaV3) {
      [normalized removeObjectForKey:@"verified"];
    } else {
      normalized[@"verified"] = @([verificationStatus isEqualToString:@"evidence_verified"]);
    }
    if (![normalized isEqualToDictionary:paper]) changed = YES;
    [papers addObject:normalized];
  }
  if (!changed) return YES;

  NSData *previousData = [NSData dataWithContentsOfURL:currentURL options:0 error:error];
  if (!previousData) return NO;
  NSURL *historyURL = [[self graphHistoryDirectoryURL] URLByAppendingPathComponent:
      [NSString stringWithFormat:@"native-managed-source-migration-%@.json", NSUUID.UUID.UUIDString.lowercaseString]];
  if (![previousData writeToURL:historyURL options:NSDataWritingAtomic error:error]) return NO;
  NSMutableDictionary *migrated = [graph mutableCopy];
  migrated[@"papers"] = papers;
  migrated[@"updated"] = [self isoTimestamp];
  if (![self writeJSONObject:migrated toURL:currentURL error:error]) return NO;
  [self appendJSONObject:@{
    @"eventId": NSUUID.UUID.UUIDString,
    @"action": @"managed_pdf_sources_migrated",
    @"timestamp": [self isoTimestamp],
    @"paperCount": @(papers.count),
    @"unmanagedPaperIds": unmanagedPaperIDs,
    @"historyPath": [@"Graph/history" stringByAppendingPathComponent:historyURL.lastPathComponent]
  } toURL:[self workspaceInboxURL]];
  return YES;
}

// Nebula artwork is an app-owned visual catalog rather than scientific graph
// evidence.  Existing users can therefore receive newly packaged artwork
// without changing the graph revision.  Never rewrite current.json while a
// Refresh is pending: the byte-exact staged snapshot must remain recoverable
// until its hash-checked promotion has completed.
- (BOOL)synchronizePackagedNebulaAssetCatalogIfSafe:(NSError **)error {
  NSFileManager *manager = NSFileManager.defaultManager;
  NSURL *lockURL = [self stageRefreshLockURL];
  // Curator, Refresh, import, and backup share this lock. If another operation
  // already owns it, visual-catalog maintenance is intentionally deferred.
  if ([manager fileExistsAtPath:lockURL.path]) return YES;
  NSURL *currentPreflightURL = [self currentGraphURL];
  if (![manager fileExistsAtPath:currentPreflightURL.path] ||
      [manager fileExistsAtPath:[self pendingRefreshURL].path]) {
    return YES;
  }
  NSURL *seedPreflightURL = [NSBundle.mainBundle.resourceURL
      URLByAppendingPathComponent:@"seed-universe.json"];
  if (![manager fileExistsAtPath:seedPreflightURL.path]) {
    if (error) *error = [self storageError:@"The app bundle is missing seed-universe.json and cannot synchronize the nebula catalog." code:417];
    return NO;
  }
  NSDictionary *currentPreflight = [self readDictionaryAtURL:currentPreflightURL
                                                 defaultValue:nil
                                                        error:error];
  NSDictionary *seedPreflight = [self readDictionaryAtURL:seedPreflightURL
                                              defaultValue:nil
                                                     error:error];
  if (!currentPreflight || !seedPreflight) return NO;
  NSDictionary *currentPreflightVisuals =
      [currentPreflight[@"visuals"] isKindOfClass:NSDictionary.class]
          ? currentPreflight[@"visuals"] : @{};
  NSDictionary *seedPreflightVisuals =
      [seedPreflight[@"visuals"] isKindOfClass:NSDictionary.class]
          ? seedPreflight[@"visuals"] : @{};
  NSArray *currentPreflightAssets =
      [currentPreflightVisuals[@"nebulaAssets"] isKindOfClass:NSArray.class]
          ? currentPreflightVisuals[@"nebulaAssets"] : @[];
  NSArray *seedPreflightAssets =
      [seedPreflightVisuals[@"nebulaAssets"] isKindOfClass:NSArray.class]
          ? seedPreflightVisuals[@"nebulaAssets"] : @[];
  NSMutableSet<NSString *> *currentPreflightAssetIDs = [NSMutableSet set];
  for (id rawAsset in currentPreflightAssets) {
    if (![rawAsset isKindOfClass:NSDictionary.class]) continue;
    NSString *assetID = [rawAsset[@"id"] isKindOfClass:NSString.class]
        ? rawAsset[@"id"] : nil;
    if (assetID.length > 0) [currentPreflightAssetIDs addObject:assetID];
  }
  BOOL missingPackagedAsset = NO;
  for (id rawAsset in seedPreflightAssets) {
    if (![rawAsset isKindOfClass:NSDictionary.class]) continue;
    NSString *assetID = [rawAsset[@"id"] isKindOfClass:NSString.class]
        ? rawAsset[@"id"] : nil;
    NSString *source = [rawAsset[@"src"] isKindOfClass:NSString.class]
        ? rawAsset[@"src"] : nil;
    if (assetID.length > 0 && source.length > 0 &&
        ![currentPreflightAssetIDs containsObject:assetID]) {
      missingPackagedAsset = YES;
      break;
    }
  }
  id seedCatalogVersion = seedPreflightVisuals[@"nebulaAssetCatalogVersion"] ?: @1;
  BOOL catalogVersionChanged =
      ![currentPreflightVisuals[@"nebulaAssetCatalogVersion"] isEqual:seedCatalogVersion];
  // The common steady-state path is deliberately read-only. Acquiring and
  // removing the curator lock for an unchanged catalog can wake the workspace
  // vnode observer and must never be part of a health-read loop.
  if (!missingPackagedAsset && !catalogVersionChanged) return YES;

  if (![manager createDirectoryAtURL:[lockURL URLByDeletingLastPathComponent]
          withIntermediateDirectories:YES
                           attributes:nil
                                error:error]) {
    return NO;
  }
  NSError *lockError = nil;
  if (![manager createDirectoryAtURL:lockURL
          withIntermediateDirectories:NO
                           attributes:nil
                                error:&lockError]) {
    // Curator owns the same atomic directory lock.  Deferring is preferable to
    // blocking the UI or touching current.json during snapshot construction.
    if ([manager fileExistsAtPath:lockURL.path]) return YES;
    if (error) *error = lockError;
    return NO;
  }

  @try {
  NSURL *currentURL = [self currentGraphURL];
  if (![manager fileExistsAtPath:currentURL.path] ||
      [manager fileExistsAtPath:[self pendingRefreshURL].path]) {
    return YES;
  }

  NSURL *seedURL = [NSBundle.mainBundle.resourceURL
      URLByAppendingPathComponent:@"seed-universe.json"];
  if (![manager fileExistsAtPath:seedURL.path]) {
    if (error) *error = [self storageError:@"The app bundle is missing seed-universe.json and cannot synchronize the nebula catalog." code:417];
    return NO;
  }

  NSDictionary *current = [self readDictionaryAtURL:currentURL
                                        defaultValue:nil
                                               error:error];
  if (!current) return NO;
  NSDictionary *seed = [self readDictionaryAtURL:seedURL
                                     defaultValue:nil
                                            error:error];
  if (!seed) return NO;
  NSDictionary *seedVisuals = [seed[@"visuals"] isKindOfClass:NSDictionary.class]
      ? seed[@"visuals"] : @{};
  NSArray *packagedAssets = [seedVisuals[@"nebulaAssets"] isKindOfClass:NSArray.class]
      ? seedVisuals[@"nebulaAssets"] : @[];
  if (packagedAssets.count == 0) return YES;

  NSDictionary *currentVisuals = [current[@"visuals"] isKindOfClass:NSDictionary.class]
      ? current[@"visuals"] : @{};
  NSArray *currentAssets = [currentVisuals[@"nebulaAssets"] isKindOfClass:NSArray.class]
      ? currentVisuals[@"nebulaAssets"] : @[];
  NSMutableArray *mergedAssets = [currentAssets mutableCopy];
  NSMutableSet<NSString *> *knownAssetIDs = [NSMutableSet set];
  for (id rawAsset in currentAssets) {
    if (![rawAsset isKindOfClass:NSDictionary.class]) continue;
    NSString *assetID = [rawAsset[@"id"] isKindOfClass:NSString.class] ? rawAsset[@"id"] : nil;
    if (assetID.length > 0) [knownAssetIDs addObject:assetID];
  }

  NSMutableArray<NSString *> *addedAssetIDs = [NSMutableArray array];
  for (id rawAsset in packagedAssets) {
    if (![rawAsset isKindOfClass:NSDictionary.class]) continue;
    NSString *assetID = [rawAsset[@"id"] isKindOfClass:NSString.class] ? rawAsset[@"id"] : nil;
    NSString *source = [rawAsset[@"src"] isKindOfClass:NSString.class] ? rawAsset[@"src"] : nil;
    if (assetID.length == 0 || source.length == 0 || [knownAssetIDs containsObject:assetID]) continue;
    [mergedAssets addObject:rawAsset];
    [knownAssetIDs addObject:assetID];
    [addedAssetIDs addObject:assetID];
  }

  id packagedCatalogVersion = seedVisuals[@"nebulaAssetCatalogVersion"] ?: @1;
  BOOL versionChanged = ![currentVisuals[@"nebulaAssetCatalogVersion"]
      isEqual:packagedCatalogVersion];
  if (addedAssetIDs.count == 0 && !versionChanged) return YES;

  NSMutableDictionary *mergedVisuals = [currentVisuals mutableCopy];
  mergedVisuals[@"nebulaAssets"] = mergedAssets;
  mergedVisuals[@"nebulaAssetCatalogVersion"] = packagedCatalogVersion;
  if (!mergedVisuals[@"nebulaAssignmentSeed"] && seedVisuals[@"nebulaAssignmentSeed"]) {
    mergedVisuals[@"nebulaAssignmentSeed"] = seedVisuals[@"nebulaAssignmentSeed"];
  }
  NSMutableDictionary *mergedGraph = [current mutableCopy];
  mergedGraph[@"visuals"] = mergedVisuals;

  // Re-check immediately before the atomic write in case Curator staged a
  // Refresh while the two catalogs were being read.
  if ([manager fileExistsAtPath:[self pendingRefreshURL].path]) return YES;
  if (![self writeJSONObject:mergedGraph toURL:currentURL error:error]) return NO;
  [self appendJSONObject:@{
    @"eventId": NSUUID.UUID.UUIDString,
    @"action": @"nebula_asset_catalog_migrated",
    @"timestamp": [self isoTimestamp],
    @"revision": current[@"revision"] ?: @0,
    @"catalogVersion": packagedCatalogVersion,
    @"addedAssetIds": addedAssetIDs
  } toURL:[self workspaceInboxURL]];
  return YES;
  } @finally {
    [manager removeItemAtURL:lockURL error:nil];
  }
}

- (BOOL)ensureRuntimeGraphStorage:(NSError **)error {
  NSArray<NSURL *> *directories = @[
    [self graphDirectoryURL],
    [self stagedGraphDirectoryURL],
    [self graphHistoryDirectoryURL],
    [self usageDirectoryURL],
    [self pdfDirectoryURL],
    [self knowledgeCardsDirectoryURL],
    [[self applicationSupportURL] URLByAppendingPathComponent:@"Knowledge/fulltext" isDirectory:YES],
    [[self applicationSupportURL] URLByAppendingPathComponent:@"Knowledge/artifacts" isDirectory:YES],
    [[self applicationSupportURL] URLByAppendingPathComponent:@"Knowledge/claims" isDirectory:YES],
    [self projectsDirectoryURL],
    [self workspaceRecoveryDirectoryURL]
  ];
  for (NSURL *directory in directories) {
    if (![NSFileManager.defaultManager createDirectoryAtURL:directory
                                withIntermediateDirectories:YES
                                                 attributes:nil
                                                      error:error]) {
      return NO;
    }
  }

  NSURL *currentURL = [self currentGraphURL];
  if (![NSFileManager.defaultManager fileExistsAtPath:currentURL.path]) {
    NSDictionary *initialGraph = [self emptyUniverseFromPackagedSeed:error];
    if (!initialGraph) return NO;
    if (![self writeJSONObject:initialGraph toURL:currentURL error:error]) return NO;
  }

  if (![NSFileManager.defaultManager fileExistsAtPath:[self workspaceMetadataURL].path] &&
      ![self writeJSONObject:[self defaultWorkspaceMetadata]
                       toURL:[self workspaceMetadataURL]
                       error:error]) {
    return NO;
  }

  if (![self ensureProjectStorage:error]) return NO;

  if (![self synchronizePackagedNebulaAssetCatalogIfSafe:error]) return NO;
  if (![self migrateLegacyGraphSourcesIfSafe:error]) return NO;

  NSURL *countsURL = [self usageCountsURL];
  if (![NSFileManager.defaultManager fileExistsAtPath:countsURL.path] &&
      ![self writeJSONObject:@{ @"schemaVersion": @1, @"counts": @{} }
                       toURL:countsURL
                       error:error]) {
    return NO;
  }
  return [self seedKnowledgeCardsIfNeeded:error];
}

- (NSString *)sha256ForData:(NSData *)data {
  if (!data) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    [hex appendFormat:@"%02x", digest[index]];
  }
  return hex;
}

- (BOOL)isSafeRefreshID:(NSString *)refreshID {
  if (![refreshID isKindOfClass:NSString.class] || refreshID.length == 0 || refreshID.length > 160) return NO;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
      @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"];
  return [refreshID rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound &&
      ![refreshID isEqualToString:@"."] && ![refreshID isEqualToString:@".."];
}

- (BOOL)revision:(id)left matches:(id)right {
  if (!left || left == NSNull.null || !right || right == NSNull.null) return NO;
  if ([left isEqual:right]) return YES;
  return [[left description] isEqualToString:[right description]];
}

- (NSNumber *)useCountFromValue:(id)value {
  id candidate = value;
  if ([value isKindOfClass:NSDictionary.class]) {
    candidate = value[@"useCount"] ?: value[@"count"];
  }
  if (![candidate isKindOfClass:NSNumber.class]) return @0;
  long long count = MAX(0, [candidate longLongValue]);
  return @(count);
}

- (NSDictionary *)graphByNormalizingWorkspaceContract:(NSDictionary *)graph {
  if (![graph isKindOfClass:NSDictionary.class]) return @{};
  NSFileManager *manager = NSFileManager.defaultManager;
  NSMutableDictionary *runtimeGraph = [graph mutableCopy];
  runtimeGraph[@"schemaVersion"] = graph[@"schemaVersion"] ?: @"3.0.0";

  NSArray *sourceCategories = [graph[@"categories"] isKindOfClass:NSArray.class]
      ? graph[@"categories"] : @[];
  NSMutableArray *categories = [NSMutableArray arrayWithCapacity:sourceCategories.count];
  for (id rawCategory in sourceCategories) {
    if (![rawCategory isKindOfClass:NSDictionary.class]) continue;
    NSMutableDictionary *category = [rawCategory mutableCopy];
    NSString *kind = [category[@"kind"] isKindOfClass:NSString.class] ? category[@"kind"] : @"macro";
    category[@"kind"] = [kind isEqualToString:@"system"] ? @"system" : @"macro";
    [categories addObject:category];
  }

  NSSet *validStatuses = [NSSet setWithArray:@[
    @"imported", @"extracted", @"needs_ocr", @"card_draft",
    @"evidence_verified", @"needs_attention", @"source_missing"
  ]];
  BOOL schemaV3 = [[[graph[@"schemaVersion"] description] lowercaseString] hasPrefix:@"3."];
  NSArray *sourcePapers = [graph[@"papers"] isKindOfClass:NSArray.class] ? graph[@"papers"] : @[];
  NSMutableArray *papers = [NSMutableArray arrayWithCapacity:sourcePapers.count];
  for (id rawPaper in sourcePapers) {
    if (![rawPaper isKindOfClass:NSDictionary.class]) continue;
    NSDictionary *sourcePaper = rawPaper;
    NSMutableDictionary *paper = [sourcePaper mutableCopy];
    NSMutableDictionary *source = [sourcePaper[@"source"] isKindOfClass:NSDictionary.class]
        ? [sourcePaper[@"source"] mutableCopy] : [NSMutableDictionary dictionary];
    NSString *pdfPath = [source[@"pdfPath"] isKindOfClass:NSString.class]
        ? source[@"pdfPath"]
        : ([sourcePaper[@"pdfPath"] isKindOfClass:NSString.class] ? sourcePaper[@"pdfPath"] : nil);
    BOOL safePDF = pdfPath.length > 0 && !pdfPath.isAbsolutePath &&
        [self isSafeWorkspaceRelativePath:pdfPath] &&
        [pdfPath.stringByStandardizingPath hasPrefix:@"Library/PDFs/"];
    NSURL *pdfURL = safePDF ? [self URLForWorkspaceRelativePath:pdfPath error:nil] : nil;
    BOOL pdfExists = pdfURL && [manager fileExistsAtPath:pdfURL.path];
    if (safePDF) {
      pdfPath = pdfPath.stringByStandardizingPath;
      source[@"pdfPath"] = pdfPath;
      paper[@"pdfPath"] = pdfPath;
    } else {
      [source removeObjectForKey:@"pdfPath"];
      paper[@"pdfPath"] = @"";
    }
    source[@"kind"] = [source[@"kind"] isKindOfClass:NSString.class]
        ? source[@"kind"] : (source[@"arxivId"] ? @"arxiv" : @"pdf");

    NSMutableDictionary *artifacts = [sourcePaper[@"artifacts"] isKindOfClass:NSDictionary.class]
        ? [sourcePaper[@"artifacts"] mutableCopy] : [NSMutableDictionary dictionary];
    NSString *cardPath = [artifacts[@"cardPath"] isKindOfClass:NSString.class]
        ? artifacts[@"cardPath"]
        : ([sourcePaper[@"markdownPath"] isKindOfClass:NSString.class] ? sourcePaper[@"markdownPath"] : nil);
    NSString *fulltextPath = [artifacts[@"fulltextPath"] isKindOfClass:NSString.class]
        ? artifacts[@"fulltextPath"]
        : ([sourcePaper[@"fulltextPath"] isKindOfClass:NSString.class] ? sourcePaper[@"fulltextPath"] : nil);
    BOOL safeCard = cardPath.length > 0 && [self isSafeWorkspaceRelativePath:cardPath] &&
        [cardPath.stringByStandardizingPath hasPrefix:@"Knowledge/cards/"];
    BOOL safeFulltext = fulltextPath.length > 0 && [self isSafeWorkspaceRelativePath:fulltextPath] &&
        [fulltextPath.stringByStandardizingPath hasPrefix:@"Knowledge/fulltext/"];
    BOOL cardExists = safeCard && [manager fileExistsAtPath:
        [self URLForWorkspaceRelativePath:cardPath error:nil].path];
    BOOL fulltextExists = safeFulltext && [manager fileExistsAtPath:
        [self URLForWorkspaceRelativePath:fulltextPath error:nil].path];
    if (safeCard) {
      cardPath = cardPath.stringByStandardizingPath;
      artifacts[@"cardPath"] = cardPath;
      paper[@"markdownPath"] = cardPath;
    } else {
      [artifacts removeObjectForKey:@"cardPath"];
      paper[@"markdownPath"] = @"";
    }
    if (safeFulltext) {
      fulltextPath = fulltextPath.stringByStandardizingPath;
      artifacts[@"fulltextPath"] = fulltextPath;
      paper[@"fulltextPath"] = fulltextPath;
    } else {
      [artifacts removeObjectForKey:@"fulltextPath"];
      [paper removeObjectForKey:@"fulltextPath"];
    }
    artifacts[@"cardSchemaVersion"] = artifacts[@"cardSchemaVersion"] ?: @"liteverse-card-v1";
    artifacts[@"evidenceCount"] = [artifacts[@"evidenceCount"] isKindOfClass:NSNumber.class]
        ? artifacts[@"evidenceCount"] : @0;
    artifacts[@"extractionStatus"] = [artifacts[@"extractionStatus"] isKindOfClass:NSString.class]
        ? artifacts[@"extractionStatus"]
        : (fulltextExists ? @"extracted" : @"pending");

    NSString *status = [sourcePaper[@"verificationStatus"] isKindOfClass:NSString.class]
        ? sourcePaper[@"verificationStatus"] : nil;
    if (![validStatuses containsObject:status]) {
      status = pdfExists
          ? (fulltextExists ? (cardExists ? @"card_draft" : @"extracted") : @"imported")
          : @"source_missing";
    }
    if ([status isEqualToString:@"evidence_verified"] &&
        (!cardExists || !fulltextExists || [artifacts[@"evidenceCount"] integerValue] < 1)) {
      status = pdfExists ? @"needs_attention" : @"source_missing";
    }
    if (!pdfExists && ![source[@"kind"] isEqualToString:@"arxiv"]) status = @"source_missing";
    paper[@"source"] = source;
    paper[@"artifacts"] = artifacts;
    paper[@"verificationStatus"] = status;
    if (schemaV3) {
      [paper removeObjectForKey:@"verified"];
    } else {
      paper[@"verified"] = @([status isEqualToString:@"evidence_verified"]);
    }
    [papers addObject:paper];
  }
  runtimeGraph[@"categories"] = categories;
  runtimeGraph[@"papers"] = papers;
  runtimeGraph[@"relations"] = [graph[@"relations"] isKindOfClass:NSArray.class]
      ? graph[@"relations"] : @[];
  return runtimeGraph;
}

- (NSDictionary *)graphByInjectingUsageCounts:(NSDictionary *)graph {
  graph = [self graphByNormalizingWorkspaceContract:graph];
  NSError *error = nil;
  NSDictionary *countsDocument = [self readDictionaryAtURL:[self usageCountsURL]
                                               defaultValue:@{ @"counts": @{} }
                                                      error:&error];
  id rawCounts = countsDocument[@"counts"] ?: countsDocument[@"paperCounts"] ?: countsDocument[@"papers"];
  NSDictionary *counts = [rawCounts isKindOfClass:NSDictionary.class] ? rawCounts : countsDocument;
  NSArray *sourcePapers = [graph[@"papers"] isKindOfClass:NSArray.class] ? graph[@"papers"] : @[];
  NSMutableArray *papers = [NSMutableArray arrayWithCapacity:sourcePapers.count];
  for (id rawPaper in sourcePapers) {
    if (![rawPaper isKindOfClass:NSDictionary.class]) continue;
    NSMutableDictionary *paper = [rawPaper mutableCopy];
    NSString *paperID = [paper[@"id"] isKindOfClass:NSString.class] ? paper[@"id"] : @"";
    paper[@"useCount"] = [self useCountFromValue:counts[paperID]];
    [papers addObject:paper];
  }
  NSMutableDictionary *runtimeGraph = [graph mutableCopy];
  runtimeGraph[@"papers"] = papers;
  return runtimeGraph;
}

- (NSDictionary *)defaultLibrary {
  return @{ @"schemaVersion": @1, @"nextNumber": @1, @"items": @[] };
}

- (NSDictionary *)defaultResearchInformation {
  return @{
    @"schemaVersion": @1,
    @"status": @"empty",
    @"draft": @{ @"text": @"", @"revision": @0, @"updatedAt": @"" },
    @"formal": @{ @"text": @"", @"sourceRevision": @0, @"organizedAt": @"" }
  };
}

- (NSDictionary *)defaultProjectsRegistry {
  NSString *timestamp = [self isoTimestamp];
  return @{
    @"schemaVersion": @1,
    @"activeProjectId": @"project-default",
    @"generatedAt": timestamp,
    @"items": @[@{
      @"schemaVersion": @1,
      @"projectId": @"project-default",
      @"name": @"Default project",
      @"description": @"Migrated Liteverse research workspace",
      @"createdAt": timestamp,
      @"updatedAt": timestamp,
      @"revision": @0,
      @"ledgerHash": @""
    }]
  };
}

- (BOOL)ensureProjectStorage:(NSError **)error {
  NSFileManager *manager = NSFileManager.defaultManager;
  if (![manager createDirectoryAtURL:[self projectsDirectoryURL]
          withIntermediateDirectories:YES attributes:nil error:error]) return NO;
  NSURL *registryURL = [self projectsRegistryURL];
  if (![manager fileExistsAtPath:registryURL.path] &&
      ![self writeJSONObject:[self defaultProjectsRegistry] toURL:registryURL error:error]) return NO;

  NSDictionary *registry = [self readDictionaryAtURL:registryURL defaultValue:nil error:error];
  if (!registry) return NO;
  NSString *activeProjectID = [registry[@"activeProjectId"] isKindOfClass:NSString.class]
      ? registry[@"activeProjectId"] : @"project-default";
  if (![self isSafeProjectID:activeProjectID]) {
    if (error) *error = [self storageError:@"Projects/projects.json has an invalid activeProjectId; the original file was preserved." code:531];
    return NO;
  }
  NSArray *items = [registry[@"items"] isKindOfClass:NSArray.class] ? registry[@"items"] : nil;
  if (!items) {
    if (error) *error = [self storageError:@"Projects/projects.json is missing its project list; the original file was preserved." code:532];
    return NO;
  }
  BOOL activeFound = NO;
  for (id rawItem in items) {
    if (![rawItem isKindOfClass:NSDictionary.class]) continue;
    NSString *itemID = [rawItem[@"projectId"] isKindOfClass:NSString.class]
        ? rawItem[@"projectId"] : rawItem[@"id"];
    if (![self isSafeProjectID:itemID]) {
      if (error) *error = [self storageError:@"Projects/projects.json contains an invalid project ID; the original file was preserved." code:533];
      return NO;
    }
    NSURL *projectDirectory = [self projectDirectoryURLForID:itemID error:error];
    if (![manager createDirectoryAtURL:projectDirectory withIntermediateDirectories:YES attributes:nil error:error] ||
        ![manager createDirectoryAtURL:[projectDirectory URLByAppendingPathComponent:@"memory" isDirectory:YES]
            withIntermediateDirectories:YES attributes:nil error:error] ||
        ![manager createDirectoryAtURL:[projectDirectory URLByAppendingPathComponent:@"Tasks" isDirectory:YES]
            withIntermediateDirectories:YES attributes:nil error:error]) return NO;
    NSURL *projectURL = [projectDirectory URLByAppendingPathComponent:@"project.json"];
    if ([manager fileExistsAtPath:projectURL.path]) {
      NSDictionary *projectDocument = [self readDictionaryAtURL:projectURL defaultValue:nil error:error];
      if (!projectDocument || ![projectDocument[@"projectId"] isEqualToString:itemID]) {
        if (error && !*error) *error = [self storageError:@"project.json does not match the project registry; the original file was preserved." code:547];
        return NO;
      }
    } else if (![itemID isEqualToString:@"project-default"]) {
      NSMutableDictionary *projectDocument = [rawItem mutableCopy];
      projectDocument[@"schemaVersion"] = projectDocument[@"schemaVersion"] ?: @1;
      projectDocument[@"projectId"] = itemID;
      projectDocument[@"name"] = projectDocument[@"name"] ?: itemID;
      projectDocument[@"revision"] = projectDocument[@"revision"] ?: @0;
      projectDocument[@"ledgerHash"] = projectDocument[@"ledgerHash"] ?: @"";
      if (![self writeJSONObject:projectDocument toURL:projectURL error:error]) return NO;
    }
    if ([itemID isEqualToString:activeProjectID]) activeFound = YES;
  }
  if (!activeFound) {
    if (error) *error = [self storageError:@"activeProjectId is not present in the project list; the original file was preserved." code:534];
    return NO;
  }
  NSDictionary *activeProjection = @{ @"schemaVersion": @1, @"projectId": activeProjectID };
  NSURL *activeURL = [self activeProjectURL];
  if ([manager fileExistsAtPath:activeURL.path]) {
    NSDictionary *storedActive = [self readDictionaryAtURL:activeURL defaultValue:nil error:error];
    if (!storedActive) return NO;
    if (![storedActive isEqualToDictionary:activeProjection] &&
        ![self writeJSONObject:activeProjection toURL:activeURL error:error]) return NO;
  } else if (![self writeJSONObject:activeProjection toURL:activeURL error:error]) {
    return NO;
  }

  // Preserve the original free-form research text as the default project's
  // editable source until Research Memory materializes its structured ledger.
  NSURL *defaultResearchURL = [self projectResearchInformationURLForID:@"project-default" error:error];
  if (![manager fileExistsAtPath:defaultResearchURL.path] &&
      [manager fileExistsAtPath:[self researchInformationURL].path] &&
      ![manager copyItemAtURL:[self researchInformationURL] toURL:defaultResearchURL error:error]) return NO;
  return YES;
}

- (NSString *)activeProjectIDFromRegistry:(NSDictionary *)registry {
  NSString *projectID = [registry[@"activeProjectId"] isKindOfClass:NSString.class]
      ? registry[@"activeProjectId"] : @"project-default";
  return [self isSafeProjectID:projectID] ? projectID : nil;
}

- (NSDictionary *)projectsPayloadFromRegistry:(NSDictionary *)registry {
  NSMutableArray *items = [NSMutableArray array];
  for (NSDictionary *item in [registry[@"items"] isKindOfClass:NSArray.class] ? registry[@"items"] : @[]) {
    NSString *projectID = [item[@"projectId"] isKindOfClass:NSString.class]
        ? item[@"projectId"] : item[@"id"];
    if (![self isSafeProjectID:projectID]) continue;
    NSMutableDictionary *payloadItem = [item mutableCopy];
    payloadItem[@"id"] = projectID;
    payloadItem[@"name"] = [item[@"name"] isKindOfClass:NSString.class] ? item[@"name"] : projectID;
    [items addObject:payloadItem];
  }
  return @{
    @"schemaVersion": registry[@"schemaVersion"] ?: @1,
    @"activeProjectId": [self activeProjectIDFromRegistry:registry] ?: @"project-default",
    @"items": items
  };
}

- (NSDictionary *)workspaceHealthWithLibrary:(NSDictionary *)library error:(NSError **)error {
  NSDictionary *graph = [self readDictionaryAtURL:[self currentGraphURL] defaultValue:nil error:error];
  if (!graph) return nil;
  NSDictionary *runtimeGraph = [self graphByNormalizingWorkspaceContract:graph];
  NSArray *papers = [runtimeGraph[@"papers"] isKindOfClass:NSArray.class] ? runtimeGraph[@"papers"] : @[];
  NSArray *categories = [runtimeGraph[@"categories"] isKindOfClass:NSArray.class] ? runtimeGraph[@"categories"] : @[];
  NSArray *relations = [runtimeGraph[@"relations"] isKindOfClass:NSArray.class] ? runtimeGraph[@"relations"] : @[];
  NSMutableArray *missingSourcePaperIDs = [NSMutableArray array];
  NSMutableArray *missingSourceHashPaperIDs = [NSMutableArray array];
  NSMutableArray *hashMismatchPaperIDs = [NSMutableArray array];
  NSMutableArray *missingCardPaperIDs = [NSMutableArray array];
  NSMutableArray *missingFulltextPaperIDs = [NSMutableArray array];
  NSMutableArray *attentionPaperIDs = [NSMutableArray array];
  NSUInteger verifiedCount = 0;
  NSUInteger stagingPaperCount = 0;
  for (NSDictionary *paper in papers) {
    NSString *paperID = [paper[@"id"] isKindOfClass:NSString.class] ? paper[@"id"] : @"unknown";
    NSString *status = [paper[@"verificationStatus"] isKindOfClass:NSString.class]
        ? paper[@"verificationStatus"] : @"needs_attention";
    NSDictionary *source = [paper[@"source"] isKindOfClass:NSDictionary.class] ? paper[@"source"] : @{};
    NSDictionary *artifacts = [paper[@"artifacts"] isKindOfClass:NSDictionary.class] ? paper[@"artifacts"] : @{};
    NSString *pdfPath = [source[@"pdfPath"] isKindOfClass:NSString.class] ? source[@"pdfPath"] : nil;
    NSString *expectedHash = [source[@"sha256"] isKindOfClass:NSString.class]
        ? [source[@"sha256"] lowercaseString] : nil;
    NSString *cardPath = [artifacts[@"cardPath"] isKindOfClass:NSString.class] ? artifacts[@"cardPath"] : nil;
    NSString *fulltextPath = [artifacts[@"fulltextPath"] isKindOfClass:NSString.class] ? artifacts[@"fulltextPath"] : nil;
    BOOL pdfExists = pdfPath.length > 0 &&
        [NSFileManager.defaultManager fileExistsAtPath:[self URLForWorkspaceRelativePath:pdfPath error:nil].path];
    BOOL cardExists = cardPath.length > 0 &&
        [NSFileManager.defaultManager fileExistsAtPath:[self URLForWorkspaceRelativePath:cardPath error:nil].path];
    BOOL fulltextExists = fulltextPath.length > 0 &&
        [NSFileManager.defaultManager fileExistsAtPath:[self URLForWorkspaceRelativePath:fulltextPath error:nil].path];
    NSString *actualHash = pdfExists
        ? [self cachedSHA256ForFileAtURL:[self URLForWorkspaceRelativePath:pdfPath error:nil] error:nil]
        : nil;
    BOOL sourceHashRecorded = expectedHash.length == CC_SHA256_DIGEST_LENGTH * 2;
    BOOL sourceHashReadable = actualHash.length == CC_SHA256_DIGEST_LENGTH * 2;
    BOOL sourceHashMatches = sourceHashRecorded && sourceHashReadable &&
        [actualHash caseInsensitiveCompare:expectedHash] == NSOrderedSame;
    if (!pdfExists) [missingSourcePaperIDs addObject:paperID];
    if (pdfExists && !sourceHashRecorded) [missingSourceHashPaperIDs addObject:paperID];
    if (pdfExists && sourceHashRecorded && !sourceHashMatches) [hashMismatchPaperIDs addObject:paperID];
    if (!cardExists) [missingCardPaperIDs addObject:paperID];
    if (!fulltextExists) [missingFulltextPaperIDs addObject:paperID];
    BOOL hasIntegrityIssue = !pdfExists || !sourceHashMatches || !cardExists || !fulltextExists;
    if (hasIntegrityIssue || [status isEqualToString:@"needs_attention"] ||
        [status isEqualToString:@"needs_ocr"] || [status isEqualToString:@"source_missing"]) {
      [attentionPaperIDs addObject:paperID];
    }
    NSInteger evidenceCount = [artifacts[@"evidenceCount"] isKindOfClass:NSNumber.class]
        ? [artifacts[@"evidenceCount"] integerValue] : 0;
    if ([status isEqualToString:@"evidence_verified"] && !hasIntegrityIssue && evidenceCount > 0) {
      verifiedCount += 1;
    }
    if ([paper[@"primaryCategory"] isEqualToString:@"liteverse-staging"]) stagingPaperCount += 1;
  }
  NSUInteger macroCategoryCount = 0;
  for (NSDictionary *category in categories) {
    if (![category[@"kind"] isEqualToString:@"system"]) macroCategoryCount += 1;
  }
  NSUInteger pendingScoringCount = 0;
  for (NSDictionary *relation in relations) {
    if ([relation[@"status"] isEqualToString:@"pending_scoring"] ||
        [relation[@"scoringStatus"] isEqualToString:@"legacy_unscored"] ||
        ![relation[@"strength"] isKindOfClass:NSNumber.class] ||
        ![relation[@"confidence"] isKindOfClass:NSNumber.class]) {
      pendingScoringCount += 1;
    }
  }
  NSArray *items = [library[@"items"] isKindOfClass:NSArray.class] ? library[@"items"] : @[];
  NSMutableDictionary<NSString *, NSNumber *> *libraryStatusCounts = [NSMutableDictionary dictionary];
  for (NSDictionary *item in items) {
    NSString *status = [item[@"status"] isKindOfClass:NSString.class] ? item[@"status"] : @"unknown";
    libraryStatusCounts[status] = @([libraryStatusCounts[status] unsignedIntegerValue] + 1);
  }
  return @{
    @"schemaVersion": @1,
    @"checkedAt": [self isoTimestamp],
    @"graphSchemaVersion": runtimeGraph[@"schemaVersion"] ?: @"unknown",
    @"revision": runtimeGraph[@"revision"] ?: @0,
    @"paperCount": @(papers.count),
    @"relationCount": @(relations.count),
    @"macroCategoryCount": @(macroCategoryCount),
    @"systemCategoryCount": @(categories.count - macroCategoryCount),
    @"stagingPaperCount": @(stagingPaperCount),
    @"verifiedPaperCount": @(verifiedCount),
    @"pendingScoringRelationCount": @(pendingScoringCount),
    @"missingSourcePaperIds": missingSourcePaperIDs,
    @"missingSourceHashPaperIds": missingSourceHashPaperIDs,
    @"hashMismatchPaperIds": hashMismatchPaperIDs,
    @"missingCardPaperIds": missingCardPaperIDs,
    @"missingFulltextPaperIds": missingFulltextPaperIDs,
    @"attentionPaperIds": attentionPaperIDs,
    @"libraryStatusCounts": libraryStatusCounts,
    @"hasPendingRefresh": @([NSFileManager.defaultManager fileExistsAtPath:[self pendingRefreshURL].path]),
    @"managedVaultPath": @"Library/PDFs"
  };
}

- (NSDictionary *)readDictionaryAtURL:(NSURL *)url
                         defaultValue:(NSDictionary *)defaultValue
                                error:(NSError **)error {
  if (![[NSFileManager defaultManager] fileExistsAtPath:url.path]) return defaultValue;
  NSData *data = [NSData dataWithContentsOfURL:url options:0 error:error];
  if (!data) return nil;
  id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
  if (![object isKindOfClass:NSDictionary.class]) {
    if (error) *error = [self storageError:[NSString stringWithFormat:@"%@ has an invalid data format; the original file was preserved.", url.lastPathComponent] code:101];
    return nil;
  }
  return object;
}

- (BOOL)writeJSONObject:(id)object toURL:(NSURL *)url error:(NSError **)error {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                  options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys
                                                    error:error];
  if (!data) return NO;
  return [data writeToURL:url options:NSDataWritingAtomic error:error];
}

- (void)appendJSONObject:(NSDictionary *)object toURL:(NSURL *)url {
  NSError *error = nil;
  NSData *eventData = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
  if (!eventData || error) return;
  NSMutableData *eventLine = [eventData mutableCopy];
  [eventLine appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
  int descriptor = open(url.path.fileSystemRepresentation, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (descriptor < 0) return;
  // O_APPEND plus one write keeps concurrently appended JSONL events from
  // interleaving between the JSON payload and its terminating newline.
  (void)write(descriptor, eventLine.bytes, eventLine.length);
  close(descriptor);
}

- (NSArray *)readAnnotationsWithError:(NSError **)error {
  NSURL *url = [self annotationsURL];
  if (![NSFileManager.defaultManager fileExistsAtPath:url.path]) return @[];
  NSData *data = [NSData dataWithContentsOfURL:url options:0 error:error];
  if (!data) return nil;
  id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
  if (![object isKindOfClass:NSArray.class]) {
    if (error) *error = [self storageError:@"user-annotations.json is corrupted; the original file was preserved and Liteverse refused to overwrite it with an empty array." code:535];
    return nil;
  }
  for (id annotation in object) {
    if (![annotation isKindOfClass:NSDictionary.class]) {
      if (error) *error = [self storageError:@"user-annotations.json contains an invalid record; the original file was preserved." code:536];
      return nil;
    }
  }
  return object;
}

- (NSArray *)readAnnotations {
  return [self readAnnotationsWithError:nil];
}

- (void)sendAnnotations:(NSArray *)annotations savedID:(NSString *)savedID {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:annotations options:0 error:&error];
  if (error || !data) return;
  NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  NSString *script = [NSString stringWithFormat:
      @"window.__liteverseReceiveAnnotations && window.__liteverseReceiveAnnotations(%@);", json];
  [self.webView evaluateJavaScript:script completionHandler:nil];
  if (savedID.length > 0) {
    NSString *callback = [NSString stringWithFormat:
        @"window.__liteverseAnnotationSaved && window.__liteverseAnnotationSaved('%@');", savedID];
    [self.webView evaluateJavaScript:callback completionHandler:nil];
  }
}

- (void)sendWorkspaceErrorForAction:(NSString *)action error:(NSError *)error {
  NSDictionary *payload = @{
    @"action": action ?: @"workspace",
    @"message": error.localizedDescription ?: @"The local data operation failed."
  };
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.webView callAsyncJavaScript:
        @"window.__liteverseWorkspaceError && window.__liteverseWorkspaceError(errorPayload);"
                              arguments:@{ @"errorPayload": payload }
                                inFrame:nil
                         inContentWorld:WKContentWorld.pageWorld
                      completionHandler:nil];
  });
}

- (void)sendLiteratureSearchError:(NSError *)error requestID:(NSString *)requestID {
  NSDictionary *payload = @{
    @"requestId": requestID ?: @"",
    @"message": error.localizedDescription ?: @"The local literature index is unavailable."
  };
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.webView callAsyncJavaScript:
        @"window.__liteverseReceiveLiteratureSearchError && window.__liteverseReceiveLiteratureSearchError(errorPayload);"
                              arguments:@{ @"errorPayload": payload }
                                inFrame:nil
                         inContentWorld:WKContentWorld.pageWorld
                      completionHandler:nil];
  });
}

- (void)sendUniverseGraph:(NSDictionary *)graph callback:(NSString *)callback {
  if (!graph || callback.length == 0) return;
  NSDictionary *runtimeGraph = [self graphByInjectingUsageCounts:graph];
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *source = [NSString stringWithFormat:
        @"window.%@ && window.%@(graphPayload);", callback, callback];
    [self.webView callAsyncJavaScript:source
                            arguments:@{ @"graphPayload": runtimeGraph }
                              inFrame:nil
                       inContentWorld:WKContentWorld.pageWorld
                    completionHandler:nil];
  });
}

- (void)loadAndSendUniverse {
  NSError *error = nil;
  if (![self ensureRuntimeGraphStorage:&error]) {
    [self sendWorkspaceErrorForAction:@"loadUniverse" error:error];
    return;
  }
  NSDictionary *graph = [self readDictionaryAtURL:[self currentGraphURL]
                                      defaultValue:nil
                                             error:&error];
  if (!graph) {
    [self sendWorkspaceErrorForAction:@"loadUniverse" error:error];
    return;
  }
  [self sendUniverseGraph:graph callback:@"__liteverseReceiveUniverse"];
}

- (NSDictionary *)stagedPayloadForPending:(NSDictionary *)pending error:(NSError **)error {
  NSString *refreshID = [pending[@"refreshId"] isKindOfClass:NSString.class]
      ? pending[@"refreshId"] : nil;
  if (![self isSafeRefreshID:refreshID]) {
    if (error) *error = [self storageError:@"pending-update.json contains an invalid refreshId." code:402];
    return nil;
  }
  NSURL *refreshDirectory = [[self stagedGraphDirectoryURL]
      URLByAppendingPathComponent:refreshID isDirectory:YES];
  NSURL *manifestURL = [refreshDirectory URLByAppendingPathComponent:@"manifest.json"];
  NSURL *snapshotURL = [refreshDirectory URLByAppendingPathComponent:@"snapshot.json"];
  NSDictionary *manifest = [self readDictionaryAtURL:manifestURL defaultValue:nil error:error];
  if (!manifest) return nil;
  NSDictionary *snapshot = [self readDictionaryAtURL:snapshotURL defaultValue:nil error:error];
  if (!snapshot) return nil;
  if (![manifest[@"refreshId"] isEqualToString:refreshID]) {
    if (error) *error = [self storageError:@"The staged manifest refreshId does not match pending-update.json." code:403];
    return nil;
  }
  NSMutableDictionary *payload = [pending mutableCopy];
  payload[@"manifest"] = manifest;
  payload[@"snapshot"] = [self graphByNormalizingWorkspaceContract:snapshot];
  return payload;
}

- (void)sendPendingRefresh {
  NSError *error = nil;
  if (![self ensureRuntimeGraphStorage:&error]) {
    [self sendWorkspaceErrorForAction:@"observePendingRefresh" error:error];
    return;
  }
  NSURL *pendingURL = [self pendingRefreshURL];
  id payload = NSNull.null;
  if ([NSFileManager.defaultManager fileExistsAtPath:pendingURL.path]) {
    NSDictionary *pending = [self readDictionaryAtURL:pendingURL defaultValue:nil error:&error];
    if (!pending) {
      [self sendWorkspaceErrorForAction:@"observePendingRefresh" error:error];
      return;
    }
    NSDictionary *stagedPayload = [self stagedPayloadForPending:pending error:&error];
    if (!stagedPayload) {
      [self sendWorkspaceErrorForAction:@"observePendingRefresh" error:error];
      return;
    }
    payload = stagedPayload;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.webView callAsyncJavaScript:
        @"window.__liteverseReceivePendingRefresh && window.__liteverseReceivePendingRefresh(refreshPayload);"
                              arguments:@{ @"refreshPayload": payload }
                                inFrame:nil
                         inContentWorld:WKContentWorld.pageWorld
                      completionHandler:nil];
  });
  [self sendWorkspaceWithNotice:nil];
}

- (void)startPendingRefreshObservation {
  NSError *error = nil;
  if (![self ensureRuntimeGraphStorage:&error]) {
    [self sendWorkspaceErrorForAction:@"observePendingRefresh" error:error];
    return;
  }
  if (_pendingRefreshSource) {
    [self sendPendingRefresh];
    return;
  }
  int descriptor = open([self graphDirectoryURL].path.fileSystemRepresentation, O_EVTONLY);
  if (descriptor < 0) {
    [self sendWorkspaceErrorForAction:@"observePendingRefresh"
                                error:[self storageError:@"Unable to monitor the Graph directory." code:404]];
    return;
  }
  _pendingRefreshSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE,
                                                  descriptor,
                                                  DISPATCH_VNODE_WRITE |
                                                      DISPATCH_VNODE_RENAME |
                                                      DISPATCH_VNODE_DELETE |
                                                      DISPATCH_VNODE_EXTEND |
                                                      DISPATCH_VNODE_ATTRIB,
                                                  _persistenceQueue);
  if (!_pendingRefreshSource) {
    close(descriptor);
    [self sendWorkspaceErrorForAction:@"observePendingRefresh"
                                error:[self storageError:@"Unable to create the Graph file watcher." code:405]];
    return;
  }
  __weak typeof(self) weakSelf = self;
  dispatch_source_t observedSource = _pendingRefreshSource;
  dispatch_source_set_event_handler(_pendingRefreshSource, ^{
    __strong typeof(weakSelf) strongSelf = weakSelf;
    if (!strongSelf) return;
    unsigned long flags = dispatch_source_get_data(observedSource);
    if (flags & (DISPATCH_VNODE_RENAME | DISPATCH_VNODE_DELETE)) {
      if (strongSelf->_pendingRefreshSource == observedSource) {
        dispatch_source_cancel(observedSource);
        strongSelf->_pendingRefreshSource = nil;
      }
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC),
                     strongSelf->_persistenceQueue, ^{
        [strongSelf startPendingRefreshObservation];
      });
      return;
    }
    [strongSelf sendPendingRefresh];
  });
  dispatch_source_set_cancel_handler(_pendingRefreshSource, ^{
    close(descriptor);
  });
  dispatch_resume(_pendingRefreshSource);
  [self sendPendingRefresh];
}

- (void)startWorkspaceObservation {
  NSError *error = nil;
  if (![self ensureRuntimeGraphStorage:&error]) {
    [self sendWorkspaceErrorForAction:@"loadWorkspace" error:error];
    return;
  }
  if (_workspaceSource) {
    [self sendWorkspaceWithNotice:nil];
    return;
  }
  int descriptor = open([self applicationSupportURL].path.fileSystemRepresentation, O_EVTONLY);
  if (descriptor < 0) {
    // The web layer's existing polling remains a deliberate fallback on file
    // systems that do not support vnode observation.
    NSLog(@"Liteverse workspace watcher unavailable; retaining polling fallback.");
    [self sendWorkspaceWithNotice:nil];
    return;
  }
  _workspaceSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE,
                                             descriptor,
                                             DISPATCH_VNODE_WRITE |
                                                 DISPATCH_VNODE_RENAME |
                                                 DISPATCH_VNODE_DELETE |
                                                 DISPATCH_VNODE_EXTEND |
                                                 DISPATCH_VNODE_ATTRIB,
                                             _persistenceQueue);
  if (!_workspaceSource) {
    close(descriptor);
    [self sendWorkspaceWithNotice:nil];
    return;
  }
  __weak typeof(self) weakSelf = self;
  dispatch_source_t observedSource = _workspaceSource;
  dispatch_source_set_event_handler(_workspaceSource, ^{
    __strong typeof(weakSelf) strongSelf = weakSelf;
    if (!strongSelf) return;
    unsigned long flags = dispatch_source_get_data(observedSource);
    if (flags & (DISPATCH_VNODE_RENAME | DISPATCH_VNODE_DELETE)) {
      if (strongSelf->_workspaceSource == observedSource) {
        dispatch_source_cancel(observedSource);
        strongSelf->_workspaceSource = nil;
      }
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC),
                     strongSelf->_persistenceQueue, ^{
        [strongSelf startWorkspaceObservation];
      });
      return;
    }
    NSUInteger generation = ++strongSelf->_workspaceObservationGeneration;
    // Atomic JSON writes commonly emit several vnode events. Coalesce them so
    // one user-visible change performs at most one graph/library health read.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 350 * NSEC_PER_MSEC),
                   strongSelf->_persistenceQueue, ^{
      if (!strongSelf || generation != strongSelf->_workspaceObservationGeneration) return;
      [strongSelf sendWorkspaceWithNotice:nil];
    });
  });
  dispatch_source_set_cancel_handler(_workspaceSource, ^{
    close(descriptor);
  });
  dispatch_resume(_workspaceSource);
  [self sendWorkspaceWithNotice:nil];
}

- (NSDictionary *)libraryByOrganizingManifestItems:(NSArray *)manifestItems
                                         refreshID:(NSString *)refreshID
                                     stagedPapers:(NSArray *)stagedPapers
                                           changed:(BOOL *)changed
                                             error:(NSError **)error {
  if (changed) *changed = NO;
  NSDictionary *storedLibrary = [self readDictionaryAtURL:[self libraryURL]
                                              defaultValue:[self defaultLibrary]
                                                     error:error];
  if (!storedLibrary) return nil;
  if (![manifestItems isKindOfClass:NSArray.class] || manifestItems.count == 0) return storedLibrary;

  NSMutableDictionary<NSString *, NSDictionary *> *descriptors = [NSMutableDictionary dictionary];
  for (id entry in manifestItems) {
    if ([entry isKindOfClass:NSString.class]) {
      descriptors[entry] = @{ @"itemId": entry };
      continue;
    }
    if (![entry isKindOfClass:NSDictionary.class]) continue;
    NSString *itemID = [entry[@"itemId"] isKindOfClass:NSString.class]
        ? entry[@"itemId"] : ([entry[@"id"] isKindOfClass:NSString.class] ? entry[@"id"] : nil);
    if (itemID.length > 0) descriptors[itemID] = entry;
  }
  NSMutableDictionary<NSString *, NSDictionary *> *papersByID = [NSMutableDictionary dictionary];
  for (id rawPaper in [stagedPapers isKindOfClass:NSArray.class] ? stagedPapers : @[]) {
    if (![rawPaper isKindOfClass:NSDictionary.class]) continue;
    NSString *paperID = [rawPaper[@"id"] isKindOfClass:NSString.class] ? rawPaper[@"id"] : nil;
    if (paperID.length > 0) papersByID[paperID] = rawPaper;
  }

  NSArray *sourceItems = [storedLibrary[@"items"] isKindOfClass:NSArray.class]
      ? storedLibrary[@"items"] : @[];
  NSMutableArray *updatedItems = [NSMutableArray arrayWithCapacity:sourceItems.count];
  NSMutableSet<NSString *> *satisfiedItemIDs = [NSMutableSet set];
  NSString *timestamp = [self isoTimestamp];
  for (id rawItem in sourceItems) {
    if (![rawItem isKindOfClass:NSDictionary.class]) continue;
    NSDictionary *item = rawItem;
    NSString *itemID = [item[@"id"] isKindOfClass:NSString.class] ? item[@"id"] : nil;
    NSDictionary *descriptor = descriptors[itemID];
    if (!descriptor) {
      [updatedItems addObject:item];
      continue;
    }
    id expectedRevision = descriptor[@"revision"];
    if (expectedRevision && ![self revision:item[@"revision"] matches:expectedRevision]) {
      if (error) *error = [self storageError:
          [NSString stringWithFormat:@"Library item %@ changed revision; the Refresh was preserved for reprocessing.", itemID]
                                        code:413];
      return nil;
    }
    NSString *itemRefreshID = [item[@"refreshId"] isKindOfClass:NSString.class]
        ? item[@"refreshId"] : nil;
    if (![itemRefreshID isEqualToString:refreshID]) {
      if (error) *error = [self storageError:
          [NSString stringWithFormat:@"Library item %@ does not belong to the current Refresh.", itemID]
                                        code:414];
      return nil;
    }
    BOOL isReady = [item[@"status"] isEqualToString:@"ready_to_refresh"];
    BOOL isAlreadyOrganized = [item[@"status"] isEqualToString:@"organized"];
    if (!isReady && !isAlreadyOrganized) {
      if (error) *error = [self storageError:
          [NSString stringWithFormat:@"Library item %@ changed status; the Refresh was preserved.", itemID]
                                        code:415];
      return nil;
    }
    [satisfiedItemIDs addObject:itemID];
    if (isAlreadyOrganized) {
      [updatedItems addObject:item];
      continue;
    }
    NSMutableDictionary *updated = [item mutableCopy];
    updated[@"status"] = @"organized";
    updated[@"organizedAt"] = timestamp;
    updated[@"updatedAt"] = timestamp;
    updated[@"refreshId"] = refreshID;
    NSString *paperID = [descriptor[@"paperId"] isKindOfClass:NSString.class]
        ? descriptor[@"paperId"] : nil;
    if (paperID.length > 0) {
      updated[@"graphPaperId"] = paperID;
      NSDictionary *paper = papersByID[paperID];
      if (paper) {
        if ([paper[@"title"] isKindOfClass:NSString.class]) updated[@"displayTitle"] = paper[@"title"];
        updated[@"titleStatus"] = @"codex_verified";
        if ([paper[@"verificationStatus"] isKindOfClass:NSString.class]) {
          updated[@"verificationStatus"] = paper[@"verificationStatus"];
        }
        if ([paper[@"citekey"] isKindOfClass:NSString.class]) updated[@"citekey"] = paper[@"citekey"];
        NSDictionary *source = [paper[@"source"] isKindOfClass:NSDictionary.class] ? paper[@"source"] : @{};
        NSDictionary *artifacts = [paper[@"artifacts"] isKindOfClass:NSDictionary.class] ? paper[@"artifacts"] : @{};
        if (source.count > 0) updated[@"source"] = source;
        if (artifacts.count > 0) updated[@"artifacts"] = artifacts;
        NSString *pdfPath = [source[@"pdfPath"] isKindOfClass:NSString.class]
            ? source[@"pdfPath"] : ([paper[@"pdfPath"] isKindOfClass:NSString.class] ? paper[@"pdfPath"] : nil);
        if (pdfPath.length > 0) {
          updated[@"localPath"] = pdfPath;
          updated[@"storedFilename"] = pdfPath.lastPathComponent;
        }
        if ([source[@"arxivId"] isKindOfClass:NSString.class]) {
          updated[@"arxivId"] = source[@"arxivId"];
          updated[@"arxivUrl"] = [NSString stringWithFormat:@"https://arxiv.org/abs/%@", source[@"arxivId"]];
        }
      }
    }
    [updatedItems addObject:updated];
    if (changed) *changed = YES;
  }
  if (satisfiedItemIDs.count != descriptors.count) {
    NSMutableSet *missing = [NSMutableSet setWithArray:descriptors.allKeys];
    [missing minusSet:satisfiedItemIDs];
    if (error) *error = [self storageError:
        [NSString stringWithFormat:@"The Refresh references missing Library items: %@", [[missing allObjects] componentsJoinedByString:@", "]]
                                      code:416];
    return nil;
  }
  NSMutableDictionary *library = [storedLibrary mutableCopy];
  library[@"items"] = updatedItems;
  return library;
}

- (void)sendRefreshCommittedGraph:(NSDictionary *)graph {
  [self sendUniverseGraph:graph callback:@"__liteverseRefreshCommitted"];
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.webView callAsyncJavaScript:
        @"window.__liteverseReceivePendingRefresh && window.__liteverseReceivePendingRefresh(null);"
                              arguments:@{}
                                inFrame:nil
                         inContentWorld:WKContentWorld.pageWorld
                      completionHandler:nil];
  });
}

- (void)commitRefreshPayload:(NSDictionary *)request {
  NSError *error = nil;
  if (![self ensureRuntimeGraphStorage:&error]) {
    [self sendWorkspaceErrorForAction:@"commitRefresh" error:error];
    return;
  }

  NSString *refreshID = [request[@"refreshId"] isKindOfClass:NSString.class]
      ? request[@"refreshId"] : nil;
  id requestedBaseRevision = request[@"baseRevision"];
  NSString *requestedHash = [request[@"snapshotSha256"] isKindOfClass:NSString.class]
      ? [request[@"snapshotSha256"] lowercaseString] : nil;
  if (![self isSafeRefreshID:refreshID] || !requestedBaseRevision || requestedHash.length != 64) {
    [self sendWorkspaceErrorForAction:@"commitRefresh"
                                error:[self storageError:@"The Refresh request is missing a valid refreshId, baseRevision, or snapshotSha256." code:406]];
    return;
  }

  NSURL *pendingURL = [self pendingRefreshURL];
  if (![NSFileManager.defaultManager fileExistsAtPath:pendingURL.path]) {
    [self sendWorkspaceErrorForAction:@"commitRefresh"
                                error:[self storageError:@"There is no pending Refresh batch to commit." code:407]];
    return;
  }
  NSDictionary *pending = [self readDictionaryAtURL:pendingURL defaultValue:nil error:&error];
  if (!pending) {
    [self sendWorkspaceErrorForAction:@"commitRefresh" error:error];
    return;
  }
  if (![pending[@"refreshId"] isEqualToString:refreshID] ||
      ![self revision:pending[@"baseRevision"] matches:requestedBaseRevision]) {
    [self sendWorkspaceErrorForAction:@"commitRefresh"
                                error:[self storageError:@"The Refresh request does not match pending-update.json." code:408]];
    return;
  }

  NSURL *refreshDirectory = [[self stagedGraphDirectoryURL]
      URLByAppendingPathComponent:refreshID isDirectory:YES];
  NSURL *manifestURL = [refreshDirectory URLByAppendingPathComponent:@"manifest.json"];
  NSURL *snapshotURL = [refreshDirectory URLByAppendingPathComponent:@"snapshot.json"];
  NSDictionary *manifest = [self readDictionaryAtURL:manifestURL defaultValue:nil error:&error];
  NSData *snapshotData = [NSData dataWithContentsOfURL:snapshotURL options:0 error:&error];
  if (!manifest || !snapshotData) {
    [self sendWorkspaceErrorForAction:@"commitRefresh" error:error];
    return;
  }
  id rawSnapshot = [NSJSONSerialization JSONObjectWithData:snapshotData options:0 error:&error];
  if (![rawSnapshot isKindOfClass:NSDictionary.class]) {
    [self sendWorkspaceErrorForAction:@"commitRefresh"
                                error:error ?: [self storageError:@"The staged snapshot is not a valid graph object." code:409]];
    return;
  }
  NSDictionary *snapshot = rawSnapshot;
  NSString *manifestHash = [manifest[@"snapshotSha256"] isKindOfClass:NSString.class]
      ? [manifest[@"snapshotSha256"] lowercaseString] : nil;
  NSString *actualHash = [self sha256ForData:snapshotData];
  id targetRevision = manifest[@"targetRevision"];
  if (![manifest[@"refreshId"] isEqualToString:refreshID] ||
      ![self revision:manifest[@"baseRevision"] matches:requestedBaseRevision] ||
      !targetRevision ||
      ![self revision:snapshot[@"revision"] matches:targetRevision] ||
      ![manifestHash isEqualToString:requestedHash] ||
      ![actualHash isEqualToString:requestedHash]) {
    [self sendWorkspaceErrorForAction:@"commitRefresh"
                                error:[self storageError:@"Refresh validation failed: revision or snapshot SHA-256 mismatch." code:410]];
    return;
  }

  NSURL *currentURL = [self currentGraphURL];
  NSData *currentData = [NSData dataWithContentsOfURL:currentURL options:0 error:&error];
  if (!currentData) {
    [self sendWorkspaceErrorForAction:@"commitRefresh" error:error];
    return;
  }
  id rawCurrent = [NSJSONSerialization JSONObjectWithData:currentData options:0 error:&error];
  if (![rawCurrent isKindOfClass:NSDictionary.class]) {
    [self sendWorkspaceErrorForAction:@"commitRefresh"
                                error:error ?: [self storageError:@"current.json is not a valid graph object." code:411]];
    return;
  }
  NSDictionary *current = rawCurrent;
  NSString *currentHash = [self sha256ForData:currentData];
  BOOL alreadyPromoted = [self revision:current[@"revision"] matches:targetRevision] &&
      [currentHash isEqualToString:actualHash];
  if (!alreadyPromoted && ![self revision:current[@"revision"] matches:requestedBaseRevision]) {
    [self sendWorkspaceErrorForAction:@"commitRefresh"
                                error:[self storageError:@"The current graph revision changed; overwrite was refused. Generate a new staged Refresh." code:412]];
    return;
  }

  BOOL libraryChanged = NO;
  NSArray *manifestItems = [manifest[@"libraryItems"] isKindOfClass:NSArray.class]
      ? manifest[@"libraryItems"] : @[];
  NSDictionary *updatedLibrary = [self libraryByOrganizingManifestItems:manifestItems
                                                               refreshID:refreshID
                                                           stagedPapers:snapshot[@"papers"]
                                                                 changed:&libraryChanged
                                                                   error:&error];
  if (!updatedLibrary) {
    [self sendWorkspaceErrorForAction:@"commitRefresh" error:error];
    return;
  }
  BOOL libraryExisted = [NSFileManager.defaultManager fileExistsAtPath:[self libraryURL].path];
  NSData *previousLibraryData = libraryExisted
      ? [NSData dataWithContentsOfURL:[self libraryURL] options:0 error:nil] : nil;

  NSURL *historyURL = [[self graphHistoryDirectoryURL]
      URLByAppendingPathComponent:[NSString stringWithFormat:@"%@-base.json", refreshID]];
  if (!alreadyPromoted && ![NSFileManager.defaultManager fileExistsAtPath:historyURL.path] &&
      ![currentData writeToURL:historyURL options:NSDataWritingAtomic error:&error]) {
    [self sendWorkspaceErrorForAction:@"commitRefresh" error:error];
    return;
  }

  if (!alreadyPromoted && ![snapshotData writeToURL:currentURL options:NSDataWritingAtomic error:&error]) {
    [self sendWorkspaceErrorForAction:@"commitRefresh" error:error];
    return;
  }
  if (libraryChanged && ![self writeJSONObject:updatedLibrary toURL:[self libraryURL] error:&error]) {
    if (!alreadyPromoted) [currentData writeToURL:currentURL options:NSDataWritingAtomic error:nil];
    [self sendWorkspaceErrorForAction:@"commitRefresh" error:error];
    return;
  }

  if (![NSFileManager.defaultManager removeItemAtURL:pendingURL error:&error]) {
    if (!alreadyPromoted) [currentData writeToURL:currentURL options:NSDataWritingAtomic error:nil];
    if (libraryChanged) {
      if (libraryExisted && previousLibraryData) {
        [previousLibraryData writeToURL:[self libraryURL] options:NSDataWritingAtomic error:nil];
      } else {
        [NSFileManager.defaultManager removeItemAtURL:[self libraryURL] error:nil];
      }
    }
    [self sendWorkspaceErrorForAction:@"commitRefresh" error:error];
    return;
  }

  [self appendJSONObject:@{
    @"eventId": NSUUID.UUID.UUIDString,
    @"action": @"graph_refresh_committed",
    @"timestamp": [self isoTimestamp],
    @"refreshId": refreshID,
    @"baseRevision": requestedBaseRevision,
    @"targetRevision": targetRevision,
    @"snapshotSha256": requestedHash
  } toURL:[self workspaceInboxURL]];
  // The pending marker has now been removed, so an app-owned visual-catalog
  // migration can safely run without breaking Refresh recovery/idempotency.
  NSError *catalogError = nil;
  [self synchronizePackagedNebulaAssetCatalogIfSafe:&catalogError];
  NSDictionary *committedGraph = [self readDictionaryAtURL:currentURL
                                               defaultValue:snapshot
                                                      error:nil];
  [self sendRefreshCommittedGraph:committedGraph ?: snapshot];
  [self sendWorkspaceWithNotice:@"The literature universe was refreshed atomically."];
}

- (NSDictionary *)projectDataForID:(NSString *)projectID
                           registry:(NSDictionary *)registry
                              error:(NSError **)error {
  NSURL *projectDirectory = [self projectDirectoryURLForID:projectID error:error];
  if (!projectDirectory) return nil;
  NSDictionary *registryItem = nil;
  for (NSDictionary *item in [registry[@"items"] isKindOfClass:NSArray.class] ? registry[@"items"] : @[]) {
    NSString *itemID = [item[@"projectId"] isKindOfClass:NSString.class] ? item[@"projectId"] : item[@"id"];
    if ([itemID isEqualToString:projectID]) { registryItem = item; break; }
  }
  if (!registryItem) {
    if (error) *error = [self storageError:@"The active project is not listed in Projects/projects.json." code:537];
    return nil;
  }

  NSFileManager *manager = NSFileManager.defaultManager;
  NSURL *projectDocumentURL = [projectDirectory URLByAppendingPathComponent:@"project.json"];
  BOOL projectDocumentExists = [manager fileExistsAtPath:projectDocumentURL.path];
  NSURL *prospectiveMemoryURL = [[projectDirectory URLByAppendingPathComponent:@"memory" isDirectory:YES]
      URLByAppendingPathComponent:@"current.json"];
  BOOL memoryProjectionExists = [manager fileExistsAtPath:prospectiveMemoryURL.path];
  NSDictionary *projectDocument = projectDocumentExists
      ? [self readDictionaryAtURL:projectDocumentURL defaultValue:nil error:error]
      : ([projectID isEqualToString:@"project-default"] && !memoryProjectionExists ? registryItem : nil);
  if (!projectDocument || ![projectDocument[@"projectId"] isEqualToString:projectID]) {
    if (error && !*error) *error = [self storageError:@"project.json is invalid or has a mismatched project ID." code:548];
    return nil;
  }
  NSURL *memoryURL = [[projectDirectory URLByAppendingPathComponent:@"memory" isDirectory:YES]
      URLByAppendingPathComponent:@"current.json"];
  NSURL *tasksURL = [projectDirectory URLByAppendingPathComponent:@"tasks.json"];
  NSDictionary *memory = [manager fileExistsAtPath:memoryURL.path]
      ? [self readDictionaryAtURL:memoryURL defaultValue:nil error:error]
      : @{ @"schemaVersion": @1, @"projectId": projectID, @"revision": @0, @"items": @[] };
  if (!memory) return nil;
  NSDictionary *tasksDocument = [manager fileExistsAtPath:tasksURL.path]
      ? [self readDictionaryAtURL:tasksURL defaultValue:nil error:error]
      : @{ @"schemaVersion": @1, @"projectId": projectID, @"revision": @0, @"tasks": @[], @"handoffs": @[] };
  if (!tasksDocument) return nil;

  // Projection closure is strict when Research Memory has materialized a
  // ledger-backed revision. A mismatch must never be shown as current truth.
  NSNumber *projectRevision = [registryItem[@"revision"] isKindOfClass:NSNumber.class] ? registryItem[@"revision"] : @0;
  NSString *projectLedgerHash = [registryItem[@"ledgerHash"] isKindOfClass:NSString.class] ? registryItem[@"ledgerHash"] : @"";
  NSNumber *documentRevision = [projectDocument[@"revision"] isKindOfClass:NSNumber.class] ? projectDocument[@"revision"] : @0;
  NSString *documentLedgerHash = [projectDocument[@"ledgerHash"] isKindOfClass:NSString.class] ? projectDocument[@"ledgerHash"] : @"";
  if (![documentRevision isEqualToNumber:projectRevision] || ![documentLedgerHash isEqualToString:projectLedgerHash]) {
    if (error) *error = [self storageError:@"project.json and Projects/projects.json have mismatched revision or ledgerHash values." code:549];
    return nil;
  }
  NSArray *projections = @[memory, tasksDocument];
  for (NSDictionary *projection in projections) {
    NSNumber *projectionRevision = [projection[@"revision"] isKindOfClass:NSNumber.class] ? projection[@"revision"] : @0;
    NSString *projectionLedgerHash = [projection[@"ledgerHash"] isKindOfClass:NSString.class] ? projection[@"ledgerHash"] : @"";
    NSString *projectionProjectID = [projection[@"projectId"] isKindOfClass:NSString.class] ? projection[@"projectId"] : projectID;
    BOOL hasMaterializedProjection = projectionRevision.integerValue > 0 || projectionLedgerHash.length > 0;
    if (hasMaterializedProjection &&
        (![projectionProjectID isEqualToString:projectID] ||
         ![projectionRevision isEqualToNumber:projectRevision] ||
         ![projectionLedgerHash isEqualToString:projectLedgerHash])) {
      if (error) *error = [self storageError:
          [NSString stringWithFormat:@"Project %@ has mismatched memory/tasks projection revision or ledgerHash values and cannot be displayed.", projectID]
                                        code:538];
      return nil;
    }
  }

  NSArray *tasks = [tasksDocument[@"tasks"] isKindOfClass:NSArray.class] ? tasksDocument[@"tasks"] : @[];
  NSMutableArray *contextPacks = [NSMutableArray array];
  NSMutableArray *artifacts = [NSMutableArray array];
  NSMutableSet<NSString *> *artifactKeys = [NSMutableSet set];
  for (NSDictionary *task in tasks) {
    for (id rawOutput in [task[@"outputs"] isKindOfClass:NSArray.class] ? task[@"outputs"] : @[]) {
      if ([rawOutput isKindOfClass:NSDictionary.class]) {
        NSMutableDictionary *artifact = [rawOutput mutableCopy];
        artifact[@"kind"] = [artifact[@"kind"] isKindOfClass:NSString.class] ? artifact[@"kind"] : @"result";
        artifact[@"id"] = artifact[@"id"] ?: [NSString stringWithFormat:@"%@-%lu", task[@"taskHash"] ?: @"task", (unsigned long)artifacts.count];
        NSString *artifactKey = [artifact[@"contentHash"] isKindOfClass:NSString.class]
            ? [@"hash:" stringByAppendingString:artifact[@"contentHash"]]
            : ([artifact[@"path"] isKindOfClass:NSString.class]
                ? [@"path:" stringByAppendingString:artifact[@"path"]]
                : [@"id:" stringByAppendingString:[artifact[@"id"] description]]);
        if (![artifactKeys containsObject:artifactKey]) {
          [artifactKeys addObject:artifactKey];
          [artifacts addObject:artifact];
        }
      } else if ([rawOutput isKindOfClass:NSString.class]) {
        NSString *artifactID = [NSString stringWithFormat:@"%@-%lu", task[@"taskHash"] ?: @"task", (unsigned long)artifacts.count];
        [artifactKeys addObject:[@"path:" stringByAppendingString:rawOutput]];
        [artifacts addObject:@{
          @"id": artifactID,
          @"kind": @"result",
          @"path": rawOutput,
          @"title": [rawOutput lastPathComponent]
        }];
      }
    }
  }
  // A code or experiment memory is itself a first-class reproducible artifact,
  // even when task completion did not duplicate it in `outputs`.
  for (NSDictionary *memoryItem in [memory[@"items"] isKindOfClass:NSArray.class] ? memory[@"items"] : @[]) {
    NSString *kind = [memoryItem[@"type"] isKindOfClass:NSString.class] ? memoryItem[@"type"] : @"";
    if (!([kind isEqualToString:@"code"] || [kind isEqualToString:@"experiment"])) continue;
    NSDictionary *metadata = [memoryItem[@"computationArtifact"] isKindOfClass:NSDictionary.class]
        ? memoryItem[@"computationArtifact"] : nil;
    if (!metadata) continue;
    NSString *memoryID = [memoryItem[@"memoryId"] isKindOfClass:NSString.class]
        ? memoryItem[@"memoryId"] : [NSString stringWithFormat:@"memory-artifact-%lu", (unsigned long)artifacts.count];
    NSString *artifactKey = [metadata[@"contentHash"] isKindOfClass:NSString.class]
        ? [@"hash:" stringByAppendingString:metadata[@"contentHash"]]
        : ([metadata[@"path"] isKindOfClass:NSString.class]
            ? [@"path:" stringByAppendingString:metadata[@"path"]]
            : [@"id:" stringByAppendingString:memoryID]);
    if ([artifactKeys containsObject:artifactKey]) continue;
    NSMutableDictionary *artifact = [metadata mutableCopy];
    artifact[@"id"] = memoryID;
    artifact[@"kind"] = kind;
    artifact[@"title"] = [memoryItem[@"title"] isKindOfClass:NSString.class]
        ? memoryItem[@"title"] : (metadata[@"path"] ?: memoryID);
    artifact[@"summary"] = [memoryItem[@"content"] isKindOfClass:NSString.class]
        ? memoryItem[@"content"] : (metadata[@"resultSummary"] ?: @"");
    artifact[@"status"] = [memoryItem[@"evidenceState"] isKindOfClass:NSString.class]
        ? memoryItem[@"evidenceState"] : @"recorded";
    if ([memoryItem[@"createdAt"] isKindOfClass:NSString.class]) artifact[@"createdAt"] = memoryItem[@"createdAt"];
    [artifactKeys addObject:artifactKey];
    [artifacts addObject:artifact];
  }

  NSURL *tasksDirectory = [projectDirectory URLByAppendingPathComponent:@"Tasks" isDirectory:YES];
  __block NSError *contextEnumerationError = nil;
  NSDirectoryEnumerator<NSURL *> *enumerator = [manager enumeratorAtURL:tasksDirectory
      includingPropertiesForKeys:@[NSURLIsRegularFileKey]
                         options:NSDirectoryEnumerationSkipsHiddenFiles
                    errorHandler:^BOOL(NSURL *url, NSError *enumerationError) {
    contextEnumerationError = enumerationError;
    return NO;
  }];
  NSString *supportPrefix = [[[self applicationSupportURL].URLByStandardizingPath path]
      stringByAppendingString:@"/"];
  for (NSURL *fileURL in enumerator) {
    if (![fileURL.pathExtension.lowercaseString isEqualToString:@"json"] ||
        ![fileURL.URLByDeletingLastPathComponent.lastPathComponent isEqualToString:@"context-packs"]) continue;
    NSDictionary *rawPack = [self readDictionaryAtURL:fileURL defaultValue:nil error:error];
    if (!rawPack) return nil;
    NSMutableDictionary *pack = [rawPack mutableCopy];
    NSString *contextID = [pack[@"contextId"] isKindOfClass:NSString.class]
        ? pack[@"contextId"] : pack[@"packId"];
    if (contextID.length == 0) contextID = fileURL.URLByDeletingPathExtension.lastPathComponent;
    pack[@"contextId"] = contextID;
    NSString *jsonPath = [fileURL.URLByStandardizingPath.path hasPrefix:supportPrefix]
        ? [fileURL.URLByStandardizingPath.path substringFromIndex:supportPrefix.length] : @"";
    pack[@"jsonPath"] = jsonPath;
    NSURL *markdownURL = [fileURL.URLByDeletingPathExtension URLByAppendingPathExtension:@"md"];
    if ([manager fileExistsAtPath:markdownURL.path]) {
      pack[@"markdownPath"] = [markdownURL.URLByStandardizingPath.path substringFromIndex:supportPrefix.length];
    }
    [contextPacks addObject:pack];
  }
  if (contextEnumerationError) {
    if (error) *error = contextEnumerationError;
    return nil;
  }

  NSDictionary *countsDocument = [self readDictionaryAtURL:[self usageCountsURL]
                                               defaultValue:@{ @"projectCounts": @{} }
                                                      error:error];
  if (!countsDocument) return nil;
  NSDictionary *projectCounts = [countsDocument[@"projectCounts"] isKindOfClass:NSDictionary.class]
      ? countsDocument[@"projectCounts"] : @{};
  NSDictionary *activeCounts = [projectCounts[projectID] isKindOfClass:NSDictionary.class]
      ? projectCounts[projectID] : @{};
  return @{
    @"projectMemory": @{
      @"revision": [memory[@"revision"] isKindOfClass:NSNumber.class] ? memory[@"revision"] : @0,
      @"items": [memory[@"items"] isKindOfClass:NSArray.class] ? memory[@"items"] : @[]
    },
    @"tasks": tasks,
    @"contextPacks": contextPacks,
    @"artifacts": artifacts,
    @"projectUseCounts": activeCounts
  };
}

- (NSError *)searchIndexErrorWithDetail:(NSString *)detail code:(NSInteger)code {
  NSString *message = @"The local search index is unavailable. Run `liteverse index rebuild` and try again.";
  if (detail.length > 0) {
    message = [NSString stringWithFormat:@"The local search index is unavailable (%@). Run `liteverse index rebuild` and try again.", detail];
  }
  return [self storageError:message code:code];
}

- (NSString *)sqliteTextFromStatement:(sqlite3_stmt *)statement column:(int)column {
  const unsigned char *value = sqlite3_column_text(statement, column);
  return value ? [NSString stringWithUTF8String:(const char *)value] : @"";
}

- (NSString *)normalizedSearchText:(NSString *)rawValue {
  NSString *value = [[rawValue ?: @"" precomposedStringWithCompatibilityMapping]
      lowercaseStringWithLocale:[NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"]];
  NSDictionary<NSString *, NSString *> *greekAliases = @{
    @"ψ": @" psi ", @"ρ": @" rho ", @"γ": @" gamma ", @"λ": @" lambda "
  };
  for (NSString *symbol in greekAliases) {
    value = [value stringByReplacingOccurrencesOfString:symbol withString:greekAliases[symbol]];
  }
  NSMutableString *normalized = [NSMutableString stringWithCapacity:value.length];
  NSCharacterSet *alphanumeric = NSCharacterSet.alphanumericCharacterSet;
  BOOL previousWasSpace = YES;
  for (NSUInteger index = 0; index < value.length; index += 1) {
    unichar character = [value characterAtIndex:index];
    BOOL retained = character == '_' || [alphanumeric characterIsMember:character];
    if (retained) {
      [normalized appendFormat:@"%C", character];
      previousWasSpace = NO;
    } else if (!previousWasSpace) {
      [normalized appendString:@" "];
      previousWasSpace = YES;
    }
  }
  return [normalized stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

- (BOOL)isCJKSearchCharacter:(unichar)character {
  return character >= 0x3400 && character <= 0x9fff;
}

- (NSString *)expandedSearchText:(NSString *)rawValue aliases:(NSArray *)aliases {
  NSString *normalized = [self normalizedSearchText:rawValue];
  NSMutableArray<NSString *> *additions = [NSMutableArray array];
  for (NSUInteger index = 0; index + 1 < normalized.length; index += 1) {
    unichar left = [normalized characterAtIndex:index];
    unichar right = [normalized characterAtIndex:index + 1];
    if ([self isCJKSearchCharacter:left] && [self isCJKSearchCharacter:right]) {
      [additions addObject:[normalized substringWithRange:NSMakeRange(index, 2)]];
    }
  }
  NSArray<NSString *> *normalizedWords = [normalized componentsSeparatedByString:@" "];
  NSSet<NSString *> *wordSet = [NSSet setWithArray:normalizedWords];
  for (id rawEntry in aliases) {
    if (![rawEntry isKindOfClass:NSArray.class]) continue;
    NSArray *entry = rawEntry;
    if (entry.count != 2 || ![entry[0] isKindOfClass:NSString.class] ||
        ![entry[1] isKindOfClass:NSString.class]) continue;
    NSString *key = entry[0];
    NSString *aliasText = [self normalizedSearchText:entry[1]];
    BOOL matched = [wordSet containsObject:key];
    if (!matched) {
      for (NSString *token in [aliasText componentsSeparatedByString:@" "]) {
        if (token.length > 0 && [normalized containsString:token]) {
          matched = YES;
          break;
        }
      }
    }
    if (matched) {
      [additions addObject:key];
      [additions addObject:aliasText];
    }
  }
  return additions.count > 0
      ? [NSString stringWithFormat:@"%@ %@", normalized, [additions componentsJoinedByString:@" "]]
      : normalized;
}

- (NSString *)searchExpressionForQuery:(NSString *)query
                                aliases:(NSArray *)aliases
                                  error:(NSError **)error {
  NSString *expanded = [self expandedSearchText:query aliases:aliases];
  NSMutableOrderedSet<NSString *> *tokens = [NSMutableOrderedSet orderedSet];
  for (NSString *token in [expanded componentsSeparatedByString:@" "]) {
    if (token.length > 0) [tokens addObject:token];
    if (tokens.count >= 48) break;
  }
  if (tokens.count == 0) {
    if (error) *error = [self storageError:@"The normalized query contains no searchable letters or numbers." code:551];
    return nil;
  }
  NSMutableArray<NSString *> *quoted = [NSMutableArray arrayWithCapacity:tokens.count];
  for (NSString *token in tokens) {
    NSString *escaped = [token stringByReplacingOccurrencesOfString:@"\"" withString:@"\"\""];
    [quoted addObject:[NSString stringWithFormat:@"\"%@\"", escaped]];
  }
  return [quoted componentsJoinedByString:@" OR "];
}

- (BOOL)prepareSearchStatement:(sqlite3_stmt **)statement
                      database:(sqlite3 *)database
                           sql:(const char *)sql
                         error:(NSError **)error {
  int status = sqlite3_prepare_v2(database, sql, -1, statement, NULL);
  if (status == SQLITE_OK) return YES;
  if (error) {
    NSString *detail = [NSString stringWithUTF8String:sqlite3_errmsg(database)] ?: @"SQL prepare failed";
    *error = [self searchIndexErrorWithDetail:detail code:552];
  }
  return NO;
}

- (NSMutableDictionary *)indexedPaperFromStatement:(sqlite3_stmt *)statement {
  NSString *authors = [self sqliteTextFromStatement:statement column:2];
  NSString *tags = [self sqliteTextFromStatement:statement column:3];
  id primaryCategory = sqlite3_column_type(statement, 5) == SQLITE_NULL
      ? NSNull.null : [self sqliteTextFromStatement:statement column:5];
  id secondaryCategory = sqlite3_column_type(statement, 6) == SQLITE_NULL
      ? NSNull.null : [self sqliteTextFromStatement:statement column:6];
  return [@{
    @"paperId": [self sqliteTextFromStatement:statement column:0],
    @"title": [self sqliteTextFromStatement:statement column:1],
    @"authors": authors.length > 0 ? [authors componentsSeparatedByString:@"; "] : @[],
    @"tags": tags.length > 0 ? [tags componentsSeparatedByString:@"; "] : @[],
    @"verificationStatus": [self sqliteTextFromStatement:statement column:4],
    @"primaryCategory": primaryCategory,
    @"secondaryCategory": secondaryCategory,
    @"artifactRevision": @(sqlite3_column_int64(statement, 7)),
    @"artifactSha256": [self sqliteTextFromStatement:statement column:8],
    @"_cardPath": [self sqliteTextFromStatement:statement column:9],
    @"_cardSha256": [self sqliteTextFromStatement:statement column:10],
    @"_claimsPath": [self sqliteTextFromStatement:statement column:11],
    @"_claimsSha256": [self sqliteTextFromStatement:statement column:12],
    @"rank": @(sqlite3_column_double(statement, 16)),
    @"snippet": [[self sqliteTextFromStatement:statement column:17]
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet],
    @"matchingClaims": [NSMutableArray array],
    @"legacyLinesRemovedFromIndex": @(sqlite3_column_int64(statement, 15)),
    @"relationExpansion": [NSMutableArray array]
  } mutableCopy];
}

- (NSDictionary *)indexedClaimFromStatement:(sqlite3_stmt *)statement error:(NSError **)error {
  NSString *evidenceJSON = [self sqliteTextFromStatement:statement column:5];
  NSData *evidenceData = [evidenceJSON dataUsingEncoding:NSUTF8StringEncoding];
  id evidence = evidenceData
      ? [NSJSONSerialization JSONObjectWithData:evidenceData options:0 error:error]
      : nil;
  if (![evidence isKindOfClass:NSArray.class]) {
    if (error && !*error) *error = [self searchIndexErrorWithDetail:@"claim evidence JSON is corrupted" code:553];
    return nil;
  }
  return @{
    @"claimId": [self sqliteTextFromStatement:statement column:0],
    @"type": [self sqliteTextFromStatement:statement column:2],
    @"section": [self sqliteTextFromStatement:statement column:3],
    @"text": [self sqliteTextFromStatement:statement column:4],
    @"evidence": evidence,
    @"verificationStatus": [self sqliteTextFromStatement:statement column:6],
    @"artifactRevision": @(sqlite3_column_int64(statement, 7)),
    @"artifactSha256": [self sqliteTextFromStatement:statement column:8],
    @"rank": @(sqlite3_column_double(statement, 9))
  };
}

- (NSDictionary *)searchLiteratureAtIndexForQuery:(NSString *)query
                                             limit:(NSInteger)limit
                                             error:(NSError **)error {
  NSString *trimmed = [query isKindOfClass:NSString.class]
      ? [query stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]
      : @"";
  if (trimmed.length == 0 || trimmed.length > 2000 || limit < 1 || limit > 100) {
    if (error) *error = [self storageError:@"The search query or result limit is invalid." code:550];
    return nil;
  }
  NSURL *databaseURL = [self searchIndexURL];
  BOOL isDirectory = NO;
  if (![NSFileManager.defaultManager fileExistsAtPath:databaseURL.path isDirectory:&isDirectory] || isDirectory) {
    if (error) *error = [self searchIndexErrorWithDetail:@"the index file does not exist" code:554];
    return nil;
  }

  sqlite3 *database = NULL;
  int openStatus = sqlite3_open_v2(databaseURL.path.fileSystemRepresentation,
                                   &database,
                                   SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX,
                                   NULL);
  if (openStatus != SQLITE_OK || !database) {
    NSString *detail = database ? [NSString stringWithUTF8String:sqlite3_errmsg(database)] : @"open failed";
    if (database) sqlite3_close(database);
    if (error) *error = [self searchIndexErrorWithDetail:detail code:555];
    return nil;
  }
  sqlite3_busy_timeout(database, 1200);
  if (sqlite3_db_readonly(database, "main") != 1) {
    sqlite3_close(database);
    if (error) *error = [self searchIndexErrorWithDetail:@"the index was not opened in read-only mode" code:556];
    return nil;
  }

  NSString *fingerprint = nil;
  sqlite3_stmt *metadataStatement = NULL;
  if (![self prepareSearchStatement:&metadataStatement database:database
        sql:"SELECT key, value FROM metadata WHERE key IN ('schemaVersion', 'queryContractVersion', 'aliasContractJson', 'aliasContractSha256', 'fingerprint', 'catalogSha256', 'paperCount', 'claimCount') ORDER BY key" error:error]) {
    sqlite3_close(database);
    return nil;
  }
  NSString *schemaVersion = nil;
  NSString *queryContractVersion = nil;
  NSString *aliasContractJSON = nil;
  NSString *aliasContractSha256 = nil;
  NSString *catalogSha256 = nil;
  NSInteger indexedPaperCount = -1;
  NSInteger indexedClaimCount = -1;
  int stepStatus = SQLITE_ROW;
  while ((stepStatus = sqlite3_step(metadataStatement)) == SQLITE_ROW) {
    NSString *key = [self sqliteTextFromStatement:metadataStatement column:0];
    NSString *value = [self sqliteTextFromStatement:metadataStatement column:1];
    if ([key isEqualToString:@"schemaVersion"]) schemaVersion = value;
    if ([key isEqualToString:@"queryContractVersion"]) queryContractVersion = value;
    if ([key isEqualToString:@"aliasContractJson"]) aliasContractJSON = value;
    if ([key isEqualToString:@"aliasContractSha256"]) aliasContractSha256 = value;
    if ([key isEqualToString:@"fingerprint"]) fingerprint = value;
    if ([key isEqualToString:@"catalogSha256"]) catalogSha256 = value;
    if ([key isEqualToString:@"paperCount"]) indexedPaperCount = value.integerValue;
    if ([key isEqualToString:@"claimCount"]) indexedClaimCount = value.integerValue;
  }
  sqlite3_finalize(metadataStatement);
  if (stepStatus != SQLITE_DONE || ![schemaVersion isEqualToString:@"liteverse-search-v2"] ||
      ![queryContractVersion isEqualToString:@"liteverse-query-v1"] ||
      aliasContractJSON.length == 0 || aliasContractSha256.length != 64 ||
      fingerprint.length != 64 || catalogSha256.length != 64 ||
      indexedPaperCount < 0 || indexedClaimCount < 0) {
    NSString *detail = stepStatus == SQLITE_DONE ? @"schema or fingerprint mismatch"
        : ([NSString stringWithUTF8String:sqlite3_errmsg(database)] ?: @"metadata read failed");
    sqlite3_close(database);
    if (error) *error = [self searchIndexErrorWithDetail:detail code:557];
    return nil;
  }
  NSData *aliasData = [aliasContractJSON dataUsingEncoding:NSUTF8StringEncoding];
  NSArray *aliases = aliasData
      ? [NSJSONSerialization JSONObjectWithData:aliasData options:0 error:error] : nil;
  if (![aliases isKindOfClass:NSArray.class] ||
      ![[self sha256ForData:aliasData] isEqualToString:aliasContractSha256]) {
    sqlite3_close(database);
    if (error && !*error) *error = [self searchIndexErrorWithDetail:@"the query-alias contract is corrupted" code:566];
    return nil;
  }
  NSString *expression = [self searchExpressionForQuery:trimmed aliases:aliases error:error];
  if (!expression) {
    sqlite3_close(database);
    return nil;
  }
  NSError *catalogHashError = nil;
  NSString *currentCatalogSha256 = [self cachedSHA256ForFileAtURL:[self papersIndexURL]
                                                             error:&catalogHashError];
  if (currentCatalogSha256.length != 64 ||
      ![currentCatalogSha256 isEqualToString:catalogSha256]) {
    sqlite3_close(database);
    if (error) *error = catalogHashError ?: [self searchIndexErrorWithDetail:@"the index does not match the Knowledge/papers.json revision" code:563];
    return nil;
  }

  sqlite3_stmt *countStatement = NULL;
  if (![self prepareSearchStatement:&countStatement database:database
        sql:"SELECT (SELECT COUNT(*) FROM papers), (SELECT COUNT(*) FROM claims)" error:error]) {
    sqlite3_close(database);
    return nil;
  }
  BOOL countsMatch = sqlite3_step(countStatement) == SQLITE_ROW &&
      sqlite3_column_int64(countStatement, 0) == indexedPaperCount &&
      sqlite3_column_int64(countStatement, 1) == indexedClaimCount;
  sqlite3_finalize(countStatement);
  if (!countsMatch) {
    sqlite3_close(database);
    if (error) *error = [self searchIndexErrorWithDetail:@"indexed paper or claim row counts do not match metadata" code:564];
    return nil;
  }

  sqlite3_stmt *quickCheck = NULL;
  if (![self prepareSearchStatement:&quickCheck database:database sql:"PRAGMA quick_check(1)" error:error]) {
    sqlite3_close(database);
    return nil;
  }
  BOOL databaseHealthy = sqlite3_step(quickCheck) == SQLITE_ROW &&
      [[self sqliteTextFromStatement:quickCheck column:0] isEqualToString:@"ok"];
  sqlite3_finalize(quickCheck);
  if (!databaseHealthy) {
    sqlite3_close(database);
    if (error) *error = [self searchIndexErrorWithDetail:@"SQLite quick_check failed" code:558];
    return nil;
  }

  NSMutableDictionary<NSString *, NSMutableDictionary *> *papersByID = [NSMutableDictionary dictionary];
  NSMutableDictionary<NSString *, NSMutableArray *> *claimsByPaper = [NSMutableDictionary dictionary];
  NSMutableOrderedSet<NSString *> *orderedClaimPaperIDs = [NSMutableOrderedSet orderedSet];
  const char *paperSQL =
      "SELECT p.paper_id, p.title, p.authors, p.tags, p.verification_status, "
      "p.primary_category, p.secondary_category, p.artifact_revision, "
      "p.artifact_sha256, p.card_path, p.card_sha256, p.claims_path, "
      "p.claims_sha256, p.fulltext_path, p.body, "
      "p.legacy_lines_removed, "
      "bm25(paper_fts, 0.0, 8.0, 4.0, 3.0, 1.0, 0.5) AS rank, "
      "snippet(paper_fts, 4, '⟦', '⟧', ' … ', 36) AS snippet "
      "FROM paper_fts JOIN papers p ON p.paper_id = paper_fts.paper_id "
      "WHERE paper_fts MATCH ? ORDER BY rank ASC, p.paper_id ASC LIMIT ?";
  sqlite3_stmt *paperStatement = NULL;
  if (![self prepareSearchStatement:&paperStatement database:database sql:paperSQL error:error]) {
    sqlite3_close(database);
    return nil;
  }
  sqlite3_bind_text(paperStatement, 1, expression.UTF8String, -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(paperStatement, 2, MAX(limit * 3, limit));
  while ((stepStatus = sqlite3_step(paperStatement)) == SQLITE_ROW) {
    NSMutableDictionary *paper = [self indexedPaperFromStatement:paperStatement];
    papersByID[paper[@"paperId"]] = paper;
  }
  sqlite3_finalize(paperStatement);
  if (stepStatus != SQLITE_DONE) {
    NSString *detail = [NSString stringWithUTF8String:sqlite3_errmsg(database)] ?: @"paper query failed";
    sqlite3_close(database);
    if (error) *error = [self searchIndexErrorWithDetail:detail code:559];
    return nil;
  }

  const char *claimSQL =
      "SELECT c.claim_id, c.paper_id, c.type, c.section, c.text, "
      "c.evidence_json, c.verification_status, c.artifact_revision, "
      "c.artifact_sha256, "
      "bm25(claim_fts, 0.0, 0.0, 2.0, 2.0, 7.0, 3.0) AS rank "
      "FROM claim_fts JOIN claims c ON c.claim_id = claim_fts.claim_id "
      "WHERE claim_fts MATCH ? ORDER BY rank ASC, c.claim_id ASC LIMIT ?";
  sqlite3_stmt *claimStatement = NULL;
  if (![self prepareSearchStatement:&claimStatement database:database sql:claimSQL error:error]) {
    sqlite3_close(database);
    return nil;
  }
  sqlite3_bind_text(claimStatement, 1, expression.UTF8String, -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(claimStatement, 2, MAX(limit * 8, 40));
  while ((stepStatus = sqlite3_step(claimStatement)) == SQLITE_ROW) {
    NSDictionary *claim = [self indexedClaimFromStatement:claimStatement error:error];
    if (!claim) {
      sqlite3_finalize(claimStatement);
      sqlite3_close(database);
      return nil;
    }
    NSString *paperID = [self sqliteTextFromStatement:claimStatement column:1];
    [orderedClaimPaperIDs addObject:paperID];
    NSMutableArray *claims = claimsByPaper[paperID] ?: [NSMutableArray array];
    [claims addObject:claim];
    claimsByPaper[paperID] = claims;
  }
  sqlite3_finalize(claimStatement);
  if (stepStatus != SQLITE_DONE) {
    NSString *detail = [NSString stringWithUTF8String:sqlite3_errmsg(database)] ?: @"claim query failed";
    sqlite3_close(database);
    if (error) *error = [self searchIndexErrorWithDetail:detail code:560];
    return nil;
  }

  const char *paperByIDSQL =
      "SELECT paper_id, title, authors, tags, verification_status, "
      "primary_category, secondary_category, artifact_revision, artifact_sha256, "
      "card_path, card_sha256, claims_path, claims_sha256, fulltext_path, body, legacy_lines_removed, "
      "? AS rank, substr(body, 1, 280) AS snippet FROM papers WHERE paper_id=?";
  sqlite3_stmt *paperByIDStatement = NULL;
  if (![self prepareSearchStatement:&paperByIDStatement database:database sql:paperByIDSQL error:error]) {
    sqlite3_close(database);
    return nil;
  }
  if (papersByID.count < (NSUInteger)limit) {
    for (NSString *paperID in orderedClaimPaperIDs) {
      if (papersByID[paperID]) continue;
      sqlite3_reset(paperByIDStatement);
      sqlite3_clear_bindings(paperByIDStatement);
      sqlite3_bind_double(paperByIDStatement, 1, 0.0);
      sqlite3_bind_text(paperByIDStatement, 2, paperID.UTF8String, -1, SQLITE_TRANSIENT);
      int rowStatus = sqlite3_step(paperByIDStatement);
      if (rowStatus == SQLITE_ROW) {
        NSMutableDictionary *paper = [self indexedPaperFromStatement:paperByIDStatement];
        papersByID[paperID] = paper;
      } else if (rowStatus != SQLITE_DONE) {
        NSString *detail = [NSString stringWithUTF8String:sqlite3_errmsg(database)] ?: @"paper lookup failed";
        sqlite3_finalize(paperByIDStatement);
        sqlite3_close(database);
        if (error) *error = [self searchIndexErrorWithDetail:detail code:561];
        return nil;
      }
      if (papersByID.count >= (NSUInteger)(limit * 2)) break;
    }
  }

  NSSet<NSString *> *directPaperIDs = [NSSet setWithArray:papersByID.allKeys];
  NSError *graphError = nil;
  NSDictionary *graph = [self readDictionaryAtURL:[self currentGraphURL] defaultValue:@{} error:&graphError];
  if (!graph) {
    sqlite3_finalize(paperByIDStatement);
    sqlite3_close(database);
    if (error) *error = graphError;
    return nil;
  }
  for (NSDictionary *relation in [graph[@"relations"] isKindOfClass:NSArray.class] ? graph[@"relations"] : @[]) {
    if (![relation isKindOfClass:NSDictionary.class] ||
        ![relation[@"status"] isEqualToString:@"verified"] ||
        ([relation[@"formalEligible"] isKindOfClass:NSNumber.class] && ![relation[@"formalEligible"] boolValue]) ||
        [relation[@"strength"] doubleValue] < 60 || [relation[@"confidence"] doubleValue] < 75) continue;
    NSString *source = [relation[@"source"] isKindOfClass:NSString.class] ? relation[@"source"] : @"";
    NSString *target = [relation[@"target"] isKindOfClass:NSString.class] ? relation[@"target"] : @"";
    NSString *matched = [directPaperIDs containsObject:source] ? source
        : ([directPaperIDs containsObject:target] ? target : nil);
    if (!matched) continue;
    NSString *neighborID = [matched isEqualToString:source] ? target : source;
    NSString *relationID = [relation[@"id"] isKindOfClass:NSString.class] ? relation[@"id"] : @"";
    NSMutableDictionary *neighbor = papersByID[neighborID];
    if (neighbor) {
      if (relationID.length > 0) [neighbor[@"relationExpansion"] addObject:relationID];
      continue;
    }
    if (papersByID.count >= (NSUInteger)MAX(limit * 2, limit + 6)) continue;
    sqlite3_reset(paperByIDStatement);
    sqlite3_clear_bindings(paperByIDStatement);
    sqlite3_bind_double(paperByIDStatement, 1, 10.0);
    sqlite3_bind_text(paperByIDStatement, 2, neighborID.UTF8String, -1, SQLITE_TRANSIENT);
    int rowStatus = sqlite3_step(paperByIDStatement);
    if (rowStatus == SQLITE_ROW) {
      neighbor = [self indexedPaperFromStatement:paperByIDStatement];
      if (relationID.length > 0) [neighbor[@"relationExpansion"] addObject:relationID];
      papersByID[neighborID] = neighbor;
    } else if (rowStatus != SQLITE_DONE) {
      NSString *detail = [NSString stringWithUTF8String:sqlite3_errmsg(database)] ?: @"relation lookup failed";
      sqlite3_finalize(paperByIDStatement);
      sqlite3_close(database);
      if (error) *error = [self searchIndexErrorWithDetail:detail code:562];
      return nil;
    }
  }
  sqlite3_finalize(paperByIDStatement);
  sqlite3_close(database);

  NSMutableArray<NSMutableDictionary *> *ranked = [NSMutableArray arrayWithCapacity:papersByID.count];
  for (NSMutableDictionary *paper in papersByID.allValues) {
    NSArray *claims = claimsByPaper[paper[@"paperId"]] ?: @[];
    paper[@"matchingClaims"] = claims.count > 6
        ? [claims subarrayWithRange:NSMakeRange(0, 6)] : claims;
    NSString *status = paper[@"verificationStatus"];
    if ([status isEqualToString:@"evidence_verified"] || [status isEqualToString:@"needs_attention"]) {
      [ranked addObject:paper];
    }
  }
  [ranked sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
    double leftClaimRank = [left[@"matchingClaims"] firstObject]
        ? [[[left[@"matchingClaims"] firstObject] objectForKey:@"rank"] doubleValue] : 0;
    double rightClaimRank = [right[@"matchingClaims"] firstObject]
        ? [[[right[@"matchingClaims"] firstObject] objectForKey:@"rank"] doubleValue] : 0;
    double leftScore = [left[@"rank"] doubleValue] + leftClaimRank;
    double rightScore = [right[@"rank"] doubleValue] + rightClaimRank;
    if (leftScore < rightScore) return NSOrderedAscending;
    if (leftScore > rightScore) return NSOrderedDescending;
    return [left[@"paperId"] compare:right[@"paperId"]];
  }];
  NSUInteger resultCount = MIN((NSUInteger)limit, ranked.count);
  NSArray *results = [ranked subarrayWithRange:NSMakeRange(0, resultCount)];
  for (NSMutableDictionary *paper in results) {
    NSArray<NSArray<NSString *> *> *artifactChecks = @[
      @[paper[@"_cardPath"] ?: @"", paper[@"_cardSha256"] ?: @"", @"knowledge card"],
      @[paper[@"_claimsPath"] ?: @"", paper[@"_claimsSha256"] ?: @"", @"claims"]
    ];
    for (NSArray<NSString *> *check in artifactChecks) {
      NSError *artifactError = nil;
      NSURL *artifactURL = [self URLForWorkspaceRelativePath:check[0] error:&artifactError];
      NSString *actualHash = artifactURL
          ? [self cachedSHA256ForFileAtURL:artifactURL error:&artifactError] : nil;
      if (actualHash.length != 64 || check[1].length != 64 ||
          ![actualHash isEqualToString:check[1].lowercaseString]) {
        if (error) {
          NSString *detail = artifactError.localizedDescription ?: [NSString stringWithFormat:
              @"%@ has a mismatched %@ artifact hash", paper[@"paperId"], check[2]];
          *error = [self searchIndexErrorWithDetail:detail code:565];
        }
        return nil;
      }
    }
    [paper removeObjectsForKeys:@[@"_cardPath", @"_cardSha256", @"_claimsPath", @"_claimsSha256"]];
  }
  return @{
    @"schemaVersion": @"liteverse-search-result-v1",
    @"query": trimmed,
    @"indexFingerprint": fingerprint,
    @"indexRebuilt": @NO,
    @"count": @(resultCount),
    @"results": results
  };
}

- (NSDictionary *)validatedPartitionProposalsAtURL:(NSURL *)url error:(NSError **)error {
  NSDictionary *proposal = [self readDictionaryAtURL:url defaultValue:nil error:error];
  if (!proposal) return nil;
  NSString *schemaVersion = [proposal[@"schemaVersion"] isKindOfClass:NSString.class]
      ? proposal[@"schemaVersion"] : nil;
  NSString *proposalSetID = [proposal[@"proposalSetId"] isKindOfClass:NSString.class]
      ? proposal[@"proposalSetId"] : nil;
  NSString *status = [proposal[@"status"] isKindOfClass:NSString.class]
      ? proposal[@"status"] : nil;
  NSString *artifactFingerprint = [proposal[@"artifactFingerprint"] isKindOfClass:NSString.class]
      ? [proposal[@"artifactFingerprint"] lowercaseString] : nil;
  NSString *searchSummary = [proposal[@"searchSummary"] isKindOfClass:NSString.class]
      ? proposal[@"searchSummary"] : nil;
  NSString *truthPath = [proposal[@"truthPath"] isKindOfClass:NSString.class]
      ? proposal[@"truthPath"] : nil;
  NSString *truthSHA256 = [proposal[@"truthSha256"] isKindOfClass:NSString.class]
      ? [proposal[@"truthSha256"] lowercaseString] : nil;
  id baseRevision = proposal[@"baseRevision"];
  NSArray *options = [proposal[@"options"] isKindOfClass:NSArray.class]
      ? proposal[@"options"] : nil;
  NSCharacterSet *hexCharacters = [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
  BOOL validArtifactFingerprint = artifactFingerprint.length == 64 &&
      [artifactFingerprint rangeOfCharacterFromSet:hexCharacters.invertedSet].location == NSNotFound;
  BOOL validTruthSHA256 = truthSHA256.length == 64 &&
      [truthSHA256 rangeOfCharacterFromSet:hexCharacters.invertedSet].location == NSNotFound;
  BOOL awaitingUser = [status isEqualToString:@"awaiting_user"];
  BOOL selected = [status isEqualToString:@"selected"];
  if (![schemaVersion isEqualToString:@"liteverse-partition-proposals-v1"] ||
      proposalSetID.length == 0 ||
      (!awaitingUser && !selected) ||
      !validArtifactFingerprint || searchSummary.length == 0 ||
      ![truthPath hasPrefix:@"Planning/partition-proposals/"] ||
      ![truthPath.pathExtension.lowercaseString isEqualToString:@"json"] ||
      ![self isSafeWorkspaceRelativePath:truthPath] || !validTruthSHA256 ||
      !([baseRevision isKindOfClass:NSNumber.class] ||
        ([baseRevision isKindOfClass:NSString.class] && [baseRevision length] > 0)) ||
      options.count != 3) {
    if (error) *error = [self storageError:
        @"Graph/partition-proposals.json is invalid: it must use the v1 schema, a supported lifecycle state, and exactly three options."
                                        code:570];
    return nil;
  }

  NSMutableSet<NSString *> *optionIDs = [NSMutableSet setWithCapacity:3];
  for (id rawOption in options) {
    if (![rawOption isKindOfClass:NSDictionary.class]) {
      if (error) *error = [self storageError:@"A partition-option record is not an object." code:571];
      return nil;
    }
    NSDictionary *option = rawOption;
    NSString *optionID = [option[@"optionId"] isKindOfClass:NSString.class]
        ? option[@"optionId"] : nil;
    NSString *name = [option[@"name"] isKindOfClass:NSString.class] ? option[@"name"] : nil;
    NSString *summary = [option[@"summary"] isKindOfClass:NSString.class] ? option[@"summary"] : nil;
    NSDictionary *tradeoffs = [option[@"tradeoffs"] isKindOfClass:NSDictionary.class]
        ? option[@"tradeoffs"] : nil;
    NSArray *strengths = [tradeoffs[@"strengths"] isKindOfClass:NSArray.class]
        ? tradeoffs[@"strengths"] : nil;
    NSArray *limitations = [tradeoffs[@"limitations"] isKindOfClass:NSArray.class]
        ? tradeoffs[@"limitations"] : nil;
    NSArray *regions = [option[@"regions"] isKindOfClass:NSArray.class]
        ? option[@"regions"] : nil;
    NSArray *assignments = [option[@"assignments"] isKindOfClass:NSArray.class]
        ? option[@"assignments"] : nil;
    NSDictionary *metrics = [option[@"metrics"] isKindOfClass:NSDictionary.class]
        ? option[@"metrics"] : nil;
    if (optionID.length == 0 || name.length == 0 || !summary ||
        [optionIDs containsObject:optionID] || !tradeoffs || !strengths || !limitations ||
        regions.count == 0 || regions.count > 10 || !assignments || !metrics) {
      if (error) *error = [self storageError:
          @"A partition option has missing fields, a duplicate optionId, or a region count outside 1-10."
                                          code:572];
      return nil;
    }
    [optionIDs addObject:optionID];
    for (id value in strengths) {
      if (![value isKindOfClass:NSString.class]) {
        if (error) *error = [self storageError:@"Partition-option strengths must be an array of strings." code:573];
        return nil;
      }
    }
    for (id value in limitations) {
      if (![value isKindOfClass:NSString.class]) {
        if (error) *error = [self storageError:@"Partition-option limitations must be an array of strings." code:574];
        return nil;
      }
    }
    NSNumber *metricRegionCount = [metrics[@"regionCount"] isKindOfClass:NSNumber.class]
        ? metrics[@"regionCount"] : nil;
    NSNumber *metricPaperCount = [metrics[@"paperCount"] isKindOfClass:NSNumber.class]
        ? metrics[@"paperCount"] : nil;
    if (!metricRegionCount || metricRegionCount.integerValue != (NSInteger)regions.count ||
        !metricPaperCount || metricPaperCount.integerValue < 0 ||
        metricPaperCount.integerValue != (NSInteger)assignments.count) {
      if (error) *error = [self storageError:
          @"Partition-option metrics regionCount/paperCount do not match regions/assignments."
                                          code:575];
      return nil;
    }
    NSMutableSet<NSString *> *regionIDs = [NSMutableSet setWithCapacity:regions.count];
    NSUInteger summedPaperCount = 0;
    for (id rawRegion in regions) {
      NSDictionary *region = [rawRegion isKindOfClass:NSDictionary.class] ? rawRegion : nil;
      NSString *regionID = [region[@"id"] isKindOfClass:NSString.class]
          ? region[@"id"] : ([region[@"regionId"] isKindOfClass:NSString.class] ? region[@"regionId"] : nil);
      NSString *regionName = [region[@"name"] isKindOfClass:NSString.class] ? region[@"name"] : nil;
      NSNumber *paperCount = [region[@"paperCount"] isKindOfClass:NSNumber.class]
          ? region[@"paperCount"] : nil;
      if (!region || regionID.length == 0 || regionName.length == 0 ||
          [regionIDs containsObject:regionID] || !paperCount || paperCount.integerValue < 0 ||
          paperCount.doubleValue != paperCount.integerValue) {
        if (error) *error = [self storageError:
            @"Every region must have a unique id, a non-empty name, and a non-negative integer paperCount." code:576];
        return nil;
      }
      [regionIDs addObject:regionID];
      summedPaperCount += paperCount.unsignedIntegerValue;
    }
    NSMutableSet<NSString *> *assignedPaperIDs = [NSMutableSet setWithCapacity:assignments.count];
    for (id rawAssignment in assignments) {
      NSDictionary *assignment = [rawAssignment isKindOfClass:NSDictionary.class] ? rawAssignment : nil;
      NSString *paperID = [assignment[@"paperId"] isKindOfClass:NSString.class]
          ? assignment[@"paperId"] : nil;
      NSString *primaryRegionID = [assignment[@"primaryCategory"] isKindOfClass:NSString.class]
          ? assignment[@"primaryCategory"]
          : ([assignment[@"regionId"] isKindOfClass:NSString.class]
              ? assignment[@"regionId"] : assignment[@"categoryId"]);
      if (!assignment || paperID.length == 0 || [assignedPaperIDs containsObject:paperID] ||
          ![primaryRegionID isKindOfClass:NSString.class] ||
          ![regionIDs containsObject:primaryRegionID]) {
        if (error) *error = [self storageError:
            @"Region assignments must cover papers without duplicates and reference regions in the same option." code:577];
        return nil;
      }
      [assignedPaperIDs addObject:paperID];
    }
    if (summedPaperCount != metricPaperCount.unsignedIntegerValue ||
        assignedPaperIDs.count != metricPaperCount.unsignedIntegerValue) {
      if (error) *error = [self storageError:
          @"The region paperCount total or assignment coverage does not match metrics.paperCount." code:578];
      return nil;
    }
  }
  if (selected) {
    NSString *selectedOptionID = [proposal[@"selectedOptionId"] isKindOfClass:NSString.class]
        ? proposal[@"selectedOptionId"] : nil;
    NSString *decisionID = [proposal[@"decisionId"] isKindOfClass:NSString.class]
        ? proposal[@"decisionId"] : nil;
    NSString *decisionRecordPath = [proposal[@"decisionRecordPath"] isKindOfClass:NSString.class]
        ? proposal[@"decisionRecordPath"] : nil;
    NSString *decisionRecordSHA256 = [proposal[@"decisionRecordSha256"] isKindOfClass:NSString.class]
        ? [proposal[@"decisionRecordSha256"] lowercaseString] : nil;
    NSString *selectedSnapshotPath = [proposal[@"selectedSnapshotPath"] isKindOfClass:NSString.class]
        ? proposal[@"selectedSnapshotPath"] : nil;
    NSString *selectedSnapshotSHA256 = [proposal[@"selectedSnapshotSha256"] isKindOfClass:NSString.class]
        ? [proposal[@"selectedSnapshotSha256"] lowercaseString] : nil;
    BOOL validDecisionHash = decisionRecordSHA256.length == 64 &&
        [decisionRecordSHA256 rangeOfCharacterFromSet:hexCharacters.invertedSet].location == NSNotFound;
    BOOL validSnapshotHash = selectedSnapshotSHA256.length == 64 &&
        [selectedSnapshotSHA256 rangeOfCharacterFromSet:hexCharacters.invertedSet].location == NSNotFound;
    if (![optionIDs containsObject:selectedOptionID] || decisionID.length == 0 ||
        ![decisionRecordPath isEqualToString:@"Planning/partition-decisions.jsonl"] ||
        !validDecisionHash ||
        ![selectedSnapshotPath hasPrefix:@"Planning/partition-snapshots/"] ||
        ![selectedSnapshotPath.pathExtension.lowercaseString isEqualToString:@"json"] ||
        ![self isSafeWorkspaceRelativePath:selectedSnapshotPath] || !validSnapshotHash) {
      if (error) *error = [self storageError:
          @"The selected partition option is missing a valid selection, decision ledger, or selected-snapshot pointer." code:579];
      return nil;
    }
  }
  return proposal;
}

- (BOOL)partitionProposals:(NSDictionary *)proposal
        closeTruthUnderRoot:(NSURL *)rootURL
                      error:(NSError **)error {
  NSString *truthPath = [proposal[@"truthPath"] isKindOfClass:NSString.class]
      ? proposal[@"truthPath"] : nil;
  NSString *expectedSHA256 = [proposal[@"truthSha256"] isKindOfClass:NSString.class]
      ? [proposal[@"truthSha256"] lowercaseString] : nil;
  if (![self isSafeWorkspaceRelativePath:truthPath] ||
      ![truthPath hasPrefix:@"Planning/partition-proposals/"] || expectedSHA256.length != 64) {
    if (error) *error = [self storageError:@"The partition option has an invalid Planning truth pointer." code:581];
    return NO;
  }
  NSURL *root = rootURL.URLByStandardizingPath.URLByResolvingSymlinksInPath;
  NSURL *truthURL = [root URLByAppendingPathComponent:truthPath]
      .URLByStandardizingPath.URLByResolvingSymlinksInPath;
  NSString *rootPrefix = [root.path stringByAppendingString:@"/"];
  NSNumber *isRegular = nil;
  NSNumber *isSymbolicLink = nil;
  if (![truthURL.path hasPrefix:rootPrefix] ||
      ![truthURL getResourceValue:&isRegular forKey:NSURLIsRegularFileKey error:error] ||
      ![truthURL getResourceValue:&isSymbolicLink forKey:NSURLIsSymbolicLinkKey error:error] ||
      !isRegular.boolValue || isSymbolicLink.boolValue) {
    if (error && !*error) *error = [self storageError:
        @"The referenced Planning truth is missing, out of bounds, or not a regular file." code:582];
    return NO;
  }
  NSString *actualSHA256 = [self sha256ForFileAtURL:truthURL error:error];
  if (![actualSHA256 isEqualToString:expectedSHA256]) {
    if (error) *error = [self storageError:
        @"The partition projection does not match the Planning truth hash and cannot be displayed." code:583];
    return NO;
  }
  if (![proposal[@"status"] isEqualToString:@"selected"]) return YES;

  NSString *selectedOptionID = proposal[@"selectedOptionId"];
  NSString *decisionID = proposal[@"decisionId"];
  NSString *decisionRecordPath = proposal[@"decisionRecordPath"];
  NSString *decisionRecordSHA256 = [proposal[@"decisionRecordSha256"] lowercaseString];
  NSString *selectedSnapshotPath = proposal[@"selectedSnapshotPath"];
  NSString *selectedSnapshotSHA256 = [proposal[@"selectedSnapshotSha256"] lowercaseString];

  NSURL *decisionURL = [root URLByAppendingPathComponent:decisionRecordPath]
      .URLByStandardizingPath.URLByResolvingSymlinksInPath;
  NSNumber *decisionIsRegular = nil;
  NSNumber *decisionIsSymbolicLink = nil;
  if (![decisionURL.path hasPrefix:rootPrefix] ||
      ![decisionURL getResourceValue:&decisionIsRegular forKey:NSURLIsRegularFileKey error:error] ||
      ![decisionURL getResourceValue:&decisionIsSymbolicLink forKey:NSURLIsSymbolicLinkKey error:error] ||
      !decisionIsRegular.boolValue || decisionIsSymbolicLink.boolValue) {
    if (error && !*error) *error = [self storageError:
        @"The selected partition decision ledger is missing, out of bounds, or not a regular file." code:585];
    return NO;
  }
  NSString *ledgerText = [NSString stringWithContentsOfURL:decisionURL
                                                   encoding:NSUTF8StringEncoding
                                                      error:error];
  if (!ledgerText) return NO;
  NSUInteger matchingDecisionCount = 0;
  BOOL matchingDecisionValid = NO;
  for (NSString *line in [ledgerText componentsSeparatedByString:@"\n"]) {
    if (line.length == 0) continue;
    NSData *lineData = [line dataUsingEncoding:NSUTF8StringEncoding];
    id rawRecord = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:error];
    if (![rawRecord isKindOfClass:NSDictionary.class]) {
      if (error && !*error) *error = [self storageError:
          @"Planning/partition-decisions.jsonl contains a corrupted record." code:586];
      return NO;
    }
    NSDictionary *record = rawRecord;
    if (![record[@"decisionId"] isEqualToString:decisionID]) continue;
    matchingDecisionCount += 1;
    NSMutableData *hashedLine = [lineData mutableCopy];
    [hashedLine appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    matchingDecisionValid = [[self sha256ForData:hashedLine] isEqualToString:decisionRecordSHA256] &&
        [record[@"proposalSetId"] isEqualToString:proposal[@"proposalSetId"]] &&
        [record[@"optionId"] isEqualToString:selectedOptionID] &&
        [self revision:record[@"baseRevision"] matches:proposal[@"baseRevision"]] &&
        [record[@"proposalTruthPath"] isEqualToString:truthPath] &&
        [record[@"proposalSha256"] isEqualToString:expectedSHA256];
  }
  if (matchingDecisionCount != 1 || !matchingDecisionValid) {
    if (error) *error = [self storageError:
        @"The selected partition decision record is missing, duplicated, hash-mismatched, or pointer-inconsistent." code:587];
    return NO;
  }

  NSURL *snapshotURL = [root URLByAppendingPathComponent:selectedSnapshotPath]
      .URLByStandardizingPath.URLByResolvingSymlinksInPath;
  NSNumber *snapshotIsRegular = nil;
  NSNumber *snapshotIsSymbolicLink = nil;
  if (![snapshotURL.path hasPrefix:rootPrefix] ||
      ![snapshotURL getResourceValue:&snapshotIsRegular forKey:NSURLIsRegularFileKey error:error] ||
      ![snapshotURL getResourceValue:&snapshotIsSymbolicLink forKey:NSURLIsSymbolicLinkKey error:error] ||
      !snapshotIsRegular.boolValue || snapshotIsSymbolicLink.boolValue) {
    if (error && !*error) *error = [self storageError:
        @"The selected partition snapshot is missing, out of bounds, or not a regular file." code:588];
    return NO;
  }
  NSData *snapshotData = [NSData dataWithContentsOfURL:snapshotURL options:0 error:error];
  if (!snapshotData) return NO;
  if (![[self sha256ForData:snapshotData] isEqualToString:selectedSnapshotSHA256]) {
    if (error) *error = [self storageError:@"The selected partition snapshot hash does not match." code:589];
    return NO;
  }
  id rawSnapshot = [NSJSONSerialization JSONObjectWithData:snapshotData options:0 error:error];
  NSDictionary *snapshot = [rawSnapshot isKindOfClass:NSDictionary.class] ? rawSnapshot : nil;
  NSDictionary *snapshotDecision = [snapshot[@"partitionDecision"] isKindOfClass:NSDictionary.class]
      ? snapshot[@"partitionDecision"] : nil;
  if (!snapshot || !snapshotDecision ||
      ![snapshotDecision[@"decisionId"] isEqualToString:decisionID] ||
      ![snapshotDecision[@"proposalSetId"] isEqualToString:proposal[@"proposalSetId"]] ||
      ![snapshotDecision[@"optionId"] isEqualToString:selectedOptionID] ||
      ![self revision:snapshotDecision[@"baseRevision"] matches:proposal[@"baseRevision"]] ||
      ![snapshotDecision[@"decisionRecordPath"] isEqualToString:decisionRecordPath] ||
      ![snapshotDecision[@"recordSha256"] isEqualToString:decisionRecordSHA256]) {
    if (error && !*error) *error = [self storageError:
        @"Decision pointers in the selected partition snapshot are incomplete or inconsistent." code:590];
    return NO;
  }
  return YES;
}

- (void)sendWorkspaceWithNotice:(NSString *)notice {
  NSError *error = nil;
  if (![self ensureRuntimeGraphStorage:&error]) {
    [self sendWorkspaceErrorForAction:@"loadWorkspace" error:error];
    return;
  }
  NSDictionary *library = [self readDictionaryAtURL:[self libraryURL]
                                       defaultValue:[self defaultLibrary]
                                              error:&error];
  if (!library) {
    [self sendWorkspaceErrorForAction:@"loadWorkspace" error:error];
    return;
  }
  NSDictionary *registry = [self readDictionaryAtURL:[self projectsRegistryURL]
                                      defaultValue:nil error:&error];
  NSString *activeProjectID = registry ? [self activeProjectIDFromRegistry:registry] : nil;
  if (!registry || !activeProjectID) {
    [self sendWorkspaceErrorForAction:@"loadWorkspace" error:error ?: [self storageError:@"The project registry is invalid." code:539]];
    return;
  }
  NSURL *projectResearchURL = [self projectResearchInformationURLForID:activeProjectID error:&error];
  NSDictionary *research = [self readDictionaryAtURL:projectResearchURL
                                        defaultValue:[self defaultResearchInformation]
                                               error:&error];
  if (!research) {
    [self sendWorkspaceErrorForAction:@"loadWorkspace" error:error];
    return;
  }
  NSDictionary *workspace = [self readDictionaryAtURL:[self workspaceMetadataURL]
                                          defaultValue:[self defaultWorkspaceMetadata]
                                                 error:&error];
  if (!workspace) {
    [self sendWorkspaceErrorForAction:@"loadWorkspace" error:error];
    return;
  }
  NSDictionary *projectData = [self projectDataForID:activeProjectID registry:registry error:&error];
  if (!projectData) {
    [self sendWorkspaceErrorForAction:@"loadWorkspace" error:error];
    return;
  }
  id partitionProposals = NSNull.null;
  NSURL *partitionProposalsURL = [self partitionProposalsURL];
  if ([NSFileManager.defaultManager fileExistsAtPath:partitionProposalsURL.path]) {
    NSDictionary *validatedProposals = [self validatedPartitionProposalsAtURL:partitionProposalsURL
                                                                         error:&error];
    if (!validatedProposals) {
      // Fail closed: retain the frontend's last known-good workspace payload
      // and surface the corruption instead of replacing it with an empty set.
      [self sendWorkspaceErrorForAction:@"loadPartitionProposals" error:error];
      return;
    }
    if (![self partitionProposals:validatedProposals
              closeTruthUnderRoot:[self applicationSupportURL]
                            error:&error]) {
      [self sendWorkspaceErrorForAction:@"loadPartitionProposals" error:error];
      return;
    }
    // A selected projection remains on disk as auditable lifecycle state, but
    // it is not a pending user decision and must not produce a Settings badge.
    if ([validatedProposals[@"status"] isEqualToString:@"awaiting_user"]) {
      partitionProposals = validatedProposals;
    }
  }
  NSDictionary *health = [self workspaceHealthWithLibrary:library error:&error];
  if (!health) {
    [self sendWorkspaceErrorForAction:@"loadWorkspaceHealth" error:error];
    return;
  }
  NSMutableDictionary *payload = [@{
    @"library": library,
    @"researchInformation": research,
    @"projects": [self projectsPayloadFromRegistry:registry],
    @"projectMemory": projectData[@"projectMemory"],
    @"tasks": projectData[@"tasks"],
    @"contextPacks": projectData[@"contextPacks"],
    @"artifacts": projectData[@"artifacts"],
    // Search is demand-driven through the shared SQLite FTS5 index. Do not
    // deserialize thousands of claims into every workspace payload.
    @"searchProjection": @[],
    @"projectUseCounts": projectData[@"projectUseCounts"],
    @"partitionProposals": partitionProposals,
    @"workspace": workspace,
    @"health": health
  } mutableCopy];
  if (notice.length > 0) payload[@"notice"] = notice;
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.webView callAsyncJavaScript:
        @"window.__liteverseReceiveWorkspace && window.__liteverseReceiveWorkspace(workspacePayload);"
                              arguments:@{ @"workspacePayload": payload }
                                inFrame:nil
                         inContentWorld:WKContentWorld.pageWorld
                      completionHandler:nil];
  });
}

- (void)sendWorkspaceHealth {
  NSError *error = nil;
  if (![self ensureRuntimeGraphStorage:&error]) {
    [self sendWorkspaceErrorForAction:@"loadWorkspaceHealth" error:error];
    return;
  }
  NSDictionary *library = [self readDictionaryAtURL:[self libraryURL]
                                       defaultValue:[self defaultLibrary]
                                              error:&error];
  NSDictionary *health = library ? [self workspaceHealthWithLibrary:library error:&error] : nil;
  if (!health) {
    [self sendWorkspaceErrorForAction:@"loadWorkspaceHealth" error:error];
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.webView callAsyncJavaScript:
        @"window.__liteverseReceiveWorkspaceHealth && window.__liteverseReceiveWorkspaceHealth(healthPayload);"
                              arguments:@{ @"healthPayload": health }
                                inFrame:nil
                         inContentWorld:WKContentWorld.pageWorld
                      completionHandler:nil];
  });
}

- (void)writeMarkdownMirrorForPaper:(NSString *)paperID annotations:(NSArray *)annotations {
  NSURL *directory = [[self applicationSupportURL] URLByAppendingPathComponent:@"user-notes" isDirectory:YES];
  [[NSFileManager defaultManager] createDirectoryAtURL:directory
                           withIntermediateDirectories:YES
                                            attributes:nil
                                                 error:nil];
  NSString *paperTitle = paperID;
  for (NSDictionary *annotation in annotations) {
    if ([annotation[@"paperId"] isEqualToString:paperID] &&
        [annotation[@"paperTitle"] isKindOfClass:NSString.class] &&
        [annotation[@"paperTitle"] length] > 0) {
      paperTitle = annotation[@"paperTitle"];
      break;
    }
  }
  NSMutableString *markdown = [NSMutableString stringWithFormat:
      @"# User annotations: %@\n\n"
       "> Raw notes written in Liteverse. Codex may reorganize them, but must preserve this source record and verification status.\n\n",
      paperTitle];
  for (NSDictionary *annotation in annotations) {
    if (![annotation[@"paperId"] isEqualToString:paperID]) continue;
    [markdown appendFormat:
        @"## %@\n\n- Status: `%@`\n- Revision: `%@`\n- Updated: `%@`\n\n%@\n\n",
        annotation[@"id"] ?: @"annotation",
        annotation[@"status"] ?: @"pending",
        annotation[@"revision"] ?: @1,
        annotation[@"updatedAt"] ?: @"",
        annotation[@"text"] ?: @""];
  }
  NSURL *output = [directory URLByAppendingPathComponent:
      [NSString stringWithFormat:@"%@.md", paperID]];
  [markdown writeToURL:output atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

- (void)saveAnnotation:(NSDictionary *)rawAnnotation {
  NSString *annotationID = rawAnnotation[@"id"];
  NSString *paperID = rawAnnotation[@"paperId"];
  NSString *text = rawAnnotation[@"text"];
  if (annotationID.length == 0 || paperID.length == 0 || text.length == 0) return;

  NSError *readError = nil;
  NSArray *storedAnnotations = [self readAnnotationsWithError:&readError];
  if (!storedAnnotations) {
    [self sendWorkspaceErrorForAction:@"saveAnnotation" error:readError];
    return;
  }
  NSMutableArray *annotations = [storedAnnotations mutableCopy];
  NSMutableDictionary *annotation = [rawAnnotation mutableCopy];
  annotation[@"status"] = @"pending";
  [annotation removeObjectForKey:@"organizedAt"];
  BOOL updated = NO;
  for (NSUInteger index = 0; index < annotations.count; index += 1) {
    NSDictionary *current = annotations[index];
    if ([current[@"id"] isEqualToString:annotationID]) {
      NSInteger expectedRevision = [current[@"revision"] integerValue] + 1;
      NSInteger requestedRevision = [annotation[@"revision"] integerValue];
      if (requestedRevision != expectedRevision) {
        [self sendWorkspaceErrorForAction:@"saveAnnotation"
                                    error:[self storageError:
            [NSString stringWithFormat:@"Annotation %@ changed revision; reopen it before saving.", annotationID]
                                                          code:421]];
        return;
      }
      annotations[index] = annotation;
      updated = YES;
      break;
    }
  }
  if (!updated) {
    NSInteger requestedRevision = [annotation[@"revision"] integerValue];
    if (requestedRevision != 1) {
      [self sendWorkspaceErrorForAction:@"saveAnnotation"
                                  error:[self storageError:@"A new annotation revision must begin at 1." code:422]];
      return;
    }
    [annotations addObject:annotation];
  }

  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:annotations
                                                  options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys
                                                    error:&error];
  if (error || ![data writeToURL:[self annotationsURL] options:NSDataWritingAtomic error:&error]) {
    [self sendWorkspaceErrorForAction:@"saveAnnotation" error:error];
    return;
  }

  NSDictionary *event = @{
    @"eventId": NSUUID.UUID.UUIDString,
    @"action": updated ? @"annotation_updated" : @"annotation_created",
    @"timestamp": annotation[@"updatedAt"] ?: @"",
    @"annotation": annotation
  };
  [self appendJSONObject:event
                    toURL:[[self applicationSupportURL] URLByAppendingPathComponent:@"codex-inbox.jsonl"]];
  [self writeMarkdownMirrorForPaper:paperID annotations:annotations];
  [self sendAnnotations:annotations savedID:annotationID];
}

- (NSString *)normalizedArxivIDFromValue:(NSString *)rawValue {
  if (![rawValue isKindOfClass:NSString.class]) return nil;
  NSString *candidate = [rawValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSURLComponents *components = [NSURLComponents componentsWithString:candidate];
  if (components.host.length > 0) {
    NSString *host = components.host.lowercaseString;
    if (![host isEqualToString:@"arxiv.org"] && ![host isEqualToString:@"www.arxiv.org"]) return nil;
    NSString *path = components.path ?: @"";
    if ([path hasPrefix:@"/abs/"]) path = [path substringFromIndex:5];
    else if ([path hasPrefix:@"/pdf/"]) path = [path substringFromIndex:5];
    else return nil;
    candidate = path;
  }
  if ([candidate hasPrefix:@"/"]) candidate = [candidate substringFromIndex:1];
  if ([candidate.lowercaseString hasSuffix:@".pdf"]) candidate = [candidate substringToIndex:candidate.length - 4];
  candidate = [candidate stringByRemovingPercentEncoding] ?: candidate;
  NSString *pattern = @"^(?:[0-9]{4}\\.[0-9]{4,5}|[A-Za-z.-]+/[0-9]{7})(?:v[0-9]+)?$";
  NSRegularExpression *expression = [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
  NSRange fullRange = NSMakeRange(0, candidate.length);
  return [expression firstMatchInString:candidate options:0 range:fullRange] ? candidate : nil;
}

- (void)saveArxivValue:(NSString *)rawValue {
  dispatch_async(_persistenceQueue, ^{
    NSString *arxivID = [self normalizedArxivIDFromValue:rawValue];
    if (arxivID.length == 0) {
      [self sendWorkspaceErrorForAction:@"saveArxiv"
                                  error:[self storageError:@"Enter a valid arXiv ID or arxiv.org link." code:201]];
      return;
    }
    NSError *error = nil;
    NSDictionary *storedLibrary = [self readDictionaryAtURL:[self libraryURL]
                                                defaultValue:[self defaultLibrary]
                                                       error:&error];
    if (!storedLibrary) {
      [self sendWorkspaceErrorForAction:@"saveArxiv" error:error];
      return;
    }
    NSMutableDictionary *library = [storedLibrary mutableCopy];
    NSMutableArray *items = [library[@"items"] isKindOfClass:NSArray.class]
        ? [library[@"items"] mutableCopy] : [NSMutableArray array];
    for (NSDictionary *item in items) {
      if ([item[@"arxivId"] isEqualToString:arxivID]) {
        [self sendWorkspaceWithNotice:[NSString stringWithFormat:@"%@ is already in the literature library.", item[@"displayTitle"] ?: arxivID]];
        return;
      }
    }
    NSInteger number = MAX(1, [library[@"nextNumber"] integerValue]);
    NSString *timestamp = [self isoTimestamp];
    NSString *itemID = [NSString stringWithFormat:@"lit-%@", NSUUID.UUID.UUIDString.lowercaseString];
    NSString *arxivURL = [NSString stringWithFormat:@"https://arxiv.org/abs/%@", arxivID];
    NSDictionary *item = @{
      @"id": itemID,
      @"number": @(number),
      @"sourceType": @"arxiv",
      @"displayTitle": [NSString stringWithFormat:@"arXiv %@ (title pending retrieval)", arxivID],
      @"titleStatus": @"pending",
      @"arxivId": arxivID,
      @"arxivUrl": arxivURL,
      @"status": @"pending_codex",
      @"revision": @1,
      @"createdAt": timestamp,
      @"updatedAt": timestamp
    };
    [items addObject:item];
    library[@"items"] = items;
    library[@"nextNumber"] = @(number + 1);
    library[@"schemaVersion"] = @1;
    if (![self writeJSONObject:library toURL:[self libraryURL] error:&error]) {
      [self sendWorkspaceErrorForAction:@"saveArxiv" error:error];
      return;
    }
    [self appendJSONObject:@{
      @"eventId": NSUUID.UUID.UUIDString,
      @"action": @"literature_arxiv_added",
      @"timestamp": timestamp,
      @"item": item
    } toURL:[self workspaceInboxURL]];
    [self sendWorkspaceWithNotice:@"The arXiv link was saved locally and is ready for the next Codex curation run."];
  });
}

- (void)importPDFURLs:(NSArray<NSURL *> *)sourceURLs {
  NSError *error = nil;
  NSDictionary *storedLibrary = [self readDictionaryAtURL:[self libraryURL]
                                              defaultValue:[self defaultLibrary]
                                                     error:&error];
  if (!storedLibrary) {
    [self sendWorkspaceErrorForAction:@"pickLiteraturePDF" error:error];
    return;
  }
  NSMutableDictionary *library = [storedLibrary mutableCopy];
  NSMutableArray *items = [library[@"items"] isKindOfClass:NSArray.class]
      ? [library[@"items"] mutableCopy] : [NSMutableArray array];
  NSInteger nextNumber = MAX(1, [library[@"nextNumber"] integerValue]);
  NSMutableArray<NSURL *> *createdFiles = [NSMutableArray array];
  NSMutableArray<NSDictionary *> *createdItems = [NSMutableArray array];
  NSURL *pdfDirectory = [self pdfDirectoryURL];

  for (NSURL *sourceURL in sourceURLs) {
    if (![sourceURL.pathExtension.lowercaseString isEqualToString:@"pdf"]) continue;
    BOOL scopedAccess = [sourceURL startAccessingSecurityScopedResource];
    NSString *sourceHash = [self sha256ForFileAtURL:sourceURL error:&error];
    if (scopedAccess) [sourceURL stopAccessingSecurityScopedResource];
    if (sourceHash.length != 64) {
      for (NSURL *createdURL in createdFiles) {
        [NSFileManager.defaultManager removeItemAtURL:createdURL error:nil];
      }
      [self sendWorkspaceErrorForAction:@"pickLiteraturePDF" error:error];
      return;
    }
    BOOL duplicate = NO;
    for (NSDictionary *existingItem in items) {
      NSDictionary *existingSource = [existingItem[@"source"] isKindOfClass:NSDictionary.class]
          ? existingItem[@"source"] : @{};
      NSString *existingHash = [existingSource[@"sha256"] isKindOfClass:NSString.class]
          ? existingSource[@"sha256"] : existingItem[@"sha256"];
      if ([existingHash isEqualToString:sourceHash]) {
        duplicate = YES;
        break;
      }
    }
    if (duplicate) continue;

    NSString *itemID = [NSString stringWithFormat:@"lit-%@", NSUUID.UUID.UUIDString.lowercaseString];
    NSString *managedHash = nil;
    if (scopedAccess) [sourceURL startAccessingSecurityScopedResource];
    NSString *relativePath = [self managedPDFRelativePathForSourceURL:sourceURL
                                                              paperID:itemID
                                                               sha256:&managedHash
                                                                error:&error];
    if (scopedAccess) [sourceURL stopAccessingSecurityScopedResource];
    if (!relativePath) {
      for (NSURL *createdURL in createdFiles) {
        [NSFileManager.defaultManager removeItemAtURL:createdURL error:nil];
      }
      [self sendWorkspaceErrorForAction:@"pickLiteraturePDF" error:error];
      return;
    }
    NSString *storedFilename = relativePath.lastPathComponent;
    NSURL *destinationURL = [pdfDirectory URLByAppendingPathComponent:storedFilename];
    [createdFiles addObject:destinationURL];
    NSString *timestamp = [self isoTimestamp];
    NSDictionary *item = @{
      @"id": itemID,
      @"number": @(nextNumber),
      @"sourceType": @"pdf",
      @"displayTitle": sourceURL.lastPathComponent.stringByDeletingPathExtension,
      @"titleStatus": @"filename_guess",
      @"originalFilename": sourceURL.lastPathComponent,
      @"storedFilename": storedFilename,
      @"localPath": relativePath,
      @"source": @{
        @"kind": @"pdf",
        @"pdfPath": relativePath,
        @"sha256": managedHash ?: sourceHash
      },
      @"verificationStatus": @"imported",
      @"status": @"pending_codex",
      @"revision": @1,
      @"createdAt": timestamp,
      @"updatedAt": timestamp
    };
    [items addObject:item];
    [createdItems addObject:item];
    nextNumber += 1;
  }

  if (createdItems.count == 0) {
    [self sendWorkspaceWithNotice:@"No PDF files were selected for import."];
    return;
  }
  library[@"items"] = items;
  library[@"nextNumber"] = @(nextNumber);
  library[@"schemaVersion"] = @1;
  if (![self writeJSONObject:library toURL:[self libraryURL] error:&error]) {
    for (NSURL *createdURL in createdFiles) {
      [NSFileManager.defaultManager removeItemAtURL:createdURL error:nil];
    }
    [self sendWorkspaceErrorForAction:@"pickLiteraturePDF" error:error];
    return;
  }
  for (NSDictionary *item in createdItems) {
    [self appendJSONObject:@{
      @"eventId": NSUUID.UUID.UUIDString,
      @"action": @"literature_pdf_imported",
      @"timestamp": item[@"createdAt"],
      @"item": item
    } toURL:[self workspaceInboxURL]];
  }
  [self sendWorkspaceWithNotice:[NSString stringWithFormat:@"Saved %lu PDF files to the local literature library for Codex curation.", (unsigned long)createdItems.count]];
}

- (void)presentPDFImporter {
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.title = @"Import Literature PDFs";
  panel.prompt = @"Import";
  panel.canChooseFiles = YES;
  panel.canChooseDirectories = NO;
  panel.allowsMultipleSelection = YES;
  panel.allowedContentTypes = @[ UTTypePDF ];
  [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
    if (result != NSModalResponseOK) {
      dispatch_async(self->_persistenceQueue, ^{
        [self sendWorkspaceWithNotice:@"PDF import was canceled."];
      });
      return;
    }
    NSArray<NSURL *> *URLs = panel.URLs;
    dispatch_async(self->_persistenceQueue, ^{
      [self importPDFURLs:URLs];
    });
  }];
}

- (void)syncCatalogItems:(NSArray *)rawItems {
  dispatch_async(_persistenceQueue, ^{
    NSError *error = nil;
    NSDictionary *storedLibrary = [self readDictionaryAtURL:[self libraryURL]
                                                defaultValue:[self defaultLibrary]
                                                       error:&error];
    if (!storedLibrary) {
      [self sendWorkspaceErrorForAction:@"syncCatalog" error:error];
      return;
    }

    NSArray *storedItems = [storedLibrary[@"items"] isKindOfClass:NSArray.class] ? storedLibrary[@"items"] : @[];
    NSMutableDictionary<NSString *, NSDictionary *> *storedByPaperID = [NSMutableDictionary dictionary];
    for (NSDictionary *storedItem in storedItems) {
      NSString *paperID = [storedItem[@"graphPaperId"] isKindOfClass:NSString.class]
          ? storedItem[@"graphPaperId"] : nil;
      BOOL eligible = [storedItem[@"catalogSource"] isEqualToString:@"universe"] ||
          [storedItem[@"status"] isEqualToString:@"organized"];
      if (paperID.length == 0 || !eligible) continue;
      NSDictionary *previous = storedByPaperID[paperID];
      BOOL storedIsUpload = ![storedItem[@"catalogSource"] isEqualToString:@"universe"];
      BOOL previousIsCatalog = [previous[@"catalogSource"] isEqualToString:@"universe"];
      if (!previous || (storedIsUpload && previousIsCatalog)) storedByPaperID[paperID] = storedItem;
    }
    NSMutableSet<NSString *> *consumedStoredIDs = [NSMutableSet set];
    NSMutableSet<NSString *> *catalogPaperIDs = [NSMutableSet set];
    NSMutableArray *catalogItems = [NSMutableArray array];
    for (id rawItem in rawItems) {
      if (![rawItem isKindOfClass:NSDictionary.class]) continue;
      NSDictionary *item = (NSDictionary *)rawItem;
      NSString *itemID = item[@"id"];
      NSString *title = item[@"displayTitle"];
      NSString *paperID = item[@"graphPaperId"];
      NSString *localPath = item[@"localPath"];
      if (itemID.length == 0 || title.length == 0 || paperID.length == 0) continue;
      [catalogPaperIDs addObject:paperID];
      NSDictionary *rawSource = [item[@"source"] isKindOfClass:NSDictionary.class] ? item[@"source"] : @{};
      NSString *sourcePDFPath = [rawSource[@"pdfPath"] isKindOfClass:NSString.class]
          ? rawSource[@"pdfPath"] : localPath;
      NSString *managedPath = nil;
      NSString *pdfHash = [rawSource[@"sha256"] isKindOfClass:NSString.class] ? rawSource[@"sha256"] : nil;
      if (sourcePDFPath.length > 0 && !sourcePDFPath.isAbsolutePath &&
          [self isSafeWorkspaceRelativePath:sourcePDFPath] &&
          [sourcePDFPath.stringByStandardizingPath hasPrefix:@"Library/PDFs/"]) {
        managedPath = sourcePDFPath.stringByStandardizingPath;
      } else if (sourcePDFPath.isAbsolutePath &&
                 [NSFileManager.defaultManager fileExistsAtPath:sourcePDFPath]) {
        managedPath = [self managedPDFRelativePathForSourceURL:[NSURL fileURLWithPath:sourcePDFPath]
                                                       paperID:paperID
                                                        sha256:&pdfHash
                                                         error:nil];
      }
      NSDictionary *rawArtifacts = [item[@"artifacts"] isKindOfClass:NSDictionary.class] ? item[@"artifacts"] : @{};
      NSString *verificationStatus = [item[@"verificationStatus"] isKindOfClass:NSString.class]
          ? item[@"verificationStatus"] : (managedPath ? @"card_draft" : @"source_missing");
      NSMutableDictionary *catalogItem = [@{
        @"id": itemID,
        @"number": [item[@"number"] isKindOfClass:NSNumber.class] ? item[@"number"] : @([catalogItems count] + 1),
        @"sourceType": [rawSource[@"kind"] isKindOfClass:NSString.class] ? rawSource[@"kind"] : @"pdf",
        @"displayTitle": title,
        @"titleStatus": [item[@"titleStatus"] isKindOfClass:NSString.class] ? item[@"titleStatus"] : @"catalog",
        @"status": @"organized",
        @"revision": [item[@"revision"] isKindOfClass:NSNumber.class] ? item[@"revision"] : @1,
        @"createdAt": [item[@"createdAt"] isKindOfClass:NSString.class] ? item[@"createdAt"] : @"",
        @"updatedAt": [item[@"updatedAt"] isKindOfClass:NSString.class] ? item[@"updatedAt"] : @"",
        @"organizedAt": [item[@"organizedAt"] isKindOfClass:NSString.class] ? item[@"organizedAt"] : @"",
        @"graphPaperId": paperID,
        @"catalogSource": @"universe",
        @"localPath": managedPath ?: @"",
        @"verificationStatus": verificationStatus,
        @"source": @{
          @"kind": [rawSource[@"kind"] isKindOfClass:NSString.class] ? rawSource[@"kind"] : @"pdf",
          @"pdfPath": managedPath ?: @"",
          @"sha256": pdfHash ?: @""
        },
        @"artifacts": rawArtifacts,
        @"citekey": [item[@"citekey"] isKindOfClass:NSString.class] ? item[@"citekey"] : paperID
      } mutableCopy];
      NSDictionary *storedMatch = storedByPaperID[paperID];
      if (storedMatch) {
        // Preserve the stable Library identity/number of an uploaded item while
        // taking title, source, artifact and verification truth from the graph.
        for (NSString *key in @[@"id", @"number", @"revision", @"createdAt", @"organizedAt", @"originalFilename"]) {
          if (storedMatch[key]) catalogItem[key] = storedMatch[key];
        }
        NSString *storedID = [storedMatch[@"id"] isKindOfClass:NSString.class] ? storedMatch[@"id"] : nil;
        if (storedID.length > 0) [consumedStoredIDs addObject:storedID];
      }
      if (managedPath.length > 0) catalogItem[@"storedFilename"] = managedPath.lastPathComponent;
      NSString *arxivID = [item[@"arxivId"] isKindOfClass:NSString.class]
          ? item[@"arxivId"] : ([storedMatch[@"arxivId"] isKindOfClass:NSString.class] ? storedMatch[@"arxivId"] : nil);
      NSString *arxivURL = [item[@"arxivUrl"] isKindOfClass:NSString.class]
          ? item[@"arxivUrl"] : ([storedMatch[@"arxivUrl"] isKindOfClass:NSString.class] ? storedMatch[@"arxivUrl"] : nil);
      if (arxivID.length > 0) catalogItem[@"arxivId"] = arxivID;
      if (arxivURL.length > 0) catalogItem[@"arxivUrl"] = arxivURL;
      [catalogItems addObject:catalogItem];
    }

    NSMutableArray *userItems = [NSMutableArray array];
    for (NSDictionary *item in storedItems) {
      NSString *itemID = [item[@"id"] isKindOfClass:NSString.class] ? item[@"id"] : @"";
      NSString *paperID = [item[@"graphPaperId"] isKindOfClass:NSString.class] ? item[@"graphPaperId"] : @"";
      BOOL mergedOrganizedItem = [item[@"status"] isEqualToString:@"organized"] && [catalogPaperIDs containsObject:paperID];
      if (![item[@"catalogSource"] isEqualToString:@"universe"] &&
          ![consumedStoredIDs containsObject:itemID] && !mergedOrganizedItem) {
        [userItems addObject:item];
      }
    }

    NSMutableDictionary *library = [storedLibrary mutableCopy];
    library[@"schemaVersion"] = @1;
    library[@"items"] = [catalogItems arrayByAddingObjectsFromArray:userItems];
    // A native catalog sync is idempotent. Rewriting identical data would wake
    // the workspace watcher, which in turn asks the frontend to sync again.
    if ([library isEqualToDictionary:storedLibrary]) return;
    if (![self writeJSONObject:library toURL:[self libraryURL] error:&error]) {
      [self sendWorkspaceErrorForAction:@"syncCatalog" error:error];
      return;
    }
    [self sendWorkspaceWithNotice:nil];
  });
}

- (void)saveResearchText:(NSString *)rawText projectID:(NSString *)requestedProjectID {
  if (![rawText isKindOfClass:NSString.class]) return;
  NSString *trimmedText = [rawText stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (trimmedText.length == 0) return;
  NSString *text = rawText;
  dispatch_async(_persistenceQueue, ^{
    NSError *error = nil;
    if (![self ensureProjectStorage:&error]) {
      [self sendWorkspaceErrorForAction:@"saveResearchInformation" error:error];
      return;
    }
    NSDictionary *registry = [self readDictionaryAtURL:[self projectsRegistryURL] defaultValue:nil error:&error];
    NSString *activeProjectID = registry ? [self activeProjectIDFromRegistry:registry] : nil;
    NSString *projectID = [self isSafeProjectID:requestedProjectID] ? requestedProjectID : activeProjectID;
    if (!projectID || ![projectID isEqualToString:activeProjectID]) {
      [self sendWorkspaceErrorForAction:@"saveResearchInformation"
                                  error:[self storageError:@"The active project changed; reopen Memory Center before saving." code:540]];
      return;
    }
    NSURL *researchURL = [self projectResearchInformationURLForID:projectID error:&error];
    NSDictionary *stored = [self readDictionaryAtURL:researchURL
                                        defaultValue:[self defaultResearchInformation]
                                               error:&error];
    if (!stored) {
      [self sendWorkspaceErrorForAction:@"saveResearchInformation" error:error];
      return;
    }
    NSMutableDictionary *research = [stored mutableCopy];
    NSDictionary *oldDraft = [research[@"draft"] isKindOfClass:NSDictionary.class] ? research[@"draft"] : @{};
    NSDictionary *oldFormal = [research[@"formal"] isKindOfClass:NSDictionary.class] ? research[@"formal"] : @{};
    NSInteger previousRevision = MAX([oldDraft[@"revision"] integerValue], [oldFormal[@"sourceRevision"] integerValue]);
    NSInteger revision = previousRevision + 1;
    NSString *timestamp = [self isoTimestamp];
    research[@"schemaVersion"] = @1;
    research[@"status"] = @"organized";
    research[@"draft"] = @{
      @"text": text,
      @"revision": @(revision),
      @"updatedAt": timestamp
    };
    research[@"formal"] = @{
      @"text": text,
      @"sourceRevision": @(revision),
      @"organizedAt": timestamp
    };
    NSURL *projectDirectory = [self projectDirectoryURLForID:projectID error:&error];
    NSURL *generatedDirectory = [projectDirectory URLByAppendingPathComponent:@"generated" isDirectory:YES];
    if (![NSFileManager.defaultManager createDirectoryAtURL:generatedDirectory
                                withIntermediateDirectories:YES
                                                 attributes:nil
                                                      error:&error]) {
      [self sendWorkspaceErrorForAction:@"saveResearchInformation" error:error];
      return;
    }
    NSURL *historyDirectory = [generatedDirectory URLByAppendingPathComponent:@"research-history" isDirectory:YES];
    if (![NSFileManager.defaultManager createDirectoryAtURL:historyDirectory
                                withIntermediateDirectories:YES
                                                 attributes:nil
                                                      error:&error]) {
      [self sendWorkspaceErrorForAction:@"saveResearchInformation" error:error];
      return;
    }

    NSString *previousText = [oldFormal[@"text"] isKindOfClass:NSString.class] ? oldFormal[@"text"] : @"";
    if (previousText.length > 0 && previousRevision > 0) {
      NSURL *previousURL = [historyDirectory URLByAppendingPathComponent:
          [NSString stringWithFormat:@"revision-%06ld.md", (long)previousRevision]];
      if (![NSFileManager.defaultManager fileExistsAtPath:previousURL.path]) {
        NSString *previousTimestamp = [oldFormal[@"organizedAt"] isKindOfClass:NSString.class]
            ? oldFormal[@"organizedAt"] : @"";
        NSString *previousMarkdown = [NSString stringWithFormat:
            @"# Liteverse research memory · revision %ld\n\n- Saved: %@\n\n%@\n",
            (long)previousRevision, previousTimestamp, previousText];
        if (![previousMarkdown writeToURL:previousURL atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
          [self sendWorkspaceErrorForAction:@"saveResearchInformation" error:error];
          return;
        }
      }
    }

    NSURL *historyURL = [historyDirectory URLByAppendingPathComponent:
        [NSString stringWithFormat:@"revision-%06ld.md", (long)revision]];
    NSString *historyMarkdown = [NSString stringWithFormat:
        @"# Liteverse research memory · revision %ld\n\n- Saved: %@\n\n%@\n",
        (long)revision, timestamp, text];
    if (![historyMarkdown writeToURL:historyURL atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
      [self sendWorkspaceErrorForAction:@"saveResearchInformation" error:error];
      return;
    }
    if (![self writeJSONObject:research toURL:researchURL error:&error]) {
      [self sendWorkspaceErrorForAction:@"saveResearchInformation" error:error];
      return;
    }
    if ([projectID isEqualToString:@"project-default"]) {
      // Compatibility mirror for older Curator versions. Projects remains the
      // canonical editable source for the App.
      [self writeJSONObject:research toURL:[self researchInformationURL] error:nil];
    }
    NSURL *markdownURL = [generatedDirectory URLByAppendingPathComponent:@"research-memory.md"];
    NSString *markdown = text;
    BOOL mirrorSaved = [markdown writeToURL:markdownURL atomically:YES encoding:NSUTF8StringEncoding error:&error];
    [self appendJSONObject:@{
      @"eventId": NSUUID.UUID.UUIDString,
      @"action": @"research_memory_updated_directly",
      @"timestamp": timestamp,
      @"projectId": projectID,
      @"revision": @(revision),
      @"historyPath": historyURL.path,
      @"mirrorSaved": @(mirrorSaved)
    } toURL:[self workspaceInboxURL]];
    [self sendWorkspaceWithNotice:mirrorSaved
        ? @"Research memory was updated and its traceable history was preserved."
        : @"Research memory and its history were saved, but the Markdown mirror could not be updated."];
  });
}

- (NSString *)projectIDFromName:(NSString *)name existingIDs:(NSSet<NSString *> *)existingIDs {
  NSString *latin = [name stringByApplyingTransform:NSStringTransformToLatin reverse:NO];
  latin = [latin stringByApplyingTransform:NSStringTransformStripDiacritics reverse:NO].lowercaseString;
  NSMutableString *slug = [NSMutableString string];
  BOOL lastWasSeparator = NO;
  NSCharacterSet *alphanumeric = NSCharacterSet.alphanumericCharacterSet;
  for (NSUInteger index = 0; index < latin.length; index += 1) {
    unichar character = [latin characterAtIndex:index];
    if ([alphanumeric characterIsMember:character]) {
      [slug appendFormat:@"%C", character];
      lastWasSeparator = NO;
    } else if (!lastWasSeparator && slug.length > 0) {
      [slug appendString:@"-"];
      lastWasSeparator = YES;
    }
  }
  while ([slug hasSuffix:@"-"]) [slug deleteCharactersInRange:NSMakeRange(slug.length - 1, 1)];
  if (slug.length == 0) [slug appendString:@"project"];
  NSString *base = [@"project-" stringByAppendingString:slug];
  if (base.length > 96) base = [base substringToIndex:96];
  NSString *candidate = base;
  NSUInteger suffix = 2;
  while ([existingIDs containsObject:candidate]) candidate = [NSString stringWithFormat:@"%@-%lu", base, (unsigned long)suffix++];
  return candidate;
}

- (void)setActiveProjectID:(NSString *)projectID {
  dispatch_async(_persistenceQueue, ^{
    NSError *error = nil;
    if (![self ensureProjectStorage:&error] || ![self isSafeProjectID:projectID]) {
      [self sendWorkspaceErrorForAction:@"setActiveProject" error:error ?: [self storageError:@"The project ID is invalid." code:541]];
      return;
    }
    NSDictionary *stored = [self readDictionaryAtURL:[self projectsRegistryURL] defaultValue:nil error:&error];
    if (!stored) { [self sendWorkspaceErrorForAction:@"setActiveProject" error:error]; return; }
    BOOL found = NO;
    for (NSDictionary *item in stored[@"items"]) {
      NSString *itemID = [item[@"projectId"] isKindOfClass:NSString.class] ? item[@"projectId"] : item[@"id"];
      if ([itemID isEqualToString:projectID]) { found = YES; break; }
    }
    if (!found) {
      [self sendWorkspaceErrorForAction:@"setActiveProject" error:[self storageError:@"The project does not exist." code:542]];
      return;
    }
    NSMutableDictionary *registry = [stored mutableCopy];
    registry[@"activeProjectId"] = projectID;
    registry[@"generatedAt"] = [self isoTimestamp];
    if (![self writeJSONObject:registry toURL:[self projectsRegistryURL] error:&error] ||
        ![self writeJSONObject:@{ @"schemaVersion": @1, @"projectId": projectID }
                         toURL:[self activeProjectURL] error:&error]) {
      [self sendWorkspaceErrorForAction:@"setActiveProject" error:error];
      return;
    }
    [self sendWorkspaceWithNotice:@"Project switched. Research memory, tasks, and project heat remain isolated."];
  });
}

- (void)createProjectNamed:(NSString *)rawName {
  if (![rawName isKindOfClass:NSString.class]) return;
  NSString *name = [rawName stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (name.length == 0 || name.length > 160) {
    [self sendWorkspaceErrorForAction:@"createProject" error:[self storageError:@"A project name is required and may contain at most 160 characters." code:543]];
    return;
  }
  dispatch_async(_persistenceQueue, ^{
    NSError *error = nil;
    if (![self ensureProjectStorage:&error]) { [self sendWorkspaceErrorForAction:@"createProject" error:error]; return; }
    NSDictionary *stored = [self readDictionaryAtURL:[self projectsRegistryURL] defaultValue:nil error:&error];
    if (!stored) { [self sendWorkspaceErrorForAction:@"createProject" error:error]; return; }
    NSMutableSet *existingIDs = [NSMutableSet set];
    for (NSDictionary *item in stored[@"items"]) {
      NSString *itemID = [item[@"projectId"] isKindOfClass:NSString.class] ? item[@"projectId"] : item[@"id"];
      if (itemID) [existingIDs addObject:itemID];
    }
    NSString *projectID = [self projectIDFromName:name existingIDs:existingIDs];
    NSString *timestamp = [self isoTimestamp];
    NSDictionary *initialEvent = @{
      @"schemaVersion": @1,
      @"eventId": NSUUID.UUID.UUIDString,
      @"timestamp": timestamp,
      @"projectId": projectID,
      @"revision": @1,
      @"type": @"project_initialized",
      @"name": name,
      @"description": @""
    };
    NSData *initialEventJSON = [NSJSONSerialization dataWithJSONObject:initialEvent
        options:NSJSONWritingSortedKeys error:&error];
    if (!initialEventJSON) { [self sendWorkspaceErrorForAction:@"createProject" error:error]; return; }
    NSMutableData *ledgerData = [initialEventJSON mutableCopy];
    [ledgerData appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    NSString *ledgerHash = [self sha256ForData:ledgerData];
    NSDictionary *project = @{
      @"schemaVersion": @1, @"projectId": projectID, @"name": name,
      @"description": @"", @"createdAt": timestamp, @"updatedAt": timestamp,
      @"revision": @1, @"ledgerHash": ledgerHash
    };
    NSDictionary *memoryProjection = @{
      @"schemaVersion": @1, @"projectId": projectID, @"revision": @1,
      @"ledgerHash": ledgerHash, @"generatedAt": timestamp, @"items": @[]
    };
    NSDictionary *tasksProjection = @{
      @"schemaVersion": @1, @"projectId": projectID, @"revision": @1,
      @"ledgerHash": ledgerHash, @"generatedAt": timestamp, @"tasks": @[], @"handoffs": @[]
    };
    NSURL *projectDirectory = [self projectDirectoryURLForID:projectID error:&error];
    NSURL *memoryDirectory = [projectDirectory URLByAppendingPathComponent:@"memory" isDirectory:YES];
    if (![NSFileManager.defaultManager createDirectoryAtURL:memoryDirectory
        withIntermediateDirectories:YES attributes:nil error:&error] ||
        ![NSFileManager.defaultManager createDirectoryAtURL:[projectDirectory URLByAppendingPathComponent:@"Tasks" isDirectory:YES]
        withIntermediateDirectories:YES attributes:nil error:&error] ||
        ![ledgerData writeToURL:[memoryDirectory URLByAppendingPathComponent:@"events.jsonl"]
                         options:NSDataWritingAtomic error:&error] ||
        ![self writeJSONObject:project toURL:[projectDirectory URLByAppendingPathComponent:@"project.json"] error:&error] ||
        ![self writeJSONObject:memoryProjection toURL:[memoryDirectory URLByAppendingPathComponent:@"current.json"] error:&error] ||
        ![self writeJSONObject:tasksProjection toURL:[projectDirectory URLByAppendingPathComponent:@"tasks.json"] error:&error] ||
        ![self writeJSONObject:[self defaultResearchInformation]
                         toURL:[self projectResearchInformationURLForID:projectID error:&error] error:&error]) {
      [self sendWorkspaceErrorForAction:@"createProject" error:error];
      return;
    }
    NSArray *storedItems = [stored[@"items"] isKindOfClass:NSArray.class] ? stored[@"items"] : @[];
    NSMutableArray *items = [storedItems mutableCopy];
    [items addObject:project];
    NSMutableDictionary *registry = [stored mutableCopy];
    registry[@"items"] = items;
    registry[@"activeProjectId"] = projectID;
    registry[@"generatedAt"] = timestamp;
    if (![self writeJSONObject:registry toURL:[self projectsRegistryURL] error:&error] ||
        ![self writeJSONObject:@{ @"schemaVersion": @1, @"projectId": projectID }
                         toURL:[self activeProjectURL] error:&error]) {
      [self sendWorkspaceErrorForAction:@"createProject" error:error];
      return;
    }
    [self appendJSONObject:@{ @"eventId": NSUUID.UUID.UUIDString, @"action": @"project_created",
      @"timestamp": timestamp, @"projectId": projectID, @"name": name } toURL:[self workspaceInboxURL]];
    [self sendWorkspaceWithNotice:@"The new project was created. The shared literature library is unchanged and project memory starts empty."];
  });
}

- (void)saveContextRequest:(NSDictionary *)payload {
  NSString *projectID = payload[@"projectId"];
  NSString *query = [payload[@"query"] isKindOfClass:NSString.class]
      ? [payload[@"query"] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] : @"";
  NSInteger budget = [payload[@"budgetChars"] integerValue];
  if (![self isSafeProjectID:projectID] || query.length == 0 || query.length > 20000 || budget < 2000 || budget > 200000) {
    [self sendWorkspaceErrorForAction:@"saveContextRequest" error:[self storageError:@"The Context request or budget is invalid." code:544]];
    return;
  }
  dispatch_async(_persistenceQueue, ^{
    NSError *error = nil;
    NSDictionary *registry = [self readDictionaryAtURL:[self projectsRegistryURL] defaultValue:nil error:&error];
    if (!registry || ![[self activeProjectIDFromRegistry:registry] isEqualToString:projectID]) {
      [self sendWorkspaceErrorForAction:@"saveContextRequest" error:error ?: [self storageError:@"The active project changed." code:545]];
      return;
    }
    NSURL *tasksDirectory = [[self projectDirectoryURLForID:projectID error:&error]
        URLByAppendingPathComponent:@"Tasks" isDirectory:YES];
    if (![NSFileManager.defaultManager createDirectoryAtURL:tasksDirectory withIntermediateDirectories:YES attributes:nil error:&error]) {
      [self sendWorkspaceErrorForAction:@"saveContextRequest" error:error]; return;
    }
    NSString *requestID = [NSString stringWithFormat:@"request-%@", NSUUID.UUID.UUIDString.lowercaseString];
    [self appendJSONObject:@{
      @"schemaVersion": @1, @"requestId": requestID, @"projectId": projectID,
      @"query": query, @"budgetChars": @(budget), @"createdAt": [self isoTimestamp],
      @"status": @"pending_cli", @"modelInvocation": @NO
    } toURL:[tasksDirectory URLByAppendingPathComponent:@"context-requests.jsonl"]];
    [self sendWorkspaceWithNotice:@"The Context request was saved. The app did not call a model; run liteverse context build to generate the evidence pack."];
  });
}

- (void)loadKnowledgeCardForPaperID:(NSString *)paperID
                               path:(NSString *)path
                     expectedSHA256:(NSString *)expectedSHA256 {
  if (![paperID isKindOfClass:NSString.class] || paperID.length == 0 ||
      ![path isKindOfClass:NSString.class] || ![self isSafeWorkspaceRelativePath:path]) return;
  NSString *standardized = path.stringByStandardizingPath;
  BOOL allowed = [standardized.pathExtension.lowercaseString isEqualToString:@"md"] &&
      ([standardized hasPrefix:@"Knowledge/cards/"] || [standardized hasPrefix:@"Knowledge/artifacts/"]);
  if (!allowed) {
    [self sendWorkspaceErrorForAction:@"loadKnowledgeCard" error:[self storageError:@"The knowledge-card path is outside the managed artifact directory." code:546]];
    return;
  }
  dispatch_async(_persistenceQueue, ^{
    NSError *error = nil;
    NSURL *fileURL = [self URLForWorkspaceRelativePath:standardized error:&error];
    NSString *markdown = fileURL ? [NSString stringWithContentsOfURL:fileURL encoding:NSUTF8StringEncoding error:&error] : nil;
    NSMutableDictionary *payload = [@{ @"paperId": paperID, @"path": standardized,
      @"sections": @[], @"evidence": @[] } mutableCopy];
    if (!markdown) {
      payload[@"error"] = error.localizedDescription ?: @"The knowledge-card file does not exist.";
    } else {
      NSString *actualSHA256 = [self cachedSHA256ForFileAtURL:fileURL error:&error];
      if (expectedSHA256.length > 0 &&
          (actualSHA256.length != 64 || ![actualSHA256 isEqualToString:expectedSHA256.lowercaseString])) {
        payload[@"error"] = @"The knowledge-card hash does not match the graph-pinned revision. Reading was refused; run liteverse doctor.";
        payload[@"artifactSha256"] = actualSHA256 ?: @"";
        dispatch_async(dispatch_get_main_queue(), ^{
          [self.webView callAsyncJavaScript:
              @"window.__liteverseReceiveKnowledgeCard && window.__liteverseReceiveKnowledgeCard(cardPayload);"
                                    arguments:@{ @"cardPayload": payload }
                                      inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:nil];
        });
        return;
      }
      NSMutableArray *sections = [NSMutableArray array];
      NSMutableArray *evidence = [NSMutableArray array];
      NSString *currentTitle = nil;
      NSMutableArray<NSString *> *currentLines = [NSMutableArray array];
      BOOL inFrontmatter = [markdown hasPrefix:@"---\n"];
      BOOL sawFrontmatterStart = NO;
      NSString *sourceHash = nil;
      NSArray<NSString *> *lines = [markdown componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
      for (NSString *line in lines) {
        if (inFrontmatter) {
          if ([line isEqualToString:@"---"]) {
            if (sawFrontmatterStart) inFrontmatter = NO;
            sawFrontmatterStart = YES;
            continue;
          }
          if ([line hasPrefix:@"source_sha256:"]) {
            sourceHash = [[line substringFromIndex:@"source_sha256:".length]
                stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@" \t\""]];
          }
          continue;
        }
        if ([line hasPrefix:@"## "]) {
          if (currentTitle) {
            NSString *content = [[currentLines componentsJoinedByString:@"\n"]
                stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
            [sections addObject:@{ @"id": [NSString stringWithFormat:@"section-%lu", (unsigned long)sections.count],
              @"title": currentTitle, @"content": content }];
          }
          currentTitle = [line substringFromIndex:3];
          [currentLines removeAllObjects];
          continue;
        }
        if ([currentTitle isEqualToString:@"Evidence index"] && [line hasPrefix:@"- E"]) {
          NSArray<NSString *> *parts = [line componentsSeparatedByString:@" — "];
          NSString *evidenceID = parts.count > 0 ? [parts[0] substringFromIndex:2] : @"E?";
          NSString *locator = parts.count > 2 ? [[parts subarrayWithRange:NSMakeRange(1, parts.count - 2)] componentsJoinedByString:@" — "] : @"";
          NSString *text = parts.count > 1 ? parts.lastObject : line;
          [evidence addObject:@{ @"id": evidenceID, @"locator": locator, @"text": text }];
        }
        if (currentTitle) [currentLines addObject:line];
      }
      if (currentTitle) {
        NSString *content = [[currentLines componentsJoinedByString:@"\n"]
            stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        [sections addObject:@{ @"id": [NSString stringWithFormat:@"section-%lu", (unsigned long)sections.count],
          @"title": currentTitle, @"content": content }];
      }
      payload[@"sections"] = sections;
      payload[@"evidence"] = evidence;
      payload[@"artifactSha256"] = actualSHA256 ?: @"";
      if (sourceHash.length > 0) payload[@"sourceSha256"] = sourceHash;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      [self.webView callAsyncJavaScript:
          @"window.__liteverseReceiveKnowledgeCard && window.__liteverseReceiveKnowledgeCard(cardPayload);"
                                arguments:@{ @"cardPayload": payload }
                                  inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:nil];
    });
  });
}

- (NSDictionary *)libraryItemWithID:(NSString *)itemID error:(NSError **)error {
  NSDictionary *library = [self readDictionaryAtURL:[self libraryURL]
                                       defaultValue:[self defaultLibrary]
                                              error:error];
  if (!library) return nil;
  for (NSDictionary *item in library[@"items"]) {
    if ([item[@"id"] isEqualToString:itemID]) return item;
  }
  if (error) *error = [self storageError:@"The item was not found in the literature library." code:301];
  return nil;
}

- (void)openLibraryItemID:(NSString *)itemID externalArxiv:(BOOL)externalArxiv {
  NSError *error = nil;
  NSDictionary *item = [self libraryItemWithID:itemID error:&error];
  if (!item) {
    [self sendWorkspaceErrorForAction:@"openLibraryItem" error:error];
    return;
  }
  if (externalArxiv) {
    NSString *rawURL = item[@"arxivUrl"];
    NSURLComponents *components = [NSURLComponents componentsWithString:rawURL];
    NSString *host = components.host.lowercaseString;
    if (![components.scheme.lowercaseString isEqualToString:@"https"] ||
        (![host isEqualToString:@"arxiv.org"] && ![host isEqualToString:@"www.arxiv.org"])) {
      [self sendWorkspaceErrorForAction:@"openExternalArxiv"
                                  error:[self storageError:@"This item does not yet have a verifiable arXiv link." code:302]];
      return;
    }
    [NSWorkspace.sharedWorkspace openURL:components.URL];
    return;
  }
  NSString *storedFilename = item[@"storedFilename"];
  NSDictionary *source = [item[@"source"] isKindOfClass:NSDictionary.class] ? item[@"source"] : @{};
  NSString *localPath = [source[@"pdfPath"] isKindOfClass:NSString.class]
      ? source[@"pdfPath"] : item[@"localPath"];
  NSURL *fileURL = nil;
  if (storedFilename.length > 0 &&
      [storedFilename isEqualToString:storedFilename.lastPathComponent] &&
      [storedFilename.pathExtension.lowercaseString isEqualToString:@"pdf"]) {
    fileURL = [[self pdfDirectoryURL] URLByAppendingPathComponent:storedFilename];
  } else if (localPath.length > 0 &&
             !localPath.isAbsolutePath &&
             [self isSafeWorkspaceRelativePath:localPath] &&
             [localPath.stringByStandardizingPath hasPrefix:@"Library/PDFs/"] &&
             [localPath.pathExtension.lowercaseString isEqualToString:@"pdf"]) {
    fileURL = [self URLForWorkspaceRelativePath:localPath error:&error];
  }
  if (!fileURL) {
    [self sendWorkspaceErrorForAction:@"openLibraryItem"
                                error:[self storageError:@"This item does not have a local PDF." code:303]];
    return;
  }
  if ([NSFileManager.defaultManager fileExistsAtPath:fileURL.path]) {
    [NSWorkspace.sharedWorkspace openURL:fileURL];
  } else {
    [self sendWorkspaceErrorForAction:@"openLibraryItem"
                                error:[self storageError:@"The local PDF file does not exist." code:304]];
  }
}

- (BOOL)isAllowedBackupRelativePath:(NSString *)relativePath includePDFs:(BOOL)includePDFs {
  if (![self isSafeWorkspaceRelativePath:relativePath]) return NO;
  NSString *path = relativePath.stringByStandardizingPath;
  NSArray<NSString *> *components = path.pathComponents;
  if ([components containsObject:@"Cache"] || [components containsObject:@"Index"] ||
      [path.pathExtension.lowercaseString isEqualToString:@"sqlite"] ||
      [path.pathExtension.lowercaseString isEqualToString:@"sqlite3"]) return NO;
  NSSet *rootFiles = [NSSet setWithArray:@[
    @"workspace.json", @"library.json", @"research-information.json",
    @"user-annotations.json", @"workspace-inbox.jsonl", @"codex-inbox.jsonl"
  ]];
  if ([rootFiles containsObject:path]) return YES;
  if ([path hasPrefix:@"Graph/"] ||
      [path hasPrefix:@"Knowledge/"] ||
      [path hasPrefix:@"Usage/"] ||
      [path hasPrefix:@"Projects/"] ||
      [path hasPrefix:@"Tasks/"] ||
      [path hasPrefix:@"Provenance/"] ||
      [path hasPrefix:@"Planning/"] ||
      [path hasPrefix:@"generated/"] ||
      [path hasPrefix:@"user-notes/"]) {
    return YES;
  }
  return includePDFs && [path hasPrefix:@"Library/PDFs/"];
}

- (NSArray<NSDictionary *> *)copyWorkspaceBackupFilesToDirectory:(NSURL *)workspaceDirectory
                                                       includePDFs:(BOOL)includePDFs
                                                            error:(NSError **)error {
  NSFileManager *manager = NSFileManager.defaultManager;
  NSURL *root = [self applicationSupportURL].URLByStandardizingPath.URLByResolvingSymlinksInPath;
  __block NSError *enumerationFailure = nil;
  NSDirectoryEnumerator<NSURL *> *enumerator = [manager enumeratorAtURL:root
                                              includingPropertiesForKeys:@[
                                                NSURLIsRegularFileKey,
                                                NSURLIsSymbolicLinkKey,
                                                NSURLFileSizeKey
                                              ]
                                                                 options:NSDirectoryEnumerationSkipsHiddenFiles
                                                            errorHandler:^BOOL(NSURL *url, NSError *enumerationError) {
    enumerationFailure = enumerationError;
    return NO;
  }];
  NSMutableArray<NSDictionary *> *files = [NSMutableArray array];
  NSString *rootPrefix = [root.path stringByAppendingString:@"/"];
  for (NSURL *sourceURL in enumerator) {
    NSString *resolvedSourcePath = sourceURL.URLByStandardizingPath.URLByResolvingSymlinksInPath.path;
    if (![resolvedSourcePath hasPrefix:rootPrefix]) continue;
    NSString *relativePath = [resolvedSourcePath substringFromIndex:rootPrefix.length];
    if (![self isAllowedBackupRelativePath:relativePath includePDFs:includePDFs]) continue;
    NSNumber *isRegularFile = nil;
    NSNumber *isSymbolicLink = nil;
    NSNumber *fileSize = nil;
    if (![sourceURL getResourceValue:&isRegularFile forKey:NSURLIsRegularFileKey error:error] ||
        ![sourceURL getResourceValue:&isSymbolicLink forKey:NSURLIsSymbolicLinkKey error:error] ||
        ![sourceURL getResourceValue:&fileSize forKey:NSURLFileSizeKey error:error]) {
      return nil;
    }
    if (isSymbolicLink.boolValue || !isRegularFile.boolValue) continue;
    NSString *hash = [self sha256ForFileAtURL:sourceURL error:error];
    if (hash.length != 64) return nil;
    NSURL *destinationURL = [workspaceDirectory URLByAppendingPathComponent:relativePath];
    if (![manager createDirectoryAtURL:destinationURL.URLByDeletingLastPathComponent
            withIntermediateDirectories:YES
                             attributes:nil
                                  error:error] ||
        ![manager copyItemAtURL:sourceURL toURL:destinationURL error:error]) {
      return nil;
    }
    [files addObject:@{
      @"path": relativePath,
      @"sha256": hash,
      @"size": fileSize ?: @0
    }];
  }
  if (enumerationFailure) {
    if (error) *error = enumerationFailure;
    return nil;
  }
  [files sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
    return [left[@"path"] compare:right[@"path"]];
  }];
  return files;
}

- (NSDictionary *)backupComponentSummaryForFiles:(NSArray<NSDictionary *> *)files
                                       includePDFs:(BOOL)includePDFs {
  NSMutableSet<NSString *> *paths = [NSMutableSet set];
  NSUInteger graphCount = 0;
  NSUInteger cardCount = 0;
  NSUInteger fulltextCount = 0;
  NSUInteger usageCount = 0;
  NSUInteger projectCount = 0;
  NSUInteger provenanceCount = 0;
  NSUInteger planningCount = 0;
  NSUInteger planningProposalCount = 0;
  NSUInteger planningDecisionCount = 0;
  NSUInteger planningSnapshotCount = 0;
  NSUInteger immutableArtifactCount = 0;
  NSUInteger pdfCount = 0;
  for (NSDictionary *entry in files) {
    NSString *relativePath = [entry[@"path"] isKindOfClass:NSString.class] ? entry[@"path"] : @"";
    if (relativePath.length == 0) continue;
    [paths addObject:relativePath];
    if ([relativePath hasPrefix:@"Graph/"]) graphCount += 1;
    if ([relativePath hasPrefix:@"Knowledge/cards/"]) cardCount += 1;
    if ([relativePath hasPrefix:@"Knowledge/fulltext/"]) fulltextCount += 1;
    if ([relativePath hasPrefix:@"Usage/"]) usageCount += 1;
    if ([relativePath hasPrefix:@"Projects/"]) projectCount += 1;
    if ([relativePath hasPrefix:@"Provenance/"] || [relativePath containsString:@"/provenance/"]) provenanceCount += 1;
    if ([relativePath hasPrefix:@"Planning/"]) planningCount += 1;
    if ([relativePath hasPrefix:@"Planning/partition-proposals/"]) planningProposalCount += 1;
    if ([relativePath isEqualToString:@"Planning/partition-decisions.jsonl"]) planningDecisionCount += 1;
    if ([relativePath hasPrefix:@"Planning/partition-snapshots/"]) planningSnapshotCount += 1;
    if ([relativePath hasPrefix:@"Knowledge/artifacts/"] || [relativePath hasPrefix:@"Knowledge/claims/"]) immutableArtifactCount += 1;
    if ([relativePath hasPrefix:@"Library/PDFs/"]) pdfCount += 1;
  }
  return @{
    @"graph": @{ @"fileCount": @(graphCount),
                  @"currentIncluded": @([paths containsObject:@"Graph/current.json"]),
                  @"partitionProposalsIncluded": @([paths containsObject:@"Graph/partition-proposals.json"]) },
    @"knowledge": @{ @"cardCount": @(cardCount), @"fulltextCount": @(fulltextCount),
                      @"artifactAndClaimCount": @(immutableArtifactCount) },
    @"usage": @{ @"fileCount": @(usageCount) },
    @"projects": @{ @"fileCount": @(projectCount), @"provenanceFileCount": @(provenanceCount) },
    @"planning": @{ @"fileCount": @(planningCount),
                       @"partitionProposalCount": @(planningProposalCount),
                       @"partitionDecisionCount": @(planningDecisionCount),
                       @"partitionSnapshotCount": @(planningSnapshotCount) },
    @"searchIndexExcluded": @YES,
    @"managedPDFs": @{ @"requested": @(includePDFs), @"fileCount": @(pdfCount) },
    @"workspaceMetadataIncluded": @([paths containsObject:@"workspace.json"]),
    @"libraryIncluded": @([paths containsObject:@"library.json"]),
    @"researchInformationIncluded": @([paths containsObject:@"research-information.json"]),
    @"annotationStoreIncluded": @([paths containsObject:@"user-annotations.json"])
  };
}

- (NSDictionary *)exportWorkspaceToURL:(NSURL *)destinationURL
                            includePDFs:(BOOL)includePDFs
                                  error:(NSError **)error {
  NSFileManager *manager = NSFileManager.defaultManager;
  NSURL *lockURL = [self stageRefreshLockURL];
  if (![manager createDirectoryAtURL:lockURL.URLByDeletingLastPathComponent
          withIntermediateDirectories:YES
                           attributes:nil
                                error:error]) {
    return nil;
  }
  NSError *lockError = nil;
  if (![manager createDirectoryAtURL:lockURL
          withIntermediateDirectories:NO
                           attributes:nil
                                error:&lockError]) {
    if (error) {
      *error = [manager fileExistsAtPath:lockURL.path]
          ? [self storageError:@"Curator or Refresh is updating the workspace. The backup did not start; try again later." code:515]
          : lockError;
    }
    return nil;
  }

  @try {
    if (![self ensureRuntimeGraphStorage:error]) return nil;
    if ([manager fileExistsAtPath:destinationURL.path]) {
      if (error) *error = [self storageError:@"The backup destination already exists. Choose a new name to avoid overwriting it." code:507];
      return nil;
    }
    NSURL *temporaryURL = [destinationURL.URLByDeletingLastPathComponent URLByAppendingPathComponent:
        [NSString stringWithFormat:@".%@.%@.tmp", destinationURL.lastPathComponent, NSUUID.UUID.UUIDString.lowercaseString]
                                                                              isDirectory:YES];
    if (![manager createDirectoryAtURL:temporaryURL
            withIntermediateDirectories:YES
                             attributes:nil
                                  error:error]) {
      return nil;
    }
    @try {
      NSURL *workspaceDirectory = [temporaryURL URLByAppendingPathComponent:@"Workspace" isDirectory:YES];
      if (![manager createDirectoryAtURL:workspaceDirectory
              withIntermediateDirectories:YES
                               attributes:nil
                                    error:error]) {
        return nil;
      }
      NSArray *files = [self copyWorkspaceBackupFilesToDirectory:workspaceDirectory
                                                     includePDFs:includePDFs
                                                          error:error];
      if (!files) return nil;
      NSDictionary *currentGraph = [self readDictionaryAtURL:[self currentGraphURL]
                                                 defaultValue:@{}
                                                        error:error];
      if (!currentGraph) return nil;
      NSDictionary *manifest = @{
        @"schemaVersion": @1,
        @"format": @"liteverse-workspace-backup",
        @"createdAt": [self isoTimestamp],
        @"includesPDFs": @(includePDFs),
        @"graphSchemaVersion": currentGraph[@"schemaVersion"] ?: @"unknown",
        @"graphRevision": currentGraph[@"revision"] ?: @0,
        @"componentSummary": [self backupComponentSummaryForFiles:files includePDFs:includePDFs],
        @"files": files
      };
      if (![self writeJSONObject:manifest
                           toURL:[temporaryURL URLByAppendingPathComponent:@"manifest.json"]
                           error:error] ||
          ![self validateBackupAtURL:temporaryURL error:error] ||
          ![manager moveItemAtURL:temporaryURL toURL:destinationURL error:error]) {
        return nil;
      }
      return manifest;
    } @finally {
      if ([manager fileExistsAtPath:temporaryURL.path]) {
        [manager removeItemAtURL:temporaryURL error:nil];
      }
    }
  } @finally {
    [manager removeItemAtURL:lockURL error:nil];
  }
}

- (NSDictionary *)validateBackupAtURL:(NSURL *)backupURL error:(NSError **)error {
  NSURL *manifestURL = [backupURL URLByAppendingPathComponent:@"manifest.json"];
  NSURL *workspaceDirectory = [backupURL URLByAppendingPathComponent:@"Workspace" isDirectory:YES];
  NSNumber *manifestIsRegular = nil;
  NSNumber *manifestIsSymbolicLink = nil;
  NSNumber *workspaceIsDirectory = nil;
  NSNumber *workspaceIsSymbolicLink = nil;
  if (![manifestURL getResourceValue:&manifestIsRegular forKey:NSURLIsRegularFileKey error:error] ||
      ![manifestURL getResourceValue:&manifestIsSymbolicLink forKey:NSURLIsSymbolicLinkKey error:error] ||
      ![workspaceDirectory getResourceValue:&workspaceIsDirectory forKey:NSURLIsDirectoryKey error:error] ||
      ![workspaceDirectory getResourceValue:&workspaceIsSymbolicLink forKey:NSURLIsSymbolicLinkKey error:error] ||
      !manifestIsRegular.boolValue || manifestIsSymbolicLink.boolValue ||
      !workspaceIsDirectory.boolValue || workspaceIsSymbolicLink.boolValue) {
    if (error && !*error) *error = [self storageError:@"The backup manifest or Workspace directory is missing, has the wrong type, or is a symbolic link." code:508];
    return nil;
  }
  NSDictionary *manifest = [self readDictionaryAtURL:manifestURL defaultValue:nil error:error];
  if (!manifest ||
      ![manifest[@"schemaVersion"] isEqual:@1] ||
      ![manifest[@"format"] isEqualToString:@"liteverse-workspace-backup"] ||
      ![manifest[@"files"] isKindOfClass:NSArray.class]) {
    if (error && !*error) *error = [self storageError:@"The selected directory is not a supported Liteverse backup." code:508];
    return nil;
  }
  BOOL includesPDFs = [manifest[@"includesPDFs"] boolValue];
  NSMutableSet<NSString *> *seenPaths = [NSMutableSet set];
  NSMutableDictionary<NSString *, NSString *> *verifiedHashes = [NSMutableDictionary dictionary];
  for (id rawEntry in manifest[@"files"]) {
    if (![rawEntry isKindOfClass:NSDictionary.class]) {
      if (error) *error = [self storageError:@"The backup manifest contains an invalid file record." code:509];
      return nil;
    }
    NSDictionary *entry = rawEntry;
    NSString *relativePath = [entry[@"path"] isKindOfClass:NSString.class] ? entry[@"path"] : nil;
    NSString *expectedHash = [entry[@"sha256"] isKindOfClass:NSString.class]
        ? [entry[@"sha256"] lowercaseString] : nil;
    NSString *standardizedPath = relativePath.stringByStandardizingPath;
    if (![self isAllowedBackupRelativePath:relativePath includePDFs:includesPDFs] ||
        ![relativePath isEqualToString:standardizedPath] ||
        expectedHash.length != 64 || [seenPaths containsObject:relativePath]) {
      if (error) *error = [self storageError:@"The backup manifest contains an unsafe, duplicate, or unhashed path." code:510];
      return nil;
    }
    [seenPaths addObject:relativePath];
    NSURL *fileURL = [workspaceDirectory URLByAppendingPathComponent:relativePath];
    NSNumber *isRegularFile = nil;
    NSNumber *isSymbolicLink = nil;
    if (![fileURL getResourceValue:&isRegularFile forKey:NSURLIsRegularFileKey error:error] ||
        ![fileURL getResourceValue:&isSymbolicLink forKey:NSURLIsSymbolicLinkKey error:error] ||
        isSymbolicLink.boolValue || !isRegularFile.boolValue) {
      if (error) *error = [self storageError:
          [NSString stringWithFormat:@"A backup file is missing, not a regular file, or a symbolic link: %@", relativePath]
                                        code:511];
      return nil;
    }
    NSString *actualHash = [self sha256ForFileAtURL:fileURL error:error];
    if (![actualHash isEqualToString:expectedHash]) {
      if (error) *error = [self storageError:
          [NSString stringWithFormat:@"A backup file hash does not match: %@", relativePath]
                                        code:512];
      return nil;
    }
    verifiedHashes[relativePath] = actualHash;
  }

  NSFileManager *manager = NSFileManager.defaultManager;
  __block NSError *enumerationFailure = nil;
  NSDirectoryEnumerator<NSURL *> *enumerator = [manager enumeratorAtURL:workspaceDirectory
                                              includingPropertiesForKeys:@[
                                                NSURLIsRegularFileKey,
                                                NSURLIsSymbolicLinkKey
                                              ]
                                                                 options:0
                                                            errorHandler:^BOOL(NSURL *url, NSError *enumerationError) {
    enumerationFailure = enumerationError;
    return NO;
  }];
  NSString *workspacePrefix = [workspaceDirectory.URLByStandardizingPath.path stringByAppendingString:@"/"];
  NSMutableSet<NSString *> *actualPaths = [NSMutableSet set];
  for (NSURL *fileURL in enumerator) {
    NSNumber *isRegularFile = nil;
    NSNumber *isSymbolicLink = nil;
    if (![fileURL getResourceValue:&isRegularFile forKey:NSURLIsRegularFileKey error:error] ||
        ![fileURL getResourceValue:&isSymbolicLink forKey:NSURLIsSymbolicLinkKey error:error]) {
      return nil;
    }
    NSString *standardizedFilePath = fileURL.URLByStandardizingPath.path;
    NSString *relativePath = [standardizedFilePath hasPrefix:workspacePrefix]
        ? [standardizedFilePath substringFromIndex:workspacePrefix.length] : nil;
    if (isSymbolicLink.boolValue) {
      if (error) *error = [self storageError:
          [NSString stringWithFormat:@"The backup Workspace contains a forbidden symbolic link: %@", relativePath ?: fileURL.lastPathComponent]
                                        code:516];
      return nil;
    }
    if (!isRegularFile.boolValue) continue;
    if (relativePath.length == 0 || ![seenPaths containsObject:relativePath]) {
      if (error) *error = [self storageError:
          [NSString stringWithFormat:@"The backup Workspace contains a file not listed in the manifest: %@", relativePath ?: fileURL.lastPathComponent]
                                        code:517];
      return nil;
    }
    [actualPaths addObject:relativePath];
  }
  if (enumerationFailure) {
    if (error) *error = enumerationFailure;
    return nil;
  }
  if (![actualPaths isEqualToSet:seenPaths]) {
    if (error) *error = [self storageError:@"The regular-file set in the backup Workspace does not exactly match the manifest." code:518];
    return nil;
  }
  if (![seenPaths containsObject:@"Graph/current.json"]) {
    if (error) *error = [self storageError:@"The backup is missing Graph/current.json." code:513];
    return nil;
  }
  NSDictionary *graph = [self readDictionaryAtURL:
      [workspaceDirectory URLByAppendingPathComponent:@"Graph/current.json"]
                                        defaultValue:nil
                                               error:error];
  NSString *schema = [graph[@"schemaVersion"] description];
  if (!graph || (!([schema hasPrefix:@"2."] || [schema hasPrefix:@"3."])) ||
      ![graph[@"categories"] isKindOfClass:NSArray.class] ||
      ![graph[@"papers"] isKindOfClass:NSArray.class] ||
      ![graph[@"relations"] isKindOfClass:NSArray.class]) {
    if (error && !*error) *error = [self storageError:@"The backup graph does not use a supported schema 2/3." code:514];
    return nil;
  }
  if (manifest[@"graphSchemaVersion"] &&
      ![[manifest[@"graphSchemaVersion"] description] isEqualToString:[graph[@"schemaVersion"] description]]) {
    if (error) *error = [self storageError:@"The graph schema in the backup manifest does not match Graph/current.json." code:519];
    return nil;
  }
  if (manifest[@"graphRevision"] && ![self revision:manifest[@"graphRevision"] matches:graph[@"revision"]]) {
    if (error) *error = [self storageError:@"The graph revision in the backup manifest does not match Graph/current.json." code:520];
    return nil;
  }

  if ([seenPaths containsObject:@"Graph/partition-proposals.json"]) {
    NSDictionary *partitionProposals = [self validatedPartitionProposalsAtURL:
        [workspaceDirectory URLByAppendingPathComponent:@"Graph/partition-proposals.json"] error:error];
    NSString *truthPath = [partitionProposals[@"truthPath"] isKindOfClass:NSString.class]
        ? partitionProposals[@"truthPath"] : nil;
    if (!partitionProposals || ![seenPaths containsObject:truthPath] ||
        ![self partitionProposals:partitionProposals closeTruthUnderRoot:workspaceDirectory error:error]) {
      if (error && !*error) *error = [self storageError:
          @"The partition projection in the backup is invalid or does not close over its Planning truth." code:584];
      return nil;
    }
  }

  for (id rawPaper in graph[@"papers"]) {
    if (![rawPaper isKindOfClass:NSDictionary.class]) {
      if (error) *error = [self storageError:@"The backup graph contains an invalid paper record." code:521];
      return nil;
    }
    NSDictionary *paper = rawPaper;
    NSString *paperID = [paper[@"id"] isKindOfClass:NSString.class] ? paper[@"id"] : @"unknown";
    NSDictionary *artifacts = [paper[@"artifacts"] isKindOfClass:NSDictionary.class] ? paper[@"artifacts"] : @{};
    NSString *cardPath = [artifacts[@"cardPath"] isKindOfClass:NSString.class]
        ? artifacts[@"cardPath"] : ([paper[@"markdownPath"] isKindOfClass:NSString.class] ? paper[@"markdownPath"] : nil);
    NSString *fulltextPath = [artifacts[@"fulltextPath"] isKindOfClass:NSString.class]
        ? artifacts[@"fulltextPath"] : ([paper[@"fulltextPath"] isKindOfClass:NSString.class] ? paper[@"fulltextPath"] : nil);
    BOOL cardClosed = cardPath.length > 0 && [self isSafeWorkspaceRelativePath:cardPath] &&
        [cardPath isEqualToString:cardPath.stringByStandardizingPath] &&
        [cardPath hasPrefix:@"Knowledge/cards/"] && [seenPaths containsObject:cardPath] &&
        [verifiedHashes[cardPath] length] == 64;
    BOOL fulltextClosed = fulltextPath.length > 0 && [self isSafeWorkspaceRelativePath:fulltextPath] &&
        [fulltextPath isEqualToString:fulltextPath.stringByStandardizingPath] &&
        [fulltextPath hasPrefix:@"Knowledge/fulltext/"] && [seenPaths containsObject:fulltextPath] &&
        [verifiedHashes[fulltextPath] length] == 64;
    if (!cardClosed || !fulltextClosed) {
      if (error) *error = [self storageError:
          [NSString stringWithFormat:@"The backup does not close over the knowledge-card or full-text files for paper %@.", paperID]
                                        code:522];
      return nil;
    }

    if (includesPDFs) {
      NSDictionary *source = [paper[@"source"] isKindOfClass:NSDictionary.class] ? paper[@"source"] : @{};
      NSString *pdfPath = [source[@"pdfPath"] isKindOfClass:NSString.class]
          ? source[@"pdfPath"] : ([paper[@"pdfPath"] isKindOfClass:NSString.class] ? paper[@"pdfPath"] : nil);
      BOOL pdfClosed = pdfPath.length > 0 && [self isSafeWorkspaceRelativePath:pdfPath] &&
          [pdfPath isEqualToString:pdfPath.stringByStandardizingPath] &&
          [pdfPath hasPrefix:@"Library/PDFs/"] && [seenPaths containsObject:pdfPath] &&
          [verifiedHashes[pdfPath] length] == 64;
      if (!pdfClosed) {
        if (error) *error = [self storageError:
            [NSString stringWithFormat:@"The backup declares PDFs but does not close over the managed PDF for paper %@.", paperID]
                                          code:523];
        return nil;
      }
      NSString *recordedSourceHash = [source[@"sha256"] isKindOfClass:NSString.class]
          ? [source[@"sha256"] lowercaseString] : nil;
      if (recordedSourceHash.length > 0 &&
          (recordedSourceHash.length != 64 || ![recordedSourceHash isEqualToString:verifiedHashes[pdfPath]])) {
        if (error) *error = [self storageError:
            [NSString stringWithFormat:@"The graph PDF hash for paper %@ does not match the verified file in the backup.", paperID]
                                          code:524];
        return nil;
      }
    }
  }
  return manifest;
}

- (BOOL)copyVerifiedBackupManifest:(NSDictionary *)manifest
                     fromWorkspace:(NSURL *)sourceWorkspace
                       toWorkspace:(NSURL *)destinationWorkspace
                             error:(NSError **)error {
  NSFileManager *manager = NSFileManager.defaultManager;
  if (![manager createDirectoryAtURL:destinationWorkspace
          withIntermediateDirectories:YES
                           attributes:nil
                                error:error]) return NO;
  BOOL includesPDFs = [manifest[@"includesPDFs"] boolValue];
  for (NSDictionary *entry in manifest[@"files"]) {
    NSString *relativePath = [entry[@"path"] isKindOfClass:NSString.class] ? entry[@"path"] : nil;
    NSString *expectedHash = [entry[@"sha256"] isKindOfClass:NSString.class]
        ? [entry[@"sha256"] lowercaseString] : nil;
    if (![self isAllowedBackupRelativePath:relativePath includePDFs:includesPDFs] ||
        ![relativePath isEqualToString:relativePath.stringByStandardizingPath] || expectedHash.length != 64) {
      if (error) *error = [self storageError:@"A restore file record became invalid before copying." code:525];
      return NO;
    }
    NSURL *sourceURL = [sourceWorkspace URLByAppendingPathComponent:relativePath];
    NSNumber *isRegularFile = nil;
    NSNumber *isSymbolicLink = nil;
    if (![sourceURL getResourceValue:&isRegularFile forKey:NSURLIsRegularFileKey error:error] ||
        ![sourceURL getResourceValue:&isSymbolicLink forKey:NSURLIsSymbolicLinkKey error:error] ||
        !isRegularFile.boolValue || isSymbolicLink.boolValue) {
      if (error && !*error) *error = [self storageError:
          [NSString stringWithFormat:@"A restore source file is missing or changed type: %@", relativePath]
                                        code:526];
      return NO;
    }
    NSURL *destinationURL = [destinationWorkspace URLByAppendingPathComponent:relativePath];
    if (![manager createDirectoryAtURL:destinationURL.URLByDeletingLastPathComponent
            withIntermediateDirectories:YES
                             attributes:nil
                                  error:error] ||
        ![manager copyItemAtURL:sourceURL toURL:destinationURL error:error]) {
      return NO;
    }
    NSString *copiedHash = [self sha256ForFileAtURL:destinationURL error:error];
    if (![copiedHash isEqualToString:expectedHash]) {
      if (error) *error = [self storageError:
          [NSString stringWithFormat:@"A restored file hash does not match after copying: %@", relativePath]
                                        code:527];
      return NO;
    }
  }
  return YES;
}

- (NSDictionary *)importWorkspaceBackupAtURL:(NSURL *)backupURL error:(NSError **)error {
  NSDictionary *manifest = [self validateBackupAtURL:backupURL error:error];
  if (!manifest) return nil;
  NSFileManager *manager = NSFileManager.defaultManager;
  NSString *recoveryID = [NSString stringWithFormat:@"recovered-%@", NSUUID.UUID.UUIDString.lowercaseString];
  NSURL *destination = [[self workspaceRecoveryDirectoryURL] URLByAppendingPathComponent:recoveryID isDirectory:YES];
  NSURL *temporary = [[self workspaceRecoveryDirectoryURL] URLByAppendingPathComponent:
      [NSString stringWithFormat:@".%@.tmp", recoveryID] isDirectory:YES];
  if (![manager createDirectoryAtURL:temporary
          withIntermediateDirectories:YES
                           attributes:nil
                                error:error]) return nil;
  @try {
    NSURL *sourceWorkspace = [backupURL URLByAppendingPathComponent:@"Workspace" isDirectory:YES];
    NSURL *recoveredWorkspace = [temporary URLByAppendingPathComponent:@"Workspace" isDirectory:YES];
    if (![self copyVerifiedBackupManifest:manifest
                            fromWorkspace:sourceWorkspace
                              toWorkspace:recoveredWorkspace
                                    error:error]) return nil;
    NSMutableDictionary *recoveryManifest = [manifest mutableCopy];
    recoveryManifest[@"recoveryId"] = recoveryID;
    recoveryManifest[@"recoveredAt"] = [self isoTimestamp];
    recoveryManifest[@"activeWorkspaceUntouched"] = @YES;
    if (![self writeJSONObject:recoveryManifest
                         toURL:[temporary URLByAppendingPathComponent:@"recovery.json"]
                         error:error] ||
        ![manager moveItemAtURL:temporary toURL:destination error:error]) {
      return nil;
    }
    return @{
      @"recoveryId": recoveryID,
      @"path": destination.path,
      @"activeWorkspaceUntouched": @YES,
      @"manifest": manifest
    };
  } @finally {
    if ([manager fileExistsAtPath:temporary.path]) [manager removeItemAtURL:temporary error:nil];
  }
}

- (void)presentWorkspaceExporterIncludingPDFs:(BOOL)includePDFs {
  NSSavePanel *panel = [NSSavePanel savePanel];
  panel.title = @"Export Liteverse Workspace Backup";
  panel.prompt = @"Export";
  panel.nameFieldStringValue = [NSString stringWithFormat:@"Liteverse-%@.liteverse-backup",
      [NSDate.date.description substringToIndex:10]];
  [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
    if (result != NSModalResponseOK || !panel.URL) return;
    dispatch_async(self->_persistenceQueue, ^{
      NSError *error = nil;
      NSDictionary *manifest = [self exportWorkspaceToURL:panel.URL includePDFs:includePDFs error:&error];
      if (!manifest) {
        [self sendWorkspaceErrorForAction:@"exportWorkspace" error:error];
        return;
      }
      dispatch_async(dispatch_get_main_queue(), ^{
        [self.webView callAsyncJavaScript:
            @"window.__liteverseWorkspaceExported && window.__liteverseWorkspaceExported(exportPayload);"
                                  arguments:@{ @"exportPayload": @{
                                    @"path": panel.URL.path,
                                    @"manifest": manifest
                                  } }
                                    inFrame:nil
                             inContentWorld:WKContentWorld.pageWorld
                          completionHandler:nil];
      });
      [self sendWorkspaceWithNotice:@"The Liteverse workspace backup was exported."];
    });
  }];
}

- (void)presentWorkspaceImporter {
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.title = @"Validate and Import Liteverse Workspace Backup";
  panel.prompt = @"Import as Restore Workspace";
  panel.canChooseFiles = YES;
  panel.canChooseDirectories = YES;
  panel.allowsMultipleSelection = NO;
  [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
    if (result != NSModalResponseOK || !panel.URL) return;
    dispatch_async(self->_persistenceQueue, ^{
      NSError *error = nil;
      NSDictionary *importResult = [self importWorkspaceBackupAtURL:panel.URL error:&error];
      if (!importResult) {
        [self sendWorkspaceErrorForAction:@"importWorkspace" error:error];
        return;
      }
      dispatch_async(dispatch_get_main_queue(), ^{
        [self.webView callAsyncJavaScript:
            @"window.__liteverseWorkspaceImported && window.__liteverseWorkspaceImported(importPayload);"
                                  arguments:@{ @"importPayload": importResult }
                                    inFrame:nil
                             inContentWorld:WKContentWorld.pageWorld
                          completionHandler:nil];
      });
      [self sendWorkspaceWithNotice:@"The backup was validated and imported into the restore area; the current workspace was not overwritten."];
    });
  }];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  [self configureApplicationMenus];
  dispatch_queue_attr_t persistenceAttributes = dispatch_queue_attr_make_with_autorelease_frequency(
      DISPATCH_QUEUE_SERIAL, DISPATCH_AUTORELEASE_FREQUENCY_WORK_ITEM);
  _persistenceQueue = dispatch_queue_create("com.liteverse.persistence", persistenceAttributes);
  _sourceHashCache = [NSMutableDictionary dictionary];
  WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
  [configuration.userContentController addScriptMessageHandler:self name:@"liteverse"];
  NSString *diagnostics =
      @"window.addEventListener('error', function(event) {"
       " window.webkit.messageHandlers.liteverse.postMessage({action:'runtimeError', message:event.message || 'unknown error', source:event.filename || '', line:event.lineno || 0});"
       "});"
       "window.addEventListener('unhandledrejection', function(event) {"
       " window.webkit.messageHandlers.liteverse.postMessage({action:'runtimeError', message:String(event.reason || 'unhandled rejection'), source:'promise', line:0});"
       "});";
  WKUserScript *diagnosticScript = [[WKUserScript alloc] initWithSource:diagnostics
                                                          injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                       forMainFrameOnly:YES];
  [configuration.userContentController addUserScript:diagnosticScript];

  self.webView = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
  self.webView.navigationDelegate = self;
  self.webView.allowsMagnification = NO;
  self.webView.wantsLayer = YES;
  self.webView.layer.backgroundColor = NSColor.blackColor.CGColor;

  NSRect visibleFrame = NSScreen.mainScreen ? NSScreen.mainScreen.visibleFrame : NSMakeRect(0, 0, 1320, 820);
  CGFloat initialWidth = MIN(1320, MAX(900, visibleFrame.size.width - 48));
  CGFloat initialHeight = MIN(820, MAX(620, visibleFrame.size.height - 48));
  NSRect frame = NSMakeRect(0, 0, initialWidth, initialHeight);
  NSWindowStyleMask style =
      NSWindowStyleMaskTitled |
      NSWindowStyleMaskClosable |
      NSWindowStyleMaskMiniaturizable |
      NSWindowStyleMaskResizable;
  self.window = [[NSWindow alloc] initWithContentRect:frame
                                            styleMask:style
                                              backing:NSBackingStoreBuffered
                                                defer:NO];
  self.window.title = @"Liteverse";
  self.window.minSize = NSMakeSize(900, 620);
  self.window.backgroundColor = NSColor.blackColor;
  self.window.contentView = self.webView;
  NSRect outerFrame = self.window.frame;
  outerFrame.origin.x = NSMidX(visibleFrame) - outerFrame.size.width * 0.5;
  outerFrame.origin.y = NSMidY(visibleFrame) - outerFrame.size.height * 0.5;
  [self.window setFrameOrigin:outerFrame.origin];
  [self.window makeKeyAndOrderFront:nil];

  NSURL *resourceURL = NSBundle.mainBundle.resourceURL;
  self.webDirectoryURL = [resourceURL URLByAppendingPathComponent:@"web" isDirectory:YES];
  NSURL *indexURL = [self.webDirectoryURL URLByAppendingPathComponent:@"index.html"];
  // CFBundleIconFile already points to the optimized ICNS. Avoid decoding the
  // 1254px web brand image a second time in the native process.
  // Bootstrap and repair the local runtime store before the web layer starts.
  // This also backfills packaged knowledge cards for users upgrading from a
  // build that already has Graph/current.json but no Knowledge/cards files.
  NSError *storageError = nil;
  if (![self ensureRuntimeGraphStorage:&storageError]) {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Liteverse Could Not Initialize the Literature Library";
    alert.informativeText = storageError.localizedDescription ?: @"Application Support data initialization failed.";
    [alert runModal];
    [NSApp terminate:nil];
    return;
  }
  if (indexURL && [NSFileManager.defaultManager fileExistsAtPath:indexURL.path]) {
    [self.webView loadFileURL:indexURL allowingReadAccessToURL:self.webDirectoryURL];
  } else {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Liteverse Could Not Start";
    alert.informativeText = @"The app bundle is missing universe resources. Rebuild Liteverse.app.";
    [alert runModal];
    [NSApp terminate:nil];
  }

  [NSApp activateIgnoringOtherApps:YES];
}

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  NSURL *URL = navigationAction.request.URL;
  NSString *scheme = URL.scheme.lowercaseString;
  BOOL isMainFrame = navigationAction.targetFrame == nil || navigationAction.targetFrame.isMainFrame;
  if (isMainFrame && ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"])) {
    [NSWorkspace.sharedWorkspace openURL:URL];
    decisionHandler(WKNavigationActionPolicyCancel);
    return;
  }
  if (isMainFrame && [scheme isEqualToString:@"file"]) {
    NSString *allowedRoot = self.webDirectoryURL.URLByStandardizingPath.path;
    NSString *requestedPath = URL.URLByStandardizingPath.path;
    if (![requestedPath hasPrefix:allowedRoot]) {
      decisionHandler(WKNavigationActionPolicyCancel);
      return;
    }
  }
  decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  [webView evaluateJavaScript:
      @"JSON.stringify({ready:document.readyState,root:document.getElementById('root')?.innerHTML.length||0,scripts:document.scripts.length,scriptBytes:document.scripts[0]?.textContent.length||0,boot:window.__liteverseBoot||null,body:document.body.innerText.slice(0,120)})"
         completionHandler:^(id result, NSError *error) {
    NSLog(@"Liteverse document state: %@ error=%@", result, error);
  }];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
  if (_pendingRefreshSource) {
    dispatch_source_cancel(_pendingRefreshSource);
    _pendingRefreshSource = nil;
  }
  if (_workspaceSource) {
    dispatch_source_cancel(_workspaceSource);
    _workspaceSource = nil;
  }
}

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
  if (![message.name isEqualToString:@"liteverse"] ||
      !message.frameInfo.isMainFrame ||
      ![message.body isKindOfClass:NSDictionary.class]) {
    return;
  }
  NSDictionary *payload = (NSDictionary *)message.body;
  NSString *action = payload[@"action"];
  if ([action isEqualToString:@"runtimeError"]) {
    NSLog(@"Liteverse runtime error: %@ (%@:%@)", payload[@"message"], payload[@"source"], payload[@"line"]);
    return;
  }
  if ([action isEqualToString:@"loadUniverse"]) {
    dispatch_async(_persistenceQueue, ^{ [self loadAndSendUniverse]; });
    return;
  }
  if ([action isEqualToString:@"observePendingRefresh"]) {
    dispatch_async(_persistenceQueue, ^{ [self startPendingRefreshObservation]; });
    return;
  }
  if ([action isEqualToString:@"commitRefresh"]) {
    dispatch_async(_persistenceQueue, ^{ [self commitRefreshPayload:payload]; });
    return;
  }
  if ([action isEqualToString:@"loadAnnotations"]) {
    NSError *annotationError = nil;
    NSArray *annotations = [self readAnnotationsWithError:&annotationError];
    if (!annotations) [self sendWorkspaceErrorForAction:@"loadAnnotations" error:annotationError];
    else [self sendAnnotations:annotations savedID:nil];
    return;
  }
  if ([action isEqualToString:@"saveAnnotation"] &&
      [payload[@"annotation"] isKindOfClass:NSDictionary.class]) {
    [self saveAnnotation:payload[@"annotation"]];
    return;
  }
  if ([action isEqualToString:@"loadWorkspace"]) {
    dispatch_async(_persistenceQueue, ^{ [self startWorkspaceObservation]; });
    return;
  }
  if ([action isEqualToString:@"loadWorkspaceHealth"]) {
    dispatch_async(_persistenceQueue, ^{ [self sendWorkspaceHealth]; });
    return;
  }
  if ([action isEqualToString:@"exportWorkspace"]) {
    [self presentWorkspaceExporterIncludingPDFs:[payload[@"includePDFs"] boolValue]];
    return;
  }
  if ([action isEqualToString:@"importWorkspace"] || [action isEqualToString:@"restoreWorkspace"]) {
    [self presentWorkspaceImporter];
    return;
  }
  if ([action isEqualToString:@"syncCatalog"] &&
      [payload[@"items"] isKindOfClass:NSArray.class]) {
    [self syncCatalogItems:payload[@"items"]];
    return;
  }
  if ([action isEqualToString:@"pickLiteraturePDF"]) {
    [self presentPDFImporter];
    return;
  }
  if ([action isEqualToString:@"saveArxiv"]) {
    [self saveArxivValue:payload[@"value"]];
    return;
  }
  if ([action isEqualToString:@"saveResearchInformation"]) {
    [self saveResearchText:payload[@"text"] projectID:payload[@"projectId"]];
    return;
  }
  if ([action isEqualToString:@"setActiveProject"] && [payload[@"projectId"] isKindOfClass:NSString.class]) {
    [self setActiveProjectID:payload[@"projectId"]];
    return;
  }
  if ([action isEqualToString:@"createProject"] && [payload[@"name"] isKindOfClass:NSString.class]) {
    [self createProjectNamed:payload[@"name"]];
    return;
  }
  if ([action isEqualToString:@"saveContextRequest"]) {
    [self saveContextRequest:payload];
    return;
  }
  if ([action isEqualToString:@"searchLiterature"] && [payload[@"query"] isKindOfClass:NSString.class]) {
    NSString *query = [payload[@"query"] copy];
    NSString *requestID = [payload[@"requestId"] isKindOfClass:NSString.class]
        ? [payload[@"requestId"] copy] : NSUUID.UUID.UUIDString.lowercaseString;
    NSInteger limit = [payload[@"limit"] isKindOfClass:NSNumber.class] ? [payload[@"limit"] integerValue] : 10;
    dispatch_async(_persistenceQueue, ^{
      @autoreleasepool {
        NSError *searchError = nil;
        NSDictionary *result = [self searchLiteratureAtIndexForQuery:query limit:limit error:&searchError];
        if (!result) {
          [self sendLiteratureSearchError:searchError requestID:requestID];
          return;
        }
        NSMutableDictionary *response = [result mutableCopy];
        response[@"requestId"] = requestID;
        dispatch_async(dispatch_get_main_queue(), ^{
          [self.webView callAsyncJavaScript:
              @"window.__liteverseReceiveLiteratureSearch && window.__liteverseReceiveLiteratureSearch(searchPayload);"
                                    arguments:@{ @"searchPayload": response }
                                      inFrame:nil
                               inContentWorld:WKContentWorld.pageWorld
                            completionHandler:nil];
        });
      }
    });
    return;
  }
  if ([action isEqualToString:@"loadKnowledgeCard"] &&
      [payload[@"paperId"] isKindOfClass:NSString.class] &&
      [payload[@"path"] isKindOfClass:NSString.class]) {
    NSString *expectedSHA256 = [payload[@"expectedSha256"] isKindOfClass:NSString.class]
        ? payload[@"expectedSha256"] : nil;
    [self loadKnowledgeCardForPaperID:payload[@"paperId"]
                                 path:payload[@"path"]
                       expectedSHA256:expectedSHA256];
    return;
  }
  if (([action isEqualToString:@"openLibraryItem"] || [action isEqualToString:@"openExternalArxiv"]) &&
      [payload[@"id"] isKindOfClass:NSString.class]) {
    [self openLibraryItemID:payload[@"id"] externalArxiv:[action isEqualToString:@"openExternalArxiv"]];
    return;
  }
  NSString *path = payload[@"path"];
  if (![action isEqualToString:@"open"] || ![path isKindOfClass:NSString.class]) return;
  NSString *standardized = path.stringByStandardizingPath;
  BOOL allowedRelativePath = !path.isAbsolutePath && [self isSafeWorkspaceRelativePath:path] &&
      ([standardized hasPrefix:@"Knowledge/cards/"] ||
       [standardized hasPrefix:@"Knowledge/fulltext/"] ||
       [standardized hasPrefix:@"Knowledge/artifacts/"] ||
       ([standardized hasPrefix:@"Projects/"] && [standardized containsString:@"/context-packs/"] &&
        ([standardized.pathExtension.lowercaseString isEqualToString:@"json"] ||
         [standardized.pathExtension.lowercaseString isEqualToString:@"md"])) ||
       [standardized hasPrefix:@"Library/PDFs/"]);
  NSString *resolvedPath = allowedRelativePath
      ? [self URLForWorkspaceRelativePath:standardized error:nil].path : nil;
  if (!resolvedPath) {
    [self sendWorkspaceErrorForAction:@"open"
                                error:[self storageError:@"Only Liteverse-managed PDFs, knowledge cards, and full-text files may be opened." code:506]];
    return;
  }
  if ([NSFileManager.defaultManager fileExistsAtPath:resolvedPath]) {
    [NSWorkspace.sharedWorkspace openURL:[NSURL fileURLWithPath:resolvedPath]];
  } else {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"File Not Found";
    alert.informativeText = resolvedPath;
    [alert beginSheetModalForWindow:self.window completionHandler:nil];
  }
}

@end

#ifndef LITEVERSE_TESTING
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSApplication *application = NSApplication.sharedApplication;
    LiteverseAppDelegate *delegate = [[LiteverseAppDelegate alloc] init];
    application.delegate = delegate;
    [application setActivationPolicy:NSApplicationActivationPolicyRegular];
    [application run];
  }
  return 0;
}
#endif
