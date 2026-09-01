import { app } from "../../scripts/app.js";
import { loras } from "./library.js";
import { connectedBase, groupOf } from "./model_base.js";
import { escapeHTML, stemOf } from "./text.js";

// The library browser for the Prompt + LoRAs node.
//
// Clicking a card writes the LoRA's bare filename into the prompt as a tag.
// That form resolves uniquely for every file in a 761-LoRA collection, and it
// reads far better in a prompt than a full path.

const NODE_ID = "Warp Lora Prompt";
const TEXT_WIDGET = "text";

const STYLE = `
.wp-backdrop {
  position: fixed; inset: 0; z-index: 1400;
  background: rgba(0, 0, 0, 0.62);
  display: flex; align-items: center; justify-content: center;
}
.wp-modal {
  --wp-warp: #4ec8e8;
  --wp-ground: var(--comfy-menu-bg, #202020);
  --wp-panel: var(--comfy-input-bg, #171717);
  --wp-ink: var(--input-text, #dcdcdc);
  --wp-rule: var(--border-color, #3a3a3a);
  --wp-mono: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace;

  width: min(1180px, 94vw); height: min(780px, 88vh);
  display: grid; grid-template-columns: 190px 1fr; grid-template-rows: auto 1fr auto;
  grid-template-areas: "head head" "rail grid" "rail foot";
  background: var(--wp-ground); color: var(--wp-ink);
  border: 1px solid var(--wp-rule); border-radius: 6px;
  overflow: hidden; box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
}
.wp-head {
  grid-area: head; display: flex; align-items: center; gap: 14px;
  padding: 12px 14px; border-bottom: 1px solid var(--wp-rule);
}
.wp-title { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; }
.wp-title span { color: var(--wp-warp); }
.wp-search {
  flex: 1; background: var(--wp-panel); color: var(--wp-ink);
  border: 1px solid var(--wp-rule); border-radius: 4px;
  padding: 6px 10px; font: inherit; font-size: 12px;
}
.wp-search:focus-visible { outline: 2px solid var(--wp-warp); outline-offset: 1px; }
.wp-close {
  background: none; border: 1px solid var(--wp-rule); color: var(--wp-ink);
  border-radius: 4px; width: 26px; height: 26px; cursor: pointer; font-size: 14px;
}
.wp-close:hover { border-color: var(--wp-warp); color: var(--wp-warp); }

.wp-rail {
  grid-area: rail; overflow-y: auto; padding: 10px 0;
  border-right: 1px solid var(--wp-rule); background: var(--wp-panel);
}
.wp-rail-row {
  display: flex; align-items: baseline; gap: 8px; width: 100%;
  padding: 6px 14px; background: none; border: 0; cursor: pointer;
  color: var(--wp-ink); font: inherit; font-size: 12px; text-align: left;
}
.wp-rail-row:hover { background: rgba(255, 255, 255, 0.05); }
.wp-rail-row[aria-pressed="true"] { color: var(--wp-warp); box-shadow: inset 2px 0 0 var(--wp-warp); }
.wp-rail-row.is-dim { opacity: 0.45; }
.wp-rail-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wp-rail-count { font-family: var(--wp-mono); font-size: 11px; opacity: 0.7; }
.wp-rail-row .wp-pin { color: var(--wp-warp); font-size: 9px; }

.wp-grid {
  grid-area: grid; overflow-y: auto; overflow-x: hidden; padding: 14px;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  /* Explicit row sizing: automatic tracks mis-measure these flex-column cards
     and collapse to a few pixels, letting every row overlap the one above. */
  grid-auto-rows: max-content;
  gap: 12px; align-content: start;
}
/* Every part of a card has a fixed height. Nothing here can grow with its
   content, so a long filename cannot push a card over its neighbour. */
.wp-card {
  display: flex; flex-direction: column; width: 100%; align-self: start;
  background: var(--wp-panel); border: 1px solid var(--wp-rule); border-radius: 5px;
  overflow: hidden; cursor: pointer; text-align: left; color: inherit;
  font: inherit; padding: 0;
}
.wp-card:hover { border-color: var(--wp-warp); }
.wp-card:focus-visible { outline: 2px solid var(--wp-warp); outline-offset: 2px; }
/* Previews are portrait but not one ratio (832x1152, 768x1280, 992x1456), so a
   fixed box crops rather than letting each card set its own height. */
.wp-card img,
.wp-noimg { display: block; width: 100%; height: 228px; flex: 0 0 228px; background: #0d0d0d; }
.wp-card img { object-fit: cover; }
.wp-noimg {
  display: flex; align-items: center; padding: 12px 10px; overflow: hidden;
  font-family: var(--wp-mono); font-size: 10px; line-height: 1.4;
  opacity: 0.5; word-break: break-word;
}
.wp-meta { padding: 8px 9px 9px; overflow: hidden; }
.wp-creator {
  font-size: 10px; opacity: 0.55;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wp-name {
  font-size: 12px; font-weight: 600; line-height: 1.3; margin: 1px 0 4px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; max-height: 2.6em;
}
.wp-tail {
  font-family: var(--wp-mono); font-size: 10px; opacity: 0.72;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wp-tail b { color: var(--wp-warp); font-weight: 400; }
.wp-trig { margin-top: 5px; font-size: 10px; opacity: 0.6; }

.wp-foot {
  grid-area: foot; padding: 8px 14px; border-top: 1px solid var(--wp-rule);
  font-size: 11px; opacity: 0.72; display: flex; gap: 14px;
}
.wp-foot .wp-hint { margin-left: auto; font-family: var(--wp-mono); }
.wp-empty { padding: 40px 14px; opacity: 0.6; font-size: 12px; }
@media (prefers-reduced-motion: reduce) { .wp-card, .wp-rail-row { transition: none; } }
`;

