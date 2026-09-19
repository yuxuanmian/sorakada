/**
 * The UI preference owner (007 T018, T019, T020, FR-085..FR-088).
 *
 * Density, Sidebar visibility and the user's preferred Sidebar width are the
 * only facts 007 persists. They are UI-only: nothing here touches document,
 * session, recovery or Workspace state, and this is deliberately *not* a general
 * Settings repository (Constitution V).
 *
 * Three rules shape the implementation:
 *
 * 1. One owner. Components receive the snapshot and explicit update methods;
 *    they never read or write browser storage themselves (FR-086).
 * 2. Conservative loading. A missing, malformed, wrong-version or out-of-range
 *    payload falls back to safe defaults rather than failing to render
 *    (FR-087, US6-AC8).
 * 3. Preference ≠ layout. The stored width is the user's *preferred* width.
 *    Clamping it against a temporarily narrow window happens at render time and
 *    must never overwrite the preference (FR-084, T153).
 */

import {
  SIDEBAR_MIN_WIDTH,
  clampStoredSidebarWidth,
} from "./layoutMetrics";

/** The three structural density presets (FR-080). */
export type UiDensity = "compact" | "default" | "comfortable";

/** The schema version of the persisted payload. */
export const UI_PREFERENCES_VERSION = 1;

/** The one storage key all UI preferences live under. */
export const UI_PREFERENCES_STORAGE_KEY = "sorakada.ui.preferences";

/** The small, versioned UI preference payload. */
export interface UiPreferences {
  /** Schema version; an unknown value means "ignore and use defaults". */
  version: 1;
  /** Structural density preset. */
  density: UiDensity;
  /** Whether the Sidebar region is shown. */
  sidebarVisible: boolean;
  /** The user's preferred Sidebar width in CSS logical pixels. */
  sidebarWidth: number;
}

/** What a first launch uses, and what every fallback returns. */
export const DEFAULT_UI_PREFERENCES: UiPreferences = Object.freeze({
  version: UI_PREFERENCES_VERSION,
  density: "default",
  sidebarVisible: true,
  sidebarWidth: 260,
});

/** Whether `value` is one of the three supported presets. */
export function isUiDensity(value: unknown): value is UiDensity {
  return value === "compact" || value === "default" || value === "comfortable";
}

/**
 * The storage seam.
 *
 * A minimal read/write pair is enough for one small payload; the store never
 * learns whether the implementation is `localStorage`, an in-memory fallback or
 * a test double.
 */
export interface UiPreferencesStorage {
  /** The stored payload, or `null` when nothing is stored. */
  read(): string | null;
  /** Persists `value`; failures are the adapter's business, not the store's. */
  write(value: string): void;
}

/** The `Storage` surface this module needs, injectable for tests. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Wraps browser storage so an unavailable or throwing implementation degrades to
 * "nothing stored" instead of breaking startup.
 */
export function createWebUiPreferencesStorage(
  storage: WebStorageLike | null | undefined = browserStorage(),
): UiPreferencesStorage {
  if (storage === null || storage === undefined) {
    return createMemoryUiPreferencesStorage();
  }

  return {
    read(): string | null {
      try {
        return storage.getItem(UI_PREFERENCES_STORAGE_KEY);
      } catch {
        return null;
      }
    },
    write(value: string): void {
      try {
        storage.setItem(UI_PREFERENCES_STORAGE_KEY, value);
      } catch {
        // A full or unavailable store must not break a UI preference change.
      }
    },
  };
}

/** A process-local adapter; also the browser-unavailable fallback. */
export function createMemoryUiPreferencesStorage(
  initial: string | null = null,
): UiPreferencesStorage {
  let current = initial;
  return {
    read: () => current,
    write: (value: string) => {
      current = value;
    },
  };
}

function browserStorage(): WebStorageLike | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    return window.localStorage ?? null;
  } catch {
    // Accessing `localStorage` can throw in a locked-down embedding context.
    return null;
  }
}

/**
 * Validates and normalizes one stored payload.
 *
 * Every failure mode is conservative in the same direction: the affected field —
 * or the whole payload — becomes its default. Nothing here can throw, because a
 * corrupt preference must never prevent the application from rendering.
 */
