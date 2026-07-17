import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const syncScript = new URL("../scripts/sync-private-shared.mjs", import.meta.url);

test("public-to-private sync is allowlisted and cannot copy research state", async () => {
  const source = await readFile(syncScript, "utf8");

  assert.match(source, /const SHARED_PATHS = Object\.freeze/);
  assert.match(source, /"app"/);
  assert.match(source, /"macos\/LiteverseApp\.m"/);
  assert.match(source, /"skills"/);
  assert.match(source, /const FORBIDDEN_SEGMENTS = new Set/);
  for (const sensitivePath of ["data", "Graph", "Knowledge", "Projects", "Usage", ".openai"]) {
    assert.match(source, new RegExp(`"${sensitivePath.replace(".", "\\.")}"`));
  }

  const allowlistBlock = source.slice(
    source.indexOf("const SHARED_PATHS"),
    source.indexOf("const FORBIDDEN_SEGMENTS"),
  );
  assert.doesNotMatch(allowlistBlock, /Info\.plist|package\.json|README|data|Graph|Knowledge|Projects|Usage/);
  assert.match(source, /if \(mode === "write"\) await atomicCopy/);
  assert.match(source, /Private-only files were preserved/);
});
