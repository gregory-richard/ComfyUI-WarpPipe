import { app } from "../../scripts/app.js";
import { connectedBase, connectedModelName, sameBase } from "./model_base.js";
import { keepWidgetValuesByName } from "./widget_values.js";

// The prompt box, made legible.
//
// The text is the only state. A highlight layer sits behind a transparent
// textarea so tags, notes and trigger words are coloured while you still type
// into a real textarea (selection, undo, IME all intact). LoRAs are tags in
// that text, each on a line of its own, and every verb - weight, off, reorder,
// remove - is an ordinary text edit on that line. One strip under the prompt
// shows whichever tag the caret is in; nothing else is stored beside the text.

const NODE_ID = "Warp Lora Prompt";
const TEXT_WIDGET = "text";
const LIST_WIDGET = "loras";

// The strip is placed by hand rather than added as a widget. A widget of its
// own takes a slot in widgets_values, and those are restored by position: a
// workflow saved before it existed then loads every later value one place out,
// which put the LoRA list into apply_to_clip and lost it. Nothing about the
// saved node changes this way.
const STRIP_H = 24;

const TAG_RE = /<lora:([^:>]+):(-?[0-9]*\.?[0-9]+)([^>]*)>/gi;
const COMMENT_RE = /\/\/[^\n]*/g;
const EMBED_RE = /\bembedding:([^\s,]+)/gi;

const WEIGHT_STEP = 0.1;
const WEIGHT_LIMIT = 4;

const FRIENDLY_LABELS = {
  text: "Prompt",
  loras: "LoRAs",
  apply_to_clip: "Apply to",
};

