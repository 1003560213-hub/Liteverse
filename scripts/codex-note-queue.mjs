import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const supportDirectory = process.env.LITEVERSE_SUPPORT_DIR || path.join(
  homedir(), "Library", "Application Support", "Liteverse",
);
const annotationsPath = path.join(supportDirectory, "user-annotations.json");

async function readAnnotations() {
  try {
    const value = JSON.parse(await readFile(annotationsPath, "utf8"));
    if (!Array.isArray(value)) throw new Error("annotation root must be an array");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`Liteverse refused to read invalid annotations: ${error.message}`);
  }
}

const command = process.argv[2] || "list";
const annotations = await readAnnotations();

if (command === "list") {
  const pending = annotations.filter((item) => item.status === "pending");
  if (!pending.length) {
    console.log("Liteverse: no pending annotations.");
  } else {
    console.log(JSON.stringify(pending, null, 2));
  }
} else if (command === "mark") {
  throw new Error(
    "The legacy mark command is read-only. Use skills/liteverse-curator/scripts/mark-annotation.mjs " +
    "with --id, --revision, --refresh-id, and every --derived-file so provenance and the staged graph are verified.",
  );
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}
