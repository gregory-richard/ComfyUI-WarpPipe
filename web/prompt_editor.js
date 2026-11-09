import { app } from "../../scripts/app.js";
import {
  BoxFacade,
  TextSync,
  diffText,
  foldCountLabel,
  foldPlan,
  foldedKeysOf,
  keyBelongsToEditor,
  sameKeys,
  sectionAtLine,
  sectionFoldRange,
} from "./editor_core.js";
import { parseSections } from "./fold.js";

const PLACEHOLDER_GAP = 10;

// A prompt box as a code editor, so //// sections fold while you type.
//
// CodeMirror is laid over ComfyUI's textarea and the textarea stays where it
// was, hidden but still laid out. It remains the truth: every edit is written
// back to it the moment it happens, with the same `input` a keystroke fires, so
// ComfyUI, Vue and everything else go on saving and queueing from it and none
// of them know the difference. A write from any of them comes back the other
// way, through the setter hooked below.
//
// Hidden rather than removed is also what keeps the box's size honest: its
// offsets, its scrollHeight and its padding are still there to be asked.

export const CODE_EDITOR_SETTING = "WarpPipe.CodeEditor";

let cm = null;

const warnFallback = (why, error) =>
  console.warn(`[WarpPipe] Prompt boxes fall back to plain text boxes: ${why}.`, error);

/**
 * Load the bundle, once, before any node exists. It is imported here rather
 * than at the top of a module so that a bundle which will not load costs the
 * boxes their folding and not the whole of the prompt UI.
 */
export async function loadCodeEditor() {
  try {
    cm = await import("./vendor/codemirror.js");
  } catch (error) {
    warnFallback("the CodeMirror bundle did not load", error);
  }
}

function setting(id, otherwise) {
  return (
    app.extensionManager?.setting?.get?.(id) ?? app.ui?.settings?.getSettingValue?.(id) ?? otherwise
  );
}

/** May a box be an editor at all: the setting is on and the bundle loaded. */
export function codeEditorEnabled() {
  return cm !== null && setting(CODE_EDITOR_SETTING, true) !== false;
}

/** How far Ctrl+Up and Ctrl+Down move a weight, as set in ComfyUI. */
export function emphasisStep() {
  return parseFloat(setting("Comfy.EditAttention.Delta", 0.05)) || 0.05;
}

// Everything that decides where a glyph lands, or how the box's edge is drawn.
const COPIED_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "textIndent",
  "textTransform",
  "tabSize",
  "textAlign",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
];
const SCROLLBAR_STYLES = ["scrollbarGutter", "scrollbarWidth", "scrollbarColor"];

// The pieces every editor shares, made once the bundle is there.
let parts = null;
function sharedParts() {
  if (parts) return parts;

  /** On a transaction that is not the reader's doing, so nothing answers it. */
  const External = cm.Annotation.define();
  /** Colours, ghost text or links changed, and only those. */
  const repaint = cm.StateEffect.define();

  /** The grey suggestion: drawn, never typed, and not part of the text. */
  class Ghost extends cm.WidgetType {
    constructor(text, hint) {
      super();
      this.text = text;
      this.hint = hint;
    }
    eq(other) {
      return other.text === this.text && other.hint === this.hint;
    }
    toDOM() {
      const ghost = document.createElement("span");
      ghost.className = "wpe-ghost";
      ghost.textContent = this.text;
      const key = document.createElement("span");
      key.className = "wpe-ghost-key";
      key.textContent = this.hint;
      ghost.appendChild(key);
      return ghost;
    }
  }

  // The box's own look, as ComfyUI sets it: measure() puts the numbers on the
  // host, and the editor only has to stop adding opinions of its own.
  const theme = cm.EditorView.theme({
    "&": { height: "100%", color: "inherit", backgroundColor: "transparent", fontSize: "inherit" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "inherit",
      lineHeight: "inherit",
      overflow: "auto",
      cursor: "text",
    },
    ".cm-content": {
      padding: "var(--wpc-pad-top) var(--wpc-pad-right) var(--wpc-pad-bottom) var(--wpc-pad-left)",
      caretColor: "var(--input-text, #dcdcdc)",
      fontFamily: "inherit",
    },
    ".cm-line": { padding: "0" },
    ".cm-placeholder": { color: "#8a8f98" },
    "& ::selection": { backgroundColor: "rgba(78,200,232,0.28)" },
    // No room at all in a box without sections, so its text sits where it did.
    ".cm-gutters": {
      display: "none",
      backgroundColor: "transparent",
      border: "none",
      color: "#9aa3b0",
    },
    "&.wpc-sections .cm-gutters": { display: "flex" },
    ".cm-foldGutter": { width: "13px" },
    ".cm-foldGutter .cm-gutterElement": { padding: "0", textAlign: "center" },
    ".cm-foldGutter span": { padding: "0", cursor: "pointer" },
    ".cm-foldGutter span:hover": { color: "#4ec8e8" },
    ".cm-foldPlaceholder": {
      background: "none",
      border: "none",
      margin: "0 0 0 0.6em",
      padding: "0",
      color: "#767e8b",
      cursor: "pointer",
    },
    ".cm-foldPlaceholder:hover": { color: "#4ec8e8" },
  });

  // The keys of a textarea and no more. CodeMirror's default set also takes
  // Ctrl+Enter, which queues the prompt here, and a dozen others ComfyUI has
  // uses for. Enter does not indent: this is prose.
  const keys = cm.keymap.of([
    ...cm.standardKeymap.filter((binding) => binding.key !== "Enter"),
    { key: "Enter", run: cm.insertNewline, shift: cm.insertNewline },
    { key: "Mod-z", run: cm.undo, preventDefault: true },
    { key: "Mod-y", run: cm.redo, preventDefault: true },
    { key: "Mod-Shift-z", run: cm.redo, preventDefault: true, stopPropagation: true },
  ]);

  const headLine = cm.Decoration.line({ class: "wpc-head" });

  parts = { External, repaint, Ghost, theme, keys, headLine };
  return parts;
}