const STYLE = `
/* The layer sits inside ComfyUI's own widget wrapper, which is positioned,
   and copies every metric that decides where a glyph lands. */
.wpe-hl {
  position: absolute; z-index: 0; pointer-events: none; overflow: hidden;
  color: var(--input-text, #dcdcdc);
  white-space: pre-wrap; overflow-wrap: break-word; word-break: normal;
  /* The textarea above is transparent so this layer shows through, which left
     the prompt the colour of the node body rather than of a field. The layer
     covers exactly the textarea's box, so it is what carries the field's own
     background now. */
  background: var(--comfy-input-bg, #222);
}
/* The textarea keeps selection, undo and IME. Only its ink is hidden. */
.wpe-live { position: relative; z-index: 1; background: transparent !important; }
.wpe-live.is-lit { color: transparent !important; }
/* Selecting text paints it in the browser's own selection colour, which is
   opaque - so a selection put plain grey text over the coloured layer and the
   notes stopped being italic while they were highlighted. Keeping the selected
   ink transparent as well leaves the layer showing through, and the highlight
   is a tint rather than a fill so it still shows what is selected. */
.wpe-live.is-lit::selection { color: transparent !important; background: rgba(78,200,232,0.28); }
.wpe-live.is-lit::-moz-selection { color: transparent !important; background: rgba(78,200,232,0.28); }
.wpe-tag { color: #4ec8e8; }
/* Two different complaints, told apart at a glance: red is a file that is not
   there, orange is a file that is there and is for another base model. The
   second still loads, so it is a warning rather than an error. */
.wpe-tag-unknown { color: #e0705a; text-decoration: underline wavy rgba(224,112,90,0.5); }
.wpe-tag-other { color: #e59440; text-decoration: underline dotted rgba(229,148,64,0.65); }
.wpe-embed { color: #e8b34e; }
.wpe-note { color: #7b7f86; font-style: italic; }
.wpe-trigger { color: #9ad9a4; }

/* Drawn, never typed: only its colour says it is provisional. */
.wpe-ghost { color: #767e8b; }
.wpe-ghost-key { color: #9aa3b0; }

/* One line along the bottom of the prompt field, for whichever tag the caret
   is in. It replaced a scrolling list of cards - one per LoRA - which repeated
   what the text already said and needed a draggable split to hold them all.
   One line needs no split: it is a fixed strip the prompt reserves room for. */
.wps {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
  display: flex; align-items: center; gap: 7px; box-sizing: border-box;
  height: 24px; padding: 0 6px; overflow: hidden;
  font-size: 10px; line-height: 1; color: var(--input-text, #dcdcdc);
  /* Darker than the field it sits in, so the two read as separate things. */
  background: var(--comfy-menu-bg, #171718);
  border-top: 1px solid var(--border-color, #3a3a3a);
}
.wps-idle { opacity: 0.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wps-thumb {
  width: 18px; height: 18px; flex: 0 0 18px; border-radius: 3px;
  object-fit: cover; background: #0d0d0d; display: block;
}
.wps-name {
  flex: 0 1 auto; min-width: 3em; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wps-name.is-missing { color: #e0705a; font-weight: 400; }
.wps-by {
  flex: 0 2 auto; min-width: 0; opacity: 0.5;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wps-by.is-other { color: #e59440; opacity: 0.9; }
/* Everything that can be acted on is the same shape and the same height, so
   the row reads as one line rather than as text with controls dropped in. */
.wps-chip {
  display: inline-flex; align-items: center; height: 15px; flex: 0 0 auto;
  padding: 0 5px; border-radius: 3px; box-sizing: border-box;
  border: 1px solid var(--border-color, #3a3a3a); background: none;
  font: inherit; line-height: 1; white-space: nowrap; color: inherit;
}
.wps-weight { color: #4ec8e8; font-family: ui-monospace, Consolas, monospace; }
/* The trigger words go last, where clipping them costs the least: they are a
   convenience, and the same words are one Tab away. */
.wps-words { display: flex; align-items: center; gap: 4px; margin-left: auto;
  min-width: 0; overflow: hidden; }
.wps-word { color: #9ad9a4; cursor: pointer; max-width: 11em;
  overflow: hidden; text-overflow: ellipsis; display: inline-block; }
.wps-word:hover { border-color: #9ad9a4; }
.wps-key { flex: 0 0 auto; opacity: 0.4; font-size: 11px; }
.wps-link {
  flex: 0 0 auto; text-decoration: none; color: #4ec8e8; opacity: 0.75;
  font-size: 12px; line-height: 1;
}
.wps-link:hover { opacity: 1; }
.wps-do { cursor: pointer; }
.wps-do:hover { border-color: #4ec8e8; color: #4ec8e8; }
.wps-open { cursor: pointer; }
.wps-open:hover { color: #4ec8e8; }

/* The details of one LoRA, at a size where the preview is worth looking at.
   The strip can only ever be a line; this is where the whole picture, every
   trigger word and the link live. */
.wpd-backdrop {
  position: fixed; inset: 0; z-index: 1500; background: rgba(0,0,0,0.62);
  display: flex; align-items: center; justify-content: center;
}
.wpd-modal {
  --wpd-warp: #4ec8e8;
  --wpd-rule: var(--border-color, #3a3a3a);
  width: min(860px, 92vw); max-height: 88vh;
  display: grid; grid-template-columns: minmax(0, 1fr) 300px;
  background: var(--comfy-menu-bg, #202020); color: var(--input-text, #dcdcdc);
  border: 1px solid var(--wpd-rule); border-radius: 6px; overflow: hidden;
  box-shadow: 0 24px 70px rgba(0,0,0,0.55); font-size: 12px;
}
.wpd-modal.is-bare { grid-template-columns: 1fr; width: min(420px, 92vw); }
.wpd-shot {
  display: flex; align-items: center; justify-content: center;
  background: #0d0d0d; min-height: 240px; overflow: hidden;
}
.wpd-shot img { max-width: 100%; max-height: 84vh; display: block; object-fit: contain; }
.wpd-side { display: flex; flex-direction: column; min-width: 0; overflow-y: auto; padding: 14px; gap: 10px; }
.wpd-title { font-size: 14px; font-weight: 600; overflow-wrap: break-word; }
.wpd-meta { opacity: 0.6; overflow-wrap: break-word; }
.wpd-file {
  font-family: ui-monospace, Consolas, monospace; font-size: 10px; opacity: 0.45;
  overflow-wrap: anywhere;
}
.wpd-label { font-size: 10px; opacity: 0.5; text-transform: uppercase; letter-spacing: 0.05em; }
.wpd-words { display: flex; flex-wrap: wrap; gap: 4px; }
.wpd-word {
  background: none; border: 1px solid var(--wpd-rule); color: #9ad9a4;
  border-radius: 3px; font: inherit; padding: 2px 6px; cursor: pointer;
  text-align: left; overflow-wrap: anywhere;
}
.wpd-word:hover { border-color: #9ad9a4; }
.wpd-word.is-in { opacity: 0.4; }
.wpd-foot { margin-top: auto; display: flex; gap: 6px; padding-top: 8px; }
.wpd-btn {
  background: none; border: 1px solid var(--wpd-rule); color: inherit;
  border-radius: 4px; font: inherit; padding: 4px 10px; cursor: pointer;
  text-decoration: none; display: inline-flex; align-items: center;
}
.wpd-btn:hover { border-color: var(--wpd-warp); color: var(--wpd-warp); }
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
// A reason names real files and real base models, so it can carry a quote.
const escapeAttr = (s) => escapeHTML(s).replace(/"/g, "&quot;");

// --- the text ---------------------------------------------------------------

/** Is this position inside a // note? A tag parked there is switched off. */
function inComment(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return text.slice(lineStart, index).includes("//");
}

function parseTags(text) {
  const found = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text)) !== null) {
    found.push({
      raw: m[0],
      name: m[1].trim(),
      weight: parseFloat(m[2]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return found;
}

/** The tag the caret is in or against. Touching either edge counts, so the
 *  weight keys work with the caret just after the closing bracket. */
function tagAt(text, index) {
  return parseTags(text).find((t) => index >= t.start && index <= t.end) || null;
}

const lineBounds = (text, index) => {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const nl = text.indexOf("\n", index);
  return { start, end: nl === -1 ? text.length : nl };
};

/** Replace a range, keeping the browser's own undo history.
 *
 * execCommand is the only way to edit a textarea that Ctrl+Z still understands;
 * assigning to value clears the undo stack, which would make every one of these
 * verbs a point of no return. The assignment is kept as a fallback for anywhere
 * the command is refused.
 */
function edit(textarea, from, to, text, caret) {
  textarea.focus();
  textarea.setSelectionRange(from, to);
  let ok = false;
  try {
    ok = document.execCommand("insertText", false, text);
  } catch {
    ok = false;
  }
  if (!ok) {
    const value = textarea.value || "";
    textarea.value = value.slice(0, from) + text + value.slice(to);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const at = caret ?? from + text.length;
  textarea.setSelectionRange(at, at);
}

/** Put a tag on a line of its own, where the caret is.
 *
 * Tags are not gathered at the top or the bottom: one belongs where you were
 * writing when you reached for it. The line to itself is what lets the
 * line-based verbs - comment out, move, delete - act on the tag and nothing
 * else, so no new syntax is needed for any of them.
 */
function tagInsertion(value, from, to, tag) {
  const before = value.slice(0, from).replace(/[ \t]+$/, "");
  const after = value.slice(to).replace(/^[ \t]+/, "");
  const openLine = before === "" || before.endsWith("\n");
  const closeLine = after === "" || after.startsWith("\n");
  const text = (openLine ? "" : "\n") + tag + (closeLine ? "" : "\n");
  return {
    from: before.length,
    to: value.length - after.length,
    text,
    // The caret lands at the end of the tag, so the weight keys and the strip
    // are both already pointing at what was just added.
    caret: before.length + (openLine ? 0 : 1) + tag.length,
  };
}

// --- highlighting ----------------------------------------------------------

/** Non-overlapping spans, earliest first: a note swallows anything after it.
 *
 * `status` answers for one LoRA name: null when there is nothing to say, or the
 * class and the reason when there is. Deciding that here would mean knowing
 * both the library and the connected model; this only needs to be told.
 */
function tokenise(text, status, triggers) {
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
    const flag = status?.(m[1].trim()) || null;
    claim(m.index, m.index + m[0].length, flag?.cls || "wpe-tag", flag?.title);
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

/** Render the text, with the suggestion spliced in as greyed-out extra text.
 *
 * The suggestion is drawn here rather than written into the textarea. Putting it
 * in the real value meant undoing it on every keystroke - which raced with fast
 * typing and duplicated characters, filled the browser's undo stack with edits
 * nobody made, and marked the workflow dirty while merely browsing. The layer
 * is only a picture of the text, so drawing on it costs nothing and cannot be
 * typed over.
 */
function highlight(text, status, triggers, ghost) {
  const spans = tokenise(text, status, triggers);
  const cut = ghost ? Math.max(0, Math.min(text.length, ghost.at)) : -1;
  const ghostHTML = ghost
    ? `<span class="wpe-ghost">${escapeHTML(ghost.text)}` +
      `<span class="wpe-ghost-key">${escapeHTML(ghost.hint || "")}</span></span>`
    : "";

  let placed = !ghost;
  const run = (from, to) => {
    if (!placed && cut >= from && cut <= to) {
      placed = true;
      return escapeHTML(text.slice(from, cut)) + ghostHTML + escapeHTML(text.slice(cut, to));
    }
    return escapeHTML(text.slice(from, to));
  };

  let html = "";
  let at = 0;
  for (const span of spans) {
    html += run(at, span.start);
    const title = span.title ? ` title="${escapeAttr(span.title)}"` : "";
    // Nested, so a suggestion inside a coloured run still reads as a suggestion.
    html += `<span class="${span.cls}"${title}>${run(span.start, span.end)}</span>`;
    at = span.end;
  }
  html += run(at, text.length);
  if (!placed) html += ghostHTML;
  // A trailing newline needs something after it or the layer scrolls short.
  return html + "\n";
}

// Every property that decides where a glyph lands, copied from the textarea
// onto the layer, so the two agree character for character.
const COPIED_STYLES = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing",
  "textIndent", "textTransform", "paddingTop", "paddingRight", "paddingBottom",
  "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
  "borderLeftWidth", "boxSizing", "tabSize", "textAlign",
];

/** The textarea being typed into, under either node renderer.
 *
 * With Nodes 2.0 the widget is a Vue component rendered under an element
 * tagged with the node's id. With the canvas renderer there is no such
 * element: ComfyUI overlays a plain textarea and hangs it off the widget as
 * inputEl. Both are real textareas, which is all anything here needs.
 */
function findTextarea(node) {
  const root = document.querySelector(`[data-node-id="${node.id}"]`);
  const rendered = root?.querySelector("textarea");
  if (rendered) return rendered;

  const widget = (node.widgets || []).find((w) => w.name === TEXT_WIDGET);
  const overlaid = widget?.inputEl ?? widget?.element;
  return overlaid?.tagName === "TEXTAREA" && overlaid.isConnected ? overlaid : null;
}

/** Colour ComfyUI's own textarea by putting a layer behind it.
 *
 * The widget is rendered by a Vue component, so the textarea can be replaced
 * at any time; the caller re-runs this when that happens. Nothing here changes
 * the value, which keeps serialising through ComfyUI as before.
 */
function light(textarea) {
  const holder = textarea.parentElement;
  if (!holder) return null;
  // Return the controls, not the element: handing back the layer itself left
  // the caller with something that had no paint() or measure().
  if (textarea._wpeControls) return textarea._wpeControls;

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

  let status = null;
  let triggers = [];
  let ghost = null;

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

    // ComfyUI's textarea reserves room for a scrollbar (scrollbar-gutter:
    // stable), so its text is laid out in a narrower box than the layer's.
    // Without matching that, every line wraps in a different place and the
    // colouring slides off the words. Whatever the gutter costs is added to
    // the layer's right padding.
    const borders =
      parseFloat(cs.borderLeftWidth || "0") + parseFloat(cs.borderRightWidth || "0");
    const gutter = Math.max(0, textarea.offsetWidth - textarea.clientWidth - borders);
    layer.style.paddingRight = `${parseFloat(cs.paddingRight || "0") + gutter}px`;

    // ComfyUI hides the textarea at low zoom; the layer follows it.
    layer.style.display = cs.display === "none" ? "none" : "";
  };

  const syncScroll = () => {
    if (layer.scrollTop !== textarea.scrollTop) layer.scrollTop = textarea.scrollTop;
    if (layer.scrollLeft !== textarea.scrollLeft) layer.scrollLeft = textarea.scrollLeft;
  };

  // Rewriting innerHTML with identical markup still costs a reflow and can be
  // seen as a flicker, and the timer calls this every second regardless.
  let painted = null;
  const paint = () => {
    const html = highlight(textarea.value || "", status, triggers, ghost);
    if (html !== painted) {
      painted = html;
      layer.innerHTML = html;
    }
    syncScroll();
  };

  // A textarea scrolls itself to follow the caret, at moments no event
  // reliably reports: focus, typing, selection and IME all do it. Rather than
  // guess, the two are compared on a timer as well as on scroll. Two integer
  // reads ten times a second cost nothing and cannot drift for longer than
  // that, whatever the browser does.
  for (const event of ["scroll", "input", "keyup", "click", "select", "focus", "blur"]) {
    textarea.addEventListener(event, syncScroll);
  }
  // One timer does both jobs. ResizeObserver would be the obvious way to catch
  // a resize, but it only delivers while the page is rendering, so a node
  // resized in a background tab comes back with the layer still at its old
  // size. Comparing two integers ten times a second always works.
  let tick = 0;
  const ticker = setInterval(() => {
    syncScroll();
    const resized =
      layer.offsetWidth !== textarea.offsetWidth || layer.offsetHeight !== textarea.offsetHeight;
    // Once a second regardless, so a theme change is picked up too - those
    // alter the font without altering the size.
    if (resized || ++tick % 10 === 0) {
      measure();
      paint();
    }
  }, 100);

  measure();

  const controls = {
    layer,
    textarea,
    paint,
    measure,
    syncScroll,
    // status(name) -> null, or { cls, title } saying what is wrong with it.
    setVocabulary: (nextStatus, nextTriggers) => {
      status = nextStatus;
      triggers = nextTriggers;
      paint();
    },
    // { at, text, hint } - extra text drawn at an offset, or null for none.
    setGhost: (next) => {
      ghost = next;
      paint();
    },
    detach: () => {
      clearInterval(ticker);
      layer.remove();
      textarea.classList.remove("wpe-live", "is-lit");
      delete textarea._wpeLayer;
      delete textarea._wpeControls;
    },
  };

  textarea._wpeControls = controls;
  return controls;
}

// --- editing verbs ---------------------------------------------------------

const roundWeight = (value) =>
  Math.max(-WEIGHT_LIMIT, Math.min(WEIGHT_LIMIT, Math.round(value / WEIGHT_STEP) * WEIGHT_STEP));

/** The four things the rows used to do, as keys on the text.
 *
 * Each is an ordinary edit to one line, which is why a tag gets a line of its
 * own: commenting, moving and deleting a line then mean exactly one LoRA.
 */
function editVerbs(textarea, commit) {
  textarea.addEventListener("keydown", (e) => {
    const value = textarea.value || "";
    const caret = textarea.selectionStart;
    const ctrl = e.ctrlKey || e.metaKey;

    // Weight. ComfyUI binds these keys for (word:1.1) emphasis, so outside a
    // tag its handler is left alone and the key keeps its usual meaning.
    if (ctrl && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const tag = tagAt(value, caret);
      if (!tag) return;
      e.preventDefault();
      e.stopPropagation();
      const next = roundWeight(tag.weight + (e.key === "ArrowUp" ? WEIGHT_STEP : -WEIGHT_STEP));
      const written = `<lora:${tag.name}:${next.toFixed(2)}>`;
      edit(textarea, tag.start, tag.end, written, tag.start + written.length);
      commit();
      return;
    }

    // Off and on. The backend already drops anything behind a //, so this
    // needs no syntax of its own - and it reads as switched off, not deleted.
    if (ctrl && e.key === "/") {
      e.preventDefault();
      e.stopPropagation();
      const { start, end } = lineBounds(value, caret);
      const line = value.slice(start, end);
      const off = /^(\s*)\/\/ ?/.exec(line);
      const next = off ? off[1] + line.slice(off[0].length) : line.replace(/^(\s*)/, "$1// ");
      edit(textarea, start, end, next, Math.max(start, caret + (next.length - line.length)));
      commit();
      return;
    }

    // Order matters: LoRAs are applied down the prompt, so a line can be moved.
    if (e.altKey && !ctrl && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const up = e.key === "ArrowUp";
      const here = lineBounds(value, caret);
      if (up && here.start === 0) return;
      if (!up && here.end === value.length) return;
      e.preventDefault();
      e.stopPropagation();

      const other = up
        ? lineBounds(value, here.start - 1)
        : lineBounds(value, here.end + 1);
      const from = Math.min(here.start, other.start);
      const to = Math.max(here.end, other.end);
      const line = value.slice(here.start, here.end);
      const swap = value.slice(other.start, other.end);
      const next = up ? `${line}\n${swap}` : `${swap}\n${line}`;
      // Keep the caret at the same column of the same line, now moved.
      const column = caret - here.start;
      const landing = up ? from : from + swap.length + 1;
      edit(textarea, from, to, next, landing + Math.min(column, line.length));
      commit();
    }
  });
}

// --- inline completion -----------------------------------------------------

/** Inline completion for "/", and the trigger words that follow it.
 *
 * Typing / starts a suggestion. The best match is drawn in grey at the end of
 * the caret's line; Tab takes it, the arrows walk the alternatives, Escape or
 * moving away drops it. Nothing is written until Tab: the textarea holds only
 * what was typed, so a suggestion cannot be typed over, cannot land in the undo
 * history, and cannot mark the workflow changed.
 *
 * Taking a LoRA that declares trigger words offers them straight away as a
 * second suggestion, so the common pair - add it, then say its word - is Tab
 * twice and no dialog.
 *
 * A popover anchored near the caret was the obvious design and kept covering
 * the text: the caret's position has to be estimated from a mirror of the text,
 * and any disagreement puts the menu on what is being typed. Grey text needs no
 * estimating; the same layer draws it, from the same string.
 */
function inlineCompletion(node, textarea, commit, lit, lookup, say, baseOf) {
  // { kind: "lora", at, query, matches, index } | { kind: "trigger", at, options, index }
  let session = null;
  let run = 0; // so a slow lookup cannot overwrite a newer one

  const drop = () => {
    if (!session) return;
    session = null;
    lit?.setGhost(null);
  };

  // The suggestion goes at the end of the caret's line, so text after the
  // caret is never pushed out of step with the real textarea underneath.
  const lineEnd = (value, caret) => lineBounds(value, caret).end;

  const draw = () => {
    if (!session) return lit?.setGhost(null);

    if (session.kind === "trigger") {
      const { options, index } = session;
      const nth = options.length > 1 ? ` ${index + 1}/${options.length} ↑↓` : "";
      lit?.setGhost({ at: session.at, text: ` ${options[index]}`, hint: `${nth} ⇥` });
      return;
    }

    if (!session.matches.length) return lit?.setGhost(null);
    const stem = stemOf(session.matches[session.index].id);
    const q = session.query;
    const shown = stem.toLowerCase().startsWith(q.toLowerCase()) ? stem.slice(q.length) : ` ${stem}`;
    const nth =
      session.matches.length > 1 ? ` ${session.index + 1}/${session.matches.length} ↑↓` : "";
    lit?.setGhost({
      at: lineEnd(textarea.value || "", session.at + 1 + q.length),
      text: shown,
      hint: `${nth} ⇥`,
    });
  };

  const look = async () => {
    if (!session || session.kind !== "lora") return;
    const mine = ++run;
    if ((textarea.value || "")[session.at] !== "/") return drop();

    const [entries, base] = await Promise.all([library(), baseOf?.() ?? null]);
    if (!session || session.kind !== "lora" || mine !== run) return;

    const q = session.query.toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const startsWith = (e) =>
      stemOf(e.id).toLowerCase().startsWith(q) ? 0 : e.name.toLowerCase().startsWith(q) ? 1 : 2;

    // A LoRA for another base model does not work on the model that is wired
    // in, so suggesting it is a waste of the list. Only what is *known* not to
    // fit is dropped: a file with no sidecar declares no base model, and
    // guessing it does not fit would hide a working LoRA - in one real
    // collection 163 of 761 files say nothing about their base. Those sort
    // after the ones that match, so the first suggestion is always a fit when
    // a fit exists.
    const fit = (e) => (sameBase(e.base_model, base) ? 0 : e.base_model ? 2 : 1);

    session.matches = entries
      .filter((e) => {
        if (!terms.length) return false; // a bare "/" is a slash, not a request
        if (base && e.base_model && !sameBase(e.base_model, base)) return false;
        const hay = `${e.creator || ""} ${e.name} ${e.folder} ${stemOf(e.id)}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .sort(
        (a, b) =>
          fit(a) - fit(b) ||
          startsWith(a) - startsWith(b) ||
          stemOf(a.id).length - stemOf(b.id).length
      )
      .slice(0, 40);
    session.index = 0;
    draw();
  };

  /** Offer a LoRA's trigger words, all of them first, then one at a time. */
  const offerTriggers = (words) => {
    const clean = (words || []).filter(Boolean);
    if (!clean.length) return;
    const value = textarea.value || "";
    const options = clean.length > 1 ? [clean.join(", "), ...clean] : clean;
    session = {
      kind: "trigger",
      at: lineEnd(value, textarea.selectionStart),
      options,
      index: 0,
    };
    draw();
  };

  const accept = () => {
    if (!session) return false;
    const value = textarea.value || "";

    if (session.kind === "trigger") {
      const words = session.options[session.index];
      const at = session.at;
      drop();
      // A line of their own, right under the tag that wants them, so the tag
      // line stays a tag line and both can be moved or commented separately.
      edit(textarea, at, at, `\n${words}`);
      commit();
      return true;
    }

    if (!session.matches.length) return false;
    const entry = session.matches[session.index];
    const { at, query } = session;
    const stem = stemOf(entry.id);
    drop();

    if (entry.kind === "embeddings") {
      // An embedding is prompt text: it goes exactly where it was typed.
      edit(textarea, at, at + 1 + query.length, `embedding:${stem}`);
      commit();
      return true;
    }

    const plan = tagInsertion(value, at, at + 1 + query.length, `<lora:${stem}:1.00>`);
    edit(textarea, plan.from, plan.to, plan.text, plan.caret);
    commit();
    if (entry.triggers?.length) offerTriggers(entry.triggers);
    return true;
  };

  textarea.addEventListener("keydown", (e) => {
    // Ctrl+/ switches a line off; only a bare slash starts a suggestion.
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      setTimeout(() => {
        session = {
          kind: "lora",
          at: Math.max(0, textarea.selectionStart - 1),
          query: "",
          matches: [],
          index: 0,
        };
        look();
      }, 0);
      return;
    }

    // Tab on a tag offers its trigger words, however long ago it was added.
    // It is the same key that offered them the moment it went in, so there is
    // nothing extra to know - put the caret in a tag and ask again.
    //
    // Every outcome answers. Doing nothing when there are no words to offer is
    // indistinguishable from the key not working at all, and a quarter of a
    // real collection - 470 of 1884 files - declares none.
    if (!session && e.key === "Tab") {
      const tag = tagAt(textarea.value || "", textarea.selectionStart);
      if (!tag) return; // not on a tag: Tab keeps its usual meaning
      e.preventDefault();
      e.stopPropagation();
      const entry = lookup?.(tag.name);
      if (!entry) {
        say?.(`${tag.name} — no such file in the library`);
      } else if (entry.triggers?.length) {
        offerTriggers(entry.triggers);
      } else {
        say?.(`${entry.title || entry.name} declares no trigger words`);
      }
      return;
    }
    if (!session) return;

    const count = session.kind === "trigger" ? session.options.length : session.matches.length;
    if (!count) {
      if (e.key === "Escape") drop();
      return;
    }

    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      accept();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      session.index = (session.index + (e.key === "ArrowDown" ? 1 : -1) + count) % count;
      draw();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      drop();
    } else if (session.kind === "trigger") {
      // Typing on is a decision to write your own words instead.
      drop();
    }
  });

  textarea.addEventListener("input", () => {
    if (!session || session.kind !== "lora") return;
    const value = textarea.value || "";
    const caret = textarea.selectionStart;
    // The session lasts as long as the caret is still after its own slash.
    if (value[session.at] !== "/" || caret <= session.at) return drop();
    session.query = value.slice(session.at + 1, caret);
    if (/[\n,<>]/.test(session.query)) return drop();
    look();
  });

  // Clicking elsewhere in the text is a decision not to complete.
  textarea.addEventListener("blur", drop);
  textarea.addEventListener("pointerdown", drop);
}

