import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { activate, collectSends, sortedNames, validateRoute } from "./warp_route.js";

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
const NO_RESULT = "no result yet";

const SLIDER_MIN_H = 240;
const SLIDER_PAD = 10;
const BAR_H = 24;
const ARROW_W = 32;

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

// --- The result slider -------------------------------------------------------

function viewURL(ref) {
  const params = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type ?? "temp",
  });
  return api.apiURL(`/view?${params}`);
}

function imageRefs(list) {
  return (Array.isArray(list) ? list : [])
    .filter((ref) => ref && typeof ref.filename === "string")
    .map((ref) => ({ filename: ref.filename, subfolder: ref.subfolder ?? "", type: ref.type }));
}

function loadImage(node, ref) {
  const img = new Image();
  img.onload = () => node.setDirtyCanvas?.(true, false);
  // The temp files are gone after a ComfyUI restart; the slider then says so.
  img.onerror = () => {
    img._warpFailed = true;
    node.setDirtyCanvas?.(true, false);
  };
  img.src = viewURL(ref);
  return img;
}

// Send name -> {first, final} image refs of its last result. Kept for this
// page only: the temp files are gone after a ComfyUI restart anyway, and a
// result is not an edit, so it must not mark the workflow modified or add an
// undo step. Keyed by name because that is how a Warp Result names its Send; a
// renamed Send shows whatever its new name last produced.
const results = new Map();

/** The loaded images for the node's last result, rebuilt when it changes. */
function resultImages(node) {
  const name = widgetNamed(node, "name")?.value;
  const result = results.get(name);
  const key = result ? JSON.stringify([name, result]) : "";
  if (node._warpImages?.key !== key) {
    node._warpImages = {
      key,
      first: imageRefs(result?.first).map((ref) => loadImage(node, ref)),
      final: imageRefs(result?.final).map((ref) => loadImage(node, ref)),
    };
  }
  return node._warpImages;
}

function imageSize(img) {
  const w = img?.naturalWidth ?? img?.width ?? 0;
  const h = img?.naturalHeight ?? img?.height ?? 0;
  if (img instanceof HTMLImageElement && !img.complete) return null;
  return w > 0 && h > 0 ? [w, h] : null;
}

/** Draw `img` as large as it fits in `rect`, centred. False if not ready. */
function drawFit(ctx, img, rect) {
  const size = imageSize(img);
  if (!size) return false;
  const scale = Math.min(rect.w / size[0], rect.h / size[1]);
  const w = size[0] * scale;
  const h = size[1] * scale;
  ctx.drawImage(img, rect.x + (rect.w - w) / 2, rect.y + (rect.h - h) / 2, w, h);
  return true;
}

function drawCentredText(ctx, text, rect) {
  ctx.fillStyle = "#888";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, rect.x + rect.w / 2, rect.y + rect.h / 2);
}

function inRect(pos, rect) {
  return (
    rect &&
    pos[0] >= rect.x &&
    pos[0] <= rect.x + rect.w &&
    pos[1] >= rect.y &&
    pos[1] <= rect.y + rect.h
  );
}

function drawBar(ctx, layout, pair, pairs) {
  const { prev, next, bar } = layout;
  ctx.fillStyle = "#2a2a2a";
  for (const box of [prev, next]) ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = "#ddd";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("◀", prev.x + prev.w / 2, prev.y + prev.h / 2);
  ctx.fillText("▶", next.x + next.w / 2, next.y + next.h / 2);
  ctx.fillText(`${pair + 1}/${pairs}`, bar.x + bar.w / 2, bar.y + bar.h / 2);
}

function drawPair(ctx, node, a, b, rect) {
  const split = rect.x + rect.w * (node._warpSplit ?? 0.5);
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, split - rect.x, rect.h);
  ctx.clip();
  const drewA = drawFit(ctx, a, rect);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(split, rect.y, rect.x + rect.w - split, rect.h);
  ctx.clip();
  const drewB = drawFit(ctx, b, rect);
  ctx.restore();
  if (!drewA && !drewB) {
    drawCentredText(ctx, a?._warpFailed || b?._warpFailed ? NO_RESULT : "…", rect);
    return;
  }
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(split, rect.y);
  ctx.lineTo(split, rect.y + rect.h);
  ctx.stroke();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(rect.x + 4, rect.y + 4, 18, 18);
  ctx.fillRect(rect.x + rect.w - 22, rect.y + 4, 18, 18);
  ctx.fillStyle = "#fff";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("A", rect.x + 13, rect.y + 13);
  ctx.fillText("B", rect.x + rect.w - 13, rect.y + 13);
}

