import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_LABELS,
  MIN_HEIGHT,
  NO_RESULT,
  WIDGET_TYPE,
  counterText,
  imageRefs,
  pairAt,
  pairCount,
  sideLabels,
  splitAt,
  stepPair,
  viewPath,
} from "../../web/compare_widget.js";

test("the module loads without a DOM and names its constants", () => {
  assert.equal(NO_RESULT, "no result yet");
  assert.equal(WIDGET_TYPE, "warp-compare");
  assert.equal(MIN_HEIGHT, 240);
});

test("imageRefs keeps refs with a filename and fills subfolder and type", () => {
  assert.deepEqual(imageRefs([{ filename: "a.png" }, null, { subfolder: "x" }, "b.png"]), [
    { filename: "a.png", subfolder: "", type: "temp" },
  ]);
  assert.deepEqual(imageRefs([{ filename: "b.png", subfolder: "s", type: "output", extra: 1 }]), [
    { filename: "b.png", subfolder: "s", type: "output" },
  ]);
  assert.deepEqual(imageRefs(undefined), []);
  assert.deepEqual(imageRefs({ filename: "a.png" }), []);
});

test("viewPath builds an encoded /view query", () => {
  assert.equal(
    viewPath({ filename: "Warp A_00001_.png", subfolder: "", type: "temp" }),
    "/view?filename=Warp+A_00001_.png&subfolder=&type=temp"
  );
  assert.equal(viewPath({ filename: "a&b.png" }), "/view?filename=a%26b.png&subfolder=&type=temp");
});

test("sideLabels is [left, right] with before/after as the default", () => {
  assert.deepEqual(DEFAULT_LABELS, ["before", "after"]);
  assert.deepEqual(sideLabels(), ["before", "after"]);
  assert.deepEqual(sideLabels(["first", "final"]), ["first", "final"]);
  assert.deepEqual(sideLabels(["first"]), ["first", "after"]);
  assert.deepEqual(sideLabels(["", 3]), ["before", "after"]);
});

test("pairCount is the longer side", () => {
  assert.equal(pairCount([], []), 0);
  assert.equal(pairCount([1], []), 1);
  assert.equal(pairCount([1], [1, 2, 3]), 3);
  assert.equal(pairCount(undefined, [1, 2]), 2);
  assert.equal(pairCount(undefined, undefined), 0);
});

test("stepPair wraps both ways and is 0 without pairs", () => {
  assert.equal(stepPair(0, 1, 3), 1);
  assert.equal(stepPair(2, 1, 3), 0);
  assert.equal(stepPair(0, -1, 3), 2);
  assert.equal(stepPair(0, 1, 1), 0);
  assert.equal(stepPair(4, 1, 0), 0);
});

test("splitAt is the pointer's place across the box, clamped", () => {
  assert.equal(splitAt(150, 100, 200), 0.25);
  assert.equal(splitAt(50, 100, 200), 0);
  assert.equal(splitAt(400, 100, 200), 1);
  assert.equal(splitAt(10, 0, 0), 0.5);
});

test("counterText counts from 1", () => {
  assert.equal(counterText(0, 3), "1/3");
  assert.equal(counterText(2, 3), "3/3");
  assert.equal(counterText(0, 0), "0/0");
});

test("pairAt: a pair with only one side is shown whole", () => {
  const a = [{ filename: "a1" }];
  const b = [{ filename: "b1" }, { filename: "b2" }];
  assert.deepEqual(pairAt(a, b, 0), { left: a[0], right: b[0], single: false });
  assert.deepEqual(pairAt(a, b, 1), { left: null, right: b[1], single: true });
  assert.deepEqual(pairAt([], b, 0), { left: null, right: b[0], single: true });
  assert.deepEqual(pairAt([], [], 0), { left: null, right: null, single: false });
});
