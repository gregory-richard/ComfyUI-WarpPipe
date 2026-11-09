// The parts of the prompt's code editor that need no page and no CodeMirror.
//
// The textarea stays the truth ComfyUI saves and queues from; the editor is a
// view of it that can be typed in. Everything that decides how the two agree,
// what a key means and which section is which lives here, where it can be
// tested. The DOM side is prompt_editor.js.

// --- the textarea and the editor --------------------------------------------

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The one replacement that turns `before` into `after`, as small as the text
 * allows: { from, to, insert }, or null when the two are the same. Never cuts a
 * surrogate pair in half, so an emoji is replaced whole.
 */
export function diffText(before, after) {
  if (before === after) return null;
  const shortest = Math.min(before.length, after.length);
  let head = 0;
  while (head < shortest && before.charCodeAt(head) === after.charCodeAt(head)) head++;
  if (head > 0 && isHighSurrogate(before.charCodeAt(head - 1))) head--;

  let tail = 0;
  while (
    tail < shortest - head &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail++;
  }
  if (tail > 0 && isLowSurrogate(before.charCodeAt(before.length - tail))) tail--;

  return { from: head, to: before.length - tail, insert: after.slice(head, after.length - tail) };
}

/**
 * The changes that turn `before` into `after`, placed at `offset`. Line by line
 * when the lines still match up, so one edit of many lines is many small changes
 * and a fold between them survives; a single replacement across it would end it.
 */
export function lineChanges(before, after, offset = 0) {
  const place = (change, at) => ({ ...change, from: at + change.from, to: at + change.to });
  const old = before.split("\n");
  const next = after.split("\n");
  if (old.length !== next.length) {
    const change = diffText(before, after);
    return change ? [place(change, offset)] : [];
  }
  const changes = [];
  let at = offset;
  old.forEach((line, i) => {
    const change = diffText(line, next[i]);
    if (change) changes.push(place(change, at));
    at += line.length + 1;
  });
  return changes;
}

/**
 * Keeps the textarea and the editor saying the same thing, without either one
 * setting the other off.
 *
 * `read` and `write` are the textarea's value, `announce` tells the page about
 * a write the way typing would, and `show` puts text into the editor. `last` is
 * the text both are known to hold, so a call that changes nothing does nothing.
 */
export class TextSync {
  constructor({ read, write, announce, show }) {
    Object.assign(this, { read, write, announce, show });
    this.last = read();
    this.writing = 0;
  }

  /** The editor changed: write the textarea, as if this had been typed there. */
  fromEditor(text) {
    if (text === this.last) return;
    this.last = text;
    this.writing++;
    try {
      this.write(text);
      this.announce();
    } finally {
      this.writing--;
    }
    // A listener answering `input` may have written something else back.
    this.fromTextarea();
  }

  /** The textarea may have been written by someone else: show what it says. */
  fromTextarea() {
    if (this.writing) return;
    const now = this.read();
    if (now === this.last) return;
    this.last = now;
    this.show(now);
  }
}

/**
 * The textarea's own interface, on top of the editor that hides it.
 *
 * The verbs, the completion and the strip were written against a textarea and
 * this is what lets them stay that way. Text and layout are still the real
 * textarea's, because it is still there and laid out; the caret, the focus and
 * the keys are the editor's.
 *
 * `view` is the CodeMirror view and `verb` is what every edit made through
 * replaceRange carries, which is what makes it one step of undo.
 */
export class BoxFacade {
  constructor({ view, textarea, verb }) {
    this.view = view;
    this.textarea = textarea;
    this.verb = verb;
    this.tagName = "TEXTAREA";
  }

  get value() {
    return this.textarea.value;
  }
  set value(text) {
    this.textarea.value = text;
  }

  get selectionStart() {
    return this.view.state.selection.main.from;
  }
  get selectionEnd() {
    return this.view.state.selection.main.to;
  }

  setSelectionRange(start, end = start) {
    const length = this.view.state.doc.length;
    const anchor = Math.max(0, Math.min(start, length));
    const head = Math.max(anchor, Math.min(end, length));
    this.view.dispatch({ selection: { anchor, head } });
  }

