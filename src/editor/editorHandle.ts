import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isolateHistory, redo, undo } from "@codemirror/commands";
import { reconfigureEditorLanguage } from "./editorLanguage";
import { searchMotionAnnotation } from "./editorMotion";
import { cancelColumnSelection } from "./columnSelection";
import {
  clearSmartSelectionHistory,
  expandSmartSelection,
  shrinkSmartSelection,
} from "./smartSelection";
import {
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import {
  computeReplacement,
  findAllMatches,
  findNearestMatch,
  findNextMatch,
  findPreservedMatch,
  findPreviousMatch,
  getCachedMatches,
  validateRegex,
} from "../app/search/searchEngine";

import type {
  DocumentId,
  DocumentViewState,
} from "../app/document/documentSession";

/**
 * Result of counting matches in the active document.
 */
export interface SearchMatchesResult {
  /** Total number of matches up to the safety cap. */
  count: number;
  /** 1-based index of the currently selected match, or 0 if none. */
  currentIndex: number;
  /** Whether the count reached the safety cap (e.g. 1000). */
  isCapped: boolean;
}

/**
 * Invoked for every CodeMirror update.
 *
 * The document id is the identity the bridge had bound at the moment the update
 * was produced, which is what lets the manager attribute a state change to the
 * right document even when it happened during a Tab switch.
 */
export type StateUpdateListener = (
  documentId: DocumentId,
  state: EditorState,
  docChanged: boolean,
) => void;

/**
 * The imperative operations the application layer needs from the editor.
 *
 * Everything here is addressed to the *single* live CodeMirror view, so that no
 * caller has to know about `EditorView` or mirror the document into React
 * state. The bridge — not the manager — is the only object that understands
 * which document is currently installed in that view.
 */
export interface EditorHandle {
  /**
   * Extensions every state created for this handle must include, so the handle
   * keeps receiving updates after a document state is swapped in.
   */
  readonly extensions: Extension;

  /** Whether a CodeMirror view is currently attached. */
  isReady(): boolean;
  /** Binds the one live view to the document it is currently showing. */
  attach(view: EditorView, documentId: DocumentId): void;
  /** Releases the view; a later update is no longer attributed to any document. */
  detach(view: EditorView): void;

  /** The state currently installed in the view. */
  getState(): EditorState;
  /**
   * Installs `state` for `documentId`.
   *
   * The document identity is bound *before* the state is set, so any update the
   * swap produces is attributed to the target document rather than the previous
   * one.
   */
  setState(documentId: DocumentId, state: EditorState): void;

  /**
   * Installs externally reloaded content and reveals its clamped primary head.
   *
   * A disk reload replaces the whole state (which is what clears undo/redo) and
   * then has to satisfy FR-019: the restored view keeps the clamped primary
   * selection head visible. Exact pixel scroll preservation is explicitly not
   * required when the new content changed line layout, so this scrolls the head
   * into view instead of restoring an offset that may now be meaningless.
   *
   * `setState` produces an update with no document change, so this can never be
   * mistaken for a user edit (plan §5.8).
   */
  reloadDocumentState(documentId: DocumentId, state: EditorState): void;

  /** Captures the reading position the shared view currently shows. */
  captureViewState(): DocumentViewState;
  /** Restores a document's reading position after its state was bound. */
  restoreViewState(viewState: DocumentViewState): void;

  /** Moves keyboard focus into the editor. */
  focus(): void;
  /** Whether the editor currently has keyboard focus. */
  hasFocus(): boolean;
  /** Runs CodeMirror's own undo command against the active view. */
  undo(): void;
  /** Runs CodeMirror's own redo command against the active view. */
  redo(): void;
  /** Simplifies selection: multi-selection -> main range -> single cursor -> false. */
  simplifySelection(): boolean;

  /** Expands the selection to the next semantic structural unit. */
  expandSelection(): void;
  /** Shrinks the selection to the previous snapshot before the last expand. */
  shrinkSelection(): void;

  /**
   * Reconfigures syntax highlighting language for the current document view.
   *
   * Dispatches `reconfigureEditorLanguage(filename)` against the attached view without
   * replacing the state, clearing smart selection, or modifying selection, scroll, or history.
   */
  reconfigureLanguage(filename: string | null): void;

  /** Registers the single receiver of state updates. */
  setStateUpdateListener(listener: StateUpdateListener | null): void;

  /** Gets the selected text from the active document, or empty string if none. */
  getSelectedText(): string;

  /** Gets the current cursor head position (anchor of primary selection). */
  getCursorHead(): number;

  /** Gets the current primary selection range, or null if view not attached. */
  getCurrentMatchRange(): { from: number; to: number } | null;

  /** Updates the active search query, options, and replacement. */
  setSearch(
    query: string,
    caseSensitive: boolean,
    isRegex?: boolean,
    replacement?: string,
  ): void;

  /** Selects nearest forward match from head, preserving valid current match if applicable. */
  selectNearestMatch(
    fromPos?: number,
    preferCurrentRange?: { from: number; to: number },
  ): SearchMatchesResult;

  /** Navigates to the next match from the current cursor position. */
  findNext(): void;

  /** Navigates to the previous match before the current cursor position. */
  findPrevious(): void;

  /** Replaces the current match (or jumps to it if not selected) and moves to the next. */
  replaceNext(
    query?: string,
    replacement?: string,
    caseSensitive?: boolean,
    isRegex?: boolean,
  ): void;

  /** Replaces all matches across the document in a single atomic transaction. */
  replaceAll(
    query?: string,
    replacement?: string,
    caseSensitive?: boolean,
    isRegex?: boolean,
  ): void;

  /** Calculates match statistics for the query against the current document. */
  countMatches(
    query: string,
    caseSensitive: boolean,
    isRegex?: boolean,
  ): SearchMatchesResult;
}

/**
 * The handle type the `Editor` component binds a view to.
 *
 * Attachment is part of the handle surface in 002: the component owns the
 * `EditorView` lifetime, while the handle owns which document it is showing.
 */
export type AttachedEditorHandle = EditorHandle;

const NOT_ATTACHED_MESSAGE =
  "The editor handle is not attached to a CodeMirror view.";

class EditorHandleImpl implements EditorHandle {
  private view: EditorView | null = null;
  private boundDocumentId: DocumentId | null = null;
  private listener: StateUpdateListener | null = null;
  private activeQuery = "";
  private activeCaseSensitive = false;
  private activeIsRegex = false;
  private activeReplacement = "";

  /**
   * `EditorView.updateListener` reads the current binding at call time, so one
   * extension instance can serve every state this handle ever creates.
   */
  readonly extensions: Extension = EditorView.updateListener.of((update) => {
    const documentId = this.boundDocumentId;
    if (documentId === null) {
      return;
    }
    this.listener?.(documentId, update.state, update.docChanged);
  });

  attach(view: EditorView, documentId: DocumentId): void {
    cancelColumnSelection();
    this.view = view;
    this.boundDocumentId = documentId;
  }

  detach(view: EditorView): void {
    cancelColumnSelection();
    if (this.view === view) {
      this.view = null;
      this.boundDocumentId = null;
    }
  }

  isReady(): boolean {
    return this.view !== null;
  }

  getState(): EditorState {
    return this.requireView().state;
  }

  setState(documentId: DocumentId, state: EditorState): void {
    cancelColumnSelection();
    const view = this.requireView();
    // Identity first: the update this call produces must already belong to the
    // target document.
    this.boundDocumentId = documentId;
    const cleanedState = state.update({
      effects: clearSmartSelectionHistory.of(),
    }).state;
    view.setState(cleanedState);
  }

  reloadDocumentState(documentId: DocumentId, state: EditorState): void {
    cancelColumnSelection();
    const view = this.requireView();
    // Same ordering rule as `setState`: the (change-free) update the swap
    // produces must already be attributed to the reloaded document.
    this.boundDocumentId = documentId;
    const cleanedState = state.update({
      effects: clearSmartSelectionHistory.of(),
    }).state;
    view.setState(cleanedState);
    // FR-019: keep the clamped primary head visible. `setState` does not scroll,
    // and the previous scroll offset may describe a line that no longer exists.
    view.dispatch({
      effects: EditorView.scrollIntoView(cleanedState.selection.main.head, {
        y: "center",
      }),
    });
  }

  captureViewState(): DocumentViewState {
    const view = this.requireView();
    return {
      scrollTop: view.scrollDOM.scrollTop,
      scrollLeft: view.scrollDOM.scrollLeft,
    };
  }

  restoreViewState(viewState: DocumentViewState): void {
    const view = this.requireView();
    view.scrollDOM.scrollTop = viewState.scrollTop;
    view.scrollDOM.scrollLeft = viewState.scrollLeft;
  }

  focus(): void {
    this.requireView().focus();
  }

  hasFocus(): boolean {
    return this.view !== null && this.view.hasFocus;
  }

  undo(): void {
    undo(this.requireView());
  }

  redo(): void {
    redo(this.requireView());
  }

  expandSelection(): void {
    if (this.view) {
      expandSmartSelection(this.view);
    }
  }

  shrinkSelection(): void {
    if (this.view) {
      shrinkSmartSelection(this.view);
    }
  }

  reconfigureLanguage(filename: string | null): void {
    const view = this.requireView();
    view.dispatch({
      effects: reconfigureEditorLanguage(filename),
    });
  }

  simplifySelection(): boolean {
    if (this.view === null) {
      return false;
    }
    const sel = this.view.state.selection;
    if (sel.ranges.length > 1) {
      this.view.dispatch({
        selection: EditorSelection.create([sel.main]),
        scrollIntoView: true,
        userEvent: "select",
      });
      return true;
    }
    if (!sel.main.empty) {
      this.view.dispatch({
        selection: EditorSelection.cursor(sel.main.head),
        scrollIntoView: true,
        userEvent: "select",
      });
      return true;
    }
    return false;
  }

  setStateUpdateListener(listener: StateUpdateListener | null): void {
    this.listener = listener;
  }

  getSelectedText(): string {
    if (this.view === null) {
      return "";
    }
    const { from, to } = this.view.state.selection.main;
    if (from === to) {
      return "";
    }
    return this.view.state.sliceDoc(from, to);
  }

  getCursorHead(): number {
    if (this.view === null) {
      return 0;
    }
    return this.view.state.selection.main.head;
  }

  getCurrentMatchRange(): { from: number; to: number } | null {
    if (this.view === null) {
      return null;
    }
    const { from, to } = this.view.state.selection.main;
    return { from, to };
  }

  setSearch(
    query: string,
    caseSensitive: boolean,
    isRegex = false,
    replacement = "",
  ): void {
    const view = this.requireView();
    this.activeQuery = query;
    this.activeCaseSensitive = caseSensitive;
    this.activeIsRegex = isRegex;
    this.activeReplacement = replacement;

    let querySpec: SearchQuery;
    if (isRegex) {
      const validation = validateRegex(query, caseSensitive);
      if (!validation.valid) {
        querySpec = new SearchQuery({
          search: "",
          caseSensitive,
          regexp: false,
          replace: replacement,
        });
      } else {
        querySpec = new SearchQuery({
          search: query,
          caseSensitive,
          regexp: true,
          replace: replacement,
        });
      }
    } else {
      querySpec = new SearchQuery({
        search: query,
        caseSensitive,
        regexp: false,
        replace: replacement,
      });
    }
    view.dispatch({
      effects: setSearchQuery.of(querySpec),
    });
  }

  selectNearestMatch(
    fromPos?: number,
    preferCurrentRange?: { from: number; to: number },
  ): SearchMatchesResult {
    if (this.view === null || this.activeQuery.length === 0) {
      return { count: 0, currentIndex: 0, isCapped: false };
    }
    const view = this.view;
    const matches = getCachedMatches(
      view.state.doc,
      this.activeQuery,
      this.activeCaseSensitive,
      this.activeIsRegex,
    );
    if (matches.length === 0) {
      return { count: 0, currentIndex: 0, isCapped: false };
    }

    let target = preferCurrentRange
      ? findPreservedMatch(matches, preferCurrentRange)
      : null;
    if (!target) {
      const head = fromPos ?? view.state.selection.main.head;
      target = findNearestMatch(matches, head);
    }
    if (target) {
      view.dispatch({
        selection: { anchor: target.match.from, head: target.match.to },
        effects: EditorView.scrollIntoView(
          EditorSelection.range(target.match.from, target.match.to),
          { y: "center", x: "center" },
        ),
        annotations: searchMotionAnnotation.of(true),
        userEvent: "select.search",
      });
    }

    const isCapped = matches.length > 1000;
    const count = isCapped ? 1000 : matches.length;
    return {
      count,
      currentIndex: target?.index ?? 0,
      isCapped,
    };
  }

  findNext(): void {
    if (this.view === null || this.activeQuery.length === 0) {
      return;
    }
    const view = this.view;
    const matches = getCachedMatches(
      view.state.doc,
      this.activeQuery,
      this.activeCaseSensitive,
      this.activeIsRegex,
    );
    if (matches.length === 0) {
      return;
    }
    const currentRange = {
      from: view.state.selection.main.from,
      to: view.state.selection.main.to,
    };
    const found = findNextMatch(matches, currentRange);
    if (found) {
      view.dispatch({
        selection: { anchor: found.match.from, head: found.match.to },
        effects: EditorView.scrollIntoView(
          EditorSelection.range(found.match.from, found.match.to),
          { y: "center", x: "center" },
        ),
        annotations: searchMotionAnnotation.of(true),
        userEvent: "select.search",
      });
    }
  }

  findPrevious(): void {
    if (this.view === null || this.activeQuery.length === 0) {
      return;
    }
    const view = this.view;
    const matches = getCachedMatches(
      view.state.doc,
      this.activeQuery,
      this.activeCaseSensitive,
      this.activeIsRegex,
    );
    if (matches.length === 0) {
      return;
    }
    const currentRange = {
      from: view.state.selection.main.from,
      to: view.state.selection.main.to,
    };
    const found = findPreviousMatch(matches, currentRange);
    if (found) {
      view.dispatch({
        selection: { anchor: found.match.from, head: found.match.to },
        effects: EditorView.scrollIntoView(
          EditorSelection.range(found.match.from, found.match.to),
          { y: "center", x: "center" },
        ),
        annotations: searchMotionAnnotation.of(true),
        userEvent: "select.search",
      });
    }
  }

  replaceNext(
    query = this.activeQuery,
    replacement = this.activeReplacement,
    caseSensitive = this.activeCaseSensitive,
    isRegex = this.activeIsRegex,
  ): void {
    const view = this.requireView();
    if (view.state.readOnly) {
      return;
    }
    this.setSearch(query, caseSensitive, isRegex, replacement);
    const matches = getCachedMatches(
      view.state.doc,
      query,
      caseSensitive,
      isRegex,
    );
    if (matches.length === 0) {
      return;
    }
    const sel = view.state.selection.main;
    const currentIdx = matches.findIndex(
      (m) => m.from === sel.from && m.to === sel.to,
    );
    if (currentIdx === -1) {
      this.findNext();
      return;
    }

    const currentMatch = matches[currentIdx];
    const insertText = computeReplacement(replacement, currentMatch.match, isRegex);

    // Apply change in projected state to inspect matches in the updated document
    const tempTr = view.state.update({
      changes: {
        from: currentMatch.from,
        to: currentMatch.to,
        insert: insertText,
      },
    });
    const nextDocText = tempTr.state.doc.toString();
    const nextMatches = findAllMatches(
      nextDocText,
      query,
      caseSensitive,
      isRegex,
    );

    let nextAnchor = currentMatch.from + insertText.length;
    let nextHead = nextAnchor;

    if (nextMatches.length > 0) {
      const searchAfterPos =
        currentMatch.from +
        Math.max(insertText.length, currentMatch.isZeroWidth ? 1 : 0);

      const forwardTarget = nextMatches.find((m) => m.from >= searchAfterPos);
      const targetMatch = forwardTarget ?? nextMatches[0];
      nextAnchor = targetMatch.from;
      nextHead = targetMatch.to;
    }

    view.dispatch({
      changes: {
        from: currentMatch.from,
        to: currentMatch.to,
        insert: insertText,
      },
      selection: { anchor: nextAnchor, head: nextHead },
      effects: EditorView.scrollIntoView(
        EditorSelection.range(nextAnchor, nextHead),
        { y: "center", x: "center" },
      ),
      annotations: [isolateHistory.of("full"), searchMotionAnnotation.of(true)],
      userEvent: "input.replace",
    });
  }

  replaceAll(
    query = this.activeQuery,
    replacement = this.activeReplacement,
    caseSensitive = this.activeCaseSensitive,
    isRegex = this.activeIsRegex,
  ): void {
    const view = this.requireView();
    if (view.state.readOnly) {
      return;
    }
    this.setSearch(query, caseSensitive, isRegex, replacement);
    const matches = getCachedMatches(
      view.state.doc,
      query,
      caseSensitive,
      isRegex,
    );
    if (matches.length === 0) {
      return;
    }
    const changes = [];
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const m = matches[i];
      const insert = computeReplacement(replacement, m.match, isRegex);
      changes.push({ from: m.from, to: m.to, insert });
    }
    view.dispatch({
      changes,
      annotations: isolateHistory.of("full"),
      userEvent: "input.replace.all",
    });
  }

  countMatches(
    query: string,
    caseSensitive: boolean,
    isRegex = false,
  ): SearchMatchesResult {
    if (this.view === null || query.length === 0) {
      return { count: 0, currentIndex: 0, isCapped: false };
    }
    const view = this.view;
    const matches = getCachedMatches(
      view.state.doc,
      query,
      caseSensitive,
      isRegex,
    );
    if (matches.length === 0) {
      return { count: 0, currentIndex: 0, isCapped: false };
    }
    const { from, to } = view.state.selection.main;
    let currentIndex = 0;
    const matchIdx = matches.findIndex((m) => m.from === from && m.to === to);
    if (matchIdx !== -1) {
      currentIndex = matchIdx + 1;
    }
    const isCapped = matches.length > 1000;
    const count = isCapped ? 1000 : matches.length;

    return { count, currentIndex, isCapped };
  }

  private requireView(): EditorView {
    if (this.view === null) {
      throw new Error(NOT_ATTACHED_MESSAGE);
    }
    return this.view;
  }
}

/** Creates the process-wide editor handle the application talks to. */
export function createEditorHandle(): AttachedEditorHandle {
  return new EditorHandleImpl();
}
