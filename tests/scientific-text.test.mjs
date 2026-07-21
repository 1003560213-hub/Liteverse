import assert from "node:assert/strict";
import test from "node:test";

import { scientificSegments } from "../app/universe/scientific-text.ts";

test("scientific text preserves underscores, commands, and formula boundaries", () => {
  const input = "Use rho_core, M_200, $f_{15}$, \\rho_{\\mathrm{core}}, \\Gamma, and `array_name`.";
  const segments = scientificSegments(input);
  const reconstructed = segments.map((segment) => segment.value).join("");

  assert.equal(reconstructed.includes("rho_core"), true);
  assert.equal(reconstructed.includes("M_200"), true);
  assert.equal(reconstructed.includes("f_{15}"), true);
  assert.equal(reconstructed.includes("\\rho_{\\mathrm{core}}"), true);
  assert.equal(reconstructed.includes("\\Gamma"), true);
  assert.deepEqual(
    segments.filter((segment) => segment.kind === "code").map((segment) => segment.value),
    ["array_name"],
  );
  assert.equal(segments.some((segment) => segment.kind === "math" && segment.value === "rho_core"), true);
  assert.equal(segments.some((segment) => segment.kind === "math" && segment.value === "M_200"), true);
});

test("display and inline delimiters remain distinct without interpreting HTML", () => {
  const segments = scientificSegments("$$E = mc^2$$ and \\(r_c\\) <script>alert(1)</script>");
  assert.deepEqual(segments.filter((segment) => segment.kind === "math"), [
    { kind: "math", value: "E = mc^2", block: true },
    { kind: "math", value: "r_c", block: false },
  ]);
  assert.equal(segments.map((segment) => segment.value).join("").includes("<script>"), true);
});
