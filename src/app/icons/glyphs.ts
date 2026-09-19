/**
 * The default glyph artwork (007 T027).
 *
 * These are the handwritten stroke paths the shell has always used, kept in one
 * table so a provider — not a component — decides which glyph an id names. Every
 * glyph is drawn with `currentColor`, so colour still comes from the shared
 * tokens and no component owns a palette (FR-017, T193).
 */

import type { IconId } from "./iconTypes";

/** The stroke path data of one glyph, drawn inside a 16×16 viewBox. */
export const ICON_GLYPHS: Readonly<Record<IconId, readonly string[]>> = {
  // Filesystem fallbacks.
  file: ["M4 1.5h4.5L12 5v9.5H4z", "M8.5 1.5V5H12"],
  "folder-open": ["M1.5 4h4l1.5 2h7.5v1.5", "M1.5 7.5h13l-1.5 6.5h-13z"],
  folder: ["M1.5 4h4l1.5 2h7.5v8h-13z"],
  // A displayable entry that is neither a file nor a directory: the generic file
  // shape plus a small mark, so it stays distinguishable at row size.
  other: ["M4 1.5h4.5L12 5v9.5H4z", "M8.5 1.5V5H12", "M6.5 9.5h3"],
  link: [
    "M6.5 9.5a2.5 2.5 0 0 1 0-3.5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5",
    "M9.5 6.5a2.5 2.5 0 0 1 0 3.5L8 11.5A2.5 2.5 0 0 1 4.5 8",
  ],

  // Navigation and shell actions.
  "chevron-right": ["M6 3.5L10 8l-4 4.5"],
  "chevron-down": ["M3.5 6L8 10.5 12.5 6"],
  "new-file": ["M4 1.5h4.5L12 5v9.5H4z", "M8.5 1.5V5H12", "M8 8v4", "M6 10h4"],
  "new-folder": ["M1.5 4h4l1.5 2h7.5v8h-13z", "M8 8v4", "M6 10h4"],
  refresh: ["M13 8a5 5 0 1 1-1.6-3.7", "M13 1.5V5h-3.5"],
  rename: ["M2 13l1-3 7.5-7.5 2 2L5 12z", "M9.5 3.5l2 2"],
  delete: ["M2.5 4h11", "M6 4V2h4v2", "M4 4l1 10h6l1-10"],
  plus: ["M8 3v10", "M3 8h10"],
  close: ["M4 4l8 8", "M12 4l-8 8"],
  minimize: ["M3 8h10"],
  maximize: ["M3.5 3.5h9v9h-9z"],
  restore: ["M5.5 5.5h7v7h-7z", "M3.5 10.5v-7h7"],
  locate: [
    "M8 2v2.5",
    "M8 11.5V14",
    "M2 8h2.5",
    "M11.5 8H14",
    "M8 6.25A1.75 1.75 0 1 1 8 9.75 1.75 1.75 0 0 1 8 6.25z",
  ],
  "collapse-all": ["M3 2.5h10", "M5 8l3-3 3 3", "M5 13l3-3 3 3"],
  more: ["M4 8h.01", "M8 8h.01", "M12 8h.01"],
  filter: ["M2.5 3.5h11l-4.5 5V13l-2-1.2V8.5z"],
  list: ["M3 4h10", "M3 8h10", "M3 12h10"],
};
