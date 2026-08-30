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

const TAG_RE = /<lora:([^:>]+):(-?[0-9]*\.?[0-9]+)([^>]*)>/gi;
const COMMENT_RE = /\/\/[^\n]*/g;
const EMBED_RE = /\bembedding:([^\s,]+)/gi;

const FRIENDLY_LABELS = {
  text: "Prompt",
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

.wpc { display: flex; flex-direction: column; gap: 3px; font-size: 11px; overflow-y: auto;
  color: var(--input-text, #dcdcdc); }
.wpc-empty { opacity: 0.45; padding: 4px 2px; }
.wpc-row {
  display: flex; align-items: center; gap: 6px; padding: 3px 5px; border-radius: 4px;
  background: var(--comfy-input-bg, #171717); border: 1px solid var(--border-color, #3a3a3a);
}
.wpc-row.is-missing { border-color: #b4553f; }
.wpc-thumb { width: 22px; height: 22px; flex: 0 0 22px; border-radius: 3px; object-fit: cover; background: #0d0d0d; }
.wpc-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wpc-name small { opacity: 0.5; }
.wpc-weight {
  width: 44px; text-align: center; padding: 1px 0; border-radius: 3px;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px;
  background: none; border: 1px solid transparent; color: #4ec8e8; cursor: ew-resize;
}
.wpc-weight:hover { border-color: var(--border-color, #3a3a3a); }
.wpc-weight:focus-visible { outline: 2px solid #4ec8e8; cursor: text; }
.wpc-btn { background: none; border: 0; color: inherit; opacity: 0.5; cursor: pointer;
  font-size: 12px; line-height: 1; padding: 2px 3px; border-radius: 3px; }
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
  textarea.classList.add("wpe-live", "is-lit");
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
    // The ink is transparent, so the caret needs its colour back.
    textarea.style.caretColor = cs.color;
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

function openPicker(node, el, commit) {
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
    const snippet =
      entry.kind === "embeddings"
        ? `embedding:${stemOf(entry.id)}`
        : `<lora:${stemOf(entry.id)}:1.0>`;
    const next = text.slice(0, slashAt) + snippet + text.slice(el.selectionStart);
    el.value = next;
    const caret = slashAt + snippet.length;
    el.setSelectionRange(caret, caret);
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

function buildRows(node, getEl, host, commit) {
  let generation = 0;

  const setText = (value) => {
    const el = getEl();
    if (!el) return;
    el.value = value;
    // Vue owns this input; an input event is how the widget value follows.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    commit();
  };

  const render = async () => {
    const mine = ++generation;
    const tags = parseTags(getEl()?.value || "");
    host.replaceChildren();

    if (!tags.length) {
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

    tags.forEach((tag, index) => {
      const entry = byStem.get(tag.name.toLowerCase());
      const row = document.createElement("div");
      row.className = "wpc-row" + (entry ? "" : " is-missing");

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
      name.title = tag.name;
      if (entry) name.innerHTML = `${escapeHTML(entry.name)} <small>${escapeHTML(entry.version || "")}</small>`;
      else name.textContent = tag.name;
      row.appendChild(name);

      if (entry?.triggers?.length) {
        const trig = document.createElement("button");
        trig.type = "button";
        trig.className = "wpc-btn wpc-trig";
        trig.textContent = `⊕${entry.triggers.length}`;
        trig.title = `Insert: ${entry.triggers.join(", ")}`;
        trig.addEventListener("click", () => {
          const text = getEl()?.value || "";
          const missing = entry.triggers.filter((w) => !text.toLowerCase().includes(w.toLowerCase()));
          if (missing.length) setText(`${text.trim()}, ${missing.join(", ")}`);
        });
        row.appendChild(trig);
      }

      const rewrite = (i, replacement) => {
        const current = getEl()?.value || "";
        const t = parseTags(current)[i];
        if (!t) return;
        setText(current.slice(0, t.start) + replacement + current.slice(t.start + t.raw.length));
      };

      const weight = document.createElement("input");
      weight.className = "wpc-weight";
      weight.value = tag.weight.toFixed(2);
      weight.title = "Drag to change, or type a value";
      const apply = (v) => rewrite(index, `<lora:${tag.name}:${Math.max(-4, Math.min(4, v)).toFixed(2)}>`);
      weight.addEventListener("change", () => apply(parseFloat(weight.value) || 0));
      weight.addEventListener("pointerdown", (down) => {
        let moved = false;
        const onMove = (mv) => {
          if (Math.abs(mv.clientX - down.clientX) < 3) return;
          moved = true;
          weight.value = (tag.weight + (mv.clientX - down.clientX) * 0.01).toFixed(2);
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          if (moved) apply(parseFloat(weight.value));
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
      row.appendChild(weight);

      const move = (delta) => {
        const current = getEl()?.value || "";
        const list = parseTags(current);
        const other = list[index + delta];
        if (!other) return;
        const [a, b] = delta > 0 ? [list[index], other] : [other, list[index]];
        let next = current;
        next = next.slice(0, b.start) + a.raw + next.slice(b.start + b.raw.length);
        next = next.slice(0, a.start) + b.raw + next.slice(a.start + a.raw.length);
        setText(next);
      };

      for (const [glyph, delta, disabled, label] of [
        ["↑", -1, index === 0, "Move earlier"],
        ["↓", 1, index === tags.length - 1, "Move later"],
      ]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "wpc-btn";
        btn.textContent = glyph;
        btn.title = label;
        btn.disabled = disabled;
        btn.addEventListener("click", () => move(delta));
        row.appendChild(btn);
      }

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "wpc-btn";
      remove.textContent = "✕";
      remove.title = "Remove";
      remove.addEventListener("click", () => rewrite(index, ""));
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

    const host = document.createElement("div");
    host.className = "wpc";
    const rowsWidget = node.addDOMWidget("warppipe_rows", "div", host, {
      getValue: () => "",
      setValue: () => {},
      serialize: false,
    });
    if (rowsWidget) {
      rowsWidget.label = "";
      rowsWidget.computeSize = () => [node.size[0], 92];
    }

    let lit = null;
    const getEl = () => lit?.textarea ?? findTextarea(node);

    const refreshVocabulary = async () => {
      const entries = await library();
      const byStem = new Map(entries.map((e) => [stemOf(e.id).toLowerCase(), e]));
      const words = new Set();
      for (const tag of parseTags(getEl()?.value || "")) {
        for (const w of byStem.get(tag.name.toLowerCase())?.triggers || []) words.add(w);
      }
      lit?.setVocabulary(new Set(byStem.keys()), [...words]);
    };

    let renderRows = async () => {};
    const commit = () => {
      lit?.paint();
      renderRows();
      refreshVocabulary();
      node.setDirtyCanvas?.(true, true);
    };
    renderRows = buildRows(node, getEl, host, commit);

    const wire = (el) => {
      lit = light(el);
      el.addEventListener("input", commit);
      el.addEventListener("keydown", (e) => {
        if (e.key === "/") setTimeout(() => openPicker(node, el, commit), 0);
      });
      commit();
    };

    // The widget is Vue-rendered: wait for it, and re-attach if it is replaced.
    const ensure = () => {
      const el = findTextarea(node);
      if (el && !el._wpeLayer) {
        if (lit && lit.textarea !== el) lit.detach();
        wire(el);
      } else if (el && lit) {
        lit.measure();
      }
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
    node._warppipeRefresh = commit;
  },
});
