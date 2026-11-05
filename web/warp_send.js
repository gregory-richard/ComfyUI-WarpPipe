import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { activate, collectSends, sortedNames, validateRoute } from "./warp_route.js";
import { addCompareWidget, imageRefs } from "./compare_widget.js";

// The hub: every model group ends in a Warp Send, one Warp Select hands the
// active Send's warp to the shared Generate, and the Warp Result at the end
// shows its images back in the Send that ran.
//
// Warp Select exists only in the browser. When the prompt is built, ComfyUI
// asks a virtual node where its outputs really come from, and this one names
// the active Send, wherever it lives, so the prompt holds only that group.

const SEND_ID = "Warp Send";
const SELECT_ID = "Warp Select";
const SELECT_TITLE = "🌀 Warp Select";
const RESULT_ID = "Warp Result";
const CATEGORY = "Custom/WarpPipe Nodes";

const ACTIVE_COLOR = "#2a5";
const DEFAULT_SIZE = [520, 860];
const ACTIVATE_LABEL = "activate";
const GO_TO_LABEL = "go to active group";

function rootGraph() {
  return app.rootGraph ?? app.graph ?? null;
}

function widgetNamed(node, name) {
  return (node.widgets ?? []).find((w) => w.name === name) ?? null;
}

/** Nodes of one type in the graph and in every subgraph inside it. */
function nodesOfType(graph, type, out = [], seen = new Set()) {
  if (!graph || seen.has(graph)) return out;
  seen.add(graph);
  for (const node of graph._nodes ?? []) {
    if (node.type === type) out.push(node);
    if (node.subgraph) nodesOfType(node.subgraph, type, out, seen);
  }
  return out;
}

/** The node whose subgraph is `graph`, for opening it from the canvas. */
function subgraphHost(graph, subgraph, seen = new Set()) {
  if (!graph || seen.has(graph)) return null;
  seen.add(graph);
  for (const node of graph._nodes ?? []) {
    if (!node.subgraph) continue;
    if (node.subgraph === subgraph) return node;
    const inner = subgraphHost(node.subgraph, subgraph, seen);
    if (inner) return inner;
  }
  return null;
}

function redraw() {
  app.canvas?.setDirty?.(true, true);
}

function warn(message) {
  window.alert(message);
}

// --- Keeping everything in step with the active Send -----------------------

// A colour the user gave the node is kept in its properties while it is active
// (the colour is saved with the workflow, so the one it replaces must be too)
// and given back when it is no longer active.
function markActive(node, on) {
  node.properties = node.properties ?? {};
  if (on) {
    if (node.color === ACTIVE_COLOR) return;
    if (node.color) node.properties._warpPrevColor = node.color;
    else delete node.properties._warpPrevColor;
    node.color = ACTIVE_COLOR;
  } else if (node.color === ACTIVE_COLOR) {
    node.color = node.properties._warpPrevColor || undefined;
    delete node.properties._warpPrevColor;
  }
}

/** The Result's target is written here, never by hand, so it is not shown. */
function hideTarget(node) {
  const widget = widgetNamed(node, "target");
  if (!widget) return null;
  widget.hidden = true;
  widget.computeSize = () => [0, -4];
  return widget;
}

// Sends that were just pasted, cloned, or moved into or out of a subgraph.
// Their copied `active` is only dropped later, in syncAll: a paste keeps the
// original, so its copy must not be a second active Send, but converting to a
// subgraph or unpacking one removes the original in the same tick, and then
// the copy is the active Send.
const newSends = new Set();

/** Settle which Send is active: at most one, and never a fresh copy beside its original. */
function settleActive(sends) {
  const isNew = (s) => newSends.has(s.node);
  newSends.clear();
  if (sends.some((s) => s.active && !isNew(s))) {
    for (const s of sends) {
      if (s.active && isNew(s)) {
        s.node.properties.active = false;
        s.active = false;
      }
    }
  }
  // Still more than one (an edited or old workflow): keep the first by index.
  const actives = sends.filter((s) => s.active);
  if (actives.length < 2) return;
  const keep = [...actives].sort((a, b) => a.index - b.index)[0];
  for (const s of actives) {
    if (s === keep) continue;
    s.node.properties.active = false;
    s.active = false;
  }
}

