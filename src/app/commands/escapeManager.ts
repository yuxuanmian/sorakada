/**
 * Hierarchical Escape key dispatch manager.
 *
 * Implements priority-based, layered dismissal of modals, popups, tool bars,
 * and editor states ("逐级退出弹窗/功能直到只剩 editor").
 *
 * Priorities align with the application stacking layers declared in `global.css`:
 * - `--layer-modal: 40` <-> `ESCAPE_PRIORITY.MODAL = 40`
 * - `--layer-popup: 30` <-> `ESCAPE_PRIORITY.POPUP = 30`
 * - `--layer-transient: 20` <-> `ESCAPE_PRIORITY.TOOL = 20`
 * - `--layer-content: 0` <-> `ESCAPE_PRIORITY.EDITOR = 0`
 */

export const ESCAPE_PRIORITY = {
  /** Modal dialogs (Confirm, alert, settings modal, etc.) */
  MODAL: 40,
  /** Popups, dropdowns, context menus, floating toolbars */
  POPUP: 30,
  /** Toolbars, pinned bars, search/replace bar, command palette */
  TOOL: 20,
  /** In-surface transient editing (inline rename, quick search) */
  INLINE: 10,
  /** Base editor fallback (e.g. multi-selection collapse) */
  EDITOR: 0,
} as const;

export type EscapePriorityValue =
  (typeof ESCAPE_PRIORITY)[keyof typeof ESCAPE_PRIORITY];

export interface EscapeHandlerEntry {
  id: number;
  priority: number;
  handle: () => boolean | void;
}

/**
 * Manages hierarchical Escape key handling across the application.
 *
 * Handlers are registered with a priority. When Escape is dispatched,
 * handlers are evaluated in descending priority order (and LIFO order
 * within the same priority level). The first handler to return `true`
 * (or void/undefined) consumes the Escape, allowing UI surfaces to exit
 * step-by-step until only the editor is left.
 */
export class EscapeManager {
  private handlers: EscapeHandlerEntry[] = [];
  private nextId = 1;

  /**
   * Registers an Escape handler with the given priority.
   *
   * @param priority Numeric priority (see {@link ESCAPE_PRIORITY}).
   * @param handle Callback invoked when Escape is dispatched.
   *               Return `true` or `void` to consume the Escape;
   *               return `false` to pass through to lower-priority handlers.
   * @returns Cleanup function to unregister the handler.
   */
  register(priority: number, handle: () => boolean | void): () => void {
    const id = this.nextId++;
    const entry: EscapeHandlerEntry = { id, priority, handle };
    this.handlers.push(entry);

    return () => {
      this.handlers = this.handlers.filter((h) => h.id !== id);
    };
  }

  /**
   * Number of currently registered handlers.
   */
  get count(): number {
    return this.handlers.length;
  }

  /**
   * Dispatches an Escape request to registered handlers.
   *
   * Evaluates handlers in descending priority order, and LIFO order within
   * ties. Returns `true` if any handler consumed the event, or `false` otherwise.
   */
  dispatch(): boolean {
    if (this.handlers.length === 0) {
      return false;
    }

    // Sort descending by priority, then descending by id (LIFO)
    const sorted = [...this.handlers].sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return b.id - a.id;
    });

    for (const entry of sorted) {
      const result = entry.handle();
      // true or void (undefined) means handled
      if (result === true || result === undefined) {
        return true;
      }
    }

    return false;
  }

  /**
   * Handles a DOM KeyboardEvent. If the event key is "Escape", attempts to
   * dispatch to the highest-priority handler. If handled, calls `preventDefault()`
   * and `stopPropagation()`.
   *
   * @returns `true` if handled, `false` otherwise.
   */
  handleKeyboardEvent(event: KeyboardEvent): boolean {
    if (event.key === "Escape") {
      const handled = this.dispatch();
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
    }
    return false;
  }
}

/** Factory creating a new EscapeManager instance. */
export function createEscapeManager(): EscapeManager {
  return new EscapeManager();
}
