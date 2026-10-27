/**
 * Smooth Caret and Viewport Follow Motion (012 Caret Enhancement, specs/012 §5-§7).
 *
 * Implements lightweight visual-only transitions:
 * - Smooth caret gliding (150ms navigation / 120ms edits, cubic-bezier(0.22, 0.61, 0.36, 1)) for short keyboard navigation, plain
 *   single left-clicks, pure Shift-clicks to expand/shorten/reverse selection, explicit short search navigation, plain text typing /
 *   selection replacement / Enter newlines, short deletes/pastes, and Chinese IME pre-edit and commit.
 * - Smooth viewport following (180ms easeOutCubic) for keyboard scroll-into-view and
 *   explicit search navigation arrival (selectNearestMatch, findNext, findPrevious, replaceNext).
 *   (mouse clicks do not trigger viewport scroll animation).
 *
 * CodeMirror remains the sole authority for live document text, selection, history,
 * and navigation targets. All animations are strictly visual and degrade gracefully:
 * - Cancelled immediately on cuts, history replay, mouse drags/double-clicks/gestures,
 *   IME composition cancel (Esc), blur, tab switch, reload, or user manual scroll.
 * - Degraded to instant positioning for large jumps (> 2500px or > 5 lines / 500 chars for
 *   keyboard nav; search arrival uses direct near-jump + bounded 180ms tail finish),
 *   cursor count changes or high cursor counts (> 10), or documents above the
 *   hard caps (200,000 lines / 10,000,000 UTF-16 units).
 * - Governed by a single application preference switch (UiPreferences.editorMotion)
 *   with priority given to system prefers-reduced-motion.
 */

import { Annotation, EditorState, Transaction, type Extension, type SelectionRange } from "@codemirror/state";
import { Direction, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** Active cleanups invoked when animations are cancelled globally. */
const activeCleanups = new Set<() => void>();

let editorMotionPreference = true;
let prefersReducedMotion = false;

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
  prefersReducedMotion = mql.matches;
  mql.addEventListener?.("change", (e) => {
    prefersReducedMotion = e.matches;
    if (prefersReducedMotion) {
      cancelAllActiveMotion();
    }
  });
}

/** Whether the system currently requests reduced motion. */
export function isReducedMotionActive(): boolean {
  return prefersReducedMotion;
}

/** Sets the mock/live reduced motion state (primarily for tests). */
export function setReducedMotionForTesting(reduced: boolean): void {
  prefersReducedMotion = reduced;
  if (reduced) {
    cancelAllActiveMotion();
  }
}

/** Whether the user preference for editor motion is enabled. */
export function isEditorMotionEnabled(): boolean {
  return editorMotionPreference;
}

/** Enables or disables editor motion application-wide. */
export function setEditorMotionEnabled(enabled: boolean): void {
  if (editorMotionPreference === enabled) {
    return;
  }
  editorMotionPreference = enabled;
  if (!enabled) {
    cancelAllActiveMotion();
  }
}

/** Whether smooth visual motion should currently be active. */
export function isMotionActive(): boolean {
  return editorMotionPreference && !prefersReducedMotion;
}

/** Cancels all currently executing animations and cleans up DOM visual classes. */
export function cancelAllActiveMotion(): void {
  for (const cleanup of activeCleanups) {
    try {
      cleanup();
    } catch {
      // Ignore cleanup errors during teardown
    }
  }
}

/** Navigation keys eligible for smooth caret and viewport motion. */
export const NAV_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

/**
 * Annotation marking a transaction as an explicit search navigation / arrival request
 * (selectNearestMatch, findNext, findPrevious, replaceNext).
 */
export const searchMotionAnnotation = Annotation.define<boolean>();

/** Thresholds for degradation and animation parameters. */
export const MOTION_CONFIG = {
  caretDurationMs: 150,
  caretTimeoutMs: 190,
  editCaretDurationMs: 120,
  editCaretTimeoutMs: 160,
  scrollDurationMs: 180,
  maxAnimDistancePx: 2500,
  maxCaretCharDist: 500,
  maxCaretLineDist: 5,
  maxCursorCount: 10,
  maxMotionDocLines: 200000,
  maxMotionDocLength: 10000000,
  maxDocLines: 50000,
  keyNavRecentWindowMs: 300,
} as const;

/** Hard cap for all motion; both document metrics are available without scanning text. */
export function isDocumentMotionAllowed(doc: { lines: number; length: number }): boolean {
  return doc.lines <= MOTION_CONFIG.maxMotionDocLines && doc.length <= MOTION_CONFIG.maxMotionDocLength;
}

/** Cubic easing for viewport scroll: decelerates smoothly to the destination. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Decides whether a selection update is eligible for smooth visual caret transition.
 */
export function shouldAnimateCaret(params: {
  isMotionActive: boolean;
  isComposing: boolean;
  docChanged: boolean;
  pointerDown: boolean;
  isRecentKeyNav: boolean;
  oldRangesCount: number;
  newRangesCount: number;
  charDist: number;
  lineDist: number;
}): boolean {
  if (!params.isMotionActive || params.isComposing || params.docChanged) {
    return false;
  }
  if (params.pointerDown || !params.isRecentKeyNav) {
    return false;
  }
  if (
    params.oldRangesCount !== params.newRangesCount ||
    params.newRangesCount > MOTION_CONFIG.maxCursorCount
  ) {
    return false;
  }
  if (params.charDist <= 0 || params.charDist > MOTION_CONFIG.maxCaretCharDist) {
    return false;
  }
  if (params.lineDist > MOTION_CONFIG.maxCaretLineDist) {
    return false;
  }
  return true;
}

/**
 * Decides whether a mouse click selection update is eligible for smooth visual caret transition.
 */
export function shouldAnimatePointerClick(params: {
  isMotionActive: boolean;
  isComposing: boolean;
  docChanged: boolean;
  hasClickCandidate: boolean;
  oldRanges: readonly SelectionRange[];
  newRanges: readonly SelectionRange[];
  charDist: number;
  lineDist: number;
  candidateOldHead?: number;
  candidateTargetPos?: number;
  isOldVisible?: boolean;
  isNewVisible?: boolean;
  isShift?: boolean;
}): boolean {
  if (
    !params.isMotionActive ||
    params.isComposing ||
    params.docChanged ||
    !params.hasClickCandidate
  ) {
    return false;
  }
  if (params.oldRanges.length !== 1 || params.newRanges.length !== 1) {
    return false;
  }
  if (params.isShift) {
    // Pure Shift click allows starting from empty or non-empty single range,
    // and ending in empty or non-empty single range.
  } else {
    // Plain click requires single collapsed caret on both sides of transition.
    if (!params.oldRanges[0].empty || !params.newRanges[0].empty) {
      return false;
    }
  }
  if (
    params.candidateOldHead !== undefined &&
    params.oldRanges[0].head !== params.candidateOldHead
  ) {
    return false;
  }
  if (
    params.candidateTargetPos !== undefined &&
    params.newRanges[0].head !== params.candidateTargetPos
  ) {
    return false;
  }
  if (params.charDist <= 0 || params.charDist > MOTION_CONFIG.maxCaretCharDist) {
    return false;
  }
  if (params.lineDist > MOTION_CONFIG.maxCaretLineDist) {
    return false;
  }
  if (params.isOldVisible === false || params.isNewVisible === false) {
    return false;
  }
  return true;
}

/**
 * Decides whether a mouse drag selection update is eligible for smooth visual caret transition
 * on its active endpoint.
 */
export function shouldAnimatePointerDrag(params: {
  isMotionActive: boolean;
  isComposing: boolean;
  docChanged: boolean;
  pointerDown: boolean;
  isDragging: boolean;
  isNonMousePointer: boolean;
  oldRangesCount: number;
  newRangesCount: number;
  charDist: number;
  lineDist: number;
}): boolean {
  if (
    !params.isMotionActive ||
    params.isComposing ||
    params.docChanged ||
    !params.pointerDown ||
    !params.isDragging ||
    params.isNonMousePointer
  ) {
    return false;
  }
  if (
    params.oldRangesCount !== params.newRangesCount ||
    params.newRangesCount > MOTION_CONFIG.maxCursorCount
  ) {
    return false;
  }
  if (params.charDist <= 0 || params.charDist > MOTION_CONFIG.maxCaretCharDist) {
    return false;
  }
  if (params.lineDist > MOTION_CONFIG.maxCaretLineDist) {
    return false;
  }
  return true;
}

/**
 * Decides whether a smart selection expand/shrink update is eligible for smooth visual caret transition.
 */
export function shouldAnimateSelectionExpandShrink(params: {
  isMotionActive: boolean;
  isComposing: boolean;
  docChanged: boolean;
  oldRangesCount: number;
  newRangesCount: number;
  charDist: number;
  lineDist: number;
}): boolean {
  if (!params.isMotionActive || params.isComposing || params.docChanged) {
    return false;
  }
  if (
    params.oldRangesCount !== params.newRangesCount ||
    params.newRangesCount > MOTION_CONFIG.maxCursorCount
  ) {
    return false;
  }
  if (params.charDist <= 0 || params.charDist > MOTION_CONFIG.maxCaretCharDist) {
    return false;
  }
  if (params.lineDist > MOTION_CONFIG.maxCaretLineDist) {
    return false;
  }
  return true;
}

export function isNormalTypingInputType(inputType: string | undefined): boolean {
  if (!inputType) {
    return false;
  }
  return (
    inputType === "insertText" ||
    inputType === "insertLineBreak" ||
    inputType === "insertParagraph" ||
    inputType === "insertReplacementText" ||
    inputType === "insertCompositionText"
  );
}

