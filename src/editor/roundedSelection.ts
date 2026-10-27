import {
  EditorSelection,
  type Extension,
  type SelectionRange,
} from "@codemirror/state";
import {
  EditorView,
  type LayerMarker,
  RectangleMarker,
  layer,
  type ViewUpdate,
} from "@codemirror/view";

/**
 * 013 Island Selection Rounding:
 *
 * Implements 3px rounded corners for CodeMirror selection backgrounds.
 * Renders visual-line-by-visual-line selection backgrounds that hug actual text,
 * avoiding full-width middle slabs and right-side empty space fills on short lines.
 * Only actually selected newline characters add a fixed 5 CSS px marker.
 *
 * Key constraints satisfied:
 * - 3px outer convex and inner concave corners (clamped at short steps)
 * - Seamless contiguous multi-line selections (no gaps, no double-darkened overlap)
 * - Shared adjacent edges between rectangles stay flat (0px radius)
 * - Non-contiguous selections remain completely independent (all 4 corners rounded)
 * - Selection rectangles clip to each visible visual line's actual text extent
 * - Actual typed trailing spaces are fully covered; soft wraps add no width
 * - Zero modifications to selection semantics, cursors, motion, or search highlights
 * - Zero new dependencies, no Canvas/SVG overlays, no unbounded loops
 */

export interface SelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

/** Standard radius in pixels for island selection corners (Spec 013 §5, A13). */
export const DEFAULT_CORNER_RADIUS = 3;

/** Visible width of a selected real newline, independent of font metrics. */
export const SELECTED_NEWLINE_WIDTH = 5;

/**
 * Maximum vertical distance between two rectangles to be considered touching/adjacent.
 * Bridges subpixel line heights and high-DPI scaling offsets (up to 1.5px).
 */
export const EPSILON_Y = 1.5;

/**
 * Horizontal threshold for considering two edges vertically aligned.
 * Differences under 2.5px represent subpixel font rasterization differences
 * rather than intentional column indentations, preventing false notches on straight edges.
 */
export const ALIGN_X_TOLERANCE = 2.5;

/**
 * Performance budget for rounded selection geometry computation.
 * When the number of visible selection rectangles exceeds this count,
 * the computation conservatively falls back to a flat (0px) seamless path.
 */
export const MAX_ROUNDED_RECTS_BUDGET = 500;

/**
 * Computes corner radii for each rectangle in a selection based on local adjacency (Spec 013 §5, A13).
 *
 * Rules:
 * - A corner is set to 0px if it touches or is covered by an adjacent rectangle's shared edge.
 * - An exposed outer corner is rounded to `radius` (default 3px).
 * - Left/right edges differing by less than `ALIGN_X_TOLERANCE` are treated as continuous straight edges (0px at seam).
 */
