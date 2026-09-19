/**
 * TabStrip layout and reveal arithmetic (007 T127, T128, T134, FR-064..FR-068).
 *
 * Four facts about a Tab strip have to be provable without a browser:
 *
 * - a Tab is as wide as its own content, bounded by the density minimum and
 *   maximum, so one short document name does not produce a half-empty Tab
 *   (FR-065: "shrink from a comfortable maximum", i.e. the maximum is a ceiling,
 *   not a default width);
 * - when the Tabs together no longer fit, they all shrink to **one** width down to
 *   the minimum — a uniform squeeze, because a ragged strip reads as broken — and
 *   only then does the viewport scroll (FR-064, FR-065);
 * - the fixed action region is *outside* the scrolling viewport, so the width
 *   available to Tabs is the strip width minus that region (FR-067);
 * - bringing the active Tab into view is computed against the actual viewport
 *   bounds, because `scrollIntoView()` could scroll an outer container or hide a
 *   Tab beneath the fixed actions (FR-066, T137).
 */

import type { LabelMeasurer } from "../shell/textMeasurement";

/**
 * Fixed horizontal widths a Tab spends besides its label.
 *
 * These mirror the `.tab` geometry in `src/styles/tabs.css` (padding, the 6px
 * flex gap and the 18px close button plus its border). They are what turn a
 * measured label width into a Tab width; the stylesheet still owns the real
 * layout, so a drift here can only make a Tab slightly loose or tight, never
 * broken — and `tabStrip.test.ts` pins the arithmetic.
 */
export interface TabAffordances {
  /** Left padding of the Tab. */
  paddingLeft: number;
  /** Right padding of the Tab. */
  paddingRight: number;
  /** Flex gap between two Tab children. */
  gap: number;
  /** Close button hit area. */
  close: number;
  /** Width of the dirty marker, including its gap. */
  dirty: number;
  /** Width of the external-state marker, including its gap. */
  external: number;
  /** The Tab's right border. */
  border: number;
  /** Slack so a label at exactly the maximum is not clipped by rounding. */
  slack: number;
}

/** The geometry `src/styles/tabs.css` renders. */
export const TAB_AFFORDANCES: TabAffordances = {
  paddingLeft: 10,
  paddingRight: 4,
  gap: 6,
  close: 18,
  dirty: 16,
  external: 17,
  border: 1,
  slack: 2,
};

/** The Tab fields a width depends on. */
export interface TabWidthInput {
  /** The measured label width in CSS pixels. */
  labelWidth: number;
  /** Whether the Tab shows the unsaved-changes marker. */
  dirty: boolean;
  /** Whether the Tab shows an external disk-state marker. */
  hasExternalState: boolean;
}

/** One Tab's content-derived width, clamped to the density bounds. */
export function naturalTabWidth(
  input: TabWidthInput,
  bounds: { minWidth: number; maxWidth: number },
  affordances: TabAffordances = TAB_AFFORDANCES,
): number {
  const fixed =
    affordances.paddingLeft +
    affordances.paddingRight +
    affordances.gap +
    affordances.close +
    affordances.border +
    affordances.slack +
    (input.dirty ? affordances.dirty : 0) +
    (input.hasExternalState ? affordances.external : 0);

  const natural = Math.ceil(input.labelWidth + fixed);
  return Math.min(bounds.maxWidth, Math.max(bounds.minWidth, natural));
}

/** Derives one natural width per Tab from measured label widths. */
export function naturalTabWidths(
  tabs: readonly TabWidthInput[],
  bounds: { minWidth: number; maxWidth: number },
  affordances: TabAffordances = TAB_AFFORDANCES,
): number[] {
  return tabs.map((tab) => naturalTabWidth(tab, bounds, affordances));
}

