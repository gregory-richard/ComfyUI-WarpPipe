import assert from "node:assert/strict";
import { test } from "node:test";

import * as core from "../../web/prompt_writer_core.js";

const {
  activeLoraTags,
  addTriggerLine,
  appendLoraTag,
  buildLoraLists,
  findLora,
  formatStatus,
  isLoraListed,
  listTargets,
  loraIndex,
  loraToggleState,
  modelLabel,
  removeLoraTag,
  removeTriggerLine,
  resolveSuggestions,
  resolveTarget,
  targetLoraTags,
} = core;

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

// --- resolveTarget ------------------------------------------------------------

test("resolveTarget: the label, else the node it was opened from, else the first", () => {
  const a = { node: { id: 1 }, label: "A" };
  const b = { node: { id: 2 }, label: "B" };
  const targets = [a, b];
  assert.equal(resolveTarget(targets, "B", a.node), b);
  assert.equal(resolveTarget(targets, "Gone", b.node), b);
  assert.equal(resolveTarget(targets, null, b.node), b);
  assert.equal(resolveTarget(targets, "Gone", { id: 9 }), a);
  assert.equal(resolveTarget(targets, null, null), a);
  assert.equal(resolveTarget([], "B", a.node), null);
});

// --- activeLoraTags -----------------------------------------------------------

test("activeLoraTags reads names and weights", () => {
  assert.deepEqual(activeLoraTags("a <lora:one:0.8> b\n<lora:two.v2:1> <LORA:Three:-.5>"), [
    { name: "one", weight: 0.8 },
    { name: "two.v2", weight: 1 },
    { name: "Three", weight: -0.5 },
  ]);
});

test("activeLoraTags skips a tag after // anywhere earlier on its line", () => {
  const text = [
    "// <lora:off1:1>",
    "words // then <lora:off2:1>",
    "<lora:on1:1> // <lora:off3:1>",
    "<lora:on2:0.5>",
  ].join("\n");
  assert.deepEqual(
    activeLoraTags(text).map((t) => t.name),
    ["on1", "on2"]
  );
});

test("activeLoraTags on nothing", () => {
  assert.deepEqual(activeLoraTags(""), []);
  assert.deepEqual(activeLoraTags(null), []);
  assert.deepEqual(activeLoraTags("<lora:broken>"), []);
});

test("targetLoraTags reads text and loras, and loras_2 only when it is on", () => {
  const widgets = (on) => ({
    widgets: [
      { name: "text", value: "<lora:a:1>" },
      { name: "loras", value: "<lora:b:1>" },
      { name: "loras_2_on", value: on },
      { name: "loras_2", value: "<lora:c:1>" },
    ],
  });
  const names = (node) => targetLoraTags(node).map((t) => t.name);
  assert.deepEqual(names(widgets(false)), ["a", "b"]);
  assert.deepEqual(names(widgets(true)), ["a", "b", "c"]);
  assert.deepEqual(names({ widgets: [{ name: "loras", value: "<lora:b:1>" }] }), ["b"]);
  assert.deepEqual(names({}), []);
  assert.deepEqual(names(null), []);
});

// --- the library ---------------------------------------------------------------

const lora = (id, base, extra = {}) => ({
  id,
  name: id.split(/[\\/]/).pop().replace(/\.[^.]+$/, ""),
  title: null,
  base_model: base,
  folder: id.includes("\\") ? id.split("\\")[0] : "",
  triggers: [],
  thumbnail: null,
  ...extra,
});

const BASE = { name: "Flux.1 D", fromFolder: false };

test("findLora matches names the way the prompt does", () => {
  const entry = lora("sub\\Deep\\My.Lora.safetensors", "Flux.1 D");
  const index = loraIndex([entry]);
  for (const name of [
    "My.Lora",
    "my.lora",
    " My.Lora ",
    "sub\\Deep\\My.Lora",
    "sub/deep/my.lora",
    "other/My.Lora.safetensors",
  ]) {
    assert.equal(findLora(index, name), entry, name);
  }
  assert.equal(findLora(index, "nope"), null);
  assert.equal(findLora(index, ""), null);
  assert.equal(findLora(index, null), null);
});

test("loraIndex keeps the first file of a name", () => {
  const first = lora("a\\same.safetensors", "X");
  const second = lora("b\\same.safetensors", "X");
  assert.equal(findLora(loraIndex([first, second]), "same"), first);
});

