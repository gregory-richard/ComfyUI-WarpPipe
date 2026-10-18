import { app } from "../../scripts/app.js";
import { everything, forget } from "./library.js";
import { connectedBase, connectedModelName, forgetBases, sameBase } from "./model_base.js";
import { escapeAttr, escapeHTML, stemOf } from "./text.js";
import { keepWidgetValuesByName } from "./widget_values.js";

// The prompt box, made legible.
//
// The text is the only state. A highlight layer sits behind a transparent
// textarea so tags, notes and trigger words are coloured while you still type
// into a real textarea (selection, undo, IME all intact).
//
// The prose has a box and the LoRAs have one of their own, a tag to a line,
// where every verb - weight, off, reorder, remove - is an ordinary text edit on
// that line. A second list, switched on, gives model_2 a stack of its own: a
// two-pass sampler runs each pass on its own files at its own weights, and one
// prompt above both says what the picture is. Tags typed into the prose still
// work, because that is how an A1111 prompt arrives.
//
// One strip under the prompt shows whichever tag the caret is in, in whichever
// box - or, with the caret in a trigger word, the LoRA that word belongs to;
// nothing else is stored beside the text.

const NODE_ID = "Warp Lora Prompt";
const TEXT_WIDGET = "text";
const LIST_WIDGET = "loras";
const LIST_2_WIDGET = "loras_2";
const LIST_2_SWITCH = "loras_2_on";

// The prose box first, then the lists. Every one of them is a textarea this
// colours, and the order is the order they are shown in.
const BOX_WIDGETS = [TEXT_WIDGET, LIST_WIDGET, LIST_2_WIDGET];

// A list is a few short lines, not a page: it takes the room it needs between
// these two and the prompt keeps the rest, rather than the two splitting the
// node down the middle. A height set by hand is bounded more loosely - that
// one was asked for.
const LIST_ROWS_MIN = 2;
const LIST_ROWS_MAX = 6;
const LIST_ROWS_HELD_MAX = 30;
const LIST_ROW_H = 16;
const LIST_CHROME = 10;

// A textarea styled the way ComfyUI styles every multiline widget, so a list
// can be measured before its own textarea exists. The constants above were the
// guess this replaced: a row two pixels too tall, which put a loading list at
// the wrong height and had ComfyUI size the node from it.
let standIn = null;
const boxStyle = (el) => {
  if (!el && !standIn?.isConnected) {
    standIn = document.createElement("textarea");
    standIn.className = "comfy-multiline-input";
    standIn.tabIndex = -1;
    standIn.setAttribute("aria-hidden", "true");
    standIn.style.cssText = "position: absolute; left: -9999px; top: 0; visibility: hidden;";
    document.body.appendChild(standIn);
  }
  return getComputedStyle(el ?? standIn);
};

// Heights set by dragging, in rows, by widget name. It lives in the node's
// properties because that is where a view this node keeps belongs: serialised
// with the node, restored with it, and no slot in widgets_values.
const ROWS_PROP = "warppipeListRows";
// What a widget given no room to draw in returns, which is how both renderers
// are told to leave it out: neither honours widget.hidden.
const NO_ROOM = -4;

// The strip is placed by hand rather than added as a widget. A widget of its
// own takes a slot in widgets_values, and those are restored by position: a
// workflow saved before it existed then loads every later value one place out,
// which put the LoRA list into apply_to_clip and lost it. Nothing about the
// saved node changes this way.
const STRIP_H = 24;

// The nodes currently on the canvas. ComfyUI's refresh hook has no node to work
// from, and walking the root graph would miss anything inside a subgraph, so
// each node adds itself here while it lives.
const live = new Set();

const TAG_RE = /<lora:([^:>]+):(-?[0-9]*\.?[0-9]+)([^>]*)>/gi;
const COMMENT_RE = /\/\/[^\n]*/g;
const EMBED_RE = /\bembedding:([^\s,]+)/gi;

const WEIGHT_STEP = 0.1;
const WEIGHT_LIMIT = 4;

