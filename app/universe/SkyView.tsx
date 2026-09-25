import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { loadUniverseAssets } from "./sky/assets";
import type { SkyModel } from "./sky/model";
import {
  SkyScene,
  type SkyFocus,
  type SkyLens,
  type SkyQuality,
  type SkyTarget,
} from "./sky/SkyScene";

export type SkyLabel = {
  id: string;
  text: string;
  detail?: string;
  kind: "region" | "galaxy" | "paper" | "black-hole";
  position: [number, number, number];
  radius: number;
  provisional?: boolean;
  emphasis?: boolean;
};

type SkyViewProps = {
  model: SkyModel;
  focus: SkyFocus;
  lens: SkyLens;
  quality: SkyQuality;
  ambient: boolean;
  reducedMotion: boolean;
  paused: boolean;
  selectedPaperId: string | null;
  highlightedPaperIds: ReadonlySet<string>;
  labels: SkyLabel[];
  keyboardTargets: Array<{ target: SkyTarget; label: string }>;
  onActivate: (target: SkyTarget | null) => void;
  onBack: () => void;
  onAnnounce: (message: string) => void;
  zoomCommand: { kind: "in" | "out" | "reset"; nonce: number } | null;
};

function sameTarget(left: SkyTarget | null, right: SkyTarget | null) {
  if (!left || !right || left.kind !== right.kind) return left === right;
  if (left.kind === "black-hole" && right.kind === "black-hole") return left.regionId === right.regionId;
  return (left as { id: string }).id === (right as { id: string }).id;
}

