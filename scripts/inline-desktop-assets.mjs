import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(root, "dist-desktop");
const indexPath = path.join(outputDirectory, "index.html");
let html = await readFile(indexPath, "utf8");

const stylesheetMatch = html.match(
  /<link rel="stylesheet" crossorigin href="(\.\/assets\/[^"]+\.css)">/,
);
const scriptMatch = html.match(
  /<script type="module" crossorigin src="(\.\/assets\/[^"]+\.js)"><\/script>/,
);

if (!stylesheetMatch || !scriptMatch) {
  throw new Error("Desktop build assets were not found in index.html.");
}

const css = await readFile(
  path.join(outputDirectory, stylesheetMatch[1].replace(/^\.\//, "")),
  "utf8",
);
const javascript = await readFile(
  path.join(outputDirectory, scriptMatch[1].replace(/^\.\//, "")),
  "utf8",
);
const escapedJavascript = javascript.replaceAll("</script", "<\\/script");
const wrappedJavascript = `
window.__liteverseBoot = { started: true };
try {
${escapedJavascript}
  window.__liteverseBoot.renderScheduled = true;
} catch (error) {
  window.__liteverseBoot.error = String(error && (error.stack || error.message || error));
  var diagnostic = document.createElement("pre");
  diagnostic.id = "liteverse-startup-error";
  diagnostic.style.cssText = "color:#ffb4b4;background:#100;padding:24px;white-space:pre-wrap;font:13px monospace";
  diagnostic.textContent = "Liteverse startup error\\n\\n" + window.__liteverseBoot.error;
  document.body.appendChild(diagnostic);
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.liteverse) {
    window.webkit.messageHandlers.liteverse.postMessage({
      action: "runtimeError",
      message: window.__liteverseBoot.error,
      source: "desktop bundle",
      line: 0
    });
  }
}
`;

html = html
  // Use replacement callbacks so JavaScript sequences such as `$&`, `$\`` and
  // `$'` stay literal instead of being interpreted by String.replace.
  .replace(
    stylesheetMatch[0],
    () => `<style>${css.replaceAll("</style", "<\\/style")}</style>`,
  )
  .replace(scriptMatch[0], () => "")
  .replace(
    "</body>",
    () => `<script>${wrappedJavascript}</script></body>`,
  );

await writeFile(indexPath, html, "utf8");
console.log("Liteverse desktop assets inlined into index.html.");

// Embed the Blender-generated point clouds as a classic script. WKWebView
// loads classic scripts from file:// URLs, but fetch() of file:// URLs is not
// supported, so the renderer reads window.__LITEVERSE_UNIVERSE_ASSETS instead.
const universeDirectory = path.join(outputDirectory, "universe");
const manifest = JSON.parse(await readFile(path.join(universeDirectory, "manifest.json"), "utf8"));
const files = {};
for (const entry of [...manifest.galaxies, manifest.deepField]) {
  const bytes = await readFile(path.join(universeDirectory, entry.file));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) throw new Error(`Universe asset ${entry.file} does not match its manifest hash.`);
  files[entry.file] = bytes.toString("base64");
}
await writeFile(
  path.join(universeDirectory, "assets.js"),
  `window.__LITEVERSE_UNIVERSE_ASSETS = ${JSON.stringify({ manifest, files })};\n`,
  "utf8",
);
for (const entry of [...manifest.galaxies, manifest.deepField]) {
  await rm(path.join(universeDirectory, entry.file));
}
console.log("Liteverse universe assets embedded into universe/assets.js.");
