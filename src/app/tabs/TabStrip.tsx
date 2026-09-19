/**
 * The Tab strip (007 T130..T138, FR-061..FR-068).
 *
 * Presentation only: it renders the metadata it is given and reports the document
 * id the user acted on. It never reads document text, never decides which document
 * becomes active, and never stores visual style anywhere but its own UI state.
 *
 * 007 supersedes 004's Tab strip in three ways (SR-001):
 *
 * - Tabs and the fixed actions are **separate regions**, so New (`+`) can never
 *   scroll out of view (FR-067, FR-068);
 * - Tabs shrink to a density minimum and then the *Tab list* scrolls, instead of
 *   the whole strip scrolling (FR-064, FR-065);
 * - the active Tab is revealed by computing a viewport-bounded scroll offset,
 *   because `scrollIntoView()` could scroll an outer container or hide a Tab
 *   beneath the fixed actions (FR-066, T137).
 *
 * The strip lives inside the Editor Group, so the AppShell no longer knows about
 * document Tabs at all (FR-061, T131).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AppIcon } from "../shell/AppIcon";
import type { DensityMetrics } from "../shell/density";
import {
  createUiLabelMeasurer,
  readUiFontSource,
  type FontSource,
} from "../shell/textMeasurement";
import type { DocumentId, TabSnapshot } from "../document/documentSession";
import { TabOverview } from "./TabOverview";
import {
  revealTabOffset,
  solveTabStrip,
  tabOffsets,
  measureTabWidths,
  type TabStripMeasurement,
} from "./tabLayout";

import "../../styles/tabs.css";

/** The measurer font used when the root font cannot be read (no DOM). */
const FALLBACK_FONT: FontSource = {
  fontSize: "13px",
  fontFamily: "system-ui, sans-serif",
};

/** Nothing is assumed about the strip before the first measurement. */
const UNMEASURED: TabStripMeasurement = { stripWidth: 0, actionsWidth: 0 };

export interface TabStripProps {
  /** The manager's lightweight projection, in Tab order. */
  tabs: readonly TabSnapshot[];
  /** Activates a Tab; the manager focuses the editor. */
  onSelect(id: DocumentId): void;
  /** Closes a Tab through the manager's close flow. */
  onClose(id: DocumentId): void;
  /**
   * Creates a new Untitled document.
   *
   * Wired to the same `file.new` command as Ctrl+N and File > New, so the `+`
   * cannot diverge from the other New surfaces (FR-068).
   */
  onNew(): void;
  /** The active density metrics: Tab height/min/max come from here (T134). */
  metrics: DensityMetrics;
  /**
   * Forces the Overview control on even without measured overflow.
   *
   * Used by the development fixture so the many-Tab presentation can be inspected
   * at a comfortable width (T183).
   */
  forceOverview?: boolean;
}

