/**
 * T178: development diagnostics are process-local.
 *
 * The whole point of keeping `UiDebugOptions` separate from `UiPreferences` is
 * that a debug flag can never become persisted user state, and that normal user
 * behaviour never depends on it.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_UI_DEBUG_OPTIONS,
  UI_DEBUG_OPTION_KEYS,
  createUiDebugOptionsStore,
  isUiDebugAvailable,
} from "./uiDebugState";
import {
  DEFAULT_UI_PREFERENCES,
  parseUiPreferences,
  serializeUiPreferences,
} from "./uiPreferences";

describe("UiDebugOptions store", () => {
  it("starts with every diagnostic off", () => {
    const store = createUiDebugOptionsStore();
    expect(store.getSnapshot()).toEqual(DEFAULT_UI_DEBUG_OPTIONS);
    expect(store.isActive()).toBe(false);
  });

  it("publishes one coherent snapshot per toggle", () => {
    const store = createUiDebugOptionsStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.toggleOption("showVirtualRange");
    expect(store.getSnapshot().showVirtualRange).toBe(true);
    expect(store.isActive()).toBe(true);

    store.setOption("showTreeRowBounds", true);
    expect(store.getSnapshot()).toEqual({
      showVirtualRange: true,
      showTreeRowBounds: true,
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not notify for a no-op change", () => {
    const store = createUiDebugOptionsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setOption("showTreeRowBounds", false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const store = createUiDebugOptionsStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.toggleOption("showVirtualRange");
    expect(listener).not.toHaveBeenCalled();
  });

  it("stays out of the persisted preference payload", () => {
    const serialized = serializeUiPreferences(DEFAULT_UI_PREFERENCES);
    for (const key of UI_DEBUG_OPTION_KEYS) {
      expect(serialized).not.toContain(key);
    }
    expect(Object.keys(parseUiPreferences(serialized))).toEqual([
      "version",
      "density",
      "sidebarVisible",
      "sidebarWidth",
    ]);
  });

  it("reports debug availability only in a development build", () => {
    // Vitest runs the module graph with Vite's development flag set.
    expect(isUiDebugAvailable()).toBe(true);
  });
});
