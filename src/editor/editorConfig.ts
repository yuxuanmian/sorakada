import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
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
 * The application-scoped appearance reconfiguration boundary.
 *
 * Appearance belongs to the application, not to a document: 002 adds no theme
 * selector, but every document state installs its appearance through this one
 * compartment so a later application-level change cannot require a per-document
 * theme preference or an editor-view rebuild.
 */
const appearanceCompartment = new Compartment();

/** The appearance currently applied to newly created document states. */
let currentAppearance: Extension = editorTheme;

/**
 * The appearance extension for a newly created state.
 *
 * Evaluated per call rather than hoisted into a constant, so a state created
 * after a reconfiguration picks up the new appearance.
 */
function appearanceBoundary(): Extension {
  return appearanceCompartment.of(currentAppearance);
}

/**
 * Replaces the application-wide editor appearance.
 *
 * The live view is reconfigured immediately; every state created afterwards
 * starts from the new appearance as well.
 */
export function reconfigureAppearance(
  view: EditorView,
  appearance: Extension,
): void {
  currentAppearance = appearance;
  view.dispatch({
    effects: appearanceCompartment.reconfigure(appearance),
  });
}

/**
 * Creates the state for a document showing `doc` (empty by default).
 *
 * This is the only factory any document state is created through — the initial
 * session in `DocumentManager` included — so every state carries `basicSetup`,
 * the application appearance boundary, and the caller's runtime extensions in
 * the same order.
 *
 * `basicSetup` already provides line numbers, the undo/redo history with its
 * keymap (`Ctrl+Z` / `Ctrl+Y`), selection handling, bracket matching and the
 * default key bindings, so nothing has to be hand-assembled yet.
 *
 * `basicSetup` installs `historyKeymap`, which binds `Mod-z` to undo. That is
 * deliberately left in place as the fallback for a browser-only `vite dev`
 * session. In the desktop shell the application's own `keydown` dispatcher
 * (`src/app/App.tsx`) matches the IDEA profile first and calls
 * `stopPropagation`, so one `Ctrl+Z` reaches `editor.undo` exactly once and
 * never also reaches this binding. Do not add a second shortcut route.
 */
export function createEditorState(
  doc = "",
  runtimeExtensions: Extension = [],
): EditorState {
  return EditorState.create({
    doc,
    extensions: [basicSetup, appearanceBoundary(), runtimeExtensions],
  });
}
