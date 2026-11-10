import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { issueColor, issueHue, NEUTRAL_COLOR, NEUTRAL_COLOR_RGB, workColor } from "../src/dashboard/shared/issue-colors.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

test("issueColor: deterministic — the same issue always gets the same color", () => {
  for (const n of [1, 2, 7, 42, 236, 9999]) {
    assert.deepEqual(issueColor(n), issueColor(n));
  }
});

test("issueColor: hex and rgb formats are valid and consistent", () => {
  for (const n of [0, 1, 5, 236]) {
    const c = issueColor(n);
    assert.match(c.hex, /^#[0-9a-f]{6}$/, "hex must be a lowercase 6-digit color");
    assert.match(c.rgb, /^\d{1,3},\d{1,3},\d{1,3}$/, "rgb must be an r,g,b triplet");
    const [r, g, b] = c.rgb.split(",").map(Number);
    assert.equal(c.hex, `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`,
      "hex and rgb must describe the same color");
  }
});

test("issueColor: concurrent issues get distinct colors (no small-palette collisions)", () => {
  const seen = new Set<string>();
  for (let n = 1; n <= 24; n++) seen.add(issueColor(n).hex);
  assert.equal(seen.size, 24, "24 consecutive issues must all have distinct colors");
});

test("issueHue: stays within [0, 360) and is stable for edge inputs", () => {
  for (const n of [0, 1, 360, 100000]) {
    const h = issueHue(n);
    assert.ok(h >= 0 && h < 360, `hue ${h} out of range for issue ${n}`);
  }
  // Negative/fractional inputs must not produce NaN or negative hues.
  assert.ok(issueHue(-5) >= 0);
  assert.deepEqual(issueColor(3.7), issueColor(3));
});

test("neutral color constants agree", () => {
  assert.match(NEUTRAL_COLOR, /^#[0-9a-f]{6}$/);
  const [r, g, b] = NEUTRAL_COLOR_RGB.split(",").map(Number);
  assert.equal(NEUTRAL_COLOR, `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`);
});

// ── No gray engine colors (issue #280) ────────────────────────────────────────

/** HSL saturation and chroma (max − min channel) of an "r,g,b" triplet, both 0..1. */
function saturationOf(rgb: string): { saturation: number; chroma: number } {
  const [r, g, b] = rgb.split(",").map((v) => Number(v) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const lightness = (max + min) / 2;
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
  return { saturation, chroma };
}

test("issueColor: every engine color is meaningfully saturated, never a gray that reads as inactive", () => {
  for (let n = 0; n <= 5000; n++) {
    const { saturation, chroma } = saturationOf(issueColor(n).rgb);
    assert.ok(saturation >= 0.95, `issue #${n} is ${issueColor(n).hex}, saturation ${saturation.toFixed(2)}`);
    assert.ok(chroma >= 0.75, `issue #${n} is ${issueColor(n).hex}, chroma ${chroma.toFixed(2)}`);
  }
});

test("NEUTRAL_COLOR is hue-free trim gray, the --trim-dim token", () => {
  const [r, g, b] = NEUTRAL_COLOR_RGB.split(",").map(Number);
  assert.ok(r === g && g === b, `${NEUTRAL_COLOR} must have no hue at all`);
  const tokens = readFileSync(join(ROOT, "src", "dashboard", "styles", "tokens.css"), "utf-8");
  assert.match(tokens, new RegExp(`--trim-dim:\\s*${NEUTRAL_COLOR};`), "the stylesheet's trim gray and the script's agree");
});

test("workColor: the issue's color, else the PR's own, else none", () => {
  assert.deepEqual(workColor(7, 10), issueColor(7), "a PR closing an issue takes the issue's color");
  assert.deepEqual(workColor(7, null), issueColor(7));
  assert.deepEqual(workColor(null, 300), issueColor(300), "an orphan PR takes its own number's color");
  assert.deepEqual(workColor(undefined, 300), issueColor(300));
  assert.deepEqual(workColor(0, 300), issueColor(0), "issue #0 is still an issue");
  assert.equal(workColor(null, null), null, "nothing to work, no color");
  assert.equal(workColor(undefined, undefined), null);
});
