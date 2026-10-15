import { basicSetup } from "codemirror";
import { getSearchQuery, search } from "@codemirror/search";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { getCachedMatches } from "../app/search/searchEngine";

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
    // Keep the row fill below drawSelection's layer (-2 in basicSetup).
    // Painting it on the line itself would tint selected characters, giving
    // partial selections a different blue from selections crossing a newline.
    ".cm-activeLine": {
      position: "relative",
      backgroundColor: "transparent",
    },
    ".cm-activeLine::before": {
      content: "''",
      position: "absolute",
      inset: "0",
      zIndex: "-3",
      pointerEvents: "none",
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
    // 009: Search match highlighting.
    ".cm-searchMatch": {
      backgroundColor: "var(--color-search-match)",
      color: "var(--color-search-match-text)",
    },
    ".cm-searchMatch::selection, .cm-searchMatch ::selection": {
      color: "var(--color-search-match-text)",
    },
    ".cm-searchMatch.cm-searchMatch-current, .cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "var(--color-search-match)",
      outline: "1px solid var(--color-search-match-current-outline)",
      outlineOffset: "-1px",
    },
    ".cm-searchMatch-zero": {
      display: "inline-block",
      width: "0px",
      height: "1.2em",
      verticalAlign: "text-bottom",
      borderLeft: "2px solid var(--color-search-match)",
      marginLeft: "-1px",
      marginRight: "-1px",
      pointerEvents: "none",
    },
    ".cm-searchMatch-zero.cm-searchMatch-zero-current": {
      borderLeft: "2px solid var(--color-search-match-current-outline)",
      outline: "1px solid var(--color-search-match-current-outline)",
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

const searchMatchMark = Decoration.mark({ class: "cm-searchMatch" });
const searchMatchSelectedMark = Decoration.mark({
  class: "cm-searchMatch cm-searchMatch-current cm-searchMatch-selected",
});
const searchMatchCurrentMark = searchMatchSelectedMark;

export class ZeroWidthMatchWidget extends WidgetType {
  constructor(readonly isCurrent: boolean) {
    super();
  }

  eq(other: ZeroWidthMatchWidget): boolean {
    return this.isCurrent === other.isCurrent;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.isCurrent
      ? "cm-searchMatch-zero cm-searchMatch-zero-current"
      : "cm-searchMatch-zero";
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Custom search match decoration plugin.
 *
 * `@codemirror/search`'s built-in `searchHighlighter` checks `if (!panel || !query.spec.valid) return Decoration.none;`.
 * Because Sorakada hosts its own React-based SearchReplaceBar instead of CodeMirror's
 * built-in panel DOM, CodeMirror's `panel` is always null, which suppresses all match
 * decorations.
 *
 * This ViewPlugin inspects `getSearchQuery(view.state)` and decorates visible ranges
 * directly whenever a valid non-empty query exists, ensuring matches are highlighted
 * immediately on the very first frame.
 */
export const searchDecorationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(readonly view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      const querySpec = getSearchQuery(update.state);
      const prevQuerySpec = getSearchQuery(update.startState);
      if (
        !querySpec.eq(prevQuerySpec) ||
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged
      ) {
        this.decorations = this.build(update.view);
      }
    }

    private build(view: EditorView): DecorationSet {
      const querySpec = getSearchQuery(view.state);
      if (!querySpec || !querySpec.valid || !querySpec.search) {
        return Decoration.none;
      }
      const isRegex = querySpec.regexp;
      const matches = getCachedMatches(
        view.state.doc,
        querySpec.search,
        querySpec.caseSensitive,
        isRegex,
      );
      if (matches.length === 0) {
        return Decoration.none;
      }

      const builder = new RangeSetBuilder<Decoration>();
      const vpFrom = view.viewport ? view.viewport.from : 0;
      const vpTo =
        view.viewport && (view.viewport.to > 0 || view.state.doc.length === 0)
          ? view.viewport.to
          : view.state.doc.length;
      const mainSel = view.state.selection.main;

      for (const m of matches) {
        if (m.from > vpTo) break;
        if (m.to < vpFrom || m.from > vpTo) {
          continue;
        }
        const isCurrent = mainSel.from === m.from && mainSel.to === m.to;
        if (m.isZeroWidth) {
          builder.add(
            m.from,
            m.to,
            Decoration.widget({
              widget: new ZeroWidthMatchWidget(isCurrent),
              side: 1,
            }),
          );
        } else {
          builder.add(
            m.from,
            m.to,
            isCurrent ? searchMatchCurrentMark : searchMatchMark,
          );
        }
      }
      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

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
    extensions: [
      basicSetup,
      search({ top: true }),
      searchDecorationPlugin,
      appearanceBoundary(),
      runtimeExtensions,
    ],
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
