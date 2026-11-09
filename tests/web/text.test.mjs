import assert from "node:assert/strict";
import { test } from "node:test";

import { toggleCommentLines } from "../../web/text.js";

function apply(value, from, to = from) {
  const { start, end, text } = toggleCommentLines(value, from, to);
  return value.slice(0, start) + text + value.slice(end);
}

test("a caret toggles only its own line", () => {
  assert.equal(apply("one\ntwo\nthree", 5), "one\n// two\nthree");
  assert.equal(apply("one\n// two\nthree", 5), "one\ntwo\nthree");
});

test("a blank line on its own can still be commented", () => {
  assert.equal(apply("", 0), "// ");
});

test("every selected line is commented", () => {
  assert.equal(apply("one\ntwo\nthree", 1, 9), "// one\n// two\n// three");
});

test("all commented lines are switched back on", () => {
  assert.equal(apply("// one\n//two\n  // three", 1, 20), "one\ntwo\n  three");
});

test("a mixed selection is commented, as in a code editor", () => {
  assert.equal(apply("// one\ntwo", 0, 10), "// // one\n// two");
});

test("blank lines inside a selection stay blank and do not count", () => {
  assert.equal(apply("one\n\ntwo", 0, 8), "// one\n\n// two");
  assert.equal(apply("// one\n\n// two", 0, 14), "one\n\ntwo");
});

test("indentation stays in front of the comment", () => {
  assert.equal(apply("  one\n    two", 0, 12), "  // one\n    // two");
});

test("a selection ending at the start of a line leaves that line alone", () => {
  assert.equal(apply("one\ntwo\nthree", 0, 4), "// one\ntwo\nthree");
});

test("the first line is found when the selection starts at zero", () => {
  assert.equal(apply("\none", 0), "// \none");
});

test("section lines are left as they are", () => {
  assert.equal(apply("//// Style\none\ntwo", 0, 18), "//// Style\n// one\n// two");
  assert.equal(apply("//// Style\n// one", 0, 16), "//// Style\none");
  assert.equal(apply("//// Style", 3), "//// Style");
});
