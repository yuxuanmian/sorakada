import { useEffect, useRef } from "react";

import { AppIcon } from "../shell/AppIcon";
import type { DocumentId, TabSnapshot } from "../document/documentSession";

import "../../styles/tabs.css";

export interface TabBarProps {
  /** The manager's lightweight projection, in Tab order. */
  tabs: readonly TabSnapshot[];
  /** Activates a Tab; the manager focuses the editor. */
  onSelect(id: DocumentId): void;
  /** Closes a Tab through the manager's close flow. */
  onClose(id: DocumentId): void;
  /**
   * Creates a new Untitled document.
   *
   * Wired to the same `file.new` command as Ctrl+N and File > New, so the `+`
   * cannot diverge from the other New surfaces (FR-017).
   */
  onNew(): void;
}

/**
 * The Tab strip.
 *
 * Presentation only: it renders the metadata it is given and reports the
 * document id the user acted on. It never reads document text, and it never
 * decides which document becomes active.
 *
 * The strip is split into a scrolling Tab area and a fixed New button, so the
 * `+` stays reachable when the Tabs overflow and is present with zero Tabs
 * (FR-018).
 */
export function TabBar({ tabs, onSelect, onClose, onNew }: TabBarProps) {
  const activeTabRef = useRef<HTMLDivElement>(null);
  const activeId = tabs.find((tab) => tab.active)?.id;

  // When the strip overflows, the active Tab has to be brought back into view.
  // Only the scrolling area moves; the New button is outside it.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeId]);

  return (
    <div className="tab-bar">
      <div className="tab-bar__scroll" role="tablist" aria-label="Open documents">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            ref={tab.active ? activeTabRef : undefined}
            className={tab.active ? "tab tab--active" : "tab"}
            role="tab"
            aria-selected={tab.active}
            tabIndex={tab.active ? 0 : -1}
            // FR-014: the full path stays available even when two Tabs share a
            // base filename.
            title={tab.path ?? tab.displayName}
            onClick={() => {
              onSelect(tab.id);
            }}
          >
            <span className="tab__label">{tab.displayName}</span>
            {tab.dirty ? (
              <span className="tab__dirty" title="Unsaved changes">
                ●
              </span>
            ) : null}
            <button
              type="button"
              className="tab__close"
              aria-label={`Close ${tab.displayName}`}
              onClick={(event) => {
                // Closing an inactive Tab must not also activate it.
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              <AppIcon name="close" />
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="tab-bar__new"
        aria-label="New document"
        title="New (Ctrl+N)"
        onClick={onNew}
      >
        <AppIcon name="plus" />
      </button>
    </div>
  );
}
