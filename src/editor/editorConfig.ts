import { basicSetup } from "codemirror";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
} from "@codemirror/state";
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
    // `drawSelection` paints the selection into its own layer, which sits *below*
    // the line elements, so an opaque active-line background would paint over the
    // selected characters. Mixing the token with transparency keeps the active
    // line visible without hiding or replacing the selection underneath it
    // (FR-024, SC-007).
    ".cm-activeLine": {
      backgroundColor:
        "color-mix(in srgb, var(--color-line-active) 45%, transparent)",
    },
    ".cm-activeLineGutter": {
      backgroundColor:
        "color-mix(in srgb, var(--color-line-active) 45%, transparent)",
      color: "var(--color-text)",
    },

    // basicSetup installs `drawSelection()`, which paints the selection into its
    // own layer. The base theme colours that layer through a rule that names the
    // focused layer path, `.cm-dark.cm-focused > .cm-scroller >
    // .cm-selectionLayer .cm-selectionBackground`, which is more specific than a
    // short application selector. The drawn focused selection would therefore
    // keep CodeMirror's built-in dark colour and the application token would
    // never apply. Naming the editor root, the focused state and the layer path
    // keeps the application colour authoritative (FR-023, FR-025).
    "&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
      {
        backgroundColor: "var(--color-selection)",
      },
    "&.cm-editor .cm-selectionBackground, .cm-content ::selection": {
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

/**
 * Builds the replacement state for a document whose content was reloaded from disk.
 *
 * This is the 005 counterpart of {@link createEditorState}, and it exists as a
 * factory rather than a dispatch so the replacement can be built, validated and
 * committed by the document owner before any view sees it.
 *
 * Three requirements shape it:
 *
 * - **Undo/redo must not resurrect the superseded version** (FR-018). History
 *   lives *inside* `EditorState`, so creating a new state is exactly what clears
 *   it; there is deliberately no "clear history" effect to forget.
 * - **Every selection anchor/head is preserved as the same absolute offset and
 *   clamped to the new length** (FR-019). Offsets past the new end collapse onto
 *   the end instead of failing the reload, and the main range index is preserved
 *   so the primary selection stays primary.
 * - **It is not a user edit transaction** (plan §5.8). No transaction with a
 *   document change is produced, so the reload cannot make the document dirty.
 *
 * Bringing the clamped primary head into view is the view's job, not the state's
 * (`EditorHandle.reloadDocumentState`), because a state cannot know whether it
 * is the one currently displayed.
 */
export function createExternalReloadState(
  current: EditorState,
  text: string,
  runtimeExtensions: Extension = [],
): EditorState {
  const replacement = createEditorState(text, runtimeExtensions);
  const length = replacement.doc.length;
  const clamp = (position: number): number =>
    Math.max(0, Math.min(position, length));

  const ranges = current.selection.ranges.map((range) =>
    EditorSelection.range(clamp(range.anchor), clamp(range.head)),
  );
  const mainIndex = Math.max(
    0,
    Math.min(current.selection.mainIndex, ranges.length - 1),
  );

  return replacement.update({
    selection: EditorSelection.create(ranges, mainIndex),
  }).state;
}
