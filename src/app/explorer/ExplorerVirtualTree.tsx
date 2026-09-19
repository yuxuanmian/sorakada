/**
 * The virtualized Explorer Tree (007 T087..T090, T096..T101).
 *
 * It receives the projection and callbacks and nothing else: no service, no
 * controller, no filesystem. The whole point is that mounted row elements are
 * bounded by the *viewport* rather than by how many nodes the user expanded
 * (FR-035, FR-036, SC-001).
 *
 * Decisions worth naming:
 *
 * - **React 19 path.** `useFlushSync: false` is set deliberately: TanStack's
 *   React guidance calls out React 19's lifecycle behaviour as the reason not to
 *   flush synchronously during scroll (T088).
 * - **Fixed row height.** Every row — nodes, sentinels and the inline editor —
 *   is one density-derived height, so scroll offsets are exact and `scrollToIndex`
 *   is reliable (T089, FR-040).
 * - **Stable focus owner.** The scroll viewport owns keyboard focus; a row click
 *   selects the logical path and returns focus to the viewport, so recycling the
 *   selected row cannot take Explorer keyboard scope with it (T096).
 * - **Pinned inline editor.** While an inline editor is active its logical row is
 *   forced into the mounted range, so virtualization itself can never blur it and
 *   thereby cancel the edit (FR-037, T097, T098).
 * - **Measured horizontal extent.** The content layer is as wide as the widest
 *   *materialized* row, computed from the projection, so an off-screen wide row
 *   still produces a horizontal scrollbar without mounting every row (FR-042,
 *   FR-043).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from "@tanstack/react-virtual";

import type { DensityMetrics } from "../shell/density";
import type { UiDebugOptions } from "../shell/uiDebugState";
import type { InlineCommitResult } from "./explorerActions";
import type { ExplorerState } from "./explorerModel";
import { ExplorerRow } from "./ExplorerRow";
import {
  inlineEditRowKey,
  planRowReveal,
  type VisibleExplorerRow,
} from "./explorerProjection";
import {
  TREE_OVERSCAN_ROWS,
  activeDescendantFor,
  computeTreeHorizontalExtent,
  treeRowDomId,
  withPinnedIndex,
} from "./explorerTreeMetrics";
import { createUiLabelMeasurer, readUiFontSource, type LabelMeasurer } from "../shell/textMeasurement";

/** What the Tree reports about its own mounting, for debug instrumentation. */
export interface ExplorerVirtualRange {
  /** How many rows the projection currently contains. */
  visibleRowCount: number;
  /** How many row elements are actually mounted. */
  renderedRowCount: number;
  /** First mounted projection index, or `-1` when nothing is mounted. */
  virtualStart: number;
  /** Last mounted projection index, or `-1` when nothing is mounted. */
  virtualEnd: number;
}

export interface ExplorerVirtualTreeProps {
  /** The controller's current state (selection, expansion, inline edit). */
  state: ExplorerState;
  /** The flattened visible rows to render. */
  rows: readonly VisibleExplorerRow[];
  /** The active density metrics; the row height comes from here. */
  metrics: DensityMetrics;
  /**
   * A logical row key to reveal, or `null`/`undefined` for no pending reveal.
   *
   * The request is expressed as a *logical* key rather than an index, so a
   * watcher update between the request and the reveal cannot move the target
   * (FR-048, T110).
   */
  revealKey?: string | null;
  /** Reports that the pending reveal has been serviced. */
  onRevealHandled?(): void;
  /**
   * A token that, when it changes, asks the Tree viewport to take focus.
   *
   * The viewport is the stable focus owner, so components that need keyboard
   * scope back (closing transient search, servicing a locate) request it instead
   * of focusing a recyclable row (T096, T109).
   */
  focusToken?: number;
  onSelect(path: string): void;
  onToggleDirectory(path: string): void;
  onOpenFile(path: string): void;
  onInlineDraftChange(name: string): void;
  onInlineCommit(): Promise<InlineCommitResult>;
  onInlineCancel(): void;
  /** Reports mounted-range changes; `null` when nothing is rendered. */
  onVirtualRangeChange?(range: ExplorerVirtualRange | null): void;
  /** Development diagnostics (T180, T181). */
  debugOptions?: UiDebugOptions;
}

/** Measures row labels with the shared UI-font measurer (T085, T134). */
function createMeasurer(): LabelMeasurer {
  return createUiLabelMeasurer(
    readUiFontSource() ?? {
      fontSize: "13px",
      fontFamily: "system-ui, sans-serif",
    },
  );
}

