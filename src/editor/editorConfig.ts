import { basicSetup } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Editor appearance.
 *
 * Colours are read from the CSS custom properties declared in
 * `styles/global.css`, so the palette can be replaced without touching the
 * editor configuration. CodeMirror owns this styling because it also needs the
 * values for layout measurements (gutter width, cursor position, wrapping).
 */
const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--color-bg)",
      color: "var(--color-text)",
      fontSize: "var(--font-size-editor)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.6",
    },
    ".cm-content": {
      padding: "8px 0",
      caretColor: "var(--color-caret)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--color-bg)",
      color: "var(--color-text-subtle)",
      border: "none",
      paddingRight: "4px",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--color-line-active)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--color-line-active)",
      color: "var(--color-text)",
    },

    // basicSetup installs `drawSelection()`, which paints its own selection layer.
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "var(--color-selection)",
      },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--color-caret)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused": {
      outline: "none",
    },
  },
  { dark: true },
);

/**
 * The extension set every editor instance starts from.
 *
 * `basicSetup` already provides line numbers, the undo/redo history with its
 * keymap (`Ctrl+Z` / `Ctrl+Y`), selection handling, bracket matching and the
 * default key bindings, so nothing has to be hand-assembled yet.
 */
const editorExtensions: Extension = [basicSetup, editorTheme];

/** Creates the initial state for an editor showing `doc` (empty by default). */
export function createEditorState(doc = ""): EditorState {
  return EditorState.create({ doc, extensions: editorExtensions });
}
