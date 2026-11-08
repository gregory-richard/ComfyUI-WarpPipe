import assert from "node:assert/strict";
import { test } from "node:test";

import * as core from "../../web/prompt_writer_core.js";

const { formatStatus, listTargets, modelLabel } = core;

test("the old hub helpers are gone", () => {
  assert.equal(core.stripTitles, undefined);
  assert.equal(core.findTargetPrompt, undefined);
});

test("modelLabel", () => {
  assert.equal(
    modelLabel({ name: "Q", prompt_price: 0.3, completion_price: 1.2, vision: true }),
    "Q · $0.30/$1.20 · 👁"
  );
  assert.equal(
    modelLabel({ name: "Q", prompt_price: null, completion_price: null, vision: false }),
    "Q"
  );
  assert.equal(modelLabel({ name: "Q", prompt_price: 0, completion_price: 0 }), "Q · $0.00/$0.00");
});

test("formatStatus", () => {
  assert.equal(
    formatStatus({
      cost: 0.003,
      seconds: 8.2,
      usage: { prompt_tokens: 1812, completion_tokens: 640 },
    }),
    "0.3 ¢ · 8 s · 1,812 → 640 tokens"
  );
  assert.equal(formatStatus({ cost: null, seconds: 12.6, usage: {} }), "13 s");
});

// --- listTargets --------------------------------------------------------------

const PROMPT = "Warp Lora Prompt";

// A node of size 100x100, so its centre is pos + 50.
function node(id, title, pos = [0, 0]) {
  return { id, type: PROMPT, title, pos, size: [100, 100] };
}

function graph(nodes, groups = []) {
  return { _nodes: nodes, _groups: groups };
}

function subgraphNode(id, pos, inner) {
  return { id, type: "uuid-subgraph", title: "sg", pos, size: [100, 100], subgraph: inner };
}

const box = (title, x, y, w = 500, h = 500) => ({ title, _bounding: [x, y, w, h] });
const labels = (root) => listTargets(root).map((t) => t.label);

test("listTargets: empty and missing graphs", () => {
  assert.deepEqual(listTargets(null), []);
  assert.deepEqual(listTargets(graph([])), []);
});

test("listTargets: only prompt nodes, labelled by group without the bookmark", () => {
  const prompt = node(1, "Prompt", [10, 10]);
  const other = { ...node(2, "Other", [10, 10]), type: "Warp Send" };
  const root = graph([prompt, other], [box("Krea [6]", 0, 0)]);
  assert.deepEqual(listTargets(root), [{ node: prompt, label: "Krea" }]);
});

test("listTargets: the centre decides the group, else the node title", () => {
  // pos 480 puts the corner inside the box but the centre (530) outside it.
  const outside = node(1, "Loose", [480, 480]);
  const inside = node(2, "Held", [430, 430]);
  const root = graph([outside, inside], [box("G", 0, 0)]);
  assert.deepEqual(labels(root), ["G", "Loose"]);
});

test("listTargets: groups given by pos and size, or in graph.groups", () => {
  const n = node(1, "T", [10, 10]);
  assert.deepEqual(labels(graph([n], [{ title: "P", pos: [0, 0], size: [200, 200] }])), ["P"]);
  assert.deepEqual(labels({ _nodes: [n], groups: [box("L", 0, 0)] }), ["L"]);
});

test("listTargets: a typed-array bounding works", () => {
  const n = node(1, "T", [10, 10]);
  const group = { title: "Typed", _bounding: new Float32Array([0, 0, 200, 200]) };
  assert.deepEqual(labels(graph([n], [group])), ["Typed"]);
});

test("listTargets: only a trailing bookmark is removed", () => {
  const a = node(1, "T", [10, 10]);
  assert.deepEqual(labels(graph([a], [box("[2] Krea [v2] x", 0, 0)])), ["[2] Krea [v2] x"]);
});

test("listTargets: a group that is only a bookmark falls back to the node title", () => {
  const a = node(1, "Title", [10, 10]);
  assert.deepEqual(labels(graph([a], [box(" [3]", 0, 0)])), ["Title"]);
});

test("listTargets: nested groups use the innermost", () => {
  const a = node(1, "T", [110, 110]);
  const groups = [box("Outer [1]", 0, 0, 1000, 1000), box("Inner [2]", 100, 100, 200, 200)];
  assert.deepEqual(labels(graph([a], groups)), ["Inner"]);
});

test("listTargets: inside a subgraph uses the top-level node's centre", () => {
  // The inner position sits in group Near, but only the subgraph node's counts.
  const inner = node(1, "Inner", [10, 10]);
  const sg = subgraphNode(9, [2010, 2010], graph([inner], [box("Inside", 0, 0)]));
  const root = graph([sg], [box("Near", 0, 0), box("Far [4]", 2000, 2000)]);
  assert.deepEqual(listTargets(root), [{ node: inner, label: "Far" }]);
});

test("listTargets: nested subgraphs use the outermost node", () => {
  const inner = node(1, "Inner", [0, 0]);
  const b = subgraphNode(2, [0, 0], graph([inner]));
  const a = subgraphNode(3, [1010, 10], graph([b]));
  assert.deepEqual(labels(graph([a], [box("Top", 1000, 0)])), ["Top"]);
});

test("listTargets: a subgraph instantiated twice lists its node once", () => {
  const inner = node(1, "Inner", [0, 0]);
  const def = graph([inner]);
  const root = graph(
    [subgraphNode(2, [10, 10], def), subgraphNode(3, [1010, 10], def)],
    [box("First", 0, 0), box("Second", 1000, 0)]
  );
  const targets = listTargets(root);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].node, inner);
  assert.equal(targets[0].label, "First");
});

test("listTargets: sorted by bookmark, then label, unnumbered last", () => {
  const at = (id, x) => node(id, `T${id}`, [x, 10]);
  const root = graph(
    [at(1, 10), at(2, 1010), at(3, 2010), at(4, 3010), at(5, 4010)],
    [
      box("Zeta", 0, 0),
      box("Alpha", 1000, 0),
      box("Late [10]", 2000, 0),
      box("Second [2]", 3000, 0),
      box("First [2]", 4000, 0),
    ]
  );
  assert.deepEqual(labels(root), ["First", "Second", "Late", "Alpha", "Zeta"]);
});

test("listTargets: duplicate labels are numbered in sort order", () => {
  const a = node(1, "Same");
  const b = node(2, "Same");
  const c = node(3, "Same");
  const targets = listTargets(graph([a, b, c]));
  assert.deepEqual(
    targets.map((t) => t.label),
    ["Same", "Same (2)", "Same (3)"]
  );
  assert.deepEqual(
    targets.map((t) => t.node),
    [a, b, c]
  );
});

test("listTargets: a suffix never collides with a real label", () => {
  const out = labels(graph([node(1, "A"), node(2, "A"), node(3, "A (2)")]));
  assert.equal(new Set(out).size, 3);
});

test("listTargets: does not change the graph", () => {
  const root = graph([node(1, "T", [10, 10])], [box("G [1]", 0, 0)]);
  const before = JSON.stringify(root);
  listTargets(root);
  assert.equal(JSON.stringify(root), before);
});
