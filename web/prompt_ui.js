import { app } from "../../scripts/app.js";

// The prompt box, made legible.
//
// Three things share one idea: the text is the only state. A highlight layer
// sits behind a transparent textarea so tags, notes and trigger words are
// coloured while you still type into a real textarea (selection, undo, IME all
// intact). A picker opens at the caret. Rows underneath show what will actually
// load. Every control rewrites the text; nothing is stored beside it.

const NODE_ID = "Warp Lora Prompt";
const TEXT_WIDGET = "text";
const LIST_WIDGET = "loras";

const TAG_RE = /<lora:([^:>]+):(-?[0-9]*\.?[0-9]+)([^>]*)>/gi;
const COMMENT_RE = /\/\/[^\n]*/g;
const EMBED_RE = /\bembedding:([^\s,]+)/gi;

const FRIENDLY_LABELS = {
  text: "Prompt",
  loras: "LoRAs",
  insert_trigger_words: "Trigger words",
  apply_to_clip: "Apply to",
};

const STYLE = `
/* The layer sits inside ComfyUI's own widget wrapper, which is positioned,
   and copies every metric that decides where a glyph lands. */
.wpe-hl {
  position: absolute; z-index: 0; pointer-events: none; overflow: hidden;
  color: var(--input-text, #dcdcdc);
  white-space: pre-wrap; overflow-wrap: break-word; word-break: normal;
}
/* The textarea keeps selection, undo and IME. Only its ink is hidden. */
.wpe-live { position: relative; z-index: 1; background: transparent !important; }
.wpe-live.is-lit { color: transparent !important; }
.wpe-tag { color: #4ec8e8; }
.wpe-tag-unknown { color: #e0705a; text-decoration: underline wavy rgba(224,112,90,0.5); }
.wpe-embed { color: #e8b34e; }
.wpe-note { color: #7b7f86; font-style: italic; }
.wpe-trigger { color: #9ad9a4; }

.wpe-menu {
  position: fixed; z-index: 1600; width: 330px; max-height: 340px; overflow-y: auto;
  background: var(--comfy-menu-bg, #1e1e1e); color: var(--input-text, #dcdcdc);
  border: 1px solid var(--border-color, #3a3a3a); border-radius: 6px;
  box-shadow: 0 14px 40px rgba(0,0,0,0.55); padding: 4px; font-size: 12px;
}
.wpe-item {
  display: flex; align-items: center; gap: 9px; width: 100%;
  padding: 5px 6px; background: none; border: 0; border-radius: 4px;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.wpe-item.is-active { background: rgba(78,200,232,0.18); }
.wpe-item img {
  width: 30px; height: 40px; flex: 0 0 30px; object-fit: cover;
  border-radius: 3px; background: #0d0d0d;
}
.wpe-item .wpe-blank { width: 30px; height: 40px; flex: 0 0 30px; border-radius: 3px; background: #0d0d0d; }
.wpe-item .wpe-txt { min-width: 0; flex: 1; }
.wpe-item .wpe-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wpe-item .wpe-sub {
  font-size: 10px; opacity: 0.55;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wpe-hint { padding: 5px 7px; font-size: 10px; opacity: 0.5; }

/* ComfyUI lays each widget out in its own row and puts its own rows back if
   they are moved, so the list sits in a pane of its own with a set height
   instead. That is what stops twenty LoRAs making the node twenty rows taller;
   the pane scrolls and can be dragged taller. */
.wpe-pane {
  min-width: 0; display: block; overflow: hidden;
  border: 1px solid var(--border-color, #3a3a3a); border-radius: 5px;
  background: var(--comfy-input-bg, #171717);
}
.wpe-grow { height: 9px; cursor: row-resize; position: relative; }
.wpe-grow::after {
  content: ""; position: absolute; left: 42%; right: 42%; top: 4px; height: 1px;
  background: var(--border-color, #3a3a3a);
}
.wpe-grow:hover::after, .wpe-grow.is-drag::after { background: #4ec8e8; height: 2px; }

/* Smaller than the prompt: a long list has to stay readable at a glance. */
.wpc { display: flex; flex-direction: column; gap: 2px; font-size: 10px; overflow-y: auto;
  height: 100%; color: var(--input-text, #dcdcdc); }
.wpc-empty { opacity: 0.45; padding: 4px 2px; }
.wpc-row {
  display: flex; align-items: center; gap: 5px; padding: 2px 4px; border-radius: 4px;
  background: var(--comfy-input-bg, #171717); border: 1px solid var(--border-color, #3a3a3a);
}
.wpc-row.is-missing { border-color: #b4553f; }
/* A disabled row stays legible - you need to read it to decide to switch it
   back on - but everything about it is quieter. */
.wpc-row.is-off { opacity: 0.42; }
.wpc-row.is-off .wpc-name { text-decoration: line-through; }
.wpc-row.is-drag { opacity: 0.35; }
.wpc-row.is-over { box-shadow: 0 -2px 0 #4ec8e8; }
.wpc-grip { cursor: grab; opacity: 0.35; flex: 0 0 9px; font-size: 11px; line-height: 1; }
.wpc-grip:active { cursor: grabbing; }
.wpc-row:hover .wpc-grip { opacity: 0.75; }
.wpc-power { color: #9ad9a4; }
.wpc-row.is-off .wpc-power { color: inherit; }
.wpc-thumb { width: 20px; height: 20px; flex: 0 0 20px; border-radius: 3px; object-fit: cover; background: #0d0d0d; }
.wpc-name { flex: 1; min-width: 0; overflow: hidden; }
.wpc-name b { font-weight: 600; }
.wpc-name .wpc-line {
  display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wpc-name .wpc-by { font-size: 9px; opacity: 0.5; }
.wpc-link { text-decoration: none; color: #4ec8e8; opacity: 0.8; font-size: 12px; }
.wpc-link:hover { opacity: 1; }

.wpt-menu {
  position: fixed; z-index: 1700; width: 300px; max-height: 300px; overflow-y: auto;
  background: var(--comfy-menu-bg, #1e1e1e); color: var(--input-text, #dcdcdc);
  border: 1px solid var(--border-color, #3a3a3a); border-radius: 6px;
  box-shadow: 0 14px 40px rgba(0,0,0,0.55); padding: 4px; font-size: 12px;
}
.wpt-head {
  padding: 5px 7px; font-size: 10px; opacity: 0.55;
  display: flex; align-items: center; gap: 8px;
}
.wpt-head button {
  margin-left: auto; background: none; border: 1px solid var(--border-color, #3a3a3a);
  color: inherit; border-radius: 3px; font: inherit; font-size: 10px;
  padding: 2px 6px; cursor: pointer;
}
.wpt-head button:hover { border-color: #4ec8e8; color: #4ec8e8; }
.wpt-item {
  display: block; width: 100%; text-align: left; padding: 5px 7px;
  background: none; border: 0; border-radius: 3px; color: inherit;
  font: inherit; cursor: pointer;
  /* Some creators write paragraphs here, so a long one wraps to a few lines
     rather than being cut to something unrecognisable. */
  white-space: normal; overflow-wrap: break-word;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.wpt-item:hover, .wpt-item.is-active { background: rgba(78,200,232,0.16); }
.wpt-item.is-in { opacity: 0.45; }
.wpc-weight {
  width: 40px; text-align: center; padding: 0; border-radius: 3px;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 10px;
  background: none; border: 1px solid transparent; color: #4ec8e8; cursor: ew-resize;
}
.wpc-weight:hover { border-color: var(--border-color, #3a3a3a); }
.wpc-weight:focus-visible { outline: 2px solid #4ec8e8; cursor: text; }
.wpc-btn { background: none; border: 0; color: inherit; opacity: 0.62; cursor: pointer;
  font-size: 11px; line-height: 1; padding: 1px 2px; border-radius: 3px; }
.wpc-btn:hover { opacity: 1; color: #4ec8e8; }
.wpc-btn:focus-visible { outline: 2px solid #4ec8e8; opacity: 1; }
.wpc-btn[disabled] { opacity: 0.15; cursor: default; }
.wpc-trig { color: #9ad9a4; opacity: 0.85; }
`;