test("buildLoraLists: available fits the base, numbered in order, minus active", () => {
  const entries = [
    lora("a.safetensors", "Flux.1 D", { title: "Title A", triggers: ["ta"] }),
    lora("other.safetensors", "SDXL 1.0"),
    lora("unknown.safetensors", ""),
    lora("b.safetensors", "flux1 d", { name: "Name B", triggers: [] }),
    lora("dir\\c.v2.safetensors", "Flux.1 D", { name: "" }),
    lora("d.safetensors", "Flux.1 D", { title: "D", triggers: ["td", "te"] }),
  ];
  const lists = buildLoraLists(entries, BASE, [{ name: "D", weight: 1 }]);
  assert.deepEqual(lists.available, [
    { ref: "L1", title: "Title A", triggers: ["ta"] },
    { ref: "L2", title: "Name B", triggers: [] },
    { ref: "L3", title: "c.v2", triggers: [] },
  ]);
  assert.deepEqual(lists.active, [{ title: "D", triggers: ["td", "te"] }]);
  assert.equal(lists.refs.get("L1"), entries[0]);
  assert.equal(lists.refs.get("L3"), entries[4]);
  assert.equal(lists.refs.size, 3);
});

test("buildLoraLists: active names each file once and may be of another base", () => {
  const entries = [
    lora("a.safetensors", "Flux.1 D", { title: "A" }),
    lora("other.safetensors", "SDXL 1.0", { title: "Other" }),
  ];
  const tags = [
    { name: "other", weight: 1 },
    { name: "OTHER", weight: 0.5 },
    { name: "not in the library", weight: 1 },
  ];
  const lists = buildLoraLists(entries, BASE, tags);
  assert.deepEqual(lists.active, [{ title: "Other", triggers: [] }]);
  assert.equal(lists.available.length, 1);
});

test("buildLoraLists: a base found from a folder matches the LoRA folder", () => {
  const moss = lora("moss\\a.safetensors", "Something Else");
  const lists = buildLoraLists([moss], { name: "moss", fromFolder: true }, []);
  assert.equal(lists.refs.get("L1"), moss);
});

test("buildLoraLists: unknown base or nothing fitting sends nothing", () => {
  const entries = [lora("a.safetensors", "Flux.1 D"), lora("b.safetensors", "")];
  const active = [{ name: "a", weight: 1 }];
  assert.equal(buildLoraLists(entries, null, active), null);
  assert.equal(buildLoraLists(entries, { name: "Pony" }, active), null);
  assert.equal(buildLoraLists([], BASE, active), null);
});

test("buildLoraLists: every fitting LoRA active leaves an empty available list", () => {
  const lists = buildLoraLists([lora("a.safetensors", "Flux.1 D")], BASE, [{ name: "a", weight: 1 }]);
  assert.deepEqual(lists.available, []);
  assert.equal(lists.active.length, 1);
});

test("buildLoraLists: at most 1000 available, as the server takes", () => {
  const entries = Array.from({ length: 1200 }, (_, i) => lora(`l${i}.safetensors`, "Flux.1 D"));
  const lists = buildLoraLists(entries, BASE, []);
  assert.equal(lists.available.length, 1000);
  assert.equal(lists.refs.size, 1000);
});

test("buildLoraLists tolerates an entry without triggers", () => {
  const entries = [lora("a.safetensors", "Flux.1 D", { triggers: undefined })];
  assert.deepEqual(buildLoraLists(entries, BASE, []).available[0].triggers, []);
});

test("resolveSuggestions stores what the chips need, from the job's map", () => {
  const entry = lora("dir\\soft.v2.safetensors", "Flux.1 D", {
    name: "soft",
    title: "Soft Light",
    thumbnail: "/t?name=soft",
    triggers: ["softlight"],
  });
  const refs = new Map([["L1", entry]]);
  const raw = [
    { ref: "L1", strength: 0.75, reason: "adds light" },
    { ref: "L9", strength: 1, reason: "not in the map" },
  ];
  assert.deepEqual(resolveSuggestions(raw, refs), [
    {
      id: "dir\\soft.v2.safetensors",
      name: "soft",
      title: "Soft Light",
      tag: "soft.v2",
      thumbnail: "/t?name=soft",
      triggers: ["softlight"],
      strength: 0.75,
      reason: "adds light",
    },
  ]);
});

test("resolveSuggestions without an answer or a map is empty", () => {
  assert.deepEqual(resolveSuggestions(undefined, new Map()), []);
  assert.deepEqual(resolveSuggestions([{ ref: "L1" }], undefined), []);
  assert.deepEqual(resolveSuggestions("x", new Map()), []);
});

// --- the composer's chip -------------------------------------------------------

