import { describe, expect, it, vi } from "vitest";

import {
  createEscapeManager,
  ESCAPE_PRIORITY,
  EscapeManager,
} from "./escapeManager";

describe("EscapeManager hierarchical dismissal", () => {
  it("dispatches to the highest priority handler first", () => {
    const manager = new EscapeManager();
    const calls: string[] = [];

    manager.register(ESCAPE_PRIORITY.TOOL, () => {
      calls.push("tool");
    });
    manager.register(ESCAPE_PRIORITY.MODAL, () => {
      calls.push("modal");
    });
    manager.register(ESCAPE_PRIORITY.POPUP, () => {
      calls.push("popup");
    });

    // 1st dispatch should hit modal (priority 40)
    const handled1 = manager.dispatch();
    expect(handled1).toBe(true);
    expect(calls).toEqual(["modal"]);
  });

  it("handles LIFO order for handlers with equal priority", () => {
    const manager = new EscapeManager();
    const calls: string[] = [];

    manager.register(ESCAPE_PRIORITY.TOOL, () => {
      calls.push("tool-1");
    });
    manager.register(ESCAPE_PRIORITY.TOOL, () => {
      calls.push("tool-2");
    });

    const handled = manager.dispatch();
    expect(handled).toBe(true);
    // tool-2 registered later than tool-1, so it should run first
    expect(calls).toEqual(["tool-2"]);
  });

  it("falls through to lower priority if handler returns false", () => {
    const manager = new EscapeManager();
    const calls: string[] = [];

    manager.register(ESCAPE_PRIORITY.TOOL, () => {
      calls.push("tool");
      return true;
    });
    manager.register(ESCAPE_PRIORITY.MODAL, () => {
      calls.push("modal-skipped");
      return false; // not handled
    });

    const handled = manager.dispatch();
    expect(handled).toBe(true);
    expect(calls).toEqual(["modal-skipped", "tool"]);
  });

  it("unregisters handlers properly via cleanup function", () => {
    const manager = createEscapeManager();
    const calls: string[] = [];

    const unregisterModal = manager.register(ESCAPE_PRIORITY.MODAL, () => {
      calls.push("modal");
    });
    manager.register(ESCAPE_PRIORITY.TOOL, () => {
      calls.push("tool");
    });

    expect(manager.count).toBe(2);

    // Unregister modal
    unregisterModal();
    expect(manager.count).toBe(1);

    const handled = manager.dispatch();
    expect(handled).toBe(true);
    expect(calls).toEqual(["tool"]);
  });

  it("returns false when no handlers are registered", () => {
    const manager = createEscapeManager();
    expect(manager.dispatch()).toBe(false);
  });

  it("handles keyboard events and prevents default only when handled", () => {
    const manager = createEscapeManager();
    let toolClosed = false;

    manager.register(ESCAPE_PRIORITY.TOOL, () => {
      toolClosed = true;
    });

    const nonEscEvent = {
      key: "Enter",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    expect(manager.handleKeyboardEvent(nonEscEvent)).toBe(false);
    expect(nonEscEvent.preventDefault).not.toHaveBeenCalled();
    expect(toolClosed).toBe(false);

    const escEvent = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    expect(manager.handleKeyboardEvent(escEvent)).toBe(true);
    expect(escEvent.preventDefault).toHaveBeenCalled();
    expect(escEvent.stopPropagation).toHaveBeenCalled();
    expect(toolClosed).toBe(true);
  });

  it("dismisses through the full hierarchy: Modal -> Popup -> Tool -> MultiSelection -> MainSelection -> Cursor", () => {
    const manager = createEscapeManager();
    const dismissed: string[] = [];

    let modalOpen = true;
    let menuPopupOpen = true;
    let searchOpen = true;
    let selectionRanges = 3;
    let hasSelectedText = true;
    let editorHasFocus = true;

    // Priority 40: Modal
    const unregisterModal = manager.register(ESCAPE_PRIORITY.MODAL, () => {
      if (modalOpen) {
        modalOpen = false;
        dismissed.push("modal");
        unregisterModal();
        return true;
      }
      return false;
    });

    // Priority 30: Popup (Menu/Context Menu/Popover)
    const unregisterPopup = manager.register(ESCAPE_PRIORITY.POPUP, () => {
      if (menuPopupOpen) {
        menuPopupOpen = false;
        dismissed.push("popup");
        unregisterPopup();
        return true;
      }
      return false;
    });

    // Priority 20: Search bar
    const unregisterSearch = manager.register(ESCAPE_PRIORITY.TOOL, () => {
      if (searchOpen) {
        searchOpen = false;
        dismissed.push("search");
        unregisterSearch();
        return true;
      }
      return false;
    });

    // Priority 0: Editor selection simplification
    manager.register(ESCAPE_PRIORITY.EDITOR, () => {
      if (!editorHasFocus) {
        return false;
      }
      if (selectionRanges > 1) {
        selectionRanges = 1;
        dismissed.push("collapse-to-main");
        return true;
      }
      if (hasSelectedText) {
        hasSelectedText = false;
        dismissed.push("collapse-to-cursor");
        return true;
      }
      return false;
    });

    // Step 1: Escape closes modal (priority 40), leaving popup/tool/editor untouched
    expect(manager.dispatch()).toBe(true);
    expect(dismissed).toEqual(["modal"]);

    // Step 2: Escape closes menu/popup (priority 30), leaving search/editor untouched
    expect(manager.dispatch()).toBe(true);
    expect(dismissed).toEqual(["modal", "popup"]);

    // Step 3: Escape closes search bar (priority 20), leaving editor untouched
    expect(manager.dispatch()).toBe(true);
    expect(dismissed).toEqual(["modal", "popup", "search"]);

    // Step 4: When editor lacks focus, editor escape does not consume (e.g. Explorer inline input active)
    editorHasFocus = false;
    expect(manager.dispatch()).toBe(false);
    expect(dismissed).toEqual(["modal", "popup", "search"]);

    // Step 5: When editor has focus, collapses multiple selections to main
    editorHasFocus = true;
    expect(manager.dispatch()).toBe(true);
    expect(dismissed).toEqual(["modal", "popup", "search", "collapse-to-main"]);

    // Step 6: Escape collapses main selection to cursor
    expect(manager.dispatch()).toBe(true);
    expect(dismissed).toEqual(["modal", "popup", "search", "collapse-to-main", "collapse-to-cursor"]);

    // Step 7: Escape on empty cursor returns false
    expect(manager.dispatch()).toBe(false);
    expect(dismissed).toEqual(["modal", "popup", "search", "collapse-to-main", "collapse-to-cursor"]);
  });

  it("dismisses nested submenus before parent menu when registered dynamically", () => {
    const manager = createEscapeManager();
    const closed: string[] = [];

    // Parent menu opens
    const unregisterParent = manager.register(ESCAPE_PRIORITY.POPUP, () => {
      closed.push("parent-menu");
      unregisterParent();
      return true;
    });

    // Submenu opens afterwards
    const unregisterSubmenu = manager.register(ESCAPE_PRIORITY.POPUP, () => {
      closed.push("sub-menu");
      unregisterSubmenu();
      return true;
    });

    // 1st Esc: closes submenu
    expect(manager.dispatch()).toBe(true);
    expect(closed).toEqual(["sub-menu"]);

    // 2nd Esc: closes parent menu
    expect(manager.dispatch()).toBe(true);
    expect(closed).toEqual(["sub-menu", "parent-menu"]);

    // 3rd Esc: nothing left to close
    expect(manager.dispatch()).toBe(false);
  });
});
