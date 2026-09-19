/**
 * The Tab Overview (007 T139..T142, FR-069, FR-070).
 *
 * A lightweight, filterable list of the currently open documents. It is a
 * *presentation* of `TabSnapshot`s: it owns only the popup's open state and the
 * filter text, marks active/dirty/external state from the snapshot, and activates
 * an existing document through the same selection path a Tab click uses.
 *
 * Nothing here can open a file or reorder Tabs, which is what keeps it from
 * becoming a second owner of document metadata (FR-070, T141).
 */

import { useState } from "react";

import { AppIcon } from "../shell/AppIcon";
import type { DocumentId, TabSnapshot } from "../document/documentSession";
import { SoraPopover } from "../../ui/popover/SoraPopover";
import {
  activateTabOverviewItem,
  filterTabOverviewItems,
  overviewHasItems,
} from "./tabOverviewModel";

export interface TabOverviewProps {
  /** The manager's current projection, in Tab order. */
  tabs: readonly TabSnapshot[];
  /** Activates an existing document; the manager focuses the editor. */
  onSelect(id: DocumentId): void;
}

/** Renders the overflow control and its filterable document list. */
export function TabOverview({ tabs, onSelect }: TabOverviewProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  // Rebuilt from the newest snapshot on every render, so a document that was
  // closed, renamed or rebound while the popup is open updates or disappears
  // instead of leaving a stale entry (T142).
  const items = filterTabOverviewItems(tabs, filter);

  return (
    <SoraPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
      }}
      triggerLabel="Open documents"
      triggerClassName="tab-strip__action"
      trigger={<AppIcon name="list" />}
      ariaLabel="Open documents"
      align="end"
      className="tab-overview"
    >
      <input
        className="tab-overview__filter"
        // The filter is the first thing the user wants to type into.
        autoFocus
        value={filter}
        aria-label="Filter open documents"
        placeholder="Filter documents"
        spellCheck={false}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
      />

      {overviewHasItems(items) ? (
        <ul className="tab-overview__list">
          {items.map((item) => (
            <li key={item.id} className="tab-overview__item">
              <button
                type="button"
                className={
                  item.active
                    ? "tab-overview__entry tab-overview__entry--active"
                    : "tab-overview__entry"
                }
                title={item.path ?? item.displayName}
                onClick={() => {
                  // Exactly one selection through the canonical path, then the
                  // popup closes (T141).
                  activateTabOverviewItem(item.id, {
                    select: onSelect,
                    close: () => {
                      setOpen(false);
                    },
                  });
                }}
              >
                <span className="tab-overview__label">{item.displayName}</span>
                {item.externalState === "modified" ? (
                  <span
                    className="tab__external tab__external--modified"
                    role="img"
                    aria-label="Changed on disk"
                    title="Changed on disk by another program"
                  >
                    ↻
                  </span>
                ) : null}
                {item.externalState === "missing" ? (
                  <span
                    className="tab__external tab__external--missing"
                    role="img"
                    aria-label="Missing on disk"
                    title="Deleted on disk; Save recreates the file"
                  >
                    ⚠
                  </span>
                ) : null}
                {item.dirty ? (
                  <span className="tab__dirty" title="Unsaved changes">
                    ●
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tab-overview__empty">No matching documents</p>
      )}
    </SoraPopover>
  );
}