// --- library ---------------------------------------------------------------

let libraryCache = null;
async function library() {
  if (libraryCache) return libraryCache;
  const [loras, embeddings] = await Promise.all([
    fetch("/warppipe/loras").then((r) => r.json()).catch(() => ({ loras: [] })),
    fetch("/warppipe/embeddings").then((r) => r.json()).catch(() => ({ embeddings: [] })),
  ]);
  libraryCache = [...(loras.loras || []), ...(embeddings.embeddings || [])];
  return libraryCache;
}

const stemOf = (id) => id.replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, "");
const escapeHTML = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The LoRA list, one per line. A line commented out is one switched off -
 * which is exactly what the backend already does with a comment: nothing. */
function parseList(value) {
  return (value || "")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const enabled = !trimmed.startsWith("//");
      const body = enabled ? trimmed : trimmed.replace(/^\/\/\s*/, "");
      const m = /^<lora:([^:>]+):(-?[0-9]*\.?[0-9]+)[^>]*>$/i.exec(body);
      return m ? { name: m[1].trim(), weight: parseFloat(m[2]), enabled } : null;
    })
    .filter(Boolean);
}

function serialiseList(items) {
  return items
    .map((i) => `${i.enabled ? "" : "// "}<lora:${i.name}:${i.weight.toFixed(2)}>`)
    .join("\n");
}

