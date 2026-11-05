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

// --- Results, the before mark and colours ------------------------------------

export const SAVE_IMAGE_ID = "Save Image Civitai";
export const BEFORE_PROP = "warpBefore";

export const GREEN = { color: "#2a5", bgcolor: "#1b3d26" };
export const RED = { color: "#a33", bgcolor: "#3d1b1b" };

/** The colours a Send or a Select shows: green when `ok`, red otherwise. */
export function stateColors(ok) {
  return ok ? GREEN : RED;
}

/** The line an inactive Send shows under its button. */
export function activeLine(sends) {
  const active = sends.find((s) => s.active);
  return `active: ${active ? active.name : "none"}`;
}

/**
 * What a node's `executed` output is for the active Send: "before" for the
 * marked node, "final" for Save Image (Civitai), otherwise null. The mark
 * wins, so a marked Save Image gives the before side.
 */
export function resultRole(node) {
  if (!node) return null;
  if (node.properties?.[BEFORE_PROP] === true) return "before";
  const type = node.comfyClass ?? node.type;
  if (type === SAVE_IMAGE_ID || node.type === SAVE_IMAGE_ID) return "final";
  return null;
}

/**
 * What each node's `executed` output is for a run, by execution id: "final"
 * or "before". Inside subgraphs the id is a path ("12:3:7"). A subgraph used
 * by two subgraph nodes runs under two paths, so each use is walked.
 */
export function resultRoles(graph, prefix = "", out = new Map(), path = new Set()) {
  if (!graph || path.has(graph)) return out;
  path.add(graph);
  for (const node of graph._nodes ?? []) {
    const id = `${prefix}${node.id}`;
    const role = resultRole(node);
    if (role) out.set(id, role);
    if (node.subgraph) resultRoles(node.subgraph, `${id}:`, out, path);
  }
  path.delete(graph);
  return out;
}

function isRefList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((ref) => ref && typeof ref.filename === "string")
  );
}

/** The images in an `executed` output: `images`, or else the first list of image refs. */
export function outputImages(output) {
  if (!output || typeof output !== "object") return [];
  if (isRefList(output.images)) return output.images;
  for (const value of Object.values(output)) if (isRefList(value)) return value;
  return [];
}

function nodeIn(graph, id) {
  return (graph?._nodes ?? []).find((node) => String(node.id) === id) ?? null;
}

/**
 * The node an execution id names. Inside subgraphs the id is a path,
 * "outer:inner:node", one subgraph node id per level.
 */
export function nodeByExecutionId(rootGraph, id) {
  if (id == null || id === "") return null;
  const parts = String(id).split(":");
  let graph = rootGraph;
  let node = null;
  for (const part of parts) {
    node = nodeIn(graph, part);
    if (!node) return null;
    graph = node.subgraph;
  }
  return node;
}

/** Every node in the graph and in the subgraphs inside it. */
export function allNodes(graph, out = [], seen = new Set()) {
  if (!graph || seen.has(graph)) return out;
  seen.add(graph);
  for (const node of graph._nodes ?? []) {
    out.push(node);
    if (node.subgraph) allNodes(node.subgraph, out, seen);
  }
  return out;
}

/** Make `target` the only node marked as the before image; null clears the mark. */
export function markBefore(rootGraph, target) {
  for (const node of allNodes(rootGraph)) {
    if (node === target) {
      node.properties = node.properties ?? {};
      node.properties[BEFORE_PROP] = true;
    } else if (node.properties && BEFORE_PROP in node.properties) {
      delete node.properties[BEFORE_PROP];
    }
  }
}

/** Keep at most one mark (a paste copies it): the first node found keeps it. */
export function settleBefore(rootGraph) {
  const marked = allNodes(rootGraph).filter((n) => n.properties?.[BEFORE_PROP] === true);
  if (marked.length > 1) markBefore(rootGraph, marked[0]);
  return marked[0] ?? null;
}