test("loraToggleState", () => {
  const lists = { available: new Array(201), active: [], refs: new Map() };
  assert.deepEqual(loraToggleState(true, lists), { text: "LoRAs on · 201", accent: true });
  assert.deepEqual(loraToggleState(false, lists), { text: "LoRAs off", accent: false });
  assert.deepEqual(loraToggleState(false, null), { text: "LoRAs off", accent: false });
  assert.deepEqual(loraToggleState(true, null), {
    text: "LoRAs: none for this model",
    accent: false,
  });
  assert.deepEqual(loraToggleState(true, undefined), { text: "LoRAs on · …", accent: true });
});

// --- adding and removing a suggestion ------------------------------------------

test("appendLoraTag puts the tag on its own last line, strength with 2 decimals", () => {
  assert.equal(appendLoraTag("", "soft", 0.8), "<lora:soft:0.80>");
  assert.equal(appendLoraTag(null, "soft", 1), "<lora:soft:1.00>");
  assert.equal(appendLoraTag("<lora:a:1>", "soft", 1.25), "<lora:a:1>\n<lora:soft:1.25>");
  assert.equal(appendLoraTag("<lora:a:1>\n", "soft", 0.5), "<lora:a:1>\n<lora:soft:0.50>");
});

test("isLoraListed sees only uncommented tags with that name", () => {
  assert.equal(isLoraListed("<lora:soft:0.80>", "soft"), true);
  assert.equal(isLoraListed("<lora:Soft:1>", "SOFT"), true);
  assert.equal(isLoraListed("<lora:sub/soft:1>", "soft"), true);
  assert.equal(isLoraListed("<lora:sub\\soft.safetensors:1>", "soft"), true);
  assert.equal(isLoraListed("<lora:soft.v2:1>", "soft.v2"), true);
  assert.equal(isLoraListed("// <lora:soft:1>", "soft"), false);
  assert.equal(isLoraListed("<lora:softer:1>", "soft"), false);
  assert.equal(isLoraListed("", "soft"), false);
});

test("removeLoraTag removes the tag's line and nothing else", () => {
  assert.equal(removeLoraTag("<lora:a:1>\n<lora:soft:0.80>\n<lora:b:1>", "soft"), "<lora:a:1>\n<lora:b:1>");
  assert.equal(removeLoraTag("<lora:a:1>\n<lora:soft:0.80>", "soft"), "<lora:a:1>");
  assert.equal(removeLoraTag("<lora:soft:0.80>", "soft"), "");
  assert.equal(removeLoraTag("<lora:a:1>", "soft"), "<lora:a:1>");
});

test("removeLoraTag removes every live copy, so the chip goes back to +", () => {
  assert.equal(removeLoraTag("<lora:soft:1>\n<lora:a:1>\n<LORA:SOFT:0.5>", "soft"), "<lora:a:1>");
});

test("removeLoraTag leaves comments alone", () => {
  assert.equal(removeLoraTag("// <lora:soft:1>", "soft"), "// <lora:soft:1>");
  assert.equal(
    removeLoraTag("// <lora:soft:1>\n<lora:soft:1>", "soft"),
    "// <lora:soft:1>"
  );
});

test("removeLoraTag on a line shared with something else takes only the tag", () => {
  assert.equal(removeLoraTag("<lora:a:1> <lora:soft:1>", "soft"), "<lora:a:1>");
  assert.equal(removeLoraTag("<lora:soft:1> // why", "soft"), "// why");
});

test("removeLoraTag undoes appendLoraTag", () => {
  const before = "<lora:a:1>\n// note\n";
  const added = appendLoraTag(before, "soft", 0.8);
  assert.equal(removeLoraTag(added, "soft"), "<lora:a:1>\n// note");
});

test("addTriggerLine puts the words first, once", () => {
  assert.equal(addTriggerLine("the prompt", ["a", "b c"]), "a, b c\nthe prompt");
  assert.equal(addTriggerLine("", ["a"]), "a\n");
  assert.equal(addTriggerLine("the prompt", []), "the prompt");
  assert.equal(addTriggerLine("a, b\nthe prompt", ["a", "b"]), "a, b\nthe prompt");
});

test("removeTriggerLine removes only a first line that is still exactly the words", () => {
  assert.equal(removeTriggerLine("a, b c\nthe prompt", ["a", "b c"]), "the prompt");
  assert.equal(removeTriggerLine("a, edited\nthe prompt", ["a", "b c"]), "a, edited\nthe prompt");
  assert.equal(removeTriggerLine("the prompt\na, b", ["a", "b"]), "the prompt\na, b");
  assert.equal(removeTriggerLine("a, b", ["a", "b"]), "");
  assert.equal(removeTriggerLine("the prompt", []), "the prompt");
});

test("removeTriggerLine undoes addTriggerLine", () => {
  const added = addTriggerLine("line one\nline two", ["x", "y"]);
  assert.equal(removeTriggerLine(added, ["x", "y"]), "line one\nline two");
});
