import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BoxFacade,
  TextSync,
  diffText,
  foldCountLabel,
  foldPlan,
  foldedKeysOf,
  keyBelongsToEditor,
  nudgeEmphasis,
  sameKeys,
  sectionAtLine,
  sectionFoldRange,
} from "../../web/editor_core.js";
import { parseSections } from "../../web/fold.js";
import {
  EditorState,
  Transaction,
  history,
  isolateHistory,
  redo,
  undo,
} from "../../web/vendor/codemirror.js";

// --- diffText ----------------------------------------------------------------

const applyDiff = (before, { from, to, insert }) =>
  before.slice(0, from) + insert + before.slice(to);

test("diffText: the same text needs no change", () => {
  assert.equal(diffText("abc", "abc"), null);
  assert.equal(diffText("", ""), null);
});

test("diffText: finds the smallest insertion, deletion and replacement", () => {
  assert.deepEqual(diffText("ab", "aXb"), { from: 1, to: 1, insert: "X" });
  assert.deepEqual(diffText("aXb", "ab"), { from: 1, to: 2, insert: "" });
  assert.deepEqual(diffText("a cat b", "a dog b"), { from: 2, to: 5, insert: "dog" });
  assert.deepEqual(diffText("", "new"), { from: 0, to: 0, insert: "new" });
  assert.deepEqual(diffText("old", ""), { from: 0, to: 3, insert: "" });
});

test("diffText: repeats do not make the head and tail overlap", () => {
  for (const [before, after] of [
    ["aaa", "aa"],
    ["aa", "aaa"],
    ["abab", "ab"],
    ["x\nx\nx", "x\nx"],
  ]) {
    assert.equal(applyDiff(before, diffText(before, after)), after);
  }
});

test("diffText: never cuts an emoji in half", () => {
  const change = diffText("a😀b", "a😁b");
  assert.deepEqual(change, { from: 1, to: 3, insert: "😁" });
});

// --- TextSync ----------------------------------------------------------------

function syncRig(initial = "") {
  const rig = { value: initial, writes: 0, announced: 0, shown: [], onAnnounce: null };
  rig.sync = new TextSync({
    read: () => rig.value,
    write: (text) => {
      rig.writes++;
      rig.value = text;
    },
    announce: () => {
      rig.announced++;
      rig.onAnnounce?.();
    },
    show: (text) => rig.shown.push(text),
  });
  return rig;
}

test("TextSync: an editor change writes the textarea once and announces it", () => {
  const rig = syncRig("a");
  rig.sync.fromEditor("ab");
  assert.equal(rig.value, "ab");
  assert.equal(rig.writes, 1);
  assert.equal(rig.announced, 1);
  assert.deepEqual(rig.shown, []);
});

test("TextSync: nothing happens when nothing changed", () => {
  const rig = syncRig("a");
  rig.sync.fromEditor("a");
  rig.sync.fromTextarea();
  assert.equal(rig.writes, 0);
  assert.equal(rig.announced, 0);
  assert.deepEqual(rig.shown, []);
});

test("TextSync: a change from outside reaches the editor once, and is not written back", () => {
  const rig = syncRig("a");
  rig.value = "loaded";
  rig.sync.fromTextarea();
  rig.sync.fromTextarea();
  assert.deepEqual(rig.shown, ["loaded"]);
  assert.equal(rig.writes, 0);
  assert.equal(rig.announced, 0);
  // The editor echoing the text it was just shown is not a new edit.
  rig.sync.fromEditor("loaded");
  assert.equal(rig.writes, 0);
});

test("TextSync: a listener reading the box back causes no loop", () => {
  const rig = syncRig("");
  // What ComfyUI's multiline widget does on input: widget.value = textarea.value.
  rig.onAnnounce = () => {
    rig.value = rig.value;
    rig.sync.fromTextarea();
  };
  rig.sync.fromEditor("typed");
  assert.equal(rig.writes, 1);
  assert.equal(rig.announced, 1);
  assert.deepEqual(rig.shown, []);
});

