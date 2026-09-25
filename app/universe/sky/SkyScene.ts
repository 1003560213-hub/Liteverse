import * as THREE from "three";
import type { Vector3 } from "../types";
import { LVPC_HEADER_BYTES, LVPC_STRIDE, type PointCloud, type UniverseAssets } from "./assets";
import type { EvidenceTier, SkyFilament, SkyGalaxy, SkyModel, SkyRegion } from "./model";
import {
  ACCRETION_FRAGMENT,
  ACCRETION_VERTEX,
  DEEP_FIELD_FRAGMENT,
  DEEP_FIELD_VERTEX,
  FILAMENT_FRAGMENT,
  FILAMENT_VERTEX,
  GALAXY_FRAGMENT,
  GALAXY_VERTEX,
  HALO_FRAGMENT,
  HALO_VERTEX,
  PAPER_STAR_FRAGMENT,
  PAPER_STAR_VERTEX,
} from "./shaders";

export type SkyQuality = "efficient" | "balanced" | "high";
export type SkyLens = "tier" | "heat" | "year" | "centrality";
export type SkyFocus =
  | { level: "universe" }
  | { level: "region"; regionId: string }
  | { level: "galaxy"; galaxyId: string }
  | { level: "notes"; regionId: string };

export type SkyTarget =
  | { kind: "region"; id: string }
  | { kind: "galaxy"; id: string }
  | { kind: "paper"; id: string }
  | { kind: "black-hole"; regionId: string }
  | { kind: "filament"; id: string; relationKey?: string };

export type SkySelection = {
  paperId: string | null;
  hovered: SkyTarget | null;
  highlightedPaperIds: ReadonlySet<string>;
};

export type ProjectedPoint = { x: number; y: number; depth: number; visible: boolean; pixelRadius: number };

type GalaxyRenderable = {
  galaxy: SkyGalaxy;
  group: THREE.Group;
  stars: THREE.Points;
  dust: THREE.Points;
  material: THREE.ShaderMaterial;
  dustMaterial: THREE.ShaderMaterial;
  maxCount: number;
};

type RegionRenderable = {
  region: SkyRegion;
  halo: THREE.Mesh;
  haloMaterial: THREE.ShaderMaterial;
  core: THREE.Points | null;
  coreMaterial: THREE.ShaderMaterial | null;
  disk: THREE.Mesh | null;
  diskMaterial: THREE.ShaderMaterial | null;
};

type CameraState = { target: THREE.Vector3; distance: number; azimuth: number; elevation: number };

const TIER_COLORS: Record<EvidenceTier, [number, number, number]> = {
  0: [0.78, 0.84, 0.95],
  1: [0.55, 0.74, 1.0],
  2: [1.0, 0.82, 0.5],
};

const QUALITY: Record<SkyQuality, { pixelRatio: number; pointsPerPixel2: number; minPoints: number; ambientFps: number }> = {
  efficient: { pixelRatio: 1, pointsPerPixel2: 0.5, minPoints: 900, ambientFps: 0 },
  balanced: { pixelRatio: 1.5, pointsPerPixel2: 1.4, minPoints: 1800, ambientFps: 24 },
  high: { pixelRatio: 2, pointsPerPixel2: 3, minPoints: 3000, ambientFps: 30 },
};

const FOCUS_DISTANCE = { region: 9, galaxy: 2.6, notes: 3.2 } as const;
const TRANSITION_MS = 700;

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function hexColor(hex: string, fallback = "#9fb4d8") {
  const color = new THREE.Color();
  try {
    color.set(/^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback);
  } catch {
    color.set(fallback);
  }
  return color;
}

