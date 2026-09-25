import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const assetRoot = path.join(root, "public", "universe");
const HEADER_BYTES = 32;
const RECORD_BYTES = 12;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
const ARCHETYPE_IDS = [
  "g01-grand-design-spiral",
  "g02-barred-spiral",
  "g03-flocculent-spiral",
  "g04-elliptical",
  "g05-lenticular",
  "g06-ring",
  "g07-irregular-dwarf",
  "g08-interacting-pair",
  "g09-starburst",
  "g10-seyfert-spiral",
];

async function loadManifest() {
  return JSON.parse(await readFile(path.join(assetRoot, "manifest.json"), "utf8"));
}

function decodeHeader(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    magic: buf.subarray(0, 4).toString("latin1"),
    version: view.getUint32(4, true),
    pointCount: view.getUint32(8, true),
    flags: view.getUint32(12, true),
    radius: view.getFloat32(16, true),
    reserved: [view.getFloat32(20, true), view.getFloat32(24, true), view.getFloat32(28, true)],
    view,
  };
}

function checkAsset(entry, buf, { populations }) {
  assert.equal(buf.byteLength, entry.byteLength, `${entry.file} byteLength`);
  assert.equal(createHash("sha256").update(buf).digest("hex"), entry.sha256, `${entry.file} sha256`);
  const h = decodeHeader(buf);
  assert.equal(h.magic, "LVPC");
  assert.equal(h.version, 1);
  assert.equal(h.flags, 0);
  assert.deepEqual(h.reserved, [0, 0, 0]);
  assert.equal(h.pointCount, entry.pointCount);
  assert.equal(buf.byteLength, HEADER_BYTES + h.pointCount * RECORD_BYTES);
  assert.ok(h.radius > 0 && Number.isFinite(h.radius));
  assert.ok(Math.abs(h.radius - entry.radius) <= 1e-6 * entry.radius);

  const counts = new Map();
  const prefixCounts = new Map();
  const prefix = Math.floor(h.pointCount / 10);
  let maxNorm = 0;
  for (let i = 0; i < h.pointCount; i += 1) {
    const o = HEADER_BYTES + i * RECORD_BYTES;
    const x = (h.view.getInt16(o, true) / 32767) * h.radius;
    const y = (h.view.getInt16(o + 2, true) / 32767) * h.radius;
    const z = (h.view.getInt16(o + 4, true) / 32767) * h.radius;
    for (const c of [x, y, z]) assert.ok(Math.abs(c) <= h.radius * (1 + 1e-6));
    maxNorm = Math.max(maxNorm, Math.hypot(x, y, z));
    const pop = buf[o + 10];
    assert.ok(populations.includes(pop), `${entry.file} point ${i} population ${pop}`);
    counts.set(pop, (counts.get(pop) ?? 0) + 1);
    if (i < prefix) prefixCounts.set(pop, (prefixCounts.get(pop) ?? 0) + 1);
  }
  assert.ok(maxNorm <= h.radius * (1 + 1e-4), `${entry.file} decoded positions within radius`);
  assert.ok(maxNorm >= h.radius * 0.999, `${entry.file} radius is the max |position|`);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, h.pointCount);
  assert.equal(
    Object.values(entry.populations).reduce((a, b) => a + b, 0),
    h.pointCount,
    `${entry.file} manifest population counts`,
  );
  // Points are shuffled: a 10 % prefix keeps population shares (LOD contract).
  for (const [pop, n] of counts) {
    const share = n / total;
    if (share < 0.02) continue;
    const prefixShare = (prefixCounts.get(pop) ?? 0) / prefix;
    assert.ok(Math.abs(prefixShare - share) < 0.03, `${entry.file} prefix share for population ${pop}`);
  }
}

test("universe manifest lists the ten archetypes and the deep field", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.schemaVersion, "liteverse-universe-assets-v1");
  assert.equal(manifest.generator.tool, "tools/blender/build_universe_assets.py");
  assert.match(manifest.generator.scriptSha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof manifest.generator.blenderVersion, "string");
  assert.ok(Number.isInteger(manifest.generator.seed));
  assert.deepEqual(
    manifest.galaxies.map((g) => g.id),
    ARCHETYPE_IDS,
  );
  for (const g of manifest.galaxies) {
    assert.equal(g.file, `galaxies/${g.id}.lvpc`);
    assert.equal(g.pointCount, manifest.generator.points);
    assert.equal(g.dominantColor.length, 3);
    assert.ok(g.sizeScale > 0);
  }
  assert.equal(manifest.deepField.file, "deep-field.lvpc");
});

test("universe assets match the manifest and decode correctly", async () => {
  const manifest = await loadManifest();
  let totalBytes = (await stat(path.join(assetRoot, "manifest.json"))).size;
  for (const entry of manifest.galaxies) {
    const buf = await readFile(path.join(assetRoot, entry.file));
    checkAsset(entry, buf, { populations: [0, 1, 2, 3, 4, 5] });
    totalBytes += buf.byteLength;
  }
  const deep = await readFile(path.join(assetRoot, manifest.deepField.file));
  checkAsset(manifest.deepField, deep, { populations: [6, 7] });
  totalBytes += deep.byteLength;
  assert.ok(totalBytes <= MAX_TOTAL_BYTES, `public/universe is ${totalBytes} bytes`);
});
