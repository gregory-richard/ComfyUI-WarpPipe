// Exactly what the prompt boxes use from CodeMirror 6, and nothing else, so the
// bundle in web/vendor stays as small as this list. Built by build_editor.mjs.

export {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder,
} from "@codemirror/view";

export {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  Transaction,
} from "@codemirror/state";

export {
  history,
  insertNewline,
  isolateHistory,
  redo,
  standardKeymap,
  undo,
} from "@codemirror/commands";

export {
  codeFolding,
  foldEffect,
  foldGutter,
  foldService,
  foldedRanges,
  unfoldEffect,
} from "@codemirror/language";
