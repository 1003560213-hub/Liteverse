import assert from "node:assert/strict";
import { test } from "node:test";

import { screenIncrementalClassification } from "../skills/liteverse-curator/scripts/screen-incremental-classification.mjs";

const snapshot = {
  revision: 7,
  categories: [
    { id: "halo-structure", name: "Halo Structure", description: "soliton cores halo density profiles wave dark matter" },
    { id: "lensing", name: "Gravitational Lensing", description: "lensing convergence caustics critical curves observables" },
  ],
  papers: [
    { id: "halo-a", primaryCategory: "halo-structure", title: "Soliton core halo profiles", summary: "wave dark matter density and core radius", tags: ["soliton", "halo"] },
    { id: "lens-a", primaryCategory: "lensing", title: "Strong lensing by compact structures", summary: "critical curves convergence and caustics", tags: ["lensing"] },
  ],
};

test("incremental screening deterministically reuses an existing macro taxonomy", () => {
  const input = { papers: [
    { paperId: "new-halo", title: "Time evolution of a soliton halo", abstract: "wave dark matter core density profile and core radius evolution" },
    { paperId: "new-lens", title: "Analytic lensing model", candidateText: "convergence critical curves caustics and lensing observables" },
  ] };
  const first = screenIncrementalClassification(snapshot, input);
  const second = screenIncrementalClassification(snapshot, input);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, "liteverse-incremental-classification-v1");
  assert.equal(first.routingOnly, true);
  assert.equal(first.writesGraph, false);
  assert.equal(first.assignments[0].recommendedCategoryId, "halo-structure");
  assert.equal(first.assignments[1].recommendedCategoryId, "lensing");
  assert.equal(first.repartitionAdvisory.proposeThreeOptions, false);
});

test("a single low-fit paper never requests a new macro region", () => {
  const result = screenIncrementalClassification(snapshot, [{
    id: "new-lab",
    title: "Cryogenic detector calibration",
    summary: "laboratory electronics temperature response and sensor noise",
  }]);
  assert.equal(result.repartitionAdvisory.lowFitPaperIds.length, 1);
  assert.equal(result.repartitionAdvisory.withinClusterConsistency, null);
  assert.equal(result.repartitionAdvisory.proposeThreeOptions, false);
});

test("invalid or duplicate batch identities fail closed", () => {
  assert.throws(() => screenIncrementalClassification(snapshot, [{ id: "Bad ID", title: "x" }]), /lowercase paperId/);
  assert.throws(() => screenIncrementalClassification(snapshot, [
    { id: "same", title: "one" },
    { id: "same", title: "two" },
  ]), /duplicate input paper/);
});