// --- the details -----------------------------------------------------------

/** Everything about one LoRA, at a size worth looking at.
 *
 * The strip is a line, so it can only ever show a thumbnail and the first few
 * trigger words. This is the rest: the preview at its own size, every trigger
 * word, and the link. It opens from the strip, on whichever tag the caret is
 * in, so it needs no list of its own to find things in.
 */
function openDetails(entry, promptText, insertWords) {
  document.querySelector(".wpd-backdrop")?.remove();

  const backdrop = document.createElement("div");
  backdrop.className = "wpd-backdrop";
  const modal = document.createElement("div");
  modal.className = "wpd-modal" + (entry.thumbnail ? "" : " is-bare");

  if (entry.thumbnail) {
    const shot = document.createElement("div");
    shot.className = "wpd-shot";
    const img = document.createElement("img");
    img.alt = "";
    // The thumbnail first, then the file itself once it arrives: the cached
    // 320px copy is already there, so something is on screen immediately.
    img.src = entry.thumbnail;
    const full = new Image();
    full.onload = () => {
      img.src = full.src;
    };
    full.src = `${entry.thumbnail}&full=1`;
    shot.appendChild(img);
    modal.appendChild(shot);
  }

  const side = document.createElement("div");
  side.className = "wpd-side";

  const title = document.createElement("div");
  title.className = "wpd-title";
  title.textContent = entry.title || entry.name;
  side.appendChild(title);

  const meta = [entry.creator, entry.structured ? entry.version : "", entry.base_model]
    .filter(Boolean)
    .join(" · ");
  if (meta) {
    const line = document.createElement("div");
    line.className = "wpd-meta";
    line.textContent = meta;
    side.appendChild(line);
  }

  const file = document.createElement("div");
  file.className = "wpd-file";
  file.textContent = entry.id;
  side.appendChild(file);

  if (entry.triggers?.length) {
    const label = document.createElement("div");
    label.className = "wpd-label";
    label.textContent = `Trigger words (${entry.triggers.length})`;
    side.appendChild(label);

    const words = document.createElement("div");
    words.className = "wpd-words";
    const lower = (promptText || "").toLowerCase();
    for (const word of entry.triggers) {
      const button = document.createElement("button");
      button.type = "button";
      // Dimmed when already written: the point is to see what is missing.
      button.className = "wpd-word" + (lower.includes(word.toLowerCase()) ? " is-in" : "");
      button.textContent = word;
      button.addEventListener("click", () => {
        insertWords(word);
        button.classList.add("is-in");
      });
      words.appendChild(button);
    }
    side.appendChild(words);
  }

  const foot = document.createElement("div");
  foot.className = "wpd-foot";
  if (entry.url) {
    const link = document.createElement("a");
    link.className = "wpd-btn";
    link.href = entry.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Civitai ↗";
    foot.appendChild(link);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "wpd-btn";
  close.textContent = "Close";
  foot.appendChild(close);
  side.appendChild(foot);

  modal.appendChild(side);
  backdrop.appendChild(modal);

  const shut = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    shut();
  };
  close.addEventListener("click", shut);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) shut();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(backdrop);
}