/** Renders the virtual Tree viewport. */
export function ExplorerVirtualTree(props: ExplorerVirtualTreeProps) {
  const { metrics, rows, state } = props;

  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  /*
   * The measurement font comes from the root tokens, not from density, so a
   * density switch never changes measured label widths (FR-081, T160). The
   * measurer is still rebuilt per density so its cache can never be read across a
   * metric change (T086).
   */
  const measurer = useMemo(
    () => createMeasurer(),
    // `metrics` participates so a density change discards label widths measured
    // for the previous layout.
    [metrics],
  );

  const rowHeight = metrics.treeRowHeight;

  /**
   * The projection index of the active inline editor, or `-1`.
   *
   * This is what keeps an inline edit mounted while the user scrolls: 004's blur
   * semantics would otherwise cancel the edit simply because virtualization
   * unmounted the row (FR-037, T097, T098).
   */
  const editRowIndex = useMemo(() => {
    const edit = state.inlineEdit;
    if (edit === null) {
      return -1;
    }
    const key = inlineEditRowKey(edit);
    return rows.findIndex((row) => row.key === key);
  }, [rows, state.inlineEdit]);

  const rangeExtractor = useCallback(
    (range: Range): number[] =>
      // The pinned inline-edit row makes the mounted set non-contiguous, which is
      // why mounted-ness is never derived from a first-to-last span (T230).
      withPinnedIndex(defaultRangeExtractor(range), editRowIndex),
    [editRowIndex],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => rowHeight,
    overscan: TREE_OVERSCAN_ROWS,
    rangeExtractor,
    // React 19 guidance: do not flush synchronous updates from the virtualizer.
    useFlushSync: false,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const virtualStart = virtualItems.length === 0 ? -1 : virtualItems[0].index;
  const virtualEnd =
    virtualItems.length === 0 ? -1 : virtualItems[virtualItems.length - 1].index;

  // T089/T038: a density change invalidates the measured row geometry.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  // T099: the horizontal scrollbar appears only when the materialized content is
  // actually wider than the viewport. Measured before paint so the first frame
  // cannot show a scrollbar that is about to disappear.
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (element === null) {
      return;
    }
    const measure = (): void => {
      setViewportWidth(element.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        window.removeEventListener("resize", measure);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const extent = useMemo(
    () =>
      computeTreeHorizontalExtent({
        rows,
        metrics,
        measurer,
      }),
    [measurer, metrics, rows],
  );

  // Reveal requests are serviced by logical key (T110, T120). A request whose row
  // is not in the projection *yet* stays pending instead of being dropped: a locate
  // that just expanded a collapsed ancestor produces the row one render later.
  const { onRevealHandled, revealKey } = props;
  useEffect(() => {
    if (revealKey === null || revealKey === undefined) {
      return;
    }
    const plan = planRowReveal(rows, revealKey);
    if (!plan.handled) {
      return;
    }
    virtualizer.scrollToIndex(plan.index, { align: "auto" });
    onRevealHandled?.();
  }, [onRevealHandled, revealKey, rows, virtualizer]);

  // A newly started inline editor is revealed before it takes focus (T097).
  useEffect(() => {
    if (editRowIndex < 0) {
      return;
    }
    virtualizer.scrollToIndex(editRowIndex, { align: "auto" });
  }, [editRowIndex, virtualizer]);

  // Focus requests are serviced on the viewport, never on a row (T096).
  const { focusToken } = props;
  useEffect(() => {
    if (focusToken === undefined || focusToken === 0) {
      return;
    }
    viewportRef.current?.focus();
  }, [focusToken]);

  // Mounted-range reporting, for the development diagnostics only (T180).
  const report = props.onVirtualRangeChange;
  useEffect(() => {
    if (report === undefined) {
      return;
    }
    report(
      rows.length === 0
        ? null
        : {
            visibleRowCount: rows.length,
            renderedRowCount: virtualItems.length,
            virtualStart,
            virtualEnd,
          },
    );
  }, [report, rows.length, virtualEnd, virtualItems.length, virtualStart]);

  const selectedPath = state.selectedPath;
  const selectedIndex =
    selectedPath === null
      ? -1
      : rows.findIndex((row) => row.key === selectedPath);
  /*
   * Only point at a row that is actually mounted: an active descendant must name
   * an existing element. The mounted indexes are tested one by one, because a
   * pinned inline-edit row puts a hole inside the mounted span (T230).
   */
  const activeDescendant = activeDescendantFor(
    selectedIndex,
    virtualItems.map((item) => item.index),
  );

  const horizontalOverflow = extent.contentWidth > viewportWidth;

  const bodyClasses = ["explorer__body"];
  if (horizontalOverflow) {
    bodyClasses.push("explorer__body--overflow-x");
  }

  return (
    <div
      ref={viewportRef}
      className={bodyClasses.join(" ")}
      // The stable focus owner: F2/Delete and type-to-search are scoped to the
      // Tree, never to a recyclable row (T096).
      tabIndex={0}
      role="tree"
      aria-label="Workspace files"
      aria-activedescendant={activeDescendant}
      data-virtual-rendered={virtualItems.length}
    >
      <div
        className="explorer-tree"
        style={{
          height: `${totalSize}px`,
          minWidth: `${extent.contentWidth}px`,
        }}
      >
        {virtualItems.map((item) => {
          const row = rows[item.index];
          return (
            <div
              key={row.key}
              id={treeRowDomId(item.index)}
              className="explorer-tree__row"
              style={{ height: `${item.size}px`, transform: `translateY(${item.start}px)` }}
            >
              <ExplorerRow
                row={row}
                state={state}
                metrics={metrics}
                debugOptions={props.debugOptions}
                onSelect={props.onSelect}
                onToggleDirectory={props.onToggleDirectory}
                onOpenFile={props.onOpenFile}
                onInlineDraftChange={props.onInlineDraftChange}
                onInlineCommit={props.onInlineCommit}
                onInlineCancel={props.onInlineCancel}
                onReturnFocus={() => {
                  viewportRef.current?.focus();
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
