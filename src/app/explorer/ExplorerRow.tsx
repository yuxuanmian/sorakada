/**
 * One Explorer Tree row (007 T091, T093..T095, FR-039, FR-045).
 *
 * The row renders exactly one projection row — it never recurses and never owns
 * state. All 004 interaction semantics live here unchanged:
 *
 * - single-clicking a **file** row selects it without opening it (FR-001);
 * - double-clicking a file opens it through the shared document pipeline;
 * - single-clicking a **directory** row selects it only, so it can never start a
 *   lazy child read (FR-003, SR-001);
 * - double-clicking a directory toggles its expansion exactly once (FR-004);
 * - the chevron toggles expansion alone and never changes the selection, and it
 *   stops its own events — including double-click — from reaching the row
 *   handlers (FR-005);
 * - clicking a row returns focus to the stable Tree viewport instead of to the
 *   recyclable row element (T096).
 *
 * Hierarchy is communicated by guide *slots* derived from the row's depth and
 * ancestor metadata, never by nested ancestor DOM (FR-039).
 */

import { useRef, type KeyboardEvent, type MouseEvent } from "react";

import { IconGlyph, AppIcon } from "../shell/AppIcon";
import { fileIcon } from "../icons/fileIconProvider";
import type { DensityMetrics } from "../shell/density";
import type { UiDebugOptions } from "../shell/uiDebugState";
import type { InlineCommitResult } from "./explorerActions";
import { EXPLORER_ROW_PATH_ATTRIBUTE } from "./explorerContextTarget";
import type { ExplorerState, InlineEditState } from "./explorerModel";
import type { VisibleExplorerRow } from "./explorerProjection";
import { rowIndent } from "./explorerTreeMetrics";

export interface ExplorerRowProps {
  /** The projection row to render. */
  row: VisibleExplorerRow;
  /** The controller's current state, for selection and inline editing. */
  state: ExplorerState;
  /** Density metrics; the row height itself is applied by the virtualizer. */
  metrics: DensityMetrics;
  /** Selects a row without opening anything. */
  onSelect(path: string): void;
  /** Expands/collapses a directory; loads it the first time. */
  onToggleDirectory(path: string): void;
  /** Opens a file through the shared document pipeline. */
  onOpenFile(path: string): void;
  /** Records an inline editor keystroke. */
  onInlineDraftChange(name: string): void;
  /** Commits the inline editor (Enter). */
  onInlineCommit(): Promise<InlineCommitResult>;
  /** Cancels the inline editor (Escape, or an ordinary blur). */
  onInlineCancel(): void;
  /** Returns keyboard focus to the stable Tree viewport. */
  onReturnFocus(): void;
  /** Development diagnostics; never affects production behaviour. */
  debugOptions?: UiDebugOptions;
}

