import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";

import type { EditorHandle, SearchMatchesResult } from "../../editor/editorHandle";
import { createEscapeManager } from "../commands/escapeManager";
import { INVALID_REGEX_ERROR } from "./searchEngine";
import { SearchController } from "./searchController";
import {
  formatMatchCountLabel,
  isImeKeyboardEvent,
  normalizeSelectionForPrefill,
} from "./searchModel";

class MockEditorHandle implements Partial<EditorHandle> {
  selectedText = "";
  cursorHead = 0;
  currentMatchRange: { from: number; to: number } | null = null;
  ready = true;
  focused = false;

  lastSearchQuery = "";
  lastCaseSensitive = false;
  lastReplacement = "";
  lastIsRegex = false;

  findNextCalled = 0;
  findPreviousCalled = 0;
  replaceNextCalled = 0;
  replaceAllCalled = 0;

  mockMatchesResult: SearchMatchesResult = {
    count: 3,
    currentIndex: 1,
    isCapped: false,
  };

  isReady(): boolean {
    return this.ready;
  }

  getSelectedText(): string {
    return this.selectedText;
  }

  getCursorHead(): number {
    return this.cursorHead;
  }

  getCurrentMatchRange(): { from: number; to: number } | null {
    return this.currentMatchRange;
  }

  selectNearestMatch(
    _fromPos?: number,
    _preferCurrentRange?: { from: number; to: number },
  ): SearchMatchesResult {
    return this.mockMatchesResult;
  }

  setSearch(
    query: string,
    caseSensitive: boolean,
    isRegex = false,
    replacement = "",
  ): void {
    this.lastSearchQuery = query;
    this.lastCaseSensitive = caseSensitive;
    this.lastIsRegex = isRegex;
    this.lastReplacement = replacement;
  }

  findNext(): void {
    this.findNextCalled += 1;
  }

  findPrevious(): void {
    this.findPreviousCalled += 1;
  }

  replaceNext(
    query: string,
    replacement: string,
    caseSensitive: boolean,
    isRegex = false,
  ): void {
    this.replaceNextCalled += 1;
    this.lastSearchQuery = query;
    this.lastReplacement = replacement;
    this.lastCaseSensitive = caseSensitive;
    this.lastIsRegex = isRegex;
  }

  replaceAll(
    query: string,
    replacement: string,
    caseSensitive: boolean,
    isRegex = false,
  ): void {
    this.replaceAllCalled += 1;
    this.lastSearchQuery = query;
    this.lastReplacement = replacement;
    this.lastCaseSensitive = caseSensitive;
    this.lastIsRegex = isRegex;
  }

  countMatches(): SearchMatchesResult {
    return this.mockMatchesResult;
  }

  focus(): void {
    this.focused = true;
  }
}

describe("isImeKeyboardEvent", () => {
  it("detects standard DOM isComposing property", () => {
    expect(isImeKeyboardEvent({ key: "Enter", isComposing: true })).toBe(true);
    expect(isImeKeyboardEvent({ key: "Enter", isComposing: false })).toBe(false);
  });

  it("detects React synthetic nativeEvent.isComposing property", () => {
    expect(
      isImeKeyboardEvent({
        key: "Enter",
        nativeEvent: { isComposing: true },
      }),
    ).toBe(true);
    expect(
      isImeKeyboardEvent({
        key: "Enter",
        nativeEvent: { isComposing: false },
      }),
    ).toBe(false);
  });

  it("detects standard IME keyCode 229 and Process key identifiers", () => {
    expect(isImeKeyboardEvent({ key: "Enter", keyCode: 229 })).toBe(true);
    expect(isImeKeyboardEvent({ key: "Process" })).toBe(true);
  });

  it("honors active component composition state", () => {
    expect(isImeKeyboardEvent({ key: "Escape" }, true)).toBe(true);
    expect(isImeKeyboardEvent({ key: "Escape" }, false)).toBe(false);
  });
});