export function shouldAnimateTyping(params: {
  isMotionActive: boolean;
  isComposing?: boolean;
  pointerDown: boolean;
  oldRanges: readonly SelectionRange[];
  newRanges: readonly SelectionRange[];
  charDist: number;
  lineDist: number;
  isConfirmedImeCommit?: boolean;
  hasExcludedUserEvent: boolean;
  hasAllowedUserEvent: boolean;
}): boolean {
  if (!params.isMotionActive || params.pointerDown) {
    return false;
  }
  if (params.hasExcludedUserEvent || !params.hasAllowedUserEvent) {
    return false;
  }
  if (
    params.oldRanges.length !== params.newRanges.length ||
    params.newRanges.length > MOTION_CONFIG.maxCursorCount
  ) {
    return false;
  }
  if (!params.newRanges.every((r) => r.empty)) {
    return false;
  }
  // An equal document offset can still move on screen after text replacement
  // (for example "ni" -> "你好"). Let CSS decide whether the measured endpoint
  // actually changed, instead of cancelling an in-flight transition here.
  if (params.charDist > MOTION_CONFIG.maxCaretCharDist) {
    return false;
  }
  for (let i = 0; i < params.newRanges.length; i++) {
    const o = params.oldRanges[i];
    const n = params.newRanges[i];
    const d = Math.abs(n.head - o.head);
    if (d > MOTION_CONFIG.maxCaretCharDist) {
      return false;
    }
  }
  if (params.lineDist > MOTION_CONFIG.maxCaretLineDist) {
    return false;
  }
  return true;
}

/**
 * Calculates vertical distance (moveY) needed to bring target rect into view.
 */
export function computeScrollMoveY(params: {
  yStrategy: string;
  rect: { top: number; bottom: number };
  bounding: { top: number; bottom: number };
  yMargin: number;
  side: number;
}): number {
  const { yStrategy, rect, bounding, yMargin, side } = params;
  if (yStrategy === "nearest") {
    if (rect.top < bounding.top + yMargin) {
      let moveY = rect.top - (bounding.top + yMargin);
      if (side > 0 && rect.bottom > bounding.bottom + moveY) {
        moveY = rect.bottom - bounding.bottom + yMargin;
      }
      return moveY;
    } else if (rect.bottom > bounding.bottom - yMargin) {
      let moveY = rect.bottom - bounding.bottom + yMargin;
      if (side < 0 && rect.top - moveY < bounding.top) {
        moveY = rect.top - (bounding.top + yMargin);
      }
      return moveY;
    }
    return 0;
  } else {
    const rectHeight = rect.bottom - rect.top;
    const boundingHeight = bounding.bottom - bounding.top;
    const targetTop =
      yStrategy === "center" && rectHeight <= boundingHeight
        ? rect.top + rectHeight / 2 - boundingHeight / 2
        : yStrategy === "start" || (yStrategy === "center" && side < 0)
          ? rect.top - yMargin
          : rect.bottom - boundingHeight + yMargin;
    return targetTop - bounding.top;
  }
}

/**
 * Calculates horizontal distance (moveX) needed to bring target rect into view.
 */
export function computeScrollMoveX(params: {
  xStrategy: string;
  rect: { left: number; right: number };
  bounding: { left: number; right: number };
  xMargin: number;
  side: number;
  ltr: boolean;
}): number {
  const { xStrategy, rect, bounding, xMargin, side, ltr } = params;
  if (xStrategy === "nearest") {
    if (rect.left < bounding.left + xMargin) {
      let moveX = rect.left - (bounding.left + xMargin);
      if (side > 0 && rect.right > bounding.right + moveX) {
        moveX = rect.right - bounding.right + xMargin;
      }
      return moveX;
    } else if (rect.right > bounding.right - xMargin) {
      let moveX = rect.right - bounding.right + xMargin;
      if (side < 0 && rect.left < bounding.left + moveX) {
        moveX = rect.left - (bounding.left + xMargin);
      }
      return moveX;
    }
    return 0;
  } else {
    const rectWidth = rect.right - rect.left;
    const boundingWidth = bounding.right - bounding.left;
    const targetLeft =
      xStrategy === "center"
        ? rectWidth <= boundingWidth
          ? rect.left + rectWidth / 2 - boundingWidth / 2
          : ltr
            ? rect.left - xMargin
            : rect.right - boundingWidth + xMargin
        : (xStrategy === "start") === ltr
          ? rect.left - xMargin
          : rect.right - boundingWidth + xMargin;
    return targetLeft - bounding.left;
  }
}

/**
 * Calculates target scrollLeft clamped to horizontal scrollable bounds.
 */
export function computeTargetScrollLeft(
  startLeft: number,
  moveX: number,
  scrollWidth?: number,
  clientWidth?: number,
): number {
  if (
    typeof scrollWidth === "number" &&
    typeof clientWidth === "number" &&
    scrollWidth > clientWidth
  ) {
    const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
    return Math.max(0, Math.min(startLeft + moveX, maxScrollLeft));
  }
  return startLeft + moveX;
}


/**
 * Calculates target scrollTop clamped to scrollable bounds.
 */
export function computeTargetScrollTop(
  startTop: number,
  moveY: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  return Math.max(0, Math.min(startTop + moveY, maxScrollTop));
}

/**
 * Decides whether viewport scroll should animate or fallback to native instant scroll.
 */
export function shouldAnimateViewportScroll(params: {
  isMotionActive: boolean;
  isRecentKeyNav: boolean;
  isMainSelection: boolean;
  docLines: number;
  hasCoords: boolean;
  moveY: number;
}): boolean {
  if (!params.isMotionActive || !params.isRecentKeyNav || !params.isMainSelection) {
    return false;
  }
  if (params.docLines > MOTION_CONFIG.maxDocLines) {
    return false;
  }
  if (!params.hasCoords) {
    return false;
  }
  if (Math.abs(params.moveY) < 1) {
    return false;
  }
  if (Math.abs(params.moveY) > MOTION_CONFIG.maxAnimDistancePx) {
    return false;
  }
  return true;
}

/**
 * Reads effective scrollMargins from CodeMirror's scrollMargins facet.
 * CodeMirror computes effective margins by taking Math.max across all margin sources.
 */
export function getScrollMargins(view: EditorView): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  try {
    for (const source of view.state.facet(EditorView.scrollMargins)) {
      const m = source(view);
      if (m) {
        if (m.left != null) left = Math.max(left, m.left);
        if (m.right != null) right = Math.max(right, m.right);
        if (m.top != null) top = Math.max(top, m.top);
        if (m.bottom != null) bottom = Math.max(bottom, m.bottom);
      }
    }
  } catch {
    // If facet reading fails, return zero margins safely
  }
  return { left, right, top, bottom };
}

/**
 * Checks whether the editor view has non-zero vertical scroll margins (e.g. top/bottom panels).
 * Vertical panel margins fall back to native CodeMirror scrolling, while normal horizontal
 * gutter margins (line numbers) remain animated.
 */
export function hasVerticalScrollMargins(view: EditorView): boolean {
  try {
    const margins = getScrollMargins(view);
    return margins.top > 0 || margins.bottom > 0;
  } catch {
    return true;
  }
}

/** Alias for backward compatibility if imported elsewhere. */
export const hasCustomScrollMargins = hasVerticalScrollMargins;

/**
 * Calculates the visible content viewport bounds of the editor's scroll container,
 * taking into account gutter occlusions (margins.left/right) and scrollbar lanes.
 */
export function getVisibleViewportBounds(view: EditorView): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} | null {
  const scrollDOM = view.scrollDOM;
  if (!scrollDOM || typeof scrollDOM.getBoundingClientRect !== "function") {
    return null;
  }
  const scrollerRect = scrollDOM.getBoundingClientRect();
  if (!scrollerRect || scrollerRect.width <= 0 || scrollerRect.height <= 0) {
    return null;
  }

  const margins = getScrollMargins(view);

  // clientWidth / clientHeight exclude native scrollbar lanes
  const clientW =
    typeof scrollDOM.clientWidth === "number" && scrollDOM.clientWidth > 0
      ? scrollDOM.clientWidth
      : scrollerRect.width;
  const clientH =
    typeof scrollDOM.clientHeight === "number" && scrollDOM.clientHeight > 0
      ? scrollDOM.clientHeight
      : scrollerRect.height;

  const left = scrollerRect.left + margins.left;
  const right = scrollerRect.left + clientW - margins.right;
  const top = scrollerRect.top + margins.top;
  const bottom = scrollerRect.top + clientH - margins.bottom;

  if (right <= left || bottom <= top) {
    return null;
  }

  return { left, right, top, bottom };
}

/**
 * Checks whether given coordinates (e.g. from coordsAtPos) are completely within
 * the visible viewport bounds (both horizontally and vertically).
 */
export function isCoordsInVisibleViewport(
  coords: { left: number; right: number; top: number; bottom: number },
  bounds: { left: number; right: number; top: number; bottom: number },
): boolean {
  const EPSILON = 0.5;
  return (
    coords.left >= bounds.left - EPSILON &&
    coords.right <= bounds.right + EPSILON &&
    coords.top >= bounds.top - EPSILON &&
    coords.bottom <= bounds.bottom + EPSILON
  );
}

