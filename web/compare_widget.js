// The before/after compare widget shared by Warp Send and Warp Compare.
//
// It is a DOM widget, so the same element shows on the classic canvas (the
// frontend lays it over the node) and in Vue nodes (mounted inside the node).
// The right image lies under the left one; the left shows left of the split and the right one right of it, the split
// follows the pointer, and a bar steps through the pairs. A live frame covers
// the pairs until it is cleared.
//
// No app or api import: the helpers at the top run under node for the tests,
// and the DOM is only touched when a widget is added.

export const NO_RESULT = "no result yet";
export const WIDGET_TYPE = "warp-compare";
export const MIN_HEIGHT = 240;
export const DEFAULT_LABELS = ["before", "after"];

const BAR_H = 24;
const ARROW_W = 32;
const BG = "#111";

/** Image refs from an `executed` output list; anything without a filename is dropped. */
export function imageRefs(list) {
  return (Array.isArray(list) ? list : [])
    .filter((ref) => ref && typeof ref.filename === "string")
    .map((ref) => ({
      filename: ref.filename,
      subfolder: ref.subfolder ?? "",
      type: ref.type ?? "temp",
    }));
}

/** The /view path for an image ref, before the api base is put in front. */
export function viewPath(ref) {
  const params = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type ?? "temp",
  });
  return `/view?${params}`;
}

/** The [left, right] side labels; anything that is not a non-empty string falls back to the default. */
export function sideLabels(labels) {
  const pick = (i) =>
    typeof labels?.[i] === "string" && labels[i] !== "" ? labels[i] : DEFAULT_LABELS[i];
  return [pick(0), pick(1)];
}

/** How many pairs there are: a side that is shorter is blank for the rest. */
export function pairCount(a, b) {
  return Math.max(a?.length ?? 0, b?.length ?? 0);
}

/** The pair after stepping by `step`, wrapping around; 0 when there is none. */
export function stepPair(index, step, count) {
  if (!(count > 0)) return 0;
  return (((index + step) % count) + count) % count;
}

/** Where the split sits, 0..1, for a pointer at `x` over a box from `left`, `width` wide. */
export function splitAt(x, left, width) {
  if (!(width > 0)) return 0.5;
  return Math.min(1, Math.max(0, (x - left) / width));
}

/** The label shown in the bar, "i/n" counted from 1. */
export function counterText(index, count) {
  return count > 0 ? `${index + 1}/${count}` : "0/0";
}

// --- DOM -------------------------------------------------------------------------

function el(tag, style = {}, text) {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text != null) node.textContent = text;
  return node;
}

const FILL = { position: "absolute", inset: "0", width: "100%", height: "100%" };
const IMAGE = { ...FILL, objectFit: "contain", pointerEvents: "none", display: "none" };

function cornerLabel(text, side) {
  return el(
    "div",
    {
      position: "absolute",
      top: "4px",
      [side]: "4px",
      padding: "0 6px",
      height: "18px",
      lineHeight: "18px",
      borderRadius: "3px",
      textAlign: "center",
      font: "12px sans-serif",
      color: "#fff",
      background: "rgba(0,0,0,0.55)",
      pointerEvents: "none",
      display: "none",
    },
    text
  );
}

function arrowButton(text, title) {
  const button = el(
    "button",
    {
      width: `${ARROW_W}px`,
      height: `${BAR_H - 6}px`,
      padding: "0",
      border: "none",
      borderRadius: "3px",
      background: "#2a2a2a",
      color: "#ddd",
      font: "14px sans-serif",
      cursor: "pointer",
    },
    text
  );
  button.type = "button";
  button.title = title;
  return button;
}

/**
 * On the classic canvas the element floats over the canvas, so the wheel
 * (zoom) and the middle button (pan) are handed on to it. A Vue node handles
 * those itself, so nothing is forwarded there.
 */
export function forwardToCanvas(element, getCanvas) {
  const onClassic = () => !!element.closest(".dom-widget");
  const target = () => getCanvas?.() ?? null;
  element.addEventListener(
    "wheel",
    (event) => {
      const canvas = target();
      if (!canvas || !onClassic()) return;
      event.preventDefault();
      canvas.dispatchEvent(new WheelEvent(event.type, event));
    },
    { passive: false }
  );
  for (const type of ["pointerdown", "pointermove", "pointerup"]) {
    element.addEventListener(type, (event) => {
      const middle = type === "pointerdown" ? event.button === 1 : (event.buttons & 4) !== 0;
      const canvas = target();
      if (!middle || !canvas || !onClassic()) return;
      event.preventDefault();
      event.stopPropagation();
      canvas.dispatchEvent(new PointerEvent(event.type, event));
    });
  }
}

/**
 * Add the compare widget to `node` as `name`.
 *
 * `options.labels` is [left, right] (default ["before", "after"]; the first
 * side is shown left of the split, the second right of it). `options.apiURL` turns a /view path into a URL (pass `api.apiURL`), and
 * `options.getCanvas` returns the canvas element events are forwarded to.
 */