/** Measures each Tab's label with the shared UI-font measurer. */
export function measureTabWidths(
  tabs: readonly {
    displayName: string;
    dirty: boolean;
    externalState: string;
  }[],
  measurer: LabelMeasurer,
  bounds: { minWidth: number; maxWidth: number },
  affordances: TabAffordances = TAB_AFFORDANCES,
): number[] {
  return naturalTabWidths(
    tabs.map((tab) => ({
      labelWidth: measurer.measure(tab.displayName),
      dirty: tab.dirty,
      hasExternalState: tab.externalState !== "normal",
    })),
    bounds,
    affordances,
  );
}

export interface TabLayoutInput {
  /** Each Tab's content-derived width, clamped to the density bounds. */
  naturalWidths: readonly number[];
  /**
   * Width available to the scrolling Tab list.
   *
   * It is already the strip width minus the fixed action region, which is what
   * keeps the actions permanently reachable (FR-067, T132).
   */
  viewportWidth: number;
  /** Narrowest a Tab may shrink to. */
  minWidth: number;
  /** Comfortable Tab width; the ceiling for a content-sized Tab. */
  maxWidth: number;
}

export interface TabLayout {
  /** The width of each Tab, in Tab order. */
  widths: number[];
  /** Total width of all Tab elements. */
  contentWidth: number;
  /** Whether the Tab list is wider than its viewport. */
  overflows: boolean;
  /**
   * The single width shared by every Tab while they are being squeezed.
   *
   * `null` while each Tab still fits its own content, which is the state a strip
   * with few Tabs is normally in.
   */
  uniformWidth: number | null;
}

const EMPTY_LAYOUT: TabLayout = {
  widths: [],
  contentWidth: 0,
  overflows: false,
  uniformWidth: null,
};

/**
 * Computes the Tab widths for one strip.
 *
 * Two phases, in this order:
 *
 * 1. **Content-sized.** If every Tab can have its natural width, they do — a Tab
 *    for `a.ts` stays narrow instead of reserving a comfortable maximum it does
 *    not need.
 * 2. **Uniform squeeze.** Otherwise every Tab gets the same width, as large as
 *    fits and no smaller than the minimum; past the minimum the viewport scrolls,
 *    and the strip never wraps to a second row.
 */
export function computeTabLayout(input: TabLayoutInput): TabLayout {
  const { naturalWidths, viewportWidth, minWidth, maxWidth } = input;
  if (naturalWidths.length === 0) {
    return EMPTY_LAYOUT;
  }

  const naturalTotal = naturalWidths.reduce((total, width) => total + width, 0);
  if (naturalTotal <= viewportWidth) {
    return {
      widths: [...naturalWidths],
      contentWidth: naturalTotal,
      overflows: false,
      uniformWidth: null,
    };
  }

  const perTab =
    viewportWidth <= 0 ? minWidth : Math.floor(viewportWidth / naturalWidths.length);
  const uniformWidth = Math.min(maxWidth, Math.max(minWidth, perTab));

  return {
    widths: naturalWidths.map(() => uniformWidth),
    contentWidth: uniformWidth * naturalWidths.length,
    overflows: uniformWidth * naturalWidths.length > viewportWidth,
    uniformWidth,
  };
}

/**
 * The width left for document Tabs once the fixed action region is reserved.
 *
 * The actions are never part of the scrolling viewport, so this subtraction is the
 * only correct way to derive the Tab width (T132).
 */
export function tabViewportWidth(
  stripWidth: number,
  actionsWidth: number,
): number {
  return Math.max(0, stripWidth - actionsWidth);
}

/** The left edge of each Tab, derived from the widths in Tab order. */
export function tabOffsets(widths: readonly number[]): number[] {
  const offsets: number[] = [];
  let position = 0;
  for (const width of widths) {
    offsets.push(position);
    position += width;
  }
  return offsets;
}

export interface TabRevealInput {
  /** Current horizontal scroll offset of the Tab viewport. */
  scrollLeft: number;
  /** Visible width of the Tab viewport (actions excluded). */
  viewportWidth: number;
  /** Total width of all Tabs. */
  contentWidth: number;
  /** Left edge of the Tab to reveal. */
  tabStart: number;
  /** Width of the Tab to reveal. */
  tabWidth: number;
}

