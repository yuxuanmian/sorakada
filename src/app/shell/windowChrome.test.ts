/**
 * T036/T037: custom window chrome and the TopBar gesture decisions.
 *
 * FR-008 is the reason this file exists: the visual Close control has to be
 * provably *not* a forced destroy, because `destroy()` bypasses the unsaved-work
 * guard. FR-007's "exactly once" gesture rule is the other half.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createTauriWindowChromeAdapter,
  createWindowChromeController,
  type TauriAppWindowLike,
  type WindowChromeAdapter,
} from "./windowChrome";
import {
  INTERACTIVE_SELECTOR,
  isInteractiveTarget,
  requestTopBarDrag,
  requestTopBarToggleMaximize,
} from "./topBarGesture";

/** A recording native window, so every call can be counted and ordered. */
function recordingWindow(maximized = false) {
  const calls: string[] = [];
  let isMaximized = maximized;

  const appWindow: TauriAppWindowLike = {
    startDragging: async () => {
      calls.push("startDragging");
    },
    minimize: async () => {
      calls.push("minimize");
    },
    toggleMaximize: async () => {
      calls.push("toggleMaximize");
      isMaximized = !isMaximized;
    },
    isMaximized: async () => {
      calls.push("isMaximized");
      return isMaximized;
    },
    close: async () => {
      calls.push("close");
    },
  };

  return { appWindow, calls };
}

describe("window chrome controller", () => {
  it("maps close to the normal close request, never a destroy", async () => {
    const { appWindow, calls } = recordingWindow();
    const chrome = createWindowChromeController({
      adapter: createTauriWindowChromeAdapter(appWindow),
    });

    await chrome.requestClose();

    expect(calls).toEqual(["close"]);
    // The guard the controller must never be able to bypass: the adapter has no
    // destroy-shaped operation at all.
    expect(Object.keys(createTauriWindowChromeAdapter(appWindow))).not.toContain(
      "destroy",
    );
  });

  it("maps minimize and maximize one-to-one to their native calls", async () => {
    const { appWindow, calls } = recordingWindow();
    const chrome = createWindowChromeController({
      adapter: createTauriWindowChromeAdapter(appWindow),
    });

    await chrome.minimize();
    const maximized = await chrome.toggleMaximize();

    expect(calls).toEqual(["minimize", "toggleMaximize", "isMaximized"]);
    expect(maximized).toBe(true);
  });

  it("reports maximize state after a toggle", async () => {
    const { appWindow } = recordingWindow(true);
    const chrome = createWindowChromeController({
      adapter: createTauriWindowChromeAdapter(appWindow),
    });

    expect(await chrome.toggleMaximize()).toBe(false);
    expect(await chrome.refreshMaximized()).toBe(false);
  });

  it("starts a native drag", async () => {
    const { appWindow, calls } = recordingWindow();
    const chrome = createWindowChromeController({
      adapter: createTauriWindowChromeAdapter(appWindow),
    });

    await chrome.startDragging();
    expect(calls).toEqual(["startDragging"]);
  });

  it("reports availability from the adapter", () => {
    const { appWindow } = recordingWindow();
    expect(
      createWindowChromeController({
        adapter: createTauriWindowChromeAdapter(appWindow),
      }).isAvailable(),
    ).toBe(true);
  });

  it("routes a native failure to the error path instead of throwing", async () => {
    const onError = vi.fn();
    const failing: WindowChromeAdapter = {
      startDragging: async () => undefined,
      minimize: async () => {
        throw new Error("no window manager");
      },
      toggleMaximize: async () => undefined,
      isMaximized: async () => true,
      close: async () => undefined,
    };
    const chrome = createWindowChromeController({ adapter: failing, onError });

    await expect(chrome.minimize()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("browser-only fallback (T037)", () => {
  it("reports itself unavailable instead of crashing", async () => {
    const chrome = createWindowChromeController();
    expect(chrome.isAvailable()).toBe(false);
  });

  it("treats every native-only operation as a safe no-op", async () => {
    const onError = vi.fn();
    const chrome = createWindowChromeController({ onError });

    await expect(chrome.startDragging()).resolves.toBeUndefined();
    await expect(chrome.minimize()).resolves.toBeUndefined();
    await expect(chrome.toggleMaximize()).resolves.toBe(false);
    await expect(chrome.requestClose()).resolves.toBeUndefined();
    await expect(chrome.refreshMaximized()).resolves.toBe(false);
    // Nothing was attempted, so nothing failed.
    expect(onError).not.toHaveBeenCalled();
  });

  it("accepts an explicitly null adapter", async () => {
    const chrome = createWindowChromeController({ adapter: null });
    expect(chrome.isAvailable()).toBe(false);
    await expect(chrome.requestClose()).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* TopBar gestures (T036, FR-006, FR-007)                                      */
/* -------------------------------------------------------------------------- */

/** A fake element tree: the target matches when it is a known interactive node. */
function fakeTarget(options: {
  interactive?: boolean;
  closestThrows?: boolean;
}): unknown {
  if (options.closestThrows) {
    return {};
  }
  return {
    closest: (selector: string) =>
      selector === INTERACTIVE_SELECTOR && options.interactive === true
        ? {}
        : null,
  };
}

describe("TopBar gesture decisions", () => {
  it("starts a window drag from the non-interactive drag region", () => {
    const startDrag = vi.fn();
    const toggleMaximize = vi.fn();

    const started = requestTopBarDrag(fakeTarget({}), {
      startDrag,
      toggleMaximize,
    });

    expect(started).toBe(true);
    expect(startDrag).toHaveBeenCalledTimes(1);
    expect(toggleMaximize).not.toHaveBeenCalled();
  });

  it("never starts a drag from an interactive descendant", () => {
    const startDrag = vi.fn();

    const started = requestTopBarDrag(fakeTarget({ interactive: true }), {
      startDrag,
      toggleMaximize: vi.fn(),
    });

    expect(started).toBe(false);
    expect(startDrag).not.toHaveBeenCalled();
  });

  it("dispatches toggle-maximize exactly once for a drag-region double-click", () => {
    const toggleMaximize = vi.fn();

    const dispatched = requestTopBarToggleMaximize(fakeTarget({}), {
      startDrag: vi.fn(),
      toggleMaximize,
    });

    expect(dispatched).toBe(true);
    expect(toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("dispatches nothing for a double-click on App Menu or window controls", () => {
    const toggleMaximize = vi.fn();

    const dispatched = requestTopBarToggleMaximize(
      fakeTarget({ interactive: true }),
      { startDrag: vi.fn(), toggleMaximize },
    );

    expect(dispatched).toBe(false);
    expect(toggleMaximize).not.toHaveBeenCalled();
  });

  it("treats an unknowable target as interactive", () => {
    expect(isInteractiveTarget(null)).toBe(true);
    expect(isInteractiveTarget("div")).toBe(true);
    expect(isInteractiveTarget(fakeTarget({ closestThrows: true }))).toBe(true);

    const toggleMaximize = vi.fn();
    expect(
      requestTopBarToggleMaximize(fakeTarget({ closestThrows: true }), {
        startDrag: vi.fn(),
        toggleMaximize,
      }),
    ).toBe(false);
    expect(toggleMaximize).not.toHaveBeenCalled();
  });
});
