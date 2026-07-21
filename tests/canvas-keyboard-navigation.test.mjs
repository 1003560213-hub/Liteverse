import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  canActivateCanvasTarget,
  canvasBackAction,
  canvasViewLevel,
  cycleCanvasTarget,
  memoryOrbitAngle,
} from "../app/universe/canvas-navigation.ts";

const root = path.resolve(import.meta.dirname, "..");

test("canvas target cycling wraps in both directions", () => {
  const targets = [
    { kind: "category", id: "nebula-1" },
    { kind: "galaxy", id: "galaxy-1" },
    { kind: "relation", key: "galaxy-1--galaxy-2" },
  ];
  assert.deepEqual(cycleCanvasTarget(targets, null, 1), targets[0]);
  assert.deepEqual(cycleCanvasTarget(targets, null, -1), targets[2]);
  assert.deepEqual(cycleCanvasTarget(targets, targets[2], 1), targets[0]);
  assert.deepEqual(cycleCanvasTarget(targets, targets[0], -1), targets[2]);
});

test("empty knowledge black holes are keyboard-focusable but cannot activate", () => {
  const target = { kind: "black-hole", categoryId: "nebula-1" };
  assert.equal(canActivateCanvasTarget(target, new Map()), false);
  assert.equal(canActivateCanvasTarget(target, new Map([["nebula-1", 1]])), true);
});

test("hierarchy view and Escape back actions preserve each navigation level", () => {
  const base = {
    categoryFilter: "all",
    selectedGalaxyId: null,
    notesCategoryId: null,
    selectedPaperId: null,
    selectedMemoryId: null,
    selectedRelationKey: null,
  };
  assert.equal(canvasViewLevel(base), "universe");
  assert.equal(canvasBackAction(base), "none");
  assert.equal(canvasViewLevel({ ...base, categoryFilter: "nebula-1" }), "galaxies");
  assert.equal(canvasBackAction({ ...base, categoryFilter: "nebula-1" }), "show-universe");
  assert.equal(canvasViewLevel({ ...base, categoryFilter: "nebula-1", selectedGalaxyId: "galaxy-1" }), "papers");
  assert.equal(canvasBackAction({ ...base, categoryFilter: "nebula-1", selectedGalaxyId: "galaxy-1" }), "show-nebula");
  assert.equal(canvasViewLevel({ ...base, categoryFilter: "nebula-1", notesCategoryId: "nebula-1" }), "notes");
  assert.equal(canvasBackAction({ ...base, categoryFilter: "nebula-1", selectedMemoryId: "note-1" }), "close-memory");
  assert.equal(canvasBackAction({ ...base, selectedPaperId: "paper-1" }), "close-paper");
  assert.equal(canvasBackAction({ ...base, selectedRelationKey: "relation-1" }), "close-relation");
});

test("reduced motion freezes personal knowledge orbits", () => {
  const frozenAtStart = memoryOrbitAngle(1.2, 1, 0, 2, true);
  const frozenLater = memoryOrbitAngle(1.2, 1, 90_000, 2, true);
  const animatedLater = memoryOrbitAngle(1.2, 1, 90_000, 2, false);
  assert.equal(frozenAtStart, 1.2);
  assert.equal(frozenLater, frozenAtStart);
  assert.notEqual(animatedLater, frozenAtStart);
});

test("the Canvas exposes keyboard instructions, focus announcements, and activation keys", async () => {
  const component = await readFile(
    path.join(root, "app", "universe", "LiteratureUniverse.tsx"),
    "utf8",
  );
  assert.match(component, /aria-describedby="universe-keyboard-help"/);
  assert.match(component, /aria-keyshortcuts="ArrowRight ArrowLeft ArrowDown ArrowUp Home End Enter Space Escape"/);
  assert.match(component, /onKeyDown=\{handleCanvasKeyDown\}/);
  assert.match(component, /cycleCanvasTarget\(/);
  assert.match(component, /key === "Enter" \|\| key === " "/);
  assert.match(component, /canActivateCanvasTarget\(target, noteCountByCategory\)/);
  assert.match(component, /No Notes\. Unavailable\./);
  assert.match(component, /role="status" aria-live="polite" aria-atomic="true"/);
});
