import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BEFORE_PROP,
  GREEN,
  RED,
  activeLine,
  allNodes,
  markBefore,
  nodeByExecutionId,
  outputImages,
  resultRole,
  resultRoles,
  settleBefore,
  stateColors,
} from "../../web/warp_route.js";

const ref = (filename) => ({ filename, subfolder: "", type: "temp" });

test("resultRole: Save Image (Civitai) is final, the marked node is before", () => {
  assert.equal(resultRole({ type: "Save Image Civitai" }), "final");
  assert.equal(resultRole({ type: "X", comfyClass: "Save Image Civitai" }), "final");
  assert.equal(resultRole({ type: "PreviewImage", properties: { warpBefore: true } }), "before");
  assert.equal(
    resultRole({ type: "Save Image Civitai", properties: { warpBefore: true } }),
    "before"
  );
  assert.equal(resultRole({ type: "PreviewImage", properties: {} }), null);
  assert.equal(resultRole({ type: "PreviewImage", properties: { warpBefore: false } }), null);
  assert.equal(resultRole(null), null);
});

test("outputImages: images first, else the first list of image refs", () => {
  assert.deepEqual(outputImages({ images: [ref("a")], a: [ref("b")] }), [ref("a")]);
  assert.deepEqual(outputImages({ text: ["x"], a: [ref("b")], b: [ref("c")] }), [ref("b")]);
  assert.deepEqual(outputImages({ images: [], a: [ref("b")] }), [ref("b")]);
  assert.deepEqual(outputImages({ text: ["x"] }), []);
  assert.deepEqual(outputImages(null), []);
});

test("nodeByExecutionId walks subgraph paths", () => {
  const deep = { id: 7, type: "PreviewImage" };
  const inner = { id: 3, subgraph: { _nodes: [deep] } };
  const outer = { id: 12, subgraph: { _nodes: [inner, { id: 7, type: "Other" }] } };
  const top = { id: 7, type: "Top" };
  const root = { _nodes: [outer, top] };
  assert.equal(nodeByExecutionId(root, "7"), top);
  assert.equal(nodeByExecutionId(root, 7), top);
  assert.equal(nodeByExecutionId(root, "12:3:7"), deep);
  assert.equal(nodeByExecutionId(root, "12:7").type, "Other");
  assert.equal(nodeByExecutionId(root, "12:9"), null);
  assert.equal(nodeByExecutionId(root, "7:1"), null);
  assert.equal(nodeByExecutionId(root, ""), null);
  assert.equal(nodeByExecutionId(root, null), null);
});

test("markBefore keeps one mark across subgraphs, null clears it", () => {
  const a = { id: 1, properties: { warpBefore: true } };
  const b = { id: 2 };
  const c = { id: 3, properties: { warpBefore: true, other: 1 } };
  const root = { _nodes: [a, { id: 9, subgraph: { _nodes: [b, c] } }] };
  assert.equal(allNodes(root).length, 4);
  markBefore(root, b);
  assert.equal(b.properties[BEFORE_PROP], true);
  assert.equal(BEFORE_PROP in a.properties, false);
  assert.deepEqual(c.properties, { other: 1 });
  markBefore(root, null);
  assert.equal(BEFORE_PROP in b.properties, false);
});

test("settleBefore drops a pasted copy of the mark", () => {
  const a = { id: 1, properties: { warpBefore: true } };
  const copy = { id: 2, properties: { warpBefore: true } };
  const root = { _nodes: [a, copy] };
  assert.equal(settleBefore(root), a);
  assert.equal(a.properties.warpBefore, true);
  assert.equal(BEFORE_PROP in copy.properties, false);
  assert.equal(settleBefore({ _nodes: [{ id: 1 }] }), null);
});

test("colours and the active line", () => {
  assert.deepEqual(GREEN, { color: "#2a5", bgcolor: "#1b3d26" });
  assert.deepEqual(RED, { color: "#a33", bgcolor: "#3d1b1b" });
  assert.equal(stateColors(true), GREEN);
  assert.equal(stateColors(false), RED);
  assert.equal(
    activeLine([
      { name: "A", active: false },
      { name: "Krea 2", active: true },
    ]),
    "active: Krea 2"
  );
  assert.equal(activeLine([{ name: "A", active: false }]), "active: none");
  assert.equal(activeLine([]), "active: none");
});

const graphOf = (...nodes) => ({ _nodes: nodes });
const save = (id) => ({ id, type: "Save Image Civitai", properties: {} });
const marked = (id) => ({ id, type: "PreviewImage", properties: { warpBefore: true } });
const plain = (id) => ({ id, type: "PreviewImage", properties: {} });

test("resultRoles: root nodes by plain id, plain nodes left out", () => {
  const roles = resultRoles(graphOf(save(4), marked(9), plain(2)));
  assert.deepEqual(
    [...roles],
    [
      ["4", "final"],
      ["9", "before"],
    ]
  );
});

test("resultRoles: nested subgraphs give path ids", () => {
  const inner = graphOf(save(7));
  const middle = graphOf(marked(5), { id: 3, subgraph: inner });
  const roles = resultRoles(graphOf({ id: 12, subgraph: middle }, plain(1)));
  assert.deepEqual(
    [...roles],
    [
      ["12:5", "before"],
      ["12:3:7", "final"],
    ]
  );
});

test("resultRoles: a shared subgraph definition is walked once per use", () => {
  const shared = graphOf(save(2), marked(3));
  const roles = resultRoles(graphOf({ id: 10, subgraph: shared }, { id: 11, subgraph: shared }));
  assert.deepEqual(
    [...roles],
    [
      ["10:2", "final"],
      ["10:3", "before"],
      ["11:2", "final"],
      ["11:3", "before"],
    ]
  );
});

test("resultRoles: a graph that holds itself does not loop", () => {
  const loop = graphOf(save(1));
  loop._nodes.push({ id: 2, subgraph: loop });
  assert.deepEqual([...resultRoles(loop)], [["1", "final"]]);
});
