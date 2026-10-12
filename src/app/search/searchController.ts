import type { EditorHandle } from "../../editor/editorHandle";
import { ESCAPE_PRIORITY, type EscapeManager } from "../commands/escapeManager";
import { validateRegex } from "./searchEngine";
import {
  INITIAL_SEARCH_STATE,
  normalizeSelectionForPrefill,
  type SearchState,
} from "./searchModel";

export type SearchStateListener = (state: SearchState) => void;

/**
 * Controller managing in-file search and replace state and operations.
 */
export class SearchController {
  private state: SearchState = INITIAL_SEARCH_STATE;
  private readonly listeners = new Set<SearchStateListener>();
  private countDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private escapeUnregister: (() => void) | null = null;
  private previousMatchRange: { from: number; to: number } | null = null;

  constructor(
    private readonly editor: EditorHandle,
    private readonly escapeManager?: EscapeManager,
  ) {}

  getState(): SearchState {
    return this.state;
  }

  subscribe(listener: SearchStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(partial: Partial<SearchState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  /**
   * Opens the search bar in the given mode.
   * If editor has selected text, pre-fills the query (escaped in regex mode).
   * Find adopts a new manual selection even from Replace mode; otherwise mode
   * switches preserve the query, options, and current match.
   */
  open(mode: "find" | "replace"): void {
    const wasClosed = this.state.mode === "closed";
    let query = this.state.query;
    let didPrefill = false;

    if ((wasClosed || mode === "find") && this.editor.isReady()) {
      const range = this.editor.getCurrentMatchRange();
      const isSearchSelection =
        !wasClosed &&
        this.previousMatchRange !== null &&
        range !== null &&
        range.from === this.previousMatchRange.from &&
        range.to === this.previousMatchRange.to;
      const selectedText = this.editor.getSelectedText();
      const candidate = normalizeSelectionForPrefill(
        selectedText,
        this.state.isRegex,
      );
      if (candidate !== null && !isSearchSelection) {
        query = candidate;
        didPrefill = true;
      }
    }

    this.setState({ mode, query, focusRequestId: this.state.focusRequestId + 1 });
    this.registerEscapeHandler();

    if (query.length > 0 && this.editor.isReady()) {
      if (this.state.isRegex) {
        const validation = validateRegex(query, this.state.caseSensitive);
        if (!validation.valid) {
          this.setState({
            error: "无效的正则表达式",
            matchIndex: 0,
            matchCount: 0,
            isCapped: false,
          });
          this.editor.setSearch(
            "",
            this.state.caseSensitive,
            false,
            this.state.replacement,
          );
          return;
        }
      }
      this.setState({ error: null });
      this.editor.setSearch(
        query,
        this.state.caseSensitive,
        this.state.isRegex,
        this.state.replacement,
      );
      if (wasClosed || didPrefill) {
        const head = this.editor.getCursorHead();
        const result = this.editor.selectNearestMatch(head);
        this.previousMatchRange = this.editor.getCurrentMatchRange();
        this.setState({
          matchCount: result.count,
          matchIndex: result.currentIndex,
          isCapped: result.isCapped,
        });
      } else {
        this.syncMatchesImmediately();
      }
    } else {
      this.setState({
        error: null,
        matchIndex: 0,
        matchCount: 0,
        isCapped: false,
      });
      if (this.editor.isReady()) {
        this.editor.setSearch(
          "",
          this.state.caseSensitive,
          this.state.isRegex,
          this.state.replacement,
        );
      }
    }
  }

  /**
   * Closes the search bar and returns keyboard focus to the editor.
   */
  close(): void {
    if (this.state.mode === "closed") {
      return;
    }
    if (this.countDebounceTimer !== null) {
      clearTimeout(this.countDebounceTimer);
      this.countDebounceTimer = null;
    }
    this.unregisterEscapeHandler();
    this.previousMatchRange = null;
    this.setState({
      mode: "closed",
      error: null,
      matchIndex: 0,
      matchCount: 0,
      isCapped: false,
    });
    if (this.editor.isReady()) {
      this.editor.setSearch(
        "",
        this.state.caseSensitive,
        this.state.isRegex,
        this.state.replacement,
      );
      this.editor.focus();
    }
  }

  /**
   * Invoked when the active document changes or all tabs close.
   * Strictly isolates search state by closing the search bar, canceling pending tasks,
   * and clearing search queries on the newly bound document state regardless of prior mode.
   */
  onDocumentChange(): void {
    if (this.countDebounceTimer !== null) {
      clearTimeout(this.countDebounceTimer);
      this.countDebounceTimer = null;
    }
    this.unregisterEscapeHandler();
    this.previousMatchRange = null;
    this.setState({
      mode: "closed",
      error: null,
      matchIndex: 0,
      matchCount: 0,
      isCapped: false,
    });
    if (this.editor.isReady()) {
      this.editor.setSearch(
        "",
        this.state.caseSensitive,
        this.state.isRegex,
        this.state.replacement,
      );
    }
  }

  /**
   * Invoked on editor state updates (text edits, undo/redo, or selection changes).
   * Updates match counts on edits or resets previousMatchRange when editor cursor moved.
   */
  onEditorStateUpdate(docChanged: boolean): void {
    if (this.state.mode === "closed" || !this.editor.isReady()) {
      return;
    }
    if (docChanged) {
      this.syncMatchesImmediately();
    } else {
      const current = this.editor.getCurrentMatchRange();
      if (
        this.previousMatchRange !== null &&
        current !== null &&
        (current.from !== this.previousMatchRange.from ||
          current.to !== this.previousMatchRange.to)
      ) {
        this.previousMatchRange = null;
        this.syncMatchesImmediately();
      }
    }
  }

  private registerEscapeHandler(): void {
    if (this.escapeUnregister === null && this.escapeManager) {
      this.escapeUnregister = this.escapeManager.register(
        ESCAPE_PRIORITY.TOOL,
        () => {
          this.close();
          return true;
        },
      );
    }
  }

  private unregisterEscapeHandler(): void {
    if (this.escapeUnregister !== null) {
      this.escapeUnregister();
      this.escapeUnregister = null;
    }
  }

  setQuery(query: string): void {
    if (this.state.mode === "closed") {
      return;
    }
    this.setState({ query });
    if (this.countDebounceTimer !== null) {
      clearTimeout(this.countDebounceTimer);
      this.countDebounceTimer = null;
    }

    if (query.length === 0) {
      this.setState({
        error: null,
        matchIndex: 0,
        matchCount: 0,
        isCapped: false,
      });
      this.previousMatchRange = null;
      if (this.editor.isReady()) {
        this.editor.setSearch(
          "",
          this.state.caseSensitive,
          this.state.isRegex,
          this.state.replacement,
        );
      }
      return;
    }

    if (this.state.isRegex) {
      const validation = validateRegex(query, this.state.caseSensitive);
      if (!validation.valid) {
        this.setState({
          error: "无效的正则表达式",
          matchIndex: 0,
          matchCount: 0,
          isCapped: false,
        });
        this.previousMatchRange = null;
        if (this.editor.isReady()) {
          this.editor.setSearch(
            "",
            this.state.caseSensitive,
            false,
            this.state.replacement,
          );
        }
        return;
      }
    }

    this.setState({ error: null });
    if (this.editor.isReady()) {
      this.editor.setSearch(
        query,
        this.state.caseSensitive,
        this.state.isRegex,
        this.state.replacement,
      );

      const currentRange = this.editor.getCurrentMatchRange();
      const isStillAtPreviousMatch =
        this.previousMatchRange !== null &&
        currentRange !== null &&
        currentRange.from === this.previousMatchRange.from &&
        currentRange.to === this.previousMatchRange.to;

      const preferRange =
        isStillAtPreviousMatch && this.previousMatchRange
          ? this.previousMatchRange
          : undefined;
      const fromPos = isStillAtPreviousMatch
        ? undefined
        : this.editor.getCursorHead();

      const immediate = this.editor.selectNearestMatch(fromPos, preferRange);
      this.previousMatchRange = this.editor.getCurrentMatchRange();

      if (immediate.count === 0) {
        this.setState({
          matchCount: 0,
          matchIndex: 0,
          isCapped: false,
        });
      } else {
        this.setState({
          matchIndex: immediate.currentIndex,
        });
        this.scheduleCountUpdate();
      }
    }
  }

  setReplacement(replacement: string): void {
    if (this.state.mode === "closed") {
      return;
    }
    this.setState({ replacement });
  }

  toggleRegex(): void {
    if (this.state.mode === "closed") {
      return;
    }
    const isRegex = !this.state.isRegex;
    this.setState({ isRegex });
    if (this.countDebounceTimer !== null) {
      clearTimeout(this.countDebounceTimer);
      this.countDebounceTimer = null;
    }
    if (this.state.query.length === 0) {
      this.setState({ error: null });
      return;
    }

    if (isRegex) {
      const validation = validateRegex(this.state.query, this.state.caseSensitive);
      if (!validation.valid) {
        this.setState({
          error: "无效的正则表达式",
          matchIndex: 0,
          matchCount: 0,
          isCapped: false,
        });
        this.previousMatchRange = null;
        if (this.editor.isReady()) {
          this.editor.setSearch(
            "",
            this.state.caseSensitive,
            false,
            this.state.replacement,
          );
        }
        return;
      }
    }

    this.setState({ error: null });
    if (this.editor.isReady()) {
      this.editor.setSearch(
        this.state.query,
        this.state.caseSensitive,
        isRegex,
        this.state.replacement,
      );

      const currentRange = this.editor.getCurrentMatchRange();
      const isStillAtPreviousMatch =
        this.previousMatchRange !== null &&
        currentRange !== null &&
        currentRange.from === this.previousMatchRange.from &&
        currentRange.to === this.previousMatchRange.to;

      const preferRange =
        isStillAtPreviousMatch && this.previousMatchRange
          ? this.previousMatchRange
          : undefined;
      const fromPos = isStillAtPreviousMatch
        ? undefined
        : this.editor.getCursorHead();

      const immediate = this.editor.selectNearestMatch(fromPos, preferRange);
      this.previousMatchRange = this.editor.getCurrentMatchRange();

      if (immediate.count === 0) {
        this.setState({
          matchCount: 0,
          matchIndex: 0,
          isCapped: false,
        });
      } else {
        this.setState({
          matchCount: immediate.count,
          matchIndex: immediate.currentIndex,
          isCapped: immediate.isCapped,
        });
      }
    }
  }

  toggleCaseSensitive(): void {
    if (this.state.mode === "closed") {
      return;
    }
    const caseSensitive = !this.state.caseSensitive;
    this.setState({ caseSensitive });
    if (this.countDebounceTimer !== null) {
      clearTimeout(this.countDebounceTimer);
      this.countDebounceTimer = null;
    }
    if (this.state.query.length === 0) {
      this.setState({ error: null });
      return;
    }

    if (this.state.isRegex) {
      const validation = validateRegex(this.state.query, caseSensitive);
      if (!validation.valid) {
        this.setState({
          error: "无效的正则表达式",
          matchIndex: 0,
          matchCount: 0,
          isCapped: false,
        });
        this.previousMatchRange = null;
        if (this.editor.isReady()) {
          this.editor.setSearch(
            "",
            caseSensitive,
            false,
            this.state.replacement,
          );
        }
        return;
      }
    }

    this.setState({ error: null });
    if (this.editor.isReady()) {
      this.editor.setSearch(
        this.state.query,
        caseSensitive,
        this.state.isRegex,
        this.state.replacement,
      );

      const currentRange = this.editor.getCurrentMatchRange();
      const isStillAtPreviousMatch =
        this.previousMatchRange !== null &&
        currentRange !== null &&
        currentRange.from === this.previousMatchRange.from &&
        currentRange.to === this.previousMatchRange.to;

      const preferRange =
        isStillAtPreviousMatch && this.previousMatchRange
          ? this.previousMatchRange
          : undefined;
      const fromPos = isStillAtPreviousMatch
        ? undefined
        : this.editor.getCursorHead();

      const immediate = this.editor.selectNearestMatch(fromPos, preferRange);
      this.previousMatchRange = this.editor.getCurrentMatchRange();

      if (immediate.count === 0) {
        this.setState({
          matchCount: 0,
          matchIndex: 0,
          isCapped: false,
        });
      } else {
        this.setState({
          matchCount: immediate.count,
          matchIndex: immediate.currentIndex,
          isCapped: immediate.isCapped,
        });
      }
    }
  }

  findNext(): void {
    if (
      this.state.mode === "closed" ||
      this.state.query.length === 0 ||
      this.state.error !== null ||
      !this.editor.isReady()
    ) {
      return;
    }
    this.editor.findNext();
    this.previousMatchRange = this.editor.getCurrentMatchRange();
    this.syncMatchesImmediately();
  }

  findPrevious(): void {
    if (
      this.state.mode === "closed" ||
      this.state.query.length === 0 ||
      this.state.error !== null ||
      !this.editor.isReady()
    ) {
      return;
    }
    this.editor.findPrevious();
    this.previousMatchRange = this.editor.getCurrentMatchRange();
    this.syncMatchesImmediately();
  }

  replaceNext(): void {
    if (
      this.state.mode === "closed" ||
      this.state.query.length === 0 ||
      this.state.error !== null ||
      !this.editor.isReady()
    ) {
      return;
    }
    this.editor.replaceNext(
      this.state.query,
      this.state.replacement,
      this.state.caseSensitive,
      this.state.isRegex,
    );
    this.previousMatchRange = this.editor.getCurrentMatchRange();
    this.syncMatchesImmediately();
  }

  replaceAll(): void {
    if (
      this.state.mode === "closed" ||
      this.state.query.length === 0 ||
      this.state.error !== null ||
      !this.editor.isReady()
    ) {
      return;
    }
    this.editor.replaceAll(
      this.state.query,
      this.state.replacement,
      this.state.caseSensitive,
      this.state.isRegex,
    );
    this.previousMatchRange = this.editor.getCurrentMatchRange();
    this.syncMatchesImmediately();
  }

  /**
   * Synchronizes match count and current match index immediately without debounce.
   */
  syncMatchesImmediately(): void {
    if (this.countDebounceTimer !== null) {
      clearTimeout(this.countDebounceTimer);
      this.countDebounceTimer = null;
    }
    if (
      this.state.mode === "closed" ||
      !this.editor.isReady() ||
      this.state.query.length === 0 ||
      this.state.error !== null
    ) {
      return;
    }
    const result = this.editor.countMatches(
      this.state.query,
      this.state.caseSensitive,
      this.state.isRegex,
    );
    this.setState({
      matchCount: result.count,
      matchIndex: result.currentIndex,
      isCapped: result.isCapped,
    });
  }

  private scheduleCountUpdate(): void {
    if (this.countDebounceTimer !== null) {
      clearTimeout(this.countDebounceTimer);
    }
    this.countDebounceTimer = setTimeout(() => {
      this.countDebounceTimer = null;
      if (
        this.state.mode === "closed" ||
        !this.editor.isReady() ||
        this.state.query.length === 0 ||
        this.state.error !== null
      ) {
        return;
      }
      const result = this.editor.countMatches(
        this.state.query,
        this.state.caseSensitive,
        this.state.isRegex,
      );
      this.setState({
        matchCount: result.count,
        matchIndex: result.currentIndex,
        isCapped: result.isCapped,
      });
    }, 100);
  }
}