test("TextSync: a listener changing the text wins, and the editor shows it", () => {
  const rig = syncRig("");
  rig.onAnnounce = () => {
    rig.value = "CLEANED";
    rig.sync.fromTextarea();
  };
  rig.sync.fromEditor("typed");
  assert.deepEqual(rig.shown, ["CLEANED"]);
  assert.equal(rig.value, "CLEANED");
});

test("TextSync: a failing listener does not leave the guard up", () => {
  const rig = syncRig("");
  rig.onAnnounce = () => {
    throw new Error("listener failed");
  };
  assert.throws(() => rig.sync.fromEditor("typed"));
  rig.onAnnounce = null;
  rig.value = "after";
  rig.sync.fromTextarea();
  assert.deepEqual(rig.shown, ["after"]);
});

// --- BoxFacade ---------------------------------------------------------------

function facadeRig(doc = "hello world") {
  const view = {
    state: EditorState.create({ doc, extensions: [history()] }),
    dispatch(...specs) {
      const tr = this.state.update(...specs);
      this.state = tr.state;
    },
    focused: 0,
    focus() {
      this.focused++;
    },
    contentDOM: new EventTarget(),
    scrollDOM: Object.assign(new EventTarget(), { scrollTop: 0, scrollLeft: 0 }),
    contentHeight: 90,
    scaleY: 1.5,
  };
  const textarea = Object.assign(new EventTarget(), {
    value: doc,
    parentElement: { id: "holder" },
    isConnected: true,
    style: { id: "style" },
    clientHeight: 11,
    clientWidth: 12,
    scrollHeight: 13,
    offsetHeight: 14,
    offsetWidth: 15,
    offsetTop: 16,
    offsetLeft: 17,
  });
  const verb = {
    annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.verb")],
  };
  const box = new BoxFacade({ view, textarea, verb });
  const doUndo = () => undo({ state: view.state, dispatch: (tr) => (view.state = tr.state) });
  const doRedo = () => redo({ state: view.state, dispatch: (tr) => (view.state = tr.state) });
  return { view, textarea, box, undo: doUndo, redo: doRedo };
}

test("BoxFacade: the selection reads low to high however it was made", () => {
  const { box, view } = facadeRig();
  view.dispatch({ selection: { anchor: 8, head: 2 } });
  assert.equal(box.selectionStart, 2);
  assert.equal(box.selectionEnd, 8);
});

test("BoxFacade: setSelectionRange clamps as a textarea does", () => {
  const { box } = facadeRig("abc");
  box.setSelectionRange(1, 99);
  assert.deepEqual([box.selectionStart, box.selectionEnd], [1, 3]);
  box.setSelectionRange(99, 99);
  assert.deepEqual([box.selectionStart, box.selectionEnd], [3, 3]);
  box.setSelectionRange(2, 1);
  assert.deepEqual([box.selectionStart, box.selectionEnd], [2, 2]);
  box.setSelectionRange(-4);
  assert.deepEqual([box.selectionStart, box.selectionEnd], [0, 0]);
});

test("BoxFacade: value is the textarea's, in both directions", () => {
  const { box, textarea } = facadeRig("abc");
  assert.equal(box.value, "abc");
  box.value = "new";
  assert.equal(textarea.value, "new");
});

test("BoxFacade: replaceRange edits, places the caret, and is one step of undo", () => {
  const { box, view, undo: doUndo, redo: doRedo } = facadeRig("hello world");
  box.replaceRange(0, 5, "HELLO", 2);
  assert.equal(view.state.doc.toString(), "HELLO world");
  assert.equal(box.selectionStart, 2);
  doUndo();
  assert.equal(view.state.doc.toString(), "hello world");
  doRedo();
  assert.equal(view.state.doc.toString(), "HELLO world");
});

test("BoxFacade: the caret defaults to the end of the new text", () => {
  const { box } = facadeRig("ab");
  box.replaceRange(1, 1, "XYZ");
  assert.equal(box.selectionStart, 4);
});