export function computeSelectionRadii(
  rects: readonly SelectionRect[],
  radius = DEFAULT_CORNER_RADIUS,
): CornerRadii[] {
  const n = rects.length;
  if (n === 0) return [];

  // Conservative performance degradation for pathological cases:
  // Fall back to 0px (flat seamless edges) rather than individual rounded blocks
  if (n > MAX_ROUNDED_RECTS_BUDGET) {
    return rects.map(() => ({
      topLeft: 0,
      topRight: 0,
      bottomRight: 0,
      bottomLeft: 0,
    }));
  }

  // Pre-calculate right and bottom bounds, identifying non-empty rects
  const bounds = rects.map((r) => ({
    left: r.left,
    top: r.top,
    right: r.left + r.width,
    bottom: r.top + r.height,
    width: r.width,
    height: r.height,
    valid: r.width > 0 && r.height > 0,
  }));

  const result: CornerRadii[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = bounds[i];

    if (!r.valid) {
      result[i] = { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 };
      continue;
    }

    let hasLeftRect = false;
    let hasRightRect = false;
    const aboveRects: typeof bounds = [];
    const belowRects: typeof bounds = [];

    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const other = bounds[j];
      if (!other.valid) continue;

      // Check vertical touch
      const isAbove =
        Math.abs(other.bottom - r.top) <= EPSILON_Y && other.top < r.top;
      const isBelow =
        Math.abs(other.top - r.bottom) <= EPSILON_Y && other.bottom > r.bottom;

      if (isAbove) {
        aboveRects.push(other);
      } else if (isBelow) {
        belowRects.push(other);
      }

      // Check same-line horizontal touch (e.g. bidirectional text or widgets)
      const vertOverlap =
        Math.min(r.bottom, other.bottom) - Math.max(r.top, other.top);
      if (vertOverlap > 0.5) {
        if (Math.abs(other.right - r.left) <= ALIGN_X_TOLERANCE) {
          hasLeftRect = true;
        }
        if (Math.abs(other.left - r.right) <= ALIGN_X_TOLERANCE) {
          hasRightRect = true;
        }
      }
    }

    // Top-Left
    let tl = radius;
    if (hasLeftRect) {
      tl = 0;
    } else {
      for (const u of aboveRects) {
        const horizOverlap = Math.min(u.right, r.right) - Math.max(u.left, r.left);
        const leftAligned = Math.abs(u.left - r.left) <= ALIGN_X_TOLERANCE;
        const leftExtendsPast = u.left < r.left - ALIGN_X_TOLERANCE && u.right > r.left;
        if (
          (leftAligned && horizOverlap > 0) ||
          leftExtendsPast
        ) {
          tl = 0;
          break;
        }
      }
    }

    // Top-Right
    let tr = radius;
    if (hasRightRect) {
      tr = 0;
    } else {
      for (const u of aboveRects) {
        const horizOverlap = Math.min(u.right, r.right) - Math.max(u.left, r.left);
        const rightAligned = Math.abs(u.right - r.right) <= ALIGN_X_TOLERANCE;
        const rightExtendsPast = u.right > r.right + ALIGN_X_TOLERANCE && u.left < r.right;
        if (
          (rightAligned && horizOverlap > 0) ||
          rightExtendsPast
        ) {
          tr = 0;
          break;
        }
      }
    }

    // Bottom-Left
    let bl = radius;
    if (hasLeftRect) {
      bl = 0;
    } else {
      for (const d of belowRects) {
        const horizOverlap = Math.min(d.right, r.right) - Math.max(d.left, r.left);
        const leftAligned = Math.abs(d.left - r.left) <= ALIGN_X_TOLERANCE;
        const leftExtendsPast = d.left < r.left - ALIGN_X_TOLERANCE && d.right > r.left;
        if (
          (leftAligned && horizOverlap > 0) ||
          leftExtendsPast
        ) {
          bl = 0;
          break;
        }
      }
    }

    // Bottom-Right
    let br = radius;
    if (hasRightRect) {
      br = 0;
    } else {
      for (const d of belowRects) {
        const horizOverlap = Math.min(d.right, r.right) - Math.max(d.left, r.left);
        const rightAligned = Math.abs(d.right - r.right) <= ALIGN_X_TOLERANCE;
        const rightExtendsPast = d.right > r.right + ALIGN_X_TOLERANCE && d.left < r.right;
        if (
          (rightAligned && horizOverlap > 0) ||
          rightExtendsPast
        ) {
          br = 0;
          break;
        }
      }
    }

    result[i] = {
      topLeft: tl,
      topRight: tr,
      bottomRight: br,
      bottomLeft: bl,
    };
  }

  return result;
}

/** Formats CornerRadii into standard CSS border-radius property value. */
export function formatRadius(r: CornerRadii): string {
  return `${r.topLeft}px ${r.topRight}px ${r.bottomRight}px ${r.bottomLeft}px`;
}

/**
 * Custom LayerMarker that attaches corner radii to selection background DOM elements.
 * Subclasses CodeMirror's native RectangleMarker to reuse its exact DOM positioning
 * and reconciliation while applying computed 3px border-radius values.
 */
export class RoundedRectangleMarker extends RectangleMarker {
  readonly radii: CornerRadii;

  constructor(
    className: string,
    left: number,
    top: number,
    width: number | null,
    height: number,
    radii: CornerRadii,
  ) {
    super(className, left, top, width, height);
    this.radii = radii;
  }

  override draw(): HTMLDivElement {
    const elt = super.draw();
    elt.style.borderRadius = formatRadius(this.radii);
    return elt;
  }

  override update(elt: HTMLDivElement, prev: RectangleMarker): boolean {
    if (!super.update(elt, prev)) return false;
    if (prev instanceof RoundedRectangleMarker) {
      if (!this.sameRadii(prev.radii)) {
        elt.style.borderRadius = formatRadius(this.radii);
      }
    } else {
      elt.style.borderRadius = formatRadius(this.radii);
    }
    return true;
  }

