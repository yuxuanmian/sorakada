import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import {
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  SearchCursor,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";

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
  /** Runs CodeMirror's own undo command against the active view. */
  undo(): void;
  /** Runs CodeMirror's own redo command against the active view. */
  redo(): void;

  /** Registers the single receiver of state updates. */
  setStateUpdateListener(listener: StateUpdateListener | null): void;

  /** Gets the selected text from the active document, or empty string if none. */
  getSelectedText(): string;

  /** Updates the active search query and case sensitivity. */
  setSearch(query: string, caseSensitive: boolean, replacement?: string): void;

  /** Navigates to the next match from the current cursor position. */
  findNext(): void;

  /** Navigates to the previous match before the current cursor position. */
  findPrevious(): void;

  /** Replaces the current match (or jumps to it if not selected) and moves to the next. */
  replaceNext(query: string, replacement: string, caseSensitive: boolean): void;

  /** Replaces all matches across the document in a single atomic transaction. */
  replaceAll(query: string, replacement: string, caseSensitive: boolean): void;

  /** Calculates match statistics for the query against the current document. */
  countMatches(query: string, caseSensitive: boolean): SearchMatchesResult;
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
    this.view = view;
    this.boundDocumentId = documentId;
  }

  detach(view: EditorView): void {
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
    const view = this.requireView();
    // Identity first: the update this call produces must already belong to the
    // target document.
    this.boundDocumentId = documentId;
    view.setState(state);
  }

  reloadDocumentState(documentId: DocumentId, state: EditorState): void {
    const view = this.requireView();
    // Same ordering rule as `setState`: the (change-free) update the swap
    // produces must already be attributed to the reloaded document.
    this.boundDocumentId = documentId;
    view.setState(state);
    // FR-019: keep the clamped primary head visible. `setState` does not scroll,
    // and the previous scroll offset may describe a line that no longer exists.
    view.dispatch({
      effects: EditorView.scrollIntoView(state.selection.main.head, {
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

  undo(): void {
    undo(this.requireView());
  }

  redo(): void {
    redo(this.requireView());
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

  setSearch(query: string, caseSensitive: boolean, replacement = ""): void {
    const view = this.requireView();
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: query,
          caseSensitive,
          replace: replacement,
        }),
      ),
    });
  }

  findNext(): void {
    const view = this.requireView();
    findNext(view);
  }

  findPrevious(): void {
    const view = this.requireView();
    findPrevious(view);
  }

  replaceNext(query: string, replacement: string, caseSensitive: boolean): void {
    const view = this.requireView();
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: query,
          caseSensitive,
          replace: replacement,
        }),
      ),
    });
    replaceNext(view);
  }

  replaceAll(query: string, replacement: string, caseSensitive: boolean): void {
    const view = this.requireView();
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: query,
          caseSensitive,
          replace: replacement,
        }),
      ),
    });
    replaceAll(view);
  }

  countMatches(query: string, caseSensitive: boolean): SearchMatchesResult {
    if (this.view === null || query.length === 0) {
      return { count: 0, currentIndex: 0, isCapped: false };
    }
    const doc = this.view.state.doc;
    const normalize = caseSensitive ? undefined : (x: string) => x.toLowerCase();
    const cursor = new SearchCursor(doc, query, 0, doc.length, normalize);
    const { from, to } = this.view.state.selection.main;
    let count = 0;
    let currentIndex = 0;
    let isCapped = false;
    const MAX_MATCHES = 1000;

    while (!cursor.next().done) {
      count += 1;
      if (cursor.value.from === from && cursor.value.to === to) {
        currentIndex = count;
      }
      if (count >= MAX_MATCHES) {
        isCapped = true;
        break;
      }
    }

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