export function SkyView(props: SkyViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SkyScene | null>(null);
  const labelsRef = useRef<SkyLabel[]>(props.labels);
  const pointerRef = useRef({ down: false, x: 0, y: 0, startX: 0, startY: 0, moved: false, button: 0 });
  const gestureRef = useRef<{ scale: number; rotation: number } | null>(null);
  const [hovered, setHovered] = useState<SkyTarget | null>(null);
  const [keyboardFocus, setKeyboardFocus] = useState<SkyTarget | null>(null);
  const [assetError, setAssetError] = useState("");
  const [ready, setReady] = useState(false);
  const propsRef = useRef(props);

  useEffect(() => {
    propsRef.current = props;
  });

  // Scene lifecycle.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let scene: SkyScene;
    try {
      scene = new SkyScene(canvas);
    } catch (error) {
      window.setTimeout(() => setAssetError(`3D rendering is unavailable: ${String((error as Error).message || error)}`), 0);
      return;
    }
    sceneRef.current = scene;
    const observer = new ResizeObserver(([entry]) => {
      scene.resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(canvas);
    scene.onAfterRender = () => positionLabels();
    let cancelled = false;
    loadUniverseAssets()
      .then((assets) => {
        if (cancelled) return;
        scene.setAssets(assets);
        setReady(true);
      })
      .catch((error: Error) => !cancelled && setAssetError(error.message));
    return () => {
      cancelled = true;
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
    // positionLabels only reads refs.
     
  }, []);

  useEffect(() => { sceneRef.current?.setModel(props.model); }, [props.model, ready]);
  useEffect(() => { sceneRef.current?.setFocus(props.focus); }, [props.focus, props.model, ready]);
  useEffect(() => { sceneRef.current?.setLens(props.lens); }, [props.lens]);
  useEffect(() => { sceneRef.current?.setQuality(props.quality); }, [props.quality]);
  useEffect(() => {
    sceneRef.current?.setAmbientMotion(props.ambient && !props.paused, props.reducedMotion);
  }, [props.ambient, props.paused, props.reducedMotion]);
  useEffect(() => {
    sceneRef.current?.setSelection({
      paperId: props.selectedPaperId,
      hovered: keyboardFocus || hovered,
      highlightedPaperIds: props.highlightedPaperIds,
    });
  }, [hovered, keyboardFocus, props.highlightedPaperIds, props.selectedPaperId]);
  useEffect(() => {
    labelsRef.current = props.labels;
    positionLabels();
    sceneRef.current?.invalidate();
     
  }, [props.labels]);
  useEffect(() => {
    const command = props.zoomCommand;
    const scene = sceneRef.current;
    if (!command || !scene) return;
    if (command.kind === "in") scene.zoom(0.8);
    else if (command.kind === "out") scene.zoom(1.25);
    else scene.resetOrientation();
  }, [props.zoomCommand]);

  // Labels are positioned imperatively after each rendered frame so camera
  // motion never re-renders React.
  function positionLabels() {
    const scene = sceneRef.current;
    const layer = labelLayerRef.current;
    if (!scene || !layer) return;
    const elements = layer.children;
    const occupied: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    // Emphasized labels claim space first; the rest yield on overlap.
    const order = labelsRef.current
      .map((label, index) => ({ label, index }))
      .sort((left, right) => Number(Boolean(right.label.emphasis)) - Number(Boolean(left.label.emphasis)));
    for (let index = labelsRef.current.length; index < elements.length; index += 1) {
      (elements[index] as HTMLElement).style.visibility = "hidden";
    }
    for (const { label, index } of order) {
      const element = elements[index] as HTMLElement | undefined;
      if (!element) continue;
      const projected = scene.project(label.position, label.radius);
      const width = element.offsetWidth || 120;
      const height = element.offsetHeight || 18;
      // Labels sit clear of their object: below stars and galaxies, above regions.
      const offset = (label.kind === "paper" ? 12 : Math.min(160, projected.pixelRadius * 0.9 + 10)) + height / 2;
      const x = projected.x;
      const y = projected.y + (label.kind === "region" ? -offset : offset);
      const box = { x0: x - width / 2 - 4, y0: y - height / 2 - 2, x1: x + width / 2 + 4, y1: y + height / 2 + 2 };
      const collides = occupied.some((other) =>
        box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0);
      const show = projected.visible && !collides && y > 0;
      element.style.visibility = show ? "visible" : "hidden";
      if (show) {
        occupied.push(box);
        element.style.transform = `translate3d(${Math.round(x - width / 2)}px, ${Math.round(y - height / 2)}px, 0)`;
      }
    }
  }

  const pick = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const scene = sceneRef.current;
    if (!canvas || !scene) return null;
    const rect = canvas.getBoundingClientRect();
    return scene.pick(clientX - rect.left, clientY - rect.top);
  };

  // Trackpad: pinch (ctrl+wheel or Safari gesture events) zooms toward the
  // cursor, two-finger scroll pans, drag orbits.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const scene = sceneRef.current;
      if (!scene) return;
      const rect = canvas.getBoundingClientRect();
      const lineScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      const dx = event.deltaX * lineScale;
      const dy = event.deltaY * lineScale;
      if (event.ctrlKey || event.metaKey) {
        scene.zoom(Math.exp(dy * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      } else if (event.shiftKey) {
        scene.orbit(-dx * 0.004, -dy * 0.004);
      } else if (Math.abs(dx) < 1 && Number.isInteger(dy) && Math.abs(dy) >= 40) {
        // A physical mouse wheel: zoom.
        scene.zoom(Math.exp(dy * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
      } else {
        scene.pan(-dx, -dy);
      }
    };
    type GestureEvent = Event & { scale: number; rotation: number; clientX: number; clientY: number };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureRef.current = { scale: 1, rotation: 0 };
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as GestureEvent;
      const previous = gestureRef.current || { scale: 1, rotation: 0 };
      const scene = sceneRef.current;
      if (!scene) return;
      const rect = canvas.getBoundingClientRect();
      scene.zoom(previous.scale / gesture.scale, gesture.clientX - rect.left, gesture.clientY - rect.top);
      scene.orbit(((gesture.rotation - previous.rotation) * Math.PI) / 180, 0);
      gestureRef.current = { scale: gesture.scale, rotation: gesture.rotation };
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gestureRef.current = null;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("gesturestart", onGestureStart);
    canvas.addEventListener("gesturechange", onGestureChange);
    canvas.addEventListener("gestureend", onGestureEnd);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", onGestureStart);
      canvas.removeEventListener("gesturechange", onGestureChange);
      canvas.removeEventListener("gestureend", onGestureEnd);
    };
  }, []);

  const hoverFrameRef = useRef(0);
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current;
    if (pointer.down) {
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 6) pointer.moved = true;
      if (pointer.button === 2 || event.altKey) sceneRef.current?.pan(dx, dy);
      else sceneRef.current?.orbit(-dx * 0.005, dy * 0.004);
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      return;
    }
    const { clientX, clientY } = event;
    const canvas = event.currentTarget;
    if (hoverFrameRef.current) return;
    hoverFrameRef.current = window.requestAnimationFrame(() => {
      hoverFrameRef.current = 0;
      const target = pick(clientX, clientY);
      canvas.dataset.interactive = target ? "true" : "false";
      setHovered((current) => sameTarget(current, target) ? current : target);
      setKeyboardFocus(null);
    });
  };

  const keyboardTargets = props.keyboardTargets;
  const focusIndex = keyboardFocus ? keyboardTargets.findIndex((item) => sameTarget(item.target, keyboardFocus)) : -1;
  const hoveredLabel = useMemo(() => {
    const target = keyboardFocus || hovered;
    if (!target) return null;
    return keyboardTargets.find((item) => sameTarget(item.target, target))?.label || null;
  }, [hovered, keyboardFocus, keyboardTargets]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const key = event.key;
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(key)) {
      event.preventDefault();
      if (keyboardTargets.length === 0) {
        props.onAnnounce("No interactive items are available in this view.");
        return;
      }
      let index: number;
      if (key === "Home") index = 0;
      else if (key === "End") index = keyboardTargets.length - 1;
      else {
        const direction = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
        index = focusIndex < 0
          ? (direction === 1 ? 0 : keyboardTargets.length - 1)
          : (focusIndex + direction + keyboardTargets.length) % keyboardTargets.length;
      }
      const item = keyboardTargets[index];
      setKeyboardFocus(item.target);
      props.onAnnounce(`${item.label} Item ${index + 1} of ${keyboardTargets.length}.`);
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (keyboardFocus) props.onActivate(keyboardFocus);
      else if (keyboardTargets[0]) setKeyboardFocus(keyboardTargets[0].target);
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      setKeyboardFocus(null);
      props.onBack();
    }
    if (key === "+" || key === "=") sceneRef.current?.zoom(0.85);
    if (key === "-") sceneRef.current?.zoom(1.18);
  };

  return (
    <div className="sky">
      <canvas
        ref={canvasRef}
        className="sky-canvas"
        tabIndex={0}
        role="application"
        aria-roledescription="3D literature universe"
        aria-label="Literature universe. Use arrow keys to move between items, Enter to open, Escape to go back. Pinch to zoom, scroll to pan, drag to orbit."
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          pointerRef.current = {
            down: true,
            x: event.clientX,
            y: event.clientY,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            button: event.button,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => {
          const moved = pointerRef.current.moved;
          pointerRef.current.down = false;
          if (moved || event.button === 2) return;
          props.onActivate(pick(event.clientX, event.clientY));
        }}
        onPointerLeave={() => setHovered(null)}
        onDoubleClick={() => sceneRef.current?.resetOrientation()}
        onKeyDown={onKeyDown}
      />
      <div className="sky-labels" ref={labelLayerRef} aria-hidden="true">
        {props.labels.map((label) => (
          <div
            key={`${label.kind}:${label.id}`}
            className={`sky-label is-${label.kind}${label.provisional ? " is-provisional" : ""}${label.emphasis ? " is-emphasis" : ""}`}
          >
            <span className="sky-label-text">{label.text}</span>
            {label.detail ? <span className="sky-label-detail">{label.detail}</span> : null}
          </div>
        ))}
      </div>
      {hoveredLabel ? <div className="sky-hover-readout" aria-hidden="true">{hoveredLabel}</div> : null}
      {assetError ? <div className="sky-error" role="alert">{assetError}</div> : null}
    </div>
  );
}
