import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesURL = new URL("../app/globals.css", import.meta.url);

test("hierarchical universe chrome uses restrained and responsive surfaces", async () => {
  const styles = await readFile(stylesURL, "utf8");

  for (const selector of [
    ".universe-breadcrumb",
    ".memory-drawer",
    ".memory-document-content",
    ".memory-provenance-card",
    ".scientific-text",
    ".scientific-math",
    ".scientific-code",
  ]) {
    assert.match(styles, new RegExp(selector.replaceAll(".", "\\.")));
  }

  for (const width of [1320, 1180, 980, 760, 520]) {
    assert.match(styles, new RegExp(`@media \\(max-width: ${width}px\\)`));
  }

  assert.match(styles, /\.memory-drawer\s*\{[\s\S]*?transform-origin:\s*top left/);
  assert.match(styles, /\.scientific-math\.is-block,[\s\S]*?overflow-x:\s*auto/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.memory-drawer[\s\S]*?opacity 160ms/);
  assert.match(styles, /@media \(prefers-reduced-transparency: reduce\)[\s\S]*?\.memory-drawer/);
  assert.match(styles, /@media \(prefers-contrast: more\)[\s\S]*?\.memory-provenance-card/);

  assert.doesNotMatch(styles, /transition:\s*all\b/);
  assert.doesNotMatch(styles, /\bease-in\b/);
});
