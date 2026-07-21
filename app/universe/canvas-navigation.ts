export type CanvasTarget =
  | { kind: "paper"; id: string }
  | { kind: "galaxy"; id: string }
  | { kind: "black-hole"; categoryId: string }
  | { kind: "memory"; id: string }
  | { kind: "relation"; key: string }
  | { kind: "category"; id: string };

export type CanvasViewLevel = "universe" | "galaxies" | "papers" | "notes";

export type CanvasHierarchyState = {
  categoryFilter: string;
  selectedGalaxyId: string | null;
  notesCategoryId: string | null;
  selectedPaperId: string | null;
  selectedMemoryId: string | null;
  selectedRelationKey: string | null;
};

export type CanvasBackAction =
  | "close-memory"
  | "close-paper"
  | "close-relation"
  | "show-nebula"
  | "show-universe"
  | "none";

export function sameCanvasTarget(
  left: CanvasTarget | null,
  right: CanvasTarget | null,
) {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "paper" && right.kind === "paper") return left.id === right.id;
  if (left.kind === "galaxy" && right.kind === "galaxy") return left.id === right.id;
  if (left.kind === "memory" && right.kind === "memory") return left.id === right.id;
  if (left.kind === "black-hole" && right.kind === "black-hole") {
    return left.categoryId === right.categoryId;
  }
  if (left.kind === "category" && right.kind === "category") return left.id === right.id;
  return left.kind === "relation" && right.kind === "relation" && left.key === right.key;
}

export function canvasViewLevel(
  state: Pick<CanvasHierarchyState, "categoryFilter" | "selectedGalaxyId" | "notesCategoryId">,
): CanvasViewLevel {
  if (state.notesCategoryId) return "notes";
  if (state.selectedGalaxyId) return "papers";
  return state.categoryFilter === "all" ? "universe" : "galaxies";
}

export function canvasBackAction(state: CanvasHierarchyState): CanvasBackAction {
  if (state.selectedMemoryId) return "close-memory";
  if (state.selectedPaperId) return "close-paper";
  if (state.selectedRelationKey) return "close-relation";
  if (state.selectedGalaxyId || state.notesCategoryId) return "show-nebula";
  if (state.categoryFilter !== "all") return "show-universe";
  return "none";
}

export function cycleCanvasTarget(
  targets: readonly CanvasTarget[],
  current: CanvasTarget | null,
  direction: 1 | -1,
) {
  if (targets.length === 0) return null;
  const currentIndex = targets.findIndex((target) => sameCanvasTarget(target, current));
  if (currentIndex < 0) return direction === 1 ? targets[0] : targets[targets.length - 1];
  return targets[(currentIndex + direction + targets.length) % targets.length];
}

export function canActivateCanvasTarget(
  target: CanvasTarget,
  noteCountByCategory: ReadonlyMap<string, number>,
) {
  return target.kind !== "black-hole" || (noteCountByCategory.get(target.categoryId) || 0) > 0;
}

export function memoryOrbitAngle(
  phase: number,
  direction: number,
  frameTime: number,
  ring: number,
  reducedMotion: boolean,
) {
  const motionTime = reducedMotion ? 0 : frameTime;
  return phase + (direction < 0 ? -1 : 1) * motionTime * (0.000045 + ring * 0.000006);
}
