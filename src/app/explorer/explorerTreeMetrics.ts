/**
 * Explorer Tree metrics and horizontal extent (007 T084..T086, FR-042..FR-044).
 *
 * Virtualization removes off-screen rows from the DOM, so the Tree can no longer
 * learn its horizontal `scrollWidth` from the browser: the widest materialized row
 * may simply not be mounted. This module derives the extent from the *visible
 * projection* plus measured label widths, so the scrollbar is correct without
 * mounting every row and without reading the filesystem (SC-010, FR-043, FR-044).
 *
 * The label measurer is injected. Production uses one Canvas 2D measurement
 * context (T085); tests inject a deterministic measurer, which is what makes the
 * arithmetic provable.
 */

import type { DensityMetrics } from "../shell/density";
import type { LabelMeasurer } from "../shell/textMeasurement";
import type { VisibleExplorerRow } from "./explorerProjection";

/** Measures the rendered width of one label, in CSS pixels. */
export type TreeLabelMeasurer = LabelMeasurer;

/**
 * Fixed horizontal widths a row spends before and after its label.
 *
 * Every value comes from the density metric table, so a density change moves the
 * Tree's extent with the rows instead of leaving a stale constant behind (T094).
 */
export interface TreeAffordanceWidths {
  /** Row start padding plus the depth-0 offset. */
  paddingLeft: number;
  /** Row end padding. */
  paddingRight: number;
  /** Chevron column, present even for files so labels stay aligned. */
  chevron: number;
  /** Icon column. */
  icon: number;
  /** Gap between two inline row elements. */
  gap: number;
  /** Link badge, when present. */
  badge: number;
  /** Horizontal scrollbar slack, so the widest label is never clipped. */
  slack: number;
}

/** The widths one row spends besides its indentation and label. */
export const TREE_AFFORDANCE_SLACK = 8;

/** Derives the affordance widths from the density metrics. */
export function treeAffordances(metrics: DensityMetrics): TreeAffordanceWidths {
  return {
    paddingLeft: 8,
    paddingRight: metrics.gap * 2,
    chevron: metrics.treeChevronSize,
    icon: 16,
    gap: metrics.gap,
    badge: 16,
    slack: TREE_AFFORDANCE_SLACK,
  };
}

/** The indent one depth level contributes. */
export function rowIndent(depth: number, metrics: DensityMetrics): number {
  return depth * metrics.treeIndent;
}

/**
 * The indent slots one row draws (008 Explorer guide polish).
 *
 * The Tree renders one *purely vertical* guide per ancestor level and no
 * horizontal connectors at all, so a slot needs no per-level variation: the count
 * is the only thing the row can get wrong, and getting it wrong is what would
 * misalign the chevron and label, because the slots and `rowIndent` have to
 * describe the very same width.
 *
 * This is presentation only — it reads the row's depth and never influences
 * expansion, selection or projection order.
 */
export function guideSlotCount(depth: number): number {
  return Math.max(0, depth);
}

/**
 * Bounded overscan (plan §9).
 *
 * Mounting a few rows above and below the viewport keeps scrolling smooth; the
 * value is deliberately small so the mounted row count stays bounded by the
 * *viewport*, never by the visible-node count (FR-036, SC-001).
 */
export const TREE_OVERSCAN_ROWS = 10;

/**
 * The greatest number of rows a viewport of this height can mount.
 *
 * SC-001 asks for fewer than 200 mounted rows with 10,000 visible ones; this
 * bound is what the configuration has to satisfy, and it is asserted by
 * `explorerTreeMetrics.test.ts` so an overscan change cannot silently break the
 * acceptance criterion.
 */
export function maxMountedRows(
  viewportHeight: number,
  rowHeight: number,
  overscan = TREE_OVERSCAN_ROWS,
): number {
  if (rowHeight <= 0) {
    return 0;
  }
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight);
  // Two overscan margins plus one row for the partially scrolled edge.
  return visible + overscan * 2 + 1;
}