  /** One edit, one step of undo, the caret left at `caret`. */
  replaceRange(from, to, text, caret = from + text.length) {
    this.view.dispatch({
      ...this.verb,
      changes: lineChanges(this.view.state.sliceDoc(from, to), text, from),
      selection: { anchor: caret },
      scrollIntoView: true,
    });
  }

  focus() {
    this.view.focus();
  }
  blur() {
    this.view.contentDOM.blur();
  }
  /** As asking the document whose focus it is: a blurred window keeps it. */
  hasFocus() {
    return this.view.contentDOM.ownerDocument?.activeElement === this.view.contentDOM;
  }

  /** The element each event is really heard on. */
  #targetOf(type) {
    if (type === "input") return this.textarea;
    if (type === "scroll") return this.view.scrollDOM;
    return this.view.contentDOM;
  }

  // keydown is heard in the capture phase. The editor listens on the same
  // element and would otherwise act on the key first, and everything added
  // here has to be able to say that a key is already spoken for.
  addEventListener(type, listener, options) {
    const opts = type === "keydown" ? { ...options, capture: true } : options;
    this.#targetOf(type).addEventListener(type, listener, opts);
  }
  removeEventListener(type, listener, options) {
    const opts = type === "keydown" ? { ...options, capture: true } : options;
    this.#targetOf(type).removeEventListener(type, listener, opts);
  }
  dispatchEvent(event) {
    return this.textarea.dispatchEvent(event);
  }

  get scrollTop() {
    return this.view.scrollDOM.scrollTop;
  }
  set scrollTop(top) {
    this.view.scrollDOM.scrollTop = top;
  }
  get scrollLeft() {
    return this.view.scrollDOM.scrollLeft;
  }
  set scrollLeft(left) {
    this.view.scrollDOM.scrollLeft = left;
  }

  /** The height the visible text wants, folded sections taking none. */
  get contentHeight() {
    return this.view.contentHeight / (this.view.scaleY || 1);
  }

  // Where the box is and how big it is were never the editor's to say.
  get parentElement() {
    return this.textarea.parentElement;
  }
  get isConnected() {
    return this.textarea.isConnected;
  }
  get style() {
    return this.textarea.style;
  }
  get clientHeight() {
    return this.textarea.clientHeight;
  }
  get clientWidth() {
    return this.textarea.clientWidth;
  }
  get scrollHeight() {
    return this.textarea.scrollHeight;
  }
  get offsetHeight() {
    return this.textarea.offsetHeight;
  }
  get offsetWidth() {
    return this.textarea.offsetWidth;
  }
  get offsetTop() {
    return this.textarea.offsetTop;
  }
  get offsetLeft() {
    return this.textarea.offsetLeft;
  }
}

// --- keys --------------------------------------------------------------------

// What ComfyUI leaves to a text field, beyond any key without Ctrl or Alt.
const TEXT_FIELD_CHORDS = new Set([
  "a",
  "c",
  "v",
  "x",
  "z",
  "y",
  "p",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "ArrowLeft",
  "ArrowRight",
]);
const SELECTING_CHORDS = new Set(["Home", "End", "ArrowLeft", "ArrowRight"]);
const MODIFIERS = new Set(["Control", "Meta", "Alt", "Shift"]);

/**
 * Should this key stop at the editor?
 *
 * ComfyUI decides by asking whether the key came from a text field, and not all
 * of its listeners count an editable div as one. So the keys a text field keeps
 * are kept from them here. Ctrl+Enter, Ctrl+S and the like are not in that list
 * and go on to ComfyUI, and so does Escape, which is never the editor's.
 */
export function keyBelongsToEditor({ key, ctrlKey, metaKey, altKey, shiftKey }) {
  if (MODIFIERS.has(key) || key === "Escape") return false;
  const ctrl = ctrlKey || metaKey;
  if (!ctrl && !altKey) return true;
  if (!ctrl || altKey) return false;
  const name = key.length === 1 ? key.toLowerCase() : key;
  return shiftKey ? SELECTING_CHORDS.has(name) : TEXT_FIELD_CHORDS.has(name);
}

// --- emphasis ----------------------------------------------------------------

