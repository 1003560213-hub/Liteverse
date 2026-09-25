/**
 * Loader for the Blender-generated point-cloud assets (`.lvpc`).
 *
 * Format (little-endian, see tools/blender/README.md):
 *   0  "LVPC" magic
 *   4  u32 version (1)
 *   8  u32 pointCount
 *  12  u32 flags
 *  16  f32 radius
 *  20  f32 x3 reserved
 *  32  pointCount × 12 bytes: i16 x,y,z · u8 r,g,b · u8 size · u8 population · u8 extra
 *
 * In the packaged app the files are shipped inside `universe/assets.js`, a
 * classic script that defines `window.__LITEVERSE_UNIVERSE_ASSETS` with
 * base64 payloads. WKWebView loads classic scripts from `file://` reliably,
 * whereas `fetch()` of `file://` URLs is not supported. The dev server serves
 * the same files over HTTP, so `fetch()` is the fallback.
 */

export const LVPC_HEADER_BYTES = 32;
export const LVPC_STRIDE = 12;

export type PointCloud = {
  id: string;
  count: number;
  radius: number;
  /** Sprite radius in normalized units = size/255 * sizeScale. */
  sizeScale: number;
  /** Interleaved 12-byte records starting at LVPC_HEADER_BYTES. */
  buffer: ArrayBuffer;
};

export type UniverseAssetManifest = {
  schemaVersion: string;
  galaxies: Array<{
    id: string;
    name: string;
    morphology: string;
    pointCount: number;
    radius: number;
    sizeScale?: number;
    byteLength: number;
    sha256: string;
    file: string;
    dominantColor?: [number, number, number];
  }>;
  deepField: {
    id?: string;
    pointCount: number;
    radius: number;
    sizeScale?: number;
    byteLength: number;
    sha256: string;
    file: string;
  };
};

type EmbeddedAssets = {
  manifest: UniverseAssetManifest;
  files: Record<string, string>;
};

declare global {
  interface Window {
    __LITEVERSE_UNIVERSE_ASSETS?: EmbeddedAssets;
  }
}

export function parsePointCloud(id: string, buffer: ArrayBuffer, sizeScale = 0.1): PointCloud {
  if (buffer.byteLength < LVPC_HEADER_BYTES) throw new Error(`${id}: point cloud is truncated`);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  if (magic !== "LVPC") throw new Error(`${id}: not an LVPC point cloud`);
  const version = view.getUint32(4, true);
  if (version !== 1) throw new Error(`${id}: unsupported LVPC version ${version}`);
  const count = view.getUint32(8, true);
  const radius = view.getFloat32(16, true);
  if (buffer.byteLength !== LVPC_HEADER_BYTES + count * LVPC_STRIDE) {
    throw new Error(`${id}: point cloud length does not match its header`);
  }
  if (!(radius > 0)) throw new Error(`${id}: point cloud radius is invalid`);
  return { id, count, radius, sizeScale, buffer };
}

function base64ToArrayBuffer(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function loadEmbeddedScript(): Promise<EmbeddedAssets | null> {
  if (typeof window === "undefined") return null;
  if (window.__LITEVERSE_UNIVERSE_ASSETS) return window.__LITEVERSE_UNIVERSE_ASSETS;
  if (window.location.protocol !== "file:") return null;
  await new Promise<void>((resolve) => {
    const script = document.createElement("script");
    script.src = "./universe/assets.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
  return window.__LITEVERSE_UNIVERSE_ASSETS || null;
}

export type UniverseAssets = {
  manifest: UniverseAssetManifest;
  galaxies: PointCloud[];
  deepField: PointCloud;
};

let pending: Promise<UniverseAssets> | null = null;

export function loadUniverseAssets(): Promise<UniverseAssets> {
  if (!pending) {
    pending = (async (): Promise<UniverseAssets> => {
      const embedded = await loadEmbeddedScript();
      const manifest: UniverseAssetManifest = embedded?.manifest ||
        await fetch("./universe/manifest.json").then((response) => {
          if (!response.ok) throw new Error("The universe asset manifest is unavailable.");
          return response.json() as Promise<UniverseAssetManifest>;
        });
      const read = async (file: string) => {
        if (embedded?.files[file]) return base64ToArrayBuffer(embedded.files[file]);
        const response = await fetch(`./universe/${file}`);
        if (!response.ok) throw new Error(`Universe asset ${file} is unavailable.`);
        return response.arrayBuffer();
      };
      const galaxies = await Promise.all(
        manifest.galaxies.map(async (entry) => parsePointCloud(entry.id, await read(entry.file), entry.sizeScale)),
      );
      const deepField = parsePointCloud("deep-field", await read(manifest.deepField.file), manifest.deepField.sizeScale);
      return { manifest, galaxies, deepField };
    })();
    pending.catch(() => { pending = null; });
  }
  return pending as Promise<UniverseAssets>;
}