export function parseUiPreferences(raw: string | null): UiPreferences {
  if (raw === null || raw === "") {
    return { ...DEFAULT_UI_PREFERENCES };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_UI_PREFERENCES };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_UI_PREFERENCES };
  }

  const record = parsed as Record<string, unknown>;

  // An unsupported schema is not partially migrated: 007 declares version 1 and
  // anything else is unknown, so the defaults are the only safe reading.
  if (record.version !== UI_PREFERENCES_VERSION) {
    return { ...DEFAULT_UI_PREFERENCES };
  }

  return {
    version: UI_PREFERENCES_VERSION,
    density: isUiDensity(record.density)
      ? record.density
      : DEFAULT_UI_PREFERENCES.density,
    sidebarVisible:
      typeof record.sidebarVisible === "boolean"
        ? record.sidebarVisible
        : DEFAULT_UI_PREFERENCES.sidebarVisible,
    sidebarWidth:
      typeof record.sidebarWidth === "number"
        ? clampStoredSidebarWidth(record.sidebarWidth)
        : DEFAULT_UI_PREFERENCES.sidebarWidth,
  };
}

/** Serializes a snapshot for the storage adapter. */
export function serializeUiPreferences(preferences: UiPreferences): string {
  return JSON.stringify({
    version: UI_PREFERENCES_VERSION,
    density: preferences.density,
    sidebarVisible: preferences.sidebarVisible,
    sidebarWidth: clampStoredSidebarWidth(preferences.sidebarWidth),
  });
}

/** The observable UI preference owner. */
export interface UiPreferencesStore {
  /** The current preferences; stable between changes. */
  getSnapshot(): UiPreferences;
  /** Subscribes to changes; returns the unsubscribe function. */
  subscribe(listener: (preferences: UiPreferences) => void): () => void;
  /** Selects a density preset. */
  setDensity(density: UiDensity): void;
  /** Shows or hides the Sidebar. */
  setSidebarVisible(visible: boolean): void;
  /**
   * Records the user's preferred Sidebar width.
   *
   * Only an explicit user gesture (drag or reset) may call this; passive
   * clamping caused by a narrow window or a different display must not.
   */
  setSidebarWidth(width: number): void;
}

export interface UiPreferencesStoreOptions {
  /** Where the payload is persisted; defaults to browser storage. */
  storage?: UiPreferencesStorage;
  /** What a first launch starts from. */
  initial?: UiPreferences;
}

/**
 * Creates the process-wide preference owner.
 *
 * The payload is loaded exactly once, here, so every component reads the same
 * validated snapshot for the lifetime of the session.
 */
export function createUiPreferencesStore(
  options: UiPreferencesStoreOptions = {},
): UiPreferencesStore {
  const storage = options.storage ?? createWebUiPreferencesStorage();
  const listeners = new Set<(preferences: UiPreferences) => void>();

  let preferences: UiPreferences =
    options.initial ?? parseUiPreferences(storage.read());

  const publish = (next: UiPreferences): void => {
    preferences = next;
    storage.write(serializeUiPreferences(next));
    for (const listener of [...listeners]) {
      listener(next);
    }
  };

  return {
    getSnapshot(): UiPreferences {
      return preferences;
    },

    subscribe(listener: (preferences: UiPreferences) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setDensity(density: UiDensity): void {
      if (preferences.density === density) {
        return;
      }
      publish({ ...preferences, density });
    },

    setSidebarVisible(visible: boolean): void {
      if (preferences.sidebarVisible === visible) {
        return;
      }
      publish({ ...preferences, sidebarVisible: visible });
    },

    setSidebarWidth(width: number): void {
      // The preference range is deliberately independent of the current layout,
      // so a narrow window cannot silently shrink what the user chose.
      const next = clampStoredSidebarWidth(
        Number.isFinite(width) ? width : SIDEBAR_MIN_WIDTH,
      );
      if (preferences.sidebarWidth === next) {
        return;
      }
      publish({ ...preferences, sidebarWidth: next });
    },
  };
}