// How many cards are built at once. Past this the grid costs more to lay out
// than anyone can read down, and the search is the way through a large library.
const PAGE = 400;

// The same cache the prompt colours its tags from, so the two views can never
// be listing different libraries - and the server indexes the folder once.
const loadIndex = () => loras();

function insertTag(node, entry) {
  const widget = (node.widgets || []).find((w) => w.name === TEXT_WIDGET);
  if (!widget) return;

  // The bare filename resolves uniquely and keeps the prompt readable.
  const stem = stemOf(entry.id);
  // The prompt owns it: this lands on a line of its own, like typing would.
  // This is the path taken whenever the prompt UI is loaded, which is always;
  // everything below is the fallback for a browser opened without it.
  if (typeof node._warppipeAddLora === "function") {
    node._warppipeAddLora(stem);
    node.setDirtyCanvas?.(true, true);
    return;
  }

  const tag = `<lora:${stem}:1.0>`;
  const el = widget.inputEl;
  const current = widget.value || "";
  if (el && typeof el.selectionStart === "number") {
    const at = el.selectionStart;
    const next = `${current.slice(0, at)}${tag}${current.slice(el.selectionEnd)}`;
    widget.value = next;
    el.value = next;
    const caret = at + tag.length;
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    widget.value = current ? `${current} ${tag}` : tag;
  }
  node.setDirtyCanvas?.(true, true);
}

