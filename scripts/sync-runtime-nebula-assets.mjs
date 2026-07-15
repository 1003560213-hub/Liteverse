import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { mergeNebulaAssetCatalog } from "./lib/nebula-catalog.mjs";

const root = path.resolve(import.meta.dirname, "..");
const supportDirectory = process.env.LITEVERSE_SUPPORT_DIR
  ? path.resolve(process.env.LITEVERSE_SUPPORT_DIR)
  : path.join(os.homedir(), "Library", "Application Support", "Liteverse");
const currentPath = path.join(supportDirectory, "Graph", "current.json");
const pendingPath = path.join(supportDirectory, "Graph", "pending-update.json");
const lockPath = path.join(supportDirectory, ".locks", "stage-refresh.lock");

try {
  await access(currentPath);
} catch {
  console.log("Liteverse runtime graph does not exist yet; the packaged seed will initialize it on first launch.");
  process.exit(0);
}

await mkdir(path.dirname(lockPath), { recursive: true });
try {
  await mkdir(lockPath);
} catch (error) {
  if (error.code === "EEXIST") {
    console.log("Curator's stage-refresh lock is active; nebula asset catalog migration was safely deferred.");
    process.exit(0);
  }
  throw error;
}

try {
  try {
    await access(pendingPath);
    console.log("A Refresh is pending; nebula asset catalog migration was safely deferred.");
    process.exitCode = 0;
  } catch {
    const [currentGraph, packagedGraph] = await Promise.all([
      readFile(currentPath, "utf8").then(JSON.parse),
      readFile(path.join(root, "data", "universe.json"), "utf8").then(JSON.parse),
    ]);
    const { graph, changed, addedAssetIds } = mergeNebulaAssetCatalog(
      currentGraph,
      packagedGraph,
    );
    if (!changed) {
      console.log("Liteverse runtime nebula asset catalog is already current.");
    } else {
      // Curator cannot create pending-update.json until this shared lock is
      // released, so the atomic rename cannot cross snapshot construction.
      const temporaryPath = `${currentPath}.nebula-assets-${process.pid}`;
      await writeFile(temporaryPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
      await rename(temporaryPath, currentPath);
      console.log(
        `Synchronized ${addedAssetIds.length} packaged nebula assets into the runtime graph: ${addedAssetIds.join(", ") || "catalog version only"}.`,
      );
    }
  }
} finally {
  await rm(lockPath, { recursive: true, force: true });
}