/** Is this position inside a // note? Parked tags are left where they are. */
function inComment(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const marker = text.slice(lineStart, index).indexOf("//");
  return marker !== -1;
}

function parseTags(text) {
  const found = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text)) !== null) {
    found.push({ raw: m[0], name: m[1].trim(), weight: parseFloat(m[2]), start: m.index });
  }
  return found;
}

// --- highlighting ----------------------------------------------------------

/** Non-overlapping spans, earliest first: a note swallows anything after it. */
function tokenise(text, known, triggers) {
  const spans = [];
  const claim = (start, end, cls, title) => {
    if (spans.some((s) => start < s.end && s.start < end)) return;
    spans.push({ start, end, cls, title });
  };

  let m;
  COMMENT_RE.lastIndex = 0;
  while ((m = COMMENT_RE.exec(text)) !== null) {
    claim(m.index, m.index + m[0].length, "wpe-note");
  }
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    const missing = known && !known.has(m[1].trim().toLowerCase());
    claim(m.index, m.index + m[0].length, missing ? "wpe-tag-unknown" : "wpe-tag",
      missing ? "No file matches this name" : undefined);
  }
  EMBED_RE.lastIndex = 0;
  while ((m = EMBED_RE.exec(text)) !== null) {
    claim(m.index, m.index + m[0].length, "wpe-embed");
  }
  for (const word of triggers || []) {
    if (word.length < 3) continue;
    const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    while ((m = re.exec(text)) !== null) {
      claim(m.index, m.index + m[0].length, "wpe-trigger", "Trigger word");
    }
  }

  return spans.sort((a, b) => a.start - b.start);
}

function highlight(text, known, triggers) {
  const spans = tokenise(text, known, triggers);
  let html = "";
  let at = 0;
  for (const span of spans) {
    html += escapeHTML(text.slice(at, span.start));
    const title = span.title ? ` title="${span.title}"` : "";
    html += `<span class="${span.cls}"${title}>${escapeHTML(text.slice(span.start, span.end))}</span>`;
    at = span.end;
  }
  html += escapeHTML(text.slice(at));
  // A trailing newline needs something after it or the layer scrolls short.
  return html + "\n";
}

/** Where the caret sits on screen, by measuring a copy of the text before it. */
function caretPoint(textarea) {
  const cs = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const prop of COPIED_STYLES) mirror.style[prop] = cs[prop];
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    width: `${textarea.clientWidth}px`,
  });
  document.body.appendChild(mirror);

  mirror.textContent = (textarea.value || "").slice(0, textarea.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);

  const box = textarea.getBoundingClientRect();
  const point = {
    left: box.left + marker.offsetLeft - textarea.scrollLeft,
    top: box.top + marker.offsetTop - textarea.scrollTop + parseFloat(cs.lineHeight || "16"),
  };
  mirror.remove();
  return point;
}

const COPIED_STYLES = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing",
  "textIndent", "textTransform", "paddingTop", "paddingRight", "paddingBottom",
  "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
  "borderLeftWidth", "boxSizing", "tabSize", "textAlign",
];

/** ComfyUI renders each widget under an element tagged with the node's id. */
function findTextarea(node) {
  const root = document.querySelector(`[data-node-id="${node.id}"]`);
  return root ? root.querySelector("textarea") : null;
}

/** Colour ComfyUI's own textarea by putting a layer behind it.
 *
 * The widget is rendered by a Vue component, so the textarea can be replaced
 * at any time; the caller re-runs this when that happens. Nothing here changes
 * the value, which keeps serialising through ComfyUI as before.
 */
