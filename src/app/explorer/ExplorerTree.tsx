/**
 * Explorer tree rendering.
 *
 * Presentation and interaction only: the tree renders the state it is handed and
 * reports the path the user acted on. It never reads the filesystem and never
 * decides which document becomes active.
 *
 * The 004 interaction rules are deliberate:
 *
 * - single-clicking a **file** row selects it without opening it (FR-001), and
 *   double-clicking it opens the file through the shared document pipeline
 *   (FR-002);
 * - single-clicking a **directory** row selects it *only*: it never changes the
 *   expanded state and therefore never starts a lazy child read
 *   (FR-003, SR-001);
 * - double-clicking a **directory** row toggles its expansion exactly once for
 *   that gesture (FR-004);
 * - the directory **chevron** toggles expansion alone, never changes the
 *   selection, and stops its own events — including double-click — from reaching
 *   the row handlers (FR-005);
 * - clicking a row moves keyboard focus into the Explorer, which is what scopes
 *   the F2/Delete handler to the Explorer (FR-079).
 *
 * The component only maps gestures onto callbacks; which directory gets read and
 * how its children are cached stays with the controller (FR-026).
 */

import {
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { AppIcon, type AppIconName } from "../shell/AppIcon";
import type { InlineCommitResult } from "./explorerActions";
import type {
  ExplorerDirectoryNode,
  ExplorerNode,
  ExplorerState,
  InlineEditState,
} from "./explorerModel";

/** Where a context menu was requested. */
export interface MenuPosition {
  x: number;
  y: number;
}

export interface ExplorerTreeProps {
  /** The controller's current tree state. */
  state: ExplorerState;
  /** Selects a row without opening anything. */
  onSelect(path: string): void;
  /** Expands/collapses a directory; loads it the first time. */
  onToggleDirectory(path: string): void;
  /** Opens a file through the shared document pipeline. */
  onOpenFile(path: string): void;
  /** Requests the context menu for `node`, or for blank space when `null`. */
  onContextMenu(node: ExplorerNode | null, position: MenuPosition): void;
  /** Records an inline editor keystroke. */
  onInlineDraftChange(name: string): void;
  /**
   * Commits the inline editor (Enter).
   *
   * The promise resolves with the action's outcome, so the input can tell a
   * closed editor from a draft that is still its own to edit (FR-015, FR-016).
   */
  onInlineCommit(): Promise<InlineCommitResult>;
  /** Cancels the inline editor (Escape, or an ordinary blur). */
  onInlineCancel(): void;
}

/** The glyph for one visible node. */
function iconFor(node: ExplorerNode): AppIconName {
  if (node.kind === "directory") {
    return node.expanded ? "folder-open" : "folder";
  }
  return "file";
}

/** The indentation of one depth level. */
const INDENT = 14;

/** Renders the single-root tree. */
export function ExplorerTree(props: ExplorerTreeProps) {
  const root = props.state.root;
  if (root === null) {
    return null;
  }

  return (
    // Right-clicking blank space is handled by the Explorer body, which owns
    // the whole scrollable area; a row stops propagation and opens the menu for
    // its own node instead.
    <div className="explorer-tree" role="tree" aria-label="Workspace files">
      <NodeRow node={root} depth={0} {...props} />
    </div>
  );
}

/** Renders one file, directory or special entry row, plus its subtree. */
function NodeRow({
  node,
  depth,
  ...props
}: ExplorerTreeProps & { node: ExplorerNode; depth: number }) {
  const { state } = props;
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

  return (
    <>
      <div
        className={rowClasses.join(" ")}
        style={{ paddingLeft: `${depth * INDENT + 8}px` }}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={node.kind === "directory" ? node.expanded : undefined}
        // Roving focus: clicking a row moves keyboard focus into the Explorer.
        tabIndex={-1}
        // FR-033: the complete path stays available even when the row truncates
        // a long name.
        title={node.path}
        onClick={(event: MouseEvent<HTMLDivElement>) => {
          event.currentTarget.focus();
          // Selection is the ordinary single-click outcome for every row kind.
          // A directory is deliberately *not* toggled here, so selecting it
          // cannot expand it or start a read (FR-001, FR-003, SR-001).
          props.onSelect(node.path);
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
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onContextMenu(node, { x: event.clientX, y: event.clientY });
        }}
      >
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

        <AppIcon name={iconFor(node)} className="explorer-row__icon" />

        {renaming === null ? (
          <span className="explorer-row__label">{node.name}</span>
        ) : (
          <InlineEditorInput
            edit={renaming}
            label={`Rename ${renaming.originalName}`}
            {...props}
          />
        )}

        {node.isSymlink ? (
          <AppIcon name="link" className="explorer-row__badge" title="Link" />
        ) : null}
      </div>

      {node.kind === "directory" && node.expanded ? (
        <DirectoryChildren node={node} depth={depth} {...props} />
      ) : null}
    </>
  );
}

/**
 * Renders the rows *inside* an expanded directory.
 *
 * Any load notice is rendered in addition to cached children, so a failed
 * refresh shows a localized error without hiding what was already loaded
 * (FR-029).
 */
function DirectoryChildren({
  node,
  depth,
  ...props
}: ExplorerTreeProps & { node: ExplorerDirectoryNode; depth: number }) {
  const rows: ReactNode[] = [];
  const edit = props.state.inlineEdit;

  if (edit !== null && edit.type !== "rename" && edit.parentPath === node.path) {
    rows.push(
      <div
        key="inline-create"
        className="explorer-row explorer-row--editing"
        style={{ paddingLeft: `${(depth + 1) * INDENT + 8}px` }}
      >
        <span className="explorer-row__chevron explorer-row__chevron--empty" />
        <AppIcon
          name={edit.type === "create-file" ? "new-file" : "new-folder"}
          className="explorer-row__icon"
        />
        <InlineEditorInput
          edit={edit}
          label={edit.type === "create-file" ? "New file name" : "New folder name"}
          {...props}
        />
      </div>,
    );
  }

  if (node.loadState === "loading" && node.children === undefined) {
    rows.push(
      <div
        key="loading"
        className="explorer-row explorer-row--notice"
        style={{ paddingLeft: `${(depth + 1) * INDENT + 8}px` }}
      >
        <span className="explorer-row__label">Loading...</span>
      </div>,
    );
  } else if (node.errorMessage !== undefined) {
    rows.push(
      <div
        key="notice"
        className="explorer-row explorer-row--notice"
        style={{ paddingLeft: `${(depth + 1) * INDENT + 8}px` }}
      >
        <span className="explorer-row__label">{node.errorMessage}</span>
      </div>,
    );
  }

  for (const child of node.children ?? []) {
    rows.push(
      <NodeRow key={child.path} node={child} depth={depth + 1} {...props} />,
    );
  }

  return <>{rows}</>;
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
}: {
  edit: InlineEditState;
  label: string;
} & Pick<
  ExplorerTreeProps,
  "onInlineDraftChange" | "onInlineCommit" | "onInlineCancel"
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
        }
      }}
      onBlur={() => {
        if (commitInFlight.current) {
          // The commit owns the editor now; this blur is not a dismissal.
          return;
        }
        // An ordinary blur discards only the transient draft and touches no
        // filesystem entry (FR-011, FR-012, SC-004).
        onInlineCancel();
      }}
    />
  );
}