test("BoxFacade: two verbs are two steps, however quickly they come", () => {
  const { box, view, undo: doUndo } = facadeRig("a");
  box.replaceRange(1, 1, "b");
  box.replaceRange(2, 2, "c");
  doUndo();
  assert.equal(view.state.doc.toString(), "ab");
});

test("BoxFacade: replacing text with itself still moves the caret", () => {
  const { box, view } = facadeRig("abc");
  box.replaceRange(0, 3, "abc", 1);
  assert.equal(box.selectionStart, 1);
  assert.equal(view.state.doc.toString(), "abc");
});

test("BoxFacade: each event is heard where it really happens", () => {
  const { box, view, textarea } = facadeRig();
  const heard = [];
  for (const type of ["input", "keydown", "keyup", "focus", "blur", "scroll"]) {
    box.addEventListener(type, () => heard.push(type));
  }
  textarea.dispatchEvent(new Event("input"));
  view.contentDOM.dispatchEvent(new Event("keydown"));
  view.contentDOM.dispatchEvent(new Event("keyup"));
  view.contentDOM.dispatchEvent(new Event("focus"));
  view.contentDOM.dispatchEvent(new Event("blur"));
  view.scrollDOM.dispatchEvent(new Event("scroll"));
  assert.deepEqual(heard, ["input", "keydown", "keyup", "focus", "blur", "scroll"]);
});

test("BoxFacade: listeners go when their signal says so, keydown included", () => {
  const { box, view } = facadeRig();
  const wiring = new AbortController();
  let heard = 0;
  box.addEventListener("keydown", () => heard++, { signal: wiring.signal });
  view.contentDOM.dispatchEvent(new Event("keydown"));
  wiring.abort();
  view.contentDOM.dispatchEvent(new Event("keydown"));
  assert.equal(heard, 1);
});

test("BoxFacade: dispatchEvent goes to the textarea", () => {
  const { box, textarea } = facadeRig();
  let heard = 0;
  textarea.addEventListener("input", () => heard++);
  box.dispatchEvent(new Event("input"));
  assert.equal(heard, 1);
});

test("BoxFacade: layout is the textarea's and scrolling the editor's", () => {
  const { box, view, textarea } = facadeRig();
  assert.equal(box.parentElement, textarea.parentElement);
  assert.equal(box.style, textarea.style);
  assert.equal(box.isConnected, true);
  assert.equal(box.clientHeight, 11);
  assert.equal(box.clientWidth, 12);
  assert.equal(box.scrollHeight, 13);
  assert.equal(box.offsetHeight, 14);
  assert.equal(box.offsetWidth, 15);
  assert.equal(box.offsetTop, 16);
  assert.equal(box.offsetLeft, 17);
  box.scrollTop = 40;
  assert.equal(view.scrollDOM.scrollTop, 40);
  assert.equal(box.scrollTop, 40);
  assert.equal(box.tagName, "TEXTAREA");
  // The view reports it on screen; the node is sized before the canvas scale.
  assert.equal(box.contentHeight, 60);
});

test("a change from outside adds no step of undo, and typing can still be undone", () => {
  const { view, undo: doUndo } = facadeRig("start");
  view.dispatch({ changes: { from: 5, insert: "!" }, userEvent: "input.type" });
  view.dispatch({
    changes: { from: 0, insert: "loaded " },
    annotations: Transaction.addToHistory.of(false),
  });
  assert.equal(view.state.doc.toString(), "loaded start!");
  doUndo();
  assert.equal(view.state.doc.toString(), "loaded start");
  assert.equal(doUndo(), false);
});

// --- keys --------------------------------------------------------------------

const key = (name, mods = "") => ({
  key: name,
  ctrlKey: mods.includes("c"),
  metaKey: mods.includes("m"),
  altKey: mods.includes("a"),
  shiftKey: mods.includes("s"),
});

