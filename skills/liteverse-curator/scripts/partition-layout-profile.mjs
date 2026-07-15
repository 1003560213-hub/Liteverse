const PROFILE_CELLS = Object.freeze([
  22, 36, 51, 48, 37, 32, 33, 36, 39, 44, 53, 54, 48, 43, 45, 52, 61, 75, 97, 109, 92, 63, 45, 32,
  22, 41, 68, 69, 53, 42, 41, 44, 47, 52, 63, 66, 58, 53, 57, 63, 71, 83, 98, 101, 82, 62, 50, 38,
  25, 38, 60, 70, 65, 55, 53, 58, 64, 68, 76, 80, 74, 72, 74, 81, 90, 102, 109, 99, 76, 65, 57, 43,
  36, 40, 53, 68, 72, 66, 62, 65, 74, 84, 97, 99, 98, 97, 95, 103, 117, 114, 101, 84, 69, 64, 57, 42,
  51, 53, 61, 76, 82, 76, 70, 68, 75, 92, 114, 123, 127, 124, 116, 116, 117, 98, 79, 70, 66, 58, 48, 40,
  50, 58, 68, 78, 83, 85, 84, 84, 86, 97, 117, 134, 142, 145, 132, 110, 93, 76, 65, 62, 64, 56, 44, 36,
  43, 55, 72, 76, 74, 85, 103, 115, 114, 119, 129, 137, 140, 144, 130, 101, 80, 69, 63, 57, 57, 53, 46, 42,
  44, 53, 68, 73, 68, 77, 102, 129, 141, 147, 151, 150, 146, 137, 119, 94, 77, 71, 67, 59, 58, 60, 61, 62,
  53, 56, 59, 67, 72, 79, 94, 116, 136, 153, 163, 160, 152, 139, 121, 98, 81, 74, 70, 70, 78, 88, 91, 89,
  53, 60, 60, 71, 86, 87, 87, 98, 115, 137, 152, 156, 153, 146, 133, 111, 95, 89, 91, 102, 119, 132, 123, 109,
  36, 46, 54, 69, 82, 82, 81, 91, 105, 119, 126, 131, 132, 133, 133, 123, 116, 116, 127, 141, 149, 149, 126, 106,
  26, 33, 43, 55, 65, 75, 87, 101, 115, 115, 107, 106, 110, 114, 120, 129, 136, 146, 157, 158, 140, 116, 92, 76,
  28, 33, 43, 56, 71, 85, 101, 109, 116, 114, 99, 97, 108, 116, 123, 134, 150, 166, 170, 153, 119, 86, 62, 47,
  38, 42, 54, 75, 94, 97, 93, 88, 93, 101, 97, 94, 103, 110, 120, 132, 146, 158, 155, 134, 103, 76, 53, 36,
  50, 57, 71, 88, 95, 88, 72, 64, 69, 88, 98, 90, 84, 81, 95, 118, 131, 137, 136, 120, 94, 71, 49, 32,
]);

// This is a deterministic, low-resolution visual-occupancy profile of the
// default 4:3 background after its CSS `cover center` crop at the canonical
// desktop viewport. Values combine broad perceptual brightness and local
// detail. Keeping the profile beside the Curator avoids decoding the PNG while
// building a graph and makes a given seed produce the same layout everywhere.
export const DEFAULT_BACKGROUND_LAYOUT_PROFILE = Object.freeze({
  schema: "liteverse-background-layout-profile-v1",
  source: "public/liteverse-nebula.png",
  sourceSha256: "e5d52b13c72b4d32d1c4d3a79f592759f29bbe68fad3fdd2cb8fb87f3ba6d34f",
  sourceWidth: 1448,
  sourceHeight: 1086,
  viewportWidth: 1320,
  viewportHeight: 820,
  objectFit: "cover",
  objectPosition: "center",
  gridWidth: 24,
  gridHeight: 15,
  cells: PROFILE_CELLS,
});

