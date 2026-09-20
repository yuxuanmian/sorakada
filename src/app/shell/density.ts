/**
 * The density metric table (007 T023, T089, T157).
 *
 * `density.css` is the CSS side of the density contract; this module is the
 * JavaScript side. The virtualizer needs a concrete row height in pixels, and
 * the horizontal Tree extent needs the same indent/affordance metrics the rows
 * are laid out with — so both read them from here instead of embedding another
 * row-height constant in a component (T089).
 *
 * The two halves are pinned together by `density.test.ts`, which parses
 * `src/styles/density.css` and compares every declared value with this table:
 * a density metric can therefore never silently drift between the stylesheet and
 * the measurement code (Constitution III).
 */

import type { UiDensity } from "./uiPreferences";

/** The three 007 density presets, in menu order. */
export const UI_DENSITIES: readonly UiDensity[] = [
  "compact",
  "default",
  "comfortable",
];

/** Structural metrics one density preset coordinates. */
export interface DensityMetrics {
  /**
   * Height of one Tree row, node or sentinel.
   *
   * 008 T026 raises this to 20/24/28. It is the only metric 008 moves, and the
   * virtualizer reads it from here rather than from a component constant
   * (008 FR-039, FR-040, SC-006).
   */
  treeRowHeight: number;
  /** Horizontal offset of one depth level. */
  treeIndent: number;
  /** Hit area of the expand/collapse chevron. */
  treeChevronSize: number;
  /** Height of one document Tab. */
  tabHeight: number;
  /** Narrowest a Tab may shrink to before the strip overflows. */
  tabMinWidth: number;
  /** Comfortable Tab width used while space allows. */
  tabMaxWidth: number;
  /** Minimum height of one menu row. */
  menuItemHeight: number;
  /** Height of a shared shell control. */
  controlHeight: number;
  /** Height of the TopBar region. */
  topBarHeight: number;
  /** Height of the Footer region. */
  footerHeight: number;
  /**
   * The Sidebar width a density reset restores (FR-088).
   *
   * It is a starting point, never a bound: the real ceiling comes from the
   * current MainArea width (`layoutMetrics.ts`).
   */
  sidebarDefaultWidth: number;
  /** Shared spacing step. */
  gap: number;
}

/** The authoritative metric values, one record per preset. */
export const DENSITY_METRICS: Readonly<Record<UiDensity, DensityMetrics>> = {
  compact: {
    treeRowHeight: 20,
    treeIndent: 12,
    treeChevronSize: 14,
    tabHeight: 26,
    tabMinWidth: 64,
    tabMaxWidth: 200,
    menuItemHeight: 22,
    controlHeight: 22,
    topBarHeight: 30,
    footerHeight: 20,
    sidebarDefaultWidth: 240,
    gap: 3,
  },
  default: {
    treeRowHeight: 24,
    treeIndent: 14,
    treeChevronSize: 16,
    tabHeight: 30,
    tabMinWidth: 72,
    tabMaxWidth: 220,
    menuItemHeight: 26,
    controlHeight: 24,
    topBarHeight: 34,
    footerHeight: 22,
    sidebarDefaultWidth: 260,
    gap: 4,
  },
  comfortable: {
    treeRowHeight: 28,
    treeIndent: 18,
    treeChevronSize: 18,
    tabHeight: 34,
    tabMinWidth: 84,
    tabMaxWidth: 260,
    menuItemHeight: 30,
    controlHeight: 28,
    topBarHeight: 38,
    footerHeight: 26,
    sidebarDefaultWidth: 300,
    gap: 6,
  },
};

/** The CSS custom property each metric is declared under in `density.css`. */
export const DENSITY_CSS_VARIABLES: Readonly<
  Record<keyof DensityMetrics, string>
> = {
  treeRowHeight: "--tree-row-height",
  treeIndent: "--tree-indent",
  treeChevronSize: "--tree-chevron-size",
  tabHeight: "--tab-height",
  tabMinWidth: "--tab-min-width",
  tabMaxWidth: "--tab-max-width",
  menuItemHeight: "--menu-item-height",
  controlHeight: "--control-height",
  topBarHeight: "--topbar-height",
  footerHeight: "--footer-height",
  sidebarDefaultWidth: "--sidebar-default-width",
  gap: "--ui-gap",
};

/** The resolved metrics for one preset. */
export function densityMetrics(density: UiDensity): DensityMetrics {
  return DENSITY_METRICS[density];
}

/** The root attribute that selects the active density token set. */
export const DENSITY_ATTRIBUTE = "data-density";

/** The minimal root-element surface the density attribute needs. */
export interface AttributeTarget {
  setAttribute(name: string, value: string): void;
}

/**
 * Publishes the active density to the root element (T034).
 *
 * The attribute — not a component class — is what selects the token set in
 * `density.css`, so switching density is one attribute write that cannot remount
 * the Editor, the Explorer controller or CodeMirror (FR-080, T156).
 */
export function applyDensityAttribute(
  density: UiDensity,
  root: AttributeTarget,
): void {
  root.setAttribute(DENSITY_ATTRIBUTE, density);
}
