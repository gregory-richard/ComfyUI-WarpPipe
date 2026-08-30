import { app } from "../../scripts/app.js";

// What the prompt is actually doing, shown under the text box.
//
// A tag like <lora:creator - name - v1 (krea2):0.8> is precise but hard to read
// and harder to edit. This renders each one as a row you can weight, reorder or
// remove, and keeps the text as the single source of truth: every control here
// rewrites the tag in place rather than storing state of its own.

const NODE_ID = "Warp Lora Prompt";
const TEXT_WIDGET = "text";

// Matches a tag and captures its parts so one can be rewritten without touching
// the rest of the prompt.
const TAG_RE = /<lora:([^:>]+):(-?[0-9]*\.?[0-9]+)([^>]*)>/gi;

const FRIENDLY_LABELS = {
  text: "Prompt",
  insert_trigger_words: "Trigger words",
  apply_to_clip: "Apply to",
  model: "model",
  clip: "clip",
  warp: "warp",
};

const STYLE = `
.wpc {
  --wpc-warp: #4ec8e8;
  --wpc-ink: var(--input-text, #dcdcdc);
  --wpc-rule: var(--border-color, #3a3a3a);
  --wpc-panel: var(--comfy-input-bg, #171717);
  --wpc-mono: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace;
  display: flex; flex-direction: column; gap: 3px;
  font-size: 11px; color: var(--wpc-ink); overflow-y: auto;
}
.wpc-empty { opacity: 0.45; padding: 4px 2px; font-size: 11px; }
.wpc-row {
  display: flex; align-items: center; gap: 6px;
  background: var(--wpc-panel); border: 1px solid var(--wpc-rule);
  border-radius: 4px; padding: 3px 5px;
}
.wpc-row.is-missing { border-color: #b4553f; }
.wpc-thumb {
  width: 22px; height: 22px; border-radius: 3px; object-fit: cover;
  background: #0d0d0d; flex: 0 0 22px;
}
.wpc-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wpc-name small { opacity: 0.5; }
.wpc-weight {
  font-family: var(--wpc-mono); font-size: 11px; width: 44px; text-align: center;
  background: none; border: 1px solid transparent; border-radius: 3px;
  color: var(--wpc-warp); cursor: ew-resize; padding: 1px 0;
}
.wpc-weight:hover { border-color: var(--wpc-rule); }
.wpc-weight:focus-visible { outline: 2px solid var(--wpc-warp); outline-offset: 1px; cursor: text; }
.wpc-btn {
  background: none; border: 0; color: var(--wpc-ink); opacity: 0.5;
  cursor: pointer; font-size: 12px; line-height: 1; padding: 2px 3px; border-radius: 3px;
}
.wpc-btn:hover { opacity: 1; color: var(--wpc-warp); }
.wpc-btn:focus-visible { outline: 2px solid var(--wpc-warp); opacity: 1; }
.wpc-btn[disabled] { opacity: 0.15; cursor: default; }
.wpc-trig { color: var(--wpc-warp); opacity: 0.8; }

.wpc-menu {
  position: fixed; z-index: 1500; min-width: 260px; max-height: 320px; overflow-y: auto;
  background: var(--comfy-menu-bg, #202020); color: var(--input-text, #dcdcdc);
  border: 1px solid var(--border-color, #3a3a3a); border-radius: 5px;
  box-shadow: 0 12px 34px rgba(0,0,0,0.5); font-size: 12px; padding: 4px;
}
.wpc-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 5px 7px; background: none; border: 0; border-radius: 3px;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.wpc-item:hover, .wpc-item.is-active { background: rgba(78,200,232,0.16); }
.wpc-item small { margin-left: auto; opacity: 0.5; font-family: var(--wpc-mono); font-size: 10px; }
.wpc-kind { font-size: 10px; opacity: 0.55; padding: 5px 7px 3px; }
`;

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