  private sameRadii(other: CornerRadii): boolean {
    return (
      this.radii.topLeft === other.topLeft &&
      this.radii.topRight === other.topRight &&
      this.radii.bottomRight === other.bottomRight &&
      this.radii.bottomLeft === other.bottomLeft
    );
  }

  override eq(other: RectangleMarker): boolean {
    return (
      super.eq(other) &&
      other instanceof RoundedRectangleMarker &&
      this.sameRadii(other.radii)
    );
  }
}

type ConcaveHole = "left top" | "right top" | "left bottom" | "right bottom";

/** A square in the union's missing quadrant, with a transparent circular hole.
 * Masking the existing selection background preserves its color/focus rules.
 */
export class ConcaveCornerMarker extends RectangleMarker {
  constructor(left: number, top: number, radius: number, readonly hole: ConcaveHole,
    className = "cm-selectionBackground") {
    super(`${className} cm-selectionConcave`, left, top, radius, radius);
  }

  private mask(elt: HTMLDivElement): void {
    elt.style.maskImage = `radial-gradient(circle ${this.width}px at ${this.hole}, transparent ${this.width}px, #000 ${this.width}px)`;
  }

  override draw(): HTMLDivElement {
    const elt = super.draw();
    this.mask(elt);
    return elt;
  }

  override update(elt: HTMLDivElement, prev: RectangleMarker): boolean {
    if (!super.update(elt, prev)) return false;
    this.mask(elt);
    return true;
  }

  override eq(other: RectangleMarker): boolean {
    return super.eq(other) && other instanceof ConcaveCornerMarker && this.hole === other.hole;
  }
}

/**
 * Safely segments a line block into visual lines when soft wrapping is active.
 * Uses assoc = 1 at wrap boundaries to avoid 0-width or UTF-16 surrogate slicing.
 * When viewport bounds are provided, quickly locates the first visible visual line
 * instead of scanning off-screen segments from the logical line start.
 */
export function getVisualLineSegments(
  view: {
    lineWrapping?: boolean;
    moveToLineBoundary?: (
      range: SelectionRange,
      forward: boolean,
      includeWrap?: boolean,
    ) => SelectionRange;
  },
  blockFrom: number,
  blockTo: number,
  viewportFrom = blockFrom,
  viewportTo = blockTo,
): Array<{ from: number; to: number }> {
  if (!view.lineWrapping || typeof view.moveToLineBoundary !== "function") {
    return [{ from: blockFrom, to: blockTo }];
  }
  if (blockFrom >= blockTo) {
    return [{ from: blockFrom, to: blockTo }];
  }

  const startTarget = Math.max(blockFrom, Math.min(blockTo, viewportFrom));
  const endLimit = Math.min(blockTo, Math.max(blockFrom, viewportTo));

  // Locate the start of the visual segment containing startTarget
  let curStart = blockFrom;
  if (startTarget > blockFrom) {
    const startCursor = EditorSelection.cursor(startTarget, 1);
    const boundaryStart = view.moveToLineBoundary(startCursor, false, true).head;
    if (boundaryStart >= blockFrom && boundaryStart <= startTarget) {
      curStart = boundaryStart;
    }
  }

  const segments: Array<{ from: number; to: number }> = [];
  let cur = curStart;
  let safety = 1000;
  while (cur < blockTo && safety-- > 0) {
    // Crucial: Use assoc = 1 so CodeMirror treats wrap boundaries as belonging to the forward line
    const endRange = view.moveToLineBoundary(
      EditorSelection.cursor(cur, 1),
      true,
      true,
    );
    const segEnd = Math.min(blockTo, endRange.head);
    if (segEnd <= cur) {
      // Geometry did not advance; conservatively break to avoid infinite loop or fabricating fragments
      break;
    }
    segments.push({ from: cur, to: segEnd });
    if (segEnd >= blockTo || segEnd >= endLimit) break;
    cur = segEnd;
  }
  return segments;
}