/** Renders the Tab strip: one scrolling Tab viewport plus fixed actions. */
export function TabStrip({
  tabs,
  onSelect,
  onClose,
  onNew,
  metrics,
  forceOverview = false,
}: TabStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  const [measurement, setMeasurement] =
    useState<TabStripMeasurement>(UNMEASURED);

  /*
   * A Tab is as wide as its own content, bounded by the density bounds (FR-065,
   * T134): one short document name no longer produces a half-empty Tab. The label
   * is measured with the shared UI-font measurer, and the widths are only
   * recomputed when the Tab set or the bounds change — never per scroll frame.
   */
  const bounds = useMemo(
    () => ({ minWidth: metrics.tabMinWidth, maxWidth: metrics.tabMaxWidth }),
    [metrics.tabMaxWidth, metrics.tabMinWidth],
  );
  const measurer = useMemo(
    () => createUiLabelMeasurer(readUiFontSource() ?? FALLBACK_FONT),
    [],
  );
  const naturalWidths = useMemo(
    () => measureTabWidths(tabs, measurer, bounds),
    [bounds, measurer, tabs],
  );

  // One pure step from observed sizes to rendered widths, so a viewport resize, an
  // Overview appearing and a density transition all take the same path (T228).
  const solve = useMemo(
    () =>
      solveTabStrip({
        naturalWidths,
        stripWidth: measurement.stripWidth,
        actionsWidth: measurement.actionsWidth,
        minWidth: metrics.tabMinWidth,
        maxWidth: metrics.tabMaxWidth,
        forceOverview,
      }),
    [
      forceOverview,
      measurement,
      metrics.tabMaxWidth,
      metrics.tabMinWidth,
      naturalWidths,
    ],
  );
  const { layout, viewportWidth, showOverview } = solve;

  /*
   * The strip's two sizes are measured, never assumed (T132, T138): the available
   * Tab width is the strip minus its fixed action region.
   *
   * Both boxes are observed, not just the strip. Showing the Overview control
   * changes the *action region's* width without changing the strip's, and a
   * density switch changes the action controls' size the same way; a strip-only
   * observation would leave the Tab viewport stale, and a viewport that is too
   * wide is exactly what lets the fixed actions cover the active Tab (T228).
   *
   * `showOverview` participates so the width the Overview costs is subtracted in
   * the same frame the control first appears, before anything is painted — and,
   * because `overflows` is monotone in the viewport width, that second pass settles
   * instead of oscillating.
   */
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip === null) {
      return;
    }

    const actions = actionsRef.current;

    const measure = (): void => {
      const stripWidth = strip.clientWidth;
      const actionsWidth = actions?.offsetWidth ?? 0;
      setMeasurement((previous) =>
        previous.stripWidth === stripWidth && previous.actionsWidth === actionsWidth
          ? previous
          : { stripWidth, actionsWidth },
      );
    };
    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        window.removeEventListener("resize", measure);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    if (actions !== null && actions !== undefined) {
      observer.observe(actions);
    }
    return () => {
      observer.disconnect();
    };
  }, [metrics.tabMaxWidth, metrics.tabMinWidth, showOverview, tabs.length]);

  const offsets = useMemo(() => tabOffsets(layout.widths), [layout.widths]);

  const activeIndex = tabs.findIndex((tab) => tab.active);

  // Reveal the active Tab within the *Tab viewport* only (FR-066, T137). The Tab's
  // own left edge is used rather than an index-times-width product, so the reveal
  // stays exact while Tabs are content-sized. It re-runs whenever the viewport
  // changes size, which is what keeps the active Tab out from under New/Overview
  // (T228).
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null || activeIndex < 0) {
      return;
    }

    const next = revealTabOffset({
      scrollLeft: viewport.scrollLeft,
      viewportWidth,
      contentWidth: layout.contentWidth,
      tabStart: offsets[activeIndex] ?? 0,
      tabWidth: layout.widths[activeIndex] ?? metrics.tabMinWidth,
    });
    if (next !== viewport.scrollLeft) {
      viewport.scrollLeft = next;
    }
  }, [
    activeIndex,
    layout.contentWidth,
    layout.widths,
    metrics.tabMinWidth,
    offsets,
    viewportWidth,
  ]);

  return (
    <div className="tab-strip" ref={stripRef}>
      <div
        className="tab-strip__viewport"
        ref={viewportRef}
        role="tablist"
        aria-label="Open documents"
      >
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            className={tab.active ? "tab tab--active" : "tab"}
            style={{ width: `${layout.widths[index] ?? metrics.tabMinWidth}px` }}
            role="tab"
            aria-selected={tab.active}
            tabIndex={tab.active ? 0 : -1}
            // FR-014: the full path stays available even when two Tabs share a
            // base filename.
            title={tab.path ?? tab.displayName}
            onClick={() => {
              onSelect(tab.id);
            }}
          >
            <span className="tab__label">{tab.displayName}</span>
            {/*
              005 (FR-041): the external disk state is shown non-modally, because
              a modal dialog on every watcher event would be unusable. The marker
              is a projection of manager-owned state, and it stays visible at the
              minimum Tab width (T135).
            */}
            {tab.externalState === "modified" ? (
              <span
                className="tab__external tab__external--modified"
                role="img"
                aria-label="Changed on disk"
                title="Changed on disk by another program"
              >
                ↻
              </span>
            ) : null}
            {tab.externalState === "missing" ? (
              <span
                className="tab__external tab__external--missing"
                role="img"
                aria-label="Missing on disk"
                title="Deleted on disk; Save recreates the file"
              >
                ⚠
              </span>
            ) : null}
            {tab.dirty ? (
              <span className="tab__dirty" title="Unsaved changes">
                ●
              </span>
            ) : null}
            <button
              type="button"
              className="tab__close"
              aria-label={`Close ${tab.displayName}`}
              onClick={(event) => {
                // Closing an inactive Tab must not also activate it (T136).
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              <AppIcon name="close" />
            </button>
          </div>
        ))}
      </div>

      {/*
        The fixed action region: it is outside the scrolling viewport, which is
        what makes New permanently reachable — including with zero Tabs — and
        keeps it out of the scroll arithmetic (FR-067, FR-068, SR-001).
      */}
      <div className="tab-strip__actions" ref={actionsRef}>
        {showOverview ? <TabOverview tabs={tabs} onSelect={onSelect} /> : null}
        <button
          type="button"
          className="tab-strip__action tab-strip__new"
          aria-label="New document"
          title="New (Ctrl+N)"
          onClick={onNew}
        >
          <AppIcon name="plus" />
        </button>
      </div>
    </div>
  );
}
