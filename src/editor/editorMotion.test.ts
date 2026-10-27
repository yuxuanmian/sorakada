import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { Direction, EditorView } from "@codemirror/view";

import { createEditorState } from "./editorConfig";
import {
  computeScrollMoveX,
  computeScrollMoveY,
  computeTargetScrollTop,
  easeOutCubic,
  EditorMotionPluginValue,
  handleScrollIntoView,
  getScrollMargins,
  getVisibleViewportBounds,
  isCoordsInVisibleViewport,
  hasVerticalScrollMargins,
  hasCustomScrollMargins,
  hasTransformScale,
  isEditorMotionEnabled,
  isMotionActive,
  isDocumentMotionAllowed,
  isReducedMotionActive,
  MOTION_CONFIG,
  searchMotionAnnotation,
  setEditorMotionEnabled,
  setReducedMotionForTesting,
  shouldAnimateCaret,
  shouldAnimatePointerDrag,
  shouldAnimatePointerClick,
  shouldAnimateSelectionExpandShrink,
  isNormalTypingInputType,
  shouldAnimateTyping,
  shouldAnimateViewportScroll,
  computeTargetScrollLeft,
  SCROLL_FOLLOWUP_MEASURE_KEY,
} from "./editorMotion";

describe("editorMotion preference and reduced-motion states", () => {
  beforeEach(() => {
    setEditorMotionEnabled(true);
    setReducedMotionForTesting(false);
  });

  afterEach(() => {
    setEditorMotionEnabled(true);
    setReducedMotionForTesting(false);
  });

  it("defaults to enabled", () => {
    expect(isEditorMotionEnabled()).toBe(true);
    expect(isReducedMotionActive()).toBe(false);
    expect(isMotionActive()).toBe(true);
  });

  it("disables motion when editorMotion preference is set to false", () => {
    setEditorMotionEnabled(false);
    expect(isEditorMotionEnabled()).toBe(false);
    expect(isMotionActive()).toBe(false);
  });

  it("prioritizes system reduced motion over user preference", () => {
    setEditorMotionEnabled(true);
    setReducedMotionForTesting(true);

    expect(isEditorMotionEnabled()).toBe(true);
    expect(isReducedMotionActive()).toBe(true);
    expect(isMotionActive()).toBe(false);
  });

  it("re-enables motion only when both preference is true and reduced motion is false", () => {
    setEditorMotionEnabled(false);
    setReducedMotionForTesting(true);
    expect(isMotionActive()).toBe(false);

    setEditorMotionEnabled(true);
    expect(isMotionActive()).toBe(false);

    setReducedMotionForTesting(false);
    expect(isMotionActive()).toBe(true);
  });
});

describe("easeOutCubic curve", () => {
  it("starts at 0 and ends at 1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("decelerates smoothly", () => {
    const mid = easeOutCubic(0.5);
    // At t=0.5, 1 - 0.5^3 = 0.875
    expect(mid).toBe(0.875);
    expect(mid).toBeGreaterThan(0.5);
  });
});

describe("shouldAnimateCaret pure eligibility logic", () => {
  const baseParams = {
    isMotionActive: true,
    isComposing: false,
    docChanged: false,
    pointerDown: false,
    isRecentKeyNav: true,
    oldRangesCount: 1,
    newRangesCount: 1,
    charDist: 10,
    lineDist: 1,
  };

  it("returns true when all conditions for keyboard navigation are satisfied", () => {
    expect(shouldAnimateCaret(baseParams)).toBe(true);
  });

  it("returns false when motion is inactive", () => {
    expect(shouldAnimateCaret({ ...baseParams, isMotionActive: false })).toBe(false);
  });

  it("returns false during IME composition", () => {
    expect(shouldAnimateCaret({ ...baseParams, isComposing: true })).toBe(false);
  });

  it("returns false when document changed (typing, deleting, pasting)", () => {
    expect(shouldAnimateCaret({ ...baseParams, docChanged: true })).toBe(false);
  });

  it("returns false on pointer interaction (mouse click or drag)", () => {
    expect(shouldAnimateCaret({ ...baseParams, pointerDown: true })).toBe(false);
  });

  it("returns false when not a recent keyboard navigation", () => {
    expect(shouldAnimateCaret({ ...baseParams, isRecentKeyNav: false })).toBe(false);
  });

  it("returns false when cursor count changes (e.g. adding cursor 1->2 or merging 3->2)", () => {
    expect(
      shouldAnimateCaret({
        ...baseParams,
        oldRangesCount: 1,
        newRangesCount: 2,
      }),
    ).toBe(false);

    expect(
      shouldAnimateCaret({
        ...baseParams,
        oldRangesCount: 3,
        newRangesCount: 2,
      }),
    ).toBe(false);
  });

  it("returns false when cursor count exceeds maxCursorCount threshold (> 10)", () => {
    expect(
      shouldAnimateCaret({
        ...baseParams,
        oldRangesCount: 11,
        newRangesCount: 11,
      }),
    ).toBe(false);

    expect(
      shouldAnimateCaret({
        ...baseParams,
        oldRangesCount: 10,
        newRangesCount: 10,
      }),
    ).toBe(true);
  });

  it("returns false on large character jump (> 500 chars)", () => {
    expect(
      shouldAnimateCaret({
        ...baseParams,
        charDist: 501,
      }),
    ).toBe(false);
  });

  it("returns false on large line jump (> 5 lines)", () => {
    expect(
      shouldAnimateCaret({
        ...baseParams,
        lineDist: 6,
      }),
    ).toBe(false);

    expect(
      shouldAnimateCaret({
        ...baseParams,
        lineDist: 5,
      }),
    ).toBe(true);
  });
});

describe("computeScrollMoveY and computeScrollMoveX calculation", () => {
  const bounding = { left: 0, right: 600, top: 100, bottom: 600 };

  it("returns 0 when target rect is already completely visible", () => {
    const moveY = computeScrollMoveY({
      yStrategy: "nearest",
      rect: { top: 200, bottom: 220 },
      bounding,
      yMargin: 10,
      side: 1,
    });
    expect(moveY).toBe(0);

    const moveX = computeScrollMoveX({
      xStrategy: "nearest",
      rect: { left: 50, right: 100 },
      bounding,
      xMargin: 10,
      side: 1,
      ltr: true,
    });
    expect(moveX).toBe(0);
  });

  it("computes negative moveY when target is above the viewport", () => {
    const moveY = computeScrollMoveY({
      yStrategy: "nearest",
      rect: { top: 50, bottom: 70 },
      bounding,
      yMargin: 10,
      side: 1,
    });
    expect(moveY).toBe(-60);
  });

  it("computes positive moveY when target is below the viewport", () => {
    const moveY = computeScrollMoveY({
      yStrategy: "nearest",
      rect: { top: 620, bottom: 640 },
      bounding,
      yMargin: 10,
      side: 1,
    });
    expect(moveY).toBe(50);
  });

  it("computes moveX when target is left or right of viewport", () => {
    const moveLeft = computeScrollMoveX({
      xStrategy: "nearest",
      rect: { left: -30, right: 20 },
      bounding,
      xMargin: 10,
      side: 1,
      ltr: true,
    });
    // rect.left (-30) - (bounding.left (0) + 10) = -40
    expect(moveLeft).toBe(-40);

    const moveRight = computeScrollMoveX({
      xStrategy: "nearest",
      rect: { left: 580, right: 630 },
      bounding,
      xMargin: 10,
      side: 1,
      ltr: true,
    });
    // rect.right (630) - bounding.right (600) + 10 = 40
    expect(moveRight).toBe(40);
  });

  it("computes target position for center and start strategies", () => {
    const moveCenter = computeScrollMoveY({
      yStrategy: "center",
      rect: { top: 300, bottom: 320 },
      bounding,
      yMargin: 10,
      side: 1,
    });
    expect(moveCenter).toBe(-40);

    const moveStart = computeScrollMoveY({
      yStrategy: "start",
      rect: { top: 250, bottom: 270 },
      bounding,
      yMargin: 15,
      side: 1,
    });
    expect(moveStart).toBe(135);
  });
});

describe("computeTargetScrollTop clamping logic", () => {
  it("adds moveY within normal scroll range", () => {
    const target = computeTargetScrollTop(200, 50, 1000, 400);
    expect(target).toBe(250);
  });

  it("clamps to 0 when moveY is negative beyond the top", () => {
    const target = computeTargetScrollTop(50, -100, 1000, 400);
    expect(target).toBe(0);
  });

  it("clamps to max scrollable height (scrollHeight - clientHeight)", () => {
    const target = computeTargetScrollTop(580, 50, 1000, 400);
    expect(target).toBe(600);
  });
});

describe("shouldAnimateViewportScroll pure eligibility logic", () => {
  const baseParams = {
    isMotionActive: true,
    isRecentKeyNav: true,
    isMainSelection: true,
    docLines: 500,
    hasCoords: true,
    moveY: 150,
  };

  it("returns true when all conditions are satisfied", () => {
    expect(shouldAnimateViewportScroll(baseParams)).toBe(true);
  });

  it("returns false when motion is inactive", () => {
    expect(shouldAnimateViewportScroll({ ...baseParams, isMotionActive: false })).toBe(false);
  });

  it("returns false when not a recent keyboard navigation", () => {
    expect(shouldAnimateViewportScroll({ ...baseParams, isRecentKeyNav: false })).toBe(false);
  });

  it("returns false for non-main selections", () => {
    expect(shouldAnimateViewportScroll({ ...baseParams, isMainSelection: false })).toBe(false);
  });

  it("returns false for documents with > 50,000 lines (large document fallback)", () => {
    expect(shouldAnimateViewportScroll({ ...baseParams, docLines: 50001 })).toBe(false);
    expect(shouldAnimateViewportScroll({ ...baseParams, docLines: 50000 })).toBe(true);
  });

  it("returns false when target coordinates are unavailable (virtualized)", () => {
    expect(shouldAnimateViewportScroll({ ...baseParams, hasCoords: false })).toBe(false);
  });

  it("returns false when moveY is less than 1px", () => {
    expect(shouldAnimateViewportScroll({ ...baseParams, moveY: 0.5 })).toBe(false);
  });

  it("returns false when move distance exceeds maxAnimDistancePx (> 2500px, fallback to native instant jump)", () => {
    expect(shouldAnimateViewportScroll({ ...baseParams, moveY: 2501 })).toBe(false);
    expect(shouldAnimateViewportScroll({ ...baseParams, moveY: 2500 })).toBe(true);
  });
});

describe("getScrollMargins, hasVerticalScrollMargins, and hasTransformScale helpers", () => {
  it("detects transform scaling via view scale properties or offset dimensions without false positives from 12px scrollbar", () => {
    // 1. Authoritative view scale properties
    const normalView = { scaleX: 1, scaleY: 1 } as unknown as EditorView;
    expect(hasTransformScale(normalView)).toBe(false);

    const scaledViewX = { scaleX: 1.05, scaleY: 1 } as unknown as EditorView;
    expect(hasTransformScale(scaledViewX)).toBe(true);

    const scaledViewY = { scaleX: 1, scaleY: 0.95 } as unknown as EditorView;
    expect(hasTransformScale(scaledViewY)).toBe(true);

    // 2. DOM offset dimensions vs getBoundingClientRect:
    // A 12px scrollbar lane reduces clientWidth (500 - 12 = 488) while offsetWidth is 500.
    // Must NOT flag this as scale!
    const elWithScrollbar = {
      offsetWidth: 500,
      clientWidth: 488,
      offsetHeight: 300,
      clientHeight: 300,
    } as HTMLElement;
    expect(hasTransformScale(elWithScrollbar, { width: 500, height: 300 })).toBe(false);

    // True DOM scale (e.g. rect width 520 on offsetWidth 500 -> 1.04)
    expect(hasTransformScale(elWithScrollbar, { width: 520, height: 300 })).toBe(true);
  });

  it("evaluates scrollMargins on state facet, allowing horizontal gutters while falling back for vertical panels", () => {
    const emptyState = EditorState.create({ doc: "" });
    const view = { state: emptyState } as unknown as EditorView;
    expect(getScrollMargins(view)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(hasVerticalScrollMargins(view)).toBe(false);

    // Normal horizontal gutter margin (e.g. line numbers 45px) must NOT trigger vertical fallback
    const gutterState = EditorState.create({
      doc: "",
      extensions: [EditorView.scrollMargins.of(() => ({ left: 45 }))],
    });
    const gutterView = { state: gutterState } as unknown as EditorView;
    expect(getScrollMargins(gutterView)).toEqual({ left: 45, right: 0, top: 0, bottom: 0 });
    expect(hasVerticalScrollMargins(gutterView)).toBe(false);

    // Vertical panel margin (top: 40) MUST trigger fallback
    const verticalPanelState = EditorState.create({
      doc: "",
      extensions: [EditorView.scrollMargins.of(() => ({ top: 40 }))],
    });
    const verticalPanelView = { state: verticalPanelState } as unknown as EditorView;
    expect(hasVerticalScrollMargins(verticalPanelView)).toBe(true);
    expect(hasCustomScrollMargins).toBe(hasVerticalScrollMargins);
  });

  it("verifies real createEditorState with basicSetup does not trigger hasVerticalScrollMargins", () => {
    const realState = createEditorState("line 1\nline 2\nline 3");
    const realView = { state: realState } as unknown as EditorView;
    expect(hasVerticalScrollMargins(realView)).toBe(false);
  });
});

describe("getVisibleViewportBounds and isCoordsInVisibleViewport helpers", () => {
  it("computes visible bounds taking into account gutter margins and scrollbar lanes", () => {
    const gutterState = EditorState.create({
      doc: "line 1\nline 2",
      extensions: [EditorView.scrollMargins.of(() => ({ left: 45 }))],
    });
    const view = {
      state: gutterState,
      scrollDOM: {
        clientWidth: 588,
        clientHeight: 388,
        getBoundingClientRect: () => ({
          left: 10,
          right: 610,
          top: 20,
          bottom: 420,
          width: 600,
          height: 400,
        }),
      },
    } as unknown as EditorView;

    const bounds = getVisibleViewportBounds(view);
    expect(bounds).toEqual({
      left: 10 + 45, // 55
      right: 10 + 588, // 598 (excludes 12px vertical scrollbar)
      top: 20,
      bottom: 20 + 388, // 408 (excludes 12px horizontal scrollbar)
    });
  });

  it("checks whether coordinates are within visible viewport horizontally and vertically", () => {
    const bounds = { left: 55, right: 598, top: 20, bottom: 408 };

    // Fully inside
    expect(isCoordsInVisibleViewport({ left: 100, right: 110, top: 50, bottom: 70 }, bounds)).toBe(true);

    // Horizontally outside (under gutter)
    expect(isCoordsInVisibleViewport({ left: 40, right: 50, top: 50, bottom: 70 }, bounds)).toBe(false);

    // Horizontally outside (past right boundary on long line)
    expect(isCoordsInVisibleViewport({ left: 600, right: 610, top: 50, bottom: 70 }, bounds)).toBe(false);

    // Vertically outside (above top)
    expect(isCoordsInVisibleViewport({ left: 100, right: 110, top: 5, bottom: 15 }, bounds)).toBe(false);

    // Vertically outside (in horizontal scrollbar lane)
    expect(isCoordsInVisibleViewport({ left: 100, right: 110, top: 405, bottom: 415 }, bounds)).toBe(false);
  });
});

/**
 * Lightweight mock harness for EditorMotionPluginValue and handleScrollIntoView lifecycle testing.
 */
function createMockHarness(overrides?: Record<string, unknown>) {
  let isUpdating = false;
  const domListeners: Record<string, ((e: any) => void)[]> = {};
  const scrollerListeners: Record<string, ((e: any) => void)[]> = {};
  const contentListeners: Record<string, ((e: any) => void)[]> = {};
  const classListSet = new Set<string>();

  const dom = {
    addEventListener: (type: string, fn: any) => {
      (domListeners[type] = domListeners[type] || []).push(fn);
    },
    removeEventListener: (type: string, fn: any) => {
      if (domListeners[type]) {
        domListeners[type] = domListeners[type].filter((f) => f !== fn);
      }
    },
    classList: {
      add: (cls: string) => classListSet.add(cls),
      remove: (cls: string) => classListSet.delete(cls),
      contains: (cls: string) => classListSet.has(cls),
    },
  };

  const scrollDOM = {
    scrollTop: 100,
    scrollLeft: 0,
    scrollHeight: 1000,
    clientHeight: 400,
    clientWidth: 588,
    offsetWidth: 600,
    offsetHeight: 400,
    addEventListener: (type: string, fn: any) => {
      (scrollerListeners[type] = scrollerListeners[type] || []).push(fn);
    },
    removeEventListener: (type: string, fn: any) => {
      if (scrollerListeners[type]) {
        scrollerListeners[type] = scrollerListeners[type].filter((f) => f !== fn);
      }
    },
    getBoundingClientRect: () => ({
      left: 0,
      right: 600,
      top: 0,
      bottom: 400,
      width: 600,
      height: 400,
    }),
  };

  const contentNode = { isContent: true };
  const contentDOM = {
    contains: (node: any) => node === contentNode || (node && node.isContent !== false),
    addEventListener: (type: string, fn: any) => {
      (contentListeners[type] = contentListeners[type] || []).push(fn);
    },
    removeEventListener: (type: string, fn: any) => {
      if (contentListeners[type]) {
        contentListeners[type] = contentListeners[type].filter((f) => f !== fn);
      }
    },
  };

  const state = EditorState.create({
    doc: "line 1\nline 2\nline 3\nline 4\nline 5",
  });

  const rawCoordsAtPos =
    (overrides?.coordsAtPos as any) ??
    (() => ({ left: 20, right: 30, top: 200, bottom: 220 }));
  const rawPosAtCoords =
    (overrides?.posAtCoords as any) ?? (() => 15);

  const measureQueue: Array<{ key?: any; read: (v: any) => any; write?: (m: any, v: any) => void }> = [];
  let autoFlushMeasure = true;

  const view: any = {
    dom,
    scrollDOM,
    contentDOM,
    state,
    hasFocus: true,
    composing: false,
    scaleX: 1,
    scaleY: 1,
    textDirection: Direction.LTR,
    plugin: () => view._plugin,
    ...overrides,
  };

  const flushMeasureOnce = (beforeWrite?: () => void) => {
    if (measureQueue.length === 0) return;
    const measuring = measureQueue.splice(0, measureQueue.length);
    const measured: any[] = [];
    const prevUpdating = isUpdating;
    // Read phase: layout reading allowed
    isUpdating = false;
    for (const m of measuring) {
      // Fail the test on layout errors, rather than silently skipping its write.
      measured.push(m.read(view));
    }
    // Write phase: DOM writing allowed, layout reading throws
    isUpdating = true;
    try {
      // CM updates plugins/docView between request reads and writes.
      beforeWrite?.();
      for (let i = 0; i < measuring.length; i++) {
        const write = measuring[i].write;
        if (write) {
          write(measured[i], view);
        }
      }
    } finally {
      isUpdating = prevUpdating;
    }
  };

  const flushMeasure = (beforeWrite?: () => void) => {
    let cycles = 0;
    while (measureQueue.length > 0) {
      if (++cycles > 6) throw new Error("Measure loop failed to stabilize");
      flushMeasureOnce(beforeWrite);
    }
  };

  view.requestMeasure = (request?: any) => {
    if (!request) return;
    if (request.key != null) {
      for (let i = 0; i < measureQueue.length; i++) {
        if (measureQueue[i].key === request.key) {
          measureQueue[i] = request;
          if (autoFlushMeasure) {
            flushMeasure();
          }
          return;
        }
      }
    }
    measureQueue.push(request);
    if (autoFlushMeasure) {
      flushMeasure();
    }
  };

  view.coordsAtPos = (pos: number, side?: number) => {
    if (isUpdating) {
      throw new Error("Reading the editor layout isn't allowed during an update");
    }
    return rawCoordsAtPos(pos, side);
  };

  view.posAtCoords = (coords: { x: number; y: number }, precise?: boolean) => {
    if (isUpdating) {
      throw new Error("Reading the editor layout isn't allowed during an update");
    }
    return rawPosAtCoords(coords, precise);
  };

  const plugin = new EditorMotionPluginValue(view as EditorView);
  view._plugin = plugin;

  const originalUpdate = plugin.update.bind(plugin);
  plugin.update = (update: any) => {
    isUpdating = true;
    try {
      return originalUpdate(update);
    } finally {
      isUpdating = false;
    }
  };

  return {
    view: view as EditorView,
    plugin,
    dom,
    scrollDOM,
    contentNode,
    domListeners,
    scrollerListeners,
    contentListeners,
    measureQueue,
    flushMeasure,
    flushMeasureOnce,
    setAutoFlushMeasure: (val: boolean) => { autoFlushMeasure = val; },
    setIsUpdating: (val: boolean) => { isUpdating = val; },
  };
}

describe("shouldAnimatePointerClick helper", () => {
  const baseClickParams = {
    isMotionActive: true,
    isComposing: false,
    docChanged: false,
    hasClickCandidate: true,
    oldRanges: [EditorSelection.cursor(10)],
    newRanges: [EditorSelection.cursor(25)],
    charDist: 15,
    lineDist: 1,
    isOldVisible: true,
    isNewVisible: true,
  };

  it("returns true for eligible single left-click from single empty cursor to another", () => {
    expect(shouldAnimatePointerClick(baseClickParams)).toBe(true);
  });

  it("returns false when clicked at same position (charDist <= 0)", () => {
    expect(shouldAnimatePointerClick({ ...baseClickParams, charDist: 0 })).toBe(false);
  });

  it("returns false when distance exceeds char limit (> 500) or line limit (> 5)", () => {
    expect(shouldAnimatePointerClick({ ...baseClickParams, charDist: 501 })).toBe(false);
    expect(shouldAnimatePointerClick({ ...baseClickParams, lineDist: 6 })).toBe(false);
  });

  it("returns false when cursor positions are not visible in viewport", () => {
    expect(shouldAnimatePointerClick({ ...baseClickParams, isOldVisible: false })).toBe(false);
    expect(shouldAnimatePointerClick({ ...baseClickParams, isNewVisible: false })).toBe(false);
  });

  it("returns false when old selection was non-empty or had multiple cursors", () => {
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        oldRanges: [EditorSelection.range(0, 10)],
      }),
    ).toBe(false);
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        oldRanges: [EditorSelection.cursor(5), EditorSelection.cursor(10)],
      }),
    ).toBe(false);
  });

  it("returns false when new selection is non-empty (drag selection) or has multiple cursors", () => {
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        newRanges: [EditorSelection.range(10, 25)],
      }),
    ).toBe(false);
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        newRanges: [EditorSelection.cursor(10), EditorSelection.cursor(25)],
      }),
    ).toBe(false);
  });

  it("allows single non-empty range transitions when isShift is true", () => {
    // 1. Empty to non-empty (empty -> nonempty expansion)
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        isShift: true,
        oldRanges: [EditorSelection.cursor(10)],
        newRanges: [EditorSelection.range(10, 25)],
      }),
    ).toBe(true);

    // 2. Existing selection expansion
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        isShift: true,
        oldRanges: [EditorSelection.range(10, 25)],
        newRanges: [EditorSelection.range(10, 35)],
        charDist: 10,
        candidateOldHead: 25,
        candidateTargetPos: 35,
      }),
    ).toBe(true);

    // 3. Existing selection shortening
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        isShift: true,
        oldRanges: [EditorSelection.range(10, 35)],
        newRanges: [EditorSelection.range(10, 20)],
        charDist: 15,
        candidateOldHead: 35,
        candidateTargetPos: 20,
      }),
    ).toBe(true);

    // 4. Cross-anchor reversal (forward to backward)
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        isShift: true,
        oldRanges: [EditorSelection.range(10, 25)],
        newRanges: [EditorSelection.range(10, 5)],
        charDist: 20,
        candidateOldHead: 25,
        candidateTargetPos: 5,
      }),
    ).toBe(true);

    // 5. Cross-anchor reversal (backward to forward)
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        isShift: true,
        oldRanges: [EditorSelection.range(10, 5)],
        newRanges: [EditorSelection.range(10, 25)],
        charDist: 20,
        candidateOldHead: 5,
        candidateTargetPos: 25,
      }),
    ).toBe(true);

    // 6. Click exactly on anchor (collapses range to empty)
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        isShift: true,
        oldRanges: [EditorSelection.range(10, 25)],
        newRanges: [EditorSelection.cursor(10)],
        charDist: 15,
        candidateOldHead: 25,
        candidateTargetPos: 10,
      }),
    ).toBe(true);

    // 7. Still rejects multiple cursors/ranges
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        isShift: true,
        oldRanges: [EditorSelection.cursor(5), EditorSelection.cursor(10)],
        newRanges: [EditorSelection.range(10, 25)],
      }),
    ).toBe(false);
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        isShift: true,
        oldRanges: [EditorSelection.cursor(10)],
        newRanges: [EditorSelection.cursor(10), EditorSelection.cursor(25)],
      }),
    ).toBe(false);
  });

  it("returns false when hasClickCandidate is false (modifier keys, right click, etc.)", () => {
    expect(shouldAnimatePointerClick({ ...baseClickParams, hasClickCandidate: false })).toBe(false);
  });

  it("returns false when candidate oldHead or targetPos does not match actual transaction ranges", () => {
    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        candidateOldHead: 5,
      }),
    ).toBe(false);

    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        candidateTargetPos: 30,
      }),
    ).toBe(false);

    expect(
      shouldAnimatePointerClick({
        ...baseClickParams,
        candidateOldHead: 10,
        candidateTargetPos: 25,
      }),
    ).toBe(true);
  });

  it("returns false when docChanged, isComposing, or isMotionActive is false", () => {
    expect(shouldAnimatePointerClick({ ...baseClickParams, docChanged: true })).toBe(false);
    expect(shouldAnimatePointerClick({ ...baseClickParams, isComposing: true })).toBe(false);
    expect(shouldAnimatePointerClick({ ...baseClickParams, isMotionActive: false })).toBe(false);
  });
});

