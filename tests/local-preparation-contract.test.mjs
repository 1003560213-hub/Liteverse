import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillURL = new URL("../skills/liteverse-curator/SKILL.md", import.meta.url);
const contractURL = new URL("../skills/liteverse-curator/references/local-preparation-contract.md", import.meta.url);

test("local preparation remains draft-only and outside graph, usage, and memory truth", async () => {
  const [skill, contract] = await Promise.all([
    readFile(skillURL, "utf8"),
    readFile(contractURL, "utf8"),
  ]);

  assert.match(skill, /optional `preparation` record/);
  assert.match(skill, /verify the local-job manifest/);
  assert.match(contract, /liteverse-local-job-v1/);
  assert.match(contract, /liteverse-local-result-v1/);
  assert.match(contract, /card_draft/);
  assert.match(contract, /review-packet\.json/);
  assert.match(contract, /routing_only/);
  assert.match(contract, /never.*Graph\/current\.json/i);
  assert.match(contract, /never.*Usage/i);
  assert.match(contract, /never.*project memory/i);
  assert.match(contract, /not original-source evidence/i);
});