function light(textarea) {
  const holder = textarea.parentElement;
  if (!holder || textarea._wpeLayer) return textarea._wpeLayer || null;

  const layer = document.createElement("div");
  layer.className = "wpe-hl";
  layer.setAttribute("aria-hidden", "true");
  holder.insertBefore(layer, textarea);
  // Read the ink colour before hiding it, or the caret inherits the
  // transparency and there is nothing left to show where you are typing.
  const ink = getComputedStyle(textarea).color;
  textarea.classList.add("wpe-live", "is-lit");
  textarea.style.caretColor = ink;
  textarea._wpeLayer = layer;

  let known = null;
  let triggers = [];

  const measure = () => {
    const cs = getComputedStyle(textarea);
    for (const prop of COPIED_STYLES) layer.style[prop] = cs[prop];
    layer.style.borderStyle = "solid";
    layer.style.borderColor = "transparent";
    // Sizes below are the textarea's border box, so the layer must measure the
    // same way regardless of what the host stylesheet sets.
    layer.style.boxSizing = "border-box";
    layer.style.left = `${textarea.offsetLeft}px`;
    layer.style.top = `${textarea.offsetTop}px`;
    layer.style.width = `${textarea.offsetWidth}px`;
    layer.style.height = `${textarea.offsetHeight}px`;
    // ComfyUI hides the textarea at low zoom; the layer follows it.
    layer.style.display = cs.display === "none" ? "none" : "";
  };

  const paint = () => {
    layer.innerHTML = highlight(textarea.value || "", known, triggers);
    layer.scrollTop = textarea.scrollTop;
    layer.scrollLeft = textarea.scrollLeft;
  };

  textarea.addEventListener("scroll", () => {
    layer.scrollTop = textarea.scrollTop;
    layer.scrollLeft = textarea.scrollLeft;
  });
  new ResizeObserver(() => {
    measure();
    paint();
  }).observe(textarea);
  measure();

  return {
    layer,
    textarea,
    paint,
    measure,
    setVocabulary: (nextKnown, nextTriggers) => {
      known = nextKnown;
      triggers = nextTriggers;
      paint();
    },
    detach: () => {
      layer.remove();
      textarea.classList.remove("wpe-live", "is-lit");
      delete textarea._wpeLayer;
    },
  };
}

// --- the picker ------------------------------------------------------------

