import type { EditorHandle } from "../../editor/editorHandle";
import { ESCAPE_PRIORITY, type EscapeManager } from "../commands/escapeManager";
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
   * If editor has selected text, pre-fills the query.
   */
  open(mode: "find" | "replace"): void {
    const selectedText = this.editor.isReady()
      ? this.editor.getSelectedText()
      : "";
    const candidate = normalizeSelectionForPrefill(selectedText);
    const query = candidate ?? this.state.query;

    this.setState({ mode, query });
    this.registerEscapeHandler();

    if (query.length > 0 && this.editor.isReady()) {
      this.editor.setSearch(
        query,
        this.state.caseSensitive,
        this.state.replacement,
      );
      this.syncMatchesImmediately();
    }
  }

  /**
   * Closes the search bar and returns keyboard focus to the editor.
   */
  close(): void {
    if (this.state.mode === "closed") {
      return;
    }
    this.unregisterEscapeHandler();
    this.setState({
      mode: "closed",
      matchIndex: 0,
      matchCount: 0,
      isCapped: false,
    });
    if (this.editor.isReady()) {
      this.editor.setSearch(
        "",
        this.state.caseSensitive,
        this.state.replacement,
      );
      this.editor.focus();
    }
  }

  /**
   * Invoked when the active document changes or all tabs close.
   * Strictly isolates search state by closing the search bar.
   */
  onDocumentChange(): void {
    if (this.state.mode !== "closed") {
      this.unregisterEscapeHandler();
      this.setState({
        mode: "closed",
        matchIndex: 0,
        matchCount: 0,
        isCapped: false,
      });
      if (this.editor.isReady()) {
        this.editor.setSearch(
          "",
          this.state.caseSensitive,
          this.state.replacement,
        );
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
    this.setState({ query });
    if (this.editor.isReady()) {
      this.editor.setSearch(
        query,
        this.state.caseSensitive,
        this.state.replacement,
      );
      this.scheduleCountUpdate();
    }
  }

  setReplacement(replacement: string): void {
    this.setState({ replacement });
  }

  toggleCaseSensitive(): void {
    const caseSensitive = !this.state.caseSensitive;
    this.setState({ caseSensitive });
    if (this.editor.isReady()) {
      this.editor.setSearch(
        this.state.query,
        caseSensitive,
        this.state.replacement,
      );
      this.syncMatchesImmediately();
    }
  }

  findNext(): void {
    if (this.state.query.length === 0 || !this.editor.isReady()) {
      return;
    }
    this.editor.findNext();
    this.syncMatchesImmediately();
  }

  findPrevious(): void {
    if (this.state.query.length === 0 || !this.editor.isReady()) {
      return;
    }
    this.editor.findPrevious();
    this.syncMatchesImmediately();
  }

  replaceNext(): void {
    if (this.state.query.length === 0 || !this.editor.isReady()) {
      return;
    }
    this.editor.replaceNext(
      this.state.query,
      this.state.replacement,
      this.state.caseSensitive,
    );
    this.syncMatchesImmediately();
  }

  replaceAll(): void {
    if (this.state.query.length === 0 || !this.editor.isReady()) {
      return;
    }
    this.editor.replaceAll(
      this.state.query,
      this.state.replacement,
      this.state.caseSensitive,
    );
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
    if (!this.editor.isReady()) {
      return;
    }
    const result = this.editor.countMatches(
      this.state.query,
      this.state.caseSensitive,
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
      if (!this.editor.isReady()) {
        return;
      }
      const result = this.editor.countMatches(
        this.state.query,
        this.state.caseSensitive,
      );
      this.setState({
        matchCount: result.count,
        matchIndex: result.currentIndex,
        isCapped: result.isCapped,
      });
    }, 100);
  }
}