/**
 * Checks whether the editor view has CSS transform or zoom scaling applied.
 * Uses CodeMirror's authoritative scaleX and scaleY properties (or offset dimensions)
 * rather than clientWidth, which incorrectly flags normal 12px scrollbar lanes as scaling.
 */
export function hasTransformScale(
  viewOrEl: EditorView | HTMLElement,
  curRect?: { width: number; height: number },
): boolean {
  try {
    if ("scaleX" in viewOrEl && typeof viewOrEl.scaleX === "number") {
      const scaleX = viewOrEl.scaleX;
      const scaleY = typeof viewOrEl.scaleY === "number" ? viewOrEl.scaleY : 1;
      if (Math.abs(scaleX - 1) > 0.02 || Math.abs(scaleY - 1) > 0.02) {
        return true;
      }
    }
    const scrollDOM = "scrollDOM" in viewOrEl ? viewOrEl.scrollDOM : viewOrEl;
    if (scrollDOM) {
      const rect =
        curRect ??
        (typeof scrollDOM.getBoundingClientRect === "function"
          ? scrollDOM.getBoundingClientRect()
          : null);
      if (rect) {
        const offsetW =
          (scrollDOM as HTMLElement).offsetWidth > 0
            ? (scrollDOM as HTMLElement).offsetWidth
            : (scrollDOM as HTMLElement).clientWidth;
        const offsetH =
          (scrollDOM as HTMLElement).offsetHeight > 0
            ? (scrollDOM as HTMLElement).offsetHeight
            : (scrollDOM as HTMLElement).clientHeight;
        if (offsetW > 0 && offsetH > 0) {
          const sx = rect.width / offsetW;
          const sy = rect.height / offsetH;
          if (Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02) {
            return true;
          }
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

export interface MeasuredTargetScroll {
  rect: { left: number; right: number; top: number; bottom: number } | null;
  fallbackTop: number | null;
  targetTop: number;
  moveX: number;
  needsHorizontalFollowup: boolean;
}

/**
 * Measures the layout coordinates and scroll targets for a search match.
 */
export function measureSearchTarget(
  v: EditorView,
  targetFrom: number,
  targetTo: number,
  options: {
    x?: "nearest" | "start" | "end" | "center";
    y?: "nearest" | "start" | "end" | "center";
    xMargin?: number;
    yMargin?: number;
  } = { y: "center", x: "center" },
): MeasuredTargetScroll | null {
  const scroller = v.scrollDOM;
  if (!scroller || scroller.clientHeight <= 0) return null;

  let headCoords = v.coordsAtPos(
    targetFrom,
    targetTo > targetFrom ? 1 : -1,
  );
  let anchorCoords = targetFrom === targetTo
    ? headCoords
    : v.coordsAtPos(targetTo, -1);

  let rect: { left: number; right: number; top: number; bottom: number } | null = null;
  if (headCoords && anchorCoords) {
    rect = {
      left: Math.min(headCoords.left, anchorCoords.left),
      top: Math.min(headCoords.top, anchorCoords.top),
      right: Math.max(headCoords.right, anchorCoords.right),
      bottom: Math.max(headCoords.bottom, anchorCoords.bottom),
    };
  } else if (headCoords) {
    rect = headCoords;
  } else if (anchorCoords) {
    rect = anchorCoords;
  }

  let fallbackTop: number | null = null;
  let needsHorizontalFollowup = false;
  if (!rect) {
    try {
      const block = v.lineBlockAt(targetFrom);
      fallbackTop = block.top;
      needsHorizontalFollowup = true;
    } catch {
      return null;
    }
  }

  const curRect = scroller.getBoundingClientRect();
  const margins = getScrollMargins(v);
  const startTop = scroller.scrollTop;

  let moveX = 0;
  let moveY = 0;
  let targetTop = startTop;

  if (rect) {
    const targetRect = {
      left: rect.left - margins.left,
      right: rect.right + margins.right,
      top: rect.top - margins.top,
      bottom: rect.bottom + margins.bottom,
    };

    const bounding = {
      left: curRect.left,
      right: curRect.left + scroller.clientWidth,
      top: curRect.top,
      bottom: curRect.top + scroller.clientHeight,
    };

    const side = 1;
    const yMargin = Math.max(
      Math.min(options.yMargin ?? 0, scroller.clientHeight),
      -scroller.clientHeight,
    );
    const yStrategy = options.y ?? "nearest";

    moveX = computeScrollMoveX({
      xStrategy: options.x ?? "nearest",
      rect: targetRect,
      bounding,
      xMargin: Math.max(
        Math.min(options.xMargin ?? 0, scroller.clientWidth),
        -scroller.clientWidth,
      ),
      side,
      ltr: true,
    });

    moveY = computeScrollMoveY({
      yStrategy,
      rect: targetRect,
      bounding,
      yMargin,
      side,
    });

    targetTop = computeTargetScrollTop(
      startTop,
      moveY,
      scroller.scrollHeight,
      scroller.clientHeight,
    );
  } else if (fallbackTop !== null) {
    const yStrategy = options.y ?? "nearest";
    const yMargin = Math.max(
      Math.min(options.yMargin ?? 0, scroller.clientHeight),
      -scroller.clientHeight,
    );
    const targetOffset =
      yStrategy === "center"
        ? fallbackTop - scroller.clientHeight / 2
        : yStrategy === "start"
          ? fallbackTop - yMargin
          : fallbackTop - scroller.clientHeight + yMargin;
    targetTop = Math.max(0, Math.min(targetOffset, scroller.scrollHeight - scroller.clientHeight));
  }

  return {
    rect,
    fallbackTop,
    targetTop,
    moveX,
    needsHorizontalFollowup,
  };
}

/**
 * ViewPlugin managing caret transition classes, user gesture tracking, and scroll animation.
 */
export class EditorMotionPluginValue {
  private lastKeyNavTime = 0;
  private pointerDown = false;
  private pointerDownPos: { clientX: number; clientY: number } | null = null;
  private isDragging = false;
  private isNonMousePointer = false;
  private isComposing = false;
  private lastCompositionCommit: {
    text: string;
    time: number;
  } | null = null;
  private pendingSearchScroll: {
    state: EditorState;
    targetFrom: number;
    targetTo: number;
    time: number;
  } | null = null;
  private cancelledSearchRequest: {
    state: EditorState;
    targetFrom: number;
    targetTo: number;
    time: number;
  } | null = null;
  private pendingClickCandidate: {
    oldHead: number;
    clientX: number;
    clientY: number;
    isShift: boolean;
    time: number;
  } | null = null;
  private caretSessionId = 0;
  private activeSearchScroll: {
    state: EditorState;
    targetFrom: number;
    targetTo: number;
    sessionId: number;
    time: number;
    layout: string | null;
    checkingLayout: boolean;
    options: {
      x?: "nearest" | "start" | "end" | "center";
      y?: "nearest" | "start" | "end" | "center";
      xMargin?: number;
      yMargin?: number;
    };
  } | null = null;
  private caretTimeout: ReturnType<typeof setTimeout> | null = null;
  private animFrameId: number | null = null;

  readonly onKeyDown = (e: KeyboardEvent) => {
    this.caretSessionId++;
    // IME composition key or composing status must NOT qualify as keyboard navigation
    if (e.isComposing || e.keyCode === 229 || this.view.composing) {
      this.lastKeyNavTime = 0;
      this.cancelScrollAnimation();
      this.cancelPendingSearchScroll();
      this.pendingClickCandidate = null;
      return;
    }
    if (NAV_KEYS.has(e.key)) {
      // Immediately cancel any previous running scroll animation before evaluating new nav
      this.cancelScrollAnimation();
      this.cancelPendingSearchScroll();
      this.lastKeyNavTime = Date.now();
    }
  };

  readonly onPointerDown = (e?: PointerEvent | MouseEvent) => {
    if (e && typeof (e as any).button === "number" && (e as any).button !== 0) {
      this.pointerDown = false;
      this.isDragging = false;
      this.pointerDownPos = null;
      this.pendingClickCandidate = null;
      return;
    }
    this.pointerDown = true;
    if (e && "pointerType" in e && e.pointerType && e.pointerType !== "mouse") {
      this.isNonMousePointer = true;
    } else {
      this.isNonMousePointer = false;
    }
    if (e && typeof (e as any).clientX === "number" && typeof (e as any).clientY === "number") {
      this.pointerDownPos = { clientX: (e as any).clientX, clientY: (e as any).clientY };
    } else {
      this.pointerDownPos = null;
    }
    this.isDragging = false;
    this.lastKeyNavTime = 0;
    this.cancelScrollAnimation();
    this.cancelCaretAnimation();
    this.cancelPendingSearchScroll();
  };

  readonly onMouseDown = (e: MouseEvent) => {
    // Clear any previous candidate before evaluating new gesture
    this.pendingClickCandidate = null;
    this.caretSessionId++;
    if (e.button !== 0) {
      this.pointerDown = false;
      this.isDragging = false;
      this.pointerDownPos = null;
      this.cancelCaretAnimation();
      return;
    }

    if (typeof e.clientX === "number" && typeof e.clientY === "number") {
      this.pointerDownPos = { clientX: e.clientX, clientY: e.clientY };
    }

    // Must be left-click with single click (detail === 1), no non-mouse pointer, not composing, motion enabled
    if (
      this.isNonMousePointer ||
      e.button !== 0 ||
      e.detail !== 1 ||
      this.isComposing ||
      this.view.composing ||
      !isMotionActive() ||
      !isDocumentMotionAllowed(this.view.state.doc)
    ) {
      this.cancelCaretAnimation();
      return;
    }

    // Ctrl, Alt, Meta are always excluded; only pure Shift or plain click is allowed
    if (e.ctrlKey || e.altKey || e.metaKey) {
      this.cancelCaretAnimation();
      return;
    }

    const isShift = Boolean(e.shiftKey);

    // Must be inside editor content DOM (not gutters or scrollbars)
    const content = this.view.contentDOM;
    if (content && e.target && typeof (content as any).contains === "function") {
      if (!content.contains(e.target as any)) {
        this.cancelCaretAnimation();
        return;
      }
    }

    // Single selection requirement:
    // Exactly one selection range must exist.
    // Plain click requires single empty cursor (curSelection.main.empty).
    // Pure Shift click allows either empty cursor or existing single selection range.
    const curSelection = this.view.state.selection;
    if (curSelection.ranges.length !== 1) {
      this.cancelCaretAnimation();
      return;
    }
    if (!isShift && !curSelection.main.empty) {
      this.cancelCaretAnimation();
      return;
    }
    const oldHead = curSelection.main.head;

    // Record candidate without forcing synchronous layout measurement or posAtCoords/coordsAtPos.
    // CodeMirror's native mousedown handler will compute the target and selection in its own
    // cycle; we validate transaction, distance, and visibility in update() and requestMeasure().
    this.pendingClickCandidate = {
      oldHead,
      clientX: e.clientX,
      clientY: e.clientY,
      isShift,
      time: Date.now(),
    };
  };

  readonly onPointerMove = (e: PointerEvent | MouseEvent) => {
    const clientX = (e as any)?.clientX;
    const clientY = (e as any)?.clientY;
    const startX = this.pointerDownPos?.clientX ?? this.pendingClickCandidate?.clientX;
    const startY = this.pointerDownPos?.clientY ?? this.pendingClickCandidate?.clientY;
    if (
      typeof clientX === "number" &&
      typeof clientY === "number" &&
      typeof startX === "number" &&
      typeof startY === "number"
    ) {
      const dx = clientX - startX;
      const dy = clientY - startY;
      if (Math.hypot(dx, dy) > 4) {
        if (!this.isDragging) this.caretSessionId++;
        this.isDragging = true;
        this.pendingClickCandidate = null;
      }
    } else if (this.pointerDown && !this.isNonMousePointer) {
      if (!this.isDragging) this.caretSessionId++;
      this.isDragging = true;
      this.pendingClickCandidate = null;
    }
  };

  readonly onPointerUp = () => {
    this.pointerDown = false;
    this.isDragging = false;
    this.pointerDownPos = null;
    this.isNonMousePointer = false;
    this.pendingClickCandidate = null;
  };

  readonly onCompositionStart = () => {
    this.caretSessionId++;
    this.isComposing = true;
    this.lastCompositionCommit = null;
    this.lastKeyNavTime = 0;
    this.cancelScrollAnimation();
    this.cancelPendingSearchScroll();
    this.pendingClickCandidate = null;
  };

  readonly onCompositionUpdate = () => {
    this.caretSessionId++;
    this.isComposing = true;
    this.lastCompositionCommit = null;
    this.lastKeyNavTime = 0;
    this.cancelScrollAnimation();
    this.cancelPendingSearchScroll();
    this.pendingClickCandidate = null;
  };

  readonly onCompositionEnd = (e?: CompositionEvent) => {
    this.isComposing = false;
    this.lastKeyNavTime = 0;
    const data = e?.data;
    if (typeof data === "string" && data.length > 0) {
      this.lastCompositionCommit = {
        text: data,
        time: Date.now(),
      };

      // A pre-end compose transaction has already armed its transition in update.
      // Keep it running; a post-end transaction uses the token above. Re-arming
      // here could undo a document-size or edit-size veto without a new edit.
    } else {
      this.lastCompositionCommit = null;
      this.cancelAll();
    }
  };

  readonly onEditIntent = (e?: Event) => {
    this.caretSessionId++;
    this.pendingClickCandidate = null;
    this.lastKeyNavTime = 0;
    this.cancelScrollAnimation();
    this.cancelPendingSearchScroll();

    // Preserve the current visual position for eligible edits; the transaction
    // still decides whether the actual change is small enough to animate.
    const inputType = (e as InputEvent | undefined)?.inputType;
    if (
      isNormalTypingInputType(inputType) ||
      inputType === "insertFromPaste" ||
      (inputType?.startsWith("delete") && inputType !== "deleteByCut" && inputType !== "deleteByDrag")
    ) {
      // Retain running caret transition class so CSS transition can smoothly
      // retarget from the current visual position without snapping between characters.
      return;
    }

    // For cuts, drops, undo/redo, or unknown/unspecified intents,
    // cancel caret animation immediately to ensure instant alignment.
    this.cancelCaretAnimation();
  };

  readonly onPasteOrCut = (e?: Event) => {
    this.caretSessionId++;
    this.lastKeyNavTime = 0;
    if (e?.type === "paste") {
      this.cancelScrollAnimation();
      this.cancelPendingSearchScroll();
      this.pendingClickCandidate = null;
      return;
    }
    this.cancelAll();
  };

  readonly onWheel = () => {
    // User manual scroll interrupts animation immediately without pulling back
    this.cancelScrollAnimation();
    this.cancelCaretAnimation();
    this.cancelPendingSearchScroll();
    this.pendingClickCandidate = null;
    this.lastKeyNavTime = 0;
  };

  readonly onTouchMove = () => {
    this.cancelScrollAnimation();
    this.cancelCaretAnimation();
    this.cancelPendingSearchScroll();
    this.lastKeyNavTime = 0;
  };

  readonly onScroll = () => {
    // If native or external scroll occurs (not driven by our active scroll animation RAF),
    // cancel caret animation to prevent caret from floating across the scrolled viewport.
    if (this.animFrameId === null) {
      this.cancelCaretAnimation();
    }
  };

  readonly onBlur = (e?: FocusEvent) => {
    this.lastKeyNavTime = 0;
    this.isComposing = false;
    this.lastCompositionCommit = null;
    this.pendingClickCandidate = null;
    this.isDragging = false;
    this.pointerDown = false;
    this.pointerDownPos = null;
    this.cancelCaretAnimation();

    // Check if focus moved to or is currently within the search bar
    const activeEl = typeof document !== "undefined" ? document.activeElement : null;
    const relatedEl = (e?.relatedTarget as Element | null) ?? null;
    const isFocusInSearchBar = Boolean(
      activeEl?.closest?.(".search-replace-bar") ||
      relatedEl?.closest?.(".search-replace-bar")
    );

    if (!isFocusInSearchBar) {
      this.cancelPendingSearchScroll();
      this.cancelScrollAnimation();
    } else if (isMotionActive() && !this.view.composing) {
      // Keep the native primary endpoint drawable while search owns focus.
      // Its existing position is the CSS transition's origin on the next match.
      this.view.dom?.classList?.add("cm-search-caret");
    }
  };

  private scrollSessionId = 0;

  constructor(readonly view: EditorView) {
    activeCleanups.add(this.cancelAll);

    const dom = view.dom;
    const scroller = view.scrollDOM;
    const content = view.contentDOM;

    if (dom && typeof dom.addEventListener === "function") {
      dom.addEventListener("keydown", this.onKeyDown, { capture: true });
      dom.addEventListener("pointerdown", this.onPointerDown as any, { capture: true });
      dom.addEventListener("mousedown", this.onMouseDown as any, { capture: true });
      dom.addEventListener("pointermove", this.onPointerMove as any, { passive: true });
      dom.addEventListener("compositionstart", this.onCompositionStart, { capture: true });
      dom.addEventListener("compositionupdate", this.onCompositionUpdate, { capture: true });
      dom.addEventListener("compositionend", this.onCompositionEnd as any, { capture: true });
      dom.addEventListener("beforeinput", this.onEditIntent, { capture: true });
      dom.addEventListener("paste", this.onPasteOrCut, { capture: true });
      dom.addEventListener("cut", this.onPasteOrCut, { capture: true });
    }

    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("pointermove", this.onPointerMove as any, { passive: true });
      window.addEventListener("pointerup", this.onPointerUp, { capture: true });
      window.addEventListener("pointercancel", this.onPointerUp, { capture: true });
      window.addEventListener("mouseup", this.onPointerUp, { capture: true });
    }

    if (scroller && typeof scroller.addEventListener === "function") {
      scroller.addEventListener("wheel", this.onWheel, { passive: true });
      scroller.addEventListener("touchmove", this.onTouchMove, { passive: true });
      scroller.addEventListener("scroll", this.onScroll, { passive: true });
    }

    if (content && typeof content.addEventListener === "function") {
      content.addEventListener("blur", this.onBlur);
    }
  }

  /** Whether pointer is currently down on the editor. */
  isPointerActive(): boolean {
    return this.pointerDown;
  }

  /** Whether the last navigation key occurred recently. */
  isRecentKeyNav(): boolean {
    return Date.now() - this.lastKeyNavTime < MOTION_CONFIG.keyNavRecentWindowMs;
  }

  /** Manually sets the last navigation key time (for testing/coordination). */
  setLastKeyNavTime(time: number): void {
    this.lastKeyNavTime = time;
  }

  /** Starts a smooth scrollTop animation from startTop to targetTop. */
  startScrollAnimation(startTop: number, targetTop: number, onComplete?: () => void): void {
    // The accepted search session owns both its queued measure and running RAF.
    // Starting the RAF must not discard the target that normal height updates use.
    if (this.activeSearchScroll?.sessionId !== this.scrollSessionId) {
      this.cancelScrollAnimation();
    } else if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    const sessionId = this.scrollSessionId;
    // Close active caret transition to avoid superposing caret flight with viewport scroll
    this.cancelCaretAnimation();

    if (typeof requestAnimationFrame !== "function") {
      if (this.view.scrollDOM) {
        this.view.scrollDOM.scrollTop = targetTop;
      }
      if (onComplete) onComplete();
      else this.clearActiveSearchScroll(sessionId);
      return;
    }

    const duration = MOTION_CONFIG.scrollDurationMs;
    const startTime = performance.now();

    const step = (now: number) => {
      if (sessionId !== this.scrollSessionId) return;
      const elapsed = now - startTime;
      const t = Math.min(1, Math.max(0, elapsed / duration));
      if (this.view.scrollDOM) {
        this.view.scrollDOM.scrollTop =
          startTop + (targetTop - startTop) * easeOutCubic(t);
      }
      if (t < 1) {
        this.animFrameId = requestAnimationFrame(step);
      } else {
        this.animFrameId = null;
        if (onComplete) onComplete();
        else this.clearActiveSearchScroll(sessionId);
      }
    };

    this.animFrameId = requestAnimationFrame(step);
  }

  /** Returns the current scroll session ID. */
  getScrollSessionId(): number {
    return this.scrollSessionId;
  }

  /** Starts a new scroll session and returns its ID. */
  nextScrollSession(): number {
    return ++this.scrollSessionId;
  }

  setActiveSearchScroll(
    state: EditorState,
    targetFrom: number,
    targetTo: number,
    sessionId: number,
    options: {
      x?: "nearest" | "start" | "end" | "center";
      y?: "nearest" | "start" | "end" | "center";
      xMargin?: number;
      yMargin?: number;
    } = { y: "center", x: "center" },
  ): void {
    this.activeSearchScroll = {
      state,
      targetFrom,
      targetTo,
      sessionId,
      time: Date.now(),
      layout: null,
      checkingLayout: false,
      options,
    };
  }

  clearActiveSearchScroll(sessionId?: number): void {
    if (sessionId === undefined || this.activeSearchScroll?.sessionId === sessionId) {
      this.activeSearchScroll = null;
    }
  }

  getActiveSearchScroll(): {
    state: EditorState;
    targetFrom: number;
    targetTo: number;
    sessionId: number;
    time: number;
    layout: string | null;
    checkingLayout: boolean;
    options: {
      x?: "nearest" | "start" | "end" | "center";
      y?: "nearest" | "start" | "end" | "center";
      xMargin?: number;
      yMargin?: number;
    };
  } | null {
    return this.activeSearchScroll;
  }

  private checkSearchScrollLayout(): void {
    const active = this.activeSearchScroll;
    // Before the initial read there is no old layout to invalidate. That read
    // will resolve the target against the current, stabilized CM viewport.
    if (!active || active.layout === null || active.checkingLayout) return;
    active.checkingLayout = true;
    this.view.requestMeasure({
      key: SCROLL_LAYOUT_MEASURE_KEY,
      read: view => {
        if (this.activeSearchScroll !== active || active.sessionId !== this.scrollSessionId) {
          return null;
        }
        const currentLayout = scrollLayout(view);
        if (currentLayout === active.layout) {
          return { unchanged: true, newLayout: currentLayout, targetTop: 0, moveX: 0 };
        }
        const measured = measureSearchTarget(
          view,
          active.targetFrom,
          active.targetTo,
          active.options,
        );
        if (!measured) {
          return null;
        }
        return {
          unchanged: false,
          newLayout: currentLayout,
          targetTop: measured.targetTop,
          moveX: measured.moveX,
        };
      },
      write: (result, view) => {
        active.checkingLayout = false;
        if (!result || this.activeSearchScroll !== active || active.sessionId !== this.scrollSessionId) {
          return;
        }
        if (result.unchanged) return;
        active.layout = result.newLayout;

        const scroller = view.scrollDOM;
        if (!scroller) return;

        if (Math.abs(result.moveX) >= 1) {
          const targetLeft = computeTargetScrollLeft(
            scroller.scrollLeft,
            result.moveX,
            scroller.scrollWidth,
            scroller.clientWidth,
          );
          scroller.scrollLeft = targetLeft;
        }

        if (this.hasActiveScrollAnimation()) {
          this.startScrollAnimation(scroller.scrollTop, result.targetTop);
        } else {
          scroller.scrollTop = result.targetTop;
        }
      },
    });
  }

  /** Whether a viewport scroll animation is actively running. */
  hasActiveScrollAnimation(): boolean {
    return this.animFrameId !== null;
  }

  /** Cancels any active viewport scroll animation and invalidates pending measurements. */
  cancelScrollAnimation = (): void => {
    this.scrollSessionId++;
    this.activeSearchScroll = null;
    if (this.animFrameId !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.animFrameId);
      }
      this.animFrameId = null;
    }
  };

  /** Cancels caret visual transition and clears timeout. */
  cancelCaretAnimation = (): void => {
    this.caretSessionId++;
    if (this.caretTimeout !== null) {
      clearTimeout(this.caretTimeout);
      this.caretTimeout = null;
    }
    this.view.dom?.classList?.remove("cm-smooth-caret");
    this.view.dom?.classList?.remove("cm-smooth-edit");
    this.view.dom?.classList?.remove("cm-search-caret");
  };

  /** Edits use a shorter transition than navigation, with the same easing. */
  armCaretTransition(kind: "edit" | "move" = "move"): void {
    if (kind === "edit") {
      this.view.dom?.classList?.add("cm-smooth-edit");
    } else {
      this.view.dom?.classList?.remove("cm-smooth-edit");
    }
    this.view.dom?.classList?.add("cm-smooth-caret");
    if (this.caretTimeout !== null) {
      clearTimeout(this.caretTimeout);
    }
    this.caretTimeout = setTimeout(() => {
      this.view.dom?.classList?.remove("cm-smooth-caret");
      this.view.dom?.classList?.remove("cm-smooth-edit");
      this.caretTimeout = null;
    }, kind === "edit" ? MOTION_CONFIG.editCaretTimeoutMs : MOTION_CONFIG.caretTimeoutMs);
  }

  /** Cancels both caret and scroll animations. */
  cancelAll = (): void => {
    this.cancelScrollAnimation();
    this.cancelCaretAnimation();
    this.pendingClickCandidate = null;
    this.cancelPendingSearchScroll();
    this.isDragging = false;
    this.pointerDownPos = null;
  };

  private cancelPendingSearchScroll(): void {
    if (this.pendingSearchScroll !== null) {
      this.cancelledSearchRequest = this.pendingSearchScroll;
      this.pendingSearchScroll = null;
    }
  }

  /**
   * Consumes and clears any pending search scroll request if matching state and target.
   * Strictly single-use to prevent stale or unrelated scrolls from animating.
   */
  consumeSearchScroll(view: EditorView, range: SelectionRange): boolean {
    if (this.pendingSearchScroll === null) {
      return false;
    }
    const pending = this.pendingSearchScroll;
    this.pendingSearchScroll = null;

    if (Date.now() - pending.time >= 1000) {
      return false;
    }
    if (view.state !== pending.state) {
      return false;
    }
    const main = view.state.selection.main;
    if (main.from !== pending.targetFrom || main.to !== pending.targetTo) {
      return false;
    }

    const matchesTarget =
      (range.head === pending.targetFrom && range.anchor === pending.targetFrom) ||
      (range.from === pending.targetFrom && range.to === pending.targetTo);
    return matchesTarget;
  }

  /**
   * Consumes an explicitly cancelled search scroll request to prevent CodeMirror's
   * default scroll fallback from snapping the viewport to the cancelled target.
   */
  consumeCancelledSearchScroll(_view: EditorView, range: SelectionRange): boolean {
    if (this.cancelledSearchRequest === null) {
      return false;
    }
    const cancelled = this.cancelledSearchRequest;
    this.cancelledSearchRequest = null;

    if (Date.now() - cancelled.time >= 1000) {
      return false;
    }

    const matchesTarget =
      range.head === cancelled.targetFrom ||
      (range.from <= cancelled.targetTo && range.to >= cancelled.targetFrom) ||
      Math.abs(range.head - cancelled.targetFrom) <= 50;
    return matchesTarget;
  }

  update(update: ViewUpdate): void {
    // Invalidate optional click checks even when a transaction keeps the same
    // head (effects/reconfigure/typing), before another visual path can arm.
    if (update.selectionSet || update.docChanged || update.transactions.length || update.state !== update.startState) {
      this.caretSessionId++;
    }
    const isSearchTx = update.transactions.some(
      (tr) =>
        (typeof tr.annotation === "function" && tr.annotation(searchMotionAnnotation) === true) ||
        (typeof tr.isUserEvent === "function" && tr.isUserEvent("select.search")),
    );
    if (this.activeSearchScroll) {
      const isStateReplaced = !update.transactions.length && update.startState !== update.state;
      if (
        update.docChanged ||
        (update.selectionSet && !isSearchTx) ||
        update.state.doc !== this.activeSearchScroll.state.doc ||
        isStateReplaced
      ) {
        this.cancelScrollAnimation();
      } else {
        this.activeSearchScroll.state = update.state;
      }
    }
    if (!isDocumentMotionAllowed(update.state.doc)) {
      this.lastKeyNavTime = 0;
      this.lastCompositionCommit = null;
      this.cancelAll();
      return;
    }
    if (update.docChanged) {
      this.lastKeyNavTime = 0;
      this.pendingClickCandidate = null;

      const isSearchTx = update.transactions.some(
        (tr) =>
          (typeof tr.annotation === "function" && tr.annotation(searchMotionAnnotation) === true) ||
          (typeof tr.isUserEvent === "function" && tr.isUserEvent("select.search")),
      );

      if (isSearchTx) {
        // Search replacement transaction (replaceNext): snap caret visual, schedule search scroll
        this.cancelCaretAnimation();
        this.cancelScrollAnimation();
        this.cancelledSearchRequest = null;
        this.pendingSearchScroll = {
          state: update.state,
          targetFrom: update.state.selection.main.from,
          targetTo: update.state.selection.main.to,
          time: Date.now(),
        };
        return;
      }

      this.cancelPendingSearchScroll();

      const isDelete = update.transactions.some(
        (tr) => typeof tr.isUserEvent === "function" && tr.isUserEvent("delete"),
      );
      const isCut = update.transactions.some(
        (tr) => typeof tr.isUserEvent === "function" && tr.isUserEvent("delete.cut"),
      );
      const isPaste = update.transactions.some(
        (tr) => typeof tr.isUserEvent === "function" && tr.isUserEvent("input.paste"),
      );
      const isDrop = update.transactions.some(
        (tr) =>
          typeof tr.isUserEvent === "function" &&
          (tr.isUserEvent("input.drop") || tr.isUserEvent("move.drop")),
      );
      const isUndoRedo = update.transactions.some(
        (tr) =>
          typeof tr.isUserEvent === "function" &&
          (tr.isUserEvent("undo") || tr.isUserEvent("redo")),
      );
      const hasSearch = update.transactions.some(
        (tr) =>
          typeof tr.isUserEvent === "function" && tr.isUserEvent("select.search"),
      );

      const hasExcludedUserEvent =
        isCut || isDrop || isUndoRedo || hasSearch;
      if (hasExcludedUserEvent) {
        this.lastCompositionCommit = null;
        this.cancelAll();
        return;
      }

      let hasCommitTextMatch = false;
      let editTooLarge = false;
      const changes = update.changes ?? update.transactions.find((tr) => tr.changes)?.changes;
      changes?.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        if (editTooLarge) return;
        // Bound the edit itself too: a large replacement can leave the head at
        // exactly the same offset while changing all the content around it.
        if (
          Math.max(toA - fromA, inserted.length) > MOTION_CONFIG.maxCaretCharDist ||
          inserted.lines - 1 > MOTION_CONFIG.maxCaretLineDist ||
          update.startState.doc.lineAt(toA).number - update.startState.doc.lineAt(fromA).number > MOTION_CONFIG.maxCaretLineDist
        ) {
          editTooLarge = true;
          return;
        }
        const commitText = this.lastCompositionCommit?.text;
        if (commitText && inserted.length > 0 && inserted.toString().includes(commitText)) {
          hasCommitTextMatch = true;
        }
      });
      if (editTooLarge) {
        this.lastCompositionCommit = null;
        this.cancelAll();
        return;
      }

      const isRecentCommit =
        this.lastCompositionCommit !== null &&
        Date.now() - this.lastCompositionCommit.time < 300 &&
        hasCommitTextMatch;
      const isConfirmedImeCommit =
        isRecentCommit && !this.isComposing && !update.view.composing;
      // Invalidate immediately so it is strictly single-use
      this.lastCompositionCommit = null;

      const isComposingActive = this.isComposing || update.view.composing;
      const hasAllowedUserEvent = isDelete || isPaste || update.transactions.some((tr) => {
        if (typeof tr.isUserEvent === "function") {
          if (tr.isUserEvent("input.type.compose")) {
            return isComposingActive || isConfirmedImeCommit;
          }
          if (tr.isUserEvent("input.type")) {
            return true;
          }
        }
        const uEv =
          typeof tr.annotation === "function"
            ? tr.annotation(Transaction.userEvent)
            : undefined;
        return (
          uEv === "input" ||
          uEv === "input.type" ||
          uEv === "input.type.compose"
        );
      });

      const oldRanges = update.startState.selection.ranges;
      const newRanges = update.state.selection.ranges;
      const oldHead = update.startState.selection.main.head;
      const newHead = update.state.selection.main.head;
      const charDist = Math.abs(newHead - oldHead);
      const oldLine = update.startState.doc.lineAt(oldHead).number;
      const newLine = update.state.doc.lineAt(newHead).number;
      const lineDist = Math.abs(newLine - oldLine);

      const animateTyping = shouldAnimateTyping({
        isMotionActive: isMotionActive(),
        isComposing: this.isComposing || update.view.composing,
        pointerDown: this.pointerDown,
        oldRanges,
        newRanges,
        charDist,
        lineDist,
        isConfirmedImeCommit,
        hasExcludedUserEvent,
        hasAllowedUserEvent,
      });

      if (!animateTyping) {
        this.cancelAll();
        return;
      }

      let isVisible = true;
      try {
        const ranges = update.view.visibleRanges;
        if (ranges && ranges.length > 0) {
          isVisible = ranges.some((r) => newHead >= r.from && newHead <= r.to);
        }
      } catch {
        // Fall back to true if visibleRanges is not available
      }

      if (!isVisible) {
        this.cancelAll();
        return;
      }

      this.cancelScrollAnimation();
      this.armCaretTransition("edit");
      return;
    }

    if (isSearchTx) {
      // Search navigation transaction (selectNearestMatch, findNext, findPrevious):
      // reuse the existing short endpoint transition; scrolling is still handled
      // independently after CodeMirror has measured the target.
      this.lastKeyNavTime = 0;
      this.pendingClickCandidate = null;
      this.cancelScrollAnimation();
      this.cancelledSearchRequest = null;
      this.pendingSearchScroll = {
        state: update.state,
        targetFrom: update.state.selection.main.from,
        targetTo: update.state.selection.main.to,
        time: Date.now(),
      };
      if (isMotionActive()) {
        const oldHead = update.startState.selection.main.head;
        const newHead = update.state.selection.main.head;
        const drawn = update.view.visibleRanges;
        const endpointsDrawn = !drawn?.length || [oldHead, newHead].every(
          pos => drawn.some(r => pos >= r.from && pos <= r.to),
        );
        const composing = this.isComposing || update.view.composing;
        const animate = update.selectionSet && !update.geometryChanged && !this.pointerDown && endpointsDrawn &&
          shouldAnimateSelectionExpandShrink({
            isMotionActive: isMotionActive(),
            isComposing: composing,
            docChanged: false,
            oldRangesCount: update.startState.selection.ranges.length,
            newRangesCount: update.state.selection.ranges.length,
            charDist: Math.abs(newHead - oldHead),
            lineDist: Math.abs(update.state.doc.lineAt(newHead).number - update.startState.doc.lineAt(oldHead).number),
          });
        if (animate) this.armCaretTransition();
        else this.cancelCaretAnimation();
        if (!composing && !this.pointerDown && update.state.selection.ranges.length === 1) {
          this.view.dom?.classList?.add("cm-search-caret");
        }
      } else {
        this.cancelCaretAnimation();
      }
      return;
    }

    if (!isMotionActive()) {
      this.lastKeyNavTime = 0;
      this.pendingClickCandidate = null;
      this.cancelAll();
      return;
    }

    // A fresh search target can cause CM to measure a newly drawn viewport.
    // Drop stale visual transitions, but let that exact state's pending request
    // reach scrollHandler, which evaluates the final geometry and fallback guards.
    if (update.geometryChanged) {
      this.lastKeyNavTime = 0;
      this.pendingClickCandidate = null;
      const noNewTx = !update.selectionSet && !update.transactions.length;
      const isMatchingPending = noNewTx && this.pendingSearchScroll?.state === update.state;
      const isMatchingActive = noNewTx && this.activeSearchScroll?.state === update.state &&
        this.activeSearchScroll.sessionId === this.scrollSessionId;

      if (isMatchingPending) {
        this.cancelCaretAnimation();
        this.cancelScrollAnimation();
      } else if (isMatchingActive) {
        this.cancelCaretAnimation();
        this.checkSearchScrollLayout();
      } else {
        this.cancelAll();
      }
      return;
    }

    const isPointerSelect = update.transactions.some((tr) =>
      (typeof tr.isUserEvent === "function" && tr.isUserEvent("select.pointer")) ||
      (typeof tr.annotation === "function" && tr.annotation(Transaction.userEvent) === "select.pointer"),
    );

    const isExpandShrink = update.transactions.some((tr) => {
      if (typeof tr.isUserEvent === "function") {
        if (tr.isUserEvent("select.expand") || tr.isUserEvent("select.shrink")) {
          return true;
        }
      }
      const uEv =
        typeof tr.annotation === "function" ? tr.annotation(Transaction.userEvent) : undefined;
      return uEv === "select.expand" || uEv === "select.shrink";
    });

    const hasOtherNonKeyboardUserEvent = update.transactions.some(
      (tr) =>
        (typeof tr.isUserEvent === "function" &&
          (tr.isUserEvent("select.search") ||
            tr.isUserEvent("input") ||
            tr.isUserEvent("delete") ||
            tr.isUserEvent("undo") ||
            tr.isUserEvent("redo"))) ||
        (typeof tr.annotation === "function" &&
          (tr.annotation(Transaction.userEvent) === "select.search" ||
            tr.annotation(Transaction.userEvent) === "input" ||
            tr.annotation(Transaction.userEvent) === "delete" ||
            tr.annotation(Transaction.userEvent) === "undo" ||
            tr.annotation(Transaction.userEvent) === "redo")),
    );

    if (hasOtherNonKeyboardUserEvent) {
      this.lastKeyNavTime = 0;
      this.pendingClickCandidate = null;
      this.cancelAll();
      return;
    }

    if (update.selectionSet) {
      this.view.dom?.classList?.remove("cm-search-caret");
      // Programmatic or non-keyboard selection changes must cancel running scroll RAF
      // to prevent an old animated target from pulling back a programmatic repositioning.
      this.cancelScrollAnimation();
      this.cancelPendingSearchScroll();
      const oldRanges = update.startState.selection.ranges;
      const newRanges = update.state.selection.ranges;
      const oldHead = update.startState.selection.main.head;
      const newHead = update.state.selection.main.head;
      const charDist = Math.abs(newHead - oldHead);
      const oldLine = update.startState.doc.lineAt(oldHead).number;
      const newLine = update.state.doc.lineAt(newHead).number;
      const lineDist = Math.abs(newLine - oldLine);

      if (isPointerSelect) {
        const candidate = this.pendingClickCandidate;
        // Consume candidate immediately so only one selection transaction can be animated
        this.pendingClickCandidate = null;

        const drawn = update.view.visibleRanges;
        const endpointsDrawn =
          !drawn?.length ||
          [oldHead, newHead].every((pos) => drawn.some((r) => pos >= r.from && pos <= r.to));

        const isCandidateValid =
          candidate !== null &&
          Date.now() - candidate.time < 500 &&
          candidate.oldHead === oldHead;

        const animateClick =
          isCandidateValid &&
          endpointsDrawn &&
          shouldAnimatePointerClick({
            isMotionActive: isMotionActive(),
            isComposing: this.isComposing || update.view.composing,
            docChanged: update.docChanged,
            hasClickCandidate: true,
            oldRanges,
            newRanges,
            charDist,
            lineDist,
            candidateOldHead: candidate.oldHead,
            isShift: candidate.isShift,
            isOldVisible: endpointsDrawn,
            isNewVisible: endpointsDrawn,
          });

        if (animateClick) {
          // Apply smooth visual caret transition for eligible single click
          this.armCaretTransition();

          // Validate exact viewport bounds (including horizontal bounds on long lines)
          // asynchronously in CodeMirror's measuring lifecycle, avoiding forced layout
          // during update or onMouseDown.
          if (typeof update.view.requestMeasure === "function") {
            const sessionId = ++this.caretSessionId;
            update.view.requestMeasure({
              key: CARET_CLICK_MEASURE_KEY,
              read: (v: EditorView) => {
                if (this.caretSessionId !== sessionId) return null;
                const bounds = getVisibleViewportBounds(v);
                if (!bounds) return { isVisible: true, sessionId };
                const oldCoords = v.coordsAtPos(oldHead);
                const newCoords = v.coordsAtPos(newHead);
                if (!oldCoords || !newCoords) return { isVisible: false, sessionId };
                return {
                  isVisible:
                    isCoordsInVisibleViewport(oldCoords, bounds) &&
                    isCoordsInVisibleViewport(newCoords, bounds),
                  sessionId,
                };
              },
              write: (measured: { isVisible: boolean; sessionId: number } | null) => {
                if (!measured || measured.sessionId !== this.caretSessionId) return;
                if (!measured.isVisible) {
                  this.cancelCaretAnimation();
                }
              },
            });
          }
          return;
        }

        const animateDrag = shouldAnimatePointerDrag({
          isMotionActive: isMotionActive(),
          isComposing: update.view.composing,
          docChanged: update.docChanged,
          pointerDown: this.pointerDown,
          isDragging: this.isDragging,
          isNonMousePointer: this.isNonMousePointer,
          oldRangesCount: oldRanges.length,
          newRangesCount: newRanges.length,
          charDist,
          lineDist,
        });

        if (animateDrag) {
          this.armCaretTransition();
          return;
        }

        this.cancelCaretAnimation();
        return;
      }

      if (isExpandShrink) {
        this.pendingClickCandidate = null;
        const animateExpandShrink = shouldAnimateSelectionExpandShrink({
          isMotionActive: isMotionActive(),
          isComposing: update.view.composing,
          docChanged: update.docChanged,
          oldRangesCount: oldRanges.length,
          newRangesCount: newRanges.length,
          charDist,
          lineDist,
        });

        if (animateExpandShrink) {
          this.armCaretTransition();
          return;
        }

        this.cancelCaretAnimation();
        return;
      }

      if (this.pointerDown || !this.isRecentKeyNav()) {
        this.cancelCaretAnimation();
        return;
      }

      const animate = shouldAnimateCaret({
        isMotionActive: isMotionActive(),
        isComposing: update.view.composing,
        docChanged: update.docChanged,
        pointerDown: this.pointerDown,
        isRecentKeyNav: this.isRecentKeyNav(),
        oldRangesCount: oldRanges.length,
        newRangesCount: newRanges.length,
        charDist,
        lineDist,
      });

      if (!animate) {
        this.cancelCaretAnimation();
        return;
      }

      this.armCaretTransition();
    }
  }

  destroy(): void {
    activeCleanups.delete(this.cancelAll);
    this.cancelAll();

    const dom = this.view.dom;
    const scroller = this.view.scrollDOM;
    const content = this.view.contentDOM;

    if (dom && typeof dom.removeEventListener === "function") {
      dom.removeEventListener("keydown", this.onKeyDown, { capture: true });
      dom.removeEventListener("pointerdown", this.onPointerDown as any, { capture: true });
      dom.removeEventListener("mousedown", this.onMouseDown as any, { capture: true });
      dom.removeEventListener("pointermove", this.onPointerMove as any);
      dom.removeEventListener("compositionstart", this.onCompositionStart, { capture: true });
      dom.removeEventListener("compositionupdate", this.onCompositionUpdate, { capture: true });
      dom.removeEventListener("compositionend", this.onCompositionEnd as any, { capture: true });
      dom.removeEventListener("beforeinput", this.onEditIntent, { capture: true });
      dom.removeEventListener("paste", this.onPasteOrCut, { capture: true });
      dom.removeEventListener("cut", this.onPasteOrCut, { capture: true });
    }

    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("pointermove", this.onPointerMove as any);
      window.removeEventListener("pointerup", this.onPointerUp, { capture: true });
      window.removeEventListener("pointercancel", this.onPointerUp, { capture: true });
      window.removeEventListener("mouseup", this.onPointerUp, { capture: true });
    }

    if (scroller && typeof scroller.removeEventListener === "function") {
      scroller.removeEventListener("wheel", this.onWheel);
      scroller.removeEventListener("touchmove", this.onTouchMove);
      scroller.removeEventListener("scroll", this.onScroll);
    }

    if (content && typeof content.removeEventListener === "function") {
      content.removeEventListener("blur", this.onBlur);
    }
  }
}