// ComfyUI blurs a textarea on any press outside it, which never reaches an
// editor. One listener answers for all of them.
const open = new Set();
let listeningOutside = false;
function blurOnOutsidePress() {
  if (listeningOutside) return;
  listeningOutside = true;
  document.addEventListener("mousedown", (e) => {
    for (const editor of open) {
      // The path, not the target: pressing a tag can re-render the very span pressed.
      if (editor.facade.hasFocus() && !e.composedPath().includes(editor.host)) {
        editor.facade.blur();
      }
    }
  });
}

const VERB_USER_EVENT = "input.verb";

/**
 * Lay an editor over a textarea and return the controls light() returns.
 *
 * `folding` is { keys(), save(keys, undoable) }, and `tokenise(text, status,
 * triggers)` is what colours a box. Throws, having put everything back, if the
 * editor cannot be made: the caller then falls back to the plain box.
 */
export function mountCodeEditor(textarea, holder, folding, tokenise) {
  const { External, repaint, Ghost, theme, keys, headLine } = sharedParts();

  const host = document.createElement("div");
  host.className = "wpc-host";
  const ownTitle = textarea.getAttribute("title");
  if (ownTitle) host.title = ownTitle;

  // --- what the text is ------------------------------------------------------

  // Asked for on every line the gutter draws, and the document object only
  // changes when the text does.
  let parsedDoc = null;
  let parsedSections = [];
  const sectionsOf = (doc) => {
    if (doc !== parsedDoc) {
      parsedDoc = doc;
      parsedSections = parseSections(doc.toString()).sections;
    }
    return parsedSections;
  };

  // --- colouring -------------------------------------------------------------

  let view = null;
  let status = null;
  let triggers = [];
  let linked = new Set();
  let ghost = null;
  let spans = [];
  let marked = { doc: null, status: null, triggers: null };
  let shown = "";

  const isLinked = (span) => span.link?.some((id) => linked.has(id)) ?? false;

  const retokenise = (doc) => {
    spans = tokenise(doc.toString(), status, triggers);
    marked = { doc, status, triggers };
  };

  /** Everything the decorations are made from, to tell when they would differ. */
  const signature = () => {
    let sig = ghost ? `${ghost.at}:${ghost.text}:${ghost.hint}` : "";
    for (const span of spans) {
      sig += `|${span.start}:${span.end}:${span.cls}:${span.title ?? ""}:${isLinked(span) ? 1 : 0}`;
    }
    return sig;
  };

  const markFor = (cls, title) =>
    cm.Decoration.mark({ class: cls, attributes: title ? { title } : undefined });

  const decorationsFor = (doc) => {
    const items = [];
    for (const span of spans) {
      if (span.end <= span.start || span.end > doc.length) continue;
      const cls = isLinked(span) ? `${span.cls} wpe-linked` : span.cls;
      items.push(markFor(cls, span.title).range(span.start, span.end));
    }
    for (const section of sectionsOf(doc)) items.push(headLine.range(section.headerStart));
    if (ghost) {
      const at = Math.max(0, Math.min(doc.length, ghost.at));
      const widget = new Ghost(ghost.text, ghost.hint || "");
      items.push(cm.Decoration.widget({ widget, side: 1 }).range(at));
    }
    return cm.Decoration.set(items, true);
  };

  const marks = cm.ViewPlugin.fromClass(
    class {
      constructor(editor) {
        retokenise(editor.state.doc);
        shown = signature();
        this.decorations = decorationsFor(editor.state.doc);
      }
      update(update) {
        const asked = update.transactions.some((tr) => tr.effects.some((e) => e.is(repaint)));
        if (update.docChanged) retokenise(update.state.doc);
        if (update.docChanged || asked) {
          shown = signature();
          this.decorations = decorationsFor(update.state.doc);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  );

  const requestRepaint = () => {
    // Touching the marks mid-composition can knock an IME out of it. The next
    // change of text or the next paint catches up.
    if (signature() === shown || view.composing) return;
    view.dispatch({ effects: repaint.of(null), annotations: External.of(true) });
  };

  // --- folding ---------------------------------------------------------------

  const foldedNow = (state) => {
    const ranges = [];
    cm.foldedRanges(state).between(0, state.doc.length, (from, to) => {
      ranges.push({ from, to });
    });
    return ranges;
  };

  let savedFolds = "";

  /** Make what is folded on screen match what is saved with the node. */
  const applySavedFolds = () => {
    const saved = folding.keys();
    savedFolds = saved.join("\n");
    const state = view.state;
    const { fold, unfold } = foldPlan(sectionsOf(state.doc), saved, foldedNow(state));
    if (!fold.length && !unfold.length) return;
    view.dispatch({
      effects: [
        ...unfold.map((range) => cm.unfoldEffect.of(range)),
        ...fold.map((range) => cm.foldEffect.of(range)),
      ],
      annotations: External.of(true),
    });
  };

  /** Write what is folded on screen back to the node. */
  const saveFolds = (undoable) => {
    const state = view.state;
    const now = foldedKeysOf(sectionsOf(state.doc), foldedNow(state));
    if (sameKeys(now, folding.keys())) return;
    savedFolds = now.join("\n");
    folding.save(now, undoable);
  };

  // --- the textarea ----------------------------------------------------------

  const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  let facade = null;

  // Removing history and adding it again is how it is emptied.
  const undoable = new cm.Compartment();
  const forgetHistory = () => {
    view.dispatch({ effects: undoable.reconfigure([]), annotations: External.of(true) });
    view.dispatch({ effects: undoable.reconfigure(cm.history()), annotations: External.of(true) });
  };

  /** Show text that came from somewhere else. It is no step of undo. */
  const show = (text) => {
    const change = diffText(view.state.doc.toString(), text);
    if (!change) return;
    const spec = {
      changes: change,
      annotations: [External.of(true), cm.Transaction.addToHistory.of(false)],
    };
    // A value assigned to a textarea leaves its caret at the end, which is
    // where Browse puts a tag into a box nobody has clicked in. A box being
    // typed in keeps the caret where the reader left it.
    if (!facade.hasFocus()) spec.selection = { anchor: text.length };
    view.dispatch(spec);
    // Old steps can no longer be trusted once text they refer to has been
    // replaced - undoing one would drop stale words into the new text - and a
    // textarea forgets its undo in the same moment. Text only added leaves
    // every step meaning what it did.
    if (change.to > change.from) forgetHistory();
    applySavedFolds();
  };

  const sync = new TextSync({
    read: () => native.get.call(textarea),
    write: (text) => native.set.call(textarea, text),
    announce: () => textarea.dispatchEvent(new Event("input", { bubbles: true })),
    show,
  });

  // A folded section keeps saying what it holds as the text changes, and the
  // folded sections of a box line up in one column after the longest header.
  const placeholders = {};
  const refreshPlaceholders = () => {
    view.requestMeasure({
      key: placeholders,
      read: () => {
        const sections = sectionsOf(view.state.doc);
        return [...view.contentDOM.querySelectorAll(".cm-foldPlaceholder")].map((element) => {
          const at = view.posAtDOM(element);
          const section = sections.find((item) => item.headerEnd === at);
          const margin = parseFloat(getComputedStyle(element).marginLeft) || 0;
          return {
            element,
            label: section ? foldCountLabel(section) : null,
            left: element.offsetLeft - margin,
          };
        });
      },
      write: (items) => {
        if (!items.length) return;
        const column = Math.max(...items.map((item) => item.left));
        for (const { element, label, left } of items) {
          if (label && element.textContent !== label) element.textContent = label;
          const margin = `${column - left + PLACEHOLDER_GAP}px`;
          if (element.style.marginLeft !== margin) element.style.marginLeft = margin;
        }
      },
    });
  };

  const onUpdate = (update) => {
    if (
      update.docChanged ||
      update.viewportChanged ||
      update.geometryChanged ||
      cm.foldedRanges(update.startState) !== cm.foldedRanges(update.state)
    ) {
      refreshPlaceholders();
    }
    if (update.transactions.some((tr) => tr.annotation(External))) return;
    if (update.docChanged) sync.fromEditor(update.state.doc.toString());
    if (cm.foldedRanges(update.startState) !== cm.foldedRanges(update.state)) {
      const clicked = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(cm.foldEffect) || e.is(cm.unfoldEffect))
      );
      saveFolds(clicked);
    }
    // What a textarea fires for a selection; a plain caret move has keyup and click.
    if (update.selectionSet && !update.docChanged && !update.state.selection.main.empty) {
      view.contentDOM.dispatchEvent(new Event("select"));
    }
  };

  // --- measuring -------------------------------------------------------------

  let bottomMargin = 0;
  const applied = new Map();
  const readOnly = new cm.Compartment();
  let isReadOnly = textarea.readOnly || textarea.disabled;

  /** Set what differs from what this last set, and say whether anything did. */
  const put = (target, key, value, write) => {
    const id = `${target === host ? "h" : "s"}:${key}`;
    if (applied.get(id) === value) return false;
    applied.set(id, value);
    write();
    return true;
  };

  let gone = false;
  const measure = () => {
    if (gone) return;
    const cs = getComputedStyle(textarea);
    const next = {};
    for (const prop of COPIED_STYLES) next[prop] = cs[prop];
    next.borderStyle = "solid";
    next.borderColor = "transparent";
    next.boxSizing = "border-box";
    next.left = `${textarea.offsetLeft}px`;
    next.top = `${textarea.offsetTop}px`;
    next.width = `${textarea.offsetWidth}px`;
    next.height = `${textarea.offsetHeight}px`;
    next.display = cs.display === "none" ? "none" : "";

    let changed = false;
    for (const [prop, value] of Object.entries(next)) {
      changed = put(host, prop, value, () => (host.style[prop] = value)) || changed;
    }
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      const name = `--wpc-pad-${side.toLowerCase()}`;
      const value = cs[`padding${side}`];
      changed = put(host, name, value, () => host.style.setProperty(name, value)) || changed;
    }
    for (const prop of SCROLLBAR_STYLES) {
      changed =
        put(view.scrollDOM, prop, cs[prop], () => (view.scrollDOM.style[prop] = cs[prop])) ||
        changed;
    }
    bottomMargin = parseFloat(cs.paddingBottom) || 0;
    // Nodes 2.0 shows a box's scrollbar only while it is hovered or focused.
    host.classList.toggle("is-quiet", cs.overflowY === "hidden");

    const locked = textarea.readOnly || textarea.disabled;
    if (locked !== isReadOnly) {
      isReadOnly = locked;
      view.dispatch({
        effects: readOnly.reconfigure(cm.EditorState.readOnly.of(locked)),
        annotations: External.of(true),
      });
    }
    if (changed) view.requestMeasure();
  };

  const paint = () => {
    if (gone) return;
    if (folding.keys().join("\n") !== savedFolds) applySavedFolds();
    const doc = view.state.doc;
    if (marked.doc !== doc || marked.status !== status || marked.triggers !== triggers) {
      retokenise(doc);
    }
    requestRepaint();
  };

  // --- building it -----------------------------------------------------------

  const initial = native.get.call(textarea);
  const start = Math.min(textarea.selectionStart ?? initial.length, initial.length);
  const end = Math.min(textarea.selectionEnd ?? initial.length, initial.length);

  const extensions = [
    undoable.of(cm.history()),
    readOnly.of(cm.EditorState.readOnly.of(isReadOnly)),
    cm.EditorView.lineWrapping,
    cm.EditorState.tabSize.of(parseInt(getComputedStyle(textarea).tabSize, 10) || 8),
    cm.EditorView.contentAttributes.of({ spellcheck: textarea.spellcheck ? "true" : "false" }),
    cm.EditorView.editorAttributes.of((editor) =>
      sectionsOf(editor.state.doc).length ? { class: "wpc-sections" } : null
    ),
    cm.EditorView.scrollMargins.of(() => ({ bottom: bottomMargin })),
    cm.EditorState.phrases.of({ "Fold line": "Fold", "Unfold line": "Unfold" }),
    keys,
    theme,
    marks,
    cm.codeFolding({
      preparePlaceholder: (state, range) => {
        const section = sectionsOf(state.doc).find((item) => item.headerEnd === range.from);
        return section ? foldCountLabel(section) : "···";
      },
      placeholderDOM: (_view, onclick, label) => {
        const dots = document.createElement("span");
        dots.className = "cm-foldPlaceholder";
        dots.textContent = label;
        dots.title = "Unfold";
        dots.onclick = onclick;
        return dots;
      },
    }),
    cm.foldGutter({ openText: "▾", closedText: "▸" }),
    cm.foldService.of((state, lineStart) =>
      sectionFoldRange(sectionAtLine(sectionsOf(state.doc), lineStart))
    ),
    // A caret left inside a section as it folds would be typing into nothing.
    cm.EditorState.transactionFilter.of((tr) => {
      if (tr.annotation(External)) return tr;
      const head = tr.newSelection.main.head;
      for (const effect of tr.effects) {
        if (effect.is(cm.foldEffect) && head > effect.value.from && head <= effect.value.to) {
          return [tr, { selection: { anchor: effect.value.from }, sequential: true }];
        }
      }
      return tr;
    }),
    // A file dropped here is ComfyUI's to open. The editor would read it as text.
    cm.Prec.highest(
      cm.EditorView.domEventHandlers({ drop: (e) => (e.dataTransfer?.files?.length ?? 0) > 0 })
    ),
    cm.EditorView.updateListener.of(onUpdate),
  ];
  if (textarea.placeholder) extensions.push(cm.placeholder(textarea.placeholder));

  holder.insertBefore(host, textarea);
  try {
    view = new cm.EditorView({
      state: cm.EditorState.create({
        doc: initial,
        selection: { anchor: start, head: Math.max(start, end) },
        extensions,
      }),
      parent: host,
    });
    facade = new BoxFacade({
      view,
      textarea,
      verb: {
        annotations: [cm.isolateHistory.of("full"), cm.Transaction.userEvent.of(VERB_USER_EVENT)],
      },
    });
    measure();
    applySavedFolds();
  } catch (error) {
    view?.destroy();
    host.remove();
    throw error;
  }

  // Everything that writes the textarea writes through here, and a write that
  // changes nothing stops at TextSync. That covers a workflow loading, a graph
  // undo, the Prompt Writer and Vue re-rendering, none of which fire an event.
  Object.defineProperty(textarea, "value", {
    configurable: true,
    enumerable: true,
    get: () => native.get.call(textarea),
    set: (text) => {
      native.set.call(textarea, text);
      sync.fromTextarea();
    },
  });
  const ownTabIndex = textarea.getAttribute("tabindex");
  textarea.setAttribute("tabindex", "-1");
  textarea.classList.add("wpe-src");

  // --- what the textarea used to catch ---------------------------------------

  const content = view.contentDOM;
  const listening = new AbortController();
  const { signal } = listening;

  // ComfyUI selects a node from its textarea's focus and click.
  content.addEventListener("focus", () => textarea.dispatchEvent(new Event("focus")));
  content.addEventListener("click", () => textarea.dispatchEvent(new MouseEvent("click")));

  // Keys a text field keeps, kept from ComfyUI; see keyBelongsToEditor.
  const keepKey = (e) => {
    if (keyBelongsToEditor(e)) e.stopPropagation();
  };
  for (const type of ["keydown", "keypress", "keyup"]) host.addEventListener(type, keepKey);
  // A paste the page also took for itself would add nodes to the canvas.
  for (const type of ["copy", "cut", "paste"]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  const onClassic = () => !!host.closest(".dom-widget");

  // A click on an arrow is not a click into the text.
  host.addEventListener("mousedown", (e) => {
    if (e.target.closest?.(".cm-gutters")) e.preventDefault();
  });

  // The node would take a press for a drag and the canvas for a pan. The middle
  // button is the exception, handed on as ComfyUI's own textarea hands it on.
  const pointerHandlers = {
    pointerdown: "processMouseDown",
    pointermove: "processMouseMove",
    pointerup: "processMouseUp",
  };
  for (const [type, handler] of Object.entries(pointerHandlers)) {
    host.addEventListener(type, (e) => {
      const middle = type === "pointermove" ? (e.buttons & 4) !== 0 : e.button === 1;
      if (middle && onClassic()) app.canvas?.[handler]?.(e);
      else e.stopPropagation();
    });
  }
  host.addEventListener("dblclick", (e) => e.stopPropagation());

  // Nodes 2.0 keeps a right-click on a box being typed in for the browser's
  // menu and gives the node's menu otherwise.
  host.addEventListener("contextmenu", (e) => {
    if (onClassic() || facade.hasFocus()) e.stopPropagation();
    else e.preventDefault();
  });

  // The same choices ComfyUI's own textarea makes. Nodes 2.0 only needs telling
  // when to keep it: anything let through bubbles to the node, which decides.
  host.addEventListener(
    "wheel",
    (e) => {
      const classic = onClassic();
      const trackpad =
        classic &&
        setting("LiteGraph.Pointer.TrackpadGestures", false) &&
        (Math.abs(e.deltaX) > 0 || Math.abs(e.deltaY) < 50);
      const forCanvas =
        e.ctrlKey || e.metaKey || trackpad || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const scroller = view.scrollDOM;
      if (!forCanvas && scroller.scrollHeight > scroller.clientHeight) {
        e.stopPropagation();
        return;
      }
      if (classic) {
        e.preventDefault();
        e.stopPropagation();
        app.canvas?.processMouseWheel?.(e);
      }
    },
    { passive: false }
  );

  // Nodes 2.0 puts the widget's own tooltip over the whole box. Over a word with
  // something particular to say, that one stands aside.
  host.addEventListener("mousemove", (e) => {
    const titled = e.target.closest?.(".cm-content [title]");
    document.body.classList.toggle("wpe-own-tip", !!titled);
  });
  host.addEventListener("mouseleave", () => document.body.classList.remove("wpe-own-tip"));

  // --- staying in step -------------------------------------------------------

  const detach = () => {
    if (gone) return;
    gone = true;
    clearInterval(ticker);
    listening.abort();
    open.delete(entry);
    view.destroy();
    host.remove();
    // Back to the prototype's own accessor; the text is already in the textarea.
    delete textarea.value;
    if (ownTabIndex === null) textarea.removeAttribute("tabindex");
    else textarea.setAttribute("tabindex", ownTabIndex);
    textarea.classList.remove("wpe-src");
    document.body.classList.remove("wpe-own-tip");
    delete textarea._wpeControls;
  };

  // The timer the plain box has always run, doing less. The setter above sees
  // writes as they happen; this is the net under it, and how a box notices a
  // resize, a textarea that has gone, or the canvas being zoomed - nothing tells
  // the editor about a transform, and a stale scale puts clicks on the wrong
  // character.
  let tick = 0;
  let seenScale = 0;
  const ticker = setInterval(() => {
    if (!textarea.isConnected) {
      detach();
      return;
    }
    sync.fromTextarea();
    const resized =
      host.offsetWidth !== textarea.offsetWidth || host.offsetHeight !== textarea.offsetHeight;
    if (resized || ++tick % 10 === 0) {
      measure();
      paint();
    }
    if (textarea.offsetWidth) {
      const scale = textarea.getBoundingClientRect().width / textarea.offsetWidth;
      if (Math.abs(scale - seenScale) > 0.001) {
        seenScale = scale;
        view.requestMeasure();
      }
    }
  }, 100);

  const entry = { facade, host };
  open.add(entry);
  blurOnOutsidePress();

  return {
    layer: host,
    view: host,
    textarea,
    input: facade,
    signal,
    get detached() {
      return gone;
    },
    paint,
    measure,
    syncScroll: () => {},
    setVocabulary: (nextStatus, nextTriggers) => {
      status = nextStatus;
      triggers = nextTriggers;
      paint();
    },
    setLinked: (next) => {
      linked = next;
      if (!gone) requestRepaint();
    },
    setGhost: (next) => {
      ghost = next;
      if (!gone) requestRepaint();
    },
    detach,
  };
}