/**
 * The scroll offset that brings one Tab fully into view.
 *
 * A Tab that is already fully visible keeps the current offset, so activating a Tab
 * never jumps the strip; a Tab to the left or right is scrolled just far enough.
 * The result is clamped to the scrollable range, which is what keeps the fixed
 * action region from covering a Tab and keeps an outer container from moving.
 */
export function revealTabOffset(input: TabRevealInput): number {
  const { scrollLeft, viewportWidth, contentWidth, tabStart, tabWidth } = input;

  const maxScroll = Math.max(0, contentWidth - viewportWidth);
  const tabEnd = tabStart + tabWidth;

  let next = scrollLeft;
  if (tabStart < scrollLeft) {
    next = tabStart;
  } else if (tabEnd > scrollLeft + viewportWidth) {
    next = tabEnd - viewportWidth;
  }

  return Math.min(maxScroll, Math.max(0, next));
}

/**
 * Whether the Tab list overflows its viewport.
 *
 * The Overview control is offered exactly when this is true, so it is derived from
 * measured geometry rather than stored in the document model (FR-069, T138).
 */
export function tabListOverflows(
  contentWidth: number,
  viewportWidth: number,
): boolean {
  return contentWidth > viewportWidth;
}

/** The two sizes a Tab strip observes about itself. */
export interface TabStripMeasurement {
  /** Width of the whole strip, fixed action region included. */
  stripWidth: number;
  /**
   * Width of the fixed action region as the DOM reports it.
   *
   * Because it is *measured*, it already includes the Overview control whenever
   * that control is rendered — which is what makes showing the Overview shrink the
   * Tab viewport instead of leaving the Tabs laid out for the wider one (T228).
   */
  actionsWidth: number;
}

export interface TabStripSolveInput extends TabStripMeasurement {
  /** Each Tab's content-derived width, clamped to the density bounds. */
  naturalWidths: readonly number[];
  /** Narrowest a Tab may shrink to. */
  minWidth: number;
  /** Comfortable Tab width; the ceiling for a content-sized Tab. */
  maxWidth: number;
  /** Forces the Overview control on even without measured overflow (T183). */
  forceOverview?: boolean;
}

/** The rendered solution for one set of observed sizes. */
export interface TabStripSolve {
  /** Width the scrolling Tab list may occupy; the fixed actions are excluded. */
  viewportWidth: number;
  /** The Tab widths for that viewport. */
  layout: TabLayout;
  /** Whether the Overview control is offered (FR-069). */
  showOverview: boolean;
}

/**
 * Turns the observed strip and action sizes into the Tab widths to render (T228).
 *
 * One pure step, so the component's only job is *observing* the two boxes: the
 * viewport is the strip minus the action region, the widths follow from that
 * viewport, and the Overview is offered exactly when the result overflows
 * (FR-067..FR-069).
 *
 * The Overview costs viewport width, so this is evaluated repeatedly while the
 * control appears — but it cannot oscillate: `overflows` is monotone in the
 * viewport width (a list that overflows at some width also overflows at any
 * narrower one), so once the Overview is offered, shrinking the viewport by its
 * own width keeps it offered. The loop therefore settles in one extra pass.
 */
export function solveTabStrip(input: TabStripSolveInput): TabStripSolve {
  const viewportWidth = tabViewportWidth(input.stripWidth, input.actionsWidth);
  const layout = computeTabLayout({
    naturalWidths: input.naturalWidths,
    viewportWidth,
    minWidth: input.minWidth,
    maxWidth: input.maxWidth,
  });

  return {
    viewportWidth,
    layout,
    showOverview:
      (input.forceOverview ?? false) ||
      tabListOverflows(layout.contentWidth, viewportWidth),
  };
}