export const editorMotionPlugin = ViewPlugin.fromClass(EditorMotionPluginValue);

export const CARET_CLICK_MEASURE_KEY = "editorMotionCaretClick";
export const SCROLL_MEASURE_KEY = "editorMotionScroll";
const SCROLL_LAYOUT_MEASURE_KEY = "editorMotionScrollLayout";
export const SCROLL_FOLLOWUP_MEASURE_KEY = "editorMotionScrollFollowup";

// A search scroll may change the rendered blocks/height estimate, but cannot
// reuse its measured destination across a resize, font change or zoom. Read
// this small layout signature only in requestMeasure's read phase.
function scrollLayout(view: EditorView): string {
  const style = view.contentDOM.ownerDocument?.defaultView?.getComputedStyle(view.contentDOM);
  return [
    view.scrollDOM.clientWidth, view.scrollDOM.clientHeight,
    view.scaleX, view.scaleY, view.defaultLineHeight, view.defaultCharacterWidth,
    view.textDirection, view.lineWrapping,
    style?.font, style?.letterSpacing, style?.paddingTop, style?.paddingBottom,
  ].join("|");
}

interface MeasuredScroll {
  sessionId: number;
  startTop: number;
  targetTop: number;
  moveX: number;
  canAnimate: boolean;
  isSearchScroll: boolean;
  needsHorizontalFollowup?: boolean;
}

