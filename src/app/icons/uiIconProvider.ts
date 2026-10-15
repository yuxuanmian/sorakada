/**
 * The default UI icon provider (007 T027, FR-056).
 *
 * Shell and action icons are resolved here, through the glyph table that already
 * backs `AppIcon`. The provider is a tiny indirection on purpose: it is the seam a
 * later icon theme or icon library replaces, without any shell component learning
 * about it (FR-059).
 */

import { ICON_GLYPHS } from "./glyphs";
import { iconDescriptor, type IconDescriptor, type UiIconId, type UiIconProvider } from "./iconTypes";

/**
 * Builds a provider over a glyph table.
 *
 * The table is validated lazily: `resolve` throws for an id the table cannot draw
 * rather than rendering an empty icon, because a silent blank is exactly the
 * kind of missing-fallback bug FR-058 forbids.
 */
export function createUiIconProvider(
  glyphs: Readonly<Record<UiIconId, readonly string[]>>,
): UiIconProvider {
  return {
    resolve(id: UiIconId, title?: string): IconDescriptor {
      if (!(id in glyphs)) {
        throw new Error(`No glyph is registered for UI icon "${id}".`);
      }
      return iconDescriptor(id, title);
    },
  };
}

/** The application's default provider, backed by the shipped glyph set. */
export const defaultUiIconProvider: UiIconProvider = createUiIconProvider(
  ICON_GLYPHS,
);

/** Shorthand for the default provider. */
export function uiIcon(id: UiIconId, title?: string): IconDescriptor {
  return defaultUiIconProvider.resolve(id, title);
}
