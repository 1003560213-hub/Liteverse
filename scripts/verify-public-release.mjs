import { access, lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const generatedDirectories = new Set([
  ".git",
  ".next",
  ".vinext",
  ".wrangler",
  "Liteverse.app",
  "build",
  "dist",
  "dist-desktop",
  "node_modules",
  "release",
  "tmp",
]);
const binaryExtensions = new Set([
  ".db",
  ".gif",
  ".icns",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".sqlite",
  ".webp",
  ".zip",
]);
const forbiddenGeneratedNames = new Set([".DS_Store", "__pycache__"]);
const privateProjectTokens = [
  ["F", "DM"].join(""),
  ["SF", "DM"].join(""),
];
const nonEnglishScripts = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const personalHomePath = new RegExp(["/Us", "ers/", "[^/\\s]+/"].join(""));
const errors = [];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    if (forbiddenGeneratedNames.has(entry.name) || /\.py[co]$/i.test(entry.name)) {
      errors.push(`${childRelative}: generated cache files must not ship`);
      continue;
    }
    if (entry.isDirectory() && generatedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      errors.push(`${childRelative}: symbolic links are not allowed in the public source tree`);
      continue;
    }
    if (metadata.isDirectory()) {
      await walk(absolute, childRelative);
      continue;
    }
    if (!metadata.isFile() || binaryExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const text = await readFile(absolute, "utf8");
    if (nonEnglishScripts.test(text)) errors.push(`${childRelative}: contains non-English CJK text`);
    if (personalHomePath.test(text)) errors.push(`${childRelative}: contains an absolute personal home path`);
    for (const token of privateProjectTokens) {
      if (new RegExp(`\\b${token}\\b`, "i").test(text)) {
        errors.push(`${childRelative}: contains private-project token ${token}`);
      }
    }
  }
}

for (const forbidden of [
  "data/papers",
  "data/research-memory.md",
  ["examples/", "f", "dm-current-partition-plan.json"].join(""),
]) {
  if (await exists(path.join(root, forbidden))) errors.push(`${forbidden}: private seed content must not ship`);
}

for (const fileName of ["data/empty-universe.json", "data/universe.json"]) {
  const filePath = path.join(root, fileName);
  if (!(await exists(filePath))) {
    errors.push(`${fileName}: required empty seed is missing`);
    continue;
  }
  const graph = JSON.parse(await readFile(filePath, "utf8"));
  if (graph.title !== "Liteverse" || graph.categories?.length || graph.papers?.length || graph.relations?.length) {
    errors.push(`${fileName}: public seed must be an empty Liteverse graph`);
  }
}

await walk(root);

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("Public-release verification passed: English-only source, empty seeds, and no private workspace content.");