/** Title colours, every Select's combo and every Result's target. */
function syncAll() {
  const root = rootGraph();
  if (!root) return;
  const sends = collectSends(root);
  settleActive(sends);
  for (const s of sends) markActive(s.node, s.active);
  const active = sends.find((s) => s.active);
  const name = active ? active.name : "";
  for (const node of nodesOfType(root, RESULT_ID)) {
    const widget = hideTarget(node);
    if (widget && widget.value !== name) widget.value = name;
  }
  for (const node of nodesOfType(root, SELECT_ID)) {
    const widget = widgetNamed(node, "active");
    if (widget) widget.value = name;
  }
  redraw();
}

function syncSoon() {
  setTimeout(syncAll, 0);
}

function activateNode(node) {
  const root = rootGraph();
  if (!root) return;
  newSends.delete(node);
  // A fresh list: activate writes to the nodes it is handed.
  activate(collectSends(root), node);
  syncAll();
}

function activateByName(name) {
  const root = rootGraph();
  if (!root) return;
  const send = collectSends(root).find((s) => s.name === name);
  if (send) activateNode(send.node);
  else syncAll();
}

/** Why the queue must wait, or null. Only a workflow with a Select is checked. */
function routeError() {
  const root = rootGraph();
  if (!root || nodesOfType(root, SELECT_ID).length === 0) return null;
  const route = validateRoute(collectSends(root));
  return route.ok ? null : route.error;
}

function goToActive() {
  const root = rootGraph();
  const canvas = app.canvas;
  if (!root || !canvas) return;
  const sends = collectSends(root);
  const send = sends.find((s) => s.active);
  if (!send) {
    const route = validateRoute(sends);
    if (!route.ok) warn(route.error);
    return;
  }
  if (canvas.graph !== send.graph) {
    if (send.graph === root) canvas.setGraph(root);
    else canvas.openSubgraph(send.graph, subgraphHost(root, send.graph));
  }
  // After the canvas has switched graphs and measured itself.
  setTimeout(() => {
    canvas.centerOnNode(send.node);
    canvas.selectNode?.(send.node, false);
    canvas.setDirty(true, true);
  }, 0);
}

// --- The result compare widget -----------------------------------------------

const COMPARE_ID = "Warp Compare";
const COMPARE_SIZE = [400, 480];
const COMPARE_WIDGET = "warp_compare";

function addCompare(node) {
  node._warpCompare = addCompareWidget(node, COMPARE_WIDGET, {
    apiURL: (path) => api.apiURL(path),
    getCanvas: () => app.canvas?.canvas ?? null,
  });
  return node._warpCompare;
}

// Send name -> {first, final} image refs of its last result. Kept for this
// page only: the temp files are gone after a ComfyUI restart anyway, and a
// result is not an edit, so it must not mark the workflow modified or add an
// undo step. Keyed by name because that is how a Warp Result names its Send; a
// renamed Send shows whatever its new name last produced.
const results = new Map();

/** Show the last result for the Send's current name, or "no result yet". */
function showResult(node) {
  const compare = node?._warpCompare;
  if (!compare) return;
  const result = results.get(widgetNamed(node, "name")?.value);
  if (result) compare.setPairs(result.first, result.final);
  else compare.setPairs([], []);
}

/** Show `img` full size in the Send's compare widget until the next result, or clear it. */
function drawPreviewInto(sendNode, img) {
  if (!sendNode) return;
  sendNode._warpPreview = img ?? null;
  sendNode._warpCompare?.setLive(img ?? null);
}

// --- Live sampling preview -----------------------------------------------------

// prompt id -> the Send that was active when that prompt was submitted.
const trackedPrompts = new Map();
const MAX_TRACKED = 32;
let decodeTicket = 0;

function activeSendNode() {
  const root = rootGraph();
  if (!root || nodesOfType(root, SELECT_ID).length === 0) return null;
  return collectSends(root).find((s) => s.active)?.node ?? null;
}

