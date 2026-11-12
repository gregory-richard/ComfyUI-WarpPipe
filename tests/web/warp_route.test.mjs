import assert from "node:assert/strict";
import { test } from "node:test";

import { activate, collectSends, sortedNames, validateRoute } from "../../web/warp_route.js";

function send(name, index, opts = {}) {
  return {
    type: "Warp Send",
    widgets: [
      { name: "name", value: name },
      { name: "index", value: index },
    ],
    properties: { active: !!opts.active },
    mode: opts.mode ?? 0,
    inputs: [{ name: "warp", link: "link" in opts ? opts.link : 5 }],
  };
}

function infos(...nodes) {
  return collectSends({ _nodes: nodes });
}

test("collectSends finds sends in nested subgraphs", () => {
  const deep = { type: "Group", subgraph: { _nodes: [send("Deep", 3)] } };
  const inner = {
    type: "Group",
    subgraph: { _nodes: [send("Inner", 2), deep] },
  };
  const root = { _nodes: [send("Krea 2", 7, { active: true }), { type: "Other" }, inner] };
  const found = collectSends(root);
  assert.equal(found.length, 3);
  const krea = found.find((s) => s.name === "Krea 2");
  assert.equal(krea.graph, root);
  assert.equal(krea.index, 7);
  assert.equal(krea.active, true);
  assert.equal(krea.muted, false);
  assert.equal(krea.hasWarp, true);
  assert.equal(found.find((s) => s.name === "Inner").graph, inner.subgraph);

  const two = collectSends({
    _nodes: [send("A", 1), { type: "Group", subgraph: { _nodes: [send("B", 2)] } }],
  });
  assert.equal(two.length, 2);
});

test("validateRoute: no sends", () => {
  assert.deepEqual(validateRoute([]), {
    ok: false,
    error: "Warp Select: this workflow has no Warp Send.",
  });
});

test("validateRoute: duplicate name", () => {
  const r = validateRoute(infos(send("A", 1, { active: true }), send("A", 2)));
  assert.equal(r.error, 'Warp Select: two Warp Sends are named "A".');
  assert.equal(r.ok, false);
});

test("validateRoute: duplicate index", () => {
  const r = validateRoute(infos(send("A", 1, { active: true }), send("B", 1)));
  assert.equal(r.error, "Warp Select: two Warp Sends use index 1.");
});

test("validateRoute: none active", () => {
  const r = validateRoute(infos(send("A", 1), send("B", 2)));
  assert.equal(r.error, "Warp Select: no Warp Send is active.");
});

test("validateRoute: deleted active send", () => {
  // The previously active Send is gone; the rest are inactive.
  const r = validateRoute(infos(send("B", 2)));
  assert.equal(r.error, "Warp Select: no Warp Send is active.");
});

test("validateRoute: muted or bypassed", () => {
  for (const mode of [2, 4]) {
    const r = validateRoute(infos(send("A", 1, { active: true, mode })));
    assert.equal(r.error, 'Warp Select: the active Warp Send "A" is muted or bypassed.');
  }
});

test("validateRoute: active send inside a muted or bypassed subgraph", () => {
  for (const mode of [2, 4]) {
    const host = { type: "Group", mode, subgraph: { _nodes: [send("A", 1, { active: true })] } };
    const sends = collectSends({ _nodes: [send("B", 2), host] });
    assert.equal(sends.find((s) => s.name === "A").muted, true);
    assert.equal(sends.find((s) => s.name === "B").muted, false);
    const r = validateRoute(sends);
    assert.equal(r.error, 'Warp Select: the active Warp Send "A" is muted or bypassed.');
  }
  // Deeper still: a bypassed host two levels up mutes the Send too.
  const inner = { type: "Group", mode: 0, subgraph: { _nodes: [send("C", 3, { active: true })] } };
  const outer = { type: "Group", mode: 4, subgraph: { _nodes: [inner] } };
  const r = validateRoute(collectSends({ _nodes: [outer] }));
  assert.equal(r.error, 'Warp Select: the active Warp Send "C" is muted or bypassed.');
});

test("validateRoute: no warp link", () => {
  for (const link of [null, undefined]) {
    const r = validateRoute(infos(send("A", 1, { active: true, link })));
    assert.equal(r.error, 'Warp Select: the active Warp Send "A" has no warp input.');
  }
});

test("validateRoute ok", () => {
  const sends = infos(send("A", 1), send("B", 2, { active: true }));
  const r = validateRoute(sends);
  assert.equal(r.ok, true);
  assert.equal(r.send.name, "B");
});

test("activate clears others", () => {
  const nodes = [send("A", 1, { active: true }), send("B", 2), send("C", 3, { active: true })];
  const sends = infos(...nodes);
  activate(sends, nodes[1]);
  assert.deepEqual(
    nodes.map((n) => n.properties.active === true),
    [false, true, false]
  );
});

test("sortedNames orders by index", () => {
  const sends = infos(send("Krea 2", 7), send("Flux 2", 1));
  assert.deepEqual(sortedNames(sends), ["Flux 2", "Krea 2"]);
});
