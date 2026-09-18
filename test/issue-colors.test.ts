import test from "node:test";
import assert from "node:assert/strict";
import { issueColor, issueHue, NEUTRAL_COLOR, NEUTRAL_COLOR_RGB } from "../src/dashboard/shared/issue-colors.js";

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