/** Renders one flattened row. */
export function ExplorerRow(props: ExplorerRowProps) {
  const { row, state, metrics } = props;

  const guides = (
    <span
      className="explorer-row__indent"
      style={{ width: `${rowIndent(row.depth, metrics)}px` }}
      aria-hidden="true"
    >
      {row.ancestorContinuation.map((continues, level) => {
        const last = level === row.ancestorContinuation.length - 1;
        const classes = ["explorer-row__guide"];
        if (!continues && !last) {
          classes.push("explorer-row__guide--gap");
        }
        if (last) {
          classes.push("explorer-row__guide--elbow");
        }
        return <span key={level} className={classes.join(" ")} />;
      })}
    </span>
  );

  if (row.kind === "notice") {
    return (
      <div
        className={`explorer-row explorer-row--notice explorer-row--notice-${row.noticeType}`}
        {...{ [EXPLORER_ROW_PATH_ATTRIBUTE]: row.parentPath }}
        role="treeitem"
        aria-disabled="true"
        data-row-bounds={props.debugOptions?.showTreeRowBounds ? "" : undefined}
        // FR-040/T082: a sentinel keeps the same fixed height as every other row;
        // the whole message stays readable through its tooltip instead of
        // expanding over its neighbours.
        title={row.message}
      >
        {guides}
        <span className="explorer-row__chevron explorer-row__chevron--empty" />
        <span className="explorer-row__label">{row.message}</span>
      </div>
    );
  }

  if (row.kind === "inline") {
    return (
      <div
        className="explorer-row explorer-row--editing"
        {...{ [EXPLORER_ROW_PATH_ATTRIBUTE]: row.parentPath }}
        role="treeitem"
        data-row-bounds={props.debugOptions?.showTreeRowBounds ? "" : undefined}
      >
        {guides}
        <span className="explorer-row__chevron explorer-row__chevron--empty" />
        <IconGlyph
          descriptor={fileIcon({
            name: row.edit.draftName,
            kind: row.edit.type === "create-folder" ? "directory" : "file",
            isSymlink: false,
          }).icon}
          className="explorer-row__icon"
        />
        <InlineEditorInput
          edit={row.edit}
          label={
            row.edit.type === "create-file" ? "New file name" : "New folder name"
          }
          onInlineDraftChange={props.onInlineDraftChange}
          onInlineCommit={props.onInlineCommit}
          onInlineCancel={props.onInlineCancel}
          onReturnFocus={props.onReturnFocus}
        />
      </div>
    );
  }

  const node = row.node;
  const selected = state.selectedPath === node.path;
  const edit = state.inlineEdit;
  const renaming =
    edit !== null && edit.type === "rename" && edit.sourcePath === node.path
      ? edit
      : null;

  const rowClasses = ["explorer-row"];
  if (selected) {
    rowClasses.push("explorer-row--selected");
  }
  if (node.isSymlink) {
    rowClasses.push("explorer-row--link");
  }

  // FR-057/T095: the glyph decision belongs to the provider, not to the row.
  const resolvedIcon = fileIcon(node);

  return (
    <div
      className={rowClasses.join(" ")}
      {...{ [EXPLORER_ROW_PATH_ATTRIBUTE]: node.path }}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={node.kind === "directory" ? node.expanded : undefined}
      aria-level={row.depth + 1}
      data-row-bounds={props.debugOptions?.showTreeRowBounds ? "" : undefined}
      // FR-045: the complete path stays available through the row tooltip, and a
      // long name never expands over the Editor region on hover.
      title={node.path}
      onClick={(event: MouseEvent<HTMLDivElement>) => {
        // Focus returns to the stable viewport, so recycling the selected row
        // cannot take Explorer keyboard scope with it (T096).
        event.preventDefault();
        props.onSelect(node.path);
        props.onReturnFocus();
      }}
      onDoubleClick={() => {
        if (node.kind === "file") {
          props.onOpenFile(node.path);
          return;
        }
        if (node.kind === "directory") {
          // The row-level toggle, and the only one: the single clicks of this
          // same gesture select without toggling (FR-004).
          props.onToggleDirectory(node.path);
        }
      }}
    >
      {guides}

      {node.kind === "directory" ? (
        <button
          type="button"
          className="explorer-row__chevron"
          aria-label={node.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
          onClick={(event: MouseEvent) => {
            // The chevron toggles expansion only; selection is unchanged.
            event.stopPropagation();
            props.onToggleDirectory(node.path);
          }}
          onDoubleClick={(event: MouseEvent) => {
            // The chevron's own clicks already performed the toggles; letting
            // the double-click bubble would add a row-level toggle on top
            // (FR-005).
            event.stopPropagation();
          }}
        >
          <AppIcon name={node.expanded ? "chevron-down" : "chevron-right"} />
        </button>
      ) : (
        <span className="explorer-row__chevron explorer-row__chevron--empty" />
      )}

      <IconGlyph descriptor={resolvedIcon.icon} className="explorer-row__icon" />

      {renaming === null ? (
        <span className="explorer-row__label">{node.name}</span>
      ) : (
        <InlineEditorInput
          edit={renaming}
          label={`Rename ${renaming.originalName}`}
          onInlineDraftChange={props.onInlineDraftChange}
          onInlineCommit={props.onInlineCommit}
          onInlineCancel={props.onInlineCancel}
          onReturnFocus={props.onReturnFocus}
        />
      )}

      {resolvedIcon.badge === undefined ? null : (
        <IconGlyph descriptor={resolvedIcon.badge} className="explorer-row__badge" />
      )}
    </div>
  );
}

/**
 * The shared inline text editor used by both create and rename.
 *
 * 004 adds one piece of local coordination: an Enter press marks a commit
 * attempt as *in flight* before the asynchronous filesystem work starts, so a
 * blur caused by that work — a native error dialog stealing focus, for example —
 * cannot cancel an operation the user already confirmed. The flag is a DOM
 * concern of this input, held in a ref rather than in application state
 * (FR-013, FR-016).
 */
function InlineEditorInput({
  edit,
  label,
  onInlineDraftChange,
  onInlineCommit,
  onInlineCancel,
  onReturnFocus,
}: {
  edit: InlineEditState;
  label: string;
} & Pick<
  ExplorerRowProps,
  | "onInlineDraftChange"
  | "onInlineCommit"
  | "onInlineCancel"
  | "onReturnFocus"
>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const commitInFlight = useRef(false);

  return (
    <input
      ref={inputRef}
      className="explorer-inline-input"
      // Exactly one inline editor exists at a time, so it always takes focus.
      autoFocus
      value={edit.draftName}
      aria-label={label}
      spellCheck={false}
      onClick={(event: MouseEvent) => {
        // The row's own click handler must not steal focus back to the viewport
        // while the user is editing inside the row.
        event.stopPropagation();
      }}
      onDoubleClick={(event: MouseEvent) => {
        event.stopPropagation();
      }}
      onChange={(event) => {
        onInlineDraftChange(event.target.value);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        // The Explorer's F2/Delete handler must not see keys typed into the
        // editor, and Enter/Escape are the only commit/cancel gestures (FR-054).
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          if (commitInFlight.current) {
            // The attempt is already running: a repeated Enter must not start a
            // second create/rename (FR-013).
            return;
          }

          // Commit intent is established synchronously, before the action gets
          // the chance to await anything, so a blur that arrives while the
          // filesystem work is in flight is not a dismissal (FR-013).
          commitInFlight.current = true;
          void (async () => {
            let result: InlineCommitResult = "retained";
            try {
              result = await onInlineCommit();
            } catch {
              // A rejected commit leaves the draft where it was; the flag still
              // has to be cleared so this input stays dismissible.
              result = "retained";
            } finally {
              commitInFlight.current = false;
            }

            if (result === "retained") {
              // The draft survived, so editing resumes here. A WorkContext that
              // replaced this input has already unmounted it, which makes the
              // ref null and this a no-op (FR-016).
              inputRef.current?.focus();
            }
          })();
        } else if (event.key === "Escape") {
          event.preventDefault();
          if (commitInFlight.current) {
            // An operation that already started cannot be retroactively
            // cancelled by dismissing the input (FR-014).
            return;
          }
          onInlineCancel();
          // Closing the editor returns keyboard scope to the Tree viewport.
          onReturnFocus();
        }
      }}
      onBlur={() => {
        if (commitInFlight.current) {
          // The commit owns the editor now; this blur is not a dismissal.
          return;
        }
        // An ordinary blur discards only the transient draft and touches no
        // filesystem entry (FR-011, FR-012, SC-004). Virtualization is the
        // deliberate exception: the edit row is pinned so that scrolling it out
        // of view cannot produce this blur in the first place (T098).
        onInlineCancel();
      }}
    />
  );
}
