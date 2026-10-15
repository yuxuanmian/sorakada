/**
 * The shared MainArea/Sidebar layout bounds (007 T150, T151, FR-083, FR-084).
 *
 * 003 capped the Sidebar at a fixed 640 CSS pixels, which conflicts with using
 * the Sidebar on a large display. 007 replaces that ceiling with a bound derived
 * from the *current* MainArea width: the Sidebar may grow until only
 * {@link MIN_EDITOR_WIDTH} is left for the EditorWorkspace, minus the fixed
 * MainArea chrome the splitter and the island layout occupy.
 *
 * This module is the single owner of those numbers, so the component, the drag
 * handling and the persisted preference all clamp against one definition. The
 * values are CSS logical pixels and are deliberately independent of any physical
 * display resolution (FR-082).
 */

import { DENSITY_METRICS } from "./density";

/** The usable Sidebar width range for one MainArea width. */
export interface SidebarWidthBounds {
  min: number;
  max: number;
}

/** Narrowest the Sidebar may ever be. */
export const SIDEBAR_MIN_WIDTH = 160;

/**
 * The EditorWorkspace minimum, frozen for 007.
 *
 * It is a layout boundary — "the Editor must keep this much room" — not a
 * display heuristic, and it is applied after the MainArea chrome below.
 */
export const MIN_EDITOR_WIDTH = 320;

/** The widest island gap any density preset declares. */
const MAX_ISLAND_GAP = Math.max(
  ...Object.values(DENSITY_METRICS).map((metrics) => metrics.islandGap),
);

/**
 * Fixed MainArea chrome the Sidebar bound has to leave room for.
 *
 * The island layout reserves the work-area inset on both sides of the MainArea
 * plus the gap between the Sidebar and EditorWorkspace islands. `--island-inset`
 * is an alias of the density-owned `--island-gap`, so the chrome is three gaps
 * wide; using the *widest* preset keeps the Editor minimum true at every density
 * without making this pure bound density-aware. The bound is therefore
 * conservative by up to two gaps at the densest preset, which can only ever
 * leave the Editor too much room, never too little.
 */
export const MAIN_AREA_CHROME_WIDTH = MAX_ISLAND_GAP * 3;

/**
 * Bounds a *stored* preference may hold.
 *
 * The upper value is deliberately far above any real window: it exists only to
 * reject a corrupt payload, because the real ceiling is the dynamic layout bound
 * computed at render time. Clamping a preference to the current window would
 * destroy the user's preferred width every time the window got narrow
 * (FR-084, T153).
 */
export const SIDEBAR_PREFERENCE_MIN_WIDTH = SIDEBAR_MIN_WIDTH;
export const SIDEBAR_PREFERENCE_MAX_WIDTH = 4000;

/**
 * The Sidebar width bounds for a MainArea of `mainAreaWidth` logical pixels.
 *
 * The maximum never falls below the minimum, so a MainArea too narrow for both
 * regions still produces usable bounds rather than an inverted range; the
 * resulting overlap-free geometry then comes from the Sidebar's own `min-width`
 * and the Editor's `min-width`, both of which are honoured by flex layout.
 */
export function sidebarWidthBounds(mainAreaWidth: number): SidebarWidthBounds {
  const available = Number.isFinite(mainAreaWidth) ? mainAreaWidth : 0;
  const dynamicMax = Math.floor(
    available - MIN_EDITOR_WIDTH - MAIN_AREA_CHROME_WIDTH,
  );

  return {
    min: SIDEBAR_MIN_WIDTH,
    max: Math.max(SIDEBAR_MIN_WIDTH, dynamicMax),
  };
}

/**
 * Clamps a requested Sidebar width against the current layout.
 *
 * A non-finite request is treated as "no change is knowable" and becomes the
 * minimum, which is the same conservative answer 003 gave.
 */
export function clampSidebarWidthToLayout(
  requested: number,
  mainAreaWidth: number,
): number {
  if (!Number.isFinite(requested)) {
    return SIDEBAR_MIN_WIDTH;
  }

  const bounds = sidebarWidthBounds(mainAreaWidth);
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(requested)));
}

/** Clamps a *persisted* width to the storable range, without layout knowledge. */
export function clampStoredSidebarWidth(requested: number): number {
  if (!Number.isFinite(requested)) {
    return SIDEBAR_MIN_WIDTH;
  }
  return Math.min(
    SIDEBAR_PREFERENCE_MAX_WIDTH,
    Math.max(SIDEBAR_PREFERENCE_MIN_WIDTH, Math.round(requested)),
  );
}

/**
 * Applies the layout bound to a preferred width without discarding it.
 *
 * Used by the rendered Sidebar: the value that is *shown* may be clamped, while
 * the preference keeps the user's number.
 */
export function renderSidebarWidth(
  preferredWidth: number,
  mainAreaWidth: number,
): number {
  return clampSidebarWidthToLayout(preferredWidth, mainAreaWidth);
}

/** Whether the EditorWorkspace would still keep its frozen minimum. */
export function preservesEditorMinimum(
  mainAreaWidth: number,
  sidebarWidth: number,
): boolean {
  return (
    mainAreaWidth - sidebarWidth - MAIN_AREA_CHROME_WIDTH >= MIN_EDITOR_WIDTH
  );
}