function track(promptId, send) {
  if (!promptId || !send) return;
  trackedPrompts.set(promptId, send);
  while (trackedPrompts.size > MAX_TRACKED) {
    trackedPrompts.delete(trackedPrompts.keys().next().value);
  }
}

async function showFrame(promptId, blob) {
  const send = trackedPrompts.get(promptId);
  if (!send || !(blob instanceof Blob)) return;
  // Only the newest frame is decoded and shown; an older one finishing late is dropped.
  const ticket = ++decodeTicket;
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return;
  }
  if (ticket !== decodeTicket || !trackedPrompts.has(promptId)) {
    bitmap.close?.();
    return;
  }
  const old = send._warpPreview;
  drawPreviewInto(send, bitmap);
  if (old && old !== bitmap) old.close?.();
}

function endPrompt(promptId) {
  const send = trackedPrompts.get(promptId);
  if (!send) return;
  trackedPrompts.delete(promptId);
  decodeTicket++;
  const old = send._warpPreview;
  drawPreviewInto(send, null);
  old?.close?.();
}

function setupPreviewMirror() {
  // queuePrompt answers with a boolean; the prompt id only comes back from the API call.
  const originalQueue = api.queuePrompt;
  api.queuePrompt = async function (...args) {
    const send = activeSendNode();
    const response = await originalQueue.apply(this, args);
    track(response?.prompt_id, send);
    return response;
  };

  let sawMetadata = false;
  api.addEventListener("b_preview_with_metadata", ({ detail }) => {
    sawMetadata = true;
    showFrame(detail?.jobId ?? detail?.promptId, detail?.blob);
  });
  // Without metadata there is no prompt id: the running prompt is the newest tracked one.
  api.addEventListener("b_preview", ({ detail }) => {
    if (sawMetadata) return;
    const last = [...trackedPrompts.keys()].pop();
    if (last) showFrame(last, detail);
  });
  for (const type of ["execution_success", "execution_error", "execution_interrupted"]) {
    api.addEventListener(type, ({ detail }) => endPrompt(detail?.prompt_id));
  }
}

window.WarpPipe = window.WarpPipe ?? {};
window.WarpPipe.warpSend = { ...(window.WarpPipe.warpSend ?? {}), drawPreviewInto };

// --- Node setup ----------------------------------------------------------------

function wrap(proto, method, after) {
  const prior = proto[method];
  proto[method] = function (...args) {
    const result = prior?.apply(this, args);
    after.apply(this, args);
    return result;
  };
}

function setupSend(nodeType) {
  const proto = nodeType.prototype;

  wrap(proto, "onNodeCreated", function () {
    this.properties = this.properties ?? {};
    if (this.properties.active == null) this.properties.active = false;

    // The route reads index and name from these; both come from the backend.
    for (const name of ["index", "name"]) {
      const widget = widgetNamed(this, name);
      if (!widget) {
        console.warn(`[WarpPipe] Warp Send ${this.id} has no "${name}" widget.`);
        continue;
      }
      const prior = widget.callback;
      const node = this;
      widget.callback = function (...args) {
        const result = prior?.apply(this, args);
        if (!app.configuringGraph) syncAll();
        if (name === "name") showResult(node);
        return result;
      };
    }

    const button = this.addWidget("button", ACTIVATE_LABEL, null, () => activateNode(this), {
      serialize: false,
    });
    if (button) button.serialize = false;
    addCompare(this);
    this.setSize([...DEFAULT_SIZE]);
  });

  // A paste, a subgraph convert or unpack adds a copy of a Send outside a
  // workflow load (which keeps the active state it saved). Whichever order the
  // frontend adds and configures it in, syncAll settles the copy afterwards,
  // once the original has either stayed or gone.
  wrap(proto, "onAdded", function () {
    if (!app.configuringGraph) newSends.add(this);
    syncSoon();
  });

  wrap(proto, "onConfigure", function () {
    showResult(this);
    syncSoon();
  });

  const priorClone = proto.clone;
  proto.clone = function (...args) {
    const copy = priorClone.apply(this, args);
    if (copy) {
      newSends.add(copy);
      syncSoon();
    }
    return copy;
  };

  wrap(proto, "onRemoved", function () {
    syncSoon();
  });
}