describe("shouldAnimatePointerDrag helper", () => {
  const baseDragParams = {
    isMotionActive: true,
    isComposing: false,
    docChanged: false,
    pointerDown: true,
    isDragging: true,
    isNonMousePointer: false,
    oldRangesCount: 1,
    newRangesCount: 1,
    charDist: 15,
    lineDist: 0,
  };

  it("returns true for eligible mouse drag within char and line limits", () => {
    expect(shouldAnimatePointerDrag(baseDragParams)).toBe(true);
  });

  it("returns true for multi-cursor drag when cursor count is stable and <= 10", () => {
    expect(
      shouldAnimatePointerDrag({
        ...baseDragParams,
        oldRangesCount: 3,
        newRangesCount: 3,
      }),
    ).toBe(true);
  });

  it("returns false when pointer is not down or user is not dragging", () => {
    expect(shouldAnimatePointerDrag({ ...baseDragParams, pointerDown: false })).toBe(false);
    expect(shouldAnimatePointerDrag({ ...baseDragParams, isDragging: false })).toBe(false);
  });

  it("returns false for non-mouse pointer (touch/pen)", () => {
    expect(shouldAnimatePointerDrag({ ...baseDragParams, isNonMousePointer: true })).toBe(false);
  });

  it("returns false when range count changes (adding/removing/merging ranges)", () => {
    expect(
      shouldAnimatePointerDrag({
        ...baseDragParams,
        oldRangesCount: 1,
        newRangesCount: 2,
      }),
    ).toBe(false);
    expect(
      shouldAnimatePointerDrag({
        ...baseDragParams,
        oldRangesCount: 2,
        newRangesCount: 1,
      }),
    ).toBe(false);
  });

  it("returns false when cursor count exceeds maxCursorCount (10)", () => {
    expect(
      shouldAnimatePointerDrag({
        ...baseDragParams,
        oldRangesCount: 11,
        newRangesCount: 11,
      }),
    ).toBe(false);
  });

  it("returns false when distance exceeds char or line thresholds", () => {
    expect(shouldAnimatePointerDrag({ ...baseDragParams, charDist: 0 })).toBe(false);
    expect(shouldAnimatePointerDrag({ ...baseDragParams, charDist: 501 })).toBe(false);
    expect(shouldAnimatePointerDrag({ ...baseDragParams, lineDist: 6 })).toBe(false);
  });

  it("returns false when motion is disabled, composing, or docChanged", () => {
    expect(shouldAnimatePointerDrag({ ...baseDragParams, isMotionActive: false })).toBe(false);
    expect(shouldAnimatePointerDrag({ ...baseDragParams, isComposing: true })).toBe(false);
    expect(shouldAnimatePointerDrag({ ...baseDragParams, docChanged: true })).toBe(false);
  });
});

describe("shouldAnimateSelectionExpandShrink helper", () => {
  const baseExpandParams = {
    isMotionActive: true,
    isComposing: false,
    docChanged: false,
    oldRangesCount: 1,
    newRangesCount: 1,
    charDist: 10,
    lineDist: 0,
  };

  it("returns true for valid expand/shrink within budget", () => {
    expect(shouldAnimateSelectionExpandShrink(baseExpandParams)).toBe(true);
  });

  it("returns true for multi-cursor expand/shrink with stable range count", () => {
    expect(
      shouldAnimateSelectionExpandShrink({
        ...baseExpandParams,
        oldRangesCount: 2,
        newRangesCount: 2,
      }),
    ).toBe(true);
  });

  it("returns false when range count changes (e.g. ranges merge)", () => {
    expect(
      shouldAnimateSelectionExpandShrink({
        ...baseExpandParams,
        oldRangesCount: 2,
        newRangesCount: 1,
      }),
    ).toBe(false);
  });

  it("returns false when distance exceeds thresholds", () => {
    expect(shouldAnimateSelectionExpandShrink({ ...baseExpandParams, charDist: 0 })).toBe(false);
    expect(shouldAnimateSelectionExpandShrink({ ...baseExpandParams, charDist: 501 })).toBe(false);
    expect(shouldAnimateSelectionExpandShrink({ ...baseExpandParams, lineDist: 6 })).toBe(false);
  });

  it("returns false when motion is disabled, composing, or docChanged", () => {
    expect(shouldAnimateSelectionExpandShrink({ ...baseExpandParams, isMotionActive: false })).toBe(false);
    expect(shouldAnimateSelectionExpandShrink({ ...baseExpandParams, isComposing: true })).toBe(false);
    expect(shouldAnimateSelectionExpandShrink({ ...baseExpandParams, docChanged: true })).toBe(false);
  });
});