/**
 * Handles smooth viewport scrolling requests from CodeMirror's scrollHandler facet.
 *
 * During CodeMirror's updateState=2 Updating phase, reading layout (e.g. coordsAtPos)
 * is prohibited and throws 'Reading the editor layout isn’t allowed during an update'.
 * This handler performs pre-filtering without layout reads, schedules target layout
 * measurement via public EditorView.requestMeasure, and applies scroll/animation
 * in the write phase.
 */
export function handleScrollIntoView(
  view: EditorView,
  range: SelectionRange,
  options: {
    x?: "nearest" | "start" | "end" | "center";
    y?: "nearest" | "start" | "end" | "center";
    xMargin?: number;
    yMargin?: number;
  },
): boolean {
  const plugin = view.plugin(editorMotionPlugin);

  // Intercept explicitly cancelled search scroll request to prevent CodeMirror's native
  // DocView.scrollIntoView from jumping to the cancelled search target.
  if (plugin && plugin.consumeCancelledSearchScroll(view, range)) {
    return true;
  }

  // Always cancel any existing scroll animation so fallback/zero-move branches don't leave old RAF running
  plugin?.cancelScrollAnimation();

  const isSearchScroll =
    plugin !== null &&
    plugin.consumeSearchScroll(view, range);

  if (!isSearchScroll) {
    if (!isMotionActive() || !isDocumentMotionAllowed(view.state.doc)) {
      return false;
    }

    // Check view.composing and pointerDown
    if (view.composing || (plugin && plugin.isPointerActive())) {
      return false;
    }

    // Normal keyboard navigation requires view focus and recent key navigation
    if (!view.hasFocus || !plugin || !plugin.isRecentKeyNav()) {
      return false;
    }

    // Follow only the main cursor for non-search keyboard navigation
    const main = view.state.selection.main;
    const isMainSelection = range.head === main.head && range.anchor === main.anchor;
    if (!isMainSelection) {
      return false;
    }

    // Large document fallback: return false for instant native jump
    if (view.state.doc.lines > MOTION_CONFIG.maxDocLines) {
      return false;
    }
  } else {
    if (view.composing) {
      return false;
    }
  }

  // Document text direction check: non-LTR falls back to native CM
  if (view.textDirection !== Direction.LTR) {
    return false;
  }

  // Vertical panel margins fallback to native CM
  if (hasVerticalScrollMargins(view)) {
    return false;
  }

  // CSS transform or zoom scale fallback to native CM
  if (hasTransformScale(view)) {
    return false;
  }

  const scrollDOM = view.scrollDOM;
  if (!scrollDOM || scrollDOM.clientHeight <= 0) {
    return false;
  }

  // If requestMeasure is not available on the view, cannot safely read layout during update phase
  if (typeof view.requestMeasure !== "function") {
    return false;
  }

  const sessionId = plugin ? plugin.nextScrollSession() : 0;
  if (isSearchScroll && plugin) {
    plugin.setActiveSearchScroll(view.state, range.from, range.to, sessionId, options);
  }

  view.requestMeasure<MeasuredScroll | null>({
    key: SCROLL_MEASURE_KEY,
    read(v: EditorView): MeasuredScroll | null {
      if (plugin && plugin.getScrollSessionId() !== sessionId) {
        return null;
      }

      const scroller = v.scrollDOM;
      if (!scroller || scroller.clientHeight <= 0) {
        return null;
      }
      const active = plugin?.getActiveSearchScroll();
      if (active?.sessionId === sessionId) active.layout = scrollLayout(v);

      let headCoords = v.coordsAtPos(
        range.head,
        range.assoc || (range.head > range.anchor ? -1 : 1),
      );
      let anchorCoords = range.empty
        ? headCoords
        : v.coordsAtPos(
            range.anchor,
            range.anchor > range.head ? -1 : 1,
          );

      let rect: { left: number; right: number; top: number; bottom: number } | null = null;
      if (headCoords && anchorCoords) {
        rect = {
          left: Math.min(headCoords.left, anchorCoords.left),
          top: Math.min(headCoords.top, anchorCoords.top),
          right: Math.max(headCoords.right, anchorCoords.right),
          bottom: Math.max(headCoords.bottom, anchorCoords.bottom),
        };
      } else if (headCoords) {
        rect = headCoords;
      } else if (anchorCoords) {
        rect = anchorCoords;
      }

      let fallbackTop: number | null = null;
      let needsHorizontalFollowup = false;
      if (!rect) {
        try {
          const block = v.lineBlockAt(range.from);
          fallbackTop = block.top;
          if (isSearchScroll) {
            needsHorizontalFollowup = true;
          }
        } catch {
          return null;
        }
      }

      const curRect = scroller.getBoundingClientRect();
      const margins = getScrollMargins(v);
      const startTop = scroller.scrollTop;

      let moveX = 0;
      let moveY = 0;
      let targetTop = startTop;
      let canAnimate = true;

      if (hasTransformScale(v, curRect)) {
        canAnimate = false;
      }
      if (hasVerticalScrollMargins(v)) {
        canAnimate = false;
      }

      if (rect) {
        const targetRect = {
          left: rect.left - margins.left,
          right: rect.right + margins.right,
          top: rect.top - margins.top,
          bottom: rect.bottom + margins.bottom,
        };

        const bounding = {
          left: curRect.left,
          right: curRect.left + scroller.clientWidth,
          top: curRect.top,
          bottom: curRect.top + scroller.clientHeight,
        };

        const side = range.head < range.anchor ? -1 : 1;
        const yMargin = Math.max(
          Math.min(options.yMargin ?? 0, scroller.clientHeight),
          -scroller.clientHeight,
        );
        const yStrategy = options.y ?? "nearest";

        moveX = computeScrollMoveX({
          xStrategy: options.x ?? "nearest",
          rect: targetRect,
          bounding,
          xMargin: Math.max(
            Math.min(options.xMargin ?? 0, scroller.clientWidth),
            -scroller.clientWidth,
          ),
          side,
          ltr: true,
        });

        if (Math.abs(moveX) >= 1 && !isSearchScroll) {
          canAnimate = false;
        }

        moveY = computeScrollMoveY({
          yStrategy,
          rect: targetRect,
          bounding,
          yMargin,
          side,
        });

        targetTop = computeTargetScrollTop(
          startTop,
          moveY,
          scroller.scrollHeight,
          scroller.clientHeight,
        );
      } else if (fallbackTop !== null) {
        const side = range.head < range.anchor ? -1 : 1;
        const yStrategy = options.y ?? "nearest";
        const yMargin = Math.max(
          Math.min(options.yMargin ?? 0, scroller.clientHeight),
          -scroller.clientHeight,
        );
        const targetOffset =
          yStrategy === "center"
            ? fallbackTop - scroller.clientHeight / 2
            : yStrategy === "start" || side < 0
              ? fallbackTop - yMargin
              : fallbackTop - scroller.clientHeight + yMargin;
        targetTop = Math.max(0, Math.min(targetOffset, scroller.scrollHeight - scroller.clientHeight));
        if (!isSearchScroll) {
          canAnimate = false;
        }
      }

      if (Math.abs(targetTop - startTop) < 1 && Math.abs(moveX) < 1 && !needsHorizontalFollowup) {
        return null;
      }

      if (isSearchScroll) {
        if (!isMotionActive() || !isDocumentMotionAllowed(v.state.doc)) {
          canAnimate = false;
        }
      } else {
        if (canAnimate) {
          canAnimate = shouldAnimateViewportScroll({
            isMotionActive: isMotionActive(),
            isRecentKeyNav: plugin ? plugin.isRecentKeyNav() : false,
            isMainSelection: true,
            docLines: v.state.doc.lines,
            hasCoords: Boolean(rect),
            moveY,
          });
        }
      }

      return {
        sessionId,
        startTop,
        targetTop,
        moveX,
        canAnimate,
        isSearchScroll,
        needsHorizontalFollowup,
      };
    },
    write(measured: MeasuredScroll | null, v: EditorView): void {
      if (plugin && plugin.getScrollSessionId() !== sessionId) {
        return;
      }
      if (!measured) {
        plugin?.clearActiveSearchScroll(sessionId);
        return;
      }

      const scroller = v.scrollDOM;
      if (!scroller) {
        return;
      }

      if (Math.abs(measured.moveX) >= 1) {
        const targetLeft = computeTargetScrollLeft(
          scroller.scrollLeft,
          measured.moveX,
          scroller.scrollWidth,
          scroller.clientWidth,
        );
        scroller.scrollLeft = targetLeft;
      }

      const scheduleFollowup = () => {
        if (!measured.needsHorizontalFollowup) {
          plugin?.clearActiveSearchScroll(sessionId);
          return;
        }
        v.requestMeasure({
          key: SCROLL_FOLLOWUP_MEASURE_KEY,
          read(v2: EditorView) {
            if (plugin && plugin.getScrollSessionId() !== sessionId) {
              return null;
            }
            const followupMeasured = measureSearchTarget(v2, range.from, range.to, options);
            if (!followupMeasured || !followupMeasured.rect) {
              return null;
            }
            return { moveX: followupMeasured.moveX };
          },
          write(followupMeasured: { moveX: number } | null, v2: EditorView) {
            try {
              if (plugin && plugin.getScrollSessionId() !== sessionId) {
                return;
              }
              if (!followupMeasured || Math.abs(followupMeasured.moveX) < 1) {
                return;
              }
              const scroller2 = v2.scrollDOM;
              if (!scroller2) return;
              const targetLeft = computeTargetScrollLeft(
                scroller2.scrollLeft,
                followupMeasured.moveX,
                scroller2.scrollWidth,
                scroller2.clientWidth,
              );
              scroller2.scrollLeft = targetLeft;
            } finally {
              plugin?.clearActiveSearchScroll(sessionId);
            }
          },
        });
      };

      if (measured.canAnimate && plugin) {
        plugin.startScrollAnimation(measured.startTop, measured.targetTop, scheduleFollowup);
      } else {
        scroller.scrollTop = measured.targetTop;
        scheduleFollowup();
      }
    },
  });

  return true;
}

export const editorScrollHandler = EditorView.scrollHandler.of(handleScrollIntoView);

/**
 * Extension bundle providing caret smoothness and viewport following.
 */
export function editorMotion(): Extension {
  return [editorMotionPlugin, editorScrollHandler, EditorView.baseTheme({
    // CM normally hides cursors on blur. Search may keep focus in its input;
    // expose only its existing primary cursor, without adding another overlay.
    "&.cm-search-caret > .cm-scroller > .cm-cursorLayer .cm-cursor-primary": {
      display: "block",
    },
  })];
}