/**
 * The DOM id of the row at `index`.
 *
 * Row elements are recycled, so the id is derived from the position the row
 * currently occupies — the accessible active-descendant pointer is therefore
 * recomputed per render rather than stored against a row.
 */
export function treeRowDomId(index: number): string {
  return `explorer-tree-row-${index}`;
}

/**
 * Adds one pinned index to a mounted set (T096, T230).
 *
 * The mounted set is **not** a contiguous index span. While an inline editor is
 * active its logical row is forced into the mounted range (FR-037), so a row that
 * has scrolled far out of the viewport is mounted *in addition to* the viewport's
 * own range — the mounted indexes become `[start..end, pinned]` with a hole in
 * between. This helper is the single place that union is formed, so the shape it
 * produces can be asserted without a virtualizer.
 */
export function withPinnedIndex(
  indexes: readonly number[],
  pinnedIndex: number,
): number[] {
  if (pinnedIndex < 0 || indexes.includes(pinnedIndex)) {
    return [...indexes];
  }
  return [...indexes, pinnedIndex].sort((left, right) => left - right);
}

/**
 * The accessible active-descendant pointer for the selected row (T230).
 *
 * `aria-activedescendant` may only name an element that exists in the DOM, so a
 * selected row that is not mounted yields no pointer at all. Membership is tested
 * against the exact mounted set rather than against its first-to-last span: with
 * a pinned off-screen inline editor mounted, an unmounted row can sit *inside*
 * that span, and naming it would point assistive technology at nothing (FR-037).
 */
export function activeDescendantFor(
  selectedIndex: number,
  mountedIndexes: readonly number[],
): string | undefined {
  if (selectedIndex < 0 || !mountedIndexes.includes(selectedIndex)) {
    return undefined;
  }
  return treeRowDomId(selectedIndex);
}

/** The label a row displays; sentinel rows show their message. */
export function rowLabel(row: VisibleExplorerRow): string {
  if (row.kind === "node") {
    return row.node.name;
  }
  if (row.kind === "notice") {
    return row.message;
  }
  return row.edit.draftName;
}

/** The minimum width of one row: indentation plus fixed affordances. */
export function minimumRowWidth(
  row: VisibleExplorerRow,
  metrics: DensityMetrics,
  affordances: TreeAffordanceWidths,
): number {
  return (
    rowIndent(row.depth, metrics) +
    affordances.paddingLeft +
    affordances.paddingRight +
    affordances.chevron +
    affordances.icon +
    affordances.gap * 2 +
    (row.kind === "node" && row.node.isSymlink ? affordances.badge : 0)
  );
}

export interface TreeHorizontalExtent {
  /** The width the virtual content layer must be able to occupy. */
  contentWidth: number;
  /** The key of the widest row, or `null` for an empty projection. */
  widestKey: string | null;
  /** The label of the widest row, for diagnostics. */
  widestLabel: string | null;
}

/**
 * Computes the horizontal extent of the whole visible projection.
 *
 * The answer accounts for rows that are currently outside the vertical viewport,
 * because it is derived from the projection rather than from mounted DOM.
 */
export function computeTreeHorizontalExtent(options: {
  rows: readonly VisibleExplorerRow[];
  metrics: DensityMetrics;
  measurer: TreeLabelMeasurer;
  affordances?: TreeAffordanceWidths;
}): TreeHorizontalExtent {
  const affordances = options.affordances ?? treeAffordances(options.metrics);
  const measurer = options.measurer;

  let contentWidth = 0;
  let widestKey: string | null = null;
  let widestLabel: string | null = null;

  for (const row of options.rows) {
    const label = rowLabel(row);
    const width =
      minimumRowWidth(row, options.metrics, affordances) +
      measurer.measure(label) +
      affordances.slack;

    if (width > contentWidth) {
      contentWidth = width;
      widestKey = row.key;
      widestLabel = label;
    }
  }

  return { contentWidth, widestKey, widestLabel };
}

/*
 * Label measurement lives in `src/app/shell/textMeasurement.ts` (007 T134): the
 * Tab strip needs the same primitive, so the Tree imports it from there instead
 * of owning a second copy.
 */