test("keys: typing and moving stay in the editor", () => {
  for (const k of [
    key("q"),
    key("r"),
    key("Q", "s"),
    key("Enter"),
    key("Enter", "s"),
    key("Delete"),
    key("Backspace"),
    key(" "),
    key("."),
    key("ArrowUp"),
    key("ArrowDown", "s"),
    key("PageUp"),
    key("Tab"),
    key("F2"),
    key("a", "c"),
    key("C", "c"),
    key("v", "c"),
    key("v", "m"),
    key("x", "c"),
    key("z", "c"),
    key("y", "c"),
    key("Backspace", "c"),
    key("Delete", "c"),
    key("Home", "c"),
    key("End", "cs"),
    key("ArrowLeft", "c"),
    key("ArrowRight", "cs"),
  ]) {
    assert.equal(keyBelongsToEditor(k), true, JSON.stringify(k));
  }
});

test("keys: ComfyUI's shortcuts go through", () => {
  for (const k of [
    key("Enter", "c"),
    key("Enter", "cs"),
    key("s", "c"),
    key("s", "m"),
    key("o", "c"),
    key("b", "c"),
    key("m", "c"),
    key("g", "c"),
    key("v", "cs"),
    key("=", "a"),
    key("c", "a"),
    key("ArrowUp", "a"),
    key("ArrowUp", "c"),
    key("Escape"),
    key("Escape", "s"),
  ]) {
    assert.equal(keyBelongsToEditor(k), false, JSON.stringify(k));
  }
});

test("keys: a modifier on its own is nobody's", () => {
  for (const name of ["Control", "Shift", "Alt", "Meta"]) {
    assert.equal(keyBelongsToEditor(key(name)), false);
  }
});

// --- emphasis ----------------------------------------------------------------

const nudged = (value, start, end, delta) => {
  const edit = nudgeEmphasis(value, start, end, delta);
  return edit && value.slice(0, edit.from) + edit.text + value.slice(edit.to);
};

test("emphasis: the word at the caret gets brackets and a step", () => {
  assert.equal(nudged("a red cat", 3, 3, 0.1), "a (red:1.1) cat");
  assert.equal(nudged("a red cat", 3, 3, -0.05), "a (red:0.95) cat");
});

test("emphasis: inside brackets it changes their weight", () => {
  assert.equal(nudged("a (red:1.1) cat", 5, 5, 0.1), "a (red:1.2) cat");
  assert.equal(nudged("a (red cat) dog", 5, 5, 0.1), "a (red cat:1.1) dog");
});

test("emphasis: a weight reaching exactly 1 loses its brackets", () => {
  assert.equal(nudged("(red:1.1) x", 2, 2, -0.1), "red x");
  assert.equal(nudged("(red:0.95)", 2, 2, 0.05), "red");
});

test("emphasis: a selection is taken whole, less a trailing space", () => {
  assert.equal(nudged("a red cat dog", 2, 9, 0.1), "a (red cat:1.1) dog");
  assert.equal(nudged("a red cat", 2, 6, 0.1), "a (red:1.1) cat");
});

test("emphasis: selecting the words inside brackets takes the brackets", () => {
  assert.equal(nudged("a (red:1.1) cat", 3, 10, 0.1), "a (red:1.2) cat");
});

test("emphasis: a time inside brackets is not a weight", () => {
  assert.equal(nudged("(at 10:30)", 3, 3, 0.1), "(at 10:30:1.1)");
});

test("emphasis: floating point noise is rounded away", () => {
  assert.equal(nudged("(red:1.1)", 2, 2, 0.1), "(red:1.2)");
  assert.equal(nudged("(red:1.15)", 2, 2, 0.05), "(red:1.2)");
});

test("emphasis: reports the range it replaces", () => {
  assert.deepEqual(nudgeEmphasis("a red cat", 3, 3, 0.1), { from: 2, to: 5, text: "(red:1.1)" });
});

test("emphasis: nothing to act on is null", () => {
  assert.equal(nudgeEmphasis("", 0, 0, 0.1), null);
  assert.equal(nudgeEmphasis("a, b", 2, 2, 0.1), null);
});

// --- folding -----------------------------------------------------------------

