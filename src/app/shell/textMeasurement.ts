/**
 * Shared UI text measurement (007 T085, T134).
 *
 * Two 007 surfaces need to know how wide a label will be *before* it is laid out:
 *
 * - the virtualized Explorer Tree, whose horizontal extent must include rows that
 *   are currently outside the viewport (FR-043);
 * - the Tab strip, whose Tabs are sized to their content up to a maximum instead
 *   of being forced to a single fixed width (FR-065).
 *
 * Both measure with **one** Canvas 2D context rather than rendering hidden DOM per
 * label, and both are handed the same UI font signature — typography is not a
 * density concern, so a density switch must not change a measured width
 * (FR-081, T160). The measurer is injectable so the arithmetic around it stays
 * testable without a browser.
 */

/** Measures the rendered width of one label, in CSS pixels. */
export interface LabelMeasurer {
  measure(text: string): number;
  /** Identifies the font this measurer was built for, for cache invalidation. */
  fontSignature: string;
}

/** The UI font a measurer is built for. */
export interface FontSource {
  fontSize: string;
  fontFamily: string;
}

/** Builds the canvas font shorthand from a font source. */
export function fontSignatureFor(font: FontSource): string {
  return `${font.fontSize} ${font.fontFamily}`;
}

/**
 * Reads the current UI font from the document.
 *
 * It reads `<body>`, not `<html>`: the UI font and size are declared on `body`
 * (`body { font-family: var(--font-ui); font-size: var(--font-size-ui) }`), and
 * the root element would report the browser's own default instead — measuring
 * every label in the wrong font. It is read once per mount rather than per label,
 * and it is *not* density dependent: density never changes typography
 * (FR-081, T160). Returns `null` when there is no DOM to read.
 */
export function readUiFontSource(): FontSource | null {
  if (typeof document === "undefined") {
    return null;
  }
  const element = document.body ?? document.documentElement;
  if (element === null || element === undefined) {
    return null;
  }

  const computed = window.getComputedStyle(element);
  return {
    fontSize: computed.fontSize === "" ? "13px" : computed.fontSize,
    fontFamily:
      computed.fontFamily === "" ? "system-ui, sans-serif" : computed.fontFamily,
  };
}

/**
 * Creates a label measurer backed by one Canvas 2D context.
 *
 * A single context is reused for every label rather than rendering each label
 * hidden in the DOM, which keeps measurement independent of what is mounted.
 * Returns `null` when the runtime has no 2D context.
 */
export function createCanvasLabelMeasurer(
  font: FontSource,
): LabelMeasurer | null {
  if (typeof document === "undefined") {
    return null;
  }

  const signature = fontSignatureFor(font);
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = document.createElement("canvas").getContext("2d");
  } catch {
    context = null;
  }
  if (context === null) {
    return null;
  }

  const measureContext = context;
  measureContext.font = signature;

  return {
    fontSignature: signature,
    measure(text: string): number {
      return measureContext.measureText(text).width;
    },
  };
}

/**
 * A measurer that needs no DOM at all.
 *
 * Used only as a last-resort fallback (and by tests that want a stable number):
 * it approximates the UI font closely enough for a scrollbar or a Tab width, and
 * it can never read anything but the string it is handed.
 */
export function createApproximateLabelMeasurer(
  font: FontSource,
  averageCharacterWidth = 7,
): LabelMeasurer {
  const signature = fontSignatureFor(font);
  return {
    fontSignature: signature,
    measure(text: string): number {
      return text.length * averageCharacterWidth;
    },
  };
}

/**
 * A measurer wrapper that caches label widths.
 *
 * The cache is keyed by the measurer's font signature *and* label, so a font
 * change simply cannot read a stale width.
 */
export function createCachingMeasurer(measurer: LabelMeasurer): LabelMeasurer {
  const cache = new Map<string, number>();

  return {
    fontSignature: measurer.fontSignature,
    measure(text: string): number {
      const cached = cache.get(text);
      if (cached !== undefined) {
        return cached;
      }
      const width = measurer.measure(text);
      cache.set(text, width);
      return width;
    },
  };
}

/**
 * The measurer every UI layout uses: one cached canvas measurer, with the
 * DOM-free approximation as the fallback.
 *
 * The fallback exists so a layout can always produce a number — never `NaN`,
 * never a crash — even in an environment without a 2D canvas.
 */
export function createUiLabelMeasurer(font: FontSource): LabelMeasurer {
  const canvas = createCanvasLabelMeasurer(font);
  return createCachingMeasurer(canvas ?? createApproximateLabelMeasurer(font));
}
