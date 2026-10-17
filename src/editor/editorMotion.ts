/**
 * Smooth Caret and Viewport Follow Motion (012 Caret Enhancement, specs/012 §5-§7).
 *
 * Implements lightweight visual-only transitions:
 * - Smooth caret gliding (150ms navigation / 120ms edits, cubic-bezier(0.22, 0.61, 0.36, 1)) for short keyboard navigation, plain
 *   single left-clicks within visible viewport without editing, plain text typing /
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
}): boolean {
  if (
    !params.isMotionActive ||
    params.isComposing ||
    params.docChanged ||
    !params.hasClickCandidate
  ) {
    return false;
  }
  if (
    params.oldRanges.length !== 1 ||
    !params.oldRanges[0].empty ||
    params.newRanges.length !== 1 ||
    !params.newRanges[0].empty
  ) {
    return false;
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
        ? rect.left + rectWidth / 2 - boundingWidth / 2
        : (xStrategy === "start") === ltr
          ? rect.left - xMargin
          : rect.right - boundingWidth + xMargin;
    return targetLeft - bounding.left;
  }
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
    targetPos: number;
    clientX: number;
    clientY: number;
  } | null = null;
  private caretTimeout: ReturnType<typeof setTimeout> | null = null;
  private animFrameId: number | null = null;

  readonly onKeyDown = (e: KeyboardEvent) => {
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

    // Plain left-click only: button === 0, detail === 1, no Ctrl/Alt/Shift/Meta
    if (
      this.isNonMousePointer ||
      e.button !== 0 ||
      e.detail !== 1 ||
      e.ctrlKey ||
      e.altKey ||
      e.shiftKey ||
      e.metaKey ||
      this.view.composing ||
      !isMotionActive()
    ) {
      this.cancelCaretAnimation();
      return;
    }

    // Must be inside editor content DOM (not gutters or scrollbars)
    const content = this.view.contentDOM;
    if (content && e.target && typeof (content as any).contains === "function") {
      if (!content.contains(e.target as any)) {
        this.cancelCaretAnimation();
        return;
      }
    }

    // Single empty cursor requirement on both sides of transition
    const curSelection = this.view.state.selection;
    if (curSelection.ranges.length !== 1 || !curSelection.main.empty) {
      this.cancelCaretAnimation();
      return;
    }
    const oldHead = curSelection.main.head;

    if (
      typeof this.view.posAtCoords !== "function" ||
      typeof this.view.coordsAtPos !== "function"
    ) {
      return;
    }

    // Resolve click target position using CodeMirror's posAtCoords
    const targetPos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    if (targetPos === null || targetPos === undefined || targetPos === oldHead) {
      return;
    }

    const charDist = Math.abs(targetPos - oldHead);
    if (charDist <= 0 || charDist > MOTION_CONFIG.maxCaretCharDist) {
      return;
    }

    const doc = this.view.state.doc;
    const oldLine = doc.lineAt(oldHead).number;
    const targetLine = doc.lineAt(targetPos).number;
    const lineDist = Math.abs(targetLine - oldLine);
    if (lineDist > MOTION_CONFIG.maxCaretLineDist) {
      return;
    }

    // Viewport visibility check for both old cursor and target positions
    const bounds = getVisibleViewportBounds(this.view);
    if (!bounds) {
      return;
    }

    const oldCoords = this.view.coordsAtPos(oldHead);
    const targetCoords = this.view.coordsAtPos(targetPos);
    if (!oldCoords || !targetCoords) {
      return;
    }

    if (
      !isCoordsInVisibleViewport(oldCoords, bounds) ||
      !isCoordsInVisibleViewport(targetCoords, bounds)
    ) {
      return;
    }

    // Store candidate only after all measurements complete safely while editor layout is idle
    this.pendingClickCandidate = {
      oldHead,
      targetPos,
      clientX: e.clientX,
      clientY: e.clientY,
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
        this.isDragging = true;
        this.pendingClickCandidate = null;
      }
    } else if (this.pointerDown && !this.isNonMousePointer) {
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
    this.isComposing = true;
    this.lastCompositionCommit = null;
    this.lastKeyNavTime = 0;
    this.cancelScrollAnimation();
    this.cancelPendingSearchScroll();
    this.pendingClickCandidate = null;
  };

  readonly onCompositionUpdate = () => {
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
    }
  };

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
  startScrollAnimation(startTop: number, targetTop: number): void {
    this.cancelScrollAnimation();
    // Close active caret transition to avoid superposing caret flight with viewport scroll
    this.cancelCaretAnimation();

    if (typeof requestAnimationFrame !== "function") {
      if (this.view.scrollDOM) {
        this.view.scrollDOM.scrollTop = targetTop;
      }
      return;
    }

    const duration = MOTION_CONFIG.scrollDurationMs;
    const startTime = performance.now();

    const step = (now: number) => {
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
      }
    };

    this.animFrameId = requestAnimationFrame(step);
  }

  /** Cancels any active viewport scroll animation. */
  cancelScrollAnimation = (): void => {
    if (this.animFrameId !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.animFrameId);
      }
      this.animFrameId = null;
    }
  };

  /** Cancels caret visual transition and clears timeout. */
  cancelCaretAnimation = (): void => {
    if (this.caretTimeout !== null) {
      clearTimeout(this.caretTimeout);
      this.caretTimeout = null;
    }
    this.view.dom?.classList?.remove("cm-smooth-caret");
    this.view.dom?.classList?.remove("cm-smooth-edit");
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

    if (Date.now() - pending.time >= 300) {
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

    if (Date.now() - cancelled.time >= 300) {
      return false;
    }

    const matchesTarget =
      range.head === cancelled.targetFrom ||
      (range.from <= cancelled.targetTo && range.to >= cancelled.targetFrom) ||
      Math.abs(range.head - cancelled.targetFrom) <= 50;
    return matchesTarget;
  }

  update(update: ViewUpdate): void {
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

    // Geometry/font/size changes cancel all animations
    if (update.geometryChanged) {
      this.lastKeyNavTime = 0;
      this.pendingClickCandidate = null;
      this.cancelPendingSearchScroll();
      this.cancelAll();
      return;
    }

    if (!isMotionActive()) {
      this.lastKeyNavTime = 0;
      this.pendingClickCandidate = null;
      this.cancelAll();
      return;
    }

    const isSearchTx = update.transactions.some(
      (tr) =>
        (typeof tr.annotation === "function" && tr.annotation(searchMotionAnnotation) === true) ||
        (typeof tr.isUserEvent === "function" && tr.isUserEvent("select.search")),
    );

    if (isSearchTx) {
      // Search navigation transaction (selectNearestMatch, findNext, findPrevious):
      // snap caret visual immediately, schedule search scroll
      this.lastKeyNavTime = 0;
      this.pendingClickCandidate = null;
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

        const animateClick = shouldAnimatePointerClick({
          isMotionActive: isMotionActive(),
          isComposing: update.view.composing,
          docChanged: update.docChanged,
          hasClickCandidate: candidate !== null,
          oldRanges,
          newRanges,
          charDist,
          lineDist,
          candidateOldHead: candidate?.oldHead,
          candidateTargetPos: candidate?.targetPos,
        });

        if (animateClick) {
          // Apply smooth visual caret transition for eligible single click
          this.armCaretTransition();
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

/**
 * Handles smooth viewport scrolling requests from CodeMirror's scrollHandler facet.
 */
export function handleScrollIntoView(
  view: EditorView,
  range: SelectionRange,
  options: {
    x?: string;
    y?: string;
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

  if (!isMotionActive() || !isDocumentMotionAllowed(view.state.doc)) {
    return false;
  }

  // Check view.composing and pointerDown
  if (view.composing || (plugin && plugin.isPointerActive())) {
    return false;
  }

  const isSearchScroll =
    plugin !== null &&
    plugin.consumeSearchScroll(view, range);

  if (!isSearchScroll) {
    // Normal keyboard navigation requires view focus and recent key navigation
    if (!view.hasFocus || !plugin || !plugin.isRecentKeyNav()) {
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

  // Follow only the main cursor for non-search keyboard navigation
  const main = view.state.selection.main;
  if (!isSearchScroll) {
    const isMainSelection = range.head === main.head && range.anchor === main.anchor;
    if (!isMainSelection) {
      return false;
    }

    // Large document fallback: return false for instant native jump
    if (view.state.doc.lines > MOTION_CONFIG.maxDocLines) {
      return false;
    }
  }

  // Measure target coordinates using CodeMirror's coordsAtPos
  let rect = view.coordsAtPos(
    range.head,
    range.assoc || (range.head > range.anchor ? -1 : 1),
  );
  if (!rect) {
    return false;
  }

  if (!range.empty) {
    const other = view.coordsAtPos(
      range.anchor,
      range.anchor > range.head ? -1 : 1,
    );
    if (other) {
      rect = {
        left: Math.min(rect.left, other.left),
        top: Math.min(rect.top, other.top),
        right: Math.max(rect.right, other.right),
        bottom: Math.max(rect.bottom, other.bottom),
      };
    }
  }

  const scrollDOM = view.scrollDOM;
  if (!scrollDOM || scrollDOM.clientHeight <= 0) {
    return false;
  }

  // CSS transform or zoom scale fallback to native CM
  if (hasTransformScale(view)) {
    return false;
  }

  const curRect = scrollDOM.getBoundingClientRect();
  const margins = getScrollMargins(view);

  // targetRect accounts for margins (e.g. left gutter like line numbers)
  const targetRect = {
    left: rect.left - margins.left,
    right: rect.right + margins.right,
    top: rect.top - margins.top,
    bottom: rect.bottom + margins.bottom,
  };

  const bounding = {
    left: curRect.left,
    right: curRect.left + scrollDOM.clientWidth,
    top: curRect.top,
    bottom: curRect.top + scrollDOM.clientHeight,
  };

  const side = range.head < range.anchor ? -1 : 1;
  const yMargin = Math.max(
    Math.min(options.yMargin ?? 0, scrollDOM.clientHeight),
    -scrollDOM.clientHeight,
  );
  const yStrategy = options.y ?? "nearest";

  // Horizontal check: if horizontal scroll adjustment is needed, fallback to native CM scroll
  const moveX = computeScrollMoveX({
    xStrategy: options.x ?? "nearest",
    rect: targetRect,
    bounding,
    xMargin: Math.max(
      Math.min(options.xMargin ?? 0, scrollDOM.clientWidth),
      -scrollDOM.clientWidth,
    ),
    side,
    ltr: true,
  });
  if (Math.abs(moveX) >= 1) {
    if (!isSearchScroll) {
      return false;
    }
    scrollDOM.scrollLeft += moveX;
  }

  const moveY = computeScrollMoveY({
    yStrategy,
    rect: targetRect,
    bounding,
    yMargin,
    side,
  });

  if (Math.abs(moveY) < 1) {
    return true;
  }

  // Compute target scrollTop clamped to scroll bounds
  const startTop = scrollDOM.scrollTop;
  const targetTop = computeTargetScrollTop(
    startTop,
    moveY,
    scrollDOM.scrollHeight,
    scrollDOM.clientHeight,
  );

  if (Math.abs(targetTop - startTop) < 1) {
    return true;
  }

  if (isSearchScroll) {
    const delta = targetTop - startTop;
    const isLargeJump =
      Math.abs(delta) > MOTION_CONFIG.maxAnimDistancePx ||
      view.state.doc.lines > MOTION_CONFIG.maxDocLines;

    if (isLargeJump) {
      const direction = delta > 0 ? 1 : -1;
      const boundedDist = Math.min(
        96,
        Math.max(20, Math.floor(scrollDOM.clientHeight / 4)),
      );
      const maxScroll = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight);
      if (Math.abs(delta) <= boundedDist) {
        plugin.startScrollAnimation(startTop, targetTop);
      } else {
        const nearTop = Math.max(
          0,
          Math.min(targetTop - direction * boundedDist, maxScroll),
        );
        scrollDOM.scrollTop = nearTop;
        plugin.startScrollAnimation(nearTop, targetTop);
      }
    } else {
      plugin.startScrollAnimation(startTop, targetTop);
    }
    return true;
  }

  const canAnimate = shouldAnimateViewportScroll({
    isMotionActive: isMotionActive(),
    isRecentKeyNav: plugin.isRecentKeyNav(),
    isMainSelection: true,
    docLines: view.state.doc.lines,
    hasCoords: true,
    moveY,
  });

  if (!canAnimate) {
    return false;
  }

  plugin.startScrollAnimation(startTop, targetTop);
  return true;
}

/**
 * CodeMirror scrollHandler facet implementing smooth viewport follow for keyboard navigation.
 */
export const editorScrollHandler = EditorView.scrollHandler.of(handleScrollIntoView);

/**
 * Extension bundle providing caret smoothness and viewport following.
 */
export function editorMotion(): Extension {
  return [editorMotionPlugin, editorScrollHandler];
}