export interface VisualSelectionTargetView {
  state: {
    selection: { ranges: readonly SelectionRange[] };
    doc: {
      length: number;
      lineAt: (pos: number) => { number: number; from: number; to: number };
      line: (num: number) => { from: number; to: number };
    };
  };
  viewport?: { from: number; to: number };
  visibleRanges?: readonly { from: number; to: number }[];
  viewportLineBlocks?: readonly { from: number; to: number }[];
  lineWrapping?: boolean;
  moveToLineBoundary?: (
    range: SelectionRange,
    forward: boolean,
    includeWrap?: boolean,
  ) => SelectionRange;
  coordsAtPos?: (
    pos: number,
    side?: -1 | 1 | -2 | 2,
  ) => { left: number; right: number; top: number; bottom: number } | null;
  defaultLineHeight?: number;
  scaleY?: number;
}

function piecesForSubRange(
  view: EditorView | VisualSelectionTargetView,
  className: string,
  range: SelectionRange,
): SelectionRect[] {
  try {
    const markers = RectangleMarker.forRange(
      view as EditorView,
      className,
      range,
    );
    if (markers.length > 0) {
      return markers.map((m) => ({
        left: m.left,
        top: m.top,
        width: m.width ?? 0,
        height: m.height,
      }));
    }
  } catch {
    // Headless test double fallback
  }

  const fromCoords =
    typeof view.coordsAtPos === "function"
      ? view.coordsAtPos(range.from, 1)
      : null;
  const toCoords =
    typeof view.coordsAtPos === "function"
      ? view.coordsAtPos(range.to, -1)
      : null;

  if (fromCoords && toCoords) {
    const left = Math.min(fromCoords.left, toCoords.left);
    const top = Math.min(fromCoords.top, toCoords.top);
    const bottom = Math.max(fromCoords.bottom, toCoords.bottom);
    const width = Math.abs(toCoords.left - fromCoords.left);
    const height = bottom - top;
    return [{ left, top, width, height }];
  }

  return [];
}

function pieceForSelectedNewline(
  view: EditorView | VisualSelectionTargetView,
  className: string,
  pos: number,
): SelectionRect | null {
  try {
    const markers = RectangleMarker.forRange(
      view as EditorView,
      className,
      EditorSelection.cursor(pos),
    );
    if (markers.length > 0) {
      return {
        left: markers[0].left,
        top: markers[0].top,
        width: SELECTED_NEWLINE_WIDTH,
        height: markers[0].height,
      };
    }
  } catch {
    // Headless test double fallback
  }

  const coords =
    typeof view.coordsAtPos === "function" ? view.coordsAtPos(pos, 1) : null;
  if (coords) {
    return {
      left: coords.left,
      top: coords.top,
      width: SELECTED_NEWLINE_WIDTH,
      height: coords.bottom - coords.top,
    };
  }
  return null;
}

interface SelectionLineGroup {
  range: SelectionRange;
  from: number;
  to: number;
  pieces: SelectionRect[];
}

interface PreviousSelectionLine {
  to: number;
  pieces: SelectionRect[];
  glyphTop: number;
  glyphBottom: number;
}

interface SelectionLineJoin {
  above: SelectionRect[];
  below: SelectionRect[];
}