function pointCloudGeometry(cloud: PointCloud) {
  const body = new Uint8Array(cloud.buffer, LVPC_HEADER_BYTES, cloud.count * LVPC_STRIDE);
  // Interleaved: i16 x3 (6 bytes), u8 rgb (3), u8 size, u8 population, u8 extra.
  const interleavedShorts = new THREE.InterleavedBuffer(
    new Int16Array(body.buffer, body.byteOffset, (cloud.count * LVPC_STRIDE) / 2),
    LVPC_STRIDE / 2,
  );
  const interleavedBytes = new THREE.InterleavedBuffer(body, LVPC_STRIDE);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.InterleavedBufferAttribute(interleavedShorts, 3, 0, true));
  geometry.setAttribute("color", new THREE.InterleavedBufferAttribute(interleavedBytes, 3, 6, true));
  geometry.setAttribute("size", new THREE.InterleavedBufferAttribute(interleavedBytes, 1, 9, true));
  const population = new Float32Array(cloud.count);
  const extra = new Float32Array(cloud.count);
  for (let index = 0; index < cloud.count; index += 1) {
    population[index] = body[index * LVPC_STRIDE + 10];
    extra[index] = body[index * LVPC_STRIDE + 11];
  }
  geometry.setAttribute("population", new THREE.BufferAttribute(population, 1));
  geometry.setAttribute("extra", new THREE.BufferAttribute(extra, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  return geometry;
}

/**
 * The Deep Universe renderer. It draws only on demand: a frame is produced
 * when the camera, data, selection, or size changes, while a transition runs,
 * or at a capped rate when ambient motion is enabled. With ambient motion off
 * (battery, Low Power Mode, reduced motion, hidden window) a still universe
 * costs no GPU time at all.
 */
export class SkyScene {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.01, 4000);
  private assets: UniverseAssets | null = null;
  private archetypeGeometry: THREE.BufferGeometry[] = [];
  private deepField: THREE.Points | null = null;
  private deepFieldMaterial: THREE.ShaderMaterial | null = null;
  private galaxies = new Map<string, GalaxyRenderable>();
  private regions = new Map<string, RegionRenderable>();
  private paperStars: THREE.Points | null = null;
  private paperStarIds: string[] = [];
  private filaments: THREE.LineSegments | null = null;
  private filamentMaterial: THREE.ShaderMaterial | null = null;
  private model: SkyModel | null = null;
  private focus: SkyFocus = { level: "universe" };
  private selection: SkySelection = { paperId: null, hovered: null, highlightedPaperIds: new Set() };
  private lens: SkyLens = "tier";
  private quality: SkyQuality = "balanced";
  private ambient = false;
  private reducedMotion = false;
  private frameRequested = 0;
  private ambientTimer = 0;
  private lastFrameAt = 0;
  private sceneTime = 0;
  private width = 1;
  private height = 1;
  private cameraState: CameraState = {
    target: new THREE.Vector3(),
    distance: 24,
    azimuth: -0.35,
    elevation: 0.32,
  };
  private transition: { from: CameraState; to: CameraState; startedAt: number } | null = null;
  private disposed = false;
  onAfterRender: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "default",
      preserveDrawingBuffer: false,
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = true;
    this.scene.matrixWorldAutoUpdate = true;
  }

  setAssets(assets: UniverseAssets) {
    if (this.disposed) return;
    this.assets = assets;
    this.archetypeGeometry.forEach((geometry) => geometry.dispose());
    this.archetypeGeometry = assets.galaxies.map((cloud) => pointCloudGeometry(cloud));
    const deepGeometry = pointCloudGeometry(assets.deepField);
    this.deepFieldMaterial = new THREE.ShaderMaterial({
      vertexShader: DEEP_FIELD_VERTEX,
      fragmentShader: DEEP_FIELD_FRAGMENT,
      uniforms: {
        uSpriteScale: { value: assets.deepField.sizeScale },
        uFocalPixels: { value: 1000 },
        uExposure: { value: 1 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.deepField = new THREE.Points(deepGeometry, this.deepFieldMaterial);
    this.deepField.frustumCulled = false;
    this.deepField.renderOrder = -100;
    this.scene.add(this.deepField);
    if (this.model) this.setModel(this.model);
    this.invalidate();
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.applyPixelRatio();
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  setQuality(quality: SkyQuality) {
    if (this.quality === quality) return;
    this.quality = quality;
    this.applyPixelRatio();
    this.renderer.setSize(this.width, this.height, false);
    this.updateAmbientLoop();
    this.invalidate();
  }

  setAmbientMotion(enabled: boolean, reducedMotion: boolean) {
    this.ambient = enabled && !reducedMotion;
    this.reducedMotion = reducedMotion;
    this.updateAmbientLoop();
  }

  setLens(lens: SkyLens) {
    if (this.lens === lens) return;
    this.lens = lens;
    this.rebuildPaperStars();
    this.applyFocusVisibility();
    this.invalidate();
  }

  private applyPixelRatio() {
    const deviceRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(Math.min(deviceRatio, QUALITY[this.quality].pixelRatio));
  }

  // ---------------------------------------------------------------- model

  setModel(model: SkyModel) {
    this.model = model;
    if (!this.assets) return;
    const seenGalaxies = new Set<string>();
    for (const galaxy of model.galaxies) {
      seenGalaxies.add(galaxy.id);
      const existing = this.galaxies.get(galaxy.id);
      if (existing && existing.galaxy.archetype === galaxy.archetype) {
        existing.galaxy = galaxy;
        this.placeGalaxy(existing);
        continue;
      }
      if (existing) this.disposeGalaxy(existing);
      this.galaxies.set(galaxy.id, this.createGalaxy(galaxy));
    }
    for (const [id, renderable] of this.galaxies) {
      if (!seenGalaxies.has(id)) {
        this.disposeGalaxy(renderable);
        this.galaxies.delete(id);
      }
    }

    const seenRegions = new Set<string>();
    for (const region of model.regions) {
      seenRegions.add(region.id);
      const existing = this.regions.get(region.id);
      if (existing) this.disposeRegion(existing);
      this.regions.set(region.id, this.createRegion(region));
    }
    for (const [id, renderable] of this.regions) {
      if (!seenRegions.has(id)) {
        this.disposeRegion(renderable);
        this.regions.delete(id);
      }
    }
    this.rebuildPaperStars();
    this.rebuildFilaments();
    this.applyFocusVisibility();
    this.invalidate();
  }

  private createGalaxy(galaxy: SkyGalaxy): GalaxyRenderable {
    const geometry = this.instanceGeometry(galaxy.archetype);
    const cloud = this.assets!.galaxies[galaxy.archetype % this.assets!.galaxies.length];
    const uniforms = () => ({
      uTime: { value: 0 },
      uSpin: { value: galaxy.spin },
      uRotation: { value: /elliptical|lenticular/.test(cloud.id) ? 0.01 : 0.05 },
      uSpriteScale: { value: cloud.sizeScale },
      uFocalPixels: { value: 1000 },
      uGain: { value: 0.32 },
      uBrightness: { value: 1 },
      uDustPass: { value: 0 },
    });
    const material = new THREE.ShaderMaterial({
      vertexShader: GALAXY_VERTEX,
      fragmentShader: GALAXY_FRAGMENT,
      uniforms: uniforms(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    const dustUniforms = uniforms();
    dustUniforms.uDustPass.value = 1;
    const dustMaterial = new THREE.ShaderMaterial({
      vertexShader: GALAXY_VERTEX,
      fragmentShader: GALAXY_FRAGMENT,
      uniforms: dustUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.OneMinusSrcColorFactor,
    });
    const stars = new THREE.Points(geometry, material);
    const dust = new THREE.Points(geometry, dustMaterial);
    stars.frustumCulled = true;
    dust.frustumCulled = true;
    stars.renderOrder = 10;
    dust.renderOrder = 11;
    const group = new THREE.Group();
    group.add(stars, dust);
    this.scene.add(group);
    const renderable = { galaxy, group, stars, dust, material, dustMaterial, maxCount: cloud.count };
    this.placeGalaxy(renderable);
    return renderable;
  }

  /** A per-instance geometry sharing the archetype's GPU buffers, so each galaxy can use its own draw range. */
  private instanceGeometry(archetype: number) {
    const source = this.archetypeGeometry[archetype % this.archetypeGeometry.length];
    const geometry = new THREE.BufferGeometry();
    for (const name of Object.keys(source.attributes)) geometry.setAttribute(name, source.getAttribute(name));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    return geometry;
  }

  private placeGalaxy(renderable: GalaxyRenderable) {
    const { galaxy, group } = renderable;
    group.position.set(...galaxy.position);
    group.rotation.set(0, 0, 0);
    group.rotateY(galaxy.positionAngle);
    group.rotateX(galaxy.inclination);
    group.scale.setScalar(galaxy.radius);
    group.updateMatrixWorld(true);
    const brightness = (galaxy.provisional ? 0.78 : 1) * (0.85 + galaxy.heat * 0.6);
    renderable.material.uniforms.uBrightness.value = brightness;
  }

  private disposeGalaxy(renderable: GalaxyRenderable) {
    this.scene.remove(renderable.group);
    renderable.stars.geometry.dispose();
    renderable.material.dispose();
    renderable.dustMaterial.dispose();
  }

  private createRegion(region: SkyRegion): RegionRenderable {
    const color = hexColor(region.color).lerp(new THREE.Color(1, 0.86, 0.68), 0.55);
    const haloMaterial = new THREE.ShaderMaterial({
      vertexShader: HALO_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      uniforms: {
        uSize: { value: region.radius * 1.25 },
        uColor: { value: color },
        uIntensity: { value: region.provisional ? 0.07 : 0.1 },
        uOutline: { value: 0 },
        uDashed: { value: region.provisional ? 1 : 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), haloMaterial);
    halo.position.set(...region.center);
    halo.frustumCulled = false;
    halo.renderOrder = -10;
    this.scene.add(halo);

    let core: THREE.Points | null = null;
    let coreMaterial: THREE.ShaderMaterial | null = null;
    if (!region.provisional && this.assets) {
      // Brightest cluster galaxy: a giant elliptical at the region centre that
      // hosts the research-memory black hole.
      const ellipticalIndex = Math.max(0, this.assets.galaxies.findIndex((cloud) => /elliptical/.test(cloud.id)));
      coreMaterial = new THREE.ShaderMaterial({
        vertexShader: GALAXY_VERTEX,
        fragmentShader: GALAXY_FRAGMENT,
        uniforms: {
          uTime: { value: 0 },
          uSpin: { value: 1 },
          uRotation: { value: 0.004 },
          uSpriteScale: { value: this.assets.galaxies[ellipticalIndex].sizeScale },
          uFocalPixels: { value: 1000 },
          uGain: { value: 0.32 },
          uBrightness: { value: 0.7 },
          uDustPass: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      core = new THREE.Points(this.instanceGeometry(ellipticalIndex), coreMaterial);
      core.position.set(...region.center);
      core.scale.setScalar(0.55);
      core.geometry.setDrawRange(0, Math.min(6000, this.assets.galaxies[ellipticalIndex].count));
      core.renderOrder = 9;
      this.scene.add(core);
    }

    let disk: THREE.Mesh | null = null;
    let diskMaterial: THREE.ShaderMaterial | null = null;
    if (region.noteCount > 0) {
      diskMaterial = new THREE.ShaderMaterial({
        vertexShader: ACCRETION_VERTEX,
        fragmentShader: ACCRETION_FRAGMENT,
        uniforms: { uTime: { value: 0 }, uIntensity: { value: 1.1 } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      disk = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 1, 1), diskMaterial);
      disk.position.set(...region.center);
      disk.rotation.set(-Math.PI / 2 + 0.32, 0, 0.18);
      disk.scale.setScalar(0.34);
      disk.renderOrder = 12;
      this.scene.add(disk);
    }
    return { region, halo, haloMaterial, core, coreMaterial, disk, diskMaterial };
  }

  private disposeRegion(renderable: RegionRenderable) {
    this.scene.remove(renderable.halo);
    renderable.halo.geometry.dispose();
    renderable.haloMaterial.dispose();
    if (renderable.core) {
      this.scene.remove(renderable.core);
      renderable.core.geometry.dispose();
    }
    renderable.coreMaterial?.dispose();
    if (renderable.disk) {
      this.scene.remove(renderable.disk);
      renderable.disk.geometry.dispose();
    }
    renderable.diskMaterial?.dispose();
  }

  private paperColor(star: { meta: { tier: EvidenceTier; heat: number; year: number | null; centrality: number } }, yearRange: [number, number], maxCentrality: number): [number, number, number] {
    const { meta } = star;
    if (this.lens === "heat") {
      const t = meta.heat;
      return [0.55 + 0.45 * t, 0.62 + 0.2 * t, 0.95 - 0.55 * t];
    }
    if (this.lens === "year") {
      const [min, max] = yearRange;
      const t = meta.year && max > min ? (meta.year - min) / (max - min) : 0.5;
      // Older = redder, newer = bluer (like stellar age).
      return [1.0 - 0.4 * t, 0.72 + 0.1 * t, 0.5 + 0.5 * t];
    }
    if (this.lens === "centrality") {
      const t = maxCentrality > 0 ? meta.centrality / maxCentrality : 0;
      return [0.6 + 0.4 * t, 0.7 + 0.25 * t, 1.0 - 0.3 * t];
    }
    return TIER_COLORS[meta.tier];
  }

  private rebuildPaperStars() {
    if (this.paperStars) {
      this.scene.remove(this.paperStars);
      this.paperStars.geometry.dispose();
      (this.paperStars.material as THREE.Material).dispose();
      this.paperStars = null;
    }
    const model = this.model;
    if (!model || model.stars.length === 0) return;
    const years = model.stars.map((star) => star.meta.year).filter((year): year is number => Boolean(year));
    const yearRange: [number, number] = years.length ? [Math.min(...years), Math.max(...years)] : [0, 0];
    const maxCentrality = model.stars.reduce((max, star) => Math.max(max, star.meta.centrality), 0);
    const count = model.stars.length;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const highlights = new Float32Array(count);
    this.paperStarIds = model.stars.map((star) => star.id);
    model.stars.forEach((star, index) => {
      positions.set(star.position, index * 3);
      colors.set(this.paperColor(star, yearRange, maxCentrality), index * 3);
      sizes[index] = Math.min(1, star.meta.heat * 0.8 + Math.log1p(star.meta.centrality) * 0.25);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("highlight", new THREE.BufferAttribute(highlights, 1));
    const material = new THREE.ShaderMaterial({
      vertexShader: PAPER_STAR_VERTEX,
      fragmentShader: PAPER_STAR_FRAGMENT,
      uniforms: { uPixelRatio: { value: this.renderer.getPixelRatio() }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.paperStars = new THREE.Points(geometry, material);
    this.paperStars.frustumCulled = false;
    this.paperStars.renderOrder = 30;
    this.scene.add(this.paperStars);
    this.updatePaperHighlights();
  }

  private rebuildFilaments() {
    if (this.filaments) {
      this.scene.remove(this.filaments);
      this.filaments.geometry.dispose();
      this.filamentMaterial?.dispose();
      this.filaments = null;
    }
    const model = this.model;
    if (!model || model.filaments.length === 0) return;
    const segments = 24;
    const positions: number[] = [];
    const colors: number[] = [];
    const alphas: number[] = [];
    const distances: number[] = [];
    const dashed: number[] = [];
    const palette: Record<SkyFilament["kind"], [number, number, number]> = {
      citation: [0.62, 0.74, 0.95],
      verified: [1.0, 0.8, 0.46],
      candidate: [0.72, 0.62, 1.0],
      unscored: [0.6, 0.64, 0.72],
    };
    for (const filament of model.filaments) {
      const source = model.galaxyById.get(filament.sourceGalaxyId);
      const target = model.galaxyById.get(filament.targetGalaxyId);
      if (!source || !target) continue;
      const a = new THREE.Vector3(...source.position);
      const b = new THREE.Vector3(...target.position);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const bend = a.distanceTo(b) * 0.12;
      mid.y += bend;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const points = curve.getPoints(segments);
      const weight = Math.min(1, 0.35 + Math.log2(1 + filament.weight) * 0.22);
      let travelled = 0;
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        const step = previous.distanceTo(current);
        const fade = Math.sin((index / points.length) * Math.PI);
        for (const [point, distance] of [[previous, travelled], [current, travelled + step]] as const) {
          positions.push(point.x, point.y, point.z);
          colors.push(...palette[filament.kind]);
          alphas.push((filament.kind === "citation" ? 0.07 : 0.3) * weight * (0.25 + 0.75 * fade));
          distances.push(distance);
          dashed.push(filament.kind === "candidate" || filament.kind === "unscored" ? 1 : 0);
        }
        travelled += step;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute("alpha", new THREE.Float32BufferAttribute(alphas, 1));
    geometry.setAttribute("lineDistance", new THREE.Float32BufferAttribute(distances, 1));
    geometry.setAttribute("dashed", new THREE.Float32BufferAttribute(dashed, 1));
    this.filamentMaterial = new THREE.ShaderMaterial({
      vertexShader: FILAMENT_VERTEX,
      fragmentShader: FILAMENT_FRAGMENT,
      uniforms: { uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.filaments = new THREE.LineSegments(geometry, this.filamentMaterial);
    this.filaments.frustumCulled = false;
    this.filaments.renderOrder = 5;
    this.scene.add(this.filaments);
  }

  // ------------------------------------------------------------ selection

  setSelection(selection: SkySelection) {
    this.selection = selection;
    this.updatePaperHighlights();
    for (const renderable of this.regions.values()) {
      const hovered = selection.hovered?.kind === "region" && selection.hovered.id === renderable.region.id;
      renderable.haloMaterial.uniforms.uOutline.value = hovered ? 1 : 0;
      renderable.haloMaterial.uniforms.uIntensity.value = (renderable.region.provisional ? 0.07 : 0.1) * (hovered ? 1.8 : 1);
    }
    for (const renderable of this.galaxies.values()) {
      const hovered = selection.hovered?.kind === "galaxy" && selection.hovered.id === renderable.galaxy.id;
      const base = (renderable.galaxy.provisional ? 0.78 : 1) * (0.85 + renderable.galaxy.heat * 0.6);
      renderable.material.uniforms.uBrightness.value = base * (hovered ? 1.45 : 1);
    }
    this.invalidate();
  }

  private updatePaperHighlights() {
    if (!this.paperStars) return;
    const attribute = this.paperStars.geometry.getAttribute("highlight") as THREE.BufferAttribute;
    const hoveredPaper = this.selection.hovered?.kind === "paper" ? this.selection.hovered.id : null;
    this.paperStarIds.forEach((id, index) => {
      attribute.setX(
        index,
        id === this.selection.paperId ? 1 : id === hoveredPaper ? 0.7 : this.selection.highlightedPaperIds.has(id) ? 0.45 : 0,
      );
    });
    attribute.needsUpdate = true;
  }

  // --------------------------------------------------------------- camera

  private universeCamera(): CameraState {
    const extent = this.model?.extent || 8;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspect = Math.max(0.6, this.camera.aspect);
    const distance = Math.max(8, (extent * 0.78) / Math.tan(fov / 2) / Math.min(1, aspect));
    return { target: new THREE.Vector3(), distance, azimuth: this.cameraState.azimuth, elevation: this.cameraState.elevation };
  }

  setFocus(focus: SkyFocus, immediate = false) {
    this.focus = focus;
    let next: CameraState = this.universeCamera();
    const model = this.model;
    if (model && focus.level === "region") {
      const region = model.regionById.get(focus.regionId);
      if (region) next = { ...next, target: new THREE.Vector3(...region.center), distance: Math.max(FOCUS_DISTANCE.region, region.radius * 3.1) };
    } else if (model && focus.level === "galaxy") {
      const galaxy = model.galaxyById.get(focus.galaxyId);
      if (galaxy) next = { ...next, target: new THREE.Vector3(...galaxy.position), distance: Math.max(FOCUS_DISTANCE.galaxy, galaxy.radius * 5.2) };
    } else if (model && focus.level === "notes") {
      const region = model.regionById.get(focus.regionId);
      if (region) next = { ...next, target: new THREE.Vector3(...region.center), distance: FOCUS_DISTANCE.notes };
    }
    this.applyFocusVisibility();
    if (immediate || this.reducedMotion) {
      this.cameraState = next;
      this.transition = null;
    } else {
      this.transition = { from: { ...this.cameraState, target: this.cameraState.target.clone() }, to: next, startedAt: performance.now() };
    }
    this.invalidate();
  }

  private applyFocusVisibility() {
    const focus = this.focus;
    const focusedGalaxyId = focus.level === "galaxy" ? focus.galaxyId : null;
    const focusedRegionId = focus.level === "region" || focus.level === "notes"
      ? focus.regionId
      : focusedGalaxyId
        ? this.model?.galaxyById.get(focusedGalaxyId)?.regionId
        : null;
    if (this.paperStars) {
      const material = this.paperStars.material as THREE.ShaderMaterial;
      this.paperStars.visible = Boolean(focusedGalaxyId);
      if (focusedGalaxyId) {
        const model = this.model!;
        const geometry = this.paperStars.geometry;
        const sizes = geometry.getAttribute("size") as THREE.BufferAttribute;
        // Only the focused galaxy's papers render as resolved stars.
        const galaxyMembers = new Set(model.galaxyById.get(focusedGalaxyId)?.paperIds || []);
        const baseSizes = model.stars.map((star) => Math.min(1, star.meta.heat * 0.8 + Math.log1p(star.meta.centrality) * 0.25));
        this.paperStarIds.forEach((id, index) => sizes.setX(index, galaxyMembers.has(id) ? baseSizes[index] : -100));
        sizes.needsUpdate = true;
      }
      material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    }
    if (this.filamentMaterial) {
      this.filamentMaterial.uniforms.uOpacity.value = focus.level === "universe" ? 1 : focus.level === "region" ? 0.5 : 0.2;
    }
    for (const renderable of this.regions.values()) {
      const dimmed = focusedRegionId && renderable.region.id !== focusedRegionId;
      renderable.halo.visible = !dimmed;
      if (renderable.disk) renderable.disk.visible = focus.level !== "universe" && renderable.region.id === focusedRegionId;
    }
    for (const renderable of this.galaxies.values()) {
      const inFocusedRegion = !focusedRegionId || renderable.galaxy.regionId === focusedRegionId;
      renderable.material.uniforms.uBrightness.value =
        (renderable.galaxy.provisional ? 0.78 : 1) * (0.85 + renderable.galaxy.heat * 0.6) * (inFocusedRegion ? 1 : 0.35);
    }
  }

  orbit(deltaAzimuth: number, deltaElevation: number) {
    this.transition = null;
    this.cameraState.azimuth += deltaAzimuth;
    this.cameraState.elevation = THREE.MathUtils.clamp(this.cameraState.elevation + deltaElevation, -1.2, 1.35);
    this.invalidate();
  }

  /** Zoom toward a screen point (in CSS pixels); factor < 1 zooms in. */
  zoom(factor: number, screenX?: number, screenY?: number) {
    this.transition = null;
    const state = this.cameraState;
    const minimum = 0.9;
    const maximum = this.universeCamera().distance * 1.8;
    const nextDistance = THREE.MathUtils.clamp(state.distance * factor, minimum, maximum);
    if (screenX !== undefined && screenY !== undefined && nextDistance < state.distance) {
      // Move the target toward the point under the cursor on the focal plane.
      const ndc = new THREE.Vector2((screenX / this.width) * 2 - 1, -(screenY / this.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      this.syncCamera();
      ray.setFromCamera(ndc, this.camera);
      const pointOnPlane = ray.ray.at(state.distance, new THREE.Vector3());
      const shift = 1 - nextDistance / state.distance;
      state.target.lerp(pointOnPlane, shift);
    }
    state.distance = nextDistance;
    this.invalidate();
  }

  /** Two-finger scroll pans the target in the camera plane. */
  pan(deltaX: number, deltaY: number) {
    this.transition = null;
    this.syncCamera();
    const state = this.cameraState;
    const worldPerPixel = (2 * state.distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / this.height;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    state.target.addScaledVector(right, -deltaX * worldPerPixel);
    state.target.addScaledVector(up, deltaY * worldPerPixel);
    this.invalidate();
  }

  resetOrientation() {
    this.cameraState.azimuth = -0.35;
    this.cameraState.elevation = 0.32;
    this.setFocus(this.focus);
  }

  private syncCamera() {
    const { target, distance, azimuth, elevation } = this.cameraState;
    const cosE = Math.cos(elevation);
    this.camera.position.set(
      target.x + distance * cosE * Math.sin(azimuth),
      target.y + distance * Math.sin(elevation),
      target.z + distance * cosE * Math.cos(azimuth),
    );
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------- picking

  project(position: Vector3 | THREE.Vector3, worldRadius = 0): ProjectedPoint {
    const vector = Array.isArray(position) ? new THREE.Vector3(...position) : position.clone();
    const viewSpace = vector.clone().applyMatrix4(this.camera.matrixWorldInverse);
    const depth = -viewSpace.z;
    vector.project(this.camera);
    const visible = depth > 0 && Math.abs(vector.x) <= 1.2 && Math.abs(vector.y) <= 1.2;
    const focal = this.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    return {
      x: (vector.x * 0.5 + 0.5) * this.width,
      y: (-vector.y * 0.5 + 0.5) * this.height,
      depth,
      visible,
      pixelRadius: depth > 0 ? (worldRadius * focal) / depth : 0,
    };
  }

  pick(x: number, y: number): SkyTarget | null {
    const model = this.model;
    if (!model) return null;
    this.syncCamera();
    const focus = this.focus;
    if (focus.level === "galaxy") {
      const galaxy = model.galaxyById.get(focus.galaxyId);
      let best: { id: string; distance: number } | null = null;
      for (const id of galaxy?.paperIds || []) {
        const star = model.starById.get(id);
        if (!star) continue;
        const projected = this.project(star.position);
        if (!projected.visible) continue;
        const distance = Math.hypot(projected.x - x, projected.y - y);
        if (distance <= 16 && (!best || distance < best.distance)) best = { id, distance };
      }
      if (best) return { kind: "paper", id: best.id };
    }
    const focusedRegionId = focus.level === "region" || focus.level === "notes" ? focus.regionId : null;
    if (focusedRegionId) {
      const region = model.regionById.get(focusedRegionId);
      if (region && region.noteCount > 0) {
        const projected = this.project(region.center, 0.4);
        if (projected.visible && Math.hypot(projected.x - x, projected.y - y) <= Math.max(22, projected.pixelRadius)) {
          return { kind: "black-hole", regionId: region.id };
        }
      }
    }
    if (focus.level !== "universe" || model.regions.length <= 1) {
      let best: { id: string; distance: number } | null = null;
      for (const galaxy of model.galaxies) {
        if (focusedRegionId && galaxy.regionId !== focusedRegionId && focus.level !== "galaxy") continue;
        const projected = this.project(galaxy.position, galaxy.radius);
        if (!projected.visible) continue;
        const distance = Math.hypot(projected.x - x, projected.y - y);
        const reach = Math.max(18, projected.pixelRadius * 0.9);
        if (distance <= reach && (!best || distance / reach < best.distance)) best = { id: galaxy.id, distance: distance / reach };
      }
      if (best) return { kind: "galaxy", id: best.id };
    }
    let bestRegion: { id: string; distance: number } | null = null;
    for (const region of model.regions) {
      const projected = this.project(region.center, region.radius);
      if (!projected.visible) continue;
      const distance = Math.hypot(projected.x - x, projected.y - y);
      const reach = Math.max(36, projected.pixelRadius);
      if (distance <= reach && (!bestRegion || distance / reach < bestRegion.distance)) bestRegion = { id: region.id, distance: distance / reach };
    }
    return bestRegion ? { kind: "region", id: bestRegion.id } : null;
  }

  // ------------------------------------------------------------ rendering

  invalidate() {
    if (this.disposed || this.frameRequested) return;
    this.frameRequested = window.requestAnimationFrame(this.frame);
  }

  private updateAmbientLoop() {
    window.clearInterval(this.ambientTimer);
    this.ambientTimer = 0;
    const fps = QUALITY[this.quality].ambientFps;
    if (this.ambient && fps > 0 && !this.disposed) {
      this.ambientTimer = window.setInterval(() => this.invalidate(), 1000 / fps);
    }
  }

  private frame = (now: number) => {
    this.frameRequested = 0;
    if (this.disposed) return;
    const elapsed = this.lastFrameAt ? Math.min(0.1, (now - this.lastFrameAt) / 1000) : 0;
    this.lastFrameAt = now;
    if (this.ambient) this.sceneTime += elapsed;

    let animating = false;
    if (this.transition) {
      const t = Math.min(1, (now - this.transition.startedAt) / TRANSITION_MS);
      const k = easeInOutCubic(t);
      const { from, to } = this.transition;
      this.cameraState = {
        target: from.target.clone().lerp(to.target, k),
        distance: from.distance + (to.distance - from.distance) * k,
        azimuth: from.azimuth + (to.azimuth - from.azimuth) * k,
        elevation: from.elevation + (to.elevation - from.elevation) * k,
      };
      if (t >= 1) this.transition = null;
      else animating = true;
    }
    this.syncCamera();
    this.updateLevelOfDetail();
    if (this.deepField && this.deepFieldMaterial) {
      this.deepField.position.copy(this.camera.position);
      this.deepFieldMaterial.uniforms.uFocalPixels.value = this.focalPixels();
    }
    for (const renderable of this.regions.values()) {
      if (renderable.diskMaterial) renderable.diskMaterial.uniforms.uTime.value = this.sceneTime;
    }
    this.renderer.render(this.scene, this.camera);
    this.onAfterRender?.();
    if (animating) this.invalidate();
  };

  /** Focal length in device pixels, for converting world sizes to sprite sizes. */
  private focalPixels() {
    return (this.height * this.renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }

  private updateLevelOfDetail() {
    const settings = QUALITY[this.quality];
    const focal = this.focalPixels();
    for (const renderable of this.galaxies.values()) {
      const { galaxy } = renderable;
      const projected = this.project(galaxy.position, galaxy.radius);
      const pixels = Math.max(0, projected.pixelRadius);
      const onScreen = projected.depth > 0 &&
        projected.x > -pixels && projected.x < this.width + pixels &&
        projected.y > -pixels && projected.y < this.height + pixels;
      renderable.group.visible = onScreen;
      if (!onScreen) continue;
      const count = Math.round(Math.min(
        renderable.maxCount,
        Math.max(settings.minPoints, pixels * pixels * settings.pointsPerPixel2),
      ));
      renderable.stars.geometry.setDrawRange(0, count);
      // Fewer points drawn: each sprite covers proportionally more area, so
      // the integrated surface brightness stays the same.
      const cloud = this.assets!.galaxies[galaxy.archetype % this.assets!.galaxies.length];
      const spriteScale = cloud.sizeScale * Math.sqrt(renderable.maxCount / Math.max(1, count));
      for (const material of [renderable.material, renderable.dustMaterial]) {
        material.uniforms.uTime.value = this.sceneTime;
        material.uniforms.uSpriteScale.value = spriteScale;
        material.uniforms.uFocalPixels.value = focal;
      }
    }
    for (const renderable of this.regions.values()) {
      if (!renderable.core || !renderable.coreMaterial) continue;
      const count = renderable.core.geometry.drawRange.count;
      const ellipticalIndex = Math.max(0, this.assets!.galaxies.findIndex((cloud) => /elliptical/.test(cloud.id)));
      const cloud = this.assets!.galaxies[ellipticalIndex];
      renderable.coreMaterial.uniforms.uSpriteScale.value = cloud.sizeScale * Math.sqrt(cloud.count / Math.max(1, Number.isFinite(count) ? count : cloud.count));
      renderable.coreMaterial.uniforms.uFocalPixels.value = focal;
      renderable.coreMaterial.uniforms.uTime.value = this.sceneTime;
    }
  }

  dispose() {
    this.disposed = true;
    window.cancelAnimationFrame(this.frameRequested);
    window.clearInterval(this.ambientTimer);
    for (const renderable of this.galaxies.values()) this.disposeGalaxy(renderable);
    for (const renderable of this.regions.values()) this.disposeRegion(renderable);
    this.archetypeGeometry.forEach((geometry) => geometry.dispose());
    this.deepField?.geometry.dispose();
    this.deepFieldMaterial?.dispose();
    this.paperStars?.geometry.dispose();
    this.filaments?.geometry.dispose();
    this.filamentMaterial?.dispose();
    this.renderer.dispose();
  }
}