function openPicker(node, el, list, commit) {
  if (!el || el._wpeMenu) return;

  const menu = document.createElement("div");
  menu.className = "wpe-menu";
  el._wpeMenu = menu;
  const point = caretPoint(el);
  menu.style.left = `${Math.round(Math.min(point.left, window.innerWidth - 344))}px`;
  menu.style.top = `${Math.round(Math.min(point.top + 4, window.innerHeight - 350))}px`;
  document.body.appendChild(menu);

  const slashAt = el.selectionStart - 1;
  let entries = [];
  let matches = [];
  let active = 0;

  const close = () => {
    menu.remove();
    delete el._wpeMenu;
    el.removeEventListener("keydown", onKey, true);
    el.removeEventListener("input", onInput);
    document.removeEventListener("mousedown", onOutside, true);
  };

  const choose = (entry) => {
    const text = el.value || "";
    // The slash and whatever was typed after it are removed either way; a LoRA
    // then joins the list below rather than cluttering the prompt, while an
    // embedding is part of the prompt and stays in it.
    const before = text.slice(0, slashAt);
    const after = text.slice(el.selectionStart);
    if (entry.kind === "embeddings") {
      const snippet = `embedding:${stemOf(entry.id)}`;
      el.value = before + snippet + after;
      const caret = slashAt + snippet.length;
      el.setSelectionRange(caret, caret);
    } else if (list.separate) {
      el.value = before + after;
      el.setSelectionRange(slashAt, slashAt);
      list.add(stemOf(entry.id));
    } else {
      const snippet = `<lora:${stemOf(entry.id)}:1.0>`;
      el.value = before + snippet + after;
      const caret = slashAt + snippet.length;
      el.setSelectionRange(caret, caret);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
    commit();
    close();
    node.setDirtyCanvas?.(true, true);
  };

  const render = () => {
    const query = (el.value || "").slice(slashAt + 1, el.selectionStart).toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    matches = entries
      .filter((e) => {
        if (!terms.length) return true;
        const hay = `${e.creator || ""} ${e.name} ${e.folder} ${e.kind}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .slice(0, 60);

    menu.replaceChildren();
    if (!matches.length) {
      const none = document.createElement("div");
      none.className = "wpe-hint";
      none.textContent = query ? `Nothing matches “${query}”` : "Library is empty";
      menu.appendChild(none);
      return;
    }
    active = Math.max(0, Math.min(active, matches.length - 1));
    matches.forEach((entry, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "wpe-item" + (i === active ? " is-active" : "");
      if (entry.thumbnail) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = "";
        img.src = entry.thumbnail;
        row.appendChild(img);
      } else {
        const blank = document.createElement("span");
        blank.className = "wpe-blank";
        row.appendChild(blank);
      }
      const txt = document.createElement("span");
      txt.className = "wpe-txt";
      const kind = entry.kind === "embeddings" ? "embedding" : entry.folder || "lora";
      txt.innerHTML =
        `<span class="wpe-nm">${escapeHTML(entry.name)}</span>` +
        `<span class="wpe-sub">${escapeHTML([entry.creator, entry.version, kind].filter(Boolean).join(" · "))}</span>`;
      txt.style.display = "block";
      row.appendChild(txt);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(entry);
      });
      menu.appendChild(row);
    });
    menu.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  };

  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      active += 1;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      active -= 1;
      render();
    } else if ((e.key === "Enter" || e.key === "Tab") && matches[active]) {
      e.preventDefault();
      e.stopPropagation();
      choose(matches[active]);
    }
  };
  const onInput = () => {
    if (el.selectionStart <= slashAt || (el.value || "")[slashAt] !== "/") close();
    else {
      active = 0;
      render();
    }
  };
  const onOutside = (e) => {
    if (!menu.contains(e.target)) close();
  };

  el.addEventListener("keydown", onKey, true);
  el.addEventListener("input", onInput);
  document.addEventListener("mousedown", onOutside, true);

  library().then((data) => {
    entries = data;
    render();
  });
}

// --- rows ------------------------------------------------------------------

/** Choose which trigger words to insert.
 *
 * A LoRA can declare one short word or several paragraphs, so inserting the lot
 * is rarely what you want. Words already in the prompt are dimmed.
 */
function openTriggerPicker(anchor, words, current, insert) {
  document.querySelector(".wpt-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "wpt-menu";
  const box = anchor.getBoundingClientRect();
  menu.style.left = `${Math.round(Math.min(box.left, window.innerWidth - 312))}px`;
  menu.style.top = `${Math.round(Math.min(box.bottom + 4, window.innerHeight - 310))}px`;

  const head = document.createElement("div");
  head.className = "wpt-head";
  head.append(`${words.length} trigger word${words.length === 1 ? "" : "s"}`);
  const all = document.createElement("button");
  all.type = "button";
  all.textContent = "Insert all";
  all.addEventListener("click", () => {
    insert(words.filter((w) => !current.toLowerCase().includes(w.toLowerCase())));
    menu.remove();
  });
  head.appendChild(all);
  menu.appendChild(head);

  for (const word of words) {
    const item = document.createElement("button");
    item.type = "button";
    const already = current.toLowerCase().includes(word.toLowerCase());
    item.className = "wpt-item" + (already ? " is-in" : "");
    item.textContent = word;
    item.title = already ? "Already in the prompt" : word;
    item.addEventListener("click", () => {
      insert([word]);
      menu.remove();
    });
    menu.appendChild(item);
  }

  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("mousedown", close, true);
    }
  };
  document.addEventListener("mousedown", close, true);
  document.body.appendChild(menu);
}

function buildRows(node, list, host, commit) {
  let generation = 0;

  const items = () => list.items();
  const write = (next) => {
    list.write(next);
    commit();
  };

  const render = async () => {
    const mine = ++generation;
    const current = items();
    host.replaceChildren();

    if (!current.length) {
      const empty = document.createElement("div");
      empty.className = "wpc-empty";
      empty.textContent = "No LoRAs yet — press / in the prompt, or use Browse.";
      host.appendChild(empty);
      return;
    }

    const entries = await library();
    if (mine !== generation) return;
    host.replaceChildren();
    const byStem = new Map(entries.map((e) => [stemOf(e.id).toLowerCase(), e]));

    current.forEach((item, index) => {
      const entry = byStem.get(item.name.toLowerCase());
      const row = document.createElement("div");
      row.className =
        "wpc-row" + (entry ? "" : " is-missing") + (item.enabled ? "" : " is-off");
      row.draggable = true;

      const grip = document.createElement("span");
      grip.className = "wpc-grip";
      grip.textContent = "⠿";
      grip.title = "Drag to reorder";
      row.appendChild(grip);

      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "move";
        // Dragging out of the node yields the tag, so a row can be dropped
        // into any other prompt as text.
        e.dataTransfer.setData("text/plain", `<lora:${item.name}:${item.weight.toFixed(2)}>`);
        e.dataTransfer.setData("application/x-warppipe-lora", String(index));
        row.classList.add("is-drag");
      });
      row.addEventListener("dragend", () => row.classList.remove("is-drag"));
      row.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("application/x-warppipe-lora")) return;
        e.preventDefault();
        row.classList.add("is-over");
      });
      row.addEventListener("dragleave", () => row.classList.remove("is-over"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("is-over");
        const from = parseInt(e.dataTransfer.getData("application/x-warppipe-lora"), 10);
        if (Number.isNaN(from) || from === index) return;
        const next = items();
        const [moved] = next.splice(from, 1);
        next.splice(index, 0, moved);
        write(next);
      });

      if (entry?.thumbnail) {
        const img = document.createElement("img");
        img.className = "wpc-thumb";
        img.loading = "lazy";
        img.alt = "";
        img.src = entry.thumbnail;
        row.appendChild(img);
      }

      const name = document.createElement("div");
      name.className = "wpc-name";
      name.title = item.name;
      if (entry) {
        // Civitai's own title when we have it; the parsed name otherwise.
        const heading = entry.title || entry.name;
        const version = entry.structured && entry.version ? entry.version : "";
        const by = [entry.creator, version].filter(Boolean).join(" · ");
        name.innerHTML =
          `<span class="wpc-line"><b>${escapeHTML(heading)}</b></span>` +
          (by ? `<span class="wpc-line wpc-by">${escapeHTML(by)}</span>` : "");
      } else {
        name.textContent = item.name;
      }
      row.appendChild(name);

      if (entry?.url) {
        const link = document.createElement("a");
        link.className = "wpc-btn wpc-link";
        link.href = entry.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "↗";
        link.title = "Open its page on Civitai";
        row.appendChild(link);
      }

      if (entry?.triggers?.length) {
        const trig = document.createElement("button");
        trig.type = "button";
        trig.className = "wpc-btn wpc-trig";
        trig.textContent = `⊕${entry.triggers.length}`;
        trig.title = `Insert: ${entry.triggers.join(", ")}`;
        trig.addEventListener("click", () => {
          const text = node._warppipeGetText?.() || "";
          openTriggerPicker(trig, entry.triggers, text, (chosen) => {
            if (!chosen.length) return;
            const now = node._warppipeGetText?.() || "";
            const joined = chosen.join(", ");
            node._warppipeSetText?.(now.trim() ? `${now.trim()}, ${joined}` : joined);
          });
        });
        row.appendChild(trig);
      }

      const weight = document.createElement("input");
      weight.className = "wpc-weight";
      weight.value = item.weight.toFixed(2);
      weight.title = "Drag to change, or type a value";
      const apply = (value) => {
        const next = items();
        if (!next[index]) return;
        next[index].weight = Math.max(-4, Math.min(4, value));
        write(next);
      };
      weight.addEventListener("change", () => apply(parseFloat(weight.value) || 0));
      // Scrubbing in steps of 0.1, eight pixels apart: fine enough to land on a
      // value deliberately, coarse enough not to wander. Pointer capture keeps
      // the drag alive when it leaves the little field.
      const STEP = 0.1;
      const PX_PER_STEP = 8;
      weight.addEventListener("pointerdown", (down) => {
        if (document.activeElement === weight) return; // typing, not dragging
        down.preventDefault();
        const startX = down.clientX;
        const startValue = item.weight;
        let moved = false;
        weight.setPointerCapture(down.pointerId);

        const onMove = (mv) => {
          const dx = mv.clientX - startX;
          if (!moved && Math.abs(dx) < 3) return;
          moved = true;
          const steps = Math.round(dx / PX_PER_STEP);
          const next = Math.max(-4, Math.min(4, startValue + steps * STEP));
          // Snap to the step so the number is always a round one.
          weight.value = (Math.round(next / STEP) * STEP).toFixed(2);
        };
        const onUp = (up) => {
          weight.releasePointerCapture?.(up.pointerId);
          weight.removeEventListener("pointermove", onMove);
          weight.removeEventListener("pointerup", onUp);
          if (moved) apply(parseFloat(weight.value));
          else weight.focus();
        };
        weight.addEventListener("pointermove", onMove);
        weight.addEventListener("pointerup", onUp);
      });
      row.appendChild(weight);

      const power = document.createElement("button");
      power.type = "button";
      power.hidden = !list.separate;
      power.className = "wpc-btn wpc-power";
      power.textContent = item.enabled ? "◉" : "○";
      power.title = item.enabled ? "Switch off (kept, not applied)" : "Switch on";
      power.addEventListener("click", () => {
        const next = items();
        next[index].enabled = !next[index].enabled;
        write(next);
      });
      row.appendChild(power);

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "wpc-btn";
      copy.textContent = "⧉";
      copy.title = "Copy the tag";
      copy.addEventListener("click", async () => {
        const tag = `<lora:${item.name}:${item.weight.toFixed(2)}>`;
        try {
          await navigator.clipboard.writeText(tag);
          copy.textContent = "✓";
          setTimeout(() => (copy.textContent = "⧉"), 900);
        } catch {
          copy.title = tag;
        }
      });
      row.appendChild(copy);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "wpc-btn";
      remove.textContent = "✕";
      remove.title = "Remove";
      remove.addEventListener("click", () => {
        const next = items();
        next.splice(index, 1);
        write(next);
      });
      row.appendChild(remove);

      host.appendChild(row);
    });
  };

  return render;
}

app.registerExtension({
  name: "warppipe.promptUI",
  async setup() {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
  },
  async nodeCreated(node) {
    if (node.comfyClass !== NODE_ID) return;

    for (const widget of node.widgets || []) {
      if (FRIENDLY_LABELS[widget.name]) widget.label = FRIENDLY_LABELS[widget.name];
    }
    if (!(node.widgets || []).some((w) => w.name === TEXT_WIDGET)) return;
    // Absent on an older backend. Everything still works; the LoRA list just
    // lives in the prompt text, as it used to.
    const listWidget = (node.widgets || []).find((w) => w.name === LIST_WIDGET);

    // The list is written by the rows below, so its own field is noise. This
    // frontend ignores widget.hidden, so the row is hidden in the document
    // instead; if that ever stops working the field reappears, which is untidy
    // rather than broken.
    const hideListRow = () => {
      if (!listWidget) return;
      const root = document.querySelector(`[data-node-id="${node.id}"]`);
      if (!root) return;
      for (const row of root.querySelectorAll("[node-id]")) {
        if (row.textContent.trim().startsWith("LoRAs")) row.style.display = "none";
      }
    };

    let lit = null;
    const getEl = () => lit?.textarea ?? findTextarea(node);

    const writeText = (value) => {
      const el = getEl();
      if (!el) return;
      el.value = value;
      // Vue owns this input; an input event is how the widget value follows.
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };

    const list = listWidget
      ? {
          separate: true,
          get: () => listWidget.value || "",
          set: (value) => {
            listWidget.value = value;
            node.setDirtyCanvas?.(true, true);
          },
        }
      : {
          separate: false,
          get: () => getEl()?.value || "",
          set: writeText,
        };
    // One per line: that is what lets a single line be commented out to switch
    // one LoRA off without touching the others.
    list.append = (tags) => {
      const existing = parseList(list.get());
      const have = new Set(existing.map((i) => i.name.toLowerCase()));
      let added = false;
      for (const { name, weight } of tags) {
        if (have.has(name.toLowerCase())) continue;
        have.add(name.toLowerCase());
        existing.push({ name, weight, enabled: true });
        added = true;
      }
      if (added) list.set(serialiseList(existing));
      return added;
    };
    list.add = (stem) => list.append([{ name: stem, weight: 1.0 }]);

    // The rows work on this shape wherever the tags actually live. With no
    // loras input they live in the prompt, where a line cannot be commented out
    // without commenting out the prose around it, so switching off is not
    // offered there.
    list.items = () =>
      list.separate
        ? parseList(list.get())
        : parseTags(list.get()).map((t) => ({ name: t.name, weight: t.weight, enabled: true }));

    list.write = (items) => {
      if (list.separate) {
        list.set(serialiseList(items));
        return;
      }
      // Rewrite the prompt: drop every tag, then put the new set back at the end.
      const text = list.get();
      let stripped = text;
      for (const tag of [...parseTags(text)].reverse()) {
        stripped = stripped.slice(0, tag.start) + stripped.slice(tag.start + tag.raw.length);
      }
      stripped = stripped.replace(/[ \t]{2,}/g, " ").trim();
      const tags = items
        .filter((i) => i.enabled)
        .map((i) => `<lora:${i.name}:${i.weight.toFixed(2)}>`)
        .join(" ");
      list.set(stripped && tags ? `${stripped} ${tags}` : stripped || tags);
    };

    // Not a DOM widget: ComfyUI repositions those into its own rows every
    // frame, which drags the list back out of the split. This one is placed by
    // hand inside the split and re-attached if the frontend rebuilds the grid.
    const host = document.createElement("div");
    host.className = "wpc wpe-pane col-span-full";

    const refreshVocabulary = async () => {
      const entries = await library();
      const byStem = new Map(entries.map((e) => [stemOf(e.id).toLowerCase(), e]));
      const words = new Set();
      // Trigger words come from the list as well as anything typed inline.
      for (const tag of [...parseTags(list.get()), ...parseTags(getEl()?.value || "")]) {
        for (const w of byStem.get(tag.name.toLowerCase())?.triggers || []) words.add(w);
      }
      lit?.setVocabulary(new Set(byStem.keys()), [...words]);
    };

    /** Move any tag out of the prompt and into the list.
     *
     * Typing one by hand, pasting one from somewhere else, or opening a
     * workflow that kept its tags inline all end in the same place: a row. A
     * tag inside a // note is left alone, since parking one there is
     * deliberate.
     */
    const migrateInlineTags = () => {
      if (!list.separate) return false;
      const el = getEl();
      if (!el) return false;
      const text = el.value || "";
      const found = parseTags(text).filter((tag) => !inComment(text, tag.start));
      if (!found.length) return false;

      let next = text;
      // Last first, so earlier offsets stay valid.
      for (const tag of [...found].reverse()) {
        next = next.slice(0, tag.start) + next.slice(tag.start + tag.raw.length);
      }
      // Removing tags never removes newlines, so the lines still correspond
      // and one left blank by a removal can be dropped without touching a
      // line the writer left blank on purpose.
      const was = text.split("\n");
      next = next
        .split("\n")
        .map((line, i) => [line.replace(/[ \t]+$/, ""), i])
        .filter(([line, i]) => line !== "" || (was[i] || "").trim() === "")
        .map(([line]) => line)
        .join("\n")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+([,.;:!?])/g, "$1")
        .replace(/(,\s*){2,}/g, ", ");
      const caret = el.selectionStart;
      el.value = next;
      const shift = text.length - next.length;
      const at = Math.max(0, Math.min(next.length, caret - shift));
      el.setSelectionRange(at, at);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      list.append(found.map((t) => ({ name: t.name, weight: t.weight })));
      return true;
    };

    let renderRows = async () => {};
    const commit = () => {
      migrateInlineTags();
      lit?.paint();
      renderRows();
      refreshVocabulary();
      hideListRow();
      node.setDirtyCanvas?.(true, true);
    };
    renderRows = buildRows(node, list, host, commit);

    const wire = (el) => {
      lit = light(el);
      el.addEventListener("input", commit);
      el.addEventListener("keydown", (e) => {
        if (e.key === "/") setTimeout(() => openPicker(node, el, list, commit), 0);
      });
      commit();
    };

    /** Give the list its own pane, directly under the prompt.
     *
     * Moving ComfyUI's own widget rows does not stick - the frontend puts them
     * back on the next render - so nothing of ComfyUI's is moved. Only this
     * pane is inserted, and re-inserted if the grid is rebuilt.
     */
    const HEIGHT_KEY = "warppipeListHeight";

    const sizePane = () => {
      host.style.height = `${node.properties[HEIGHT_KEY] ?? 150}px`;
    };

    const attachGrow = (grow) => {
      grow.addEventListener("pointerdown", (down) => {
        down.preventDefault();
        grow.classList.add("is-drag");
        grow.setPointerCapture(down.pointerId);
        const startY = down.clientY;
        const startHeight = host.getBoundingClientRect().height;
        const onMove = (mv) => {
          node.properties[HEIGHT_KEY] = Math.max(48, startHeight + (mv.clientY - startY));
          sizePane();
        };
        const onUp = (up) => {
          grow.classList.remove("is-drag");
          grow.releasePointerCapture?.(up.pointerId);
          grow.removeEventListener("pointermove", onMove);
          grow.removeEventListener("pointerup", onUp);
          node.setDirtyCanvas?.(true, true);
        };
        grow.addEventListener("pointermove", onMove);
        grow.addEventListener("pointerup", onUp);
      });
    };

    const applyPane = () => {
      const root = document.querySelector(`[data-node-id="${node.id}"]`);
      const grid = root?.querySelector(".lg-node-widgets");
      if (!grid) return;

      const promptRow = Array.from(grid.children).find((r) => r.querySelector("textarea"));
      if (!promptRow) return;

      let grow = grid.querySelector(":scope > .wpe-grow");
      if (!grow) {
        grow = document.createElement("div");
        grow.className = "wpe-grow col-span-full";
        grow.title = "Drag to change the height of the list";
        attachGrow(grow);
      }

      // Re-appending the same elements keeps their listeners and scroll offset.
      if (host.previousElementSibling !== promptRow || !host.isConnected) {
        grid.insertBefore(host, promptRow.nextSibling);
        grid.insertBefore(grow, host.nextSibling);
      }
      sizePane();
    };

    // Prompt, then what is loaded, then how to add more, then the settings.
    const ORDER = ["text", "warppipe_rows", "Browse LoRAs", "insert_trigger_words", "apply_to_clip"];
    const reorderWidgets = () => {
      const widgets = node.widgets || [];
      const rank = (w) => {
        const i = ORDER.indexOf(w.name);
        return i === -1 ? ORDER.length : i;
      };
      const sorted = [...widgets].sort((a, b) => rank(a) - rank(b));
      if (sorted.some((w, i) => w !== widgets[i])) node.widgets = sorted;
    };

    const ensure = () => {
      reorderWidgets();
      applyPane();
      const el = findTextarea(node);
      if (el && !el._wpeLayer) {
        if (lit && lit.textarea !== el) lit.detach();
        wire(el);
      } else if (el && lit) {
        lit.measure();
      }
      hideListRow();
      return !!el;
    };

    let tries = 0;
    const timer = setInterval(() => {
      if (ensure() || ++tries > 150) clearInterval(timer);
    }, 100);
    const root = document.querySelector(`[data-node-id="${node.id}"]`);
    if (root) new MutationObserver(() => ensure()).observe(root, { childList: true, subtree: true });

    node._warppipeGetText = () => getEl()?.value || "";
    node._warppipeSetText = (value) => {
      const el = getEl();
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      commit();
    };
    node._warppipeAddLora = (stem) => {
      list.add(stem);
      commit();
    };
    node._warppipeRefresh = commit;
  },
});
