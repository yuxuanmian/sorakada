/**
 * The single icon set the shell and Explorer draw from.
 *
 * Icons are decorative stroke paths using `currentColor`, so colors come from
 * the shared CSS tokens instead of being hard-coded per component (FR-095,
 * FR-096). Keeping them here rather than inline in each component means a new
 * Explorer surface cannot fork its own copy of a file/folder glyph.
 */

import type { ReactElement } from "react";

/** Every glyph the 003 shell needs. */
export type AppIconName =
  | "file"
  | "folder"
  | "folder-open"
  | "chevron-right"
  | "chevron-down"
  | "new-file"
  | "new-folder"
  | "refresh"
  | "rename"
  | "delete"
  | "link"
  | "plus"
  | "close";

const ICON_PATHS: Readonly<Record<AppIconName, readonly string[]>> = {
  file: ["M4 1.5h4.5L12 5v9.5H4z", "M8.5 1.5V5H12"],
  folder: ["M1.5 4h4l1.5 2h7.5v8h-13z"],
  "folder-open": ["M1.5 4h4l1.5 2h7.5v1.5", "M1.5 7.5h13l-1.5 6.5h-13z"],
  "chevron-right": ["M6 3.5L10 8l-4 4.5"],
  "chevron-down": ["M3.5 6L8 10.5 12.5 6"],
  "new-file": ["M4 1.5h4.5L12 5v9.5H4z", "M8.5 1.5V5H12", "M8 8v4", "M6 10h4"],
  "new-folder": ["M1.5 4h4l1.5 2h7.5v8h-13z", "M8 8v4", "M6 10h4"],
  refresh: ["M13 8a5 5 0 1 1-1.6-3.7", "M13 1.5V5h-3.5"],
  rename: ["M2 13l1-3 7.5-7.5 2 2L5 12z", "M9.5 3.5l2 2"],
  delete: ["M2.5 4h11", "M6 4V2h4v2", "M4 4l1 10h6l1-10"],
  link: [
    "M6.5 9.5a2.5 2.5 0 0 1 0-3.5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5",
    "M9.5 6.5a2.5 2.5 0 0 1 0 3.5L8 11.5A2.5 2.5 0 0 1 4.5 8",
  ],
  plus: ["M8 3v10", "M3 8h10"],
  close: ["M4 4l8 8", "M12 4l-8 8"],
};

export interface AppIconProps {
  /** Which glyph to render. */
  name: AppIconName;
  /** Extra class names for sizing/state. */
  className?: string;
  /**
   * Accessible label. Omitted icons are decorative and hidden from assistive
   * technology, which is what row icons need because the row text already names
   * the entry.
   */
  title?: string;
}

/** Renders one shared glyph. */
export function AppIcon({
  name,
  className,
  title,
}: AppIconProps): ReactElement {
  const classes = className === undefined ? "app-icon" : `app-icon ${className}`;

  return (
    <svg
      className={classes}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={title === undefined}
      role={title === undefined ? undefined : "img"}
    >
      {title === undefined ? null : <title>{title}</title>}
      {ICON_PATHS[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
