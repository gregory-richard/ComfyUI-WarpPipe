import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  activate,
  activeLine,
  allNodes,
  BEFORE_PROP,
  collectSends,
  markBefore,
  nodeByExecutionId,
  outputImages,
  resultRole,
  settleBefore,
  sortedNames,
  stateColors,
  validateRoute,
} from "./warp_route.js";
import { addCompareWidget, forwardToCanvas, imageRefs } from "./compare_widget.js";

// The hub: every model group ends in a Warp Send, and one Warp Select hands the
// active Send's warp to the shared Generate. The run's images come back to the
// Send that was active when it was queued: Save Image (Civitai) gives the
// final side, the one node marked "before" gives the other.
//
// Warp Select exists only in the browser. When the prompt is built, ComfyUI
// asks a virtual node where its outputs really come from, and this one names
// the active Send, wherever it lives, so the prompt holds only that group.

const SEND_ID = "Warp Send";
const SELECT_ID = "Warp Select";
const SELECT_TITLE = "🌀 Warp Select";
const CATEGORY = "Custom/WarpPipe Nodes";

const DEFAULT_SIZE = [520, 860];
const ACTIVATE_LABEL = "activate";
const ACTIVE_LABEL = "active";
const GO_TO_LABEL = "go to active group";
const MARK_LABEL = "Use as before image for Warp Send";
const UNMARK_LABEL = "Remove before-image mark";
const BADGE_TEXT = "before";

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