// --- the strip -------------------------------------------------------------

/** One line under the prompt, describing the tag the caret is in.
 *
 * This is what the cards became. A card per LoRA repeated what the text already
 * said, and needed a scrolling panel and a draggable split to hold them all -
 * which is where the flickering and the caret-hiding came from. Only one LoRA
 * can be under the caret, so only one line is ever needed.
 */
function makeStrip(node) {
  const el = document.createElement("div");
  el.className = "wps";

  const idle = (text) => {
    el.replaceChildren();
    const span = document.createElement("span");
    span.className = "wps-idle";
    span.textContent = text;
    el.appendChild(span);
  };

  const show = (tag, entry, insertWords, openFull, fits) => {
    el.replaceChildren();

    if (entry?.thumbnail) {
      const img = document.createElement("img");
      img.className = "wps-thumb wps-open";
      img.loading = "lazy";
      img.alt = "";
      img.src = entry.thumbnail;
      img.title = "See the preview, the trigger words and the link";
      img.addEventListener("click", openFull);
      el.appendChild(img);
    }

    const name = document.createElement("span");
    name.className = "wps-name" + (entry ? " wps-open" : " is-missing");
    name.textContent = entry ? entry.title || entry.name : `${tag.name} — no such file`;
    name.title = entry ? "See the preview, the trigger words and the link" : tag.name;
    if (entry) name.addEventListener("click", openFull);
    el.appendChild(name);

    const by = [entry?.creator, entry?.structured ? entry?.version : ""]
      .filter(Boolean)
      .join(" · ");
    if (by) {
      const span = document.createElement("span");
      span.className = "wps-by";
      span.textContent = by;
      el.appendChild(span);
    }
    if (entry?.base_model) {
      // The same thing the orange in the prompt says, in words.
      const span = document.createElement("span");
      span.className = "wps-by" + (fits === false ? " is-other" : "");
      span.textContent = entry.base_model;
      if (fits === false) span.title = "Made for another base model than the one connected";
      el.appendChild(span);
    }

    const weight = document.createElement("span");
    weight.className = "wps-chip wps-weight";
    weight.textContent = tag.weight.toFixed(2);
    weight.title = "Ctrl+↑ / Ctrl+↓ to change, in steps of 0.1";
    el.appendChild(weight);

    if (entry?.triggers?.length) {
      const words = document.createElement("span");
      words.className = "wps-words";
      // The buttons are the mouse's route to these; this says the keyboard has
      // one too, which is otherwise nowhere on screen.
      const key = document.createElement("span");
      key.className = "wps-key";
      key.textContent = "⇥";
      key.title = "Tab inserts a trigger word";
      words.appendChild(key);
      for (const word of entry.triggers.slice(0, 6)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "wps-chip wps-word";
        button.textContent = word;
        button.title = `Insert "${word}"`;
        button.addEventListener("click", () => insertWords(word));
        words.appendChild(button);
      }
      el.appendChild(words);
    }

    if (entry?.url) {
      const link = document.createElement("a");
      link.className = "wps-link";
      link.href = entry.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "↗";
      link.title = "Open its page on Civitai";
      // Without trigger words nothing has pushed to the right yet.
      if (!entry?.triggers?.length) link.style.marginLeft = "auto";
      el.appendChild(link);
    }
  };

  /** Old workflows kept their LoRAs in a field of their own. The backend still
   *  reads it, so nothing is broken - but it is the last thing that does, and
   *  moving it is a single edit the reader should get to approve. */
  const offerMove = (count, move) => {
    el.replaceChildren();
    const span = document.createElement("span");
    span.className = "wps-idle";
    span.textContent = `${count} LoRA${count === 1 ? "" : "s"} in the old field`;
    el.appendChild(span);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wps-chip wps-do";
    button.textContent = "Move into the prompt";
    button.addEventListener("click", move);
    el.appendChild(button);
  };

  return { el, idle, show, offerMove };
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

    // Kept in the schema so older workflows still load and still run - the
    // backend reads tags from both - but no longer shown or written to.
    // Neither renderer honours widget.hidden, so a canvas widget is hidden by
    // giving it no size to draw in.
    const listWidget = (node.widgets || []).find((w) => w.name === LIST_WIDGET);
    if (listWidget) {
      listWidget.computeSize = () => [0, -4];
      listWidget.draw = () => {};
    }

    let lit = null;
    const getEl = () => lit?.textarea ?? findTextarea(node);
    const strip = makeStrip(node);

    /** Put the strip along the bottom of the field the prompt already sits in.
     *
     * The room it needs is a constant. Sizing a panel from the height of the
     * box it lives in - which is what the old list did - feeds back, because
     * the box is sized by its contents: the two then chase each other a pixel
     * at a time, which showed as the prompt jumping and the caret blinking.
     */
    const attachStrip = () => {
      const el = getEl();
      const holder = el?.parentElement;
      if (!holder) return;
      if (strip.el.parentElement !== holder) holder.appendChild(strip.el);
      const want = `${STRIP_H}px`;
      if (el.style.paddingBottom !== want) {
        el.style.paddingBottom = want;
        // The layer copies the textarea's padding, so the text stays aligned.
        lit?.measure();
        lit?.paint();
      }
    };

    /** Everything the tags need to know about themselves. */
    let known = new Map();
    /** Every name a tag might use for a file, not just its bare stem.
     *
     * ComfyUI's own loader names a LoRA by its path inside the folder, so a tag
     * copied out of one carries a directory the stem does not have. Indexing
     * only stems left those tags looking unknown - red, and with nothing behind
     * them - although the backend resolves them perfectly well.
     */
    const indexBy = (entries) => {
      const map = new Map();
      for (const entry of entries) {
        const noExt = entry.id.replace(/\.[^.]+$/, "");
        for (const key of [stemOf(entry.id), noExt, noExt.replace(/\\/g, "/")]) {
          const at = key.toLowerCase();
          if (!map.has(at)) map.set(at, entry);
        }
      }
      return map;
    };
    const lookup = (name) => {
      const at = (name || "").trim().toLowerCase();
      return known.get(at) ?? known.get(stemOf(at)) ?? null;
    };

    const refreshVocabulary = async () => {
      const entries = await library();
      known = indexBy(entries);
      const words = new Set();
      for (const tag of parseTags(getEl()?.value || "")) {
        for (const w of lookup(tag.name)?.triggers || []) words.add(w);
      }
      lit?.setVocabulary(tagStatus, [...words]);
      await baseOf();
      updateStrip();
    };

    const insertWords = (word) => {
      const el = getEl();
      if (!el) return;
      const value = el.value || "";
      const at = lineBounds(value, el.selectionStart).end;
      edit(el, at, at, `\n${word}`);
      commit();
    };

    const moveOldList = () => {
      const el = getEl();
      if (!el || !listWidget) return;
      // The old field is already one tag per line, // and all - which is the
      // shape the prompt wants, so it is appended as it stands.
      const lines = (listWidget.value || "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return;
      const value = el.value || "";
      const joined = lines.join("\n");
      const text = value && !value.endsWith("\n") ? `\n${joined}` : joined;
      edit(el, value.length, value.length, text);
      listWidget.value = "";
      commit();
    };

    // A message worth reading outlives the keyup that follows the key that
    // caused it - without this the strip would go back to describing the caret
    // before the answer could be read.
    let notice = null;
    const say = (text) => {
      notice = { text, until: Date.now() + 3000 };
      strip.idle(text);
    };

    const updateStrip = () => {
      const el = getEl();
      if (!el) return;
      if (notice && Date.now() < notice.until) return;
      notice = null;
      if (listWidget?.value?.trim()) {
        const count = parseTags(listWidget.value).length;
        if (count) return strip.offerMove(count, moveOldList);
      }
      const value = el.value || "";
      // The strip describes what the caret is on, so with the caret gone there
      // is nothing for it to describe: leaving the last tag up made it look
      // like the state of the node rather than the state of the cursor.
      //
      // Asked of the document rather than tracked from focus and blur. A flag
      // is only ever as right as the last event that reached it, and this is
      // repainted from a timer and from every edit as well.
      const hasCaret = document.activeElement === el;
      const tag = hasCaret ? tagAt(value, el.selectionStart) : null;
      if (!tag) {
        const total = parseTags(value).filter((t) => !inComment(value, t.start)).length;
        // Naming the base model here is the only place the reader can find out
        // that "/" is not offering them the whole library.
        const fitting = baseSeen.base ? ` · ${baseSeen.base}` : "";
        strip.idle(
          total
            ? `${total} LoRA${total === 1 ? "" : "s"} · / to add${fitting} · caret in a tag to see it`
            : `Press / to add a LoRA or embedding${fitting}`
        );
        return;
      }
      const entry = lookup(tag.name);
      const fits = entry?.base_model && baseSeen.base ? sameBase(entry.base_model, baseSeen.base) : null;
      strip.show(
        tag,
        entry,
        insertWords,
        () => entry && openDetails(entry, el.value || "", insertWords),
        fits
      );
    };

    /** What is wrong with this tag, if anything.
     *
     * Two complaints, and they are not the same. A name nothing matches will
     * not load at all, and is red. A name that matches a file made for another
     * base model loads perfectly well and usually does nothing useful, so it is
     * a warning in orange rather than an error - the reader may know something
     * the sidecar does not.
     */
    const tagStatus = (name) => {
      const entry = lookup(name);
      if (!entry) return { cls: "wpe-tag-unknown", title: "No file matches this name" };
      const base = baseSeen.base;
      if (base && entry.base_model && !sameBase(entry.base_model, base)) {
        return {
          cls: "wpe-tag-other",
          title: `Made for ${entry.base_model}, but ${base} is connected`,
        };
      }
      return null;
    };

    // Asked again whenever the wired-in model changes, and not otherwise: the
    // answer is a file read on the server and the checkpoint rarely moves.
    let baseSeen = { name: undefined, base: null };
    const baseOf = async () => {
      const name = connectedModelName(node);
      if (name === baseSeen.name) return baseSeen.base;
      const base = await connectedBase(node);
      baseSeen = { name, base };
      return base;
    };

    const commit = () => {
      lit?.paint();
      refreshVocabulary();
      node.setDirtyCanvas?.(true, true);
    };

    const wire = (el) => {
      lit = light(el);
      el.addEventListener("input", commit);
      // The strip follows the caret, which moves for reasons other than typing.
      for (const event of ["keyup", "click", "select"]) {
        el.addEventListener(event, updateStrip);
      }
      el.addEventListener("focus", updateStrip);
      el.addEventListener("blur", (e) => {
        // Focus moving into the strip is still work on this tag - its trigger
        // words and its preview are buttons in there, and clearing on the way
        // to one would take it away as it was being clicked. The repaint is
        // deferred so the document has settled on where focus went.
        if (strip.el.contains(e.relatedTarget)) return;
        setTimeout(updateStrip, 0);
      });
      editVerbs(el, commit);
      inlineCompletion(node, el, commit, lit, lookup, say, baseOf);
      attachStrip();
      commit();
    };

    // Widget values are stored by position, and this node reorders its widgets
    // so Browse sits under the prompt - which put every value after the prompt
    // one place out on each save and reload.
    keepWidgetValuesByName(node);

    // Prompt, then what the caret is on, then how to add more, then settings.
    const ORDER = [TEXT_WIDGET, "Browse LoRAs", "apply_to_clip"];
    const reorderWidgets = () => {
      const widgets = node.widgets || [];
      const rank = (w) => {
        const i = ORDER.indexOf(w.name);
        return i === -1 ? ORDER.length : i;
      };
      const sorted = [...widgets].sort((a, b) => rank(a) - rank(b));
      if (sorted.some((w, i) => w !== widgets[i])) node.widgets = sorted;
    };

    // ensure() writes into the very subtree the observer watches, so without
    // this guard each pass triggers the next.
    let settling = false;
    const ensure = () => {
      if (settling) return !!getEl();
      settling = true;
      try {
        reorderWidgets();
        const el = findTextarea(node);
        if (el && !el._wpeLayer) {
          if (lit && lit.textarea !== el) lit.detach();
          wire(el);
        } else if (el && lit) {
          lit.measure();
          attachStrip();
        }
        return !!el;
      } finally {
        // Released after the observer has delivered this pass's own records,
        // so they are dropped rather than starting another.
        queueMicrotask(() => {
          settling = false;
        });
      }
    };

    /** Was this batch of mutations entirely our own doing? */
    const isOurs = (records) =>
      records.every((r) => {
        const t = r.target;
        return (
          strip.el.contains(t) ||
          t === strip.el ||
          (lit?.layer && (lit.layer.contains(t) || t === lit.layer)) ||
          t === lit?.textarea
        );
      });

    let tries = 0;
    const timer = setInterval(() => {
      if (ensure() || ++tries > 150) clearInterval(timer);
    }, 100);

    const root = document.querySelector(`[data-node-id="${node.id}"]`);
    if (root) {
      new MutationObserver((records) => {
        if (!isOurs(records)) ensure();
      }).observe(root, { childList: true, subtree: true });
    } else {
      // No subtree to watch under the canvas renderer: one cheap look every
      // half second is enough to notice the overlay being replaced.
      const recheck = setInterval(() => {
        if (!node.graph) {
          clearInterval(recheck);
          return;
        }
        ensure();
      }, 500);
    }

    node._warppipeGetText = () => getEl()?.value || "";
    node._warppipeSetText = (value) => {
      const el = getEl();
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      commit();
    };
    // The browser hands over a stem; it lands like anything typed would.
    node._warppipeAddLora = (stem) => {
      const el = getEl();
      if (!el) return;
      const value = el.value || "";
      const caret = el.selectionStart ?? value.length;
      const plan = tagInsertion(value, caret, caret, `<lora:${stem}:1.00>`);
      edit(el, plan.from, plan.to, plan.text, plan.caret);
      commit();
    };
    node._warppipeRefresh = commit;
  },
});