function openBrowser(node) {
  const backdrop = document.createElement("div");
  backdrop.className = "wp-backdrop";
  backdrop.innerHTML = `
    <div class="wp-modal" role="dialog" aria-modal="true" aria-label="LoRA library">
      <div class="wp-head">
        <div class="wp-title"><span>&#x1F300;</span> LoRA library</div>
        <input class="wp-search" type="search" placeholder="Search name, creator or version" />
        <button class="wp-close" aria-label="Close">&times;</button>
      </div>
      <div class="wp-rail"></div>
      <div class="wp-grid"><div class="wp-empty">Loading library&hellip;</div></div>
      <div class="wp-foot"><span class="wp-count"></span><span class="wp-hint">click to insert &middot; esc to close</span></div>
    </div>`;

  const modal = backdrop.querySelector(".wp-modal");
  const rail = backdrop.querySelector(".wp-rail");
  const grid = backdrop.querySelector(".wp-grid");
  const search = backdrop.querySelector(".wp-search");
  const count = backdrop.querySelector(".wp-count");

  const close = () => {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector(".wp-close").addEventListener("click", close);
  modal.addEventListener("mousedown", (e) => e.stopPropagation());

  document.body.appendChild(backdrop);
  search.focus();

  let connected = null;
  let entries = [];
  let folder = null;

  function render() {
    const query = search.value.trim().toLowerCase();
    const terms = query ? query.split(/\s+/) : [];
    const visible = entries.filter((e) => {
      if (folder && groupOf(e) !== folder) return false;
      if (!terms.length) return true;
      const hay = `${e.creator || ""} ${e.name} ${e.version || ""} ${groupOf(e)}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });

    grid.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "wp-empty";
      empty.textContent = "Nothing matches. Clear the search, or pick another family.";
      grid.appendChild(empty);
    }

    for (const entry of visible.slice(0, PAGE)) {
      const card = document.createElement("div");
      card.className = "wp-card";
      card.setAttribute("role", "button");
      card.tabIndex = 0;

      if (entry.has_preview) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = "";
        // Native lazy loading defers anything offscreen; no observer needed.
        img.src = entry.thumbnail;
        card.appendChild(img);
      } else {
        const blank = document.createElement("div");
        blank.className = "wp-noimg";
        blank.textContent = entry.id.replace(/\\/g, "/").split("/").pop();
        card.appendChild(blank);
      }

      const meta = document.createElement("div");
      meta.className = "wp-meta";
      if (entry.creator) {
        const who = document.createElement("div");
        who.className = "wp-creator";
        who.textContent = entry.creator;
        meta.appendChild(who);
      }
      const name = document.createElement("div");
      name.className = "wp-name";
      name.textContent = entry.name;
      meta.appendChild(name);

      const tail = document.createElement("div");
      tail.className = "wp-tail";
      // Only claim a version when the filename actually carried one.
      // Filenames and sidecars are not ours to trust: a base model called
      // "<img onerror=...>" is a string Civitai served, so it is escaped like
      // any other untrusted text rather than pasted straight into markup.
      const version = entry.structured && entry.version ? `${entry.version} · ` : "";
      tail.innerHTML = `${escapeHTML(version)}<b>${escapeHTML(groupOf(entry))}</b>`;
      meta.appendChild(tail);

      if (entry.triggers?.length) {
        const trig = document.createElement("div");
        trig.className = "wp-trig";
        trig.textContent = `⊕ ${entry.triggers.length} trigger word${entry.triggers.length > 1 ? "s" : ""}`;
        meta.appendChild(trig);
      }

      card.appendChild(meta);
      const choose = () => {
        insertTag(node, entry);
        close();
      };
      card.addEventListener("click", choose);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          choose();
        }
      });
      grid.appendChild(card);
    }

    const shown = Math.min(visible.length, PAGE);
    const capped = visible.length > PAGE ? ` (showing ${shown})` : "";
    const why = connected ? ` · ${connected} connected` : "";
    count.textContent = `${visible.length} of ${entries.length}${capped}${why}`;
  }

  function renderRail() {
    const counts = new Map();
    for (const e of entries) counts.set(groupOf(e), (counts.get(groupOf(e)) || 0) + 1);
    const folders = [...counts.entries()].sort((a, b) => b[1] - a[1]);

    rail.replaceChildren();
    const all = document.createElement("button");
    all.className = "wp-rail-row";
    all.type = "button";
    all.setAttribute("aria-pressed", String(folder === null));
    all.innerHTML =
      `<span class="wp-rail-name">All families</span>` +
      `<span class="wp-rail-count">${entries.length}</span>`;
    all.addEventListener("click", () => {
      folder = null;
      renderRail();
      render();
    });
    rail.appendChild(all);

    for (const [name, n] of folders) {
      const row = document.createElement("button");
      row.className = "wp-rail-row";
      row.type = "button";
      row.setAttribute("aria-pressed", String(folder === name));
      // Families that cannot apply to the connected model stay visible but quiet.
      if (connected && name !== connected) row.classList.add("is-dim");
      const pin = connected && name === connected ? '<span class="wp-pin">●</span>' : "";
      row.innerHTML =
        `${pin}<span class="wp-rail-name">${escapeHTML(name || "(root)")}</span>` +
        `<span class="wp-rail-count">${n}</span>`;
      row.addEventListener("click", () => {
        folder = folder === name ? null : name;
        renderRail();
        render();
      });
      rail.appendChild(row);
    }
  }

  search.addEventListener("input", render);

  Promise.all([loadIndex(), connectedBase(node)])
    .then(([data, base]) => {
      entries = data;
      connected = base;
      // Only pre-filter when the connected model's base is one we actually have
      // LoRAs for; otherwise show everything rather than an empty grid.
      folder = base && entries.some((e) => groupOf(e) === base) ? base : null;
      renderRail();
      render();
    })
    .catch((err) => {
      grid.replaceChildren();
      const fail = document.createElement("div");
      fail.className = "wp-empty";
      fail.textContent = `Could not load the library: ${err.message}. Is WarpPipe's server route running?`;
      grid.appendChild(fail);
    });
}

app.registerExtension({
  name: "warppipe.loraBrowser",
  async setup() {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_ID) return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = created?.apply(this, arguments);
      this.addWidget("button", "Browse LoRAs", null, () => openBrowser(this));
      return result;
    };
  },
});