function setupCompare(nodeType) {
  const proto = nodeType.prototype;
  wrap(proto, "onNodeCreated", function () {
    addCompare(this);
    this.setSize([...COMPARE_SIZE]);
  });
  // Its output is {a: [ref…], b: [ref…]}, one temp image per batch item.
  wrap(proto, "onExecuted", function (output) {
    this._warpCompare?.setPairs(output?.a, output?.b);
  });
}

function setupResult(nodeType) {
  const proto = nodeType.prototype;
  wrap(proto, "onNodeCreated", function () {
    hideTarget(this);
    syncSoon();
  });
  wrap(proto, "onConfigure", function () {
    hideTarget(this);
    syncSoon();
  });
}

function registerSelect() {
  const { LiteGraph, LGraphNode } = window;

  class WarpSelectNode extends LGraphNode {
    static title = SELECT_TITLE;
    static category = CATEGORY;

    constructor(title) {
      super(title ?? SELECT_TITLE);
      this.isVirtualNode = true;
      this.serialize_widgets = true;
      this.properties = this.properties ?? {};
      this.addOutput("warp", "WARPPIPE");
      this.addOutput("index", "INT");

      // Read on every open, so the list is always the Sends there are now.
      const options = {};
      Object.defineProperty(options, "values", {
        get: () => {
          const root = rootGraph();
          const names = root ? sortedNames(collectSends(root)) : [];
          return names.length ? names : [""];
        },
        enumerable: true,
        configurable: true,
      });
      this.addWidget(
        "combo",
        "active",
        "",
        (value) => {
          if (!app.configuringGraph) activateByName(value);
        },
        options
      );
      const button = this.addWidget("button", GO_TO_LABEL, null, () => goToActive(), {
        serialize: false,
      });
      if (button) button.serialize = false;
      this.size = this.computeSize();
    }

    // The Sends say which one is active; the saved combo value only follows.
    onConfigure() {
      syncSoon();
    }

    onAdded() {
      syncSoon();
    }

    /** Where ComfyUI should take this output from: the active Send's. */
    resolveVirtualOutput(slot) {
      if (slot !== 0 && slot !== 1) return undefined;
      const root = rootGraph();
      if (!root) return undefined;
      const route = validateRoute(collectSends(root));
      if (route.ok) return { node: route.send.node, slot };
      console.warn(route.error);
      return undefined;
    }
  }

  LiteGraph.registerNodeType(SELECT_ID, WarpSelectNode);
}

app.registerExtension({
  name: "WarpPipe.WarpSend",

  async setup() {
    // Every way to queue goes through app.queuePrompt.
    const original = app.queuePrompt;
    app.queuePrompt = async function (...args) {
      const error = routeError();
      if (error) {
        warn(error);
        return false;
      }
      // The Result's target goes into the prompt; make sure it names this Send.
      syncAll();
      return original.apply(this, args);
    };

    setupPreviewMirror();

    api.addEventListener("executed", ({ detail }) => {
      const output = detail?.output;
      if (!output || !Array.isArray(output.target)) return;
      if (!("first" in output) && !("final" in output)) return;
      const name = output.target[0];
      if (typeof name !== "string" || name === "") return;
      const root = rootGraph();
      if (!root) return;
      const send = collectSends(root).find((s) => s.name === name);
      if (!send) return;
      results.set(name, { first: imageRefs(output.first), final: imageRefs(output.final) });
      const node = send.node;
      const old = node._warpPreview;
      drawPreviewInto(node, null);
      old?.close?.();
      showResult(node);
    });
  },

  registerCustomNodes() {
    registerSelect();
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === SEND_ID) setupSend(nodeType);
    else if (nodeData.name === COMPARE_ID) setupCompare(nodeType);
    else if (nodeData.name === RESULT_ID) setupResult(nodeType);
  },
});
