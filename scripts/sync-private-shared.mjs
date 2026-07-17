#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PRIVATE_ROOT = resolve(PUBLIC_ROOT, "..", "Liteverse");

// This allowlist is intentionally narrow. Research data, graph state, project
// memory, private seeds, bundle identity, release output, and local settings
// must never travel from either workspace to the other.
const SHARED_PATHS = Object.freeze([
  "AGENTS.md",
  "app",
  "desktop",
  "macos/LiteverseApp.m",
  "macos/LiteverseLocalWorker.swift",
  "public/liteverse-brand.png",
  "public/liteverse-star-source.png",
  "public/nebula-regions",
  "scripts/build-local-worker.sh",
  "scripts/build-macos-app.sh",
  "scripts/install-codex-skills.sh",
  "scripts/sync-private-shared.mjs",
  "skills",
  "tests/apple-design-system.test.mjs",
  "tests/layout-localization.test.mjs",
  "tests/local-preparation-contract.test.mjs",
  "tests/native-local-preparation-bridge.test.mjs",
  "tests/native-local-worker.test.mjs",
  "tests/native-workspace-contract.test.mjs",
  "tests/performance-guards.test.mjs",
  "tests/runtime-logic.test.mjs",
  "tests/shared-code-sync.test.mjs",
  "tsconfig.app.json",
  "vite.desktop.config.ts",
]);

const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".openai",
  "Application Support",
  "Cache",
  "Graph",
  "Knowledge",
  "Library",
  "Planning",
  "Projects",
  "Usage",
  "Work",
  "build",
  "data",
  "dist",
  "dist-desktop",
  "node_modules",
  "release",
]);

function parseArguments(argv) {
  let mode = "check";
  let privateRoot = process.env.LITEVERSE_PRIVATE_ROOT || DEFAULT_PRIVATE_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") mode = "check";
    else if (argument === "--write") mode = "write";
    else if (argument === "--private-root") privateRoot = argv[++index];
    else if (argument === "--help") {
      console.log("Usage: node scripts/sync-private-shared.mjs [--check|--write] [--private-root <path>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!privateRoot) throw new Error("--private-root requires a path");
  return { mode, privateRoot: resolve(privateRoot) };
}

function assertSafeRelativePath(path) {
  const normalized = path.split(sep).join("/");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Unsafe shared path: ${path}`);
  }
  for (const segment of normalized.split("/")) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new Error(`Forbidden shared path segment '${segment}' in ${path}`);
    }
  }
}

async function pathStat(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function collectFiles(root, relativePath) {
  assertSafeRelativePath(relativePath);
  const absolutePath = join(root, relativePath);
  const info = await pathStat(absolutePath);
  if (!info) return [];
  if (info.isSymbolicLink()) throw new Error(`Refusing shared symlink: ${relativePath}`);
  if (info.isFile()) return [relativePath];
  if (!info.isDirectory()) return [];

  const files = [];
  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === ".DS_Store" || entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
    const child = join(relativePath, entry.name);
    assertSafeRelativePath(child);
    if (entry.isSymbolicLink()) throw new Error(`Refusing shared symlink: ${child}`);
    if (entry.isDirectory()) files.push(...await collectFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function atomicCopy(source, destination) {
  const [bytes, sourceInfo] = await Promise.all([readFile(source), stat(source)]);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.liteverse-sync-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, bytes, { mode: sourceInfo.mode });
    await chmod(temporary, sourceInfo.mode);
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function main() {
  const { mode, privateRoot } = parseArguments(process.argv.slice(2));
  if (privateRoot === PUBLIC_ROOT) throw new Error("Public and private roots must differ");
  const privateInfo = await pathStat(privateRoot);
  if (!privateInfo?.isDirectory()) throw new Error(`Private Liteverse root not found: ${privateRoot}`);

  const sharedFiles = [];
  for (const sharedPath of SHARED_PATHS) sharedFiles.push(...await collectFiles(PUBLIC_ROOT, sharedPath));
  sharedFiles.sort();

  const mismatches = [];
  for (const relativePath of sharedFiles) {
    const publicPath = join(PUBLIC_ROOT, relativePath);
    const privatePath = join(privateRoot, relativePath);
    const publicBytes = await readFile(publicPath);
    const privateInfoForFile = await pathStat(privatePath);
    const privateBytes = privateInfoForFile?.isFile() ? await readFile(privatePath) : null;
    if (!privateBytes || sha256(publicBytes) !== sha256(privateBytes)) {
      mismatches.push(relativePath);
      if (mode === "write") await atomicCopy(publicPath, privatePath);
    }
  }

  if (mode === "check" && mismatches.length > 0) {
    console.error(`Shared-code drift detected in ${mismatches.length} file(s):`);
    for (const path of mismatches) console.error(`  ${path}`);
    process.exitCode = 1;
    return;
  }

  const action = mode === "write" ? `synchronized ${mismatches.length}` : `verified ${sharedFiles.length}`;
  console.log(`Liteverse shared code ${action} file(s). Private-only files were preserved.`);
}

await main();