/** Join only neighboring selected visual rows, splitting their measured gap in half. */
function joinSelectionLines(
  view: EditorView | VisualSelectionTargetView,
  previous: PreviousSelectionLine | undefined,
  group: SelectionLineGroup,
  joins: SelectionLineJoin[],
): PreviousSelectionLine {
  let glyphTop = Infinity, glyphBottom = -Infinity;
  for (const p of group.pieces) {
    glyphTop = Math.min(glyphTop, p.top);
    glyphBottom = Math.max(glyphBottom, p.top + p.height);
  }
  const current = { to: group.to, pieces: group.pieces, glyphTop, glyphBottom };
  if (!previous) return current;

  // Equal offsets are a soft wrap. A one-position gap must be a real newline,
  // never a skipped character, hidden visual row, or a different selection.
  const contiguous = previous.to === group.from ||
    (previous.to + 1 === group.from &&
      view.state.doc.lineAt(previous.to).to === previous.to &&
      view.state.doc.lineAt(group.from).from === group.from);
  if (!contiguous) return current;

  const gap = glyphTop - previous.glyphBottom;
  const previousHeight = previous.glyphBottom - previous.glyphTop;
  const currentHeight = glyphBottom - glyphTop;
  const lineHeight = (view.defaultLineHeight ?? 0) * (view.scaleY ?? 1);
  const pitch = (glyphTop + glyphBottom - previous.glyphTop - previous.glyphBottom) / 2;
  // Font glyph boxes can be shorter than a line. Use CM's measured line height
  // only as a guard against layout gaps/widgets; never as a fixed extension.
  if (gap < 0 || previousHeight <= 0 || currentHeight <= 0 ||
      pitch > Math.max(lineHeight, previousHeight, currentHeight) + EPSILON_Y) {
    return current;
  }

  const seam = (previous.glyphBottom + glyphTop) / 2;
  for (const p of previous.pieces) p.height = seam - p.top;
  for (const p of group.pieces) {
    const bottom = p.top + p.height;
    p.top = seam;
    p.height = bottom - seam;
  }
  // At most 499 joins can affect an in-budget geometry. Keep metadata bounded
  // even when the viewport contains many more rectangles (which stay visible).
  if (joins.length < MAX_ROUNDED_RECTS_BUDGET) {
    joins.push({ above: previous.pieces, below: group.pieces });
  }
  // Keep unextended glyph bounds for the next row's guard and midpoint.
  return current;
}

/**
 * Builds individual selection rectangles clipped to each visual line's text extent.
 * Prevents CodeMirror's multi-line middle slab from stretching across empty editor space.
 */
function buildVisualSelectionGeometry(
  view: EditorView | VisualSelectionTargetView,
  className = "cm-selectionBackground",
): { pieces: SelectionRect[]; joins: SelectionLineJoin[] } {
  const joins: SelectionLineJoin[] = [];
  if (view.state.selection.ranges.every((r) => r.empty)) {
    return { pieces: [], joins };
  }

  const vpFrom = view.viewport ? view.viewport.from : 0;
  const vpTo = view.viewport ? view.viewport.to : view.state.doc.length;

  let blocks: Array<{ from: number; to: number }> = [];
  try {
    const vpBlocks = view.viewportLineBlocks;
    if (vpBlocks && vpBlocks.length > 0) {
      blocks = vpBlocks.map((b) => ({ from: b.from, to: b.to }));
    }
  } catch {
    blocks = [];
  }

  if (blocks.length === 0) {
    const doc = view.state.doc;
    const clampedFrom = Math.max(0, Math.min(doc.length, vpFrom));
    const clampedTo = Math.max(0, Math.min(doc.length, vpTo));
    const startLine = doc.lineAt(clampedFrom);
    const endLine = doc.lineAt(clampedTo);
    for (let l = startLine.number; l <= endLine.number; l++) {
      const line = doc.line(l);
      blocks.push({ from: line.from, to: line.to });
    }
  }

  const rects: SelectionRect[] = [];
  const drawnRanges = view.visibleRanges ?? [{ from: vpFrom, to: vpTo }];
  let previousGroups = new Map<SelectionRange, PreviousSelectionLine>();

  for (const block of blocks) {
    // Skip blocks completely outside viewport bounds
    if (block.to < vpFrom || block.from > vpTo) {
      continue;
    }

    // A viewport contains entire logical lines. Long wrapped lines may have
    // unrendered gaps inside it; only enumerate CodeMirror's drawn portions.
    const segments: Array<{ from: number; to: number }> = [];
    const seenSegments = new Set<string>();
    for (const drawn of drawnRanges) {
      if (drawn.to < block.from || drawn.from > block.to) continue;
      for (const segment of getVisualLineSegments(
        view, block.from, block.to,
        Math.max(vpFrom, drawn.from), Math.min(vpTo, drawn.to),
      )) {
        const key = `${segment.from}:${segment.to}`;
        if (seenSegments.has(key)) continue;
        seenSegments.add(key);
        segments.push(segment);
      }
    }

    for (const seg of segments) {
      const visFrom = seg.from;
      const visTo = seg.to;

      const lineGroups: SelectionLineGroup[] = [];

      for (const range of view.state.selection.ranges) {
        if (range.empty) continue;
        if (range.to <= visFrom || range.from > visTo) continue;

        const subFrom = Math.max(range.from, visFrom);
        const subTo = Math.min(range.to, visTo);
        // A soft-wrap boundary is not a character. The exclusive range end
        // must pass a real logical-line terminator to earn its visible width.
        const selectedNewline = range.from <= visTo && range.to > visTo &&
          visTo < view.state.doc.length && view.state.doc.lineAt(visTo).to === visTo;

        if (subFrom < subTo) {
          const subRange = EditorSelection.range(subFrom, subTo);
          const rawPieces = piecesForSubRange(view, className, subRange);
          if (rawPieces.length > 0) {
            if (selectedNewline) {
              // Extend the visual end once, not every bidi fragment. No extra
              // text padding is added on any other row or exclusive endpoint.
              let endPiece = rawPieces[0];
              for (const piece of rawPieces) {
                if (piece.left + piece.width > endPiece.left + endPiece.width) endPiece = piece;
              }
              endPiece.width += SELECTED_NEWLINE_WIDTH;
            }
            lineGroups.push({ range, from: subFrom, to: subTo, pieces: rawPieces });
          }
        } else if (selectedNewline) {
          const piece = pieceForSelectedNewline(view, className, visTo);
          if (piece) {
            lineGroups.push({ range, from: subFrom, to: subTo, pieces: [piece] });
          }
        }
      }

      const allLinePieces = lineGroups.flatMap((g) => g.pieces);

      const currentGroups = new Map<SelectionRange, PreviousSelectionLine>();
      for (const group of lineGroups) {
        currentGroups.set(group.range,
          joinSelectionLines(view, previousGroups.get(group.range), group, joins));
      }
      // Missing geometry/selection on an intervening row breaks continuity.
      previousGroups = currentGroups;

      for (const p of allLinePieces) {
        rects.push(p);
      }
    }
  }

  return { pieces: rects, joins };
}

