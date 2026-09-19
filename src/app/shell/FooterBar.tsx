/**
 * The application-level Footer region (007 T049, FR-073, FR-074).
 *
 * It is a real AppShell region below MainArea — not an overlay inside CodeMirror
 * — with a left context slot and a right status slot. US7 (Phase 9) populates
 * those slots; the structure exists from the shell refactor onward so the
 * vertical geometry is stable before the content arrives.
 *
 * 007 keeps it thin and low-prominence: content truncates rather than widening
 * the window or covering MainArea (FR-078).
 */

import type { ReactNode } from "react";

export interface FooterBarProps {
  /** Filesystem/document context; truncates first when space runs out. */
  left?: ReactNode;
  /** Read-only document format status; never wraps. */
  right?: ReactNode;
}

/** Renders the Footer. */
export function FooterBar({ left, right }: FooterBarProps) {
  return (
    <footer className="footer-bar" role="contentinfo" aria-label="Status">
      <div className="footer-bar__left">{left}</div>
      <div className="footer-bar__right">{right}</div>
    </footer>
  );
}