export const DEFAULT_LAYOUT_CAMERA = Object.freeze({
  rotationX: -0.08,
  rotationY: -0.22,
  zoom: 1.08,
  focalLength: 10,
  worldScaleFraction: 0.115,
  verticalCenterFraction: 0.51,
  regionWorldRadius: 1.55,
  footprintScaleX: 1.06,
  footprintScaleY: 0.86,
  safeInsets: Object.freeze({ left: 40, right: 70, top: 132, bottom: 32 }),
});

const FOOTPRINT_SAMPLES = Object.freeze([
  [0, 0, 5],
  [-0.38, 0, 3], [0.38, 0, 3], [0, -0.38, 3], [0, 0.38, 3],
  [-0.64, -0.34, 2], [0.64, -0.34, 2], [-0.64, 0.34, 2], [0.64, 0.34, 2],
  [-0.82, 0, 1], [0.82, 0, 1], [0, -0.82, 1], [0, 0.82, 1],
]);

export function projectDefaultLayoutCenter(
  position,
  profile = DEFAULT_BACKGROUND_LAYOUT_PROFILE,
  camera = DEFAULT_LAYOUT_CAMERA,
) {
  const [x0, y0, z0] = position;
  const cosY = Math.cos(camera.rotationY);
  const sinY = Math.sin(camera.rotationY);
  const x1 = x0 * cosY - z0 * sinY;
  const z1 = x0 * sinY + z0 * cosY;
  const cosX = Math.cos(camera.rotationX);
  const sinX = Math.sin(camera.rotationX);
  const y1 = y0 * cosX - z1 * sinX;
  const z2 = y0 * sinX + z1 * cosX;
  const perspective = camera.focalLength / (camera.focalLength + z2);
  const scale = Math.min(profile.viewportWidth, profile.viewportHeight)
    * camera.worldScaleFraction
    * camera.zoom;
  const radius = camera.regionWorldRadius * scale * perspective;
  return {
    x: profile.viewportWidth * 0.5 + x1 * scale * perspective,
    y: profile.viewportHeight * camera.verticalCenterFraction - y1 * scale * perspective,
    depth: z2,
    perspective,
    radiusX: radius * camera.footprintScaleX,
    radiusY: radius * camera.footprintScaleY,
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function sampleProfile(profile, x, y) {
  const gridX = clamp((x / profile.viewportWidth) * profile.gridWidth - 0.5, 0, profile.gridWidth - 1);
  const gridY = clamp((y / profile.viewportHeight) * profile.gridHeight - 0.5, 0, profile.gridHeight - 1);
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const x1 = Math.min(profile.gridWidth - 1, x0 + 1);
  const y1 = Math.min(profile.gridHeight - 1, y0 + 1);
  const fractionX = gridX - x0;
  const fractionY = gridY - y0;
  const cell = (cellX, cellY) => profile.cells[cellY * profile.gridWidth + cellX] / 255;
  const upper = cell(x0, y0) * (1 - fractionX) + cell(x1, y0) * fractionX;
  const lower = cell(x0, y1) * (1 - fractionX) + cell(x1, y1) * fractionX;
  return upper * (1 - fractionY) + lower * fractionY;
}

export function backgroundFootprintCost(position) {
  const frame = projectDefaultLayoutCenter(position);
  let weightedCost = 0;
  let totalWeight = 0;
  for (const [offsetX, offsetY, weight] of FOOTPRINT_SAMPLES) {
    weightedCost += sampleProfile(
      DEFAULT_BACKGROUND_LAYOUT_PROFILE,
      frame.x + offsetX * frame.radiusX,
      frame.y + offsetY * frame.radiusY,
    ) * weight;
    totalWeight += weight;
  }
  const { safeInsets } = DEFAULT_LAYOUT_CAMERA;
  const horizontalOverflows = [
    Math.max(0, safeInsets.left - (frame.x - frame.radiusX)) / frame.radiusX,
    Math.max(0, frame.x + frame.radiusX - (DEFAULT_BACKGROUND_LAYOUT_PROFILE.viewportWidth - safeInsets.right)) / frame.radiusX,
  ];
  const verticalOverflows = [
    Math.max(0, safeInsets.top - (frame.y - frame.radiusY)) / frame.radiusY,
    Math.max(0, frame.y + frame.radiusY - (DEFAULT_BACKGROUND_LAYOUT_PROFILE.viewportHeight - safeInsets.bottom)) / frame.radiusY,
  ];
  return {
    cost: weightedCost / totalWeight,
    edgePenalty: [...horizontalOverflows, ...verticalOverflows]
      .reduce((sum, overflow) => sum + overflow * overflow, 0),
    frame,
  };
}

export function projectedNebulaOverlapPenalty(position, usedCenters) {
  const frame = projectDefaultLayoutCenter(position);
  let cost = 0;
  let maximumPenetration = 0;
  let overlapCount = 0;
  for (const center of usedCenters) {
    const other = projectDefaultLayoutCenter(center);
    const normalizedX = (frame.x - other.x) / (frame.radiusX + other.radiusX);
    const normalizedY = (frame.y - other.y) / (frame.radiusY + other.radiusY);
    const penetration = Math.max(0, 1 - Math.hypot(normalizedX, normalizedY));
    if (penetration <= 0) continue;
    overlapCount += 1;
    maximumPenetration = Math.max(maximumPenetration, penetration);
    cost += penetration * penetration;
  }
  return { cost, maximumPenetration, overlapCount, frame };
}

function normalizedMinimumDistance(position, usedCenters) {
  if (!usedCenters.length) return 0;
  return Math.min(...usedCenters.map((center) => Math.hypot(
    (position[0] - center[0]) / 3.8,
    (position[1] - center[1]) / 2.55,
    (position[2] - center[2]) / 0.95,
  )));
}

export function scorePartitionCenter(position, usedCenters) {
  const background = backgroundFootprintCost(position);
  const overlap = projectedNebulaOverlapPenalty(position, usedCenters);
  const separation = normalizedMinimumDistance(position, usedCenters);
  return {
    total:
      background.cost
      + background.edgePenalty * 2.2
      + overlap.cost * 2.8
      - separation * 0.08,
    backgroundCost: background.cost,
    edgePenalty: background.edgePenalty,
    overlapCost: overlap.cost,
    maximumPenetration: overlap.maximumPenetration,
    overlapCount: overlap.overlapCount,
    separation,
    frame: background.frame,
  };
}

export function selectBackgroundAwareCenter(candidates, usedCenters) {
  let selected;
  let selectedScore;
  for (const candidate of candidates) {
    const score = scorePartitionCenter(candidate, usedCenters);
    if (
      !selectedScore
      || score.total < selectedScore.total - 1e-12
      || (
        Math.abs(score.total - selectedScore.total) <= 1e-12
        && (
          score.overlapCost < selectedScore.overlapCost - 1e-12
          || (
            Math.abs(score.overlapCost - selectedScore.overlapCost) <= 1e-12
            && score.backgroundCost < selectedScore.backgroundCost - 1e-12
          )
        )
      )
    ) {
      selected = candidate;
      selectedScore = score;
    }
  }
  return selected;
}

export function summarizeProjectedNebulaOverlap(centers) {
  let totalPenetration = 0;
  let maximumPenetration = 0;
  let overlapCount = 0;
  for (let index = 0; index < centers.length; index += 1) {
    const metrics = projectedNebulaOverlapPenalty(centers[index], centers.slice(0, index));
    totalPenetration += metrics.cost;
    maximumPenetration = Math.max(maximumPenetration, metrics.maximumPenetration);
    overlapCount += metrics.overlapCount;
  }
  return { totalPenetration, maximumPenetration, overlapCount };
}
