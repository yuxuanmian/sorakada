import { describe, expect, it } from "vitest";

import type { EditorHandle, SearchMatchesResult } from "../../editor/editorHandle";
import { createEscapeManager } from "../commands/escapeManager";
import { SearchController } from "./searchController";
import {
  formatMatchCountLabel,
  normalizeSelectionForPrefill,
} from "./searchModel";

class MockEditorHandle implements Partial<EditorHandle> {
  selectedText = "";
  ready = true;
  focused = false;

  lastSearchQuery = "";
  lastCaseSensitive = false;
  lastReplacement = "";

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

  setSearch(query: string, caseSensitive: boolean, replacement = ""): void {
    this.lastSearchQuery = query;
    this.lastCaseSensitive = caseSensitive;
    this.lastReplacement = replacement;
  }

  findNext(): void {
    this.findNextCalled += 1;
  }

  findPrevious(): void {
    this.findPreviousCalled += 1;
  }

  replaceNext(query: string, replacement: string, caseSensitive: boolean): void {
    this.replaceNextCalled += 1;
    this.lastSearchQuery = query;
    this.lastReplacement = replacement;
    this.lastCaseSensitive = caseSensitive;
  }

  replaceAll(query: string, replacement: string, caseSensitive: boolean): void {
    this.replaceAllCalled += 1;
    this.lastSearchQuery = query;
    this.lastReplacement = replacement;
    this.lastCaseSensitive = caseSensitive;
  }

  countMatches(): SearchMatchesResult {
    return this.mockMatchesResult;
  }

  focus(): void {
    this.focused = true;
  }
}

describe("normalizeSelectionForPrefill", () => {
  it("accepts normal single-line text", () => {
    expect(normalizeSelectionForPrefill("hello")).toBe("hello");
    expect(normalizeSelectionForPrefill("foo_bar_123")).toBe("foo_bar_123");
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

  it("retains existing query and replacement across find and replace mode switches", () => {
    const editor = new MockEditorHandle();
    const controller = new SearchController(editor as unknown as EditorHandle);

    controller.open("find");
    controller.setQuery("alpha");
    controller.setReplacement("beta");

    expect(controller.getState().query).toBe("alpha");
    expect(controller.getState().replacement).toBe("beta");

    // Switch to replace mode
    controller.open("replace");
    expect(controller.getState().mode).toBe("replace");
    expect(controller.getState().query).toBe("alpha");
    expect(controller.getState().replacement).toBe("beta");
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
});