function parseTags(text) {
  const found = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text)) !== null) {
    found.push({ raw: m[0], name: m[1].trim(), weight: parseFloat(m[2]), start: m.index });
  }
  return found;
}

function replaceTag(text, index, replacement) {
  const tags = parseTags(text);
  const tag = tags[index];
  if (!tag) return text;
  return text.slice(0, tag.start) + replacement + text.slice(tag.start + tag.raw.length);
}

function setText(widget, value) {
  widget.value = value;
  if (widget.inputEl) {
    widget.inputEl.value = value;
    widget.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// ---------------------------------------------------------------------------
// The "/" menu
// ---------------------------------------------------------------------------

function openSlashMenu(node, widget) {
  const el = widget.inputEl;
  if (!el) return;

  const menu = document.createElement("div");
  menu.className = "wpc-menu";
  const rect = el.getBoundingClientRect();
  menu.style.left = `${Math.round(rect.left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  menu.style.width = `${Math.round(Math.max(260, rect.width))}px`;
  document.body.appendChild(menu);

  let entries = [];
  let active = 0;
  // Where the "/" was typed, so the query and the slash can both be replaced.
  const slashAt = el.selectionStart - 1;

  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", onOutside, true);
    el.removeEventListener("keydown", onKey, true);
    el.removeEventListener("input", onInput);
  };

  const insert = (entry) => {
    const text = widget.value || "";
    const caret = el.selectionStart;
    const snippet =
      entry.kind === "embeddings"
        ? `embedding:${stemOf(entry.id)}`
        : `<lora:${stemOf(entry.id)}:1.0>`;
    const next = text.slice(0, slashAt) + snippet + text.slice(caret);
    setText(widget, next);
    const pos = slashAt + snippet.length;
    el.setSelectionRange(pos, pos);
    el.focus();
    close();
    node.setDirtyCanvas?.(true, true);
  };

  const render = () => {
    const query = (widget.value || "").slice(slashAt + 1, el.selectionStart).toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    const matches = entries
      .filter((e) => {
        if (!terms.length) return true;
        const hay = `${e.creator || ""} ${e.name} ${e.folder} ${e.kind}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .slice(0, 40);

    menu.replaceChildren();
    if (!matches.length) {
      const none = document.createElement("div");
      none.className = "wpc-kind";
      none.textContent = query ? `Nothing matches “${query}”` : "Library is empty";
      menu.appendChild(none);
      return;
    }
    active = Math.min(active, matches.length - 1);
    matches.forEach((entry, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "wpc-item" + (i === active ? " is-active" : "");
      const kind = entry.kind === "embeddings" ? "embedding" : entry.folder || "lora";
      row.innerHTML = `<span>${entry.name}</span><small>${kind}</small>`;
      row.addEventListener("click", () => insert(entry));
      menu.appendChild(row);
    });
    menu._matches = matches;
  };

  const onKey = (e) => {
    if (!menu.isConnected) return;
    const matches = menu._matches || [];
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(active + 1, matches.length - 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      render();
    } else if (e.key === "Enter" && matches[active]) {
      e.preventDefault();
      e.stopPropagation();
      insert(matches[active]);
    }
  };
  const onInput = () => {
    // Typing past the slash filters; deleting it closes the menu.
    if (el.selectionStart <= slashAt) close();
    else render();
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

// ---------------------------------------------------------------------------
// The chip list
// ---------------------------------------------------------------------------

function buildChips(node, widget, host) {
  // Renders are async (the library is fetched once) and can be triggered from
  // several places at once. Without this token two runs interleave past the
  // await and each appends its own rows, doubling the list.
  let generation = 0;

  const render = async () => {
    const mine = ++generation;
    const text = widget.value || "";
    const tags = parseTags(text);
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
      if (entry) {
        name.innerHTML = `${entry.name} <small>${entry.version || ""}</small>`;
        name.title = tag.name;
      } else {
        name.textContent = tag.name;
        name.title = "No file matches this name";
      }
      row.appendChild(name);

      if (entry?.triggers?.length) {
        const trig = document.createElement("button");
        trig.type = "button";
        trig.className = "wpc-btn wpc-trig";
        trig.textContent = `⊕${entry.triggers.length}`;
        trig.title = `Insert trigger words: ${entry.triggers.join(", ")}`;
        trig.addEventListener("click", () => {
          const missing = entry.triggers.filter(
            (w) => !text.toLowerCase().includes(w.toLowerCase())
          );
          if (missing.length) setText(widget, `${text.trim()}, ${missing.join(", ")}`);
          render();
        });
        row.appendChild(trig);
      }

      const weight = document.createElement("input");
      weight.className = "wpc-weight";
      weight.value = tag.weight.toFixed(2);
      weight.title = "Drag to change, or type a value";
      const applyWeight = (value) => {
        const clamped = Math.max(-4, Math.min(4, value));
        setText(widget, replaceTag(widget.value, index, `<lora:${tag.name}:${clamped.toFixed(2)}>`));
        render();
      };
      weight.addEventListener("change", () => applyWeight(parseFloat(weight.value) || 0));
      // Scrubbing beats retyping a number inside a long tag.
      weight.addEventListener("pointerdown", (down) => {
        let moved = false;
        const startX = down.clientX;
        const startValue = tag.weight;
        const onMove = (move) => {
          if (Math.abs(move.clientX - startX) < 3) return;
          moved = true;
          weight.value = (startValue + (move.clientX - startX) * 0.01).toFixed(2);
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          if (moved) applyWeight(parseFloat(weight.value));
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
      row.appendChild(weight);

      const move = (delta) => {
        const list = parseTags(widget.value);
        const target = list[index + delta];
        if (!target) return;
        let next = widget.value;
        // Swap the two tags by rewriting both, furthest first so the earlier
        // offsets stay valid.
        const [a, b] = delta > 0 ? [list[index], target] : [target, list[index]];
        next = next.slice(0, b.start) + a.raw + next.slice(b.start + b.raw.length);
        next = next.slice(0, a.start) + b.raw + next.slice(a.start + a.raw.length);
        setText(widget, next);
        render();
      };

      const up = document.createElement("button");
      up.type = "button";
      up.className = "wpc-btn";
      up.textContent = "↑";
      up.title = "Move earlier";
      up.disabled = index === 0;
      up.addEventListener("click", () => move(-1));
      row.appendChild(up);

      const down = document.createElement("button");
      down.type = "button";
      down.className = "wpc-btn";
      down.textContent = "↓";
      down.title = "Move later";
      down.disabled = index === tags.length - 1;
      down.addEventListener("click", () => move(1));
      row.appendChild(down);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "wpc-btn";
      remove.textContent = "✕";
      remove.title = "Remove";
      remove.addEventListener("click", () => {
        setText(widget, replaceTag(widget.value, index, ""));
        render();
      });
      row.appendChild(remove);

      host.appendChild(row);
    });
  };

  return render;
}

app.registerExtension({
  name: "warppipe.loraChips",
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

    const text = (node.widgets || []).find((w) => w.name === TEXT_WIDGET);
    if (!text) return;

    const host = document.createElement("div");
    host.className = "wpc";
    const chip = node.addDOMWidget("warppipe_chips", "div", host, {
      getValue: () => "",
      setValue: () => {},
      serialize: false,
    });
    if (chip) {
      chip.computeSize = () => [node.size[0], 88];
      chip.label = "";
    }

    const render = buildChips(node, text, host);
    render();

    if (text.inputEl) {
      text.inputEl.addEventListener("input", () => render());
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "/") {
          // Let the slash land first, so the caret sits after it.
          setTimeout(() => openSlashMenu(node, text), 0);
        }
      });
    }
    node._warppipeRenderChips = render;
  },
});
