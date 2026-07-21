#define LITEVERSE_TESTING 1
#import "../macos/LiteverseApp.m"

@interface LiteverseBackupTestDelegate : LiteverseAppDelegate
@property(nonatomic, strong) NSURL *testSupportURL;
@end

@implementation LiteverseBackupTestDelegate
- (NSURL *)applicationSupportURL {
  [NSFileManager.defaultManager createDirectoryAtURL:self.testSupportURL
                          withIntermediateDirectories:YES
                                           attributes:nil
                                                error:nil];
  return self.testSupportURL;
}
@end

static int reportFailure(NSError *error) {
  fprintf(stderr, "%s\n", (error.localizedDescription ?: @"backup operation failed").UTF8String);
  return 2;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 4 && strcmp(argv[1], "search") == 0) {
      LiteverseBackupTestDelegate *delegate = [[LiteverseBackupTestDelegate alloc] init];
      delegate.testSupportURL = [[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]] isDirectory:YES]
          URLByResolvingSymlinksInPath];
      NSError *error = nil;
      NSDictionary *result = [delegate
          searchLiteratureAtIndexForQuery:[NSString stringWithUTF8String:argv[3]]
                                     limit:10
                                     error:&error];
      if (!result) return reportFailure(error);
      NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:&error];
      if (!json) return reportFailure(error);
      fwrite(json.bytes, 1, json.length, stdout);
      fputc('\n', stdout);
      return 0;
    }
    if (argc == 3 && strcmp(argv[1], "partition") == 0) {
      LiteverseBackupTestDelegate *delegate = [[LiteverseBackupTestDelegate alloc] init];
      delegate.testSupportURL = [[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]] isDirectory:YES]
          URLByResolvingSymlinksInPath];
      NSError *error = nil;
      NSDictionary *proposal = [delegate validatedPartitionProposalsAtURL:[delegate partitionProposalsURL]
                                                                    error:&error];
      if (!proposal || ![delegate partitionProposals:proposal
                                  closeTruthUnderRoot:delegate.testSupportURL
                                                error:&error]) {
        return reportFailure(error);
      }
      NSDictionary *result = @{
        @"status": proposal[@"status"],
        @"pending": @([proposal[@"status"] isEqualToString:@"awaiting_user"])
      };
      NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:&error];
      if (!json) return reportFailure(error);
      fwrite(json.bytes, 1, json.length, stdout);
      fputc('\n', stdout);
      return 0;
    }
    if (argc == 4 && strcmp(argv[1], "linked-scan") == 0) {
      LiteverseBackupTestDelegate *delegate = [[LiteverseBackupTestDelegate alloc] init];
      delegate.testSupportURL = [[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]] isDirectory:YES]
          URLByResolvingSymlinksInPath];
      NSURL *rootURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[3]] isDirectory:YES];
      NSError *error = nil;
      NSArray *descriptors = [delegate linkedPDFDescriptorsUnderRootURL:rootURL error:&error];
      if (!descriptors) return reportFailure(error);
      NSData *json = [NSJSONSerialization dataWithJSONObject:descriptors options:0 error:&error];
      if (!json) return reportFailure(error);
      fwrite(json.bytes, 1, json.length, stdout);
      fputc('\n', stdout);
      return 0;
    }
    if (argc == 2) {
      LiteverseAppDelegate *delegate = [[LiteverseAppDelegate alloc] init];
      NSError *error = nil;
      NSURL *backupURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]] isDirectory:YES];
      NSDictionary *manifest = [delegate validateBackupAtURL:backupURL error:&error];
      if (!manifest) return reportFailure(error);
      printf("validated %lu files\n", (unsigned long)[manifest[@"files"] count]);
      return 0;
    }
    if (argc == 4 && strcmp(argv[1], "import") == 0) {
      LiteverseBackupTestDelegate *delegate = [[LiteverseBackupTestDelegate alloc] init];
      delegate.testSupportURL = [[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[3]] isDirectory:YES]
          URLByResolvingSymlinksInPath];
      NSError *error = nil;
      NSURL *backupURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]] isDirectory:YES];
      NSDictionary *result = [delegate importWorkspaceBackupAtURL:backupURL error:&error];
      if (!result) return reportFailure(error);
      printf("%s\n", [result[@"path"] UTF8String]);
      return 0;
    }
    if (argc == 5 && strcmp(argv[1], "export") == 0) {
      LiteverseBackupTestDelegate *delegate = [[LiteverseBackupTestDelegate alloc] init];
      delegate.testSupportURL = [[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]] isDirectory:YES]
          URLByResolvingSymlinksInPath];
      NSURL *destination = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[3]] isDirectory:YES];
      NSError *error = nil;
      NSDictionary *manifest = [delegate exportWorkspaceToURL:destination
                                                   includePDFs:atoi(argv[4]) != 0
                                                         error:&error];
      if (!manifest) return reportFailure(error);
      printf("exported %lu files\n", (unsigned long)[manifest[@"files"] count]);
      return 0;
    }
    {
      fprintf(stderr, "usage: native-backup-validator <backup-directory> | partition <support> | linked-scan <support> <folder> | search <support> <query> | import <backup> <support> | export <support> <destination> <include-pdfs>\n");
      return 64;
    }
  }
}