const TEXT = "lead\n//// Style\nfoo\nbar\n//// Empty\n//// Style\nbaz\n\n//// Last";
const { sections } = parseSections(TEXT);
const sectionNamed = (key) => sections.find((section) => section.key === key);
const rangeOf = (key) => sectionFoldRange(sectionNamed(key));

test("fold: a header's line finds its section, and other lines nothing", () => {
  const style = sectionNamed("Style#0");
  assert.equal(sectionAtLine(sections, style.headerStart), style);
  assert.equal(sectionAtLine(sections, 0), null);
  assert.equal(sectionAtLine(sections, style.bodyStart), null);
});

test("fold: a section folds from the end of its header to the end of its body", () => {
  const style = sectionNamed("Style#0");
  assert.deepEqual(sectionFoldRange(style), { from: style.headerEnd, to: style.bodyEnd });
  assert.equal(TEXT.slice(style.headerEnd, style.bodyEnd), "\nfoo\nbar");
});

test("fold: a section with nothing in it has nothing to fold", () => {
  assert.equal(rangeOf("Empty#0"), null);
  assert.equal(rangeOf("Last#0"), null);
  assert.equal(sectionFoldRange(null), null);
});

test("fold: blank lines at the end of a section fold with it", () => {
  const style = sectionNamed("Style#1");
  assert.equal(TEXT.slice(style.headerEnd, style.bodyEnd), "\nbaz\n");
});

test("fold: keys keep the format saved workflows already use", () => {
  assert.deepEqual(
    sections.map((section) => section.key),
    ["Style#0", "Empty#0", "Style#1", "Last#0"]
  );
});

test("fold: ranges map back to keys, in text order", () => {
  const ranges = [rangeOf("Style#1"), rangeOf("Style#0")];
  assert.deepEqual(foldedKeysOf(sections, ranges), ["Style#0", "Style#1"]);
  assert.deepEqual(foldedKeysOf(sections, []), []);
});

test("fold: a range that is not a section's has no key", () => {
  assert.deepEqual(foldedKeysOf(sections, [{ from: 1, to: 2 }]), []);
});

test("fold: restoring folds what is saved and nothing else", () => {
  assert.deepEqual(foldPlan(sections, ["Style#1"], []), {
    fold: [rangeOf("Style#1")],
    unfold: [],
  });
});

test("fold: restoring opens what is no longer saved", () => {
  assert.deepEqual(foldPlan(sections, [], [rangeOf("Style#0")]), {
    fold: [],
    unfold: [rangeOf("Style#0")],
  });
});

test("fold: what is already right is left alone", () => {
  assert.deepEqual(foldPlan(sections, ["Style#0"], [rangeOf("Style#0")]), {
    fold: [],
    unfold: [],
  });
});

test("fold: a saved key the text no longer has is ignored", () => {
  assert.deepEqual(foldPlan(sections, ["Gone#0", "Empty#0"], []), { fold: [], unfold: [] });
});

test("fold: a range that has drifted is replaced by the section's real one", () => {
  const right = rangeOf("Style#0");
  const drifted = { from: right.from, to: right.to - 2 };
  assert.deepEqual(foldPlan(sections, ["Style#0"], [drifted]), {
    fold: [right],
    unfold: [drifted],
  });
});

test("fold: comparing keys ignores order", () => {
  assert.equal(sameKeys(["a#0", "b#0"], ["b#0", "a#0"]), true);
  assert.equal(sameKeys(["a#0"], ["a#0", "b#0"]), false);
  assert.equal(sameKeys(["a#0"], ["b#0"]), false);
  assert.equal(sameKeys([], []), true);
});

test("fold: the placeholder counts lines", () => {
  assert.equal(foldCountLabel({ lineCount: 6, loraCount: 0, activeLoras: 0 }), "··· 6 lines");
  assert.equal(
    foldCountLabel({ lineCount: 3, loraCount: 3, activeLoras: 2 }),
    "··· 3 LoRAs · 2 active"
  );
});