/** Text-fitted bodies, including the shared seams, without decorative patches. */
export function buildVisualSelectionPieces(
  view: EditorView | VisualSelectionTargetView,
  className = "cm-selectionBackground",
): SelectionRect[] {
  return buildVisualSelectionGeometry(view, className).pieces;
}

interface RowSpan extends SelectionRect {
  leftPiece: SelectionRect;
  rightPiece: SelectionRect;
}

/** Merge touching bidi fragments before looking for actual outline steps. */
function rowSpans(pieces: SelectionRect[]): RowSpan[] {
  const spans: RowSpan[] = [];
  for (const p of pieces.filter(p => p.width > 0 && p.height > 0).sort((a, b) => a.left - b.left)) {
    const last = spans[spans.length - 1];
    if (last && p.left <= last.left + last.width) {
      const right = Math.max(last.left + last.width, p.left + p.width);
      const bottom = Math.max(last.top + last.height, p.top + p.height);
      if (p.left + p.width >= last.left + last.width) last.rightPiece = p;
      last.width = right - last.left;
      last.top = Math.min(last.top, p.top);
      last.height = bottom - last.top;
    } else {
      spans.push({ ...p, leftPiece: p, rightPiece: p });
    }
  }
  return spans;
}

/** Square growth into a missing quadrant stops before any other painted body.
 * Leaving half the available distance also keeps nearby independent ranges apart.
 */
function clearCornerRadius(x: number, y: number, sx: number, sy: number,
  radius: number, obstacles: readonly SelectionRect[]): number {
  for (const p of obstacles) {
    if (p.width <= 0 || p.height <= 0) continue;
    const x1 = sx * (p.left - x), x2 = sx * (p.left + p.width - x);
    const y1 = sy * (p.top - y), y2 = sy * (p.top + p.height - y);
    // Ignore shared edges (including floating point cancellation at the seam).
    if (Math.max(x1, x2) <= 1e-6 || Math.max(y1, y2) <= 1e-6) continue;
    const distance = Math.max(0, Math.min(x1, x2), Math.min(y1, y2));
    radius = Math.min(radius, distance / 2);
  }
  return radius;
}