export function addCompareWidget(node, name, options = {}) {
  const apiURL = options.apiURL ?? ((path) => path);

  const root = el("div", {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    minHeight: `${MIN_HEIGHT}px`,
    boxSizing: "border-box",
    background: BG,
    borderRadius: "4px",
    overflow: "hidden",
    userSelect: "none",
    color: "#ddd",
    font: "14px sans-serif",
  });
  root.className = "warppipe-compare";

  const stage = el("div", {
    position: "relative",
    flex: "1 1 auto",
    minHeight: "0",
    overflow: "hidden",
  });
  const imgB = el("img", IMAGE);
  const imgA = el("img", IMAGE);
  const [leftText, rightText] = sideLabels(options.labels);
  imgA.alt = leftText;
  imgB.alt = rightText;
  for (const img of [imgA, imgB]) img.draggable = false;
  const line = el("div", {
    position: "absolute",
    top: "0",
    bottom: "0",
    width: "1px",
    background: "#fff",
    pointerEvents: "none",
    display: "none",
  });
  const labelA = cornerLabel(leftText, "left");
  const labelB = cornerLabel(rightText, "right");
  const live = el("canvas", { ...FILL, objectFit: "contain", display: "none" });
  const placeholder = el(
    "div",
    {
      ...FILL,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "#888",
      pointerEvents: "none",
    },
    NO_RESULT
  );
  stage.append(imgB, imgA, line, labelA, labelB, live, placeholder);

  const bar = el("div", {
    display: "none",
    flex: `0 0 ${BAR_H}px`,
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 2px",
  });
  const prev = arrowButton("◀", "previous pair");
  const next = arrowButton("▶", "next pair");
  const counter = el("span", { color: "#ddd" });
  bar.append(prev, counter, next);
  root.append(stage, bar);

  const state = { a: [], b: [], index: 0, split: 0.5, live: false };
  // src -> true once it failed (the temp files are gone after a ComfyUI restart).
  const failed = new Set();

  function sideShown(img) {
    return img.style.display !== "none" && !failed.has(img.src);
  }

  function renderSplit() {
    const pct = state.split * 100;
    imgA.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    imgB.style.clipPath = `inset(0 0 0 ${pct}%)`;
    line.style.left = `calc(${pct}% - 0.5px)`;
  }

  function showSide(img, label, ref) {
    if (ref) {
      const src = apiURL(viewPath(ref));
      if (img.getAttribute("src") !== src) img.src = src;
      img.style.display = "block";
      label.style.display = "block";
    } else {
      img.removeAttribute("src");
      img.style.display = "none";
      label.style.display = "none";
    }
  }

  function render() {
    const count = pairCount(state.a, state.b);
    state.index = Math.min(state.index, Math.max(0, count - 1));
    const showPairs = !state.live && count > 0;

    live.style.display = state.live ? "block" : "none";
    showSide(imgA, labelA, showPairs ? state.a[state.index] : null);
    showSide(imgB, labelB, showPairs ? state.b[state.index] : null);
    const any = sideShown(imgA) || sideShown(imgB);
    line.style.display = showPairs && any ? "block" : "none";
    placeholder.style.display = state.live || (showPairs && any) ? "none" : "flex";
    for (const [img, label] of [
      [imgA, labelA],
      [imgB, labelB],
    ]) {
      if (failed.has(img.src)) img.style.display = label.style.display = "none";
    }

    bar.style.display = showPairs ? "flex" : "none";
    counter.textContent = counterText(state.index, count);
    prev.disabled = next.disabled = count < 2;
    for (const button of [prev, next]) button.style.opacity = count < 2 ? "0.4" : "1";
    renderSplit();
  }

  for (const img of [imgA, imgB]) {
    img.addEventListener("load", () => {
      failed.delete(img.src);
      render();
    });
    img.addEventListener("error", () => {
      if (img.getAttribute("src")) failed.add(img.src);
      render();
    });
  }

  stage.addEventListener("pointermove", (event) => {
    const box = stage.getBoundingClientRect();
    state.split = splitAt(event.clientX, box.left, box.width);
    renderSplit();
  });
  stage.addEventListener("pointerleave", () => {
    state.split = 0.5;
    renderSplit();
  });

  function step(by) {
    state.index = stepPair(state.index, by, pairCount(state.a, state.b));
    render();
  }
  prev.addEventListener("click", (event) => {
    event.stopPropagation();
    step(-1);
  });
  next.addEventListener("click", (event) => {
    event.stopPropagation();
    step(1);
  });

  forwardToCanvas(root, options.getCanvas);

  const widget = node.addDOMWidget(name, WIDGET_TYPE, root, {
    serialize: false,
    hideOnZoom: true,
    // No maximum: the widget takes whatever height the node has left.
    getMinHeight: () => MIN_HEIGHT,
  });
  widget.serialize = false;

  const handle = {
    widget,
    element: root,
    /** Show these pairs from the first: `a` on the left, `b` on the right; a side that is shorter is blank. */
    setPairs(a, b) {
      state.a = imageRefs(a);
      state.b = imageRefs(b);
      state.index = 0;
      render();
    },
    /** Draw `bitmap` over the pairs until it is called with null. */
    setLive(bitmap) {
      const w = bitmap?.width ?? 0;
      const h = bitmap?.height ?? 0;
      if (bitmap && w > 0 && h > 0) {
        if (live.width !== w) live.width = w;
        if (live.height !== h) live.height = h;
        live.getContext("2d")?.drawImage(bitmap, 0, 0, w, h);
        state.live = true;
      } else {
        state.live = false;
      }
      render();
    },
    /** Back to "no result yet". */
    clear() {
      state.a = [];
      state.b = [];
      state.index = 0;
      state.live = false;
      failed.clear();
      render();
    },
  };
  render();
  return handle;
}