describe("EditorMotionPluginValue and handleScrollIntoView lifecycle & coordination", () => {

  let savedRaf: any;
  let savedCancelRaf: any;
  const rafTimers = new Map<number, any>();
  let rafSeq = 1;

  beforeEach(() => {
    vi.useFakeTimers();
    savedRaf = (globalThis as any).requestAnimationFrame;
    savedCancelRaf = (globalThis as any).cancelAnimationFrame;

    (globalThis as any).requestAnimationFrame = (cb: (time: number) => void) => {
      const id = rafSeq++;
      const timer = setTimeout(() => {
        rafTimers.delete(id);
        cb(performance.now());
      }, 16);
      rafTimers.set(id, timer);
      return id;
    };

    (globalThis as any).cancelAnimationFrame = (id: number) => {
      const timer = rafTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        rafTimers.delete(id);
      }
    };

    setEditorMotionEnabled(true);
    setReducedMotionForTesting(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    (globalThis as any).requestAnimationFrame = savedRaf;
    (globalThis as any).cancelAnimationFrame = savedCancelRaf;
    setEditorMotionEnabled(true);
    setReducedMotionForTesting(false);
  });


  it("closes active caret transition when viewport scroll animation starts", () => {
    const { plugin, dom } = createMockHarness();

    // Give caret transition class
    dom.classList.add("cm-smooth-caret");
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Starting viewport scroll animation cancels caret CSS transition
    plugin.startScrollAnimation(100, 200);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("cancels running scroll animation on new navigation keydown so old RAF never pulls back", () => {
    const { plugin, scrollDOM } = createMockHarness();

    // Start a scroll animation toward 300
    plugin.startScrollAnimation(100, 300);

    // New navigation key arrives
    plugin.onKeyDown({ key: "ArrowDown" } as KeyboardEvent);

    // Advancing timers should not continue writing scrollTop to 300
    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(100);

    plugin.destroy();
  });

  it("cancels running scroll animation when handleScrollIntoView encounters moveY < 1 or native fallback", () => {
    const { view, plugin, scrollDOM } = createMockHarness();

    // 1. Start an animation toward 300
    plugin.startScrollAnimation(100, 300);
    plugin.setLastKeyNavTime(Date.now());

    // Target rect is at top: 100, bottom: 120 (already visible within viewport, moveY = 0)
    view.coordsAtPos = () => ({ left: 20, right: 30, top: 100, bottom: 120 });
    const handled = handleScrollIntoView(view, EditorSelection.cursor(0), { y: "nearest" });

    // Returns true (zero move)
    expect(handled).toBe(true);

    // Previous animation must have been cancelled immediately; advancing timers must not write 300
    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(100);

    // 2. Large jump fallback (> 2500px):
    plugin.startScrollAnimation(100, 300);
    plugin.setLastKeyNavTime(Date.now());
    view.coordsAtPos = () => ({ left: 20, right: 30, top: 4100, bottom: 4120 });

    const fallbackHandled = handleScrollIntoView(view, EditorSelection.cursor(0), { y: "nearest" });
    // Handled via requestMeasure: layout measured in read phase, instant jump in write phase without animation
    expect(fallbackHandled).toBe(true);
    expect(plugin.hasActiveScrollAnimation()).toBe(false);
    expect(scrollDOM.scrollTop).toBe(600);

    // Advancing timers does not write to 300
    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(600);

    plugin.destroy();
  });

  it("cancels running animation and falls back to native when horizontal scrolling is required", () => {
    const { view, plugin, scrollDOM } = createMockHarness();

    plugin.startScrollAnimation(100, 300);
    plugin.setLastKeyNavTime(Date.now());

    // Target is outside horizontally (left: -50)
    view.coordsAtPos = () => ({ left: -50, right: -20, top: 200, bottom: 220 });

    const handled = handleScrollIntoView(view, EditorSelection.cursor(0), { x: "nearest", y: "nearest" });
    // Handled via requestMeasure: horizontal adjustment applied instantly in write phase without animation
    expect(handled).toBe(true);
    expect(plugin.hasActiveScrollAnimation()).toBe(false);
    expect(scrollDOM.scrollLeft).toBe(-50);

    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(100);

    plugin.destroy();
  });

  it("cancels caret and scroll animations on compositionstart without needing docChanged", () => {
    const { plugin, dom } = createMockHarness();

    dom.classList.add("cm-smooth-caret");
    plugin.startScrollAnimation(100, 250);
    plugin.setLastKeyNavTime(Date.now());

    // compositionstart fires
    plugin.onCompositionStart();

    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    expect(plugin.isRecentKeyNav()).toBe(false);

    plugin.destroy();
  });

  it("does not qualify IME navigation keys as keyboard navigation", () => {
    const { plugin } = createMockHarness();

    // IME arrow key (e.isComposing = true or keyCode = 229)
    plugin.onKeyDown({ key: "ArrowDown", isComposing: true, keyCode: 229 } as KeyboardEvent);
    expect(plugin.isRecentKeyNav()).toBe(false);

    plugin.destroy();
  });

  it("cancels animations and clears qualification on beforeinput, cut, and paste", () => {
    const { plugin, dom } = createMockHarness();

    dom.classList.add("cm-smooth-caret");
    plugin.setLastKeyNavTime(Date.now());

    plugin.onEditIntent();

    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    expect(plugin.isRecentKeyNav()).toBe(false);

    plugin.destroy();
  });

  it("cancels all animations and clears qualification on blur", () => {
    const { plugin, dom } = createMockHarness();

    dom.classList.add("cm-smooth-caret");
    plugin.setLastKeyNavTime(Date.now());

    plugin.onBlur();

    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    expect(plugin.isRecentKeyNav()).toBe(false);

    plugin.destroy();
  });

  it("cancels both caret and scroll animations on geometryChanged in update", () => {
    const { view, plugin, dom, scrollDOM } = createMockHarness();

    dom.classList.add("cm-smooth-caret");
    plugin.startScrollAnimation(100, 250);
    plugin.setLastKeyNavTime(Date.now());

    plugin.update({
      docChanged: false,
      geometryChanged: true,
      selectionSet: false,
      transactions: [],
      startState: view.state,
      state: view.state,
      view,
    } as any);

    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    expect(plugin.isRecentKeyNav()).toBe(false);

    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(100);

    plugin.destroy();
  });

  it("cancels all animations and clears qualification when transaction has non-keyboard userEvent", () => {
    const { view, plugin, dom } = createMockHarness();

    dom.classList.add("cm-smooth-caret");
    plugin.setLastKeyNavTime(Date.now());

    const mockTr = {
      isUserEvent: (ev: string) => ev === "select.search",
    };

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [mockTr],
      startState: view.state,
      state: view.state,
      view,
    } as any);

    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    expect(plugin.isRecentKeyNav()).toBe(false);

    plugin.destroy();
  });

  it("refuses scroll animation when editor has no focus or pointer is down", () => {
    const { view, plugin } = createMockHarness();
    plugin.setLastKeyNavTime(Date.now());

    (view as any).hasFocus = false;
    expect(handleScrollIntoView(view, EditorSelection.cursor(0), {})).toBe(false);

    (view as any).hasFocus = true;
    plugin.onPointerDown();
    expect(handleScrollIntoView(view, EditorSelection.cursor(0), {})).toBe(false);

    plugin.destroy();
  });

  it("symmetrically unregisters activeCleanups and event listeners on destroy", () => {
    const { plugin, domListeners, scrollerListeners } = createMockHarness();

    expect(domListeners["keydown"]?.length).toBe(1);
    expect(scrollerListeners["wheel"]?.length).toBe(1);

    plugin.destroy();

    expect(domListeners["keydown"]?.length).toBe(0);
    expect(scrollerListeners["wheel"]?.length).toBe(0);
    plugin.destroy();
  });

  it("animates viewport scroll to target destination when gutter margin and scrollbar lane are present", () => {
    // State with simulated 45px line-number gutter
    const stateWithGutter = EditorState.create({
      doc: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10",
      extensions: [EditorView.scrollMargins.of(() => ({ left: 45 }))],
    });

    const { view, plugin, scrollDOM } = createMockHarness({
      state: stateWithGutter,
      // Target rect is at left: 80 (clear of 45px gutter), top: 550, bottom: 570 (below viewport)
      coordsAtPos: () => ({ left: 80, right: 90, top: 550, bottom: 570 }),
    });

    plugin.setLastKeyNavTime(Date.now());

    // Call handleScrollIntoView
    const handled = handleScrollIntoView(view, EditorSelection.cursor(0), { y: "nearest" });
    expect(handled).toBe(true);

    // Halfway through animation (90ms), scrollTop has smoothly moved towards 270 (100 + (570 - 400))
    vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs / 2);
    expect(scrollDOM.scrollTop).toBeGreaterThan(100);
    expect(scrollDOM.scrollTop).toBeLessThan(270);

    // At completion (> 180ms), scrollTop reaches exact target 270
    vi.advanceTimersByTime(150);
    expect(scrollDOM.scrollTop).toBe(270);

    plugin.destroy();
  });

  it("falls back to native CM scroll when transform scale, vertical margins, or gutter occlusion are present", () => {
    // 1. Scale fallback
    const { view: scaleView, plugin: scalePlugin } = createMockHarness({
      scaleX: 1.05,
      coordsAtPos: () => ({ left: 80, right: 90, top: 550, bottom: 570 }),
    });
    scalePlugin.setLastKeyNavTime(Date.now());
    expect(handleScrollIntoView(scaleView, EditorSelection.cursor(0), { y: "nearest" })).toBe(false);
    scalePlugin.destroy();

    // 2. Vertical panel margin fallback
    const panelState = EditorState.create({
      doc: "line 1\nline 2\nline 3",
      extensions: [EditorView.scrollMargins.of(() => ({ top: 35 }))],
    });
    const { view: panelView, plugin: panelPlugin } = createMockHarness({
      state: panelState,
      coordsAtPos: () => ({ left: 80, right: 90, top: 550, bottom: 570 }),
    });
    panelPlugin.setLastKeyNavTime(Date.now());
    expect(handleScrollIntoView(panelView, EditorSelection.cursor(0), { y: "nearest" })).toBe(false);
    panelPlugin.destroy();

    // 3. Horizontal gutter occlusion fallback (cursor behind 45px gutter: left: 20 < 45)
    const gutterState = EditorState.create({
      doc: "line 1\nline 2\nline 3",
      extensions: [EditorView.scrollMargins.of(() => ({ left: 45 }))],
    });
    const { view: gutterView, plugin: gutterPlugin, scrollDOM: gutterScrollDOM } = createMockHarness({
      state: gutterState,
      coordsAtPos: () => ({ left: 20, right: 25, top: 550, bottom: 570 }),
    });
    gutterPlugin.setLastKeyNavTime(Date.now());
    expect(handleScrollIntoView(gutterView, EditorSelection.cursor(0), { y: "nearest" })).toBe(true);
    expect(gutterPlugin.hasActiveScrollAnimation()).toBe(false);
    expect(gutterScrollDOM.scrollTop).toBe(270);
    gutterPlugin.destroy();
  });

  it("cancels running scroll animation on programmatic selectionSet without userEvent", () => {
    const { view, plugin, scrollDOM } = createMockHarness();

    plugin.startScrollAnimation(100, 300);

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [],
      startState: view.state,
      state: view.state,
      view,
    } as any);

    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(100);

    plugin.destroy();
  });

  it("enables caret transition on single left-click pointer selection without animating viewport scroll", () => {
    const { view, plugin, dom, contentNode } = createMockHarness();

    // Initial cursor at pos 0
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);

    // CodeMirror dispatches select.pointer transaction moving cursor to pos 15 (line 1)
    const newState = view.state.update({
      selection: EditorSelection.cursor(15),
    });

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: newState.state,
      view,
    } as any);

    // Caret CSS transition class is added
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Mouse click does NOT qualify as recent key nav; viewport scroll handler returns false (native scroll)
    expect(handleScrollIntoView(view, EditorSelection.cursor(15), {})).toBe(false);

    // After caretTimeoutMs, class is removed
    vi.advanceTimersByTime(MOTION_CONFIG.caretTimeoutMs);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("falls back to instant placement when old cursor is horizontally outside visible viewport on long line", () => {
    const { view, plugin, dom, contentNode } = createMockHarness({
      // Old cursor at pos 0 is horizontally scrolled out of view to the right (left: 800)
      // while visible viewport right is 588
      coordsAtPos: (pos: number) => {
        if (pos === 0) {
          return { left: 800, right: 810, top: 200, bottom: 220 };
        }
        return { left: 100, right: 110, top: 200, bottom: 220 };
      },
      posAtCoords: () => 15,
    });

    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      clientX: 100,
      clientY: 200,
      target: contentNode,
    } as any);

    const newState = view.state.update({
      selection: EditorSelection.cursor(15),
    });

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: newState.state,
      view,
    } as any);

    // Because old cursor was horizontally offscreen, candidate was rejected and no transition applied
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("falls back to instant placement when target position is horizontally outside visible viewport", () => {
    const { view, plugin, dom, contentNode } = createMockHarness({
      coordsAtPos: (pos: number) => {
        if (pos === 15) {
          // Target position 15 is horizontally scrolled out to the right (left: 800)
          return { left: 800, right: 810, top: 200, bottom: 220 };
        }
        return { left: 100, right: 110, top: 200, bottom: 220 };
      },
      posAtCoords: () => 15,
    });

    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      clientX: 100,
      clientY: 200,
      target: contentNode,
    } as any);

    const newState = view.state.update({
      selection: EditorSelection.cursor(15),
    });

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: newState.state,
      view,
    } as any);

    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("animates mouse drag while rejecting double click, modifiers, multi-cursor clicks, and gutter clicks", () => {
    const { view, plugin, dom, contentNode } = createMockHarness();

    // 1. Mouse drag (move > 4px) animates active endpoint
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);
    plugin.onPointerMove({ clientX: 110, clientY: 100 } as any);

    const dragRangeState = view.state.update({
      selection: EditorSelection.single(0, 15),
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: dragRangeState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 2. Double-click (detail: 2)
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 2,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: dragRangeState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // 3. Ctrl-click (ctrlKey: true)
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      ctrlKey: true,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: dragRangeState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // 4. Alt+Shift-click (altKey + shiftKey)
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      altKey: true,
      shiftKey: true,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: dragRangeState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // Pure Shift-click (shiftKey: true, no other modifiers) animates active endpoint
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      shiftKey: true,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: dragRangeState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 5. Gutter click (target outside contentDOM)
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      clientX: 10,
      clientY: 100,
      target: { isContent: false },
    } as any);
    const gutterNewState = view.state.update({
      selection: EditorSelection.cursor(10),
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: gutterNewState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // 6. Clicking when editor already has 3 cursors (collapse to 1)
    const multiCursorState = EditorState.create({
      doc: "line 1\nline 2\nline 3",
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(7),
        EditorSelection.cursor(14),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: multiCursorState,
      state: EditorState.create({ doc: "line 1\nline 2\nline 3", selection: EditorSelection.cursor(5) }),
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // 7. Clicking during IME composing
    (view as any).composing = true;
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: gutterNewState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("cleans up mousedown and pointermove listeners on destroy symmetrically", () => {
    const { plugin, domListeners } = createMockHarness();

    expect(domListeners["mousedown"]?.length).toBe(1);
    expect(domListeners["pointermove"]?.length).toBe(1);

    plugin.destroy();

    expect(domListeners["mousedown"]?.length).toBe(0);
    expect(domListeners["pointermove"]?.length).toBe(0);
  });

  it("animates smart selection expand and shrink transactions and cleans up via timeout", () => {
    const { view, plugin, dom } = createMockHarness();

    // select.expand arms transition
    const expandState = view.state.update({
      selection: EditorSelection.single(0, 10),
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.expand" }],
      startState: view.state,
      state: expandState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    expect(dom.classList.contains("cm-smooth-edit")).toBe(false);

    // Timeout after 190ms clears transition class
    vi.advanceTimersByTime(190);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // select.shrink arms transition
    const shrinkState = expandState.state.update({
      selection: EditorSelection.single(0, 5),
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.shrink" }],
      startState: expandState.state,
      state: shrinkState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    plugin.destroy();
  });

  it("animates mouse drag selection with continuous retargeting and rejects oversized drag", () => {
    const { view, plugin, dom, contentNode } = createMockHarness();

    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);
    plugin.onPointerMove({ clientX: 110, clientY: 100 } as any);

    // Step 1: initial drag to pos 10
    const drag1 = view.state.update({ selection: EditorSelection.single(0, 10) });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: drag1.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Step 2: continue dragging to pos 20 (continuous retargeting without snapping)
    plugin.onPointerMove({ clientX: 120, clientY: 100 } as any);
    const drag2 = view.state.update({ selection: EditorSelection.single(0, 20) });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: drag1.state,
      state: drag2.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Step 3: oversized drag jump (> 5 lines) snaps instantly
    const bigDocState = EditorState.create({
      doc: "0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20",
      selection: EditorSelection.single(0, 0),
    });
    const jumpState = bigDocState.update({
      selection: EditorSelection.single(0, 40),
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: bigDocState,
      state: jumpState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.onPointerUp();
    plugin.destroy();
  });

  it("animates multi-cursor drag when range count is stable, but snaps on range count changes", () => {
    const multiStartState = EditorState.create({
      doc: "line 1\nline 2\nline 3\nline 4\nline 5",
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(7, 10),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    const multiMovedState = EditorState.create({
      doc: "line 1\nline 2\nline 3\nline 4\nline 5",
      selection: EditorSelection.create([
        EditorSelection.range(0, 4),
        EditorSelection.range(7, 11),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const { view, plugin, dom, contentNode } = createMockHarness();
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      altKey: true,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);
    plugin.onPointerMove({ clientX: 110, clientY: 100 } as any);

    // Stable 2 ranges -> animates
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: multiStartState,
      state: multiMovedState,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Adding a 3rd range (2 -> 3) -> snaps instantly
    const multiAddedState = EditorState.create({
      doc: "line 1\nline 2\nline 3\nline 4\nline 5",
      selection: EditorSelection.create([
        EditorSelection.range(0, 4),
        EditorSelection.range(7, 11),
        EditorSelection.range(14, 18),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: multiMovedState,
      state: multiAddedState,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("animates keyboard movement when selection already exists and with Shift+Arrow", () => {
    const { view, plugin, dom } = createMockHarness();
    const selState = EditorState.create({
      doc: "line 1\nline 2\nline 3",
      selection: EditorSelection.range(5, 0),
    });
    const collapsedState = EditorState.create({
      doc: "line 1\nline 2\nline 3",
      selection: EditorSelection.cursor(5),
    });

    // Keyboard ArrowRight collapsing an existing selection
    plugin.onKeyDown({ key: "ArrowRight" } as any);
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: () => false }],
      startState: selState,
      state: collapsedState,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Shift+Arrow extending selection
    const extendedState = EditorState.create({
      doc: "line 1\nline 2\nline 3",
      selection: EditorSelection.range(5, 6),
    });
    plugin.onKeyDown({ key: "ArrowRight", shiftKey: true } as any);
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: () => false }],
      startState: collapsedState,
      state: extendedState,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    plugin.destroy();
  });

  it("rejects selection animation on programmatic repositioning, disabled motion, and IME composing", () => {
    const { view, plugin, dom, contentNode } = createMockHarness();
    const targetState = view.state.update({
      selection: EditorSelection.cursor(5),
    });

    // 1. Programmatic repositioning without keynav or userEvent -> rejected
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: () => false }],
      startState: view.state,
      state: targetState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // 2. Disabled motion -> rejected
    setEditorMotionEnabled(false);
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);
    plugin.onPointerMove({ clientX: 110, clientY: 100 } as any);
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: targetState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    setEditorMotionEnabled(true);

    // 3. Composing -> rejected
    (view as any).composing = true;
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.expand" }],
      startState: view.state,
      state: targetState.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });
});

describe("isNormalTypingInputType helper", () => {
  it("returns true for legitimate typing insertion inputTypes", () => {
    expect(isNormalTypingInputType("insertText")).toBe(true);
    expect(isNormalTypingInputType("insertLineBreak")).toBe(true);
    expect(isNormalTypingInputType("insertParagraph")).toBe(true);
    expect(isNormalTypingInputType("insertReplacementText")).toBe(true);
    expect(isNormalTypingInputType("insertCompositionText")).toBe(true);
  });

  it("returns false for non-typing or deletion inputTypes", () => {
    expect(isNormalTypingInputType("deleteContentBackward")).toBe(false);
    expect(isNormalTypingInputType("deleteContentForward")).toBe(false);
    expect(isNormalTypingInputType("insertFromPaste")).toBe(false);
    expect(isNormalTypingInputType("insertFromDrop")).toBe(false);
    expect(isNormalTypingInputType("historyUndo")).toBe(false);
    expect(isNormalTypingInputType("historyRedo")).toBe(false);
    expect(isNormalTypingInputType(undefined)).toBe(false);
    expect(isNormalTypingInputType("")).toBe(false);
  });
});

describe("shouldAnimateTyping pure eligibility logic", () => {
  const baseTypingParams = {
    isMotionActive: true,
    isComposing: false,
    pointerDown: false,
    oldRanges: [EditorSelection.cursor(10)],
    newRanges: [EditorSelection.cursor(11)],
    charDist: 1,
    lineDist: 0,
    isConfirmedImeCommit: false,
    hasExcludedUserEvent: false,
    hasAllowedUserEvent: true,
  };

  it("returns true for normal typing with single cursor", () => {
    expect(shouldAnimateTyping(baseTypingParams)).toBe(true);
  });

  it("returns true for selection replacement typing", () => {
    expect(
      shouldAnimateTyping({
        ...baseTypingParams,
        oldRanges: [EditorSelection.range(5, 15)],
        newRanges: [EditorSelection.cursor(6)],
        charDist: 4,
        lineDist: 0,
      }),
    ).toBe(true);
  });

  it("returns true for Enter newline insertion with lineDist <= 5", () => {
    expect(
      shouldAnimateTyping({
        ...baseTypingParams,
        oldRanges: [EditorSelection.cursor(10)],
        newRanges: [EditorSelection.cursor(11)],
        charDist: 1,
        lineDist: 1,
      }),
    ).toBe(true);
  });

  it("returns true for multi-cursor typing with equal cursor count (<= 10)", () => {
    expect(
      shouldAnimateTyping({
        ...baseTypingParams,
        oldRanges: [EditorSelection.cursor(5), EditorSelection.cursor(20)],
        newRanges: [EditorSelection.cursor(6), EditorSelection.cursor(22)],
        charDist: 1,
        lineDist: 0,
      }),
    ).toBe(true);
  });

  it("returns true for confirmed Chinese IME commit", () => {
    expect(
      shouldAnimateTyping({
        ...baseTypingParams,
        isConfirmedImeCommit: true,
        charDist: 2,
      }),
    ).toBe(true);
  });

  it("returns false when motion is inactive or reduced motion is active", () => {
    expect(shouldAnimateTyping({ ...baseTypingParams, isMotionActive: false })).toBe(false);
  });

  it("returns true during active IME composition pre-edit with positive displacement", () => {
    expect(shouldAnimateTyping({ ...baseTypingParams, isComposing: true, charDist: 1 })).toBe(true);
  });

  it("allows equal document offsets because replacement glyph widths can move the visual caret", () => {
    expect(shouldAnimateTyping({ ...baseTypingParams, oldRanges: [EditorSelection.cursor(10)], newRanges: [EditorSelection.cursor(10)], charDist: 0 })).toBe(true);
  });

  it("returns false when pointer is active", () => {
    expect(shouldAnimateTyping({ ...baseTypingParams, pointerDown: true })).toBe(false);
  });

  it("returns false on excluded user events (cut, drop, undo, search)", () => {
    expect(shouldAnimateTyping({ ...baseTypingParams, hasExcludedUserEvent: true })).toBe(false);
  });

  it("returns false when hasAllowedUserEvent is false", () => {
    expect(shouldAnimateTyping({ ...baseTypingParams, hasAllowedUserEvent: false })).toBe(false);
  });

  it("allows motion up to the document hard caps and disables it beyond either cap", () => {
    expect(isDocumentMotionAllowed({ lines: 100001, length: 100000 })).toBe(true);
    expect(isDocumentMotionAllowed({ lines: MOTION_CONFIG.maxMotionDocLines, length: MOTION_CONFIG.maxMotionDocLength })).toBe(true);
    expect(isDocumentMotionAllowed({ lines: MOTION_CONFIG.maxMotionDocLines + 1, length: 200000 })).toBe(false);
    expect(isDocumentMotionAllowed({ lines: 1, length: MOTION_CONFIG.maxMotionDocLength + 1 })).toBe(false);
  });

  it("returns false when cursor count changes (e.g. adding or merging cursors)", () => {
    expect(
      shouldAnimateTyping({
        ...baseTypingParams,
        oldRanges: [EditorSelection.cursor(5), EditorSelection.cursor(10)],
        newRanges: [EditorSelection.cursor(6)],
      }),
    ).toBe(false);
  });

  it("returns false when cursor count exceeds maxCursorCount threshold (> 10)", () => {
    const elevenCursorsOld = Array.from({ length: 11 }, (_, i) => EditorSelection.cursor(i * 10));
    const elevenCursorsNew = Array.from({ length: 11 }, (_, i) => EditorSelection.cursor(i * 10 + 1));
    expect(
      shouldAnimateTyping({
        ...baseTypingParams,
        oldRanges: elevenCursorsOld,
        newRanges: elevenCursorsNew,
      }),
    ).toBe(false);
  });

  it("returns false when new selection has non-empty range", () => {
    expect(
      shouldAnimateTyping({
        ...baseTypingParams,
        newRanges: [EditorSelection.range(5, 10)],
      }),
    ).toBe(false);
  });

  it("returns false on large character jump (> 500 chars) or large line jump (> 5 lines)", () => {
    expect(shouldAnimateTyping({ ...baseTypingParams, charDist: 501 })).toBe(false);
    expect(shouldAnimateTyping({ ...baseTypingParams, lineDist: 6 })).toBe(false);
  });
});

describe("EditorMotionPluginValue typing and Chinese IME caret motion", () => {
  beforeEach(() => {
    setEditorMotionEnabled(true);
    setReducedMotionForTesting(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    setEditorMotionEnabled(true);
    setReducedMotionForTesting(false);
  });

  it("animates short typing, delete and paste edits in a 100,000-line document", () => {
    const { view, plugin, dom } = createMockHarness();
    (view as any).state = EditorState.create({ doc: "abcdef" + "\n".repeat(100000), selection: EditorSelection.cursor(3) });
    for (const spec of [
      { changes: { from: 3, insert: "x" }, selection: EditorSelection.cursor(4), userEvent: "input.type" },
      { changes: { from: 3, to: 4 }, selection: EditorSelection.cursor(3), userEvent: "delete.backward" },
      { changes: { from: 3, insert: "xy" }, selection: EditorSelection.cursor(5), userEvent: "input.paste" },
    ]) {
      const startState = view.state;
      const tr = startState.update(spec);
      (view as any).state = tr.state;
      plugin.update({ docChanged: true, geometryChanged: true, selectionSet: true, transactions: [tr], changes: tr.changes, startState, state: tr.state, view } as any);
      expect(dom.classList.contains("cm-smooth-caret"), spec.userEvent).toBe(true);
      expect(tr.state.doc.lines).toBe(100001);
    }
    expect(view.state.doc.sliceString(0, 8)).toBe("abcxydef");
    plugin.destroy();
  });

  it("snaps large replacements even when the caret offset is unchanged, and compositionend cannot re-arm them", () => {
    const { view, plugin, dom } = createMockHarness();
    const startState = EditorState.create({ doc: "x".repeat(600), selection: EditorSelection.cursor(1) });
    const tr = startState.update({ changes: { from: 0, to: 600, insert: "y".repeat(600) }, selection: EditorSelection.cursor(1), userEvent: "input.paste" });
    (view as any).state = tr.state;
    plugin.armCaretTransition();
    plugin.update({ docChanged: true, geometryChanged: true, selectionSet: true, transactions: [tr], changes: tr.changes, startState, state: tr.state, view } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    plugin.onCompositionEnd({ data: "y" } as CompositionEvent);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    plugin.destroy();
  });

  it("disables caret and viewport motion above the hard document cap before measuring layout", () => {
    const { view, plugin, dom } = createMockHarness();
    const startState = EditorState.create({ doc: "\n".repeat(MOTION_CONFIG.maxMotionDocLines), selection: EditorSelection.cursor(1) });
    const tr = startState.update({ selection: EditorSelection.cursor(2), userEvent: "select" });
    (view as any).state = tr.state;
    plugin.armCaretTransition();
    plugin.setLastKeyNavTime(Date.now());
    plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true, transactions: [tr], startState, state: tr.state, view } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    const measure = vi.fn(() => { throw new Error("must not measure oversized document"); });
    view.coordsAtPos = measure;
    plugin.setLastKeyNavTime(Date.now());
    expect(handleScrollIntoView(view, view.state.selection.main, {})).toBe(false);
    expect(measure).not.toHaveBeenCalled();
    plugin.destroy();
  });

  it("uses the shorter edit transition and restores navigation timing without leaving stale classes", () => {
    const { plugin, dom } = createMockHarness();
    plugin.armCaretTransition("edit");
    expect(dom.classList.contains("cm-smooth-edit")).toBe(true);
    vi.advanceTimersByTime(MOTION_CONFIG.editCaretTimeoutMs - 1);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    expect(dom.classList.contains("cm-smooth-edit")).toBe(false);

    plugin.armCaretTransition("edit");
    plugin.armCaretTransition();
    expect(dom.classList.contains("cm-smooth-edit")).toBe(false);
    vi.advanceTimersByTime(MOTION_CONFIG.editCaretTimeoutMs);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    plugin.cancelCaretAnimation();
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    plugin.destroy();
  });

  it("preserves transition class for typing, deletion and paste intents, but clears unknown intents", () => {
    const { plugin, dom } = createMockHarness();

    // 1. Activate transition class
    dom.classList.add("cm-smooth-caret");

    // 2. Normal typing beforeinput (insertText): does NOT cancel caret animation!
    plugin.onEditIntent({ inputType: "insertText" } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Enter newline beforeinput (insertParagraph): does NOT cancel caret animation!
    plugin.onEditIntent({ inputType: "insertParagraph" } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 3. Deletion also preserves the current visual position.
    plugin.onEditIntent({ inputType: "deleteContentBackward" } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 4. Paste preserves it until the actual transaction can be checked.
    dom.classList.add("cm-smooth-caret");
    plugin.onEditIntent({ inputType: "insertFromPaste" } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    plugin.onPasteOrCut({ type: "paste" } as Event);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 5. Activate again, unknown/empty beforeinput: conservative cancel
    dom.classList.add("cm-smooth-caret");
    plugin.onEditIntent({} as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("maintains transition class continuously across multiple characters without snapping in beforeinput", () => {
    const { view, plugin, dom } = createMockHarness();

    // Char 1: beforeinput -> update
    plugin.onEditIntent({ inputType: "insertText" } as any);
    const startState1 = view.state;
    const tr1 = startState1.update({
      changes: { from: 0, insert: "a" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type",
    });
    (view as any).state = tr1.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [tr1],
      startState: startState1,
      state: tr1.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Step 50ms into transition (animation running)
    vi.advanceTimersByTime(50);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Char 2 beforeinput fires while Char 1 is animating: MUST NOT remove class!
    plugin.onEditIntent({ inputType: "insertText" } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Char 2 update updates selection and keeps class alive
    const tr2 = view.state.update({
      changes: { from: 1, insert: "b" },
      selection: EditorSelection.cursor(2),
      userEvent: "input.type",
    });
    (view as any).state = tr2.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [tr2],
      startState: tr1.state,
      state: tr2.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Timeout after Char 2 cleans up class
    vi.advanceTimersByTime(MOTION_CONFIG.caretTimeoutMs);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("reliably cancels transition class in update if typed intent is followed by invalid transaction", () => {
    const { view, plugin, dom } = createMockHarness();

    // Active transition class
    dom.classList.add("cm-smooth-caret");

    // beforeinput claims insertText
    plugin.onEditIntent({ inputType: "insertText" } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // But the actual transaction is history replay, which must align immediately.
    const badTr = view.state.update({
      changes: { from: 0, insert: "x" },
      selection: EditorSelection.cursor(1),
      userEvent: "undo", // excluded event
    });
    (view as any).state = badTr.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [badTr],
      startState: view.state,
      state: badTr.state,
      view,
    } as any);

    // Reliably cancelled in update phase, does NOT remain stuck
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("animates single typing insertion without reading layout in update and leaves selection/history clean", () => {
    const { view, plugin, dom } = createMockHarness();

    // Initial state: cursor at 5 ("line 1\n...")
    const startState = view.state;
    // User types '!' at pos 5
    const tr = startState.update({
      changes: { from: 5, insert: "!" },
      selection: EditorSelection.cursor(6),
      userEvent: "input.type",
    });
    (view as any).state = tr.state;

    plugin.update({
      docChanged: true,
      geometryChanged: true, // CM viewUpdate sets geometryChanged when docChanged is true
      selectionSet: true,
      transactions: [tr],
      startState,
      state: tr.state,
      view,
    } as any);

    // .cm-smooth-caret added without layout read error
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    // Real document text is updated immediately
    expect(tr.state.doc.sliceString(0, 7)).toBe("line !1");
    // Real selection is at pos 6 immediately
    expect(tr.state.selection.main.head).toBe(6);

    // Timeout clears visual class
    vi.advanceTimersByTime(MOTION_CONFIG.caretTimeoutMs);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("refreshes caretTimeout on continuous typing without visual class flickering", () => {
    const { view, plugin, dom } = createMockHarness();

    let curState = view.state;
    // Keystroke 1: 'a'
    const tr1 = curState.update({
      changes: { from: 0, insert: "a" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type",
    });
    (view as any).state = tr1.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [tr1],
      startState: curState,
      state: tr1.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 50ms later: Keystroke 2: 'b'
    vi.advanceTimersByTime(50);
    curState = tr1.state;
    const tr2 = curState.update({
      changes: { from: 1, insert: "b" },
      selection: EditorSelection.cursor(2),
      userEvent: "input.type",
    });
    (view as any).state = tr2.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [tr2],
      startState: curState,
      state: tr2.state,
      view,
    } as any);

    // Class is still active (not toggled off)
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Advance 150ms (total 200ms since key 1, but only 150ms since key 2): still active
    vi.advanceTimersByTime(150);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // The refreshed timeout is relative to the latest key, not the first one.
    vi.advanceTimersByTime(MOTION_CONFIG.caretTimeoutMs - 150 + 1);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("animates typing when replacing selected text and on Enter newline insertion", () => {
    const { view, plugin, dom } = createMockHarness();

    // 1. Selection replacement
    const stateWithSelection = view.state.update({
      selection: EditorSelection.single(0, 4),
    }).state;
    const replaceTr = stateWithSelection.update({
      changes: { from: 0, to: 4, insert: "W" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type",
    });
    (view as any).state = replaceTr.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [replaceTr],
      startState: stateWithSelection,
      state: replaceTr.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 2. Enter newline insertion (userEvent: "input")
    const preEnterState = replaceTr.state;
    const enterTr = preEnterState.update({
      changes: { from: 1, insert: "\n" },
      selection: EditorSelection.cursor(2),
      userEvent: "input",
    });
    (view as any).state = enterTr.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [enterTr],
      startState: preEnterState,
      state: enterTr.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    plugin.destroy();
  });

  it("animates multi-cursor typing with small cursor count but snaps instantly on cursor merge", () => {
    const { view, plugin, dom } = createMockHarness();

    const multiState = EditorState.create({
      doc: "aaa\nbbb\nccc",
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(4),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    // 1. Both cursors insert 'x'
    const insertTr = multiState.update({
      changes: [
        { from: 0, insert: "x" },
        { from: 4, insert: "x" },
      ],
      selection: EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.cursor(6),
      ]),
      userEvent: "input.type",
    });
    (view as any).state = insertTr.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [insertTr],
      startState: multiState,
      state: insertTr.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 2. Cursors merge from 2 to 1
    const mergeTr = insertTr.state.update({
      changes: { from: 1, to: 6, insert: "" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type",
    });
    (view as any).state = mergeTr.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [mergeTr],
      startState: insertTr.state,
      state: mergeTr.state,
      view,
    } as any);
    // Cursor count change (2 -> 1) rejects animation and snaps instantly
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("allows delete/paste transactions while excluding cut and history replay", () => {
    const { view, plugin, dom } = createMockHarness();

    dom.classList.add("cm-smooth-caret");

    // 1. Delete backward is eligible; CSS only moves if screen coordinates change.
    const delTr = {
      isUserEvent: (ev: string) => ev === "delete" || ev === "delete.backward",
      annotation: () => "delete.backward",
    };
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [delTr],
      startState: view.state,
      state: view.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 2. Paste
    dom.classList.add("cm-smooth-caret");
    const pasteTr = {
      isUserEvent: (ev: string) => ev === "input.paste",
      annotation: () => "input.paste",
    };
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [pasteTr],
      startState: view.state,
      state: view.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 3. Cut
    dom.classList.add("cm-smooth-caret");
    const cutTr = {
      isUserEvent: (ev: string) => ev === "delete.cut",
      annotation: () => "delete.cut",
    };
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [cutTr],
      startState: view.state,
      state: view.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // 4. Undo
    dom.classList.add("cm-smooth-caret");
    const undoTr = {
      isUserEvent: (ev: string) => ev === "undo",
      annotation: () => "undo",
    };
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [undoTr],
      startState: view.state,
      state: view.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("handles Chinese IME lifecycle: animates pre-edit, short deletion and commit, snaps on cancel", () => {
    const { view, plugin, dom } = createMockHarness();

    // 1. compositionstart fires -> resets scroll/search without unconditionally stripping caret class
    dom.classList.add("cm-smooth-caret");
    plugin.onCompositionStart();
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 2. Pre-edit letter 'n' typing: beforeinput + input.type.compose transaction
    plugin.onEditIntent({ inputType: "insertCompositionText" } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    (view as any).composing = true;
    const preState = view.state;
    const composeTr1 = preState.update({
      changes: { from: 0, insert: "n" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type.compose",
    });
    (view as any).state = composeTr1.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [composeTr1],
      startState: preState,
      state: composeTr1.state,
      view,
    } as any);
    // Smooth caret animation enabled during pre-edit typing!
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    expect(composeTr1.state.doc.sliceString(0, 1)).toBe("n");
    expect(composeTr1.state.selection.main.head).toBe(1);

    // 3. Continuous pre-edit letter 'i': connects smoothly
    plugin.onEditIntent({ inputType: "insertCompositionText" } as any);
    const composeTr2 = composeTr1.state.update({
      changes: { from: 1, insert: "i" },
      selection: EditorSelection.cursor(2),
      userEvent: "input.type.compose",
    });
    (view as any).state = composeTr2.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [composeTr2],
      startState: composeTr1.state,
      state: composeTr2.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    expect(composeTr2.state.doc.sliceString(0, 2)).toBe("ni");

    // 4. Pre-edit backspace deletion follows the same short-edit transition.
    plugin.onEditIntent({ inputType: "deleteContentBackward" } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    const delTr = composeTr2.state.update({
      changes: { from: 1, to: 2, insert: "" },
      selection: EditorSelection.cursor(1),
      userEvent: "delete.backward",
    });
    (view as any).state = delTr.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [delTr],
      startState: composeTr2.state,
      state: delTr.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 5. Equal document offsets need not mean equal screen coordinates: n -> 你.
    const switchTr = delTr.state.update({
      changes: { from: 0, to: 1, insert: "你" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type.compose",
    });
    (view as any).state = switchTr.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [switchTr],
      startState: delTr.state,
      state: switchTr.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 6. Candidate commit flow: compositionend with committed text "你好" (head 1 -> 2)
    (view as any).composing = false;
    const preCommitState = switchTr.state;
    const commitTr = preCommitState.update({
      changes: { from: 0, to: 1, insert: "你好" },
      selection: EditorSelection.cursor(2),
      userEvent: "input.type.compose",
    });
    (view as any).state = commitTr.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      changes: commitTr.changes,
      transactions: [commitTr],
      startState: preCommitState,
      state: commitTr.state,
      view,
    } as any);
    plugin.onCompositionEnd({ data: "你好" } as any);

    // Smooth caret animation enabled on commit!
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 7. Cancel flow: compositionstart -> compositionend with data: "" (Esc cancel)
    plugin.onCompositionStart();
    plugin.onCompositionEnd({ data: "" } as any);

    const cancelTr = {
      isUserEvent: (ev: string) => ev === "input.type.compose",
      annotation: () => "input.type.compose",
    };
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [cancelTr],
      startState: view.state,
      state: view.state,
      view,
    } as any);
    // Cancelled composition snaps immediately without animation
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("keeps typing viewport scroll native instant and cancels caret animation on native scroll", () => {
    const { view, plugin, dom } = createMockHarness();

    // Typing sets .cm-smooth-caret
    dom.classList.add("cm-smooth-caret");

    // Typing does not set lastKeyNavTime, so handleScrollIntoView returns false (native scroll)
    expect(handleScrollIntoView(view, EditorSelection.cursor(5), {})).toBe(false);

    // If native scroll occurs (e.g. scroll event fires while animFrameId is null),
    // onScroll cancels caret animation so the caret aligns immediately with the scrolled viewport
    plugin.onScroll();
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("keeps the pre-end compose transition running when Chrome emits no post-end docChanged", () => {
    const { view, plugin, dom } = createMockHarness();

    // 1. Composition active: text enters document in compose txn while composing = true
    plugin.onCompositionStart();
    (view as any).composing = true;

    const preState = view.state;
    const earlyTr = preState.update({
      changes: { from: 0, insert: "世界" },
      selection: EditorSelection.cursor(2),
      userEvent: "input.type.compose",
    });
    (view as any).state = earlyTr.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      changes: earlyTr.changes,
      transactions: [earlyTr],
      startState: preState,
      state: earlyTr.state,
      view,
    } as any);

    // Smooth transition enabled on legitimate compose transaction (head 0 -> 2)
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 2. compositionend capture event fires with data "世界"
    // (Note: view.composing may still be true during capture, before CM handler runs)
    plugin.onCompositionEnd({ data: "世界" } as any);

    // Ending composition preserves the transition armed by the actual edit.
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // 3. CodeMirror post-composition update arrives without subsequent docChanged or movement
    (view as any).composing = false;
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: false,
      transactions: [],
      startState: earlyTr.state,
      state: earlyTr.state,
      view,
    } as any);

    // Class remains active for the configured transition
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    // Real text and selection were immediately committed without synthetic transactions
    expect(earlyTr.state.selection.main.head).toBe(2);
    expect(earlyTr.state.doc.sliceString(0, 2)).toBe("世界");

    // Timeout cleans up class
    vi.advanceTimersByTime(MOTION_CONFIG.caretTimeoutMs);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("snaps immediately during IME pre-edit when motion is disabled or prefers-reduced-motion is active", () => {
    const { view, plugin, dom } = createMockHarness();

    setEditorMotionEnabled(false);
    (view as any).composing = true;
    const preState = view.state;
    const tr = preState.update({
      changes: { from: 0, insert: "n" },
      selection: EditorSelection.cursor(1),
      userEvent: "input.type.compose",
    });
    (view as any).state = tr.state;
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [tr],
      startState: preState,
      state: tr.state,
      view,
    } as any);

    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // Also check reduced motion
    setEditorMotionEnabled(true);
    setReducedMotionForTesting(true);
    plugin.update({
      docChanged: true,
      geometryChanged: true,
      selectionSet: true,
      transactions: [tr],
      startState: preState,
      state: tr.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("excludes mouse click gesture animation during active IME composition", () => {
    const { view, plugin, dom } = createMockHarness();

    (view as any).composing = true;
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      clientX: 50,
      clientY: 50,
    } as any);

    // Mouse click candidate is rejected during composing
    const clickTr = view.state.update({
      selection: EditorSelection.cursor(1),
      userEvent: "select.pointer",
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [clickTr],
      startState: view.state,
      state: clickTr.state,
      view,
    } as any);

    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });
});

describe("Search navigation viewport follow and arrival animation", () => {
  let savedRaf: any;
  let savedCancelRaf: any;
  const rafTimers = new Map<number, any>();
  let rafSeq = 1;

  beforeEach(() => {
    vi.useFakeTimers();
    savedRaf = (globalThis as any).requestAnimationFrame;
    savedCancelRaf = (globalThis as any).cancelAnimationFrame;

    (globalThis as any).requestAnimationFrame = (cb: (time: number) => void) => {
      const id = rafSeq++;
      const timer = setTimeout(() => {
        rafTimers.delete(id);
        cb(performance.now());
      }, 16);
      rafTimers.set(id, timer);
      return id;
    };

    (globalThis as any).cancelAnimationFrame = (id: number) => {
      const timer = rafTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        rafTimers.delete(id);
      }
    };

    setEditorMotionEnabled(true);
    setReducedMotionForTesting(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    (globalThis as any).requestAnimationFrame = savedRaf;
    (globalThis as any).cancelAnimationFrame = savedCancelRaf;
    setEditorMotionEnabled(true);
    setReducedMotionForTesting(false);
  });

  it("retargets short search endpoints while search owns focus, then cancels on user touch", () => {
    const { view, plugin, dom, scrollDOM } = createMockHarness({ hasFocus: false });
    (view as any).state = EditorState.create({ doc: "one two one", selection: EditorSelection.single(0, 3) });
    const startState = view.state;
    const searchBar = { closest: (selector: string) => selector === ".search-replace-bar" ? {} : null };
    plugin.onBlur({ relatedTarget: searchBar } as any);
    expect(dom.classList.contains("cm-search-caret")).toBe(true);

    const next = startState.update({
      selection: EditorSelection.single(8, 11),
      annotations: searchMotionAnnotation.of(true),
      effects: EditorView.scrollIntoView(8, { y: "center" }),
      userEvent: "select.search",
    });
    (view as any).state = next.state;
    plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true,
      transactions: [next], startState, state: next.state, view } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    expect(dom.classList.contains("cm-smooth-edit")).toBe(false);
    expect(view.state.selection.main).toEqual(next.state.selection.main);
    expect(view.state.sliceDoc(8, 11)).toBe("one");
    // Already centered: no viewport motion should erase a legitimate short glide.
    view.coordsAtPos = () => ({ left: 20, right: 20, top: 190, bottom: 210 });
    expect(handleScrollIntoView(view, EditorSelection.cursor(8), { y: "center" })).toBe(true);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    vi.advanceTimersByTime(MOTION_CONFIG.caretTimeoutMs);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    expect(dom.classList.contains("cm-search-caret")).toBe(true);

    const previous = next.state.update({ selection: EditorSelection.single(0, 3),
      annotations: searchMotionAnnotation.of(true), userEvent: "select.search" });
    (view as any).state = previous.state;
    plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true,
      transactions: [previous], startState: next.state, state: previous.state, view } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    plugin.onTouchMove();
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    expect(dom.classList.contains("cm-search-caret")).toBe(false);
    vi.advanceTimersByTime(250);
    expect(scrollDOM.scrollTop).toBe(100);
    expect(view.state.doc.toString()).toBe(startState.doc.toString());
    plugin.destroy();
  });

  it.each(["disabled", "reduced", "composing", "far", "undrawn", "hard-cap"])(
    "keeps search endpoint degradation for %s", (guard) => {
      const { view, plugin, dom } = createMockHarness({ hasFocus: false });
      if (guard === "far") (view as any).state = EditorState.create({ doc: "x".repeat(600) });
      if (guard === "hard-cap") (view as any).state = EditorState.create({ doc: "\n".repeat(MOTION_CONFIG.maxMotionDocLines) });
      if (guard === "disabled") setEditorMotionEnabled(false);
      if (guard === "reduced") setReducedMotionForTesting(true);
      if (guard === "composing") plugin.onCompositionStart();
      if (guard === "undrawn") Object.assign(view, { visibleRanges: [{ from: 0, to: 4 }] });
      const startState = view.state;
      const from = guard === "far" ? 550 : 10;
      const tr = startState.update({ selection: EditorSelection.single(from, from + 3),
        annotations: searchMotionAnnotation.of(true), userEvent: "select.search" });
      (view as any).state = tr.state;
      plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true,
        transactions: [tr], startState, state: tr.state, view } as any);
      expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
      plugin.destroy();
    },
  );

  it.each([false, true])("keeps the pending search arrival through target layout measurement (initial geometry=%s)", (geometryChanged) => {
    const { view, plugin, scrollDOM } = createMockHarness({ hasFocus: false });
    const startState = view.state;
    const tr = startState.update({
      selection: EditorSelection.single(10, 15), annotations: searchMotionAnnotation.of(true),
      effects: EditorView.scrollIntoView(10, { y: "center" }), userEvent: "select.search",
    });
    (view as any).state = tr.state;
    plugin.update({ docChanged: false, geometryChanged, selectionSet: true,
      transactions: [tr], startState, state: tr.state, view } as any);
    // CM can measure newly drawn wrapped lines before invoking scrollHandler.
    plugin.update({ docChanged: false, geometryChanged: true, heightChanged: true, viewportChanged: true,
      selectionSet: false, transactions: [], startState: tr.state, state: tr.state, view } as any);
    view.coordsAtPos = () => ({ left: 100, right: 120, top: 500, bottom: 520 });
    expect(handleScrollIntoView(view, EditorSelection.cursor(10), { y: "center" })).toBe(true);
    vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs / 2);
    expect(scrollDOM.scrollTop).toBeGreaterThan(100);
    expect(scrollDOM.scrollTop).toBeLessThan(410);
    vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs);
    expect(scrollDOM.scrollTop).toBe(410);
    plugin.destroy();
  });

  it("animates viewport scroll into view when search box is focused and match range is non-empty", () => {
    const { view, plugin, dom, scrollDOM } = createMockHarness();

    // Editor lacks focus because search box is focused
    (view as any).hasFocus = false;

    // Search transaction: selectNearestMatch / findNext selects match from 10 to 15
    const startState = view.state;
    const searchTr = startState.update({
      selection: EditorSelection.single(10, 15),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (view as any).state = searchTr.state;

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [searchTr],
      startState,
      state: searchTr.state,
      view,
    } as any);

    // A short endpoint glide is allowed until viewport following takes over.
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Target match at top: 500, bottom: 520, scroller clientHeight: 400
    // Centered target: 500 + 10 - 200 = 310 -> moveY = 310 - 100 = 210 -> targetTop = 100 + 210 = 310
    view.coordsAtPos = (_pos: number) => ({
      left: 100,
      right: 120,
      top: 500,
      bottom: 520,
    });

    const handled = handleScrollIntoView(view, EditorSelection.cursor(10), { y: "center" });
    expect(handled).toBe(true);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // Halfway (90ms): smoothly moving towards 310
    vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs / 2);
    expect(scrollDOM.scrollTop).toBeGreaterThan(100);
    expect(scrollDOM.scrollTop).toBeLessThan(410);

    // At completion (180ms): lands exactly at targetTop 410
    vi.advanceTimersByTime(120);
    expect(scrollDOM.scrollTop).toBe(410);

    plugin.destroy();
  });

  it("handles large distance search by smoothly scrolling from start to target without nearTop jump", () => {
    const { view, plugin, scrollDOM } = createMockHarness();
    scrollDOM.scrollHeight = 10000;

    (view as any).hasFocus = false;

    // Search jump to match at line far down (startTop = 100, targetTop = 4200, delta = 4100 > 2500)
    const searchTr = view.state.update({
      selection: EditorSelection.single(10, 15),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (view as any).state = searchTr.state;

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [searchTr],
      startState: view.state,
      state: searchTr.state,
      view,
    } as any);

    // Target coordinates producing moveY = 4100 -> targetTop = 4200 (height 20px: top 4100, bottom 4120)
    view.coordsAtPos = () => ({
      left: 100,
      right: 120,
      top: 4100,
      bottom: 4120,
    });

    const handled = handleScrollIntoView(view, EditorSelection.cursor(10), { y: "start" });
    expect(handled).toBe(true);

    // Initial write phase does NOT jump to nearTop (e.g. 4104); starts at startTop 100
    expect(scrollDOM.scrollTop).toBe(100);
    expect(plugin.hasActiveScrollAnimation()).toBe(true);

    // Smoothly animates full distance over 180ms
    vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs / 2);
    expect(scrollDOM.scrollTop).toBeGreaterThan(100);
    expect(scrollDOM.scrollTop).toBeLessThan(4200);

    vi.advanceTimersByTime(120);
    // Exact destination reached cleanly
    expect(scrollDOM.scrollTop).toBe(4200);
    expect(plugin.hasActiveScrollAnimation()).toBe(false);

    plugin.destroy();
  });

  it("handles document search between 50k and 200k lines by smoothly scrolling to target without nearTop jump", () => {
    const { view, plugin, scrollDOM } = createMockHarness();
    scrollDOM.scrollHeight = 500000;

    (view as any).hasFocus = false;

    // Create a lightweight 100,000 lines state (between 50k and 200k hard limit)
    const largeDocState = EditorState.create({
      doc: "\n".repeat(100_000),
      selection: EditorSelection.single(0, 5),
    });
    expect(largeDocState.doc.lines).toBe(100001);
    expect(largeDocState.doc.lines).toBeGreaterThan(MOTION_CONFIG.maxDocLines);
    expect(largeDocState.doc.lines).toBeLessThanOrEqual(MOTION_CONFIG.maxMotionDocLines);

    (view as any).state = largeDocState;

    const searchTr = largeDocState.update({
      selection: EditorSelection.single(200, 205),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (view as any).state = searchTr.state;

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [searchTr],
      startState: largeDocState,
      state: searchTr.state,
      view,
    } as any);

    view.coordsAtPos = () => ({
      left: 100,
      right: 120,
      top: 300,
      bottom: 320,
    });

    const handled = handleScrollIntoView(view, EditorSelection.cursor(200), { y: "start" });
    expect(handled).toBe(true);

    // Starts at startTop 100 without nearTop jump (e.g. 304)
    expect(scrollDOM.scrollTop).toBe(100);
    expect(plugin.hasActiveScrollAnimation()).toBe(true);

    // Smoothly reaches target 400
    vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs / 2);
    expect(scrollDOM.scrollTop).toBeGreaterThan(100);
    expect(scrollDOM.scrollTop).toBeLessThan(400);

    vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs + 20);
    expect(scrollDOM.scrollTop).toBe(400);
    expect(plugin.hasActiveScrollAnimation()).toBe(false);

    plugin.destroy();
  });

  it("falls back to native direct positioning when document exceeds hard motion limits or motion is disabled", () => {
    // 1. Exceeds maxMotionDocLines (200,001 lines)
    const { view: vLines, plugin: pLines } = createMockHarness({ hasFocus: false });
    const overLinesState = EditorState.create({
      doc: "\n".repeat(MOTION_CONFIG.maxMotionDocLines),
      selection: EditorSelection.single(0, 5),
    });
    expect(overLinesState.doc.lines).toBe(MOTION_CONFIG.maxMotionDocLines + 1);
    (vLines as any).state = overLinesState;
    const trLines = overLinesState.update({
      selection: EditorSelection.single(10, 15),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (vLines as any).state = trLines.state;
    pLines.update({
      docChanged: false, geometryChanged: false, selectionSet: true,
      transactions: [trLines], startState: overLinesState, state: trLines.state, view: vLines,
    } as any);
    expect(handleScrollIntoView(vLines, EditorSelection.cursor(10), { y: "start" })).toBe(false);
    expect(pLines.hasActiveScrollAnimation()).toBe(false);
    pLines.destroy();

    // 2. Exceeds maxMotionDocLength (> 10,000,000 chars)
    const { view: vLen, plugin: pLen } = createMockHarness({ hasFocus: false });
    const trLen = vLen.state.update({
      selection: EditorSelection.single(0, 5),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (vLen as any).state = trLen.state;
    Object.defineProperty(vLen.state, "doc", {
      value: { lines: 10, length: MOTION_CONFIG.maxMotionDocLength + 1 },
      configurable: true,
    });
    pLen.update({
      docChanged: false, geometryChanged: false, selectionSet: true,
      transactions: [trLen], startState: vLen.state, state: trLen.state, view: vLen,
    } as any);
    expect(handleScrollIntoView(vLen, EditorSelection.cursor(0), { y: "start" })).toBe(false);
    expect(pLen.hasActiveScrollAnimation()).toBe(false);
    pLen.destroy();

    // 3. Motion disabled
    setEditorMotionEnabled(false);
    try {
      const { view: vDis, plugin: pDis } = createMockHarness({ hasFocus: false });
      const trDis = vDis.state.update({
        selection: EditorSelection.single(10, 15),
        annotations: searchMotionAnnotation.of(true),
        userEvent: "select.search",
      });
      (vDis as any).state = trDis.state;
      pDis.update({
        docChanged: false, geometryChanged: false, selectionSet: true,
        transactions: [trDis], startState: vDis.state, state: trDis.state, view: vDis,
      } as any);
      // Search positioning remains active when smooth motion is disabled.
      expect(handleScrollIntoView(vDis, EditorSelection.cursor(10), { y: "start" })).toBe(true);
      expect(pDis.hasActiveScrollAnimation()).toBe(false);
      pDis.destroy();
    } finally {
      setEditorMotionEnabled(true);
    }

    // 4. Reduced motion
    setReducedMotionForTesting(true);
    try {
      const { view: vRed, plugin: pRed } = createMockHarness({ hasFocus: false });
      const trRed = vRed.state.update({
        selection: EditorSelection.single(10, 15),
        annotations: searchMotionAnnotation.of(true),
        userEvent: "select.search",
      });
      (vRed as any).state = trRed.state;
      pRed.update({
        docChanged: false, geometryChanged: false, selectionSet: true,
        transactions: [trRed], startState: vRed.state, state: trRed.state, view: vRed,
      } as any);
      // Reduced motion disables animation, not search positioning.
      expect(handleScrollIntoView(vRed, EditorSelection.cursor(10), { y: "start" })).toBe(true);
      expect(pRed.hasActiveScrollAnimation()).toBe(false);
      pRed.destroy();
    } finally {
      setReducedMotionForTesting(false);
    }
  });

  it("animates search scroll to distant virtualized target when coordsAtPos returns null and lineBlockAt provides position", () => {
    const { view, plugin, scrollDOM } = createMockHarness({
      hasFocus: false,
      state: EditorState.create({ doc: "x".repeat(200), selection: EditorSelection.single(0, 0) }),
    });
    const searchTr = view.state.update({
      selection: EditorSelection.single(100, 105),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (view as any).state = searchTr.state;
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [searchTr],
      startState: view.state,
      state: searchTr.state,
      view,
    } as any);

    // coordsAtPos returns null because off-screen line is not rendered
    view.coordsAtPos = () => null;
    (view as any).lineBlockAt = vi.fn((_pos: number) => ({
      from: 100,
      to: 110,
      top: 500,
      height: 20,
    }));

    const handled = handleScrollIntoView(view, EditorSelection.cursor(100), { y: "start", yMargin: 20 });
    expect(handled).toBe(true);
    // targetTop = 500 - 20 = 480.
    // Start at 100 without instant jump:
    expect(scrollDOM.scrollTop).toBe(100);
    expect(plugin.hasActiveScrollAnimation()).toBe(true);

    vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs / 2);
    expect(scrollDOM.scrollTop).toBeGreaterThan(100);
    expect(scrollDOM.scrollTop).toBeLessThan(480);

    vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs);
    expect(scrollDOM.scrollTop).toBe(480);
    expect(plugin.hasActiveScrollAnimation()).toBe(false);

    plugin.destroy();
  });

  it("cancels pending search scroll on user wheel before handleScrollIntoView and consumes without moving viewport", () => {
    const { view, plugin, scrollDOM } = createMockHarness();
    (view as any).hasFocus = false;

    const searchTr = view.state.update({
      selection: EditorSelection.single(10, 15),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (view as any).state = searchTr.state;

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [searchTr],
      startState: view.state,
      state: searchTr.state,
      view,
    } as any);

    // User spins wheel BEFORE CodeMirror measure/handleScrollIntoView executes!
    plugin.onWheel();

    view.coordsAtPos = () => ({ left: 100, right: 120, top: 500, bottom: 520 });

    // When CodeMirror DocView calls handleScrollIntoView for the queued target:
    const handled = handleScrollIntoView(view, EditorSelection.cursor(10), { y: "center" });

    // Returns true (consumed to prevent native DocView from forcefully snapping)
    expect(handled).toBe(true);

    // Viewport does NOT move! It stays at initial 100
    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(100);

    // Subsequent normal scroll request is not blocked (cancelled search request was strictly single-use)
    const normalHandled = handleScrollIntoView(view, EditorSelection.cursor(10), { y: "center" });
    // Returns false because no search is pending and view lacks focus/key nav
    expect(normalHandled).toBe(false);

    plugin.destroy();
  });

  it("cancels pending search scroll on typing (docChanged) before handleScrollIntoView without moving viewport", () => {
    const { view, plugin, scrollDOM } = createMockHarness();
    (view as any).hasFocus = false;

    const searchTr = view.state.update({
      selection: EditorSelection.single(10, 15),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (view as any).state = searchTr.state;

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [searchTr],
      startState: view.state,
      state: searchTr.state,
      view,
    } as any);

    // User types before scroll handler runs
    const typeTr = view.state.update({
      changes: { from: 10, insert: "a" },
      selection: EditorSelection.cursor(11),
      userEvent: "input.type",
    });
    (view as any).state = typeTr.state;

    plugin.update({
      docChanged: true,
      geometryChanged: false,
      selectionSet: true,
      transactions: [typeTr],
      startState: searchTr.state,
      state: typeTr.state,
      view,
    } as any);

    view.coordsAtPos = () => ({ left: 100, right: 120, top: 500, bottom: 520 });

    // Call scroll handler for the old search target
    const handled = handleScrollIntoView(view, EditorSelection.cursor(10), { y: "center" });
    // Consumes cancelled search target to prevent snapping
    expect(handled).toBe(true);

    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(100);

    plugin.destroy();
  });

  it("cancels pending search scroll on programmatic selectionSet before handleScrollIntoView", () => {
    const { view, plugin, scrollDOM } = createMockHarness();
    (view as any).hasFocus = false;

    const searchTr = view.state.update({
      selection: EditorSelection.single(10, 15),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (view as any).state = searchTr.state;

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [searchTr],
      startState: view.state,
      state: searchTr.state,
      view,
    } as any);

    // Another non-search selection change occurs
    const otherTr = view.state.update({
      selection: EditorSelection.cursor(20),
    });
    (view as any).state = otherTr.state;

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [otherTr],
      startState: searchTr.state,
      state: otherTr.state,
      view,
    } as any);

    view.coordsAtPos = () => ({ left: 100, right: 120, top: 500, bottom: 520 });
    const handled = handleScrollIntoView(view, EditorSelection.cursor(10), { y: "center" });
    expect(handled).toBe(true);

    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(100);

    plugin.destroy();
  });

  it("preserves pending search scroll when blur moves focus into search bar, cancels when moving elsewhere", () => {
    const { view, plugin, scrollDOM } = createMockHarness();
    (view as any).hasFocus = false;

    const searchTr = view.state.update({
      selection: EditorSelection.single(10, 15),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (view as any).state = searchTr.state;

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [searchTr],
      startState: view.state,
      state: searchTr.state,
      view,
    } as any);

    // 1. Blur where relatedTarget is in search bar -> preserves pending search scroll
    const searchBarEl = {
      closest: (sel: string) => (sel === ".search-replace-bar" ? {} : null),
    };
    plugin.onBlur({ relatedTarget: searchBarEl } as any);

    view.coordsAtPos = () => ({ left: 100, right: 120, top: 500, bottom: 520 });
    const handled = handleScrollIntoView(view, EditorSelection.cursor(10), { y: "center" });
    // Still animates smoothly because focus is in search bar!
    expect(handled).toBe(true);

    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(410);

    // 2. New search request, then blur to unrelated external element
    const searchTr2 = view.state.update({
      selection: EditorSelection.single(20, 25),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (view as any).state = searchTr2.state;
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [searchTr2],
      startState: view.state,
      state: searchTr2.state,
      view,
    } as any);

    const unrelatedEl = {
      closest: () => null,
    };
    plugin.onBlur({ relatedTarget: unrelatedEl } as any);

    view.coordsAtPos = () => ({ left: 100, right: 120, top: 600, bottom: 620 });
    const handled2 = handleScrollIntoView(view, EditorSelection.cursor(20), { y: "center" });
    // Consumes cancelled request and does not move
    expect(handled2).toBe(true);
    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(410);

    plugin.destroy();
  });

  it("cancels running search scroll animation immediately on user wheel, touch, or typing without pulling back", () => {
    const { view, plugin, scrollDOM } = createMockHarness();

    (view as any).hasFocus = false;

    const searchTr = view.state.update({
      selection: EditorSelection.single(10, 15),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (view as any).state = searchTr.state;

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [searchTr],
      startState: view.state,
      state: searchTr.state,
      view,
    } as any);

    view.coordsAtPos = () => ({ left: 100, right: 120, top: 500, bottom: 520 });
    handleScrollIntoView(view, EditorSelection.cursor(10), { y: "center" });

    // Step 50ms into animation
    vi.advanceTimersByTime(50);
    const midScroll = scrollDOM.scrollTop;
    expect(midScroll).toBeGreaterThan(100);

    // User spins wheel
    plugin.onWheel();

    // Advance remainder of timer
    vi.advanceTimersByTime(200);
    // Must remain at midScroll, not pulled back to destination
    expect(scrollDOM.scrollTop).toBe(midScroll);

    plugin.destroy();
  });

  it("does not animate or shake when search match is already aligned", () => {
    const { view, plugin, scrollDOM } = createMockHarness();

    (view as any).hasFocus = false;

    const searchTr = view.state.update({
      selection: EditorSelection.single(10, 15),
      annotations: searchMotionAnnotation.of(true),
      userEvent: "select.search",
    });
    (view as any).state = searchTr.state;

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [searchTr],
      startState: view.state,
      state: searchTr.state,
      view,
    } as any);

    // Target match is already centered at top: 190, bottom: 210 (center = 300 = clientHeight/2 + curRect.top)
    view.coordsAtPos = () => ({ left: 100, right: 120, top: 190, bottom: 210 });
    const handled = handleScrollIntoView(view, EditorSelection.cursor(10), { y: "center" });
    expect(handled).toBe(true);

    // scrollTop remains 100 without jitter
    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(100);

    plugin.destroy();
  });
});

describe("CodeMirror measure lifecycle & requestMeasure scroll integration regression", () => {
  let savedRaf: any;
  let savedCancelRaf: any;
  const rafTimers = new Map<number, any>();
  let rafSeq = 1;

  beforeEach(() => {
    vi.useFakeTimers();
    savedRaf = (globalThis as any).requestAnimationFrame;
    savedCancelRaf = (globalThis as any).cancelAnimationFrame;

    (globalThis as any).requestAnimationFrame = (cb: (time: number) => void) => {
      const id = rafSeq++;
      const timer = setTimeout(() => {
        rafTimers.delete(id);
        cb(performance.now());
      }, 16);
      rafTimers.set(id, timer);
      return id;
    };

    (globalThis as any).cancelAnimationFrame = (id: number) => {
      const timer = rafTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        rafTimers.delete(id);
      }
    };
  });

  afterEach(() => {
    (globalThis as any).requestAnimationFrame = savedRaf;
    (globalThis as any).cancelAnimationFrame = savedCancelRaf;
    rafTimers.forEach((timer) => clearTimeout(timer));
    rafTimers.clear();
    vi.useRealTimers();
  });

  it("executes scrollHandler during update phase without calling coordsAtPos, defers layout read to read phase, and applies scroll in write phase", () => {
    const { view, plugin, scrollDOM, measureQueue, flushMeasure, setAutoFlushMeasure, setIsUpdating } = createMockHarness();
    setAutoFlushMeasure(false);

    const startState = view.state;
    const nextState = EditorState.create({
      doc: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10",
      selection: EditorSelection.single(10, 15),
    });
    const tr = {
      docChanged: false,
      selectionSet: true,
      geometryChanged: false,
      state: nextState,
      startState,
      transactions: [{
        annotation: (type: any) => type === searchMotionAnnotation ? true : undefined,
        isUserEvent: (type: string) => type === "select.search",
      }],
      view,
    };
    plugin.update(tr as any);
    (view as any).state = nextState;

    view.coordsAtPos = vi.fn((_pos: number) => {
      // If called during updating phase, throws layout read error
      return { left: 20, right: 30, top: 500, bottom: 520 };
    });

    // 1. CodeMirror update phase: isUpdating is true
    setIsUpdating(true);

    // Call handleScrollIntoView while editor is in Updating phase
    const handled = handleScrollIntoView(view, EditorSelection.range(10, 15), { y: "center" });

    // scrollHandler intercepts and schedules measure without throwing layout error
    expect(handled).toBe(true);
    expect(view.coordsAtPos).not.toHaveBeenCalled();
    expect(measureQueue.length).toBe(1);
    expect(scrollDOM.scrollTop).toBe(100); // unchanged during update phase
    expect(plugin.hasActiveScrollAnimation()).toBe(false);

    // 2. CodeMirror measure cycle: flush measure queue
    flushMeasure();

    // coordsAtPos was safely called during read phase
    expect(view.coordsAtPos).toHaveBeenCalled();
    // Animation started during write phase
    expect(plugin.hasActiveScrollAnimation()).toBe(true);

    plugin.destroy();
  });

  it("produces real intermediate scrollTop values during search scroll easing and reaches exact alignment at duration completion", () => {
    const { view, plugin, scrollDOM } = createMockHarness();

    const startState = view.state;
    const nextState = EditorState.create({
      doc: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10",
      selection: EditorSelection.single(10, 15),
    });
    plugin.update({
      docChanged: false,
      selectionSet: true,
      geometryChanged: false,
      state: nextState,
      startState,
      transactions: [{
        annotation: (type: any) => type === searchMotionAnnotation ? true : undefined,
        isUserEvent: () => false,
      }],
      view,
    } as any);
    (view as any).state = nextState;

    // Target rect: top 500, bottom 520 -> center in 400px viewport:
    // targetTop = 510 - 200 = 310. moveY = 310 - 0 = 310. targetTop = 100 + 310 = 410.
    view.coordsAtPos = () => ({ left: 20, right: 30, top: 500, bottom: 520 });

    const handled = handleScrollIntoView(view, EditorSelection.range(10, 15), { y: "center" });
    expect(handled).toBe(true);
    expect(scrollDOM.scrollTop).toBe(100);
    expect(plugin.hasActiveScrollAnimation()).toBe(true);

    // 1. Advance by 60ms (1/3 of 180ms duration):
    // t = 60/180 = 0.3333, easeOutCubic = 1 - (1 - 0.3333)^3 ≈ 0.7037
    // expected scrollTop = 100 + (410 - 100) * 0.7037 ≈ 318.15
    vi.advanceTimersByTime(60);
    expect(scrollDOM.scrollTop).toBeGreaterThan(100);
    expect(scrollDOM.scrollTop).toBeLessThan(410);
    expect(scrollDOM.scrollTop).toBeCloseTo(287.75, 0);

    // 2. Advance by another 60ms (120ms total, 2/3 duration):
    // t = 120/180 = 0.6667, easeOutCubic = 1 - (1 - 0.6667)^3 ≈ 0.9630
    // expected scrollTop = 100 + 310 * 0.9630 ≈ 398.5
    vi.advanceTimersByTime(60);
    expect(scrollDOM.scrollTop).toBeGreaterThan(318);
    expect(scrollDOM.scrollTop).toBeLessThan(410);
    expect(scrollDOM.scrollTop).toBeCloseTo(393.29, 0);

    // 3. Advance to completion (> 180ms total):
    vi.advanceTimersByTime(80);
    expect(scrollDOM.scrollTop).toBe(410);
    expect(plugin.hasActiveScrollAnimation()).toBe(false);

    plugin.destroy();
  });

  it("replaces queued measurement on new jump request and animates only to the newest target", () => {
    const { view, plugin, scrollDOM, measureQueue, flushMeasure, setAutoFlushMeasure } = createMockHarness();
    setAutoFlushMeasure(false);

    const doc = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10";

    // Target 1 at pos 10 -> targetTop = 410
    const state1 = EditorState.create({ doc, selection: EditorSelection.single(10, 15) });
    plugin.update({
      docChanged: false, selectionSet: true, geometryChanged: false,
      state: state1, startState: view.state,
      transactions: [{ annotation: (type: any) => type === searchMotionAnnotation ? true : undefined, isUserEvent: () => false }],
      view,
    } as any);
    (view as any).state = state1;
    view.coordsAtPos = () => ({ left: 20, right: 30, top: 500, bottom: 520 });

    handleScrollIntoView(view, EditorSelection.range(10, 15), { y: "center" });
    const session1 = plugin.getScrollSessionId();
    expect(measureQueue.length).toBe(1);

    // Target 2 at pos 20 arrives BEFORE measureQueue is flushed!
    // top 550, bottom 570 -> targetTop = 560 - 200 = 360, moveY = 360, startTop + 360 = 460 <= 600
    const state2 = EditorState.create({ doc, selection: EditorSelection.single(20, 25) });
    plugin.update({
      docChanged: false, selectionSet: true, geometryChanged: false,
      state: state2, startState: state1,
      transactions: [{ annotation: (type: any) => type === searchMotionAnnotation ? true : undefined, isUserEvent: () => false }],
      view,
    } as any);
    (view as any).state = state2;
    view.coordsAtPos = () => ({ left: 20, right: 30, top: 550, bottom: 570 });

    handleScrollIntoView(view, EditorSelection.range(20, 25), { y: "center" });
    const session2 = plugin.getScrollSessionId();

    // Key-based deduplication replaced the queued measure request
    expect(measureQueue.length).toBe(1);
    expect(session2).toBeGreaterThan(session1);

    // Now flush measurement
    flushMeasure();
    vi.advanceTimersByTime(200);

    // Scrolled to Target 2 (460), never Target 1 (410)
    expect(scrollDOM.scrollTop).toBe(460);

    plugin.destroy();
  });

  it("invalidates queued measurement on user wheel interruption without moving viewport", () => {
    const { view, plugin, scrollDOM, scrollerListeners, flushMeasure, setAutoFlushMeasure } = createMockHarness();
    setAutoFlushMeasure(false);

    const nextState = EditorState.create({
      doc: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10",
      selection: EditorSelection.single(10, 15),
    });
    plugin.update({
      docChanged: false, selectionSet: true, geometryChanged: false,
      state: nextState, startState: view.state,
      transactions: [{ annotation: (type: any) => type === searchMotionAnnotation ? true : undefined, isUserEvent: () => false }],
      view,
    } as any);
    (view as any).state = nextState;
    view.coordsAtPos = () => ({ left: 20, right: 30, top: 500, bottom: 520 });

    handleScrollIntoView(view, EditorSelection.range(10, 15), { y: "center" });

    // User spins wheel before measure flushes
    scrollerListeners["wheel"].forEach((fn) => fn(new Event("wheel")));

    // When measure runs, session is invalidated
    flushMeasure();
    expect(scrollDOM.scrollTop).toBe(100);
    expect(plugin.hasActiveScrollAnimation()).toBe(false);

    vi.advanceTimersByTime(200);
    expect(scrollDOM.scrollTop).toBe(100);

    plugin.destroy();
  });

  it("falls back to instant lineBlockAt positioning without throwing when coordsAtPos returns null", () => {
    const { view, plugin, scrollDOM } = createMockHarness();
    plugin.setLastKeyNavTime(Date.now());

    // coordsAtPos returns null (e.g. unrendered gap)
    view.coordsAtPos = () => null;
    (view as any).lineBlockAt = vi.fn((_pos: number) => ({
      from: 0,
      to: 10,
      top: 350,
      height: 20,
    }));

    const handled = handleScrollIntoView(view, EditorSelection.cursor(0), { y: "start", yMargin: 20 });
    expect(handled).toBe(true);

    // Layout measured via lineBlockAt, instant jump to 350 - 20 = 330 without smooth animation
    expect(view.lineBlockAt).toHaveBeenCalledWith(0);
    expect(plugin.hasActiveScrollAnimation()).toBe(false);
    expect(scrollDOM.scrollTop).toBe(330);

    plugin.destroy();
  });

  it("keeps queued search scroll measure when geometryChanged occurs for the same target after consumeSearchScroll, while cancelling on real user interruption", () => {
    const { view, plugin, scrollDOM, scrollerListeners, measureQueue, flushMeasure, setAutoFlushMeasure } = createMockHarness({ hasFocus: false });
    // Disable autoFlushMeasure so requestMeasure stays queued until we explicitly flush
    setAutoFlushMeasure(false);

    const startState = view.state;
    const searchTr = startState.update({
      selection: EditorSelection.single(10, 15),
      annotations: searchMotionAnnotation.of(true),
      effects: EditorView.scrollIntoView(10, { y: "center" }),
      userEvent: "select.search",
    });
    (view as any).state = searchTr.state;

    // 1. Transaction arrives: update() sets pendingSearchScroll
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [searchTr],
      startState,
      state: searchTr.state,
      view,
    } as any);

    // 2. CodeMirror's docView.scrollIntoView invokes scrollHandler
    view.coordsAtPos = vi.fn(() => ({ left: 20, right: 30, top: 500, bottom: 520 }));
    const handled = handleScrollIntoView(view, EditorSelection.cursor(10), { y: "center" });
    expect(handled).toBe(true);

    // consumeSearchScroll has consumed pendingSearchScroll and registered activeSearchScroll
    const sessionId = plugin.getScrollSessionId();
    expect(sessionId).toBeGreaterThan(0);
    expect(plugin.getActiveSearchScroll()?.sessionId).toBe(sessionId);

    // 3. Before requestMeasure flushes, CodeMirror measures newly drawn viewport lines
    // and fires an update with geometryChanged = true for the SAME state and without selectionSet
    plugin.update({
      docChanged: false,
      geometryChanged: true,
      heightChanged: true,
      viewportChanged: true,
      selectionSet: false,
      transactions: [],
      startState: searchTr.state,
      state: searchTr.state,
      view,
    } as any);

    // Assert: session ID was NOT invalidated by normal same-target layout advancement!
    expect(plugin.getScrollSessionId()).toBe(sessionId);
    expect(plugin.getActiveSearchScroll()?.sessionId).toBe(sessionId);

    // 4. Now CodeMirror's batched measure runs and flushes the queued requestMeasure
    flushMeasure(() => {
      plugin.update({
        docChanged: false, geometryChanged: true, heightChanged: true,
        viewportChanged: false, selectionSet: false, transactions: [],
        startState: view.state, state: view.state, view,
      } as any);
    });

    // The session must survive both read -> updatePlugins -> write and later RAFs.
    expect(plugin.hasActiveScrollAnimation()).toBe(true);
    vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs / 2);
    expect(scrollDOM.scrollTop).toBeGreaterThan(100);
    expect(scrollDOM.scrollTop).toBeLessThan(410);
    plugin.update({
      docChanged: false, geometryChanged: true, heightChanged: true,
      viewportChanged: true, selectionSet: false, transactions: [],
      startState: view.state, state: view.state, view,
    } as any);
    flushMeasure();
    expect(plugin.getScrollSessionId()).toBe(sessionId);
    expect(plugin.hasActiveScrollAnimation()).toBe(true);
    vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs);
    expect(scrollDOM.scrollTop).toBe(410);
    expect(plugin.hasActiveScrollAnimation()).toBe(false);
    expect(plugin.getActiveSearchScroll()).toBeNull();
    expect(measureQueue).toHaveLength(0);
    expect(view.coordsAtPos).toHaveBeenCalledTimes(1);

    // 5. Contrast test: if a REAL user interruption (e.g. wheel) occurs after consumeSearchScroll,
    // the queued measure is properly invalidated and does NOT scroll
    const secondSearchTr = searchTr.state.update({
      selection: EditorSelection.single(20, 25),
      annotations: searchMotionAnnotation.of(true),
      effects: EditorView.scrollIntoView(20, { y: "center" }),
      userEvent: "select.search",
    });
    (view as any).state = secondSearchTr.state;
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [secondSearchTr],
      startState: searchTr.state,
      state: secondSearchTr.state,
      view,
    } as any);

    view.coordsAtPos = () => ({ left: 20, right: 30, top: 600, bottom: 620 });
    handleScrollIntoView(view, EditorSelection.cursor(20), { y: "center" });
    const secondSessionId = plugin.getScrollSessionId();
    expect(secondSessionId).toBeGreaterThan(sessionId);

    // User spins wheel before measure flushes
    scrollerListeners["wheel"].forEach((fn) => fn(new Event("wheel")));

    // Active search scroll is cancelled, session is invalidated
    expect(plugin.getScrollSessionId()).toBeGreaterThan(secondSessionId);
    expect(plugin.getActiveSearchScroll()).toBeNull();

    // Flushing measure now does NOT move viewport
    const beforeWheelScroll = scrollDOM.scrollTop;
    flushMeasure();
    expect(plugin.hasActiveScrollAnimation()).toBe(false);
    expect(scrollDOM.scrollTop).toBe(beforeWheelScroll);

    plugin.destroy();
  });

  it("stops an in-flight search on resize, font/zoom change, user interruption, state replacement and destroy", () => {
    // 1. User interruptions, doc state replacement and destroy truly cancel in-flight search
    for (const reason of ["wheel", "touch", "click", "input", "state", "destroy"]) {
      const { view, plugin, scrollDOM, flushMeasure, setAutoFlushMeasure } = createMockHarness();
      setAutoFlushMeasure(false);
      let font = "14px monospace";
      (view.contentDOM as any).ownerDocument = {
        defaultView: { getComputedStyle: () => ({ font }) },
      };
      const startState = view.state;
      const tr = startState.update({
        selection: EditorSelection.single(10, 15),
        annotations: searchMotionAnnotation.of(true),
      });
      (view as any).state = tr.state;
      plugin.update({ docChanged: false, selectionSet: true, geometryChanged: false,
        state: tr.state, startState, transactions: [tr], view } as any);
      view.coordsAtPos = () => ({ left: 20, right: 30, top: 500, bottom: 520 });
      expect(handleScrollIntoView(view, tr.state.selection.main, { y: "center" })).toBe(true);
      flushMeasure();
      vi.advanceTimersByTime(64);
      const stoppedAt = scrollDOM.scrollTop;
      expect(stoppedAt).toBeGreaterThan(100);

      if (reason === "wheel") plugin.onWheel();
      else if (reason === "touch") plugin.onTouchMove();
      else if (reason === "click") plugin.onPointerDown({ pointerType: "mouse" } as any);
      else if (reason === "input") plugin.onEditIntent();
      else if (reason === "destroy") plugin.destroy();
      else if (reason === "state") {
        (view as any).state = EditorState.create({ doc: startState.doc });
        plugin.update({ docChanged: false, geometryChanged: true,
          heightChanged: true, viewportChanged: true,
          selectionSet: false, transactions: [], startState: tr.state, state: view.state, view } as any);
      }
      flushMeasure();
      expect(plugin.hasActiveScrollAnimation(), reason).toBe(false);
      vi.advanceTimersByTime(200);
      expect(scrollDOM.scrollTop, reason).toBe(stoppedAt);
      plugin.destroy();
    }

    // 2. Normal layout, scrollbar toggles, and dimensions safely re-measure and re-align
    for (const reason of ["resize", "resize-and-height", "font", "font-metrics", "zoom"]) {
      const { view, plugin, scrollDOM, flushMeasure, setAutoFlushMeasure } = createMockHarness();
      setAutoFlushMeasure(false);
      let font = "14px monospace";
      (view.contentDOM as any).ownerDocument = {
        defaultView: { getComputedStyle: () => ({ font }) },
      };
      const startState = view.state;
      const tr = startState.update({
        selection: EditorSelection.single(10, 15),
        annotations: searchMotionAnnotation.of(true),
      });
      (view as any).state = tr.state;
      plugin.update({ docChanged: false, selectionSet: true, geometryChanged: false,
        state: tr.state, startState, transactions: [tr], view } as any);
      const docTop = 600;
      view.coordsAtPos = () => ({
        left: 20,
        right: 30,
        top: docTop - scrollDOM.scrollTop,
        bottom: docTop - scrollDOM.scrollTop + 20,
      });
      expect(handleScrollIntoView(view, tr.state.selection.main, { y: "center" })).toBe(true);
      flushMeasure();
      vi.advanceTimersByTime(64);
      expect(scrollDOM.scrollTop).toBeGreaterThan(100);

      if (reason === "resize-and-height") scrollDOM.clientWidth -= 40;
      if (reason === "font") font = "14px serif";
      if (reason === "font-metrics") (view as any).defaultLineHeight = 28;
      if (reason === "zoom") (view as any).scaleY = 1.25;
      plugin.update({ docChanged: false, geometryChanged: true,
        heightChanged: reason !== "resize", viewportChanged: true,
        selectionSet: false, transactions: [], startState: tr.state, state: view.state, view } as any);
      flushMeasure();
      // Navigation remains alive and aligns to destination
      expect(plugin.getScrollSessionId()).toBeGreaterThan(0);
      vi.advanceTimersByTime(200);
      expect(plugin.hasActiveScrollAnimation()).toBe(false);
      expect(scrollDOM.scrollTop, reason).toBe(410);
      plugin.destroy();
    }
  });

  it("invalidates a queued click measure when drag takes over, without delaying selection or layer writes", () => {
    const { view, plugin, dom, contentNode, flushMeasure, measureQueue, setAutoFlushMeasure } = createMockHarness();
    setAutoFlushMeasure(false);
    plugin.onPointerDown({ pointerType: "mouse", clientX: 100, clientY: 100 } as any);
    plugin.onMouseDown({ button: 0, detail: 1, shiftKey: true,
      clientX: 100, clientY: 100, target: contentNode } as any);
    const click = view.state.update({ selection: EditorSelection.single(0, 15), userEvent: "select.pointer" });
    const startState = view.state;
    (view as any).state = click.state;
    plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true,
      startState, state: click.state, transactions: [click], view } as any);
    // Native state is already committed, while the optional click check is queued.
    expect(view.state.selection.main.head).toBe(15);
    expect(measureQueue).toHaveLength(1);
    view.coordsAtPos = vi.fn(() => ({ left: 800, right: 801, top: 100, bottom: 120 }));
    let layerDraws = 0;
    view.requestMeasure({ read: v => v.state.selection.main.head, write: head => {
      expect(head).toBe(20);
      layerDraws++;
    } });
    // The next native pointer transaction can precede the scheduled CM measure.
    plugin.onPointerMove({ clientX: 110, clientY: 100 } as any);
    const drag = view.state.update({ selection: EditorSelection.single(0, 20), userEvent: "select.pointer" });
    (view as any).state = drag.state;
    plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true,
      startState: click.state, state: drag.state, transactions: [drag], view } as any);
    expect(view.state.selection.main.head).toBe(20);
    flushMeasure();
    expect(layerDraws).toBe(1);
    expect(view.coordsAtPos).not.toHaveBeenCalled();
    expect(measureQueue).toHaveLength(0);
    // The invisible old click must not cancel the newer drag transition.
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    plugin.destroy();
  });

  it("invalidates pending caret measurement when a new transaction or destroy occurs before measurement flushes", () => {
    const { view, plugin, dom, contentNode, flushMeasure, setAutoFlushMeasure } = createMockHarness();
    setAutoFlushMeasure(false);

    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      shiftKey: true,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);

    const newState = view.state.update({
      selection: EditorSelection.single(0, 15),
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: newState.state,
      view,
    } as any);

    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Another transaction arrives (e.g. typing or programmatic jump) before measure flushes
    const thirdState = newState.state.update({
      selection: EditorSelection.single(5, 5),
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (_ev: string) => false }],
      startState: newState.state,
      state: thirdState.state,
      view,
    } as any);

    // Caret animation was cancelled for the new non-motion selection
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // Flushing the older queued caret measurement now does NOT re-arm caret
    flushMeasure();
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });
});

describe("Pure Shift+Click selection extension and active endpoint animation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("animates active caret on Shift-click from collapsed cursor to range (empty -> nonempty)", () => {
    const { view, plugin, dom, contentNode } = createMockHarness({
      posAtCoords: () => 15,
    });
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      shiftKey: true,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);

    const newState = view.state.update({
      selection: EditorSelection.single(0, 15),
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: newState.state,
      view,
    } as any);

    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    vi.advanceTimersByTime(MOTION_CONFIG.caretTimeoutMs);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    plugin.destroy();
  });

  it("animates active caret on Shift-click extending existing selection farther from anchor", () => {
    const { view, plugin, dom, contentNode } = createMockHarness({
      state: EditorState.create({
        doc: "Hello CodeMirror 6\nSecond line\nThird line",
        selection: EditorSelection.single(0, 15),
      }),
      posAtCoords: () => 25,
      coordsAtPos: () => ({ left: 200, right: 210, top: 100, bottom: 120 }),
    });

    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      shiftKey: true,
      clientX: 200,
      clientY: 100,
      target: contentNode,
    } as any);

    const newState = view.state.update({
      selection: EditorSelection.single(0, 25),
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: newState.state,
      view,
    } as any);

    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    plugin.destroy();
  });

  it("animates active caret on Shift-click shortening existing selection closer to anchor", () => {
    const { view, plugin, dom, contentNode } = createMockHarness({
      state: EditorState.create({
        doc: "Hello CodeMirror 6\nSecond line\nThird line",
        selection: EditorSelection.single(0, 25),
      }),
      posAtCoords: () => 10,
      coordsAtPos: () => ({ left: 100, right: 110, top: 100, bottom: 120 }),
    });

    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      shiftKey: true,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);

    const newState = view.state.update({
      selection: EditorSelection.single(0, 10),
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: newState.state,
      view,
    } as any);

    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    plugin.destroy();
  });

  it("animates active caret on Shift-click reversing selection across anchor", () => {
    const { view, plugin, dom, contentNode } = createMockHarness({
      state: EditorState.create({
        doc: "Hello CodeMirror 6\nSecond line\nThird line",
        selection: EditorSelection.single(10, 25),
      }),
      posAtCoords: () => 5,
      coordsAtPos: () => ({ left: 50, right: 60, top: 100, bottom: 120 }),
    });

    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      shiftKey: true,
      clientX: 50,
      clientY: 100,
      target: contentNode,
    } as any);

    // Reversed selection: anchor remains 10, head becomes 5
    const newState = view.state.update({
      selection: EditorSelection.single(10, 5),
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: newState.state,
      view,
    } as any);

    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);
    plugin.destroy();
  });

  it("smoothly connects consecutive Shift-clicks across multiple extension steps", () => {
    let targetPos = 10;
    const { view, plugin, dom, contentNode } = createMockHarness({
      posAtCoords: () => targetPos,
      coordsAtPos: () => ({ left: targetPos * 10, right: targetPos * 10 + 10, top: 100, bottom: 120 }),
    });

    // Step 1: cursor(0) -> single(0, 10)
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      shiftKey: true,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);
    const state1 = view.state.update({ selection: EditorSelection.single(0, 10) });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: state1.state,
      view,
    } as any);
    (view as any).state = state1.state;
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Step 2: single(0, 10) -> single(0, 25)
    targetPos = 25;
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      shiftKey: true,
      clientX: 250,
      clientY: 100,
      target: contentNode,
    } as any);
    const state2 = state1.state.update({ selection: EditorSelection.single(0, 25) });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: state1.state,
      state: state2.state,
      view,
    } as any);
    (view as any).state = state2.state;
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // Step 3: single(0, 25) -> single(0, 15) (shorten)
    targetPos = 15;
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      shiftKey: true,
      clientX: 150,
      clientY: 100,
      target: contentNode,
    } as any);
    const state3 = state2.state.update({ selection: EditorSelection.single(0, 15) });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: state2.state,
      state: state3.state,
      view,
    } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    vi.advanceTimersByTime(MOTION_CONFIG.caretTimeoutMs);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("hands over animation to drag path when mouse moves > 4px after Shift-down", () => {
    const { view, plugin, dom, contentNode } = createMockHarness({
      posAtCoords: () => 15,
    });
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      shiftKey: true,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);

    // Mouse movement > 4px promotes gesture to drag
    plugin.onPointerMove({ clientX: 110, clientY: 100 } as any);

    const newState = view.state.update({
      selection: EditorSelection.single(0, 15),
    });
    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: newState.state,
      view,
    } as any);

    // Animated via drag animation path
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    plugin.destroy();
  });

  it("rejects Shift-click animation when combined with other modifiers or double-click", () => {
    const { view, plugin, dom, contentNode } = createMockHarness({
      posAtCoords: () => 15,
    });

    const newState = view.state.update({ selection: EditorSelection.single(0, 15) });

    // 1. Shift + Ctrl
    plugin.onMouseDown({ button: 0, detail: 1, shiftKey: true, ctrlKey: true, clientX: 100, clientY: 100, target: contentNode } as any);
    plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true, transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }], startState: view.state, state: newState.state, view } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // 2. Shift + Alt
    plugin.onMouseDown({ button: 0, detail: 1, shiftKey: true, altKey: true, clientX: 100, clientY: 100, target: contentNode } as any);
    plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true, transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }], startState: view.state, state: newState.state, view } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // 3. Shift + Meta
    plugin.onMouseDown({ button: 0, detail: 1, shiftKey: true, metaKey: true, clientX: 100, clientY: 100, target: contentNode } as any);
    plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true, transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }], startState: view.state, state: newState.state, view } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // 4. Shift + double click (detail: 2)
    plugin.onMouseDown({ button: 0, detail: 2, shiftKey: true, clientX: 100, clientY: 100, target: contentNode } as any);
    plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true, transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }], startState: view.state, state: newState.state, view } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    // 5. Outside contentDOM (e.g. gutter)
    plugin.onMouseDown({ button: 0, detail: 1, shiftKey: true, clientX: 10, clientY: 100, target: { isContent: false } } as any);
    plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true, transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }], startState: view.state, state: newState.state, view } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("rejects Shift-click animation when motion is disabled, reduced motion active, or composing", () => {
    const { view, plugin, dom, contentNode } = createMockHarness({ posAtCoords: () => 15 });
    const newState = view.state.update({ selection: EditorSelection.single(0, 15) });

    // 1. Motion disabled
    setEditorMotionEnabled(false);
    try {
      plugin.onMouseDown({ button: 0, detail: 1, shiftKey: true, clientX: 100, clientY: 100, target: contentNode } as any);
      plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true, transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }], startState: view.state, state: newState.state, view } as any);
      expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    } finally {
      setEditorMotionEnabled(true);
    }

    // 2. Reduced motion
    setReducedMotionForTesting(true);
    try {
      plugin.onMouseDown({ button: 0, detail: 1, shiftKey: true, clientX: 100, clientY: 100, target: contentNode } as any);
      plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true, transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }], startState: view.state, state: newState.state, view } as any);
      expect(dom.classList.contains("cm-smooth-caret")).toBe(false);
    } finally {
      setReducedMotionForTesting(false);
    }

    // 3. Composing
    plugin.onCompositionStart();
    plugin.onMouseDown({ button: 0, detail: 1, shiftKey: true, clientX: 100, clientY: 100, target: contentNode } as any);
    plugin.update({ docChanged: false, geometryChanged: false, selectionSet: true, transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }], startState: view.state, state: newState.state, view } as any);
    expect(dom.classList.contains("cm-smooth-caret")).toBe(false);

    plugin.destroy();
  });

  it("rejects Shift-click animation when distance limits or viewport bounds are exceeded", () => {
    // 1. charDist > maxCaretCharDist (500)
    const { view: vDist, plugin: pDist, dom: dDist, contentNode } = createMockHarness({
      state: EditorState.create({ doc: "x".repeat(600), selection: EditorSelection.cursor(0) }),
      posAtCoords: () => 505,
    });
    pDist.onMouseDown({ button: 0, detail: 1, shiftKey: true, clientX: 100, clientY: 100, target: contentNode } as any);
    const trDist = vDist.state.update({ selection: EditorSelection.single(0, 505) });
    pDist.update({ docChanged: false, geometryChanged: false, selectionSet: true, transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }], startState: vDist.state, state: trDist.state, view: vDist } as any);
    expect(dDist.classList.contains("cm-smooth-caret")).toBe(false);
    pDist.destroy();

    // 2. Out of visible viewport
    const { view: vBounds, plugin: pBounds, dom: dBounds } = createMockHarness({
      coordsAtPos: () => ({ left: 800, right: 810, top: 100, bottom: 120 }), // viewport right is 588
      posAtCoords: () => 15,
    });
    pBounds.onMouseDown({ button: 0, detail: 1, shiftKey: true, clientX: 100, clientY: 100, target: contentNode } as any);
    const trBounds = vBounds.state.update({ selection: EditorSelection.single(0, 15) });
    pBounds.update({ docChanged: false, geometryChanged: false, selectionSet: true, transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }], startState: vBounds.state, state: trBounds.state, view: vBounds } as any);
    expect(dBounds.classList.contains("cm-smooth-caret")).toBe(false);
    pBounds.destroy();
  });

  it("does not call forced layout APIs on mousedown hot path and applies native selection immediately", () => {
    let posAtCoordsCalls = 0;
    let coordsAtPosCallsOnMouseDown = 0;
    let onMouseDownPhase = false;

    const { view, plugin, dom, contentNode } = createMockHarness({
      posAtCoords: (_coords: any) => {
        posAtCoordsCalls++;
        return 15;
      },
      coordsAtPos: (_pos: number) => {
        if (onMouseDownPhase) {
          coordsAtPosCallsOnMouseDown++;
        }
        return { left: 100, right: 110, top: 100, bottom: 120 };
      },
    });

    onMouseDownPhase = true;
    plugin.onPointerDown({ pointerType: "mouse" } as any);
    plugin.onMouseDown({
      button: 0,
      detail: 1,
      shiftKey: true,
      clientX: 100,
      clientY: 100,
      target: contentNode,
    } as any);
    onMouseDownPhase = false;

    // Zero forced layout reads on mousedown capture listener
    expect(posAtCoordsCalls).toBe(0);
    expect(coordsAtPosCallsOnMouseDown).toBe(0);

    // Native CodeMirror transaction immediately applies real selection without delay
    const newState = view.state.update({
      selection: EditorSelection.single(0, 15),
    });
    expect(newState.state.selection.main.from).toBe(0);
    expect(newState.state.selection.main.to).toBe(15);
    expect(newState.state.selection.main.head).toBe(15);

    plugin.update({
      docChanged: false,
      geometryChanged: false,
      selectionSet: true,
      transactions: [{ isUserEvent: (ev: string) => ev === "select.pointer" }],
      startState: view.state,
      state: newState.state,
      view,
    } as any);

    // Smooth transition is armed without delaying real selection
    expect(dom.classList.contains("cm-smooth-caret")).toBe(true);

    // posAtCoords was never called by the motion plugin
    expect(posAtCoordsCalls).toBe(0);

    plugin.destroy();
  });
});


