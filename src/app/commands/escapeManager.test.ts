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
});