function concaveSelectionMarkers(
  pieces: SelectionRect[], joins: SelectionLineJoin[], radii: CornerRadii[], className: string,
): ConcaveCornerMarker[] {
  if (pieces.length > MAX_ROUNDED_RECTS_BUDGET) return [];
  const corners = new Map(pieces.map((p, i) => [p, radii[i]]));
  const patches: ConcaveCornerMarker[] = [];
  const occupiedPatches: SelectionRect[] = [];

  function addSteps(narrow: RowSpan[], wide: RowSpan[], below: boolean): void {
    for (let i = 0; i < narrow.length; i++) {
      const span = narrow[i];
      const y = below ? span.top : span.top + span.height;
      for (const left of [true, false]) {
        const x = left ? span.left : span.left + span.width;
        const container = wide.find(w => x > w.left && x < w.left + w.width &&
          Math.abs((below ? w.top + w.height : w.top) - y) < 1e-6);
        if (!container) continue;
        const step = left ? x - container.left : container.left + container.width - x;
        const neighbor = narrow[i + (left ? -1 : 1)];
        const gap = !neighbor ? Infinity : left ? x - neighbor.left - neighbor.width : neighbor.left - x;
        const sx = left ? -1 : 1, sy = below ? 1 : -1;
        let radius = Math.min(DEFAULT_CORNER_RADIUS, step / 2, gap / 2, span.height / 2);
        radius = clearCornerRadius(x, y, sx, sy, radius, pieces);
        radius = clearCornerRadius(x, y, sx, sy, radius, occupiedPatches);
        if (radius <= 1e-6) continue;

        // The convex corner across a short ledge must leave room for its inner
        // partner. Their radii together never exceed that ledge's real length.
        const outer = corners.get(left ? container.leftPiece : container.rightPiece)!;
        const key = `${below ? "bottom" : "top"}${left ? "Left" : "Right"}` as keyof CornerRadii;
        outer[key] = Math.min(outer[key], step - radius);
        const patch = new ConcaveCornerMarker(x - (left ? radius : 0), y - (below ? 0 : radius),
          radius, `${left ? "left" : "right"} ${below ? "bottom" : "top"}`, className);
        patches.push(patch);
        occupiedPatches.push({ left: patch.left, top: patch.top, width: radius, height: radius });
      }
    }
  }

  for (const join of joins) {
    const above = rowSpans(join.above), below = rowSpans(join.below);
    addSteps(below, above, true);
    addSteps(above, below, false);
  }
  return patches;
}

/**
 * Builds the text-fitted bodies and non-overlapping inner-corner masks in one layer.
 */
export function buildVisualSelectionMarkers(
  view: EditorView | VisualSelectionTargetView,
  className = "cm-selectionBackground",
): readonly LayerMarker[] {
  const { pieces, joins } = buildVisualSelectionGeometry(view, className);
  if (pieces.length === 0) return [];

  const radii = computeSelectionRadii(pieces);
  const concave = concaveSelectionMarkers(pieces, joins, radii, className);
  const markers: LayerMarker[] = new Array(pieces.length);

  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    markers[i] = new RoundedRectangleMarker(
      className,
      p.left,
      p.top,
      p.width,
      p.height,
      radii[i],
    );
  }

  return markers.concat(concave);
}

/**
 * Dedicated CodeMirror layer for rounded text-fitted selection backgrounds.
 */
export const roundedSelectionLayerConfig: Parameters<typeof layer>[0] = {
  above: false,
  // `layer.class` is passed to DOMTokenList.add as a single token.
  class: "cm-roundedSelectionLayer",
  mount(dom) {
    dom.classList.add("cm-selectionLayer");
  },
  markers(view: EditorView) {
    return buildVisualSelectionMarkers(view);
  },
  update(update: ViewUpdate) {
    return (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.geometryChanged
    );
  },
};

export const roundedSelectionLayer = layer(roundedSelectionLayerConfig);

const roundedSelectionTheme = EditorView.baseTheme({
  // Hide native selection layer so only our rounded visual selection is visible
  ".cm-selectionLayer:not(.cm-roundedSelectionLayer)": {
    display: "none !important",
  },
  ".cm-roundedSelectionLayer": {
    zIndex: "-2 !important",
    pointerEvents: "none",
  },
  ".cm-roundedSelectionLayer .cm-selectionBackground": {
    position: "absolute",
    boxSizing: "border-box",
  },
});

/**
 * Returns an extension enabling 3px island rounded corners on selection rectangles.
 * Renders visual-line-by-visual-line selection backgrounds that hug actual text,
 * avoiding full-width middle slabs, with 5px markers only for selected real newlines.
 */
export function roundedSelection(): Extension {
  return [roundedSelectionLayer, roundedSelectionTheme];
}