describe("Search navigation horizontal viewport positioning regression (2026-10-27)", () => {
  let savedRaf: any;
  let savedCancelRaf: any;
  const rafTimers = new Map<number, any>();
  let rafSeq = 1;

  beforeEach(() => {
    vi.useFakeTimers();
    savedRaf = (globalThis as any).requestAnimationFrame;
    savedCancelRaf = (globalThis as any).cancelAnimationFrame;

    (globalThis as any).requestAnimationFrame = (cb: (time: number) => void) => {
      const id = rafSeq++;
      const timer = setTimeout(() => {
        rafTimers.delete(id);
        cb(performance.now());
      }, 16);
      rafTimers.set(id, timer);
      return id;
    };

    (globalThis as any).cancelAnimationFrame = (id: number) => {
      const timer = rafTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        rafTimers.delete(id);
      }
    };

    setEditorMotionEnabled(true);
    setReducedMotionForTesting(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    (globalThis as any).requestAnimationFrame = savedRaf;
    (globalThis as any).cancelAnimationFrame = savedCancelRaf;
    setEditorMotionEnabled(true);
    setReducedMotionForTesting(false);
  });

  describe("computeScrollMoveX and computeTargetScrollLeft", () => {
    it("centers short hits in available viewport excluding gutter and margins", () => {
      // Bounding viewport: 0 to 800 (clientWidth: 800)
      // Gutter margins.left: 50, margins.right: 10
      // Available content area: 50 to 790 (width: 740, center: 420)
      const bounding = { left: 0, right: 800 };
      const margins = { left: 50, right: 10 };
      const xMargin = 5;

      // 1. Hit is off-screen to the right (real text rect: 1200 to 1300, width: 100)
      const rectRight = {
        left: 1200 - margins.left,
        right: 1300 + margins.right,
      };
      const moveXRight = computeScrollMoveX({
        xStrategy: "center",
        rect: rectRight,
        bounding,
        xMargin,
        side: 1,
        ltr: true,
      });
      // targetLeft = 1150 + 160 / 2 - 800 / 2 = 1150 + 80 - 400 = 830
      // moveX = 830 - 0 = 830
      expect(moveXRight).toBe(830);
      // New real text position in screen coords: 1200 - 830 = 370 to 1300 - 830 = 470
      // Text center: 420. Exactly matches content area center (50 + 790) / 2 = 420!
      expect((370 + 470) / 2).toBe((50 + 790) / 2);

      // 2. Hit is off-screen to the left (real text rect: -200 to -100, width: 100)
      const rectLeft = {
        left: -200 - margins.left,
        right: -100 + margins.right,
      };
      const moveXLeft = computeScrollMoveX({
        xStrategy: "center",
        rect: rectLeft,
        bounding,
        xMargin,
        side: 1,
        ltr: true,
      });
      // targetLeft = -250 + 80 - 400 = -570
      expect(moveXLeft).toBe(-570);
      // New real text position: -200 - (-570) = 370 to -100 - (-570) = 470
      expect((370 + 470) / 2).toBe((50 + 790) / 2);
    });

    it("stably aligns start of ultra-wide hits past gutter with xMargin", () => {
      const bounding = { left: 0, right: 800 };
      const margins = { left: 50, right: 10 };
      const xMargin = 5;

      // Text width: 1200px > available content width 740px
      // Real text rect: 1000 to 2200
      const targetRect = {
        left: 1000 - margins.left, // 950
        right: 2200 + margins.right, // 2210
      };
      // targetRect width: 1260 > bounding width 800
      const moveX = computeScrollMoveX({
        xStrategy: "center",
        rect: targetRect,
        bounding,
        xMargin,
        side: 1,
        ltr: true,
      });
      // For ultra-wide hit: targetLeft = rect.left - xMargin = 950 - 5 = 945
      // moveX = 945 - 0 = 945
      expect(moveX).toBe(945);

      // New real text start: 1000 - 945 = 55
      // Gutter left is 50, plus xMargin 5 = 55!
      expect(1000 - moveX).toBe(margins.left + xMargin);
    });

    it("clamps horizontal scroll to document boundaries [0, scrollWidth - clientWidth]", () => {
      // 1. Moving past left boundary clamps to 0
      expect(computeTargetScrollLeft(100, -200, 2000, 800)).toBe(0);

      // 2. Moving past right boundary clamps to scrollWidth - clientWidth (1200)
      expect(computeTargetScrollLeft(1000, 500, 2000, 800)).toBe(1200);

      // 3. Within boundaries moves directly
      expect(computeTargetScrollLeft(100, 200, 2000, 800)).toBe(300);

      // 4. Undefined scrollWidth (test mock) preserves startLeft + moveX
      expect(computeTargetScrollLeft(0, -50)).toBe(-50);
    });
  });

  describe("handleScrollIntoView with full range and virtualization follow-up", () => {
    it("measures both head and anchor for search scroll and centers short hit", () => {
      const { view, plugin, scrollDOM, flushMeasure } = createMockHarness();
      // Setup text where head is at 20, anchor is at 10
      const tr = view.state.update({
        selection: EditorSelection.single(10, 20),
        annotations: searchMotionAnnotation.of(true),
        userEvent: "select.search",
      });
      (view as any).state = tr.state;
      plugin.update({
        docChanged: false,
        geometryChanged: false,
        selectionSet: true,
        transactions: [tr],
        startState: view.state,
        state: tr.state,
        view,
      } as any);

      // Mock coordsAtPos to return distinct coordinates for head (20) and anchor (10)
      view.coordsAtPos = (pos: number) => {
        if (pos === 10) return { left: 900, right: 910, top: 200, bottom: 220 };
        if (pos === 20) return { left: 990, right: 1000, top: 200, bottom: 220 };
        return { left: 900, right: 1000, top: 200, bottom: 220 };
      };

      const range = EditorSelection.range(10, 20);
      const handled = handleScrollIntoView(view, range, { x: "center", y: "center" });
      expect(handled).toBe(true);
      flushMeasure();

      // scrollDOM.scrollLeft was updated to center the hit in clientWidth (588)
      // Hit is [900, 1000] (width: 100). Center: 950.
      // Target center is clientWidth / 2 = 294.
      // moveX = 950 - 294 = 656.
      expect(scrollDOM.scrollLeft).toBe(656);
      plugin.destroy();
    });

    it("stably displays start of ultra-wide hit past gutter on search navigation", () => {
      const { view, plugin, scrollDOM, flushMeasure } = createMockHarness({
        state: EditorState.create({ doc: "x".repeat(200) }),
      });
      const startState = view.state;
      const tr = startState.update({
        selection: EditorSelection.single(0, 100),
        annotations: searchMotionAnnotation.of(true),
        userEvent: "select.search",
      });
      (view as any).state = tr.state;
      plugin.update({
        docChanged: false,
        geometryChanged: false,
        selectionSet: true,
        transactions: [tr],
        startState,
        state: tr.state,
        view,
      } as any);

      // Hit width is 1500px, clientWidth is 588px
      view.coordsAtPos = (pos: number) => {
        if (pos === 0) return { left: 200, right: 210, top: 200, bottom: 220 };
        if (pos === 100) return { left: 1690, right: 1700, top: 200, bottom: 220 };
        return { left: 200, right: 1700, top: 200, bottom: 220 };
      };

      const range = EditorSelection.range(0, 100);
      const handled = handleScrollIntoView(view, range, { x: "center", y: "center", xMargin: 5 });
      expect(handled).toBe(true);
      flushMeasure();

      // Ultra-wide hit displays start at rect.left - xMargin (200 - 5 = 195)
      expect(scrollDOM.scrollLeft).toBe(195);
      plugin.destroy();
    });

    it("follows up horizontal positioning when coordsAtPos is null initially due to virtualization", () => {
      expect(SCROLL_FOLLOWUP_MEASURE_KEY).toBe("editorMotionScrollFollowup");
      const { view, plugin, scrollDOM, flushMeasure } = createMockHarness({
        hasFocus: false,
        state: EditorState.create({ doc: "x".repeat(1000), selection: EditorSelection.single(0, 0) }),
      });
      const startState = view.state;
      const tr = startState.update({
        selection: EditorSelection.single(500, 520),
        annotations: searchMotionAnnotation.of(true),
        userEvent: "select.search",
      });
      (view as any).state = tr.state;
      plugin.update({
        docChanged: false,
        geometryChanged: false,
        selectionSet: true,
        transactions: [tr],
        startState,
        state: tr.state,
        view,
      } as any);

      // Initially target line is virtualized (coordsAtPos returns null)
      let rendered = false;
      view.coordsAtPos = (pos: number) => {
        if (!rendered) return null;
        if (pos === 500) return { left: 800, right: 810, top: 600, bottom: 620 };
        if (pos === 520) return { left: 890, right: 900, top: 600, bottom: 620 };
        return { left: 800, right: 900, top: 600, bottom: 620 };
      };
      (view as any).lineBlockAt = vi.fn((_pos: number) => ({
        from: 500,
        to: 520,
        top: 600,
        height: 20,
      }));

      const range = EditorSelection.range(500, 520);
      const handled = handleScrollIntoView(view, range, { x: "center", y: "center" });
      expect(handled).toBe(true);

      // Start scrollTop is 100; animation is running
      expect(scrollDOM.scrollTop).toBe(100);
      expect(plugin.hasActiveScrollAnimation()).toBe(true);
      expect(scrollDOM.scrollLeft).toBe(0);

      // Target line is rendered once animation completes at targetTop
      rendered = true;
      vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs + 50);
      flushMeasure();

      // Horizontal follow-up measured the rendered line and applied scrollLeft
      expect(scrollDOM.scrollLeft).toBeGreaterThan(0);
      plugin.destroy();
    });

    it("preserves native keyboard navigation strategy unchanged", () => {
      const { view, plugin, scrollDOM, flushMeasure } = createMockHarness();
      plugin.setLastKeyNavTime(Date.now());
      (view as any).hasFocus = true;

      // Update state selection to match cursor(5)
      const selTr = view.state.update({ selection: EditorSelection.cursor(5) });
      (view as any).state = selTr.state;

      // Normal cursor movement with default nearest strategy
      view.coordsAtPos = () => ({ left: 200, right: 200, top: 150, bottom: 170 });
      const range = EditorSelection.cursor(5);
      const handled = handleScrollIntoView(view, range, { x: "nearest", y: "nearest" });
      expect(handled).toBe(true);
      flushMeasure();

      // Already in viewport: scrollLeft does not change
      expect(scrollDOM.scrollLeft).toBe(0);
      plugin.destroy();
    });

    describe("Search navigation windowed candidate switching regression (2026-10-27)", () => {
      it("keeps pending search arrival when geometryChanged occurs with heightChanged: false", () => {
        const { view, plugin, scrollDOM, flushMeasure } = createMockHarness({ hasFocus: false });
        const startState = view.state;
        const tr = startState.update({
          selection: EditorSelection.single(10, 15),
          annotations: searchMotionAnnotation.of(true),
          effects: EditorView.scrollIntoView(10, { y: "center", x: "center" }),
          userEvent: "select.search",
        });
        (view as any).state = tr.state;

        // 1. Search transaction dispatches and arms pendingSearchScroll
        plugin.update({
          docChanged: false,
          geometryChanged: false,
          selectionSet: true,
          transactions: [tr],
          startState,
          state: tr.state,
          view,
        } as any);

        // 2. CM measures layout in windowed mode (horizontal scrollbar toggle / clientWidth check):
        // geometryChanged is true, BUT heightChanged is false. Must NOT cancel pendingSearchScroll!
        plugin.update({
          docChanged: false,
          geometryChanged: true,
          heightChanged: false,
          viewportChanged: true,
          selectionSet: false,
          transactions: [],
          startState: tr.state,
          state: tr.state,
          view,
        } as any);

        view.coordsAtPos = () => ({ left: 100, right: 120, top: 500, bottom: 520 });
        expect(handleScrollIntoView(view, EditorSelection.cursor(10), { y: "center", x: "center" })).toBe(true);
        flushMeasure();

        // Viewport smoothly follows to destination
        vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs / 2);
        expect(scrollDOM.scrollTop).toBeGreaterThan(100);
        expect(scrollDOM.scrollTop).toBeLessThan(410);
        vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs);
        expect(scrollDOM.scrollTop).toBe(410);
        plugin.destroy();
      });

      it("allows consecutive search jumps in windowed mode without entering stuck state", () => {
        const { view, plugin, scrollDOM, flushMeasure } = createMockHarness({ hasFocus: false });
        const doc = "word ".repeat(100);
        (view as any).state = EditorState.create({ doc });

        const targets = [
          { from: 10, to: 14, top: 400 },
          { from: 50, to: 54, top: 800 },
          { from: 90, to: 94, top: 1200 },
        ];

        for (const target of targets) {
          const startState = view.state;
          const tr = startState.update({
            selection: EditorSelection.single(target.from, target.to),
            annotations: searchMotionAnnotation.of(true),
            effects: EditorView.scrollIntoView(target.from, { y: "center", x: "center" }),
            userEvent: "select.search",
          });
          (view as any).state = tr.state;

          plugin.update({
            docChanged: false,
            geometryChanged: false,
            selectionSet: true,
            transactions: [tr],
            startState,
            state: tr.state,
            view,
          } as any);

          // Windowed mode geometry updates between clicks
          plugin.update({
            docChanged: false,
            geometryChanged: true,
            heightChanged: false,
            viewportChanged: true,
            selectionSet: false,
            transactions: [],
            startState: tr.state,
            state: tr.state,
            view,
          } as any);

          view.coordsAtPos = () => ({
            left: 100,
            right: 120,
            top: target.top - scrollDOM.scrollTop,
            bottom: target.top - scrollDOM.scrollTop + 20,
          });

          expect(
            handleScrollIntoView(view, EditorSelection.cursor(target.from), { y: "center", x: "center" }),
          ).toBe(true);
          flushMeasure();

          vi.advanceTimersByTime(MOTION_CONFIG.scrollDurationMs + 50);
          const expectedTop = Math.min(
            target.top + 10 - scrollDOM.clientHeight / 2,
            scrollDOM.scrollHeight - scrollDOM.clientHeight,
          );
          expect(scrollDOM.scrollTop).toBeCloseTo(expectedTop, 0);
        }

        plugin.destroy();
      });

      it("executes horizontal follow-up without session drop when animation is disabled", () => {
        setReducedMotionForTesting(true);
        try {
          const {
            view,
            plugin,
            scrollDOM,
            flushMeasureOnce,
            setAutoFlushMeasure,
          } = createMockHarness({ hasFocus: false });
          setAutoFlushMeasure(false);
          const startState = view.state;
          const tr = startState.update({
            selection: EditorSelection.single(20, 25),
            annotations: searchMotionAnnotation.of(true),
            effects: EditorView.scrollIntoView(20, { y: "center", x: "center" }),
            userEvent: "select.search",
          });
          (view as any).state = tr.state;

          plugin.update({
            docChanged: false,
            geometryChanged: false,
            selectionSet: true,
            transactions: [tr],
            startState,
            state: tr.state,
            view,
          } as any);

          let rendered = false;
          view.coordsAtPos = () => {
            if (!rendered) return null;
            return { left: 900, right: 950, top: 400, bottom: 420 };
          };
          (view as any).lineBlockAt = vi.fn(() => ({ from: 20, to: 25, top: 400, height: 20 }));

          expect(
            handleScrollIntoView(view, EditorSelection.range(20, 25), { y: "center", x: "center" }),
          ).toBe(true);
          flushMeasureOnce();

          // Immediate vertical jump happened
          expect(scrollDOM.scrollTop).toBe(200);

          // Followup renders line in a later measure cycle and applies horizontal center.
          rendered = true;
          flushMeasureOnce();
          expect(scrollDOM.scrollLeft).toBeGreaterThan(0);
          plugin.destroy();
        } finally {
          setReducedMotionForTesting(false);
        }
      });
    });
  });
});