const WORD_EDGES = " .,\\/!?%^*;:{}=-_`~()\r\n\t";
const NUMBER = "[+-]?(?:\\d*\\.)?\\d+(?:[eE][+-]?\\d+)?";
const BRACKETED = /^\((.*)\)$/;
const ENDS_WITH_WEIGHT = new RegExp(`:${NUMBER}$`);
// "(at 10:30)" is a time, not the word "at 10" at weight 30.
const ENDS_WITH_TIME = /(?:^|\s)\d{1,2}:\d{2}$/;
const WEIGHTED = new RegExp(`\\((.*):(${NUMBER})\\)`);

/** What is inside the innermost brackets around `at`, or null if nothing is. */
function bracketsAround(value, at) {
  let open = at;
  if (value[at] !== "(") {
    let closed = 0;
    for (open = at - 1; open >= 0; open--) {
      if (value[open] === ")") closed++;
      else if (value[open] === "(") {
        if (closed === 0) break;
        closed--;
      }
    }
    if (open < 0) return null;
  }
  let depth = 0;
  for (let close = value[at] === "(" ? at + 1 : at; close < value.length; close++) {
    if (value[close] === "(") depth++;
    else if (value[close] === ")") {
      if (depth === 0) return { start: open + 1, end: close };
      depth--;
    }
  }
  return null;
}

/**
 * What Ctrl+Up and Ctrl+Down do to (word:1.1), as ComfyUI does it in a textarea.
 *
 * ComfyUI's handler only answers a real textarea with the focus, so it cannot be
 * handed this. `delta` is the signed step. With nothing selected it acts on the
 * brackets around the caret, or else the word at the caret; a weight that lands
 * on exactly 1 loses its brackets. Returns { from, to, text }, or null when
 * there is nothing to act on.
 */
export function nudgeEmphasis(value, selectionStart, selectionEnd, delta) {
  let from = selectionStart;
  let to = selectionEnd;
  if (from === to) {
    const inside = bracketsAround(value, from);
    if (inside) {
      from = inside.start;
      to = inside.end;
    } else {
      while (from > 0 && !WORD_EDGES.includes(value[from - 1])) from--;
      while (to < value.length && !WORD_EDGES.includes(value[to])) to++;
      if (from === to) return null;
    }
  }

  let text = value.slice(from, to);
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    to--;
  }
  if (value[from - 1] === "(" && value[to] === ")") {
    from--;
    to++;
    text = value.slice(from, to);
  }
  if (text[0] !== "(" || text.at(-1) !== ")") text = `(${text})`;

  const inner = BRACKETED.exec(text)?.[1];
  if (inner !== undefined && (ENDS_WITH_TIME.test(inner) || !ENDS_WITH_WEIGHT.test(inner))) {
    text = `(${inner}:1.0)`;
  }

  const written = text.replace(WEIGHTED, (_, body, weight) => {
    const next = Number((parseFloat(weight) + delta).toFixed(10));
    return next === 1 ? body : `(${body}:${next})`;
  });
  return { from, to, text: written };
}

// --- folding -----------------------------------------------------------------

/** The section headed by the line starting at this offset, if there is one. */
export function sectionAtLine(sections, lineStart) {
  return sections.find((section) => section.headerStart === lineStart) ?? null;
}

/** What folding a section hides: from the end of its header to the end of its
 *  body. Null when it holds nothing to hide. */
export function sectionFoldRange(section) {
  if (!section || section.lineCount === 0) return null;
  return { from: section.headerEnd, to: section.bodyEnd };
}

/** The keys of the sections these folded ranges belong to, in text order. */
export function foldedKeysOf(sections, ranges) {
  const folded = new Set(ranges.map((range) => range.from));
  return sections.filter((section) => folded.has(section.headerEnd)).map((section) => section.key);
}

/**
 * What has to change for exactly the sections in `keys` to be folded, given the
 * ranges folded now: { fold, unfold }, each a list of { from, to }.
 */
export function foldPlan(sections, keys, ranges) {
  const saved = new Set(keys);
  const wanted = new Map();
  for (const section of sections) {
    const range = saved.has(section.key) ? sectionFoldRange(section) : null;
    if (range) wanted.set(range.from, range);
  }
  const current = new Map(ranges.map((range) => [range.from, range]));
  return {
    fold: [...wanted.values()].filter((range) => current.get(range.from)?.to !== range.to),
    unfold: ranges.filter((range) => wanted.get(range.from)?.to !== range.to),
  };
}

export function sameKeys(a, b) {
  return a.length === b.length && new Set([...a, ...b]).size === new Set(a).size;
}