describe("normalizeSelectionForPrefill", () => {
  it("accepts normal single-line text", () => {
    expect(normalizeSelectionForPrefill("hello")).toBe("hello");
    expect(normalizeSelectionForPrefill("foo_bar_123")).toBe("foo_bar_123");
  });

  it("escapes regex special characters when isRegex is true", () => {
    expect(normalizeSelectionForPrefill("item.foo[0]*", true)).toBe(
      "item\\.foo\\[0\\]\\*",
    );
  });

  it("rejects empty or whitespace-only text", () => {
    expect(normalizeSelectionForPrefill("")).toBeNull();
    expect(normalizeSelectionForPrefill("   ")).toBeNull();
  });

  it("rejects multi-line text", () => {
    expect(normalizeSelectionForPrefill("hello\nworld")).toBeNull();
    expect(normalizeSelectionForPrefill("hello\r\nworld")).toBeNull();
  });

  it("rejects text longer than 200 characters", () => {
    const longText = "a".repeat(201);
    expect(normalizeSelectionForPrefill(longText)).toBeNull();
    const exactly200 = "a".repeat(200);
    expect(normalizeSelectionForPrefill(exactly200)).toBe(exactly200);
  });
});

describe("formatMatchCountLabel", () => {
  it("returns empty string when query is empty", () => {
    expect(formatMatchCountLabel("", 0, 0, false)).toBe("");
  });

  it("returns '0 个结果' when no matches", () => {
    expect(formatMatchCountLabel("foo", 0, 0, false)).toBe("0 个结果");
  });

  it("returns index and total when matchIndex > 0", () => {
    expect(formatMatchCountLabel("foo", 15, 3, false)).toBe("3 / 15");
  });

  it("appends '+' when count is capped", () => {
    expect(formatMatchCountLabel("foo", 1000, 5, true)).toBe("5 / 1000+");
    expect(formatMatchCountLabel("foo", 1000, 0, true)).toBe("1000+ 个结果");
  });

  it("displays in-place error message when error is non-null", () => {
    expect(
      formatMatchCountLabel("foo", 0, 0, false, INVALID_REGEX_ERROR),
    ).toBe("无效的正则表达式");
    expect(
      formatMatchCountLabel("foo", 0, 0, false, "custom-error"),
    ).toBe("custom-error");
  });
});

