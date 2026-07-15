#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { rebuildCounts } from "./_usage-ledger.mjs";

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  console.log(`Usage: rebuild-usage.mjs [--support-dir DIR] [--dry-run]

Reconstruct Usage/counts.json from the append-only events ledger. Duplicate
task/paper events count once. An incomplete final crash fragment is ignored;
invalid complete lines are rejected without changing the cache.`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const support = path.resolve(
    argument("--support-dir")
      ?? process.env.LITEVERSE_SUPPORT_DIR
      ?? path.join(homedir(), "Library", "Application Support", "Liteverse"),
  );
  const result = await rebuildCounts(support, !process.argv.includes("--dry-run"));
  console.log(JSON.stringify({
    status: process.argv.includes("--dry-run") ? "validated" : "rebuilt",
    ignoredPartialTail: result.ignoredPartialTail,
    ...result.cache,
  }, null, 2));
}

main().catch((error) => {
  console.error(`rebuild-usage: ${error.message}`);
  process.exitCode = 2;
});
