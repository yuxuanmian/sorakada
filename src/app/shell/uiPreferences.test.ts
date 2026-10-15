/**
 * T021/T149: preference validation, fallback and the observable store.
 *
 * A corrupt UI preference must never prevent startup, and a *narrow window* must
 * never rewrite the width the user chose. Both are asserted here because both are
 * data-safety-adjacent behaviours that a later refactor could quietly break.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_UI_PREFERENCES,
  UI_PREFERENCES_STORAGE_KEY,
  UI_PREFERENCES_VERSION,
  createMemoryUiPreferencesStorage,
  createUiPreferencesStore,
  createWebUiPreferencesStorage,
  parseUiPreferences,
  serializeUiPreferences,
  type UiPreferences,
  type WebStorageLike,
} from "./uiPreferences";
import {
  SIDEBAR_PREFERENCE_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./layoutMetrics";

describe("parseUiPreferences", () => {
  it("returns defaults for a missing payload", () => {
    expect(parseUiPreferences(null)).toEqual(DEFAULT_UI_PREFERENCES);
    expect(parseUiPreferences("")).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it("accepts a valid payload", () => {
    expect(
      parseUiPreferences(
        JSON.stringify({
          version: UI_PREFERENCES_VERSION,
          density: "comfortable",
          sidebarVisible: false,
          sidebarWidth: 800,
        }),
      ),
    ).toEqual({
      version: 1,
      density: "comfortable",
      sidebarVisible: false,
      sidebarWidth: 800,
    });
  });

  it("falls back for malformed JSON", () => {
    expect(parseUiPreferences("{not json")).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it("falls back for a non-object payload", () => {
    expect(parseUiPreferences("42")).toEqual(DEFAULT_UI_PREFERENCES);
    expect(parseUiPreferences("[]")).toEqual(DEFAULT_UI_PREFERENCES);
    expect(parseUiPreferences("null")).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it("ignores a payload from an unsupported schema version", () => {
    expect(
      parseUiPreferences(
        JSON.stringify({
          version: 99,
          density: "compact",
          sidebarVisible: false,
          sidebarWidth: 500,
        }),
      ),
    ).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it("falls back per field for wrong types", () => {
    expect(
      parseUiPreferences(
        JSON.stringify({
          version: UI_PREFERENCES_VERSION,
          density: "gigantic",
          sidebarVisible: "yes",
          sidebarWidth: "wide",
        }),
      ),
    ).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it("falls back for a non-numeric width", () => {
    expect(
      parseUiPreferences(
        JSON.stringify({
          version: UI_PREFERENCES_VERSION,
          density: "default",
          sidebarVisible: true,
          sidebarWidth: Number.NaN,
        }),
      ).sidebarWidth,
    ).toBe(DEFAULT_UI_PREFERENCES.sidebarWidth);
  });

  it("clamps an out-of-range width instead of failing", () => {
    const tiny = parseUiPreferences(
      JSON.stringify({
        version: UI_PREFERENCES_VERSION,
        density: "default",
        sidebarVisible: true,
        sidebarWidth: -4000,
      }),
    );
    const huge = parseUiPreferences(
      JSON.stringify({
        version: UI_PREFERENCES_VERSION,
        density: "default",
        sidebarVisible: true,
        sidebarWidth: 999_999,
      }),
    );

    expect(tiny.sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(huge.sidebarWidth).toBe(SIDEBAR_PREFERENCE_MAX_WIDTH);
  });

  it("round-trips through serialization", () => {
    const preferences: UiPreferences = {
      version: UI_PREFERENCES_VERSION,
      density: "compact",
      sidebarVisible: false,
      sidebarWidth: 512,
    };
    expect(parseUiPreferences(serializeUiPreferences(preferences))).toEqual(
      preferences,
    );
  });

  it("serializes no diagnostics at all (T178)", () => {
    const payload = JSON.parse(
      serializeUiPreferences(DEFAULT_UI_PREFERENCES),
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "density",
      "sidebarVisible",
      "sidebarWidth",
      "version",
    ]);
  });
});

describe("storage adapters", () => {
  it("reads and writes under one stable key", () => {
    const written: { key: string; value: string }[] = [];
    const storage: WebStorageLike = {
      getItem: (key) => (key === UI_PREFERENCES_STORAGE_KEY ? "stored" : null),
      setItem: (key, value) => {
        written.push({ key, value });
      },
    };

    const adapter = createWebUiPreferencesStorage(storage);
    expect(adapter.read()).toBe("stored");
    adapter.write("payload");
    expect(written).toEqual([
      { key: UI_PREFERENCES_STORAGE_KEY, value: "payload" },
    ]);
  });

  it("degrades to memory when browser storage is unavailable", () => {
    const adapter = createWebUiPreferencesStorage(null);
    expect(adapter.read()).toBeNull();
    adapter.write("x");
    expect(adapter.read()).toBe("x");
  });

  it("swallows a throwing storage implementation", () => {
    const throwing: WebStorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const adapter = createWebUiPreferencesStorage(throwing);
    expect(adapter.read()).toBeNull();
    expect(() => adapter.write("x")).not.toThrow();
  });
});

describe("UiPreferencesStore", () => {
  it("loads the persisted payload once at creation", () => {
    const storage = createMemoryUiPreferencesStorage(
      JSON.stringify({
        version: UI_PREFERENCES_VERSION,
        density: "compact",
        sidebarVisible: false,
        sidebarWidth: 400,
      }),
    );
    const store = createUiPreferencesStore({ storage });
    expect(store.getSnapshot()).toEqual({
      version: 1,
      density: "compact",
      sidebarVisible: false,
      sidebarWidth: 400,
    });
  });

  it("publishes one coherent snapshot per change and persists it", () => {
    const storage = createMemoryUiPreferencesStorage();
    const store = createUiPreferencesStore({ storage });
    const listener = vi.fn();
    store.subscribe(listener);

    store.setDensity("comfortable");
    store.setSidebarVisible(false);
    store.setSidebarWidth(720);

    expect(listener).toHaveBeenCalledTimes(3);
    const snapshot = store.getSnapshot();
    expect(snapshot).toEqual({
      version: 1,
      density: "comfortable",
      sidebarVisible: false,
      sidebarWidth: 720,
    });
    expect(parseUiPreferences(storage.read())).toEqual(snapshot);
  });

  it("does not notify for a no-op change", () => {
    const store = createUiPreferencesStore({
      storage: createMemoryUiPreferencesStorage(),
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.setDensity(store.getSnapshot().density);
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const store = createUiPreferencesStore({
      storage: createMemoryUiPreferencesStorage(),
    });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.setDensity("compact");
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps the preferred width when the layout would clamp it (T153)", () => {
    const storage = createMemoryUiPreferencesStorage();
    const store = createUiPreferencesStore({ storage });
    store.setSidebarWidth(1800);

    // A narrower window renders a clamped width; the preference is untouched, so
    // the width comes back when the space returns.
    expect(store.getSnapshot().sidebarWidth).toBe(1800);
    expect(parseUiPreferences(storage.read()).sidebarWidth).toBe(1800);
  });

  it("does not read storage from a component path (FR-086)", () => {
    const storage = createMemoryUiPreferencesStorage();
    const read = vi.spyOn(storage, "read");
    const store = createUiPreferencesStore({ storage });
    read.mockClear();

    store.setSidebarWidth(300);
    store.getSnapshot();
    expect(read).not.toHaveBeenCalled();
  });
});
