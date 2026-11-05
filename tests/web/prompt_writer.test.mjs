import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findTargetPrompt,
  formatStatus,
  modelLabel,
  stripTitles,
} from "../../web/prompt_writer_core.js";

test("stripTitles removes // lines and collapses blanks", () => {
  assert.equal(stripTitles("// Overview\n- A\n\n\n  // Subject 1\n- B\n"), "- A\n\n- B");
  assert.equal(stripTitles("a\r\n// t\r\nb"), "a\nb");
  assert.equal(stripTitles(""), "");
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

// --- fake graphs --------------------------------------------------------------

// Builds a graph whose links live in a Map (frontend 1.57) or a plain object.
function graph(nodes, links, { map = true, groups = [] } = {}) {
  const store = map ? new Map() : {};
  for (const [id, origin_id, origin_slot, target_id, target_slot] of links) {
    const link = { id, origin_id, origin_slot, target_id, target_slot };
    if (map) store.set(id, link);
    else store[id] = link;
  }
  return { _nodes: nodes, links: store, _groups: groups };
}

function node(id, type, inputLinks = [], extra = {}) {
  return {
    id,
    type,
    pos: extra.pos ?? [0, 0],
    size: extra.size ?? [100, 100],
    inputs: inputLinks.map((link, i) => ({ name: `in${i}`, link })),
    widgets: extra.widgets ?? [],
    properties: extra.properties ?? {},
    mode: 0,
    ...(extra.subgraph ? { subgraph: extra.subgraph } : {}),
  };
}

function send(id, name, link, opts = {}) {
  const n = node(id, "Warp Send", [], {
    pos: opts.pos,
    widgets: [
      { name: "name", value: name },
      { name: "index", value: opts.index ?? 1 },
    ],
    properties: { active: opts.active ?? true },
  });
  n.inputs = [{ name: "warp", link }];
  return n;
}

const PROMPT = "Warp Lora Prompt";

test("findTargetPrompt: direct links", () => {
  const prompt = node(1, PROMPT);
  const warp = node(2, "Warp", [10]);
  const s = send(3, "Krea", 11);
  const g = graph(
    [prompt, warp, s],
    [
      [10, 1, 0, 2, 0],
      [11, 2, 0, 3, 0],
    ]
  );
  assert.deepEqual(findTargetPrompt(g), { node: prompt, group: "Krea" });
  // plain-object links work too
  const g2 = graph(
    [prompt, warp, s],
    [
      [10, 1, 0, 2, 0],
      [11, 2, 0, 3, 0],
    ],
    { map: false }
  );
  assert.equal(findTargetPrompt(g2).node, prompt);
});

test("findTargetPrompt: group title names the group", () => {
  const prompt = node(1, PROMPT);
  const s = send(3, "Krea", 11, { pos: [50, 50] });
  const g = graph([prompt, s], [[11, 1, 0, 3, 0]], {
    groups: [{ title: "Krea 2", _bounding: [0, 0, 500, 500] }],
  });
  assert.deepEqual(findTargetPrompt(g), { node: prompt, group: "Krea 2" });
});

test("findTargetPrompt: prompt inside a subgraph node", () => {
  const prompt = node(1, PROMPT);
  const innerWarp = node(2, "Warp", [20]);
  // Inner: prompt -> warp -> subgraph output 0 (id -20). Output 1 fed by noise.
  const noise = node(4, "Noise");
  const sub = graph(
    [prompt, innerWarp, noise],
    [
      [20, 1, 0, 2, 0],
      [21, 2, 0, -20, 0],
      [22, 4, 0, -20, 1],
    ]
  );
  const sgNode = node(7, "uuid-subgraph", [], { subgraph: sub });
  const other = node(8, PROMPT); // feeds sgNode output 1's sibling: must not be found
  const s = send(9, "ZIT", 30);
  const root = graph([sgNode, other, s], [[30, 7, 0, 9, 0]]);
  assert.deepEqual(findTargetPrompt(root), { node: prompt, group: "ZIT" });
});

test("findTargetPrompt: send inside a subgraph, prompt outside via subgraph input", () => {
  const prompt = node(1, PROMPT);
  const innerWarp = node(2, "Warp", [40]);
  const s = send(3, "Inner", 41);
  const sub = graph(
    [innerWarp, s],
    [
      [40, -10, 0, 2, 0],
      [41, 2, 0, 3, 0],
    ]
  );
  const sgNode = node(5, "uuid-subgraph", [50], { subgraph: sub });
  const root = graph([prompt, sgNode], [[50, 1, 0, 5, 0]]);
  assert.deepEqual(findTargetPrompt(root), { node: prompt, group: "Inner" });
});

test("findTargetPrompt: nested subgraphs both ways", () => {
  // root: prompt -> outer(sg A) ; A contains inner(sg B) containing the Send.
  const prompt = node(1, PROMPT);
  const s = send(3, "Deep", 60);
  const subB = graph([s], [[60, -10, 0, 3, 0]]);
  const nodeB = node(4, "sgB", [61], { subgraph: subB });
  const subA = graph([nodeB], [[61, -10, 0, 4, 0]]);
  const nodeA = node(5, "sgA", [62], { subgraph: subA });
  const root = graph([prompt, nodeA], [[62, 1, 0, 5, 0]]);
  assert.equal(findTargetPrompt(root).node, prompt);
});

test("findTargetPrompt: group fallback without links", () => {
  const prompt = node(1, PROMPT, [], { pos: [100, 100], size: [200, 200] });
  const outside = node(2, PROMPT, [], { pos: [2000, 2000] });
  const s = send(3, "Krea", null, { pos: [400, 100] });
  s.size = [100, 100];
  const g = graph([prompt, outside, s], [], {
    groups: [
      { title: "Far", pos: [1900, 1900], size: [500, 500] },
      { title: "Krea 2", pos: [0, 0], size: [800, 600] },
    ],
  });
  assert.deepEqual(findTargetPrompt(g), { node: prompt, group: "Krea 2" });
});

test("findTargetPrompt: two distinct prompts upstream is an error naming the group", () => {
  const p1 = node(1, PROMPT);
  const p2 = node(2, PROMPT);
  const merge = node(3, "Merge", [10, 11]);
  const s = send(4, "ZIT", 12, { pos: [10, 10] });
  const g = graph(
    [p1, p2, merge, s],
    [
      [10, 1, 0, 3, 0],
      [11, 2, 0, 3, 1],
      [12, 3, 0, 4, 0],
    ],
    { groups: [{ title: "ZIT+ZIB", _bounding: [0, 0, 500, 500] }] }
  );
  const r = findTargetPrompt(g);
  assert.ok(r.error, "expected an error");
  assert.match(r.error, /ZIT\+ZIB/);
});

test("findTargetPrompt: same prompt reached twice is not ambiguous", () => {
  const p = node(1, PROMPT);
  const merge = node(3, "Merge", [10, 11]);
  const s = send(4, "A", 12);
  const g = graph(
    [p, merge, s],
    [
      [10, 1, 0, 3, 0],
      [11, 1, 1, 3, 1],
      [12, 3, 0, 4, 0],
    ]
  );
  assert.equal(findTargetPrompt(g).node, p);
});

test("findTargetPrompt: nothing found names the group", () => {
  const s = send(4, "Lonely", null);
  const r = findTargetPrompt(graph([s], []));
  assert.match(r.error, /Lonely/);
});

test("findTargetPrompt: no active Send", () => {
  const s = send(4, "A", null, { active: false });
  assert.deepEqual(findTargetPrompt(graph([s], [])), { error: "Activate a Warp Send first" });
  assert.deepEqual(findTargetPrompt(null), { error: "Activate a Warp Send first" });
});
