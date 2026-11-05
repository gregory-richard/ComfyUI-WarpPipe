// Routing for Warp Select: which Warp Send is active, and whether the
// workflow is in a state that can run.
//
// Kept apart from the extension that uses it so it can be tested without a
// ComfyUI page around it.

const MUTED_MODES = [2, 4]; // muted, bypassed

function widgetValue(node, name) {
  const widget = (node.widgets ?? []).find((w) => w.name === name);
  return widget ? widget.value : undefined;
}

// `muted` is true inside a subgraph node that is itself muted or bypassed:
// nothing in there runs, whatever its own mode says.
function collectInto(graph, out, muted = false) {
  for (const node of graph?._nodes ?? []) {
    const off = muted || MUTED_MODES.includes(node.mode);
    if (node.type === "Warp Send") {
      const warp = (node.inputs ?? []).find((input) => input.name === "warp");
      out.push({
        node,
        graph,
        name: String(widgetValue(node, "name") ?? ""),
        index: Number(widgetValue(node, "index")),
        active: node.properties?.active === true,
        muted: off,
        hasWarp: warp?.link != null,
      });
    }
    if (node.subgraph?._nodes) collectInto(node.subgraph, out, off);
  }
}

/** Every Warp Send in the graph and in the subgraphs inside it. */
export function collectSends(rootGraph) {
  const out = [];
  collectInto(rootGraph, out);
  return out;
}

function firstDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) return { value };
    seen.add(value);
  }
  return null;
}

/** The active Send, or the reason the queue should be blocked. */
export function validateRoute(sends) {
  const fail = (error) => ({ ok: false, error });
  if (sends.length === 0) return fail("Warp Select: this workflow has no Warp Send.");

  const dupName = firstDuplicate(sends.map((s) => s.name));
  if (dupName) return fail(`Warp Select: two Warp Sends are named "${dupName.value}".`);

  const dupIndex = firstDuplicate(sends.map((s) => s.index));
  if (dupIndex) return fail(`Warp Select: two Warp Sends use index ${dupIndex.value}.`);

  const send = sends.find((s) => s.active);
  if (!send) return fail("Warp Select: no Warp Send is active.");
  if (send.muted) {
    return fail(`Warp Select: the active Warp Send "${send.name}" is muted or bypassed.`);
  }
  if (!send.hasWarp) {
    return fail(`Warp Select: the active Warp Send "${send.name}" has no warp input.`);
  }
  return { ok: true, send };
}

/** Make `node` the only active Send. */
export function activate(sends, node) {
  for (const s of sends) {
    s.node.properties = s.node.properties ?? {};
    s.node.properties.active = s.node === node;
  }
}

/** Send names in index order, for the Select's combo. */
export function sortedNames(sends) {
  return [...sends].sort((a, b) => a.index - b.index).map((s) => s.name);
}
