import assert from "node:assert/strict";
import { test } from "node:test";

import { foldMarkup, parseSections, pruneFolded } from "../../web/fold.js";

const slice = (text, start, end) => text.slice(start, end);

function bodyOf(text, section) {
  return slice(text, section.bodyStart, section.bodyEnd);
}

test("no headers: everything is preamble", () => {
  const text = "a photo\nof a cat";
  assert.deepEqual(parseSections(text), {
    preamble: { start: 0, end: text.length, text },
    sections: [],
  });
});

test("an empty text has an empty preamble and no sections", () => {
  assert.deepEqual(parseSections(""), {
    preamble: { start: 0, end: 0, text: "" },
    sections: [],
  });
});

test("three slashes is a note, not a header", () => {
  const { sections } = parseSections("/// not one\n// nor this\nnor //// this");
  assert.deepEqual(sections, []);
});

test("offsets are exact for a preamble and two sections", () => {
  const text = "lead\n//// Style\nfoo\nbar\n//// Subject\nbaz";
  const { preamble, sections } = parseSections(text);
  assert.deepEqual(preamble, { start: 0, end: 4, text: "lead" });
  assert.deepEqual(sections, [
    {
      key: "Style#0",
      title: "Style",
      headerStart: 5,
      headerEnd: 15,
      bodyStart: 16,
      bodyEnd: 23,
      lineCount: 2,
    },
    {
      key: "Subject#0",
      title: "Subject",
      headerStart: 24,
      headerEnd: 36,
      bodyStart: 37,
      bodyEnd: 40,
      lineCount: 1,
    },
  ]);
  assert.equal(slice(text, 5, 15), "//// Style");
  assert.equal(bodyOf(text, sections[0]), "foo\nbar");
  assert.equal(bodyOf(text, sections[1]), "baz");
});

test("a header on the first line leaves an empty preamble", () => {
  const { preamble, sections } = parseSections("//// A\nx");
  assert.deepEqual(preamble, { start: 0, end: 0, text: "" });
  assert.equal(sections[0].headerStart, 0);
});

test("duplicate titles are numbered in order of appearance", () => {
  const { sections } = parseSections("//// Style\n//// Other\n//// Style\n//// Style");
  assert.deepEqual(
    sections.map((s) => s.key),
    ["Style#0", "Other#0", "Style#1", "Style#2"]
  );
});

test("a body may be empty with the next header straight after", () => {
  const text = "//// A\n//// B\nx";
  const [a, b] = parseSections(text).sections;
  assert.equal(a.bodyStart, 7);
  assert.equal(a.bodyEnd, 7);
  assert.equal(a.lineCount, 0);
  assert.equal(bodyOf(text, b), "x");
});

test("a header on the last line with no newline", () => {
  const text = "x\n//// End";
  const [section] = parseSections(text).sections;
  assert.equal(section.headerStart, 2);
  assert.equal(section.headerEnd, text.length);
  assert.equal(section.bodyStart, text.length);
  assert.equal(section.bodyEnd, text.length);
  assert.equal(section.lineCount, 0);
});

test("a header on the last line followed by a newline", () => {
  const text = "//// End\n";
  const [section] = parseSections(text).sections;
  assert.equal(section.headerEnd, 8);
  assert.equal(section.bodyStart, 9);
  assert.equal(section.bodyEnd, 9);
  assert.equal(section.lineCount, 0);
});

test("indented headers count, and the offsets cover the indent", () => {
  const text = "  //// Inner\n\t////Tight\nx";
  const [inner, tight] = parseSections(text).sections;
  assert.equal(inner.title, "Inner");
  assert.equal(inner.headerStart, 0);
  assert.equal(inner.headerEnd, 12);
  assert.equal(tight.title, "Tight");
  assert.equal(tight.headerStart, 13);
});

test("the space around a title is not part of it", () => {
  assert.equal(parseSections("////    Style  ").sections[0].key, "Style#0");
});

test("a title may be empty, and a header cannot reach onto the next line", () => {
  const [first, second] = parseSections("////\ntext\n////\n").sections;
  assert.equal(first.key, "#0");
  assert.equal(first.title, "");
  assert.equal(second.key, "#1");
  assert.equal(parseSections("////\ntext").sections[0].lineCount, 1);
});

test("a fifth slash is the start of the title", () => {
  assert.equal(parseSections("///// Style").sections[0].title, "/ Style");
});

test("blank lines between sections are in the body but not in the count", () => {
  const text = "//// A\nx\n\ny\n\n\n//// B";
  const [a] = parseSections(text).sections;
  assert.equal(bodyOf(text, a), "x\n\ny\n\n");
  assert.equal(a.lineCount, 3);
});

test("pruneFolded keeps only keys that still name a section", () => {
  const { sections } = parseSections("//// A\n//// B");
  assert.deepEqual(pruneFolded(["B#0", "Gone#0", "A#0", "A#1"], sections), ["B#0", "A#0"]);
});

test("pruneFolded does not trust what a saved workflow holds", () => {
  assert.deepEqual(pruneFolded(undefined, []), []);
  assert.deepEqual(pruneFolded("A#0", parseSections("//// A").sections), []);
});

function markup(text, folded = []) {
  return foldMarkup(text, parseSections(text), new Set(folded), (start, end) =>
    text.slice(start, end)
  );
}

test("the view shows a preamble, a header and its body", () => {
  const html = markup("lead\n//// Style\nfoo");
  assert.match(html, /^<div class="wpf-text" data-at="0" data-end="4">lead<\/div>/);
  assert.match(html, /<div class="wpf-head" data-i="0">/);
  assert.match(html, /<span class="wpf-title" data-at="10" data-end="15">Style<\/span>/);
  assert.match(html, /<div class="wpf-text" data-at="16" data-end="19">foo<\/div>$/);
  assert.match(html, /▾/);
});

test("a folded section shows its header and a count, and no body", () => {
  const html = markup("//// Style\nfoo\nbar\n//// Next\nbaz", ["Style#0"]);
  assert.match(html, /is-folded/);
  assert.match(html, /▸/);
  assert.match(html, /· 2 lines/);
  assert.doesNotMatch(html, /foo/);
  assert.match(html, /baz/);
});

test("the count says one line in the singular", () => {
  assert.match(markup("//// A\nx", ["A#0"]), /· 1 line</);
});

test("a preamble is left out only when the first header starts the text", () => {
  assert.doesNotMatch(markup("//// A\nx"), /data-at="0" data-end="0"/);
  assert.match(markup("\n//// A\nx"), /<div class="wpf-text" data-at="0" data-end="0">/);
});

test("an empty body is drawn only when there is a blank line to draw", () => {
  const noLine = '<div class="wpf-text"';
  assert.equal(markup("//// A\n//// B").includes(noLine), false);
  assert.equal(markup("//// A").includes(noLine), false);
  assert.equal(markup("//// A\n\n//// B").includes(noLine), true);
  assert.equal(markup("//// A\n").includes(noLine), true);
});

test("a title is escaped, and its offsets skip trailing space", () => {
  const html = markup("//// <b>  \nx");
  assert.match(html, /data-at="5" data-end="8">&lt;b&gt;<\/span>/);
});

test("an offset into a title lands on the title even when it repeats a slash", () => {
  assert.match(markup("/////"), /data-at="4" data-end="5">\/<\/span>/);
});

test("folded text is still in the source: folding never changes the value", () => {
  const text = "lead\n//// A\nsecret";
  const before = text;
  markup(text, ["A#0"]);
  assert.equal(text, before);
  assert.equal(bodyOf(text, parseSections(text).sections[0]), "secret");
});
