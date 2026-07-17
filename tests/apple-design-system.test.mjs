import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesURL = new URL("../app/globals.css", import.meta.url);
const layoutURL = new URL("../app/layout.tsx", import.meta.url);
const componentURL = new URL("../app/universe/LiteratureUniverse.tsx", import.meta.url);

test("Apple-style interface uses one neutral token system and readable type", async () => {
  const [styles, layout] = await Promise.all([
    readFile(stylesURL, "utf8"),
    readFile(layoutURL, "utf8"),
  ]);

  for (const token of [
    "--lv-surface",
    "--lv-control",
    "--lv-text",
    "--lv-text-secondary",
    "--lv-hairline",
    "--lv-radius-control",
    "--lv-radius-card",
    "--lv-radius-drawer",
  ]) {
    assert.match(styles, new RegExp(token));
  }
  assert.match(styles, /-apple-system, BlinkMacSystemFont/);
  assert.doesNotMatch(layout, /next\/font/);
  assert.doesNotMatch(styles, /background-clip:\s*padding-box\s*,\s*border-box/);

  const pixelSizes = [...styles.matchAll(/font-size:\s*([0-9.]+)px/g)]
    .map((match) => Number(match[1]));
  assert.ok(pixelSizes.length > 0);
  assert.ok(pixelSizes.every((size) => size >= 11), `visible type fell below 11px: ${Math.min(...pixelSizes)}px`);

  assert.match(styles, /scroll-snap-type:\s*x proximity/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(styles, /@media \(prefers-contrast: more\)/);
});

test("drawer metrics and Canvas labels use restrained, non-overlapping presentation", async () => {
  const [styles, component] = await Promise.all([
    readFile(stylesURL, "utf8"),
    readFile(componentURL, "utf8"),
  ]);

  assert.match(styles, /\.paper-temperature-value\s*\{/);
  assert.match(styles, /font-family: ui-rounded, "SF Pro Rounded"/);
  assert.match(styles, /#paper-tab-relations\s*\{[^}]*min-width: 144px/s);
  assert.match(styles, /\.drawer-tabs i\s*\{[^}]*flex: 0 0 auto/s);
  assert.match(component, /Skill-managed · Read-only/);
  assert.doesNotMatch(component, /Read-only here/);
  assert.match(component, /const categoryLabel = category\.name;/);
  assert.doesNotMatch(component, /category\.name\.toUpperCase\(\)/);
  assert.doesNotMatch(component, /strokeText\(categoryLabel/);
  assert.doesNotMatch(component, /lineWidth \* 4\.2/);
  assert.match(
    component,
    /const lineDash = hasVerifiedRelation\s*\? \[\]\s*:\s*hasUnscoredRelation\s*\? \[2, 8\]\s*:\s*\[7, 8\]/,
  );
  assert.match(component, /const photonCount = focused \? 1 : 0/);
  assert.match(component, /hitWidth: Math\.max\(7, lineWidth \+ 4\)/);
});