const FRIENDLY_LABELS = {
  text: "Prompt",
  loras: "LoRAs",
  loras_2_on: "Model 2",
  loras_2: "LoRAs · model 2",
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
/* Set while the pointer is over a coloured word that has its own title. */
body.wpe-own-tip .p-tooltip { display: none !important; }
.wpe-tag { color: #4ec8e8; }
/* Two different complaints, told apart at a glance: red is a file that is not
   there, orange is a file that is there and is for another base model. The
   second still loads, so it is a warning rather than an error. */
.wpe-tag-unknown { color: #e0705a; text-decoration: underline wavy rgba(224,112,90,0.5); }
.wpe-tag-other { color: #e59440; text-decoration: underline dotted rgba(229,148,64,0.65); }
.wpe-embed { color: #e8b34e; }
.wpe-note { color: #7b7f86; font-style: italic; }
.wpe-trigger { color: #9ad9a4; }
/* A trigger word whose LoRA is not loaded - switched off, at weight 0, or in
   the second list while that is off. Still coloured, because it is still a
   trigger word and the prompt still sends it; muted, because nothing it was
   written for is there to answer it. */
.wpe-trigger-off { color: #6c8f73; }
/* One LoRA and everything that is its: the tag and its trigger words, in every
   box, while the caret is in any of them. A background only - anything that
   took room would move the glyphs off the textarea's. */
.wpe-linked {
  border-radius: 2px;
  background: rgba(255,255,255,0.1);
  background: color-mix(in srgb, currentColor 22%, transparent);
}

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
/* The word the caret is in, when that is what brought the LoRA up. */
.wps-via { flex: 0 1 auto; min-width: 2em; max-width: 9em; color: #9ad9a4;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wps-via.is-off { color: #6c8f73; }
.wps-from { flex: 0 0 auto; opacity: 0.45; }
.wps-state { flex: 0 0 auto; opacity: 0.6; }
.wps-link {
  flex: 0 0 auto; text-decoration: none; color: #4ec8e8; opacity: 0.75;
  font-size: 12px; line-height: 1;
}
.wps-link:hover { opacity: 1; }
.wps-do { cursor: pointer; }
.wps-do:hover { border-color: #4ec8e8; color: #4ec8e8; }
/* The whole line does it, not just the chip. The chip is 15px tall before the
   canvas is scaled, so on a node zoomed out to fit it is a few pixels of
   target - and the words beside it look like part of the same control. */
.wps-offer { cursor: pointer; }
.wps-offer:hover .wps-do { border-color: #4ec8e8; color: #4ec8e8; }

/* A band along the bottom of a list, to set its height by hand. Quiet, since
   the box sizes itself to what it holds and most of the time there is nothing
   to do here - but never invisible. Hidden until hovered, nobody found it: a
   seven-pixel strip with nothing on it is not something anyone points at. */
.wps-grip { position: absolute; left: 0; right: 0; bottom: 0; height: 7px; z-index: 3; cursor: ns-resize; }
.wps-grip::after {
  content: ""; position: absolute; left: 50%; bottom: 2px; width: 28px; height: 2px;
  transform: translateX(-50%); border-radius: 1px; opacity: 0.22;
  background: var(--input-text, #dcdcdc);
}
.wps-grip:hover::after, .wps-grip.is-held::after { opacity: 0.6; }
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

// Shared with the browser, so the index is fetched once rather than per view.
// A failure here leaves tags uncoloured, which is what should happen: the
// prompt is still perfectly editable without knowing what is on disk.
const library = () => everything().catch(() => []);

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

/** Add words to the end of a line - trigger words, where the reader is.
 *
 * In the prompt that is the end of the line the caret was last on, so the words
 * arrive in the prose rather than in a place of their own. After a tag written
 * inline it is that tag's line, which keeps the two together. A space follows a
 * tag or a comma; anything else is a word already there, and gets a comma first.
 */
function wordsInsertion(value, index, words) {
  const { start, end } = lineBounds(value, index);
  const kept = value.slice(start, end).trimEnd();
  const last = kept.slice(-1);
  const joiner = !last ? "" : last === ">" || last === "," ? " " : ", ";
  return { from: start + kept.length, to: end, text: joiner + words };
}

// --- highlighting ----------------------------------------------------------

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** A trigger word as a pattern that finds it only as a whole word.
 *
 * Matched as a bare substring, "red" was a trigger word inside "cluttered" and
 * "art" inside "party". The edge is only drawn where the word has a letter or
 * digit to draw it against, so one that starts or ends in punctuation -
 * "(masterpiece)" - still matches wherever it is written. Letters are any
 * script's: plenty of trigger words are not English.
 */
function wordPattern(word) {
  const body = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = WORD_CHAR.test(word[0]) ? "(?<![\\p{L}\\p{N}_])" : "";
  const after = WORD_CHAR.test(word.at(-1)) ? "(?![\\p{L}\\p{N}_])" : "";
  return new RegExp(before + body + after, "giu");
}

/** Non-overlapping spans, earliest first: a note swallows anything after it.
 *
 * `status` answers for one LoRA name: null when there is nothing to say, or any
 * of a class, a reason and the file it links to when there is. `triggers` are
 * the words to find, each already knowing its class, its reason and the files
 * it belongs to. Deciding any of that here would mean knowing the library, the
 * connected model and every other box; this only needs to be told.
 *
 * `link` is the files a span belongs to, so one LoRA's tag and its words can
 * be picked out together.
 */
function tokenise(text, status, triggers) {
  const spans = [];
  const claim = (span) => {
    if (spans.some((s) => span.start < s.end && s.start < span.end)) return;
    spans.push(span);
  };

  let m;
  COMMENT_RE.lastIndex = 0;
  while ((m = COMMENT_RE.exec(text)) !== null) {
    // A tag switched off is still that LoRA's, so the note it is in links to
    // it: with the caret on one of its words, the line that parks it shows.
    const link = parseTags(m[0])
      .map((t) => status?.(t.name)?.link)
      .filter(Boolean);
    claim({ start: m.index, end: m.index + m[0].length, cls: "wpe-note", link });
  }
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    const flag = status?.(m[1].trim()) || null;
    claim({
      start: m.index,
      end: m.index + m[0].length,
      cls: flag?.cls || "wpe-tag",
      title: flag?.title,
      link: flag?.link ? [flag.link] : [],
    });
  }
  EMBED_RE.lastIndex = 0;
  while ((m = EMBED_RE.exec(text)) !== null) {
    claim({ start: m.index, end: m.index + m[0].length, cls: "wpe-embed" });
  }
  // Longest first, so a phrase is claimed whole rather than by a shorter word
  // inside it that belongs to some other LoRA.
  const words = [...(triggers || [])].sort((a, b) => b.word.length - a.word.length);
  for (const trigger of words) {
    if (trigger.word.length < 3) continue;
    const re = wordPattern(trigger.word);
    while ((m = re.exec(text)) !== null) {
      claim({
        start: m.index,
        end: m.index + m[0].length,
        cls: trigger.cls,
        title: trigger.title,
        link: trigger.link,
        trigger,
      });
    }
  }

  return spans.sort((a, b) => a.start - b.start);
}

/** The trigger word the caret is in or against, as `triggers` described it. */
function triggerAt(text, index, triggers) {
  if (!triggers?.length) return null;
  const span = tokenise(text, null, triggers).find(
    (s) => s.trigger && index >= s.start && index <= s.end
  );
  return span?.trigger ?? null;
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
function highlight(text, status, triggers, ghost, linked) {
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
    const cls = span.link?.some((id) => linked?.has(id)) ? `${span.cls} wpe-linked` : span.cls;
    // Nested, so a suggestion inside a coloured run still reads as a suggestion.
    html += `<span class="${cls}"${title}>${run(span.start, span.end)}</span>`;
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
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "textIndent",
  "textTransform",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "boxSizing",
  "tabSize",
  "textAlign",
];

/** One box's textarea, under either node renderer.
 *
 * With the canvas renderer ComfyUI overlays a plain textarea and hangs it off
 * the widget as inputEl, so the widget says which box is which. With Nodes 2.0
 * the widget is a Vue component with no element on it to ask: the node's own
 * subtree holds one textarea per shown box instead, in the order the widgets
 * are in, so the box is found by counting.
 */
function findTextarea(node, name) {
  const widgets = node.widgets || [];
  const widget = widgets.find((w) => w.name === name);
  if (!widget) return null;

  const overlaid = widget.inputEl ?? widget.element;
  if (overlaid?.tagName === "TEXTAREA" && overlaid.isConnected) return overlaid;

  const root = document.querySelector(`[data-node-id="${node.id}"]`);
  if (!root) return null;
  const shown = widgets.filter((w) => BOX_WIDGETS.includes(w.name) && !w._wpeHidden);
  const nth = shown.indexOf(widget);
  return nth === -1 ? null : (root.querySelectorAll("textarea")[nth] ?? null);
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
  let linked = new Set();

  // Everything is read before anything is written. Reading a size after
  // writing a style lays out the half-written layer, and it used to be laid
  // out with its right padding still missing the scrollbar gutter: a line that
  // only wraps because of the scrollbar then fitted, the layer came out a line
  // short, and the browser clamped its scroll to suit. The timers run this
  // every half second, so a prompt scrolled to the bottom jumped a line and
  // back in time with the caret.
  let seenClientWidth = -1;
  const measure = () => {
    const cs = getComputedStyle(textarea);
    const next = {};
    for (const prop of COPIED_STYLES) next[prop] = cs[prop];
    next.borderStyle = "solid";
    next.borderColor = "transparent";
    // Sizes below are the textarea's border box, so the layer must measure the
    // same way regardless of what the host stylesheet sets.
    next.boxSizing = "border-box";
    next.left = `${textarea.offsetLeft}px`;
    next.top = `${textarea.offsetTop}px`;
    next.width = `${textarea.offsetWidth}px`;
    next.height = `${textarea.offsetHeight}px`;

    // ComfyUI's textarea reserves room for a scrollbar (scrollbar-gutter:
    // stable), so its text is laid out in a narrower box than the layer's.
    // Without matching that, every line wraps in a different place and the
    // colouring slides off the words. Whatever the gutter costs is added to
    // the layer's right padding.
    const borders = parseFloat(cs.borderLeftWidth || "0") + parseFloat(cs.borderRightWidth || "0");
    seenClientWidth = textarea.clientWidth;
    const gutter = Math.max(0, textarea.offsetWidth - seenClientWidth - borders);
    next.paddingRight = `${parseFloat(cs.paddingRight || "0") + gutter}px`;

    // ComfyUI hides the textarea at low zoom; the layer follows it.
    next.display = cs.display === "none" ? "none" : "";

    for (const [prop, value] of Object.entries(next)) {
      if (layer.style[prop] !== value) layer.style[prop] = value;
    }
    // A change of width rewraps the layer, which can clamp its scroll.
    syncScroll();
  };

  const syncScroll = () => {
    if (layer.scrollTop !== textarea.scrollTop) layer.scrollTop = textarea.scrollTop;
    if (layer.scrollLeft !== textarea.scrollLeft) layer.scrollLeft = textarea.scrollLeft;
  };

  // Rewriting innerHTML with identical markup still costs a reflow and can be
  // seen as a flicker, and the timer calls this every second regardless.
  let painted = null;
  const paint = () => {
    const html = highlight(textarea.value || "", status, triggers, ghost, linked);
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
    // A scrollbar coming or going changes the width the text wraps in without
    // changing the box, so that is compared as well.
    const resized =
      layer.offsetWidth !== textarea.offsetWidth ||
      layer.offsetHeight !== textarea.offsetHeight ||
      textarea.clientWidth !== seenClientWidth;
    // Once a second regardless, so a theme change is picked up too - those
    // alter the font without altering the size.
    if (resized || ++tick % 10 === 0) {
      measure();
      paint();
    }
  }, 100);

  // The layer takes no pointer events - the textarea over it has to have them -
  // so a title on one of its spans was never shown, whatever it said. The
  // pointer is checked against the spans instead, and the textarea borrows the
  // title of whichever one it is over, handing back its own when it leaves.
  //
  // Nodes 2.0 puts the widget's own tooltip over the whole box, so the two
  // would stack. Over a word with something particular to say, the box's
  // general one stands aside until the pointer moves off it.
  const ownTitle = textarea.getAttribute("title");
  const showTitle = (tip) => {
    document.body.classList.toggle("wpe-own-tip", tip !== null && tip !== ownTitle);
    if (tip === null) textarea.removeAttribute("title");
    else if (textarea.getAttribute("title") !== tip) textarea.setAttribute("title", tip);
  };
  textarea.addEventListener("mousemove", (e) => {
    let tip = null;
    for (const span of layer.querySelectorAll("[title]")) {
      for (const r of span.getClientRects()) {
        const inside =
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom;
        if (inside) tip = span.getAttribute("title");
      }
    }
    showTitle(tip ?? ownTitle);
  });
  textarea.addEventListener("mouseleave", () => showTitle(ownTitle));

  measure();

  const controls = {
    layer,
    textarea,
    paint,
    measure,
    syncScroll,
    // status(name) -> null, or { cls, title, link } saying what is wrong with
    // it and which file it is; triggers -> [{ word, cls, title, link }].
    setVocabulary: (nextStatus, nextTriggers) => {
      status = nextStatus;
      triggers = nextTriggers;
      paint();
    },
    // The files whose tags and words are picked out, as a Set of ids.
    setLinked: (next) => {
      linked = next;
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
      showTitle(ownTitle);
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
 * own: commenting, moving and deleting a line then mean exactly one LoRA. The
 * same keys work in the prompt, on a tag written inline there.
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

      const other = up ? lineBounds(value, here.start - 1) : lineBounds(value, here.end + 1);
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
 *
 * Trigger words are prose, so they are written into the prompt even when the
 * tag offering them is in a list box. `words` says where that is; the grey text
 * is drawn there too, so the offer is shown where it will land.
 */
function inlineCompletion(textarea, commit, lit, lookup, say, baseOf, words) {
  // { kind: "lora", at, query, matches, index }
  // | { kind: "trigger", at, options, index, to: { textarea, lit } }
  let session = null;
  let run = 0; // so a slow lookup cannot overwrite a newer one

  const here = () => ({ textarea, lit, at: textarea.selectionStart });

  const drop = () => {
    if (!session) return;
    const to = session.to;
    session = null;
    lit?.setGhost(null);
    // The offer may have been drawn on another box, which has a layer of its
    // own to clear.
    if (to && to.lit !== lit) to.lit?.setGhost(null);
  };

  // The suggestion goes at the end of the caret's line, so text after the
  // caret is never pushed out of step with the real textarea underneath.
  const lineEnd = (value, caret) => lineBounds(value, caret).end;

  const draw = () => {
    if (!session) return lit?.setGhost(null);

    if (session.kind === "trigger") {
      const { options, index, to } = session;
      const nth = options.length > 1 ? ` ${index + 1}/${options.length} ↑↓` : "";
      // Drawn from the same plan Tab will write, joiner and all, on whichever
      // box it will be written into.
      const plan = wordsInsertion(to.textarea.value || "", session.at, options[index]);
      to.lit?.setGhost({ at: plan.from, text: plan.text, hint: `${nth} ⇥` });
      return;
    }

    if (!session.matches.length) return lit?.setGhost(null);
    const stem = stemOf(session.matches[session.index].id);
    const q = session.query;
    const shown = stem.toLowerCase().startsWith(q.toLowerCase())
      ? stem.slice(q.length)
      : ` ${stem}`;
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
    // fit is dropped by the filter below: a file with no sidecar declares no
    // base model, and guessing it does not fit would hide a working LoRA - in
    // one real collection 163 of 761 files say nothing about their base.
    //
    // So only two ranks reach here, a match and an unknown, and the unknowns
    // sort last: the first suggestion is always a fit when a fit exists.
    const fit = (e) => (sameBase(e.base_model, base) ? 0 : 1);

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
  const offerTriggers = (offered) => {
    const clean = (offered || []).filter(Boolean);
    if (!clean.length) return;
    const to = words?.() ?? null;
    const target = to?.textarea ? to : here();
    const options = clean.length > 1 ? [clean.join(", "), ...clean] : clean;
    session = {
      kind: "trigger",
      to: target,
      at: lineEnd(target.textarea.value || "", target.at),
      options,
      index: 0,
    };
    draw();
  };

  const accept = () => {
    if (!session) return false;
    const value = textarea.value || "";

    if (session.kind === "trigger") {
      // Where the grey text was: after a tag on its own line, or at the end of
      // the prompt line the reader last left off on.
      const { to } = session;
      const plan = wordsInsertion(
        to.textarea.value || "",
        session.at,
        session.options[session.index]
      );
      const resume = [textarea.selectionStart, textarea.selectionEnd];
      drop();
      edit(to.textarea, plan.from, plan.to, plan.text);
      // Writing into another box takes the focus with it. Typing carries on
      // where it was: the words went to the prompt, the reader did not.
      if (to.textarea !== textarea) {
        textarea.focus();
        textarea.setSelectionRange(resume[0], resume[1]);
      }
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
    for (const word of entry.triggers) {
      const button = document.createElement("button");
      button.type = "button";
      // Dimmed when already written: the point is to see what is missing. As a
      // whole word, the way it is coloured - "red" is not in "cluttered".
      const written = wordPattern(word).test(promptText || "");
      button.className = "wpd-word" + (written ? " is-in" : "");
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
function makeStrip() {
  const el = document.createElement("div");
  el.className = "wps";
  // Pressing on the strip must not take the caret out of the box it describes.
  // The strip clears when that box loses focus, so a press on the name or the
  // thumbnail cleared it while the button was still down, and the click that
  // would have opened the details landed on nothing. Two things take the focus:
  // the browser, moving it to whatever was pressed, and ComfyUI, which blurs
  // every text widget on any mousedown outside it, from a listener on the
  // document - so the press is kept from reaching that as well. The click still
  // happens; only the focus stays where it was.
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  /** Back to an ordinary strip: whatever it shows next is not an offer. */
  const plain = () => {
    el.classList.remove("wps-offer");
    el.onclick = null;
    el.removeAttribute("title");
  };

  const idle = (text) => {
    el.replaceChildren();
    plain();
    const span = document.createElement("span");
    span.className = "wps-idle";
    span.textContent = text;
    el.appendChild(span);
  };

  /** `context` says how the caret got here and what state the LoRA is in:
   *  `word` when it is in one of the LoRA's trigger words rather than its tag,
   *  `off` for why it is not loaded, `pass` for which list it is in when there
   *  are two, and `others` for whoever else declares the same word. */
  const show = (tag, entry, insertWords, openFull, fits, context = {}) => {
    el.replaceChildren();
    plain();

    if (context.word) {
      // The word first: it is what the caret is in, and the rest of the line
      // answers whose it is.
      const via = document.createElement("span");
      via.className = "wps-via" + (context.off ? " is-off" : "");
      via.textContent = context.word;
      el.appendChild(via);
      const from = document.createElement("span");
      from.className = "wps-from";
      from.textContent = "from";
      el.appendChild(from);
    }

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
    // From a trigger word the keys would change the word's emphasis instead.
    weight.title = context.word
      ? "The weight its tag loads it at"
      : "Ctrl+↑ / Ctrl+↓ to change, in steps of 0.1";
    el.appendChild(weight);

    // Plain words after the weight, so the state reads with the number it is
    // about: "0.00 off", "1.00 model 2".
    const note = (text, title) => {
      const span = document.createElement("span");
      span.className = "wps-by wps-state";
      span.textContent = text;
      if (title) span.title = title;
      el.appendChild(span);
    };
    if (context.off) note("off", `Not loaded: ${context.off}`);
    if (context.pass) note(`model ${context.pass}`, `In the list for model ${context.pass}`);
    if (context.others?.length) {
      note(`+${context.others.length}`, `Also a trigger word of ${context.others.join(", ")}`);
    }

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

  /** A tag written into the prose still loads - that is how an A1111 prompt
   *  arrives, and how every workflow saved before the list existed reads. The
   *  list is where it can be seen at a glance, and moving it is a single edit
   *  the reader should get to approve rather than have done to their prompt. */
  const offerMove = (count, move) => {
    el.replaceChildren();
    el.classList.add("wps-offer");
    el.title = "Take the tags out of the prose and put them in the LoRAs box";
    const span = document.createElement("span");
    span.className = "wps-idle";
    span.textContent = `${count} LoRA${count === 1 ? "" : "s"} in the prompt`;
    el.appendChild(span);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wps-chip wps-do";
    button.textContent = "Move into the list";
    el.appendChild(button);
    // On the line rather than on the button, so the words are a target too.
    el.onclick = move;
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
  // ComfyUI calls this when node definitions are reloaded - the r key, or the
  // menu. Every other node's model lists update at that moment; ours did not,
  // because the library is cached in the browser and went on describing the
  // folder as it was when the tab was opened. A LoRA added since then read as
  // red, and completion never offered it.
  async refreshComboInNodes() {
    forget();
    forgetBases();
    await Promise.all([...live].map((node) => node._warppipeRefresh?.()));
  },
  async nodeCreated(node) {
    if (node.comfyClass !== NODE_ID) return;

    for (const widget of node.widgets || []) {
      if (FRIENDLY_LABELS[widget.name]) widget.label = FRIENDLY_LABELS[widget.name];
    }
    if (!(node.widgets || []).some((w) => w.name === TEXT_WIDGET)) return;
    live.add(node);

    const widgetNamed = (name) => (node.widgets || []).find((w) => w.name === name) ?? null;

    /** The text boxes, by widget name: the prose, then the lists.
     *
     * A list is the same thing as the prompt as far as everything here is
     * concerned - a textarea with a layer behind it and the same verbs on it -
     * so each one is wired the same way and told apart only by what it holds.
     */
    const boxes = new Map();
    for (const name of BOX_WIDGETS) {
      const widget = widgetNamed(name);
      // loras_2 is absent when the frontend is newer than the server.
      if (widget) boxes.set(name, { name, widget, el: null, lit: null });
    }
    const prompt = boxes.get(TEXT_WIDGET);
    const list = boxes.get(LIST_WIDGET);
    const list2 = boxes.get(LIST_2_WIDGET);
    const switchWidget = widgetNamed(LIST_2_SWITCH);

    const getEl = () => prompt?.el ?? findTextarea(node, TEXT_WIDGET);
    const strip = makeStrip();

    /** The box the reader is typing in, if it is one of ours. */
    const focusedBox = () => {
      for (const box of boxes.values()) {
        if (box.el && document.activeElement === box.el) return box;
      }
      return null;
    };
    // Where a tag goes when it does not come from typing - the Browse button.
    // The list, unless the reader is writing somewhere else at that moment:
    // a tag lands with the other tags rather than in the middle of a sentence.
    const tagBox = () => focusedBox() ?? list ?? prompt;

    // Trigger words are prose, so they go in the prompt however the offer was
    // made. Where in it is wherever the reader last had the caret - and the
    // end of the text until they have put one there at all.
    let promptCaret = null;
    const wordsTarget = () => {
      if (!prompt?.el) return null;
      const value = prompt.el.value || "";
      const at =
        document.activeElement === prompt.el
          ? prompt.el.selectionStart
          : Math.min(promptCaret ?? value.length, value.length);
      return { textarea: prompt.el, lit: prompt.lit, at };
    };

    /** Put the strip along the bottom of the field the prompt already sits in.
     *
     * The room it needs is a constant. Sizing a panel from the height of the
     * box it lives in - which is what the old list did - feeds back, because
     * the box is sized by its contents: the two then chase each other a pixel
     * at a time, which showed as the prompt jumping and the caret blinking.
     */
    const attachStrip = () => {
      const el = prompt?.el;
      const holder = el?.parentElement;
      if (!holder) return;
      if (strip.el.parentElement !== holder) holder.appendChild(strip.el);
      const want = `${STRIP_H}px`;
      if (el.style.paddingBottom !== want) {
        el.style.paddingBottom = want;
        // The layer copies the textarea's padding, so the text stays aligned.
        prompt.lit?.measure();
        prompt.lit?.paint();
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

    /** What a box holds, shown or not. A hidden box may have no textarea of
     *  its own to ask, and the widget is what serialises either way. */
    const textOf = (box) => (box.el?.isConnected ? box.el.value : box.widget.value) || "";

    /** Why a tag in this box loads nothing, or null when it loads. */
    const whyOff = (box, value, tag) => {
      if (box === list2 && !switchWidget?.value) return "the model 2 list is switched off";
      if (inComment(value, tag.start)) return "switched off with //";
      if (tag.weight === 0) return "its weight is 0";
      return null;
    };

    /** The trigger words in use, each knowing whose it is.
     *
     * A word is a trigger word because a LoRA declares it, and the LoRA is in
     * a list while the word is in the prose - so the words are collected from
     * every box and then given to every box. Each keeps the tags that declare
     * it, so the reader can be told whose it is, and whether any of them is
     * actually loaded: a word is coloured as live while one of its LoRAs is.
     */
    let triggers = [];
    const collectTriggers = () => {
      const on2 = !!switchWidget?.value;
      const found = new Map();
      for (const box of boxes.values()) {
        const value = textOf(box);
        for (const tag of parseTags(value)) {
          const entry = lookup(tag.name);
          if (!entry?.triggers?.length) continue;
          const use = { tag, entry, pass: box === list2 ? 2 : 1, off: whyOff(box, value, tag) };
          for (const word of entry.triggers) {
            const key = word.toLowerCase();
            if (!found.has(key)) found.set(key, { word, uses: [] });
            found.get(key).uses.push(use);
          }
        }
      }
      return [...found.values()].map(({ word, uses }) => {
        // Loaded first, so the strip and the title lead with the LoRA that is
        // actually answering the word.
        uses.sort((a, b) => !!a.off - !!b.off);
        // One name per file, though a file can be in both lists - the same
        // LoRA at 1.00 on the base pass and 0.40 on the turbo one.
        const byFile = new Map();
        for (const use of uses) {
          if (!byFile.has(use.entry.id)) byFile.set(use.entry.id, []);
          byFile.get(use.entry.id).push(use);
        }
        const whose = [...byFile.values()]
          .map((mine) => {
            const name = mine[0].entry.title || mine[0].entry.name;
            const on = mine.filter((u) => !u.off);
            // Where it loads, when there are two places it could; why it
            // does not, when it loads nowhere.
            const said = on.length
              ? on2
                ? on.map((u) => `model ${u.pass}`)
                : []
              : mine.map((u) => (on2 ? `model ${u.pass}: ${u.off}` : u.off));
            const unique = [...new Set(said)];
            return unique.length ? `${name} (${unique.join("; ")})` : name;
          })
          .join(", ");
        const loaded = uses.some((u) => !u.off);
        return {
          word,
          uses,
          cls: loaded ? "wpe-trigger" : "wpe-trigger-off",
          title: `Trigger word of ${whose}`,
          link: [...byFile.keys()],
        };
      });
    };

    const refreshVocabulary = async () => {
      const entries = await library();
      known = indexBy(entries);
      triggers = collectTriggers();
      for (const box of boxes.values()) box.lit?.setVocabulary(tagStatus, triggers);
      await baseOf();
      updateStrip();
    };

    const insertWords = (word) => {
      const to = wordsTarget();
      if (!to) return;
      const plan = wordsInsertion(to.textarea.value || "", to.at, word);
      edit(to.textarea, plan.from, plan.to, plan.text);
      // So a second word from the strip follows the first rather than landing
      // back where the caret was two clicks ago.
      promptCaret = to.textarea.selectionStart;
      commit();
    };

    /** Take the tags out of the prose and put them in the list.
     *
     * Offered rather than done: a tag in the prose loads perfectly well, and
     * rewriting someone's prompt because a newer version prefers a box would
     * be a poor way to repay them for updating. What is left behind is tidied
     * the way the backend tidies it - a line that held only a tag goes, rather
     * than becoming a blank line that was never there.
     */
    const moveIntoList = () => {
      const el = prompt?.el;
      const into = list?.el;
      if (!el || !into) return;
      const value = el.value || "";
      const tags = parseTags(value);
      if (!tags.length) return;

      const kept = [];
      for (const line of value.split("\n")) {
        const bare = line
          .replace(TAG_RE, "")
          .replace(/[ \t]{2,}/g, " ")
          .replace(/[ \t]+([,.])/g, "$1")
          .replace(/,(\s*,)+/g, ",")
          .replace(/[ \t]+$/, "");
        if (line.trim() && !bare.trim()) continue;
        kept.push(bare);
      }

      const here = into.value || "";
      const moved = tags.map((t) => t.raw).join("\n");
      edit(into, here.length, here.length, here && !here.endsWith("\n") ? `\n${moved}` : moved);
      edit(el, 0, value.length, kept.join("\n"));
      // The list is short and the prompt is long, so on a large node the whole
      // change can happen off the part of it you are looking at. It says so.
      // Not "Ctrl+Z puts it back": that is two edits in two boxes, and the
      // browser's undo knows each of them only in the box it happened in.
      say(`${tags.length} tags moved into the list`);
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

    /** Every box that is on screen, so a hidden one counts for nothing. */
    const shownBoxes = () => [...boxes.values()].filter((b) => b.el && !b.widget._wpeHidden);

    /** The LoRAs that will load: every tag in every shown box, notes aside. */
    const countTags = () =>
      shownBoxes().reduce((total, box) => {
        const value = box.el.value || "";
        return total + parseTags(value).filter((t) => !inComment(value, t.start)).length;
      }, 0);

    /** Pick out one LoRA's tag and words in every box, or none for []. */
    let linkedKey = "";
    const linkTo = (ids) => {
      const key = [...ids].sort().join("\n");
      if (key === linkedKey) return;
      linkedKey = key;
      const set = new Set(ids);
      for (const box of boxes.values()) box.lit?.setLinked(set);
    };

    const updateStrip = () => {
      if (!prompt?.el) return;

      // The strip describes what the caret is on, so with the caret gone there
      // is nothing for it to describe: leaving the last tag up made it look
      // like the state of the node rather than the state of the cursor.
      //
      // Asked of the document rather than tracked from focus and blur. A flag
      // is only ever as right as the last event that reached it, and this is
      // repainted from a timer and from every edit as well.
      const box = focusedBox();
      const value = box ? box.el.value || "" : "";
      const caret = box?.el.selectionStart ?? 0;
      const tag = box ? tagAt(value, caret) : null;
      // In a trigger word rather than a tag, the question is whose it is.
      const word = box && !tag ? triggerAt(value, caret, triggers) : null;

      // The tag and its words light up together wherever they are, so either
      // one shows where the other went - a word in the prose, its LoRA two
      // boxes down. Done before the notice below, which only holds the strip.
      const tagEntry = tag ? lookup(tag.name) : null;
      linkTo(tagEntry ? [tagEntry.id] : (word?.link ?? []));

      if (notice && Date.now() < notice.until) return;
      notice = null;

      if (word) {
        const use = word.uses[0];
        const fits =
          use.entry.base_model && baseSeen.base
            ? sameBase(use.entry.base_model, baseSeen.base)
            : null;
        const others = [
          ...new Set(
            word.uses
              .filter((u) => u.entry.id !== use.entry.id)
              .map((u) => u.entry.title || u.entry.name)
          ),
        ];
        strip.show(
          use.tag,
          use.entry,
          insertWords,
          () => openDetails(use.entry, prompt.el?.value || "", insertWords),
          fits,
          {
            word: word.word,
            off: use.off,
            pass: switchWidget?.value ? use.pass : null,
            others,
          }
        );
        return;
      }

      if (!tag) {
        // Tags in the prose of a prompt written before the list existed, with
        // the list still empty: the one moment there is something to offer.
        const stray = parseTags(prompt.el.value || "").length;
        if (stray && list?.el && !parseTags(list.el.value || "").length) {
          return strip.offerMove(stray, moveIntoList);
        }
        const total = countTags();
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
      const fits =
        entry?.base_model && baseSeen.base ? sameBase(entry.base_model, baseSeen.base) : null;
      strip.show(
        tag,
        entry,
        insertWords,
        // What counts as already written is what the model will be sent, which
        // is the prose - a name inside a tag is not the word.
        () => entry && openDetails(entry, prompt.el?.value || "", insertWords),
        fits,
        { off: whyOff(box, value, tag) }
      );
    };

    /** What is wrong with this tag, if anything, and which file it is.
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
          link: entry.id,
        };
      }
      return { link: entry.id };
    };

    // Asked again whenever the wired-in model changes, and not otherwise: the
    // answer is a file read on the server and the checkpoint rarely moves.
    let baseSeen = { name: undefined, base: null };
    const forgetBase = () => {
      baseSeen = { name: undefined, base: null };
    };
    const baseOf = async () => {
      const name = connectedModelName(node);
      if (name === baseSeen.name) return baseSeen.base;
      const base = await connectedBase(node);
      baseSeen = { name, base };
      return base;
    };

    const commit = () => {
      for (const box of boxes.values()) box.lit?.paint();
      // A list is as tall as what it holds, so a line added or taken away
      // changes its height - which is a thing to settle before the repaint.
      sizeBoxes();
      const done = refreshVocabulary();
      node.setDirtyCanvas?.(true, true);
      return done;
    };

    const wire = (box) => {
      const el = box.el;
      box.lit = light(el);
      el.addEventListener("input", commit);
      // The strip follows the caret, which moves for reasons other than typing.
      const moved = () => {
        if (box === prompt) promptCaret = el.selectionStart;
        updateStrip();
      };
      for (const event of ["keyup", "click", "select", "focus"]) {
        el.addEventListener(event, moved);
      }
      el.addEventListener("blur", (e) => {
        // Focus moving into the strip is still work on this tag - its trigger
        // words and its preview are buttons in there, and clearing on the way
        // to one would take it away as it was being clicked. The repaint is
        // deferred so the document has settled on where focus went.
        if (strip.el.contains(e.relatedTarget)) return;
        setTimeout(updateStrip, 0);
      });
      editVerbs(el, commit);
      inlineCompletion(el, commit, box.lit, lookup, say, baseOf, wordsTarget);
      if (box === prompt) attachStrip();
      else attachGrip(box);
      // A new layer knows nothing of what is picked out, so the next pass is
      // made to hand it over rather than finding nothing has changed.
      linkedKey = null;
      commit();
    };

    /** The height of one text row in a box, as laid out. */
    const rowHeight = (box) => {
      const cs = boxStyle(box.el);
      // ComfyUI leaves line-height at "normal", which computes to a word.
      return parseFloat(cs.lineHeight) || Math.round(parseFloat(cs.fontSize) * 1.35) || LIST_ROW_H;
    };

    /** The rows a box was dragged to, if it was, else undefined. */
    const heldRows = (box) => node.properties?.[ROWS_PROP]?.[box.name];

    /** How tall a list wants to be: the lines it holds, within its two limits.
     *
     * The box is asked how much of itself it is hiding rather than the text
     * being measured a second time here - that is what catches a line long
     * enough to wrap, and a foldered LoRA name wraps often in a node no wider
     * than it has to be. Only what overflows adds a row, so an empty list does
     * not grow to fill whatever height it happens to have been given.
     *
     * A height dragged by hand replaces all of that. It was asked for, so it
     * is kept whatever the text does, and the box scrolls like any other.
     */
    const listHeight = (box) => {
      const el = box.el;
      const cs = boxStyle(el);
      const line = rowHeight(box);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const chrome = Number.isFinite(pad) ? pad : LIST_CHROME;
      const held = heldRows(box);
      if (held) {
        box.shownRows = held;
        // Nothing left to learn once the box is there: the rows were asked for.
        box.settled = !!el;
        box.asked = Math.round(held * line + chrome) + 2;
        return box.asked;
      }
      const value = (box.widget.value ?? "") || "";
      // The answer is remembered against the text it was measured for. Letting
      // it fall back once the extra room has made the overflow go away is how
      // a box ends up flickering between two heights, a line at a time.
      if (box.rows?.value !== value) box.rows = { value, count: value.split("\n").length };
      // Only a box that has settled near the height it was last given can say
      // anything useful about what it is hiding. Laid out larger, a box still
      // at the size a multiline widget starts at reports a wall of rows; laid
      // out smaller - a node off screen, or a first pass - it reports the
      // whole text as overflow. Either would be remembered as rows the text
      // does not have.
      const settled =
        box.asked && el?.clientHeight >= box.asked - 2 && el.clientHeight <= box.asked + 2 * line;
      if (settled && el.scrollHeight > el.clientHeight) {
        box.rows.count = Math.min(
          LIST_ROWS_MAX,
          Math.max(box.rows.count, Math.round((el.scrollHeight - chrome) / line))
        );
      }
      // Its wrapped lines are counted in this pass, so the height is final.
      box.settled = !!settled;
      const rows = Math.min(LIST_ROWS_MAX, Math.max(LIST_ROWS_MIN, box.rows.count));
      box.shownRows = rows;
      box.asked = Math.round(rows * line + chrome) + 2;
      return box.asked;
    };

    /** What a list costs the node: its own height and the margins around it. */
    const listSlot = (box) => listHeight(box) + 2 * (box.widget.margin ?? 0);

    /** The rows a list is showing now, dragged or worked out. */
    const rowsNow = (box) => {
      if (!box.shownRows) listHeight(box);
      return heldRows(box) ?? box.shownRows ?? LIST_ROWS_MIN;
    };

    /** Set the rows a list is held at, or clear it back to sizing itself. */
    const holdRows = (box, rows) => {
      const held = { ...(node.properties?.[ROWS_PROP] ?? {}) };
      if (rows === null) delete held[box.name];
      else held[box.name] = Math.min(LIST_ROWS_HELD_MAX, Math.max(1, rows));
      node.properties = { ...(node.properties ?? {}), [ROWS_PROP]: held };
      sizeBoxes();
      node.setDirtyCanvas?.(true, true);
    };

    /** A band along the bottom of a list, dragged to set its height.
     *
     * The rows are counted in canvas pixels rather than screen ones, so a drag
     * moves the edge by as much as the pointer wherever the canvas is zoomed
     * to. A double-click hands the height back to the box.
     *
     * ComfyUI notices a change to the graph on a mouse-up on the canvas or a
     * key, and a drag here is neither - the canvas is kept out of it. Unsaid,
     * a height set by hand was not autosaved, did not mark the workflow as
     * changed and was no step of undo, so a reload quietly lost it. Each drag
     * is bracketed as one change instead.
     */
    const attachGrip = (box) => {
      const holder = box.el?.parentElement;
      if (!holder) return;
      if (!box.grip) {
        const grip = document.createElement("div");
        grip.className = "wps-grip";
        grip.title = "Drag to set the height · double-click to fit the list";
        grip.addEventListener("pointerdown", (e) => {
          // The canvas pans and selects on the same button underneath.
          e.preventDefault();
          e.stopPropagation();
          grip.setPointerCapture(e.pointerId);
          grip.classList.add("is-held");
          app.canvas?.emitBeforeChange?.();
          const line = rowHeight(box) * (app.canvas?.ds?.scale || 1);
          const from = e.clientY;
          const rows = rowsNow(box);
          const drag = (m) => holdRows(box, rows + Math.round((m.clientY - from) / line));
          const done = () => {
            grip.classList.remove("is-held");
            grip.removeEventListener("pointermove", drag);
            grip.removeEventListener("pointerup", done);
            grip.removeEventListener("pointercancel", done);
            app.canvas?.emitAfterChange?.();
          };
          grip.addEventListener("pointermove", drag);
          grip.addEventListener("pointerup", done);
          grip.addEventListener("pointercancel", done);
        });
        grip.addEventListener("dblclick", (e) => {
          e.preventDefault();
          e.stopPropagation();
          app.canvas?.emitBeforeChange?.();
          holdRows(box, null);
          app.canvas?.emitAfterChange?.();
        });
        box.grip = grip;
      }
      if (box.grip.parentElement !== holder) holder.appendChild(box.grip);
    };

    /** Give a widget a fixed height, or no room at all to hide it.
     *
     * Both are asked for twice over: the canvas renderer sizes a widget from
     * computeSize and Nodes 2.0 from computeLayoutSize, and a widget with no
     * height still leaves its element on the page, so that is hidden by hand.
     */
    const room = (widget, height) => {
      const hidden = height === NO_ROOM;
      // The room a widget is given is not the size of its element: ComfyUI
      // takes a margin off each end before it places one, so a box asks for
      // what it wants to be plus what will be taken off it.
      const slot = hidden ? NO_ROOM : height + 2 * (widget.margin ?? 0);
      widget._wpeHidden = hidden;
      widget.computeSize = () => [0, slot];
      widget.computeLayoutSize = () => ({
        minHeight: Math.max(0, slot),
        maxHeight: Math.max(0, slot),
        minWidth: 0,
      });
      const el = widget.inputEl ?? widget.element;
      if (el) el.style.display = hidden ? "none" : "";
    };

    /** Size both lists, and let the node carry whatever they now take.
     *
     * A box that gains a line takes the room from the node rather than from
     * the prompt above it, and gives it back when the line goes - which is
     * also how the second box makes room for itself when it is switched on.
     * What each one last took is remembered so the change can be measured.
     */
    const took = new Map();
    let configured = false;
    const sizeBoxes = () => {
      const on = !!switchWidget?.value;
      for (const box of [list, list2]) {
        if (!box) continue;
        const shown = box !== list2 || on;
        // Measured before it is hidden: a box with no room reports none.
        const want = shown ? listSlot(box) : 0;
        room(box.widget, shown ? want - 2 * (box.widget.margin ?? 0) : NO_ROOM);
        // The grip is a sibling of the textarea, not part of it, so hiding the
        // box does not hide the band along its bottom.
        if (box.grip) box.grip.style.display = shown ? "" : "none";
        // A node loaded from a workflow was saved at the height its lists had
        // settled to. Until a list has settled again - its own textarea there
        // and laid out, its wrapped lines counted - what it takes is noted
        // rather than charged to the node. Charging it grew the node by every
        // wrapped line, or shrank it by a guessed row, on every reload.
        if (box.loading) {
          took.set(box.name, want);
          if (!shown || box.settled) box.loading = false;
          continue;
        }
        const had = took.get(box.name);
        took.set(box.name, want);
        if (had !== undefined && had !== want && node.size) {
          node.setSize?.([node.size[0], Math.max(0, node.size[1] + want - had)]);
        }
      }
    };

    // Widget values are stored by position, and this node reorders its widgets
    // so Browse sits under the prompt - which put every value after the prompt
    // one place out on each save and reload.
    keepWidgetValuesByName(node);

    // The switch answers at once rather than on the next look around - the
    // box, and the colour of every word whose LoRA it just switched on or off.
    if (switchWidget) {
      const priorCallback = switchWidget.callback;
      switchWidget.callback = function (...args) {
        const result = priorCallback?.apply(this, args);
        commit();
        return result;
      };
    }

    // A workflow saved the height that holds its lists as well, so finding
    // them on load is not somebody adding lines or opening the second box: the
    // lists settle into the room the node already has.
    //
    // They are sized here, from the text and heights just restored, rather
    // than on the first look around. ComfyUI works out how small a loading node
    // may be straight after this, and draws it before that look - both from
    // two-line lists, which then jumped to the height they were saved at.
    const priorConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = priorConfigure?.apply(this, args);
      configured = true;
      for (const box of [list, list2]) if (box) box.loading = true;
      sizeBoxes();
      return result;
    };

    // Before the first look around, so neither list is drawn at the full size
    // a multiline widget starts at and then snapped down to a few lines.
    sizeBoxes();

    // A node made from scratch is as tall as ComfyUI worked out its widgets
    // needed, which it did before the lists had a height of their own. It
    // grows by what they take, so the prompt is the size it has always been
    // and the boxes are extra. A node loaded from a workflow is left at the
    // height it was saved with, which is settled by the time this runs.
    setTimeout(() => {
      if (configured || !node.graph || !list) return;
      node.setSize?.([node.size[0], node.size[1] + listSlot(list)]);
    }, 0);

    // The prompt, then the LoRAs it uses, then the second pass, then how to add
    // more and what to apply it to.
    const ORDER = [
      TEXT_WIDGET,
      LIST_WIDGET,
      LIST_2_SWITCH,
      LIST_2_WIDGET,
      "Browse LoRAs",
      "apply_to_clip",
    ];
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
      if (settling) return !!prompt?.el;
      settling = true;
      try {
        reorderWidgets();
        for (const box of boxes.values()) {
          const el = findTextarea(node, box.name);
          if (!el) continue;
          if (el !== box.el) {
            // Nodes 2.0 can replace a textarea at any time; the layer belongs
            // to the one it was made for.
            box.lit?.detach();
            box.el = el;
            wire(box);
          } else {
            box.lit?.measure();
          }
        }
        if (prompt?.el) attachStrip();
        for (const box of [list, list2]) if (box?.el) attachGrip(box);
        sizeBoxes();
        return !!prompt?.el;
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
        if (strip.el.contains(t) || t === strip.el) return true;
        return [...boxes.values()].some(
          (box) =>
            t === box.el ||
            t === box.grip ||
            (box.lit?.layer && (box.lit.layer.contains(t) || t === box.lit.layer))
        );
      });

    // Everything started here has to be stoppable. light() runs a 100ms timer
    // for as long as it is attached, and without this the timer outlived the
    // node: deleting it, or loading another workflow, left one reflowing a
    // layer that was no longer on the page - ten times a second, for the rest
    // of the session, holding the textarea and this whole closure alive.
    const started = [];
    const every = (ms, work) => {
      const id = setInterval(work, ms);
      started.push(() => clearInterval(id));
      return id;
    };

    const teardown = () => {
      live.delete(node);
      for (const stop of started.splice(0)) stop();
      for (const box of boxes.values()) {
        box.lit?.detach();
        box.lit = null;
        box.el = null;
        box.grip?.remove();
        box.grip = null;
      }
      strip.el.remove();
    };

    let tries = 0;
    const timer = every(100, () => {
      if (ensure() || ++tries > 150) clearInterval(timer);
    });

    const root = document.querySelector(`[data-node-id="${node.id}"]`);
    if (root) {
      const observer = new MutationObserver((records) => {
        if (!isOurs(records)) ensure();
      });
      observer.observe(root, { childList: true, subtree: true });
      started.push(() => observer.disconnect());
    } else {
      // No subtree to watch under the canvas renderer: one cheap look every
      // half second is enough to notice the overlay being replaced.
      every(500, () => {
        if (!node.graph) teardown();
        else ensure();
      });
    }

    // Removal is the one moment a node is told it is going away. Both renderers
    // call this, and it fires for a graph being cleared as well as for a delete.
    const priorRemoved = node.onRemoved;
    node.onRemoved = function () {
      teardown();
      return priorRemoved?.apply(this, arguments);
    };

    node._warppipeGetText = () => getEl()?.value || "";
    node._warppipeSetText = (value) => {
      const el = getEl();
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      commit();
    };
    // The browser hands over a stem; it lands like anything typed would, in
    // the box that was last being worked in - the list, until it is not.
    node._warppipeAddLora = (stem) => {
      const el = tagBox()?.el;
      if (!el) return;
      const value = el.value || "";
      const caret = el.selectionStart ?? value.length;
      const plan = tagInsertion(value, caret, caret, `<lora:${stem}:1.00>`);
      edit(el, plan.from, plan.to, plan.text, plan.caret);
      commit();
    };
    // Re-read everything this node has memoised, then repaint. Called by the
    // refresh hook below, where the library on the server has just changed.
    node._warppipeRefresh = () => {
      forgetBase();
      return commit();
    };
  },
});
