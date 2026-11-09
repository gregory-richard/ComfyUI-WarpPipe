import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countLoras,
  foldLabelParts,
  parseSections,
} from "../../web/fold.js";

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
      loraCount: 0,
      activeLoras: 0,
    },
    {
      key: "Subject#0",
      title: "Subject",
      headerStart: 24,
      headerEnd: 36,
      bodyStart: 37,
      bodyEnd: 40,
      lineCount: 1,
      loraCount: 0,
      activeLoras: 0,
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

test("countLoras counts every tag and those not behind a //", () => {
  assert.deepEqual(countLoras("<lora:a:1.00>\n// <lora:b:0.5>\n<lora:c:1> // note <lora:d:1>"), {
    total: 4,
    active: 2,
  });
  assert.deepEqual(countLoras("plain words\n// a note"), { total: 0, active: 0 });
});

function lorasText(total, active) {
  const lines = [];
  for (let i = 0; i < total; i += 1) lines.push(`${i < active ? "" : "// "}<lora:x${i}:1.00>`);
  return lines.join("\n");
}

test("foldLabelParts: columns are as wide as the largest numbers in the box", () => {
  const text = [
    `//// A\n${lorasText(120, 12)}`,
    `//// B\n${lorasText(3, 1)}`,
    `//// C\n${lorasText(1, 0)}`,
    "//// D\none\ntwo",
  ].join("\n");
  const { sections } = parseSections(text);
  assert.deepEqual(foldLabelParts(sections[0], sections), {
    count: 120,
    unit: "LoRAs",
    active: 12,
    countWidth: 3,
    activeWidth: 2,
  });
  assert.deepEqual(foldLabelParts(sections[2], sections), {
    count: 1,
    unit: "LoRA",
    active: 0,
    countWidth: 3,
    activeWidth: 2,
  });
  assert.deepEqual(foldLabelParts(sections[3], sections), {
    count: 2,
    unit: "lines",
    active: null,
    countWidth: 3,
    activeWidth: 2,
  });
});

test("foldLabelParts: a box without LoRAs still has an active column width", () => {
  const { sections } = parseSections("//// A\none");
  assert.deepEqual(foldLabelParts(sections[0], sections), {
    count: 1,
    unit: "line",
    active: null,
    countWidth: 1,
    activeWidth: 1,
  });
});
