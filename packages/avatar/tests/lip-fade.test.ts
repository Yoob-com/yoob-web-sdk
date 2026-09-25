// The lip cadence (the Luna app's LipCrossfade / LipHandover, 2026-09-24/25) as the web canvas uses it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  HOST_PRESENTATION_LEAD_MS,
  LIP_ENTER_FADE_MS,
  LIP_FADE_FEATHER_PX,
  LIP_NEIGHBOUR_FADE_MS,
  LIP_SETTLE_FADE_MS,
  LipFadeState,
  fadeRegion,
  featherAlpha,
  hostFramesAdjacent,
  lipFadeWeight,
  lipFramesAdjacent,
  resolveLipCadence,
} from "../src/engine/runtime/lip-fade";

test("blend is the default; only an explicit step turns it off", () => {
  assert.equal(resolveLipCadence(undefined), "blend");
  assert.equal(resolveLipCadence("blend"), "blend");
  assert.equal(resolveLipCadence("step"), "step");
  assert.equal(resolveLipCadence("off"), "blend");
});

test("the app's windows: 40 ms between frames, 120 ms into a reply, 160 ms back to the idle face", () => {
  assert.equal(LIP_NEIGHBOUR_FADE_MS, 40);
  assert.equal(LIP_ENTER_FADE_MS, 120);
  assert.equal(LIP_SETTLE_FADE_MS, 160);
  assert.equal(HOST_PRESENTATION_LEAD_MS, 20);
});

test("a neighbour fade reaches half weight half a frame after it is shown: when its audio is due", () => {
  assert.equal(lipFadeWeight("neighbour", 0), 0);
  assert.equal(lipFadeWeight("neighbour", HOST_PRESENTATION_LEAD_MS), 0.5);
  assert.equal(lipFadeWeight("neighbour", 40), 1);
  assert.equal(lipFadeWeight("neighbour", 400), 1);
  assert.equal(lipFadeWeight("neighbour", -5), 0);
});

test("the first mouth of a reply is centred on its audio: a third in when shown, half when due", () => {
  assert.ok(Math.abs(lipFadeWeight("enter", 0) - 1 / 3) < 1e-9);
  assert.equal(lipFadeWeight("enter", HOST_PRESENTATION_LEAD_MS), 0.5);
  assert.equal(lipFadeWeight("enter", HOST_PRESENTATION_LEAD_MS + 60), 1);
});

test("the settle fade runs 160 ms from the first repaint", () => {
  assert.equal(lipFadeWeight("settle", 0), 0);
  assert.equal(lipFadeWeight("settle", 80), 0.5);
  assert.equal(lipFadeWeight("settle", 160), 1);
});

test("frames fade only to the next frame or over one skipped frame", () => {
  assert.equal(lipFramesAdjacent(4, 5), true);
  assert.equal(lipFramesAdjacent(4, 6), true);
  assert.equal(lipFramesAdjacent(4, 7), false, "two skipped frames step");
  assert.equal(lipFramesAdjacent(4, 4), false);
  assert.equal(lipFramesAdjacent(5, 4), false, "never backwards");
  assert.equal(lipFramesAdjacent(-1, 0), false, "no mouth on screen: not a neighbour");
});

test("host frames are neighbours around the loop's end, and a seek is a jump", () => {
  assert.equal(hostFramesAdjacent(10, 11, 150), true);
  assert.equal(hostFramesAdjacent(149, 0, 150), true, "the loop wraps");
  assert.equal(hostFramesAdjacent(0, 148, 150), true);
  assert.equal(hostFramesAdjacent(10, 13, 150), false);
  assert.equal(hostFramesAdjacent(80, 0, 150), false);
  assert.equal(hostFramesAdjacent(-1, 0, 150), false);
});

test("the faded region covers both mouth boxes, in 16 px steps, inside the canvas", () => {
  const region = fadeRegion([278, 658, 608, 988], [283, 662, 613, 992], 1080, 1920);
  const [x0, y0, x1, y1] = region;
  assert.ok(x0 <= 278 && y0 <= 658 && x1 >= 613 && y1 >= 992, JSON.stringify(region));
  assert.equal((x1 - x0) % 16, 0);
  assert.equal((y1 - y0) % 16, 0);
  assert.ok(x1 - x0 < 360 && y1 - y0 < 360);
  const edge = fadeRegion(undefined, [1070, 1900, 1080, 1920], 1080, 1920);
  assert.ok(edge[0] >= 0 && edge[2] <= 1080 && edge[1] >= 0 && edge[3] <= 1920, JSON.stringify(edge));
});

test("the feather mask is opaque inside and fades to 0 at the region's edge", () => {
  assert.equal(featherAlpha(160, 160, 336, 336), 255);
  assert.ok(featherAlpha(0, 160, 336, 336) < 20);
  assert.ok(featherAlpha(335, 160, 336, 336) < 20);
  assert.equal(featherAlpha(LIP_FADE_FEATHER_PX, 160, 336, 336), 255);
});

test("a fade's weight never goes back, and it ends at 1", () => {
  const fade = new LipFadeState();
  assert.equal(fade.begin("neighbour", 1000), 0);
  assert.equal(fade.weight(1020), 0.5);
  assert.equal(fade.weight(1010), 0.5, "a clock stepping back holds the weight");
  assert.equal(fade.running, true);
  assert.equal(fade.weight(1040), 1);
  assert.equal(fade.running, false);
  fade.begin("enter", 2000);
  fade.begin("settle", 3000);
  fade.step();
  assert.deepEqual(fade.counts, { started: 1, stepped: 1, enters: 1, settles: 1 });
});
