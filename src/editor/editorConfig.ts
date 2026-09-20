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
 * Colours and typography are read from the CSS custom properties declared in
 * `styles/global.css`, so the palette and the Editor preset can be replaced
 * without touching the editor configuration. CodeMirror owns this styling
 * because it also needs the values for layout measurements (gutter width,
 * cursor position, wrapping).
 *
 * 008 gives the Editor the quietest surface in the application: a near-opaque
 * neutral plane, softened text, a tuned 14px/1.52 rhythm, a gutter that stays
 * integrated with the reading plane, a restrained current line and a selection
 * that visibly dominates it (008 FR-016..FR-024, SC-002, SC-003). The family,
 * size, line height and padding remain application appearance defaults — they
 * are deliberately not document fields, and the existing `appearanceCompartment`
 * below is still the single seam a later Settings surface would reconfigure
 * (008 FR-013, FR-014).
 */
const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--surface-editor)",
      color: "var(--color-text)",
      fontSize: "var(--font-size-editor)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-editor)",
      lineHeight: "var(--editor-line-height)",
    },
    ".cm-content": {
      padding: "var(--editor-padding-block) 0",
      caretColor: "var(--color-caret)",
    },
    // Inline breathing room for the text itself, without wrapping the code in a
    // fake card or container (008 FR-016).
    ".cm-line": {
      padding: "0 var(--editor-line-padding-inline)",
    },
    // The gutter shares the reading plane's surface: no hard divider, no column
    // that reads as a separate panel, and no reserved space for gutter icons 008
    // does not have (008 FR-017, FR-025).
    ".cm-gutters": {
      backgroundColor: "var(--surface-editor)",
      color: "var(--color-text-subtle)",
      border: "none",
      paddingRight: "4px",
    },
    // `drawSelection` paints the selection into its own layer, which sits *below*
    // the line elements, so an opaque active-line background would paint over the
    // selected characters. Mixing the token with transparency keeps the active
    // line visible without hiding or replacing the selection underneath it
    // (008 FR-020, FR-021, SC-002).
    ".cm-activeLine": {
      backgroundColor:
        "color-mix(in srgb, var(--color-line-active) 72%, transparent)",
    },
    // The current line number becomes more prominent without any line-number
    // geometry change (008 FR-019).
    ".cm-activeLineGutter": {
      backgroundColor:
        "color-mix(in srgb, var(--color-line-active) 72%, transparent)",
      color: "var(--color-text)",
    },

    // basicSetup installs `drawSelection()`, which paints the selection into its
    // own layer. The base theme colours that layer through a rule that names the
    // focused layer path, `.cm-dark.cm-focused > .cm-scroller >
    // .cm-selectionLayer .cm-selectionBackground`, which is more specific than a
    // short application selector. The drawn focused selection would therefore
    // keep CodeMirror's built-in dark colour and the application token would
    // never apply. Naming the editor root, the focused state and the layer path
    // keeps the application colour authoritative (008 FR-021, FR-023).
    "&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
      {
        backgroundColor: "var(--color-selection)",
      },
    "&.cm-editor .cm-selectionBackground": {
      backgroundColor: "var(--color-selection)",
    },
    /*
     * The native selection additionally consumes the semantic selection
     * foreground (008 FR-022). Only the native path is recoloured: 008 has no
     * syntax highlighting, so building a brittle overlay purely to recolour every
     * drawn-selection glyph is not earned. `--color-selection-text` is the
     * contract future syntax work will consume.
     */
    ".cm-content ::selection": {
      backgroundColor: "var(--color-selection)",
      color: "var(--color-selection-text)",
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
