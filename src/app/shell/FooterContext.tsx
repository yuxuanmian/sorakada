/**
 * Footer presentation (007 T168..T176, FR-074..FR-078).
 *
 * `FooterBar` owns the region and its two slots; these two components fill them
 * from a `FooterProjection`. Both are read-only: the left side is plain text
 * (not a button, because 007 defines no breadcrumb click behaviour), and the right
 * side is a list of format labels.
 *
 * Truncation priority is structural rather than scripted: the left context is the
 * flexible half and shrinks first, and inside a breadcrumb the earlier path
 * components shrink before the file name and before the right-hand status items
 * (FR-078, T174).
 */

import type { FooterLeftContext, FooterStatusItem } from "./footerProjection";

export interface FooterLeftProps {
  context: FooterLeftContext;
}

/** Renders the Footer's left-hand filesystem/document context. */
export function FooterLeft({ context }: FooterLeftProps) {
  switch (context.kind) {
    case "empty":
      return null;

    case "workspace":
      return (
        <span className="footer-bar__context" title={context.title}>
          <span className="footer-bar__crumb footer-bar__crumb--name">
            {context.workspaceName}
          </span>
        </span>
      );

    case "untitled":
      return (
        <span className="footer-bar__context">
          <span className="footer-bar__crumb footer-bar__crumb--name">
            {context.displayName}
          </span>
        </span>
      );

    case "inside":
      return (
        <span className="footer-bar__context" title={context.title}>
          <span className="footer-bar__crumb">{context.workspaceName}</span>
          {context.segments.map((segment, index) => (
            <span
              // Segments are positional within one path, which is exactly what
              // the breadcrumb shows; the path itself is the stable identity.
              key={`${index}:${segment}`}
              className={
                index === context.segments.length - 1
                  ? "footer-bar__crumb footer-bar__crumb--name"
                  : "footer-bar__crumb"
              }
            >
              <span className="footer-bar__separator" aria-hidden="true">
                /
              </span>
              {segment}
            </span>
          ))}
        </span>
      );

    case "outside":
      return (
        <span className="footer-bar__context" title={context.title}>
          {context.segments.map((segment, index) => (
            <span
              key={`${index}:${segment}`}
              className={
                index === context.segments.length - 1
                  ? "footer-bar__crumb footer-bar__crumb--name"
                  : "footer-bar__crumb"
              }
            >
              {index === 0 ? null : (
                <span className="footer-bar__separator" aria-hidden="true">
                  /
                </span>
              )}
              {segment}
            </span>
          ))}
        </span>
      );
  }
}

export interface FooterRightProps {
  items: readonly FooterStatusItem[];
}

/** Renders the read-only document format items. */
export function FooterRight({ items }: FooterRightProps) {
  return (
    <>
      {items.map((item) => (
        <span key={item.id} className="footer-bar__status" title={item.title}>
          {item.label}
        </span>
      ))}
    </>
  );
}
