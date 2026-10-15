/**
 * Custom window chrome (007 T038, FR-007..FR-009).
 *
 * 007 removes the native title bar, so the shell owns minimize, maximize/restore
 * and close. Two rules make that safe:
 *
 * 1. **Close is a request, never a destroy.** `requestClose()` calls the native
 *    `close()`, which is what the existing dirty-aware `installWindowLifecycle()`
 *    intercepts. `destroy()` would bypass the unsaved-work guard, so this module
 *    deliberately has no way to call it.
 * 2. **A browser-only session is a first-class runtime.** When no Tauri window is
 *    available every operation is a reported no-op instead of an IPC call, so
 *    `vite dev` still renders the shell (FR-007, US1-AC8).
 *
 * React components never touch `getCurrentWindow()` themselves: the adapter is
 * created once in `App.tsx` and injected here, which also makes the whole
 * controller testable without a desktop shell.
 */

/** The narrow native surface the chrome needs. */
export interface WindowChromeAdapter {
  /** Begins a native window move. */
  startDragging(): Promise<void>;
  /** Minimizes the window. */
  minimize(): Promise<void>;
  /** Toggles maximize/restore. */
  toggleMaximize(): Promise<void>;
  /** Whether the window is currently maximized. */
  isMaximized(): Promise<boolean>;
  /**
   * Requests a normal close.
   *
   * The window lifecycle intercepts this while documents are dirty; a native
   * force-destroy is intentionally not part of this contract.
   */
  close(): Promise<void>;
}

/** The Tauri window surface this adapter is built from. */
export interface TauriAppWindowLike {
  startDragging(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  close(): Promise<void>;
}

/** Adapts a Tauri `WebviewWindow` to {@link WindowChromeAdapter}. */
export function createTauriWindowChromeAdapter(
  appWindow: TauriAppWindowLike,
): WindowChromeAdapter {
  return {
    startDragging: () => appWindow.startDragging(),
    minimize: () => appWindow.minimize(),
    toggleMaximize: () => appWindow.toggleMaximize(),
    isMaximized: () => appWindow.isMaximized(),
    // `close()`, never `destroy()`: the close request must reach the window
    // lifecycle so the unsaved-work guard stays authoritative (FR-008).
    close: () => appWindow.close(),
  };
}

/** The window-chrome operations the TopBar dispatches commands to. */
export interface WindowChromeController {
  /** Whether native window control exists in this runtime. */
  isAvailable(): boolean;
  /** Begins a native window move; a no-op without a native window. */
  startDragging(): Promise<void>;
  /** Minimizes the window; a no-op without a native window. */
  minimize(): Promise<void>;
  /** Toggles maximize/restore and resolves with the resulting state. */
  toggleMaximize(): Promise<boolean>;
  /** Requests a normal close, which the window lifecycle may intercept. */
  requestClose(): Promise<void>;
  /** Re-reads the native maximize state; `false` without a native window. */
  refreshMaximized(): Promise<boolean>;
}

export interface CreateWindowChromeOptions {
  /** The native adapter, or `null`/omitted in a browser-only runtime. */
  adapter?: WindowChromeAdapter | null;
  /** Reports a native failure without letting it escape as an unhandled rejection. */
  onError?(error: unknown): void;
}

/**
 * Creates the chrome controller.
 *
 * Every operation funnels its native failure into `onError` and then resolves, so
 * a window-manager refusal can never break a React event handler; the caller
 * sees the outcome through {@link WindowChromeController.isAvailable} and the
 * error path instead of an exception.
 */
export function createWindowChromeController(
  options: CreateWindowChromeOptions = {},
): WindowChromeController {
  const adapter = options.adapter ?? null;

  const run = async <T>(
    operation: (adapter: WindowChromeAdapter) => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    if (adapter === null) {
      return fallback;
    }
    try {
      return await operation(adapter);
    } catch (error) {
      options.onError?.(error);
      return fallback;
    }
  };

  return {
    isAvailable: () => adapter !== null,

    startDragging: () => run((native) => native.startDragging(), undefined),

    minimize: () => run((native) => native.minimize(), undefined),

    toggleMaximize: () =>
      run(async (native) => {
        await native.toggleMaximize();
        return native.isMaximized();
      }, false),

    requestClose: () => run((native) => native.close(), undefined),

    refreshMaximized: () =>
      run((native) => native.isMaximized(), false),
  };
}
