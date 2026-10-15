/**
 * The single glyph renderer.
 *
 * Icons are decorative paths using `currentColor`, so colours come from the
 * shared CSS tokens instead of being hard-coded per component (FR-017, T193).
 * 007 splits the *decision* about which glyph to draw into the icon providers and
 * keeps only the *rendering* here, so no component can fork its own copy of a
 * file/folder/window-control glyph.
 *
 * 008 adds the smallest possible render distinction: a descriptor may ask for the
 * filled draw mode, which the Explorer's generic filesystem glyphs use
 * (008 FR-048). Everything that does not ask for it keeps the 007 stroke
 * renderer, so no shell action icon changes.
 */

import type { ReactElement } from "react";

import { ICON_GLYPHS } from "../icons/glyphs";
import type { IconDescriptor, IconDrawMode, IconId } from "../icons/iconTypes";

/** An icon id, kept as the historical name for component props. */
export type AppIconName = IconId;

export interface AppIconProps {
  /** Which glyph to render. */
  name: IconId;
  /** Extra class names for sizing/state. */
  className?: string;
  /**
   * Accessible label. Omitted icons are decorative and hidden from assistive
   * technology, which is what row icons need because the row text already names
   * the entry.
   */
  title?: string;
}

export interface IconGlyphProps {
  /** A provider's answer: which glyph, how to draw it, and whether it is announced. */
  descriptor: IconDescriptor;
  /** Extra class names for sizing/state. */
  className?: string;
}

function renderGlyph(
  id: IconId,
  className: string | undefined,
  title: string | undefined,
  drawMode: IconDrawMode = "stroke",
): ReactElement {
  const classes = className === undefined ? "app-icon" : `app-icon ${className}`;
  const filled = drawMode === "fill";

  /*
   * A filled glyph keeps a hairline current-colour edge so the open-path artwork
   * (the folder's front edge, the file's fold) stays defined; stroke mode keeps
   * the 007 weight exactly.
   */
  return (
    <svg
      className={classes}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0.5 : 1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={title === undefined}
      role={title === undefined ? undefined : "img"}
    >
      {title === undefined ? null : <title>{title}</title>}
      {ICON_GLYPHS[id].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

/** Renders one shared glyph by id. */
export function AppIcon({ name, className, title }: AppIconProps): ReactElement {
  return renderGlyph(name, className, title);
}

/**
 * Renders whatever an icon provider resolved.
 *
 * Components that own a `FileIconProvider`/`UiIconProvider` use this, so a
 * descriptor from either provider reaches the same single renderer.
 */
export function IconGlyph({
  descriptor,
  className,
}: IconGlyphProps): ReactElement {
  return renderGlyph(
    descriptor.id,
    className,
    descriptor.title,
    descriptor.drawMode,
  );
}
