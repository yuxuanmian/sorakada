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
 * The New control is the trailing item *inside* the scrolling Tab strip, so it
 * follows the last Tab in Tab order and may scroll out of view with the Tabs
 * (FR-018, FR-020, SR-003).
 */
export function TabBar({ tabs, onSelect, onClose, onNew }: TabBarProps) {
  const activeTabRef = useRef<HTMLDivElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const activeId = tabs.find((tab) => tab.active)?.id;
  const activeIndex = tabs.findIndex((tab) => tab.active);
  const activeIsFinal = activeIndex >= 0 && activeIndex === tabs.length - 1;

  // When the strip overflows, the active Tab has to be brought back into view.
  // Activating the *final* Tab additionally has to reveal the trailing `+`, so
  // the New control stays reachable without the `+` ever moving beside an older
  // active Tab (FR-021).
  useEffect(() => {
    if (activeIsFinal) {
      // The `+` ends the strip, so aligning its end edge reveals the final Tab
      // and the `+` together.
      newButtonRef.current?.scrollIntoView({
        block: "nearest",
        inline: "end",
      });
      return;
    }

    activeTabRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeId, activeIsFinal]);

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
            {/*
              005 (FR-041): the external disk state is shown non-modally, because
              a modal dialog on every watcher event would be unusable. The marker
              is a projection of manager-owned state, so the strip never decides
              what the state is — and `dirty` keeps its own separate marker
              (FR-009).
            */}
            {tab.externalState === "modified" ? (
              <span
                className="tab__external tab__external--modified"
                role="img"
                aria-label="Changed on disk"
                title="Changed on disk by another program"
              >
                ↻
              </span>
            ) : null}
            {tab.externalState === "missing" ? (
              <span
                className="tab__external tab__external--missing"
                role="img"
                aria-label="Missing on disk"
                title="Deleted on disk; Save recreates the file"
              >
                ⚠
              </span>
            ) : null}
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

        <button
          ref={newButtonRef}
          type="button"
          className="tab-bar__new"
          aria-label="New document"
          title="New (Ctrl+N)"
          onClick={onNew}
        >
          <AppIcon name="plus" />
        </button>
      </div>
    </div>
  );
}