describe("SearchController", () => {
  it("initializes with closed mode", () => {
    const editor = new MockEditorHandle() as unknown as EditorHandle;
    const controller = new SearchController(editor);
    expect(controller.getState().mode).toBe("closed");
  });

  it("pre-fills query when selection exists and opens in find mode", () => {
    const editor = new MockEditorHandle();
    editor.selectedText = "myFunction";
    const controller = new SearchController(editor as unknown as EditorHandle);

    controller.open("find");

    expect(controller.getState().mode).toBe("find");
    expect(controller.getState().query).toBe("myFunction");
    expect(editor.lastSearchQuery).toBe("myFunction");
  });

  it("escapes candidate selection when prefilling in regex mode", () => {
    const editor = new MockEditorHandle();
    editor.selectedText = "foo.bar[1]";
    const controller = new SearchController(editor as unknown as EditorHandle);

    // Open first to toggle regex
    controller.open("find");
    controller.toggleRegex();
    controller.close();

    // Reopen with new selection
    controller.open("find");
    expect(controller.getState().query).toBe("foo\\.bar\\[1\\]");
  });

  it("retains existing query and replacement across find and replace mode switches without re-prefilling", () => {
    const editor = new MockEditorHandle();
    editor.selectedText = "highlightedMatch";
    const controller = new SearchController(editor as unknown as EditorHandle);

    controller.open("find");
    controller.setQuery("alpha");
    controller.setReplacement("beta");

    expect(controller.getState().query).toBe("alpha");
    expect(controller.getState().replacement).toBe("beta");

    // Editor now has selected text from a match, but switching mode must NOT overwrite query
    editor.selectedText = "alphaMatch";
    controller.open("replace");
    expect(controller.getState().mode).toBe("replace");
    expect(controller.getState().query).toBe("alpha");
    expect(controller.getState().replacement).toBe("beta");
  });

  it.each([false, true])("prefills a new manual selection on repeated Find (regex=%s)", (isRegex) => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);
    controller.open("find");
    if (isRegex) controller.toggleRegex();
    editor.currentMatchRange = { from: 0, to: 4 };
    controller.setQuery("item");

    editor.currentMatchRange = { from: 20, to: 27 };
    editor.cursorHead = 27;
    editor.selectedText = "foo.[x]";
    controller.onEditorStateUpdate(false);
    const nearest = vi.spyOn(editor, "selectNearestMatch");
    controller.open("find");

    expect(controller.getState().query).toBe(isRegex ? "foo\\.\\[x\\]" : "foo.[x]");
    expect(editor.lastSearchQuery).toBe(controller.getState().query);
    expect(controller.getState().isRegex).toBe(isRegex);
    expect(nearest).toHaveBeenCalledWith(27);
    controller.close();
  });

  it("prefills a new manual selection when Find is invoked from Replace mode", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);
    controller.open("replace");
    controller.toggleRegex();
    editor.currentMatchRange = { from: 0, to: 5 };
    controller.setQuery("item\\d+");
    controller.setReplacement("$&!");

    editor.currentMatchRange = { from: 20, to: 27 };
    editor.cursorHead = 27;
    editor.selectedText = "foo.[x]";
    controller.onEditorStateUpdate(false);
    const focusBefore = controller.getState().focusRequestId;
    controller.open("find");

    expect(controller.getState()).toMatchObject({
      mode: "find", query: "foo\\.\\[x\\]", replacement: "$&!", isRegex: true,
      focusRequestId: focusBefore + 1,
    });
    expect(editor.lastSearchQuery).toBe("foo\\.\\[x\\]");
    controller.close();
  });

  it("preserves a regex and current match when repeated Find sees its automatic selection", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);
    controller.open("find");
    controller.toggleRegex();
    editor.currentMatchRange = { from: 10, to: 15 };
    controller.setQuery("item\\d+");
    editor.selectedText = "item1";
    const nearest = vi.spyOn(editor, "selectNearestMatch");
    const focusBefore = controller.getState().focusRequestId;

    controller.open("find");
    controller.open("find");

    expect(controller.getState().query).toBe("item\\d+");
    expect(editor.currentMatchRange).toEqual({ from: 10, to: 15 });
    expect(nearest).not.toHaveBeenCalled();
    expect(controller.getState().focusRequestId).toBe(focusBefore + 2);
    controller.close();
  });

  it("requests focus again without a new selection, but never for query or feedback updates", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);
    controller.open("find");
    const firstRequest = controller.getState().focusRequestId;
    controller.setQuery("existing");
    controller.syncMatchesImmediately();
    expect(controller.getState().focusRequestId).toBe(firstRequest);

    controller.open("find");
    expect(controller.getState().query).toBe("existing");
    expect(controller.getState().focusRequestId).toBe(firstRequest + 1);
    controller.close();
  });

  it("keeps query, options, and current match across presentation mode changes", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);
    controller.open("find");
    controller.toggleRegex();
    controller.toggleCaseSensitive();
    editor.currentMatchRange = { from: 10, to: 15 };
    controller.setQuery("item\\d+");
    controller.setReplacement("$&!");
    editor.selectedText = "item1";
    const nearest = vi.spyOn(editor, "selectNearestMatch");
    controller.open("replace");
    controller.open("find");

    expect(controller.getState()).toMatchObject({
      query: "item\\d+", replacement: "$&!", isRegex: true, caseSensitive: true,
    });
    expect(editor.currentMatchRange).toEqual({ from: 10, to: 15 });
    expect(nearest).not.toHaveBeenCalled();
    controller.close();
  });

  it("closes and resets mode and clears editor search query", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);

    controller.open("find");
    controller.setQuery("test");
    controller.close();

    expect(controller.getState().mode).toBe("closed");
    expect(editor.lastSearchQuery).toBe("");
    expect(editor.focused).toBe(true);
  });

  it("automatically closes when onDocumentChange is called (Tab isolation)", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);

    controller.open("find");
    controller.setQuery("isolate");

    controller.onDocumentChange();

    expect(controller.getState().mode).toBe("closed");
    expect(editor.lastSearchQuery).toBe("");
  });

  it("clears editor search query on onDocumentChange even when controller mode is already closed", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);

    // Initial state: search was already closed
    expect(controller.getState().mode).toBe("closed");

    // Simulate switching back to a tab whose EditorState held a previous search query
    editor.lastSearchQuery = "lingeringOldQuery";
    controller.onDocumentChange();

    // Must clear the newly bound state's search query to prevent ghost highlights
    expect(editor.lastSearchQuery).toBe("");
    expect(controller.getState().mode).toBe("closed");
  });

  it("ignores late setQuery, toggle, and replacement calls when controller is closed", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);

    expect(controller.getState().mode).toBe("closed");
    editor.lastSearchQuery = "";

    // Late setQuery (e.g. late compositionend after close)
    controller.setQuery("lateInput");
    expect(editor.lastSearchQuery).toBe("");
    expect(controller.getState().query).toBe("");

    // Late toggleRegex
    controller.toggleRegex();
    expect(controller.getState().isRegex).toBe(false);

    // Late toggleCaseSensitive
    controller.toggleCaseSensitive();
    expect(controller.getState().caseSensitive).toBe(false);

    // Late setReplacement
    controller.setReplacement("lateReplacement");
    expect(controller.getState().replacement).toBe("");
  });

  it("searches from getCursorHead when editor selection was moved manually", () => {
    const editor = new MockEditorHandle();
    editor.cursorHead = 45;
    const controller = new SearchController(editor as unknown as EditorHandle);

    controller.open("find");
    editor.selectNearestMatch = vi.fn().mockReturnValue({ count: 1, currentIndex: 1, isCapped: false });

    // Moving cursor manually
    editor.currentMatchRange = { from: 40, to: 45 };
    editor.cursorHead = 45;
    controller.onEditorStateUpdate(false);

    controller.setQuery("test");
    expect(editor.selectNearestMatch).toHaveBeenCalledWith(45, undefined);
  });

  it("toggles case sensitivity and updates editor search", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);

    controller.open("find");
    controller.setQuery("case");

    expect(controller.getState().caseSensitive).toBe(false);

    controller.toggleCaseSensitive();
    expect(controller.getState().caseSensitive).toBe(true);
    expect(editor.lastCaseSensitive).toBe(true);
  });

  it("toggles regex mode and guards against invalid regex expressions", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);

    controller.open("find");
    controller.toggleRegex();
    expect(controller.getState().isRegex).toBe(true);

    // Invalid regex
    controller.setQuery("[unclosed");
    expect(controller.getState().error).toBe("invalid-regex");
    expect(controller.getState().matchCount).toBe(0);
    expect(controller.getState().matchIndex).toBe(0);
    expect(editor.lastSearchQuery).toBe("");

    // Navigation and replace are guarded when error is present
    controller.findNext();
    expect(editor.findNextCalled).toBe(0);
    controller.replaceNext();
    expect(editor.replaceNextCalled).toBe(0);

    // Fixed regex
    controller.setQuery("[closed]");
    expect(controller.getState().error).toBeNull();
    expect(editor.lastSearchQuery).toBe("[closed]");
  });

  it("immediately clears match count to 0 when query produces no matches without waiting for debounce", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);

    controller.open("find");
    // Initially has 3 matches
    editor.mockMatchesResult = { count: 3, currentIndex: 1, isCapped: false };
    controller.setQuery("abc");
    expect(controller.getState().matchIndex).toBe(1);

    // Now query produces 0 matches
    editor.mockMatchesResult = { count: 0, currentIndex: 0, isCapped: false };
    controller.setQuery("abcd");

    // Count is cleared immediately to 0 rather than waiting 100ms
    expect(controller.getState().matchCount).toBe(0);
    expect(controller.getState().matchIndex).toBe(0);
  });

  it("schedules 100ms debounce for positive match count updates", () => {
    vi.useFakeTimers();
    try {
      const editor = new MockEditorHandle();
      const controller = new SearchController(editor as unknown as EditorHandle);

      controller.open("find");
      editor.mockMatchesResult = { count: 42, currentIndex: 2, isCapped: false };
      controller.setQuery("debounced");

      // matchIndex is immediate
      expect(controller.getState().matchIndex).toBe(2);
      // matchCount updates after debounce
      expect(controller.getState().matchCount).toBe(0);

      vi.advanceTimersByTime(100);
      expect(controller.getState().matchCount).toBe(42);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears previousMatchRange and updates count when editor cursor is moved externally", () => {
    const editor = new MockEditorHandle();
    editor.currentMatchRange = { from: 10, to: 15 };
    editor.cursorHead = 100;
    const controller = new SearchController(editor as unknown as EditorHandle);

    controller.open("find");
    controller.setQuery("match");

    // External cursor move in editor
    editor.currentMatchRange = { from: 100, to: 100 };
    controller.onEditorStateUpdate(false);

    // When typing continues, previousMatchRange is no longer used, getCursorHead is passed
    editor.selectNearestMatch = vi.fn().mockReturnValue({ count: 1, currentIndex: 1, isCapped: false });
    controller.setQuery("match2");

    expect(editor.selectNearestMatch).toHaveBeenCalledWith(100, undefined);
  });

  it("immediately syncs matches when document content changes via onEditorStateUpdate(true)", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);

    controller.open("find");
    controller.setQuery("item");

    editor.mockMatchesResult = { count: 99, currentIndex: 5, isCapped: false };
    controller.onEditorStateUpdate(true);

    expect(controller.getState().matchCount).toBe(99);
    expect(controller.getState().matchIndex).toBe(5);
  });

  it("dispatches navigation and replacement operations", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);

    controller.open("replace");
    controller.setQuery("old");
    controller.setReplacement("new");

    controller.findNext();
    expect(editor.findNextCalled).toBe(1);

    controller.findPrevious();
    expect(editor.findPreviousCalled).toBe(1);

    controller.replaceNext();
    expect(editor.replaceNextCalled).toBe(1);
    expect(editor.lastReplacement).toBe("new");

    controller.replaceAll();
    expect(editor.replaceAllCalled).toBe(1);
  });

  it("registers with EscapeManager on open and exits on Escape dispatch", () => {
    const editor = new MockEditorHandle();
    const escapeManager = createEscapeManager();
    const controller = new SearchController(
      editor as unknown as EditorHandle,
      escapeManager,
    );

    expect(escapeManager.count).toBe(0);

    // Open search bar -> registers with escapeManager
    controller.open("find");
    controller.setQuery("test");
    expect(controller.getState().mode).toBe("find");
    expect(escapeManager.count).toBe(1);

    // Dispatching Escape via EscapeManager (e.g. focus in editor or outside search box)
    const handled = escapeManager.dispatch();
    expect(handled).toBe(true);
    expect(controller.getState().mode).toBe("closed");
    expect(editor.lastSearchQuery).toBe("");
    expect(editor.focused).toBe(true);
    expect(escapeManager.count).toBe(0);
  });

  it("unregisters from EscapeManager when switching tabs or closing", () => {
    const editor = new MockEditorHandle();
    const escapeManager = createEscapeManager();
    const controller = new SearchController(
      editor as unknown as EditorHandle,
      escapeManager,
    );

    controller.open("replace");
    expect(escapeManager.count).toBe(1);

    controller.onDocumentChange();
    expect(controller.getState().mode).toBe("closed");
    expect(escapeManager.count).toBe(0);

    // Open and close manually
    controller.open("find");
    expect(escapeManager.count).toBe(1);
    controller.close();
    expect(escapeManager.count).toBe(0);
  });

  it("formats match count and error labels dynamically without freezing on locale", async () => {
    expect(formatMatchCountLabel("foo", 0, 0, false)).toBe("0 个结果");
    expect(formatMatchCountLabel("foo", 15, 0, false)).toBe("15 个结果");
    expect(formatMatchCountLabel("foo", 1000, 0, true)).toBe("1000+ 个结果");
    expect(formatMatchCountLabel("foo", 15, 3, false)).toBe("3 / 15");
    expect(formatMatchCountLabel("foo", 0, 0, false, INVALID_REGEX_ERROR)).toBe("无效的正则表达式");
    expect(formatMatchCountLabel("foo", 0, 0, false, "native diagnostic")).toBe("native diagnostic");

    await i18n.changeLanguage("en-US");
    try {
      expect(formatMatchCountLabel("foo", 0, 0, false)).toBe("0 results");
      expect(formatMatchCountLabel("foo", 15, 0, false)).toBe("15 results");
      expect(formatMatchCountLabel("foo", 1000, 0, true)).toBe("1000+ results");
      expect(formatMatchCountLabel("foo", 15, 3, false)).toBe("3 / 15");
      expect(formatMatchCountLabel("foo", 0, 0, false, INVALID_REGEX_ERROR)).toBe("Invalid regular expression");
      expect(formatMatchCountLabel("foo", 0, 0, false, "native diagnostic")).toBe("native diagnostic");
    } finally {
      await i18n.changeLanguage("zh-CN");
    }
  });

  it("ensures regex error business state uses stable discriminator and functions identically across locales", async () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);
    controller.open("find");
    controller.toggleRegex();

    controller.setQuery("[unclosed");
    // Business state holds the stable identifier 'invalid-regex'
    expect(controller.getState().error).toBe("invalid-regex");
    expect(controller.getState().error !== null).toBe(true);

    // Business guards hold: navigation is blocked
    controller.findNext();
    expect(editor.findNextCalled).toBe(0);

    // Switch to en-US: business state remains stable 'invalid-regex'
    await i18n.changeLanguage("en-US");
    try {
      expect(controller.getState().error).toBe("invalid-regex");
      controller.findNext();
      expect(editor.findNextCalled).toBe(0);
    } finally {
      await i18n.changeLanguage("zh-CN");
    }
  });
});