// Sends and Selects are always coloured by their state, so a colour set by
// hand does not last; the property the older version kept one in is dropped.
function paint(node, ok) {
  const { color, bgcolor } = stateColors(ok);
  if (node.color !== color) node.color = color;
  if (node.bgcolor !== bgcolor) node.bgcolor = bgcolor;
  if (node.properties && "_warpPrevColor" in node.properties) {
    delete node.properties._warpPrevColor;
  }
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

// --- The before mark -------------------------------------------------------------

// One badge object, shown on whichever node carries the mark. The node badge
// list is drawn by the classic canvas and read by Vue nodes.
let beforeBadge = null;

function badge() {
  const Badge = window.LGraphBadge;
  if (!beforeBadge && Badge) {
    beforeBadge = new Badge({ text: BADGE_TEXT, fgColor: "#fff", bgColor: "#b60" });
  }
  return beforeBadge;
}

function showBadge(node, on) {
  const mark = badge();
  if (!mark) return;
  const list = Array.isArray(node.badges) ? node.badges : [];
  if (list.includes(mark) === on) return;
  // A new array, so a Vue node that watches the list sees the change.
  node.badges = on ? [...list, mark] : list.filter((b) => b !== mark);
}

function syncBefore(root) {
  settleBefore(root);
  for (const node of allNodes(root)) showBadge(node, node.properties?.[BEFORE_PROP] === true);
}

function toggleBefore(node) {
  const root = rootGraph();
  if (!root || !node) return;
  const marked = node.properties?.[BEFORE_PROP] === true;
  markBefore(root, marked ? null : node);
  syncAll();
}

// --- Syncing -----------------------------------------------------------------------

/** Colours, the activate buttons, every Select's combo and the before badge. */
function syncAll() {
  const root = rootGraph();
  if (!root) return;
  const sends = collectSends(root);
  settleActive(sends);
  const line = activeLine(sends);
  for (const s of sends) {
    paint(s.node, s.active);
    s.node._warpActivate?.update(s.active, line);
  }
  const active = sends.find((s) => s.active);
  const name = active ? active.name : "";
  const ok = validateRoute(sends).ok;
  for (const node of nodesOfType(root, SELECT_ID)) {
    paint(node, ok);
    const widget = widgetNamed(node, "active");
    if (widget) widget.value = name;
  }
  syncBefore(root);
  redraw();
}

// Loads and pastes add many nodes in one tick; one sync after them is enough.
let syncPending = false;

function syncSoon() {
  if (syncPending) return;
  syncPending = true;
  setTimeout(() => {
    syncPending = false;
    syncAll();
  }, 0);
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

// --- The activate button -----------------------------------------------------------

const BUTTON_H = 3 * (window.LiteGraph?.NODE_WIDGET_HEIGHT ?? 20);
const LINE_H = 18;
const GAP = 4;
const ACTIVATE_H = BUTTON_H + GAP + LINE_H;

const BUTTON_UP = {
  background: "#333",
  color: "#eee",
  border: "1px solid #555",
  boxShadow: "0 2px 0 #111",
  transform: "none",
  cursor: "pointer",
};
const BUTTON_DOWN = {
  background: "#17462a",
  color: "#cfe9d7",
  border: "1px solid #2a5",
  boxShadow: "inset 0 3px 6px rgba(0,0,0,0.6)",
  transform: "translateY(1px)",
  cursor: "default",
};

/**
 * The big "activate" button and, on an inactive Send, the line naming the
 * active one. A DOM widget, so it looks and sizes the same in both renderers.
 */
function addActivate(node) {
  const root = document.createElement("div");
  Object.assign(root.style, {
    display: "flex",
    flexDirection: "column",
    gap: `${GAP}px`,
    width: "100%",
    height: `${ACTIVATE_H}px`,
    boxSizing: "border-box",
  });
  const button = document.createElement("button");
  button.type = "button";
  Object.assign(button.style, {
    flex: `0 0 ${BUTTON_H}px`,
    width: "100%",
    padding: "0",
    borderRadius: "6px",
    font: "bold 18px sans-serif",
    ...BUTTON_UP,
  });
  button.textContent = ACTIVATE_LABEL;
  const line = document.createElement("div");
  Object.assign(line.style, {
    flex: `0 0 ${LINE_H}px`,
    lineHeight: `${LINE_H}px`,
    font: "13px sans-serif",
    color: "#ddd",
    textAlign: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
  root.append(button, line);

  let isActive = false;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!isActive) activateNode(node);
  });
  forwardToCanvas(root, () => app.canvas?.canvas ?? null);

  const widget = node.addDOMWidget("warp_activate", "warp-activate", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => ACTIVATE_H,
    getMaxHeight: () => ACTIVATE_H,
  });
  widget.serialize = false;

  node._warpActivate = {
    widget,
    update(active, text) {
      isActive = active;
      const label = active ? ACTIVE_LABEL : ACTIVATE_LABEL;
      if (button.textContent !== label) button.textContent = label;
      Object.assign(button.style, active ? BUTTON_DOWN : BUTTON_UP);
      button.setAttribute("aria-pressed", String(active));
      line.textContent = active ? "" : text;
      line.style.visibility = active ? "hidden" : "visible";
    },
  };
  return node._warpActivate;
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

// Send name -> {promptId, before, final} image refs of its last run. Kept for
// this page only: the temp files are gone after a ComfyUI restart anyway, and
// a result is not an edit, so it must not mark the workflow modified or add an
// undo step. A renamed Send shows whatever its new name last produced.
const results = new Map();

/** Show the last result for the Send's current name, or "no result yet". */
function showResult(node) {
  const compare = node?._warpCompare;
  if (!compare) return;
  const result = results.get(widgetNamed(node, "name")?.value);
  if (result) compare.setPairs(result.before, result.final);
  else compare.setPairs([], []);
}

/** Show `img` full size in the Send's compare widget until the next result, or clear it. */
function drawPreviewInto(sendNode, img) {
  if (!sendNode) return;
  sendNode._warpPreview = img ?? null;
  sendNode._warpCompare?.setLive(img ?? null);
}

// --- Live sampling preview and results -------------------------------------------

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

/** A tracked prompt's Save Image (final) or marked node (before) has run. */
function takeResult(detail) {
  const promptId = detail?.prompt_id;
  const send = trackedPrompts.get(promptId);
  if (!send) return;
  const root = rootGraph();
  if (!root) return;
  const node = nodeByExecutionId(root, detail.display_node) ?? nodeByExecutionId(root, detail.node);
  const role = resultRole(node);
  if (!role) return;
  const name = widgetNamed(send, "name")?.value;
  let entry = results.get(name);
  // A new run starts blank: a side it does not produce stays empty.
  if (!entry || entry.promptId !== promptId) entry = { promptId, before: [], final: [] };
  entry[role] = imageRefs(outputImages(detail.output));
  results.set(name, entry);
  if (role === "final") {
    const old = send._warpPreview;
    drawPreviewInto(send, null);
    old?.close?.();
  }
  showResult(send);
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
  api.addEventListener("executed", ({ detail }) => takeResult(detail));
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

/** Call syncSoon whenever a Send's mode is set (mute, bypass, back on). */
function hookMode(proto) {
  let owner = proto;
  let desc;
  while (owner && !(desc = Object.getOwnPropertyDescriptor(owner, "mode"))) {
    owner = Object.getPrototypeOf(owner);
  }
  if (!desc?.get || !desc?.set) return;
  Object.defineProperty(proto, "mode", {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      return desc.get.call(this);
    },
    set(value) {
      desc.set.call(this, value);
      syncSoon();
    },
  });
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

    addActivate(this);
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

  // A warp link added or removed, or the Send muted, changes whether the
  // route is valid, and with it the Select's colour.
  wrap(proto, "onConnectionsChange", function () {
    syncSoon();
  });
  hookMode(proto);
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
      syncAll();
      return original.apply(this, args);
    };

    setupPreviewMirror();
  },

  // Any node can give the before image; only one carries the mark at a time.
  getNodeMenuItems(node) {
    if (!node) return [];
    const marked = node.properties?.[BEFORE_PROP] === true;
    return [{ content: marked ? UNMARK_LABEL : MARK_LABEL, callback: () => toggleBefore(node) }];
  },

  // A pasted or loaded node may carry the mark; its badge follows in syncAll.
  nodeCreated() {
    syncSoon();
  },

  async afterConfigureGraph() {
    syncSoon();
  },

  registerCustomNodes() {
    registerSelect();
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === SEND_ID) setupSend(nodeType);
    else if (nodeData.name === COMPARE_ID) setupCompare(nodeType);
  },
});