function drawSlider(ctx, node, widget, width, y) {
  const height = widget.computedHeight ?? SLIDER_MIN_H;
  const images = resultImages(node);
  const pairs = Math.min(images.first.length, images.final.length);
  const preview = node._warpPreview ?? null;
  const showBar = !preview && pairs > 1;

  const area = { x: SLIDER_PAD, y: y + 2, w: width - 2 * SLIDER_PAD, h: height - 8 };
  const bar = { x: area.x, y: area.y, w: area.w, h: showBar ? BAR_H : 0 };
  const rect = { x: area.x, y: area.y + bar.h, w: area.w, h: Math.max(10, area.h - bar.h) };
  const layout = {
    rect,
    bar,
    prev: showBar ? { x: bar.x, y: bar.y + 2, w: ARROW_W, h: BAR_H - 6 } : null,
    next: showBar ? { x: bar.x + bar.w - ARROW_W, y: bar.y + 2, w: ARROW_W, h: BAR_H - 6 } : null,
    pairs,
  };
  widget._warpLayout = layout;

  ctx.save();
  ctx.fillStyle = "#111";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  if (preview) {
    if (!drawFit(ctx, preview, rect)) drawCentredText(ctx, "…", rect);
  } else if (pairs > 0) {
    const pair = Math.min(node._warpPair ?? 0, pairs - 1);
    node._warpPair = pair;
    if (showBar) drawBar(ctx, layout, pair, pairs);
    drawPair(ctx, node, images.first[pair], images.final[pair], rect);
  } else {
    // Only one side came back (one input of the Result left empty): show it.
    const single = images.final[0] ?? images.first[0];
    if (!single || !drawFit(ctx, single, rect)) drawCentredText(ctx, NO_RESULT, rect);
  }
  ctx.restore();
}

function sliderMouse(event, pos, node, widget) {
  if (event.type !== "pointerdown" && event.type !== "mousedown") return false;
  const layout = widget._warpLayout;
  if (!layout || layout.pairs < 2) return false;
  const step = inRect(pos, layout.prev) ? -1 : inRect(pos, layout.next) ? 1 : 0;
  if (!step) return false;
  node._warpPair = ((node._warpPair ?? 0) + step + layout.pairs) % layout.pairs;
  node.setDirtyCanvas?.(true, false);
  return true;
}

function makeSlider() {
  return {
    type: "warppipe_result_slider",
    name: "warp_result",
    value: null,
    serialize: false,
    options: { serialize: false },
    // No computeSize: the frontend then gives this widget whatever height the
    // node has left, and uses that height for drawing and for hit testing.
    computeLayoutSize() {
      return { minHeight: SLIDER_MIN_H, maxHeight: 1e6, minWidth: 120 };
    },
    draw(ctx, node, width, y) {
      drawSlider(ctx, node, this, width, y);
    },
    mouse(event, pos, node) {
      return sliderMouse(event, pos, node, this);
    },
  };
}

/** Show `img` full size in the Send's slider until the next result, or clear it. */
function drawPreviewInto(sendNode, img) {
  if (!sendNode) return;
  sendNode._warpPreview = img ?? null;
  sendNode.setDirtyCanvas?.(true, false);
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
      widget.callback = function (...args) {
        const result = prior?.apply(this, args);
        if (!app.configuringGraph) syncAll();
        return result;
      };
    }

    const button = this.addWidget("button", ACTIVATE_LABEL, null, () => activateNode(this), {
      serialize: false,
    });
    if (button) button.serialize = false;
    this.addCustomWidget(makeSlider());
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

  // The split between A and B follows the pointer while it is over the image.
  wrap(proto, "onMouseMove", function (_event, pos) {
    const slider = widgetNamed(this, "warp_result");
    const rect = slider?._warpLayout?.rect;
    if (!rect || !inRect(pos, rect)) return;
    this._warpSplit = Math.min(1, Math.max(0, (pos[0] - rect.x) / rect.w));
    this.setDirtyCanvas?.(true, false);
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
      node._warpPreview?.close?.();
      node._warpPreview = null;
      node._warpPair = 0;
      node.setDirtyCanvas?.(true, true);
    });
  },

  registerCustomNodes() {
    registerSelect();
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === SEND_ID) setupSend(nodeType);
    else if (nodeData.name === RESULT_ID) setupResult(nodeType);
  },
});
