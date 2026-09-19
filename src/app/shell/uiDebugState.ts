/**
 * Development-only UI diagnostics (007 T022, FR-089).
 *
 * The virtualized Tree's counters and overlays exist so the 007 foundation can be
 * inspected without building a Settings page. They are deliberately **not** part
 * of `UiPreferences`: a debug flag is process-local, never serialized and never
 * restored, so `T178` can assert that persisted preferences contain no
 * diagnostics at all.
 *
 * The whole surface can be absent from a production build; ordinary density and
 * Sidebar preference commands remain available regardless (FR-089, T184).
 */

/** The diagnostics 007 actually implements. */
export interface UiDebugOptions {
  /** Outlines each mounted Tree row and shows its depth/height. */
  showTreeRowBounds: boolean;
  /** Shows visible/rendered row counts and the current virtual range. */
  showVirtualRange: boolean;
}

/** Every diagnostic starts off: normal user behaviour never depends on them. */
export const DEFAULT_UI_DEBUG_OPTIONS: UiDebugOptions = Object.freeze({
  showTreeRowBounds: false,
  showVirtualRange: false,
});

/** The keys, in the order the debug submenu presents them. */
export const UI_DEBUG_OPTION_KEYS: readonly (keyof UiDebugOptions)[] = [
  "showVirtualRange",
  "showTreeRowBounds",
];

/** The observable, process-local diagnostics owner. */
export interface UiDebugOptionsStore {
  /** The current diagnostics; stable between changes. */
  getSnapshot(): UiDebugOptions;
  /** Subscribes to changes; returns the unsubscribe function. */
  subscribe(listener: (options: UiDebugOptions) => void): () => void;
  /** Sets one diagnostic explicitly. */
  setOption<K extends keyof UiDebugOptions>(
    key: K,
    value: UiDebugOptions[K],
  ): void;
  /** Flips one diagnostic. */
  toggleOption(key: keyof UiDebugOptions): void;
  /** Whether any diagnostic is currently on. */
  isActive(): boolean;
}

/** Creates the process-local diagnostics store. */
export function createUiDebugOptionsStore(
  initial: UiDebugOptions = DEFAULT_UI_DEBUG_OPTIONS,
): UiDebugOptionsStore {
  const listeners = new Set<(options: UiDebugOptions) => void>();
  let options: UiDebugOptions = { ...initial };

  const publish = (next: UiDebugOptions): void => {
    options = next;
    for (const listener of [...listeners]) {
      listener(next);
    }
  };

  return {
    getSnapshot(): UiDebugOptions {
      return options;
    },

    subscribe(listener: (options: UiDebugOptions) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setOption(key, value): void {
      if (options[key] === value) {
        return;
      }
      publish({ ...options, [key]: value });
    },

    toggleOption(key): void {
      publish({ ...options, [key]: !options[key] });
    },

    isActive(): boolean {
      return UI_DEBUG_OPTION_KEYS.some((key) => options[key]);
    },
  };
}

/**
 * Whether the development diagnostics surface is available at all.
 *
 * Debug tooling is a development affordance: a production build hides the whole
 * submenu and its fixtures rather than exposing unfinished Settings (T179, T184).
 */
export function isUiDebugAvailable(): boolean {
  return import.meta.env?.DEV === true;
}
